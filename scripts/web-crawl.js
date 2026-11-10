#!/usr/bin/env node
// web-crawl: a bounded, polite site crawl that finds download candidates.
//
// The extension is a *capture* client — it reports what a page you already have
// open links to. The engine expands one listing page into many downloads
// (resolveUrl -> array -> enqueue). Between the two there was a hole: walking a
// site's pagination to find the listing pages in the first place, which until
// now was done by hand (pasting each page) or by an unbounded Tampermonkey
// autoloop that the app could only throttle after it had already stormed.
//
// This tool closes that hole with the app's own stack:
//   - lib/http.js requestWithRedirects for the fetch (45s socket timeout,
//     redirect-following),
//   - lib/cf-fallback for a Cloudflare-challenged page (the real-Chrome bridge),
//   - downloader.js's shared junk/nav/browser-UI guards, so a crawl can never
//     enqueue what the engine's own enqueue() would reject.
//
// Rules: one host only (unless --any-host), a page budget (--max-pages), a link
// depth (--max-depth), quiet time between fetches (--delay), and honor of HTTP
// 429/503 + Retry-After. Dry-run by default: it REPORTS what it found and
// changes nothing. --enqueue sends the discovered URLs to the running app over
// the WS bridge as a native loopback client (docs/ws-protocol.md §7.1) and
// honors the app's own PACE_LIMITED retryAfter window.
//
// Usage:
//   node scripts/web-crawl.js <start-url> [more-urls] [options]
//
// Discovery:
//   --max-pages N     page fetch budget                (default 25)
//   --max-depth N     ordinary-link depth from start   (default 1)
//   --follow MODE     next | links | none              (default next)
//   --collect MODE    media | pages                    (default media)
//   --delay MS        quiet time between page fetches  (default 1200)
//   --any-host        follow links on other hosts too  (default off)
//   --no-cf           disable the Cloudflare browser fallback
//   --json            full report as JSON on stdout
//   --out FILE        also write the discovered URLs to FILE
//   --quiet           no progress/summary on stderr
//   --ua STRING       User-Agent for page fetches
//   --cookie STRING   Cookie header for page fetches and queued downloads
//
// Enqueue (opt-in):
//   --enqueue         send every discovered URL to the running app
//   --deepgrab-ws URL default ws://127.0.0.1:8765 (env DEEPGRAB_WS_URL)
//   --referer URL     referer override (default: the page it was found on)
//
// Exit: 0 crawl completed, 1 crawl/enqueue failed, 2 usage error.
// stdout carries the URL list (or --json); every log line goes to stderr.
"use strict";

const fs = require("fs");
const WebSocket = require("ws");

const { createCrawler } = require("../lib/crawl");
// The app-side halves of a crawl (page fetcher over lib/http + the Cloudflare
// fallback, and the engine's guard composition) live in lib/crawl-runner.js so
// the CLI and the window can never drift apart.
const { makeFetchPage, isRejectedUrl, parseRetryAfter } = require("../lib/crawl-runner");

const DEFAULT_WS = "ws://127.0.0.1:8765";

const HELP = `web-crawl — bounded, polite crawl for download candidates

Usage:
  node scripts/web-crawl.js <start-url> [more-urls] [options]

Discovery:
  --max-pages N     page fetch budget                (default 25)
  --max-depth N     ordinary-link depth from start   (default 1)
  --follow MODE     next | links | none              (default next)
  --collect MODE    media | pages                    (default media)
  --delay MS        quiet time between page fetches  (default 1200)
  --any-host        follow links on other hosts too  (default off)
  --no-cf           disable the Cloudflare browser fallback
  --json            full report as JSON on stdout
  --out FILE        also write the discovered URLs to FILE
  --quiet           no progress/summary on stderr
  --ua STRING       User-Agent for page fetches
  --cookie STRING   Cookie header for page fetches and queued downloads

Enqueue (opt-in; the running app must have its WS bridge up):
  --enqueue         send every discovered URL to the app
  --deepgrab-ws URL default ws://127.0.0.1:8765 (env DEEPGRAB_WS_URL)
  --referer URL     referer override (default: the page it was found on)

Exit: 0 crawl completed, 1 crawl/enqueue failed, 2 usage error.`;

// --------------------------------------------------------------------- args

const BOOL_FLAGS = new Set(["json", "enqueue", "quiet", "help", "any-host", "no-cf"]);

/** Parse argv. Known boolean flags never consume the next argument (the start
 * URLs are positional and must not be swallowed); --key=value also works. */
function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!a.startsWith("--")) { opts._.push(a); continue; }
    const body = a.slice(2);
    const eq = body.indexOf("=");
    const key = (eq > 0 ? body.slice(0, eq) : body).toLowerCase();
    if (eq > 0) { opts[key] = body.slice(eq + 1); continue; }
    if (BOOL_FLAGS.has(key)) { opts[key] = true; continue; }
    const next = argv[i + 1];
    if (next === undefined || String(next).startsWith("--")) { opts[key] = ""; continue; }
    opts[key] = String(next);
    i++;
  }
  return opts;
}

function num(v, dflt) {
  if (v === undefined || v === null || v === "" || v === true) return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

// -------------------------------------------------------------------- fetch

// ----------------------------------------------------------------- enqueue

/** Minimal WS client: hello (native loopback client), then one reply per
 * reqId. Mirrors scripts/newtv-catalog-bridge.js's client shape. Resolves only
 * once the socket is OPEN — a request sent while CONNECTING throws
 * ("readyState 0"), which is exactly how the first version of this failed. */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 8000 });
    const pending = new Map();
    let appHello = null;
    let opened = false;
    const failPending = (type, message) => {
      for (const fn of pending.values()) fn({ type, message });
      pending.clear();
    };
    const client = {
      ws,
      appHello: () => appHello,
      // One reply per request; a closed socket answers the outstanding ones
      // with an error so the caller never hangs.
      request: (frame, key) => new Promise((res) => {
        pending.set(key, res);
        try { ws.send(JSON.stringify(frame)); }
        catch (e) { pending.delete(key); res({ type: "error", code: "WS_SEND_FAILED", message: e.message }); }
      }),
      close: () => { try { ws.close(); } catch { /* already gone */ } },
    };
    ws.on("open", () => {
      opened = true;
      ws.send(JSON.stringify({ type: "hello", v: "web-crawl", protocolVersion: 1 }));
      resolve(client);
    });
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg && msg.type === "hello") { appHello = msg; return; }
      const key = msg && (msg.reqId || msg.url);
      const fn = key && pending.get(key);
      if (fn) { pending.delete(key); fn(msg); }
    });
    ws.on("error", (e) => {
      failPending("error", "WS error: " + e.message);
      if (!opened) reject(e);
    });
    ws.on("close", () => failPending("error", "WS closed"));
  });
}

/** Send every discovered URL as its own `download` (docs/ws-protocol.md §3.1),
 * one at a time, honoring a retryable refusal (PACE_LIMITED) on the app's own
 * retryAfter window instead of hammering the throttle. */
async function enqueueAll(items, { wsUrl = DEFAULT_WS, cookieHeader = "", referer = "", maxRetries = 2, maxWaitMs = 120000, sleep, log } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const logf = log || (() => {});
  const client = await connect(wsUrl);
  const out = { accepted: 0, failed: [], refusals: 0, waitedMs: 0, appVersion: "" };
  try {
    let seq = 0;
    for (const it of items) {
      let attempt = 0;
      for (;;) {
        const id = "crawl-" + (++seq);
        const reply = await client.request({
          type: "download",
          reqId: id,
          url: it.url,
          title: it.title || "",
          referer: referer || it.referer || "",
          cookieHeader: cookieHeader || "",
        }, id);
        if (reply.type === "accepted") { out.accepted++; break; }
        const retryable = !!reply.retryable || reply.code === "PACE_LIMITED";
        const secs = reply.retryAfter != null && reply.retryAfter !== "" ? Number(reply.retryAfter) : 0;
        if (retryable && attempt < maxRetries) {
          attempt++;
          out.refusals++;
          const ms = Math.min(secs > 0 ? secs * 1000 : 60000, maxWaitMs);
          logf("  refused (" + (reply.code || "retryable") + ") — waiting " + Math.round(ms / 1000) + "s");
          if (ms > 0) { out.waitedMs += ms; await wait(ms); }
          continue;
        }
        out.failed.push({ url: it.url, code: reply.code || "", error: reply.message || "rejected" });
        break;
      }
    }
    const hello = client.appHello();
    if (hello && hello.version) out.appVersion = hello.version;
  } finally {
    client.close();
  }
  return out;
}

// -------------------------------------------------------------------- main

async function main(argv) {
  const opts = parseArgs(argv || []);
  if (opts.help) { process.stdout.write(HELP + "\n"); return 0; }

  const starts = opts._.slice();
  if (opts.start) starts.push(String(opts.start));
  if (!starts.length) { process.stderr.write(HELP + "\n"); return 2; }
  const bad = starts.filter((u) => !/^https?:\/\//i.test(u));
  if (bad.length) { process.stderr.write("web-crawl: not an http(s) URL: " + bad[0] + "\n"); return 2; }

  const follow = String(opts.follow || "next").toLowerCase();
  if (!["next", "links", "none"].includes(follow)) { process.stderr.write("web-crawl: --follow must be next|links|none\n"); return 2; }
  const collect = String(opts.collect || "media").toLowerCase();
  if (!["media", "pages"].includes(collect)) { process.stderr.write("web-crawl: --collect must be media|pages\n"); return 2; }

  const quiet = !!opts.quiet;
  const log = (line) => { if (!quiet) process.stderr.write(line + "\n"); };

  const headers = {};
  if (opts.ua) headers["User-Agent"] = String(opts.ua);
  if (opts.cookie) headers.Cookie = String(opts.cookie);

  const config = {
    delayMs: num(opts.delay, 1200),
    maxPages: num(opts["max-pages"], 25),
    maxDepth: num(opts["max-depth"], 1),
    follow,
    collect,
    sameHostOnly: !opts["any-host"],
  };
  log("crawl " + starts.length + " start url(s) — max-pages " + config.maxPages +
    ", follow " + follow + ", collect " + collect + ", delay " + config.delayMs + "ms" +
    (config.sameHostOnly ? ", same-host only" : ", any host"));

  const fetchPage = makeFetchPage({ headers, cfFallback: !opts["no-cf"] });
  const crawler = createCrawler(Object.assign({}, config, {
    fetchPage,
    isRejected: isRejectedUrl,
    onProgress: ({ page, stats }) => {
      const state = page.ok ? "ok " + page.status : "FAIL " + (page.error || page.status);
      log("  [" + stats.fetches + "] " + page.url + " — " + state +
        " (media " + page.media + ", links " + page.links + ", next " + page.next.length + ")");
    },
  }));

  let report;
  try {
    report = await crawler.crawl(starts);
  } catch (e) {
    process.stderr.write("web-crawl: " + e.message + "\n");
    return 1;
  }

  const urls = report.discovered.map((d) => d.url);
  const t = report.totals;
  let enq = null;
  if (opts.enqueue && urls.length) {
    const wsUrl = opts["deepgrab-ws"] || process.env.DEEPGRAB_WS_URL || DEFAULT_WS;
    log("enqueueing " + urls.length + " url(s) via " + wsUrl);
    try {
      enq = await enqueueAll(report.discovered, {
        wsUrl,
        cookieHeader: opts.cookie ? String(opts.cookie) : "",
        referer: opts.referer ? String(opts.referer) : "",
        log,
      });
    } catch (e) {
      process.stderr.write("web-crawl: enqueue failed: " + e.message + "\n");
      return 1;
    }
    if (enq.appVersion) log("app version " + enq.appVersion);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({}, report, { enqueue: enq }), null, 2) + "\n");
  } else {
    for (const u of urls) process.stdout.write(u + "\n");
  }
  if (opts.out) {
    try { fs.writeFileSync(String(opts.out), urls.join("\n") + (urls.length ? "\n" : "")); }
    catch (e) { process.stderr.write("web-crawl: cannot write " + opts.out + ": " + e.message + "\n"); return 1; }
  }

  log("done — " + t.pages + " page(s) fetched (" + t.failed + " failed), " + t.discovered +
    " discovered (" + t.media + " media, " + t.pageCandidates + " page candidates), " +
    t.rejected + " rejected, " + t.retries + " retry(ies), " + Math.round(t.waitedMs / 1000) + "s waited" +
    (t.truncated ? " [budget reached]" : "") +
    (enq ? "; enqueued " + enq.accepted + "/" + urls.length + (enq.failed.length ? ", " + enq.failed.length + " failed" : "") : ""));
  return 0;
}

module.exports = { parseArgs, parseRetryAfter, makeFetchPage, isRejectedUrl, connect, enqueueAll, main, HELP, DEFAULT_WS };

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => { process.stderr.write("web-crawl: " + (e && e.stack || e) + "\n"); process.exit(1); });
}
