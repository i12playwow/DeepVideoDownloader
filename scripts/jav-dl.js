#!/usr/bin/env node
"use strict";
// jav-dl — resolve a JAV code on MissAV (with mirror fallback) and download the
// best-quality HLS stream through the app's own download engine.
//
// Why a port of the standalone K:\jav-dl.py rather than a wrapper: this repo
// already owns every hard part — lib/http.js fetchHtml routes Cloudflare
// challenge bodies through the headed cf-browser bridge (lib/cf-fallback.js),
// lib/resolvers.js resolveMissav extracts the surrit m3u8 (eval-unpack for the
// obfuscated player included), and DownloadManager.runHls does master->best-
// variant picking, ad-segment filtering, parallel segments with resume, and the
// ffmpeg remux. The CLI only adds what the app lacks: code->page resolution,
// a queue, and skip-already-downloaded.
//
// Usage:
//   node scripts/jav-dl.js ipz-721                      # best quality, engine default dir
//   node scripts/jav-dl.js "IPZ 721" midv-832           # queue: sequential, skips existing
//   node scripts/jav-dl.js --from-file list.txt         # one code per line; # comments OK
//   node scripts/jav-dl.js ipz-721 --list-only          # resolve + show variants only
//   node scripts/jav-dl.js --url https://surrit.com/<uuid>/playlist.m3u8
//
// Slug candidates tried in order: <code>, -uncensored-leak, -uncensored-leak-sub,
// -chinese-sub, -english-sub, -cm, -ub, -uc. When every slug misses, a search
// fallback runs: MissAV's own search page, then mirror video pages discovered
// through the Wayback CDX index (search engines proved region-walled/bot-walled
// for plain fetches on this line), then the mirror page's Filemoon embed — its
// SPA page is fetched via the cf-browser bridge and scanned for an m3u8.
// --no-fallback turns the search stages off AND the python-engine last resort
// below. Last resort: when Node's whole chain fails — every slug + the
// search/mirror fallback, or the engine's auto-retry budget exhausted under a
// surrit challenge — the standalone python engine (K:\jav-dl.py, whose
// python-urllib fetches pass surrit's TLS-fingerprint gate where Node's fail)
// runs as a subprocess on the SAME output path. JAVDL_PY overrides the engine
// path (the boot-verify drill points it at a stub); JAVDL_PY=0/JAVDL_PY=false
// or --no-fallback disables the stage entirely.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { DownloadManager } = require("../downloader");
const { ProxyManager } = require("../proxy");
const { DEFAULT_CONFIG } = require("../config");
const { fetchHtml, UA } = require("../lib/http");
const { resolveMissav, isCfwalledSupjavMovie } = require("../lib/resolvers");
const { isHlsUrl, parseHlsPlaylist, HLS_MASTER_RE } = require("../lib/hls");
const { isCfChallengeBody } = require("../lib/cf-fallback");
const REPO = path.join(__dirname, "..");

// ------------------------------------------------------ TLS-fingerprint relay
// surrit's Cloudflare ALSO scores the client TLS fingerprint: Node's stack can
// be challenged while python-urllib passes from the same IP in the same second
// (header-identical head-to-head validated 2026-09-30; no TLS option — ALPN,
// cipher list, min/maxVersion — changes the verdict). When a direct master
// probe draws a challenge, the CLI reoriginates surrit fetches through a local
// python relay (scripts/surrit-relay.py, stdlib-only): plain loopback HTTP in,
// python TLS out. One relay serves the whole queue — the URL is the engine's
// dedupe/history key, so per-code ports would break re-run skips. Reused if a
// relay already listens on the port; only a relay THIS process spawned is
// killed at exit. Strictly optional: --no-relay / JAVDL_RELAY=0 disables,
// JAVDL_RELAY=force skips the probe and always relays (live debugging).
function relayPort() { return Number(process.env.JAVDL_RELAY_PORT) || 8931; } // read per-call: testable
const RELAY_HOSTS = (process.env.JAVDL_RELAY_HOSTS || "surrit.com")
  .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const RELAY_HOST_RE = new RegExp("^https?://(" + RELAY_HOSTS.map(escapeRe).join("|") + ")(:\\d+)?/", "i");
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
let relayProc = null, relaySpawnedByUs = false, relayPortLive = null;
function relayEnabled(args) {
  if (args && args.noRelay) return false; // the documented --no-relay CLI flag
  return process.env.JAVDL_RELAY !== "0" && process.env.JAVDL_RELAY !== "false";
}
function relayForced() { return process.env.JAVDL_RELAY === "force"; }
// Rewrite into the relay's path-embedded form: the ORIGINAL scheme+authority
// must ride INSIDE the path (/http/<host>[:<port>]/<rest>) — swapping only the
// origin prefix would lose the upstream host entirely (the relay would read
// "hls" as the scheme and 400). The port is the live relay's; passing one
// explicitly keeps the rewriter testable without a spawned relay.
function relayUrl(url, port) {
  const p = port || relayPortLive;
  if (!p) return url;
  const m = /^(https?:)\/\/([^/]+)((?:\/.*)?)$/i.exec(url);
  if (!m) return url;
  return "http://127.0.0.1:" + p + "/" + m[1].toLowerCase().replace(":", "") + "/" + m[2] + (m[3] || "/");
}

// Any HTTP answer (even the relay's 400 usage reply) proves something is
// listening; fetchHtml would throw on 4xx, so this is a raw probe.
function relayAlive(port) {
  const http = require("http");
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1500 }, (res) => { res.resume(); resolve(true); });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

async function ensureRelay(timeoutMs = 10000) {
  if (relayPortLive) return relayPortLive;
  if (await relayAlive(relayPort())) { relayPortLive = relayPort(); return relayPortLive; }
  const py = process.platform === "win32" ? "python" : "python3";
  const allowFlags = [];
  for (const h of RELAY_HOSTS) allowFlags.push("--allow", h);
  relayProc = spawn(py, [path.join(__dirname, "surrit-relay.py"), "--port", String(relayPort())].concat(allowFlags),
    { stdio: ["ignore", "pipe", "pipe"] });
  relaySpawnedByUs = true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (relayProc.exitCode !== null) throw new Error("relay exited early (code " + relayProc.exitCode + ")");
    if (await relayAlive(relayPort())) { relayPortLive = relayPort(); return relayPortLive; }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("relay did not start listening within " + timeoutMs + "ms");
}

function stopRelay() {
  if (relayProc && relaySpawnedByUs) { try { relayProc.kill(); } catch (e) { /* best effort */ } }
  relayProc = null; relaySpawnedByUs = false; relayPortLive = null;
}

// ------------------------------------------------ python-engine last resort
// Final fallback when Node's own chain fails (slugs + search/mirror resolve,
// or the engine's auto-retry exhausted under a surrit challenge): the
// standalone python engine (K:\jav-dl.py — headless-Chrome resolve + python-
// urllib segment fetches, proven end-to-end with a 1.42 GiB download) runs as
// a subprocess on the SAME output path. Python's TLS fingerprint passes
// surrit's gate where Node's fails, and the engine carries its own
// search/mirror discovery. Strictly optional: JAVDL_PY overrides the engine
// path (the boot-verify drill points it at a stub), JAVDL_PY=0/JAVDL_PY=false
// or --no-fallback disables the stage. A missing python interpreter surfaces
// as a logged spawn failure, never a crash.
const PY_ENGINE_DEFAULT = path.join("K:", "jav-dl.py");
function pyEnginePath() { return process.env.JAVDL_PY || PY_ENGINE_DEFAULT; }
function pyFallbackEnabled() {
  const v = process.env.JAVDL_PY;
  return v !== "0" && v !== "false";
}
function pyEngineAvailable() {
  if (!pyFallbackEnabled()) return false;
  try { return fs.existsSync(pyEnginePath()); } catch (e) { return false; }
}
// Inverse of relayUrl: recover the true upstream URL from a relay-rewritten
// one, so a python-engine --url run never depends on this process's relay
// (which dies with us) — the engine fetches upstream directly.
function unrelayUrl(url) {
  const m = /^http:\/\/127\.0\.0\.1:\d+\/(https?)\/([^/]+)((?:\/.*)?)$/i.exec(url);
  return m ? (m[1].toLowerCase() + "://" + m[2] + (m[3] || "")) : url;
}
function pyEngineArgs(target, outPath) {
  const engine = pyEnginePath();
  if (target && target.url) return [engine, "--url", unrelayUrl(target.url), "-o", outPath, "--force"];
  return [engine, target.code, "-o", outPath, "--force"];
}
// Output basename for a bare m3u8 target: surrit URLs carry a hex-36 uuid as
// their first path segment; anything else collapses to "stream".
function urlSlug(u) {
  try {
    const seg = new URL(u).pathname.split("/").filter(Boolean)[0];
    return seg ? decodeURIComponent(seg) : "stream";
  } catch (e) { return "stream"; }
}
// Run the python engine to completion, streaming its stdout/stderr through
// our log with a [py] prefix so a mixed Node/python run stays readable. Only
// invoked after a real Node failure, so the engine's headless-Chrome cost is
// bounded behind that failure. The timeout is a hang guard, not a download
// budget: a multi-GB segment fetch runs well inside 45 minutes.
function runPyEngine(target, outPath, timeoutMs = 45 * 60000) {
  const py = process.platform === "win32" ? "python" : "python3";
  const args = pyEngineArgs(target, outPath);
  log("[py-fallback] running python engine: " + py + " " +
    args.map((a) => /[\s"]/.test(a) ? JSON.stringify(a) : a).join(" "));
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let out = "", err = "";
    const finish = (r) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(r); } };
    const child = spawn(py, args, { stdio: ["ignore", "pipe", "pipe"] });
    timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* best effort */ }
      finish({ ok: false, code: -1, out, err: "python engine timed out after " + timeoutMs + "ms" });
    }, timeoutMs);
    child.stdout.on("data", (c) => {
      out += c;
      for (const line of c.toString().split(/\r?\n/)) if (line.trim()) log("  [py] " + line.trim());
    });
    child.stderr.on("data", (c) => {
      err += c;
      for (const line of c.toString().split(/\r?\n/)) if (line.trim()) log("  [py] " + line.trim());
    });
    child.on("error", (e) => finish({ ok: false, code: -1, out, err: String((e && e.message) || e) }));
    child.on("exit", (c) => finish({ ok: c === 0, code: c, out, err }));
  });
}
// The fallback stage itself: same output path the Node path would have
// written, success = engine exit 0 + non-trivial file on disk. The tried-set
// makes the stage idempotent per process: processCode's resolve-miss hook AND
// the main loop's not-found branch both call this, and the engine must never
// run twice for one code.
const pyFallbackTried = new Set();
async function pyFallback(target, args, outDir) {
  const slug = target && target.code ? normalizeCode(target.code)
    : (target && target.url ? urlSlug(unrelayUrl(target.url))
    : (args.out ? path.basename(args.out).replace(/\.mp4$/i, "") : "stream"));
  if (pyFallbackTried.has(slug)) return false;
  pyFallbackTried.add(slug);
  const outPath = args.out || path.join(outDir, slug + ".mp4");
  const r = await runPyEngine({ code: target.code || "stream" }, outPath);
  if (r.ok && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
    log("wrote " + outPath + " (python engine)");
    return true;
  }
  log("  python engine failed (exit " + r.code + (r.err ? ": " + String(r.err).split("\n")[0] : "") + ")");
  return false;
}

// Base site override: the boot-verify drill points this at a local mock MissAV
// (JAVDL_SITE=http://127.0.0.1:<port>) so Phase L resolves a fixture code with
// zero network egress. Fetches/referers all flow from this base.
const SITE = process.env.JAVDL_SITE || "https://missav.ws";
const SLUG_SUFFIXES = ["", "-uncensored-leak", "-uncensored-leak-sub", "-chinese-sub",
  "-english-sub", "-cm", "-ub", "-uc"];
const MIRROR_DOMAINS = ["javhd.today", "javdock.com", "bestjavporn.com", "javhdporn.net"];
// JAVDL_CDX_BASE: drill seam — Phase N points the Wayback CDX index at the
// local fixture (no rows) so mirror exhaustion costs zero network egress.
const CDX_BASE = process.env.JAVDL_CDX_BASE || "https://web.archive.org";

// --------------------------------------------------------------------- utils
function normalizeCode(code) {
  const slug = code.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("cannot normalize JAV code: " + JSON.stringify(code));
  return slug;
}

function log(msg) { console.log(msg); }

// ------------------------------------------------------------- page fetching
// Plain fetch first (lib/http.js — CF challenge bodies are auto-routed through
// the headed cf-browser bridge); a challenge body that still leaks through is
// scanned for the m3u8 before giving up, since the bridge already spent its
// headed-Chrome budget on the page.
async function fetchPage(url) {
  let html = await fetchHtml(url, null, { Referer: SITE + "/", "Accept-Language": "en-US,en;q=0.9" });
  let finalUrl = url;
  // MissAV serves a meta-refresh bounce (…/en/<slug> -> …/dm14/en/<slug>) that
  // http.request does NOT follow — the 679-byte shell has neither stream nor
  // 404 markers, so the slug sweep must chase it explicitly (Playwright did
  // this transparently in the standalone script).
  const bounce = html.match(/http-equiv="refresh"\s+content="\d+;url='([^']+)'/);
  if (bounce) {
    finalUrl = bounce[1];
    html = await fetchHtml(finalUrl, null, { Referer: SITE + "/", "Accept-Language": "en-US,en;q=0.9" });
  }
  if (isCfChallengeBody(html)) {
    const m = html.match(/https?:\/\/[^\s'"\\]+\.m3u8/);
    if (m) return { html, finalUrl, url: m[0] };
    throw Object.assign(new Error("MissAV: Cloudflare challenge not cleared for " + url),
      { category: "requires-browser" });
  }
  return { html, finalUrl };
}

function extractSurrit(html) {
  const m = html.match(/https:\/\/surrit\.com\/[0-9a-f-]{36}\/playlist\.m3u8/);
  return m ? m[0] : null;
}

// --------------------------------------------------------------- resolution
async function resolveBySlug(slug, ctx) {
  for (const suffix of SLUG_SUFFIXES) {
    const url = SITE + "/en/" + slug + suffix;
    let page;
    try {
      page = await fetchPage(url);
    } catch (err) {
      if (err.category === "requires-browser") throw err;
      continue; // 404s etc: next suffix
    }
    // Some pages carry the stream in plain form; others (packer-obfuscated) need
    // the resolver's eval-unpack — which also pulls og:title. Tiny shells are
    // 404 pages; real pages are ~344 KB. resolveMissav refetches the FINAL url
    // itself (one extra fetch per real hit, none for misses).
    const surrit = extractSurrit(page.html);
    if (surrit) return { m3u8: surrit, slug: slug + suffix };
    if (page.html.length < 10000) continue;
    try {
      const r = await resolveMissav(page.finalUrl, ctx, { Referer: SITE + "/" });
      return { m3u8: r.resolvedUrl, title: r.title, slug: slug + suffix };
    } catch (err) {
      if (/Cloudflare/.test(err.message)) throw err; // bridge exhausted: stop sweeping
      continue; // extraction miss (404 shape etc): next suffix
    }
  }
  return null;
}

// MissAV's own search page: different slug spelling, same site. Plain fetch of
// /en/search/<code> is JS-rendered, so this only pays off when the SSR'd HTML
// already carries result links; the cf-browser bridge body may carry more.
async function resolveBySearchPage(code, ctx) {
  const url = SITE + "/en/search/" + code;
  let html = "";
  try {
    html = (await fetchPage(url)).html;
  } catch { return null; }
  // result anchors: /en/<slug> whose nearby text contains the code
  const re = /href="\/en\/([a-z0-9-]+)\/?"[^>]*>([^<]{0,200})/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[2].toLowerCase().includes(code.toLowerCase())) return m[1];
  }
  return null;
}

// Mirror video pages via the Wayback CDX index (pure JSON API). General search
// engines are unusable over plain fetches here: DDG html/lite serve their no-JS
// landing and Bing returns a region-hijacked SERP (validated 2026-09-30).
async function mirrorPageUrls(code, limit = 10) {
  const out = [];
  for (const domain of MIRROR_DOMAINS) {
    const cdx = CDX_BASE + "/cdx/search/cdx?url=" + domain +
      "&matchType=domain&filter=original:.*" + code + ".*" +
      "&collapse=urlkey&limit=20&fl=original&output=json";
    let rows;
    try {
      rows = JSON.parse(await fetchHtml(cdx, null, {}, 0, 1));
    } catch (err) {
      log("  cdx " + domain + ": " + err.message);
      continue;
    }
    for (const row of (Array.isArray(rows) ? rows.slice(1) : [])) {
      const u = Array.isArray(row) ? row[0] : String(row);
      if (new RegExp(domain.replace(/\./g, "\\.") + "/\\d{3,}/[a-z0-9-]+").test(u) && !out.includes(u)) {
        out.push(u);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

// javhd.today-shape embed extraction: anchors carry
// aria-label="Open external download page on <Kind>" (icon/span markup sits
// between the tag and the label text, so inner-text matching misses them).
function extractEmbeds(html) {
  const embeds = [];
  const seen = new Set();
  const re = /href="(https?:\/\/[^"]+)"[^>]*?aria-label="Open external download page on ([A-Za-z0-9]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); embeds.push({ kind: m[2].toLowerCase(), url: m[1] }); }
  }
  if (!embeds.length) { // layout drift: any known embed host shape
    const re2 = /https?:\/\/(?:www\.)?(filemoon\.[a-z.]+\/[de]\/[0-9a-z]+|playmogo\.com\/d\/[0-9a-z]+)/g;
    while ((m = re2.exec(html)) !== null) {
      const url = "https://" + m[1];
      if (!seen.has(url)) { seen.add(url); embeds.push({ kind: url.includes("filemoon") ? "filemoon" : "playmogo", url }); }
    }
  }
  return embeds;
}

// Fetch an embed page through the cf-browser bridge (Filemoon is an SPA whose
// player only exists after JS; lib/http's fetchHtml has no JS runtime) and scan
// the rendered DOM for an m3u8.
async function renderEmbedForStream(page) {
  let mod;
  try { mod = require(path.join(REPO, "lib", "cf-fallback")); } catch { return null; }
  if (typeof mod.fetchViaCfBrowser !== "function") return null;
  try {
    const res = await mod.fetchViaCfBrowser(page);
    const html = (res && (res.html || res.body)) || "";
    if (!html) return null;
    if (/404 not found/i.test(html.slice(-2000))) { log("  embed 404: " + page); return null; }
    const m = html.match(/https?:\/\/[^\s'"\\]+\.m3u8[^\s'"\\]*/);
    return m ? m[0] : null;
  } catch (err) {
    log("  embed render failed: " + err.message);
    return null;
  }
}

// Full fallback chain. Returns {m3u8, label, referer} or null.
async function fallbackResolve(code, slug) {
  const ctx = { proxyManager: null, config: { maxRetries: 2 }, paceHost: null };
  log("  MissAV slugs exhausted; trying search fallback ...");
  const hit = await resolveBySearchPage(code, ctx);
  if (hit) {
    log("  missav search: " + code + " -> /en/" + hit);
    try {
      const page = await fetchPage(SITE + "/en/" + hit);
      const m3u8 = extractSurrit(page.html);
      if (m3u8) return { m3u8, label: slug + " (" + hit + ")", referer: SITE + "/" };
    } catch { /* fall through to mirrors */ }
    log("  missav search hit /en/" + hit + " but its stream never surfaced; trying mirror lookup ...");
  } else {
    log("  missav search: no hit; trying mirror lookup (wayback index) ...");
  }
  for (const pageUrl of await mirrorPageUrls(code)) {
    log("  mirror page: " + pageUrl.slice(0, 100));
    let embeds;
    try {
      embeds = extractEmbeds(await fetchHtml(pageUrl, null, { Referer: "https://www.google.com/" }));
    } catch { continue; }
    if (!embeds.length) continue;
    const ordered = embeds.filter((e) => e.kind === "filemoon").concat(embeds.filter((e) => e.kind !== "filemoon"));
    for (const embed of ordered) {
      log("  rendering " + embed.kind + " embed: " + embed.url);
      const m3u8 = await renderEmbedForStream(embed.url);
      if (m3u8) return { m3u8, label: slug + " (mirror)", referer: embed.url };
    }
    log("  mirror embeds dead or DRM-walled: " + embeds.slice(0, 3).map((e) => e.url).join(", "));
    log("  (these third-party links may still work in a real browser + IDM)");
  }
  return null;
}

// -------------------------------------------------------------- master parse
// lib/http.js DELIBERATELY skips the cf-browser handoff for .m3u8 URLs (the app
// covers playlist fetches with its built-in-browser cookie bridge instead).
// Validated 2026-09-30: surrit's Cloudflare runs a ROLLING per-IP reputation
// window — the same plain fetch returned 200/#EXTM3U and 403/challenge minutes
// apart, python-urllib and Node flipped together, the headed cf-browser Chrome
// got hard-blocked ("Attention Required") and even bridge cookies did not
// unblock Node. No client trick rides this out; time does. So: only --list-only
// pre-fetches the master (variant listing is informational); the DOWNLOAD path
// hands the m3u8 straight to the engine, whose own playlist fetch + maxRetries +
// auto-retry (autoRetryMinutes) is the mechanism that outlives a hot window.
async function fetchMasterForListing(m3u8) {
  const body = await fetchHtml(m3u8, null, { Referer: SITE + "/" });
  if (!body.includes("#EXTM3U")) {
    throw new Error("surrit returned a Cloudflare challenge for the playlist — this IP's " +
      "reputation window is hot right now. Retry in a few minutes, or just run the " +
      "download without --list-only: the engine's own retries ride the window out.");
  }
  return body;
}

// Minimal master playlist listing for --list-only. The DOWNLOAD itself re-picks
// inside the engine (runHls), which also handles variant->master upgrades.
function listVariants(masterBody, masterUrl) {
  const out = [];
  const lines = masterBody.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF/.test(lines[i])) continue;
    const res = /RESOLUTION=(\d+)x(\d+)/.exec(lines[i]);
    const bw = /BANDWIDTH=(\d+)/.exec(lines[i]);
    const uri = lines.slice(i + 1).find((ln) => ln.trim() && !ln.startsWith("#"));
    if (uri) out.push({
      resolution: res ? res[1] + "x" + res[2] : "?",
      bandwidth: bw ? Math.round(Number(bw[1]) / 1000) : 0,
      url: new URL(uri.trim(), masterUrl).href,
    });
  }
  return out;
}

// --------------------------------------------------------------------- queue
function buildQueue(argv) {
  const codes = [];
  let fromFile = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from-file") fromFile = argv[++i];
    else if (!a.startsWith("--") && a !== argv.urlFlag) codes.push(a);
  }
  if (fromFile) {
    const p = path.resolve(fromFile);
    if (!fs.existsSync(p)) throw new Error("--from-file: no such file: " + p);
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const s = line.trim();
      if (s && !s.startsWith("#")) codes.push(s);
    }
  }
  return [...new Set(codes)];
}

function parseArgs(argv) {
  const args = { codes: [], quality: "best", url: null, out: null, listOnly: false,
    force: false, noFallback: false, noRelay: false, fromFile: null, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "-o" || a === "--out") args.out = argv[++i];
    else if (a === "--quality") args.quality = argv[++i];
    else if (a === "--from-file") args.fromFile = argv[++i];
    else if (a === "--list-only") args.listOnly = true;
    else if (a === "--force") args.force = true;
    else if (a === "--no-fallback") args.noFallback = true;
    else if (a === "--no-relay") args.noRelay = true;
    else if (a === "--retry-wait-min") args.retryWaitMin = Number(argv[++i]);
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "-h" || a === "--help") args.help = true;
    else if (!a.startsWith("--")) args.codes.push(a);
  }
  return args;
}

// ----------------------------------------------------------------- main flow
async function processCode(code, args, dm, outDir) {
  // args.url mode passes code=null — the slug is only used for the default
  // output basename (and only when -o is absent).
  const slug = code ? normalizeCode(code) : (args.out ? path.basename(args.out).replace(/\.mp4$/i, "") : "stream");
  let m3u8 = null, referer = SITE + "/", label = slug;

  if (args.url) {
    // --url may arrive relay-rewritten (a caller pastes a `stream:` line from
    // a JAVDL_RELAY=force session); recover the true upstream so the engine's
    // master→variant→segment chain and any python fallback target surrit
    // directly. No-op for a plain URL.
    m3u8 = unrelayUrl(args.url);
  } else {
    log("resolving " + slug + " ...");
    const ctx = { proxyManager: null, config: { maxRetries: 2 }, paceHost: null };
    const bySlug = await resolveBySlug(slug, ctx);
    if (bySlug) {
      m3u8 = bySlug.m3u8;
      label = bySlug.slug;
    } else if (!args.noFallback) {
      const fb = await fallbackResolve(code, slug);
      if (!fb) {
        // --list-only has no download to delegate; the python-engine stage is
        // download-only by design (its own discovery runs at download time).
        if (pyEngineAvailable() && !args.listOnly) return await pyFallback({ code }, args, outDir);
        return false;
      }
      m3u8 = fb.m3u8; label = fb.label; referer = fb.referer || referer;
    } else {
      // --no-fallback also kills the python-engine stage: the user asked for
      // "MissAV slug probe only", in any engine.
      return false;
    }
  }

  let cookieHeader = null;
  if (args.listOnly) {
    let master;
    try {
      master = await fetchMasterForListing(m3u8);
    } catch (err) {
      // A challenge on the listing path gets the relay retry too.
      if (!/Cloudflare/.test(err.message || "") || !relayEnabled(args)) throw err;
      log("  listing challenged — retrying through the TLS relay ...");
      await ensureRelay();
      const body = await fetchHtml(relayUrl(m3u8), null, { Referer: SITE + "/" });
      if (!body.includes("#EXTM3U")) throw err;
      master = body;
    }
    const variants = listVariants(master, m3u8);
    log("stream: " + m3u8);
    for (const v of variants.sort((a, b) => a.bandwidth - b.bandwidth)) {
      log("  variant: " + v.resolution + " @ " + v.bandwidth + " kb/s");
    }
    return true;
  }
  log("stream: " + m3u8);

  // Gate probe: one cheap direct master fetch. A Cloudflare challenge here is
  // the TLS-fingerprint verdict, not a dead stream (python passes in the same
  // second) — so rather than burn 30 min of blind auto-retry on a gate that
  // never opens for Node, reorigin surrit fetches through the local python
  // relay. Anything else (timeout, 404, network) leaves the URL untouched.
  if (relayEnabled(args) && RELAY_HOST_RE.test(m3u8)) {
    const gated = await (async () => {
      if (relayForced()) return true;
      try {
        const body = await fetchHtml(m3u8, null, { Referer: SITE + "/" });
        return isCfChallengeBody(body);
      } catch (e) {
        return /Cloudflare|challenge/i.test(e.message || "");
      }
    })();
    if (gated) {
      try {
        log("  surrit challenged Node's TLS fingerprint — routing fetches through the local python relay ...");
        await ensureRelay();
        m3u8 = relayUrl(m3u8);
      } catch (e) {
        log("  relay unavailable (" + (e.message || e) + ") — falling back to direct fetch + auto-retry");
      }
      if (!relayPortLive && relayForced()) throw new Error("--JAVDL_RELAY=force but the relay could not start");
    }
  }

  const outPath = args.out || path.join(outDir, slug + ".mp4");
  if (fs.existsSync(outPath) && !args.force && !args.limit) {
    if (args.out) throw new Error("refusing to overwrite existing " + outPath + " (use --force)");
    log("[skip] " + slug + ": " + path.basename(outPath) + " already exists");
    return true;
  }
  // The engine names files from the title, so an explicit -o basename must
  // BECOME the title (dirOverride only steers the directory).
  const title = args.out ? path.basename(outPath).replace(/\.mp4$/i, "") : slug;
  // autoRetry rides out surrit's rolling per-IP Cloudflare window (validated
  // 2026-09-30: plain fetches 200 and 403 minutes apart, no header/TLS/cookie
  // trick helps). A CLI run should WAIT that out, not die on the first 403:
  // default 2-minute cycles, up to 15 of them (~30 min), overridable.
  const autoRetryMinutes = args.retryWaitMin !== undefined ? args.retryWaitMin
    : (dm.config.autoRetryMinutes || 2);
  const engineOpts = { autoRetryMinutes, autoRetryMax: 15 };

  // Hand the stream to the app's own engine: title encodes the resolved slug so
  // the engine's dedupe/rename machinery applies; the engine picks the best
  // variant, filters ads, resumes partials, and remuxes via its own ffmpeg.
  log("downloading via engine to " + outPath + " ...");
  const cfg = { ...DEFAULT_CONFIG, ...dm.config, downloadDir: path.dirname(outPath),
    autoRetryMinutes, autoRetryMax: engineOpts.autoRetryMax };
  const engine = args.limit
    ? new DownloadManager({ config: cfg, proxyManager: new ProxyManager(cfg), onUpdate: () => {} })
    : dm;
  const id = await engine.enqueue({
    url: m3u8,
    title,
    referer,
    dirOverride: path.dirname(outPath),
    force: args.force || Boolean(args.limit),
    markDuplicate: false,
  });
  if (!id) { log("[skip] " + slug + ": engine reported duplicate"); return true; }
  // Wait across auto-retry cycles: an error status with retry budget left is
  // followed by the engine requeueing (status -> queued), so only a terminal
  // state after the LAST cycle (or 'done') settles the promise.
  await new Promise((resolve, reject) => {
    let lastNote = "", lastSig = "", lastChange = Date.now();
    const poll = setInterval(() => {
      const it = engine.items.get(id);
      if (!it) return;
      if (it.status === "running" && it.total) {
        process.stdout.write("\r  " + Math.floor((it.received / it.total) * 100) + "% of " +
          Math.round(it.total / 1e6) + " MB   ");
      } else if (it.status === "error") {
        // Terminal only when the retry budget is spent — the engine keeps
        // status "error" after its final failed cycle (there is no separate
        // "terminal" state), so an unconditional reject here would kill a
        // run that still has cycles coming, and waiting forever would wedge.
        const exhausted = /Auto-retry exhausted/.test(it.error || "") ||
          (it._autoRetries || 0) >= engineOpts.autoRetryMax;
        if (exhausted) {
          clearInterval(poll);
          process.stdout.write("\n");
          // LAST RESORT: the engine's budget spent under a surrit challenge —
          // hand the target to the standalone python engine, whose urllib TLS
          // fingerprint passes the gate, on the SAME output path. --url mode
          // delegates the m3u8 itself (pyFallback un-relays it — this
          // process's relay dies with us); code mode re-resolves from scratch.
          const engineErr = "engine: " + it.status + (it.error ? " — " + it.error : "");
          if (pyEngineAvailable()) {
            pyFallback(code ? { code } : { url: m3u8 }, args, outDir).then((pyOk) => {
              if (pyOk) resolve();
              else reject(new Error(engineErr + " (python fallback also failed)"));
            }).catch((e) => reject(new Error(engineErr + " (python fallback crashed: " + ((e && e.message) || e) + ")")));
          } else {
            reject(new Error(engineErr));
          }
          return;
        }
        const note = "engine error — auto-retry cycle " +
          ((it._autoRetries || 0) + 1) + "/" + engineOpts.autoRetryMax +
          " (next attempt in " + autoRetryMinutes + " min): " + (it.error || "unknown");
        if (note !== lastNote) { process.stdout.write("\n  " + note + "\n"); lastNote = note; }
      } else if (it.status === "scheduled" && lastNote) {
        process.stdout.write("\r  retrying in " + autoRetryMinutes + " min...                     ");
      } else if (it.status === "done") {
        clearInterval(poll);
        process.stdout.write("\n");
        resolve();
      }
      // Stall watchdog: this poll once wedged for an hour when auto-retry was
      // accidentally disabled (status never changed again) — any state with no
      // progress for 20 minutes is treated as a hang worth reporting.
      const sig = it.status + ":" + it.received;
      if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); }
      else if (Date.now() - lastChange > 20 * 60000) {
        clearInterval(poll);
        reject(new Error("engine stalled: status=" + it.status + " received=" + it.received + " for 20min (error: " + (it.error || "none") + ")"));
      }
    }, 1500);
  });
  log("wrote " + outPath);
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.codes.length && !args.url && !args.fromFile)) {
    console.log("usage: node scripts/jav-dl.js <code...> | --from-file LIST | --url <m3u8>");
    console.log("       [--quality best|720|480|360] [-o OUT] [--list-only] [--limit N]");
    console.log("       [--force] [--no-fallback] [--no-relay] [--retry-wait-min N]");
    console.log("JAV code -> MissAV stream (search/mirror fallback) -> engine HLS download.");
    console.log("Last resort on failure: the standalone python engine (JAVDL_PY, default K:\\jav-dl.py) re-runs the code.");
    process.exit(args.help ? 0 : 1);
  }
  if (args.codes.length > 1 && args.out) throw new Error("-o applies to a single code only");
  const fromFileArg = args.fromFile;
  const allCodes = args.url ? [] : (() => {
    const codes = [...args.codes];
    if (fromFileArg) {
      const p = path.resolve(fromFileArg);
      if (!fs.existsSync(p)) throw new Error("--from-file: no such file: " + p);
      for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
        const s = line.trim();
        if (s && !s.startsWith("#")) codes.push(s);
      }
    }
    return [...new Set(codes)];
  })();
  if (!args.url && !allCodes.length) throw new Error("give a JAV code, several codes, or --from-file LIST");

  // JAVDL_OUT_DIR (drill seam) overrides the default download dir without
  // needing an explicit -o on every invocation.
  const outDir = args.out ? path.dirname(path.resolve(args.out))
    : (process.env.JAVDL_OUT_DIR || DEFAULT_CONFIG.downloadDir || process.cwd());
  const config = { ...DEFAULT_CONFIG, autoProxy: false, skipDuplicates: false,
    // Auto-retry is the mechanism that rides out surrit's rolling CF window.
    // DEFAULT_CONFIG has autoRetryMinutes: 0 (= OFF) and these used to be
    // threaded only into the --limit branch's engine — so on the normal path
    // the FIRST 403 went terminal, no cycle 2 ever ran, and the CLI's wait
    // loop wedged. Wired on the shared dm so every code in a queue retries.
    autoRetryMinutes: args.retryWaitMin !== undefined ? args.retryWaitMin : 2,
    autoRetryMax: 15 };
  const dm = new DownloadManager({ config, proxyManager: new ProxyManager(config), onUpdate: () => {} });

  const ok = [], skipped = [], failed = [];
  if (args.url) {
    if (args.codes.length) throw new Error("--url cannot be combined with codes");
    if (args.listOnly) {
      let master = null, gated = false;
      try { master = await fetchMasterForListing(args.url); }
      catch (err) { gated = /Cloudflare/.test(err.message || ""); }
      if (master) log("stream: " + args.url);
      else if (gated && relayEnabled(args)) {
        log("  listing challenged — retrying through the TLS relay ...");
        try {
          await ensureRelay();
          master = await fetchHtml(relayUrl(args.url), null, { Referer: SITE + "/" });
        } catch (e) { log("  relay listing failed: " + ((e && e.message) || e)); }
      }
      if (master && master.includes("#EXTM3U")) {
        log("stream: " + args.url);
        for (const v of listVariants(master, args.url).sort((a, b) => a.bandwidth - b.bandwidth)) {
          log("  variant: " + v.resolution + " @ " + v.bandwidth + " kb/s");
        }
      } else log("stream: " + args.url + " (listing gated" + (pyEngineAvailable() ? " — the python engine can list it: JAVDL_PY engine --url mode" : "") + ")");
      return true;
    }
    await processCode(null, args, dm, outDir);
  } else {
    const multi = allCodes.length > 1;
    for (const code of allCodes) {
      const slug = normalizeCode(code);
      const outPath = args.out || path.join(outDir, slug + ".mp4");
      try {
        if (multi && !args.listOnly && fs.existsSync(outPath) && !args.force && !args.limit) {
          log("[skip] " + slug + ": " + path.basename(outPath) + " already exists");
          skipped.push(slug);
          continue;
        }
        log("\n=== " + slug + " ===");
        if (await processCode(code, args, dm, outDir)) ok.push(slug);
        else {
          // Resolution failed everywhere in Node — the python engine carries
          // its own (headless-Chrome) discovery, so it still gets one shot.
          if (pyEngineAvailable() && !args.noFallback) {
            if (await pyFallback({ code }, args, outDir)) { ok.push(slug); continue; }
          }
          failed.push([slug, "not found on MissAV or in mirror search"]); log("[fail] " + slug + ": not found");
        }
      } catch (err) {
        failed.push([slug, err.message]);
        log("[fail] " + slug + ": " + err.message);
      }
    }
  }

  if (!args.url && allCodes.length > 1) {
    log("\n=== queue summary: " + ok.length + " ok, " + skipped.length + " skipped, " + failed.length + " failed ===");
    for (const [slug, err] of failed) log("  FAILED " + slug + ": " + err);
  }
  if (failed.length) process.exitCode = 1;
}

if (require.main === module) {
  main().then(() => { stopRelay(); process.exit(process.exitCode || 0); }).catch((err) => {
    stopRelay();
    console.error("jav-dl: " + (err && err.message || err));
    process.exit(1);
  });
}

// Test seams: the boot-verify drill drives processCode programmatically against
// a mock MissAV (JAVDL_SITE) instead of spawning the CLI as a child.
module.exports = { normalizeCode, processCode, buildQueue, parseArgs,
  _internals: { SITE, SLUG_SUFFIXES, resolveBySlug, relayUrl, ensureRelay, stopRelay,
    pyEnginePath, pyFallbackEnabled, pyEngineAvailable, unrelayUrl, pyEngineArgs,
    runPyEngine, pyFallback, urlSlug, relayEnabled } };
