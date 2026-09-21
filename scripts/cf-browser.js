#!/usr/bin/env node
// cf-browser: drive a REAL headed Chrome over CDP to bypass Cloudflare's
// bot checks the way a normal browser does.
//
// Design rules that make it pass:
//   - headed, real Chrome (no --headless, no --enable-automation, no CDP
//     "AutomationControlled" leaks) -> navigator.webdriver === false
//   - persistent profile dir -> cf_clearance cookie survives across runs,
//     so a challenge solved once is not solved again
//   - waits out interstitials (up to --timeout) instead of racing them;
//     interactive Turnstile shows a visible window the human can click
//   - WARM BY DEFAULT: a one-shot fetch leaves the browser running so the
//     next run reuses it via the profile's cdp.json -- repeat fetches of a
//     CF site skip the challenge wait entirely (clearance is already in the
//     live jar). Opt out with --cold to close the browser after the fetch.
//
// Usage:
//   node scripts/cf-browser.js <url> [--out file.html] [--session file.json]
//        [--profile dir] [--timeout ms] [--keep] [--cold] [--headless]
//   node scripts/cf-browser.js --serve 8899          # HTTP API for pipelines
//   node scripts/cf-browser.js --status              # is the shared browser up?
//
// HTTP API (serve mode):
//   GET  /health -> {"ok":true,...}
//   POST /fetch  {"url":"...","timeoutMs":90000} -> summary + html + cookies
//
// Summary JSON always printed to stdout. Logs go to stderr.
"use strict";

const { spawn, execFileSync } = require("child_process");
const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");

// ---------------------------------------------------------------- chrome bin
function findChrome() {
  const candidates = [
    process.env.CF_BROWSER_CHROME,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(REPO, ".freebuff", "runner", "xt-cft", "chrome-win64", "chrome.exe"), // Chrome for Testing fallback
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  throw new Error("no Chrome found; set CF_BROWSER_CHROME to a chrome.exe path");
}

// ---------------------------------------------------------------- CDP client
class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }
  async send(method, params = {}, sessionId) {
    await this.opened;
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }
  on(fn) { this.listeners.push(fn); }
  async close() {
    // Ask the browser to shut down gracefully and WAIT for it: a graceful
    // exit flushes the cookie DB to the profile (cf_clearance persistence),
    // while an immediate taskkill would lose session cookies. Cap the wait;
    // the caller's taskkill sweep catches anything left over.
    await new Promise((resolve) => {
      try { this.ws.send(JSON.stringify({ id: this.nextId++, method: "Browser.close", params: {} })); } catch { /* already dead */ }
      const t = setTimeout(resolve, 4000);
      this.ws.once("close", () => { clearTimeout(t); resolve(); });
    });
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

function log(...args) { console.error("[cf]", ...args); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- browser setup
// Orphan sweep: a previous crashed run can leave a live browser holding the
// profile; a fresh spawn on a singleton-locked profile exits instantly
// without binding the debug port (observed 2026-09-22). Kill by cmdline so
// the user's own browser (different dir) is never touched.
function sweepProfileHolders(profileDir) {
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
       path.join(REPO, ".freebuff", "runner", "sweep-chrome-profile.ps1"),
       "-Dir", profileDir],
      { encoding: "utf8", timeout: 30000, windowsHide: true });
    const m = /cleaned=(\d+)/.exec(out);
    if (m && Number(m[1]) > 0) log(`swept ${m[1]} orphaned chrome process(es) holding the profile`);
  } catch (e) {
    log("orphan sweep failed (continuing):", (e.message || "").slice(0, 120));
  }
}

// Reserve a real TCP port so we can poll /json/version directly. We do NOT
// trust the spawned process handle: on Windows chrome.exe sometimes re-execs
// itself (update relaunch), the first process exits 0, and the relaunched
// browser re-binds the same flags. Polling the endpoint survives that.
function reservePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function httpGetJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
  });
}

async function launchBrowser(profileDir, headless) {
  fs.mkdirSync(profileDir, { recursive: true });
  // A previous run may have left a live browser on this profile: reuse it.
  const cdpFile = path.join(profileDir, "cdp.json");
  if (fs.existsSync(cdpFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(cdpFile, "utf8"));
      const cdp = new CDP(prev.ws);
      await cdp.send("Browser.getVersion");
      log("reusing running browser on profile (pid " + prev.pid + ")");
      return { cdp, pid: prev.pid, reused: true, port: prev.port || null };
    } catch { fs.rmSync(cdpFile, { force: true }); }
  }
  const chrome = findChrome();
  const absProfile = path.resolve(profileDir);
  sweepProfileHolders(absProfile);
  const port = await reservePort();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${absProfile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-session-crashed-bubble",
    // keep the fingerprint human: window size + no automation flags. Do NOT
    // add --enable-automation / --headless=new unless --headless was asked.
    "--window-size=1280,900",
    "--disable-blink-features=AutomationControlled",
    "--lang=en-US",
    "about:blank",
  ];
  if (headless) args.unshift("--headless=new"); // discouraged: CF detects headless
  log("launching", chrome, "(devtools port", port + ")");
  // detached: chrome must survive this node process (console teardown in
  // MSYS/Git-Bash shells kills attached children -- observed 2026-09-22),
  // otherwise --keep/serve modes die the moment the spawning shell exits.
  // GUI window is unaffected; stdio is ignored since we poll the endpoint.
  const child = spawn(chrome, args, { stdio: "ignore", detached: true });
  child.unref();

  // Poll the DevTools endpoint until the browser (or its relaunch) binds it.
  const deadline = Date.now() + 25000;
  let version = null;
  while (Date.now() < deadline) {
    await sleep(300);
    try { version = await httpGetJson(`http://127.0.0.1:${port}/json/version`); break; }
    catch { /* not up yet */ }
  }
  if (!version || !version.webSocketDebuggerUrl) {
    throw new Error("chrome never exposed a DevTools endpoint on port " + port);
  }
  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.send("Browser.getVersion");
  // The real browser pid (the spawned handle may be a short-lived launcher).
  let pid = null;
  try {
    const procInfo = await cdp.send("SystemInfo.getProcessInfo");
    pid = (procInfo.processes.find((p) => p.type === "browser") || {}).id || null;
  } catch { /* optional */ }
  fs.writeFileSync(cdpFile, JSON.stringify({ ws: version.webSocketDebuggerUrl, pid, port }));
  return { cdp, pid, reused: false, port };
}

// -------------------------------------------------------------- page drivers
async function evalJS(cdp, sessionId, expression) {
  const r = await cdp.send("Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: false }, sessionId);
  if (r.exceptionDetails) throw new Error("page eval failed: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

const CHALLENGE_SNIPPET = `(() => {
  // Title markers are the stablest signal across Cloudflare variants
  // ("Just a moment...", "Attention Required!", "Checking your browser").
  // DOM markers cover the classic interstitial DOM plus the newer
  // Turnstile-based structure (2024+ reshuffled these ids).
  const title = (document.title || '').toLowerCase();
  const titleMarkers = ['just a moment', 'attention required', 'checking your browser', 'verify you are human'];
  if (titleMarkers.some(m => title.includes(m))) return true;
  const t = document.body ? document.body.innerText : '';
  const bodyMarkers = ['Verify you are human', 'Verifying you are human', 'Checking your browser', 'Enable JavaScript and cookies to continue'];
  if (bodyMarkers.some(m => t.includes(m))) return true;
  if (document.querySelector('#challenge-form, #challenge-running, #challenge-stage, #challenge-error-text, .cf-turnstile, .spu-container, iframe[src*="challenges.cloudflare.com"]')) return true;
  return false;
})()`;

async function attachToPage(cdp) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);
  return { targetId, sessionId };
}

async function closePage(cdp, targetId) {
  try { await cdp.send("Target.closeTarget", { targetId }); } catch { /* already gone */ }
}

// Navigate + wait out any Cloudflare interstitial. Returns page facts.
async function fetchThroughBrowser(cdp, url, { timeoutMs = 90000 } = {}) {
  const { targetId, sessionId } = await attachToPage(cdp);
  const started = Date.now();
  let sawChallenge = false;
  let lastChallengeHint = "";
  try {
    log("navigating", url);
    await cdp.send("Page.navigate", { url }, sessionId);

    while (Date.now() - started < timeoutMs) {
      await sleep(1000);
      let ready = "", finalUrl = "", challenged = false, webdriver = null;
      try {
        ready = await evalJS(cdp, sessionId, "document.readyState");
        finalUrl = await evalJS(cdp, sessionId, "location.href");
        challenged = await evalJS(cdp, sessionId, CHALLENGE_SNIPPET);
        webdriver = await evalJS(cdp, sessionId, "navigator.webdriver");
      } catch { /* navigation in flight, evaluate can transiently fail */ }
      if (challenged) {
        sawChallenge = true;
        const elapsed = Math.round((Date.now() - started) / 1000);
        if (elapsed % 5 === 0) {
          const hint = await evalJS(cdp, sessionId,
            `(document.querySelector('.cf-turnstile,#challenge-form') ? 'interactive checkbox may need a human click' : 'interstitial auto-verifying')`)
            .catch(() => "");
          if (hint && hint !== lastChallengeHint) { lastChallengeHint = hint; log(`challenge detected (${elapsed}s elapsed): ${hint}`); }
          else log(`waiting out challenge... ${elapsed}s`);
        }
        continue;
      }
      if (ready === "complete" && finalUrl && finalUrl !== "about:blank") {
        await sleep(1200); // let late scripts settle before HTML capture
        break;
      }
    }

    const finalUrl = await evalJS(cdp, sessionId, "location.href").catch(() => "");
    const title = await evalJS(cdp, sessionId, "document.title").catch(() => "");
    const stillChallenged = await evalJS(cdp, sessionId, CHALLENGE_SNIPPET).catch(() => true);
    const userAgent = await evalJS(cdp, sessionId, "navigator.userAgent").catch(() => "");
    const html = await evalJS(cdp, sessionId, "document.documentElement.outerHTML").catch(() => "");
    const { cookies } = await cdp.send("Network.getCookies",
      { urls: [finalUrl].filter(Boolean) }, sessionId);
    return {
      ok: Boolean(finalUrl && finalUrl !== "about:blank" && !stillChallenged),
      url, finalUrl, title,
      challenged: sawChallenge,
      stillChallenged,
      waitedMs: Date.now() - started,
      navigatorWebdriver: null, // filled by caller via one extra eval
      cookies, html, userAgent,
    };
  } finally {
    await closePage(cdp, targetId);
  }
}

// -------------------------------------------------------------------- modes
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--serve") args.serve = Number(argv[++i]);
    else if (a === "--status") args.status = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--session") args.session = argv[++i];
    else if (a === "--profile") args.profile = argv[++i];
    else if (a === "--timeout") args.timeout = Number(argv[++i]);
    else if (a === "--keep") args.keep = true; // now the default; kept for compat
    else if (a === "--cold") args.cold = true;
    else if (a === "--headless") args.headless = true;
    else if (a === "--connect") args.connect = argv[++i];
    else args._.push(a);
  }
  return args;
}

function stripHtml(f) { const { html, ...rest } = f; return rest; }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profileDir = args.profile || path.join(REPO, ".freebuff", "cf-profile");
  const cdpFile = path.join(profileDir, "cdp.json");

  // --status: report whether the shared profile browser is up
  if (args.status) {
    try {
      const prev = JSON.parse(fs.readFileSync(cdpFile, "utf8"));
      const cdp = new CDP(prev.ws);
      const v = await cdp.send("Browser.getVersion");
      console.log(JSON.stringify({ ok: true, reused: true, pid: prev.pid, userAgent: v.userAgent }));
      try { cdp.ws.close(); } catch { /* ignore */ }
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    // Exit explicitly: a live CDP websocket would otherwise keep this node
    // process alive forever after the report (observed 2026-09-22).
    process.exit(0);
  }

  // --serve: HTTP API around one shared browser
  if (args.serve) {
    const { cdp } = await launchBrowser(profileDir, false);
    const server = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url.startsWith("/health")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, profile: profileDir }));
      }
      if (req.method === "POST" && req.url.startsWith("/fetch")) {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
          try {
            const { url, timeoutMs } = JSON.parse(body || "{}");
            if (!url) throw new Error("body must be {url, timeoutMs?}");
            const fact = await fetchThroughBrowser(cdp, url, { timeoutMs: timeoutMs || 90000 });
            // strip big fields? keep html: pipelines want it
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(fact));
          } catch (e) {
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
          }
        });
        return;
      }
      res.writeHead(404); res.end("not found");
    });
    server.listen(args.serve, "127.0.0.1", () =>
      log(`serve mode: http://127.0.0.1:${args.serve}  (POST /fetch {"url":...}) — browser stays up, Ctrl+C to stop`));
    const shutdown = async () => { await cdp.close().catch(() => {}); try { fs.rmSync(cdpFile, { force: true }); } catch {} process.exit(0); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  // default: one-shot fetch
  const url = args._[0];
  if (!url) {
    console.error("usage: node scripts/cf-browser.js <url> [--out f.html] [--session f.json] [--profile dir] [--timeout ms] [--cold]");
    process.exit(2);
  }
  let browserInfo;
  if (args.connect) browserInfo = { cdp: new CDP(args.connect) };
  else browserInfo = await launchBrowser(profileDir, !!args.headless);
  const { cdp, pid, reused, port } = browserInfo;

  const fact = await fetchThroughBrowser(cdp, url, { timeoutMs: args.timeout || 90000 });
  // one extra fingerprint proof on a live page context
  try {
    const probe = await attachToPage(cdp);
    fact.navigatorWebdriver = await evalJS(cdp, probe.sessionId, "navigator.webdriver");
    await closePage(cdp, probe.targetId);
  } catch { /* non-fatal */ }

  let outFile, sessionFile;
  if (args.out === "-") {
    // Machine mode: emit ONLY the marker + base64 HTML block on stdout so a
    // bridging process can capture arbitrarily large HTML without shell/JSON
    // quoting hazards. The summary JSON goes to stderr instead.
    outFile = "-";
  } else if (args.out) {
    fs.writeFileSync(args.out, fact.html);
    outFile = args.out;
  }
  if (args.session) {
    const sess = {
      fetchedAt: new Date().toISOString(),
      finalUrl: fact.finalUrl,
      userAgent: fact.userAgent,
      cookies: fact.cookies,
    };
    fs.writeFileSync(args.session, JSON.stringify(sess, null, 2));
    sessionFile = args.session;
  }
  const summary = {
    ok: fact.ok, url: fact.url, finalUrl: fact.finalUrl, title: fact.title,
    challenged: fact.challenged, stillChallenged: fact.stillChallenged,
    waitedMs: fact.waitedMs, navigatorWebdriver: fact.navigatorWebdriver,
    cookieCount: fact.cookies.length,
    hasCfClearance: fact.cookies.some((c) => c.name === "cf_clearance"),
    userAgent: fact.userAgent, outFile, sessionFile, reused, pid: pid || null,
  };
  if (args.out === "-") {
    process.stdout.write("---CFB64---" + Buffer.from(fact.html, "utf8").toString("base64") + "\n");
    log("summary", JSON.stringify(summary));
  } else {
    console.log(JSON.stringify(summary, null, 2));
  }

  if (args.cold) {
    // Explicit opt-out: fully close the browser after the fetch. The graceful
    // Browser.close flushes the cookie DB; then wait for the endpoint to die
    // and fall back to the profile-targeted sweep if the pid was unknown.
    await cdp.close().catch(() => {});
    let gone = !port;
    const deadline = Date.now() + 8000;
    while (port && Date.now() < deadline) {
      try { await httpGetJson(`http://127.0.0.1:${port}/json/version`, 1000); } catch { gone = true; break; }
      await sleep(400);
    }
    if (!gone) sweepProfileHolders(path.resolve(profileDir));
    try { fs.rmSync(cdpFile, { force: true }); } catch { /* ignore */ }
    log("browser closed (--cold)");
  } else {
    // WARM default: leave the browser running with cdp.json intact so the
    // next one-shot reuses it and skips challenge waits. Drop only OUR
    // websocket -- do NOT send Browser.close.
    try { cdp.ws.close(); } catch { /* ignore */ }
    log(`browser left warm (profile ${profileDir}); next run reuses it — pass --cold to close it`);
  }
  process.exit(fact.ok ? 0 : 1);
}

// Exports for unit tests (test-cf-browser.js): the browser-context challenge
// detector source and the CLI arg parser. Requiring this module never runs
// main() — only direct invocation does.
module.exports = { CHALLENGE_SNIPPET, parseArgs };

if (require.main === module) {
  main().catch((e) => { log("FATAL", e.message || e); process.exit(1); });
}
