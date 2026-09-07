// boot-verify.js — repeatable real-app boot drill for the 1.3.10
// download/automation batch (run via: npm run boot-verify). Writes the sandbox config.json, launches the
// real Electron app (isolated port 8766 + temp dirs; prod app on 8765 is
// never touched), then drives three WS phases against the live app and
// asserts the outcomes:
//   A download      — a real MP4 completes byte-exact into the temp dir
//   B window gating — a closed schedule window leaves a new item queued; a
//                     start-flagged site rule bypasses it + folder override
//   C auto-retry    — a deterministic 404 fails, auto-retries after
//                     autoRetryMinutes, and re-fails cleanly
//   D cap exhaustion — with autoRetryMax 2 the item requeues at +60s for
//                     each capped cycle, then terminal error with the
//                     "Auto-retry exhausted after 2 cycles" message + category
//   E budget reset   — a CDP-driven manual window.api.retry(id) on the
//                     exhausted item gives a fresh budget: re-run, re-arm,
//                     requeue ~+60s (observed passively by item id)
// Self-contained: the fixture MP4 is embedded and served by an in-process
// static server (Range support) on an ephemeral port — no network egress.
// Usage: npm run boot-verify [-- --keep] [-- --force]
// Exit 0 = all phases passed; 1 = any assertion failed / setup aborted.

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");
const WebSocket = require("ws");

const ROOT = path.join(__dirname, "..");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const CONFIG_PATH = path.join(ROOT, "config.json");
const WS_PORT = 8766;
const KEEP = process.argv.includes("--keep");
const FORCE = process.argv.includes("--force");

// 1-second testsrc 160x90 x264 MP4 (generated with ffmpeg, 8680 bytes).
const MP4 = Buffer.from("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", "base64");

const sandbox = path.join(ROOT, "scripts", "bv-" + Date.now());
const dlDir = path.join(sandbox, "dl");
const dl2Dir = path.join(sandbox, "dl2");
const udDir = path.join(sandbox, "ud");
const appLog = path.join(sandbox, "app.log");
const appErr = path.join(sandbox, "app.log.err");

let fixture;
let appPid = null;
let configBackup = null;
const results = [];

const pass = (name, detail) => { results.push([true, name]); console.log("PASS  " + name + (detail ? " - " + detail : "")); };
const fail = (name, detail) => { results.push([false, name]); console.log("FAIL  " + name + (detail ? " - " + detail : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startFixture() {
  return new Promise((resolve, reject) => {
    fixture = http.createServer((req, res) => {
      const p = req.url.split("?")[0];
      if (p === "/v/one.mp4" || p === "/v/two.mp4" || p === "/v/three.mp4") {
        const range = req.headers.range;
        if (range) {
          const m = /bytes=([0-9]+)-([0-9]*)/.exec(range);
          const start = m ? parseInt(m[1], 10) : 0;
          const end = m && m[2] ? parseInt(m[2], 10) : MP4.length - 1;
          res.writeHead(206, {
            "Content-Type": "video/mp4",
            "Content-Range": "bytes " + start + "-" + end + "/" + MP4.length,
            "Content-Length": end - start + 1,
            "Accept-Ranges": "bytes"
          });
          res.end(MP4.slice(start, end + 1));
          return;
        }
        res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": MP4.length, "Accept-Ranges": "bytes" });
        res.end(MP4);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });
    fixture.on("error", reject);
    fixture.listen(0, "127.0.0.1", () => resolve(fixture.address().port));
  });
}

function writeConfig(patch) {
  const base = {
    port: WS_PORT,
    downloadDir: dlDir.split(path.sep).join("/"),
    downloadDir2: "",
    downloadDir3: "",
    minFreeMB: 500, concurrency: 2, segments: 4, speedLimitKB: 0,
    maxRetries: 0, maxRefresh: 0, hostDelayMs: 0, idleTabMinutes: 0,
    autoProxy: false, ffmpegPath: "ffmpeg", theme: "dark",
    saveHistory: true, skipDuplicates: true, autoCloseTab: false, thumbnails: false,
    maxHistory: 2000, liveWindow: 0, autoTrimAt: 500,
    proxies: [], proxyRules: [],
    scheduleWindowStart: "", scheduleWindowEnd: "",
    autoRetryMinutes: 0, siteRules: []
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(Object.assign(base, patch), null, 2));
}

const CDP_PORT = 0; // ephemeral; Chromium writes the chosen port to <udDir>/DevToolsActivePort

function launchApp() {
  const out = fs.openSync(appLog, "w");
  const err = fs.openSync(appErr, "w");
  const child = spawn(ELECTRON, [".", "--user-data-dir=" + udDir.split(path.sep).join("/"), "--remote-debugging-port=" + CDP_PORT], {
    cwd: ROOT, detached: true, windowsHide: true, stdio: ["ignore", out, err]
  });
  appPid = child.pid;
  child.unref();
}

function killApp() {
  if (appPid == null) return;
  try { execFileSync("taskkill", ["/PID", String(appPid), "/T", "/F"], { stdio: "ignore" }); } catch (e) { /* already gone */ }
  appPid = null;
}

function waitForWsConnect(timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const probe = () => {
      if (done) return;
      if (Date.now() - t0 > timeoutMs) { done = true; resolve(false); return; }
      const ws = new WebSocket("ws://127.0.0.1:" + WS_PORT);
      ws.on("open", () => { done = true; try { ws.close(); } catch (e) {} resolve(true); });
      ws.on("error", () => { try { ws.terminate(); } catch (e) {} setTimeout(probe, 500); });
    };
    probe();
  });
}

// Drive one download over WS; collect status messages whose url matches.
function wsDownload(url, title, referer, waitMs) {
  return new Promise((resolve) => {
    const states = [];
    const t0 = Date.now();
    let acceptedId = null;
    let why = "timeout";
    let finished = false;
    const finish = (w) => {
      if (finished) return;
      finished = true;
      why = w;
      clearTimeout(timer);
      try { ws.terminate(); } catch (e) { /* ignore */ }
      resolve({ states, acceptedId, why });
    };
    const timer = setTimeout(() => finish("timeout"), waitMs);
    let ws = null;
    const connect = () => {
      ws = new WebSocket("ws://127.0.0.1:" + WS_PORT);
      ws.on("open", () => {
        if (acceptedId == null) ws.send(JSON.stringify({ type: "download", url, title, referer: referer || "" }));
      });
      ws.on("message", (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === "accepted") acceptedId = m.id;
        if (m.type === "status" && m.url === url) {
          states.push({ t: Math.round((Date.now() - t0) / 1000), status: m.status, received: m.received, total: m.total, error: (m.error || ""), cat: m.errorCategory || "" });
          if (m.status === "done" || m.status === "error" || m.status === "duplicate") finish(m.status);
        }
      });
      ws.on("close", () => { if (!finished) setTimeout(connect, 500); }); // reconnect: statuses are pushes, keep observing
      ws.on("error", () => {});
    };
    connect();
  });
}

const fileSize = (p) => { try { return fs.statSync(p).size; } catch (e) { return -1; } };
const hasFile = (p) => fs.existsSync(p);

async function phaseA(port) {
  console.log("--- Phase A: real download completes byte-exact ---");
  const url = "http://127.0.0.1:" + port + "/v/one.mp4";
  const r = await wsDownload(url, "bv-a", "", 30000);
  const done = r.states.find((s) => s.status === "done");
  if (!r.acceptedId) return fail("A accepted", "no accepted reply");
  if (!r.states.some((s) => s.status === "running")) return fail("A pump started", "never saw running: " + r.states.map((s) => s.status).join(","));
  if (!done) return fail("A completed", "no done in " + r.states.map((s) => s.status + "@" + s.t).join(","));
  if (done.received !== MP4.length || done.total !== MP4.length) return fail("A byte counts", "recv " + done.received + " total " + done.total + " expected " + MP4.length);
  const file = path.join(dlDir, "bv-a.mp4");
  if (!hasFile(file) || fileSize(file) !== MP4.length) return fail("A file on disk", file + " = " + fileSize(file) + " expected " + MP4.length);
  // Dedupe write is debounced (500ms) in HistoryStore; poll briefly.
  const dd = path.join(dlDir, "downloaded.json");
  let deduped = false;
  for (let i = 0; i < 20; i++) {
    try { if (fs.readFileSync(dd, "utf8").includes(url)) { deduped = true; break; } } catch (e) { /* not written yet */ }
    await sleep(200);
  }
  if (!deduped) return fail("A dedupe recorded", "downloaded.json missing url after 4s");
  pass("A download", "done " + done.received + "B, file " + fileSize(file) + "B, states " + r.states.map((s) => s.status).join("->"));
}

// A window provably closed at run time: [now+10min, now+20min). Even when it
// wraps midnight, now is still outside it, so gating is deterministic.
function closedWindow() {
  const t = (add) => { const d = new Date(Date.now() + add * 60000); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
  return { s: t(10), e: t(20) };
}

async function phaseB(port) {
  console.log("--- Phase B: schedule-window gating + site-rule bypass ---");
  const w = closedWindow(); writeConfig({ scheduleWindowStart: w.s, scheduleWindowEnd: w.e });
  await sleep(3500); // watcher applies the edit
  const urlB = "http://127.0.0.1:" + port + "/v/two.mp4";
  const rb = await wsDownload(urlB, "bv-b", "", 14000);
  const ran = rb.states.some((s) => s.status === "running" || s.status === "done");
  if (ran) return fail("B gated item stayed queued", rb.states.map((s) => s.status + "@" + s.t).join(","));
  if (!rb.states.some((s) => s.status === "queued")) return fail("B gated item enqueued", "no queued state: " + rb.states.map((s) => s.status).join(","));
  pass("B window gating", "stayed queued 14s, zero bytes");

  writeConfig({
    scheduleWindowStart: w.s, scheduleWindowEnd: w.e,
    siteRules: [{ host: "127.0.0.1", folder: dl2Dir.split(path.sep).join("/"), start: true }]
  });
  await sleep(3500);
  const urlC = "http://127.0.0.1:" + port + "/v/three.mp4";
  const rc = await wsDownload(urlC, "bv-c", "", 30000);
  const doneC = rc.states.find((s) => s.status === "done");
  if (!doneC) return fail("B2 bypass completed", rc.states.map((s) => s.status + "@" + s.t).join(",") + " err=" + ((rc.states.find((s) => s.error) || {}).error || ""));
  const fileC = path.join(dl2Dir, "bv-c.mp4");
  if (!hasFile(fileC) || fileSize(fileC) !== MP4.length) return fail("B2 folder override", fileC + " = " + fileSize(fileC) + " expected " + MP4.length);
  if (hasFile(path.join(dlDir, "bv-c.mp4"))) return fail("B2 override not main dir", "landed in main dl dir instead of override");
  if (hasFile(path.join(dlDir, "bv-b.mp4"))) return fail("B gating persisted", "gated item started during bypass");
  pass("B2 site-rule bypass", "start flag ran despite closed window; file in override dir (" + fileSize(fileC) + "B)");
}

async function phaseC(port) {
  console.log("--- Phase C: auto-retry after autoRetryMinutes ---");
  // Window back open so the failing URL actually runs; 404 fails instantly.
  writeConfig({ scheduleWindowStart: "", scheduleWindowEnd: "", autoRetryMinutes: 1, siteRules: [] });
  await sleep(3500);
  const urlF = "http://127.0.0.1:" + port + "/v/fail.mp4";
  const r = await wsDownload(urlF, "bv-f", "", 95000);
  const firstSched = r.states.findIndex((s) => s.status === "scheduled");
  if (firstSched === -1) return fail("C auto-retry armed", r.states.map((s) => s.status + "@" + s.t).join(","));
  const after = r.states.slice(firstSched);
  const requeued = after.some((s) => s.status === "running");
  const rearmed = after.filter((s) => s.status === "scheduled").length >= 2;
  const seg = r.states.map((s) => s.status + "@" + s.t).join("->");
  if (!requeued) return fail("C requeued after timer", seg);
  if (!rearmed) return fail("C re-armed after re-fail", seg);
  pass("C auto-retry", "failed -> scheduled -> requeued after 60s -> re-failed -> scheduled (" + seg + ")");
}

async function phaseD(port) {
  console.log("--- Phase D: auto-retry cap exhausts into terminal error ---");
  // autoRetryMax 2 with a deterministic 404: two capped cycles at +60s each,
  // then the item lands in terminal error instead of a third requeue.
  writeConfig({ scheduleWindowStart: "", scheduleWindowEnd: "", autoRetryMinutes: 1, autoRetryMax: 2, siteRules: [] });
  await sleep(3500);
  const urlF = "http://127.0.0.1:" + port + "/v/fail2.mp4";
  const r = await wsDownload(urlF, "bv-d", "", 150000);
  const seq = r.states.map((s) => s.status + "@" + s.t);
  const schedCount = r.states.filter((s) => s.status === "scheduled").length;
  const err = r.states.find((s) => s.status === "error");
  if (schedCount < 2) return fail("D two capped cycles", seq.join(",") + " (only " + schedCount + " scheduled)");
  if (!err) return fail("D terminal error after cap", seq.join(",") + " (no error state)");
  if (!/Auto-retry exhausted after 2 cycles/.test(err.error)) return fail("D exhaustion message", "got: " + err.error);
  if (err.cat !== "http") return fail("D category preserved", "got " + err.cat + " expected http");
  pass("D cap exhaustion", "2 cycles then terminal error (" + seq.join(",") + ")");
  lastExhaustedId = r.acceptedId;
}

// Drive the real renderer API through CDP (no WS control channel exists):
// open the DevToolsActivePort file, attach to the app renderer page, evaluate
// window.api.retry(id) in it. Any failure rejects with a short reason.
async function cdpRetry(itemId) {
  const http = require("http");
  const devtools = parseInt(String(fs.readFileSync(path.join(udDir, "DevToolsActivePort"), "utf8")).trim(), 10);
  const getJson = (u) => new Promise((res, rej) => { const q = http.get(u, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }); q.on("error", rej); q.setTimeout(5000, () => { q.destroy(new Error("timeout")); }); });
  const targets = await getJson("http://127.0.0.1:" + devtools + "/json");
  const page = targets.find((t) => t.type === "page" && /renderer.html$/.test(t.url));
  if (!page) throw new Error("renderer page target not found");
  return await new Promise((resolve, reject) => {
    const watchdog = setTimeout(() => reject(new Error("cdp evaluate timeout")), 15000);
    const wd2 = new WebSocket(page.webSocketDebuggerUrl);
    wd2.on("open", () => {
      const expr = "window.api.retry(" + JSON.stringify(itemId) + ")"
      wd2.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    });
    wd2.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.id === 1) {
        clearTimeout(watchdog);
        try { wd2.close(); } catch (e) {}
        if (m.error) return reject(new Error(m.error.message));
        const r = m.result && m.result.result;
        if (r && r.value === false) return reject(new Error("api.retry returned false (item not in error state?)"));
        resolve(true);
      }
    });
    wd2.on("error", (e) => reject(e));
  });
}

// Phase E: the exhausted Phase-D item, manually retried, must get a FRESH budget:
// re-run, re-arm scheduled (a stale budget would error terminally here instead),
// and requeue again at +60s - then fail again. That full arc is only reachable
// when the manual retry reset the per-item auto-retry budget.
let lastExhaustedId = null;

// Phase E: the exhausted Phase-D item, manually retried via CDP, must get a
// FRESH budget: re-run, re-arm scheduled (a stale budget would error terminally
// instead), and requeue again ~+60s. Observed passively by item id - no second
// download is enqueued, so the arc can only come from the retried item itself.
async function phaseE(port, itemId) {
  console.log("--- Phase E: manual retry resets the auto-retry budget ---");
  if (!itemId) return fail("E manual retry driven", "no exhausted item id from phase D");
  const states = [];
  const t0 = Date.now();
  const obs = new WebSocket("ws://127.0.0.1:" + WS_PORT);
  obs.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === "status" && m.id === itemId) {
      states.push({ t: Math.round((Date.now() - t0) / 1000), status: m.status, error: m.error || "", cat: m.errorCategory || "" });
    }
  });
  obs.on("error", () => {});
  await sleep(700); // observer connected before the retry fires
  try { await cdpRetry(itemId); } catch (e) { try { obs.close(); } catch (e2) {} return fail("E manual retry driven", String((e && e.message) || e)); }
  const seq = () => states.map((s) => s.status + "@" + s.t).join(",");
  const deadline = Date.now() + 100000;
  while (Date.now() < deadline) {
    const armed = states.filter((s) => s.status === "scheduled").length >= 1;
    const requeued = states.some((s) => s.status === "queued" && s.t >= 55);
    const rerun = states.some((s) => s.status === "running");
    if (armed && requeued && rerun) break;
    await sleep(500);
  }
  try { obs.close(); } catch (e) {}
  if (!states.some((s) => s.status === "running")) return fail("E re-ran after manual retry", seq());
  if (!states.some((s) => s.status === "scheduled")) return fail("E re-armed (budget reset)", seq() + " - no scheduled after re-fail");
  if (!states.some((s) => s.status === "queued" && s.t >= 55)) return fail("E second cycle requeue at ~+60s", seq());
  pass("E budget reset", "manual retry -> re-run -> re-armed -> requeue ~+60s (" + seq() + ")");
}

async function main() {
  if (!fs.existsSync(ELECTRON)) { console.log("ABORT electron not found: " + ELECTRON); process.exit(1); }
  const busy = await new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: WS_PORT });
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });
  if (busy) { console.log("ABORT port " + WS_PORT + " is in use; refusing to run."); process.exit(1); }
  if (fs.existsSync(CONFIG_PATH) && !FORCE) { console.log("ABORT config.json already exists; move it aside or pass --force (it is backed up + restored)."); process.exit(1); }

  fs.mkdirSync(dlDir, { recursive: true });
  fs.mkdirSync(dl2Dir, { recursive: true });
  fs.mkdirSync(udDir, { recursive: true });
  if (fs.existsSync(CONFIG_PATH)) {
    configBackup = CONFIG_PATH + ".bv-bak";
    fs.copyFileSync(CONFIG_PATH, configBackup);
  }
  const port = await startFixture();
  writeConfig({});
  console.log("sandbox: " + sandbox + "\nfixture on 127.0.0.1:" + port);
  launchApp();

  const ok = await waitForWsConnect(40000);
  if (!ok) { fail("app boot", "no WS hello on 8766 within 40s (see " + appLog + " / " + appErr + ")"); return 1; }
  pass("app boot", "WS hello on 8766");

  try {
    await phaseA(port);
    await phaseB(port);
    await phaseC(port);
    await phaseD(port);
    await phaseE(port, lastExhaustedId);
  } catch (e) {
    fail("uncaught", (e && e.stack) || String(e));
  }
  return results.every(([p]) => p) ? 0 : 1;
}

main().then(async (code) => {
  killApp();
  try { if (fixture) fixture.close(); } catch (e) { /* ignore */ }
  if (configBackup) {
    try { fs.copyFileSync(configBackup, CONFIG_PATH); fs.unlinkSync(configBackup); } catch (e) { /* ignore */ }
  }
  if (!KEEP) {
    // taskkill returns before the dying tree releases file handles (GPU cache,
    // DIPS wal); give it a beat, then retry the removal until it sticks.
    await sleep(1200);
    for (let i = 0; i < 12; i++) {
      try { fs.rmSync(sandbox, { recursive: true, force: true }); break; } catch (e) { await sleep(500); }
    }
    try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* ignore */ }
  } else {
    console.log("kept sandbox at " + sandbox + " (config.json left in place)");
  }
  const failed = results.filter(([p]) => !p);
  console.log(String.fromCharCode(10) + results.length + " checks: " + (results.length - failed.length) + " passed, " + failed.length + " failed");
  if (failed.length) {
    console.log("failed: " + failed.map(([, n]) => n).join(", "));
    if (fs.existsSync(appLog)) { const NL = String.fromCharCode(10); console.log("app log tail:" + NL + String(fs.readFileSync(appLog)).split(NL).slice(-8).join(NL)); }
  }
  process.exit(code);
}).catch((e) => { console.log("ABORT " + ((e && e.stack) || e)); process.exit(1); });
