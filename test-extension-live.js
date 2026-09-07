"use strict";
// Real-browser validation of the Deep Grab content script's best-only selection
// (validated 2026-09-03, after the extension/best-only.js extraction). Loads the
// REAL extension into hidden Electron BrowserWindows via session.loadExtension
// — the same mechanism main.js uses for the built-in browser — then drives
// fixture pages and asserts on the #dv-found toolbar DOM the content script
// renders in the page.
// Each scenario gets its OWN session partition (separate extension instance +
// background service worker): the extension background keeps found state that
// is not reliably per-tab across rapid Electron window create/destroy, so a
// shared session leaked earlier pages' entries into later ones via
// refreshFromBackground.
//   p1: MP4s only (720p <video> + 1080p/480p <a>)  -> single best = 1080p MP4
//   p2: 1080p MP4 <video> + HLS master <a>          -> HLS master REPLACES the
//       MP4 (full movie outranks the highlight) — the exact semantics the old
//       test-best-only simulation got wrong
//   p3: order-dependence via scripted re-scans (append <a> + click the toolbar
//       Scan button between steps):
//       s1 initial 720p/1080p links      -> 1080p MP4 held
//       s2 append 4k (2160p) link        -> held best UPGRADES to the 4k
//       s3 append HLS master link        -> HLS master replaces the 4k
//       s4 append 8k (4320p) link        -> HLS master STAYS (later MP4 never
//                                           replaces a held HLS)
//   p4: AUTO-capture of appended sources (MutationObserver; NO Scan click):
//       s1 initial 720p link          -> 720p MP4 held
//       s2 append 1080p <a>           -> auto-captured, best UPGRADES to 1080p
//       s3 append 2160p <video>       -> auto-captured, best UPGRADES to 2160p
//       s4 append HLS master <a>      -> auto-captured, replaces the 2160p
//       s5 append 8k <a>              -> auto-captured, HLS master STAYS
//   p5: HIDDEN-TAB catch-up: append 1080p <a> while the window is hidden ->
//       observer skips (held best unchanged), then show the window -> the
//       visibilitychange catch-up scan captures it and upgrades the best.
// No desktop app / WS needed: selection is decided page-side.
// Requires: electron devDependency (node_modules/electron), ffmpeg for the
// fixture mp4 (reuses test-video.mp4; generates one if missing).
// Run: node test-extension-live.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const EXT_DIR = path.join(__dirname, "extension");
const ELECTRON = path.join(__dirname, "node_modules", "electron", "dist", "electron.exe");
const FIX_MP4 = path.join(__dirname, "test-video.mp4");

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log("  PASS  " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? " -> " + detail : "")); }
}

if (!fs.existsSync(ELECTRON)) { console.log("  FAIL  electron binary missing at " + ELECTRON); process.exit(1); }
if (!fs.existsSync(FIX_MP4)) {
  const r = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=duration=15:size=640x480:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=15", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-b:v", "200k", "-maxrate", "200k", "-bufsize", "400k", "-c:a", "aac", "-shortest", FIX_MP4], { stdio: "ignore" });
  if (r.status !== 0 || !fs.existsSync(FIX_MP4)) { console.log("  SKIP  cannot create test-video.mp4 fixture"); process.exit(0); }
}
const mp4Bytes = fs.readFileSync(FIX_MP4);

const P1 = `<!doctype html><html><head><meta charset="utf-8"><title>bestonly-p1</title></head><body>
<video src="/media/video_720p.mp4"></video>
<a href="/media/video_1080p.mp4">1080 link</a>
<a href="/media/video_480p.mp4">480 link</a>
</body></html>`;
const P2 = `<!doctype html><html><head><meta charset="utf-8"><title>bestonly-p2</title></head><body>
<video src="/media/video_1080p.mp4"></video>
<a href="/hls/master.m3u8">master</a>
</body></html>`;
const P3 = `<!doctype html><html><head><meta charset="utf-8"><title>bestonly-p3</title></head><body>
<a href="/media/video_720p.mp4">720 link</a>
<a href="/media/video_1080p.mp4">1080 link</a>
</body></html>`;
const M3U8 = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\nv.m3u8\n";
const P4 = `<!doctype html><html><head><meta charset="utf-8"><title>bestonly-p4</title></head><body>
<a href="/media/video_720p.mp4">720 link</a>
</body></html>`;
const P5 = `<!doctype html><html><head><meta charset="utf-8"><title>bestonly-p5</title></head><body>
<a href="/media/video_720p.mp4">720 link</a>
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = (req.url || "").split("?")[0];
      if (u === "/p1.html") return send(res, P1, "text/html");
      if (u === "/p2.html") return send(res, P2, "text/html");
      if (u === "/p3.html") return send(res, P3, "text/html");
      if (u === "/p4.html") return send(res, P4, "text/html");
      if (u === "/p5.html") return send(res, P5, "text/html");
      if (/^\/media\/video_\d+p\.mp4$/.test(u)) return send(res, mp4Bytes, "video/mp4");
      if (u === "/hls/master.m3u8") return send(res, M3U8, "application/vnd.apple.mpegurl");
      res.writeHead(404); res.end();
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
  function send(res, body, type) {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(200, { "Content-Type": type, "Content-Length": b.length });
    res.end(b);
  }
}

// Minimal Electron host app, written to a temp dir at runtime. All snippets it
// executes in the page are single-quoted strings (no nested template literals).
function electronMainSrc() {
  return `"use strict";
const { app, session, BrowserWindow } = require("electron");
const path = require("path");
const os = require("os");
const EXT = process.argv[2];
const BASE = process.argv[3];
app.disableHardwareAcceleration();
app.setPath("userData", path.join(os.tmpdir(), "dv-extchk-" + Date.now()));
app.on("window-all-closed", () => { /* keep alive across per-scenario windows */ });
app.whenReady().then(async () => {
  const out = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const attach = (win) => {
    const ev = (code) => win.webContents.executeJavaScript(code);
    const grab = () => ev("(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); for (let i = 0; i < 60; i++) { const li = document.querySelectorAll('#dv-found li.dv-item'); if (li.length) break; await wait(400); } const items = Array.from(document.querySelectorAll('#dv-found li.dv-item')).map((el) => { const cb = el.querySelector('input[data-sel]'); const kind = el.querySelector('.dv-kind'); return { url: cb ? cb.dataset.sel : '', kind: kind ? kind.textContent.trim() : '' }; }); return JSON.stringify(items); })()");
    const settle = async (pred) => {
      let last = null, stable = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 25000) {
        const items = JSON.parse(await grab());
        const ok = items.length === 1 && pred(items[0]);
        if (ok) {
          if (last && JSON.stringify(last) === JSON.stringify(items)) stable += 400; else stable = 0;
          last = items;
          if (stable >= 2000) return items;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      return JSON.parse(await grab());
    };
    const addAnchor = (href, text) => ev("(async () => { const a = document.createElement('a'); a.href = " + JSON.stringify(href) + "; a.textContent = " + JSON.stringify(text) + "; document.body.appendChild(a); const btn = document.getElementById('dv-scan'); if (btn) btn.click(); return true; })()");
    const appendAnchor = (href, text) => ev("(async () => { const a = document.createElement('a'); a.href = " + JSON.stringify(href) + "; a.textContent = " + JSON.stringify(text) + "; document.body.appendChild(a); return true; })()");
    const appendVideo = (src) => ev("(async () => { const v = document.createElement('video'); v.src = " + JSON.stringify(src) + "; document.body.appendChild(v); return true; })()");
    const visibility = () => ev("JSON.stringify({ hidden: document.hidden, state: document.visibilityState })");
    return { grab, settle, addAnchor, appendAnchor, appendVideo, visibility };
  };
  // Fresh partition per scenario = fresh extension instance + background.
  const runPage = async (part, url) => {
    const ses = session.fromPartition(part);
    let info = null;
    try { info = await ses.loadExtension(EXT); }
    catch (e1) { info = await ses.loadExtension(EXT, { allowFileAccess: true }); }
    if (!info || !info.id) throw new Error("loadExtension failed for " + part);
    const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { session: ses } });
    const api = attach(win);
    await win.loadURL(url);
    return { win, api };
  };
  const isHlsMaster = (e) => e.url.endsWith("/hls/master.m3u8") && e.kind === "HLS";
  const isMp4 = (needle) => (e) => e.url.indexOf(needle) !== -1 && e.kind === "MP4";
  try {
    let r = await runPage("persist:dv-extchk-c1", BASE + "/p1.html");
    out.push({ id: "p1", entries: await r.api.settle(isMp4("video_1080p.mp4")) });
    r.win.destroy(); await sleep(400);

    r = await runPage("persist:dv-extchk-c2", BASE + "/p2.html");
    out.push({ id: "p2", entries: await r.api.settle(isHlsMaster) });
    r.win.destroy(); await sleep(400);

    r = await runPage("persist:dv-extchk-c3", BASE + "/p3.html");
    const p3 = [];
    p3.push({ id: "p3s1", entries: await r.api.settle(isMp4("video_1080p.mp4")) });
    await r.api.addAnchor(BASE + "/media/video_2160p.mp4", "4k link");
    p3.push({ id: "p3s2", entries: await r.api.settle(isMp4("video_2160p.mp4")) });
    await r.api.addAnchor(BASE + "/hls/master.m3u8", "master");
    p3.push({ id: "p3s3", entries: await r.api.settle(isHlsMaster) });
    await r.api.addAnchor(BASE + "/media/video_4320p.mp4", "8k link");
    p3.push({ id: "p3s4", entries: await r.api.settle(isHlsMaster) });
    out.push({ id: "p3", steps: p3 });
    r.win.destroy(); await sleep(400);

    r = await runPage("persist:dv-extchk-c4", BASE + "/p4.html");
    const p4 = [];
    p4.push({ id: "p4s1", entries: await r.api.settle(isMp4("video_720p.mp4")) });
    await r.api.appendAnchor(BASE + "/media/video_1080p.mp4", "1080 auto");
    p4.push({ id: "p4s2", entries: await r.api.settle(isMp4("video_1080p.mp4")) });
    await r.api.appendVideo(BASE + "/media/video_2160p.mp4");
    p4.push({ id: "p4s3", entries: await r.api.settle(isMp4("video_2160p.mp4")) });
    await r.api.appendAnchor(BASE + "/hls/master.m3u8", "master auto");
    p4.push({ id: "p4s4", entries: await r.api.settle(isHlsMaster) });
    await r.api.appendAnchor(BASE + "/media/video_4320p.mp4", "8k auto");
    p4.push({ id: "p4s5", entries: await r.api.settle(isHlsMaster) });
    out.push({ id: "p4", steps: p4 });
    r.win.destroy(); await sleep(400);

    r = await runPage("persist:dv-extchk-c5", BASE + "/p5.html");
    const p5 = [];
    p5.push({ id: "p5s1", entries: await r.api.settle(isMp4("video_720p.mp4")) });
    r.win.hide();
    await sleep(500);
    const hiddenState = JSON.parse(await r.api.visibility());
    await r.api.appendAnchor(BASE + "/media/video_1080p.mp4", "1080 while hidden");
    await sleep(900); // a visible-tab scan would have captured it by now
    const whileHidden = JSON.parse(await r.api.grab());
    p5.push({ id: "p5hidden", hidden: hiddenState, entries: whileHidden });
    r.win.show();
    await sleep(300);
    p5.push({ id: "p5s2", entries: await r.api.settle(isMp4("video_1080p.mp4")) });
    out.push({ id: "p5", steps: p5 });
    r.win.destroy();
    console.log("CHK_RESULT " + JSON.stringify(out));
    app.exit(0);
  } catch (e) {
    console.log("CHK_ERROR " + e.message);
    app.exit(3);
  }
});
`;
}

function stepOf(p3, id) {
  const st = p3 && p3.steps && p3.steps.find((x) => x.id === id);
  return st && st.entries && st.entries[0];
}

(async () => {
  console.log("\n=== extension live best-only (Electron-hosted) ===\n");
  const srv = await startServer();
  const { server, port } = srv;
  const tmpApp = fs.mkdtempSync(path.join(os.tmpdir(), "dv-extchk-app-"));
  fs.writeFileSync(path.join(tmpApp, "package.json"), JSON.stringify({ name: "dv-extchk", main: "main.js" }));
  fs.writeFileSync(path.join(tmpApp, "main.js"), electronMainSrc());

  let out = "", err = "";
  const child = spawn(ELECTRON, [tmpApp, EXT_DIR, "http://127.0.0.1:" + port], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 150000);
    child.on("close", (code) => { clearTimeout(timer); resolve(code); });
    child.on("error", (e) => { clearTimeout(timer); console.log("  FAIL  electron spawn: " + e.message); resolve(-9); });
  });
  const resultLine = out.split("\n").find((l) => l.startsWith("CHK_RESULT "));
  if (exited === -9) { /* already reported */ }
  else if (!resultLine) {
    assert("CHK_RESULT produced", false, "no result line; exit=" + exited);
    const tail = (err + out).split("\n").slice(-6).join(" | ");
    console.log("    tail: " + tail);
  } else {
    let parsed = [];
    try { parsed = JSON.parse(resultLine.slice("CHK_RESULT ".length)); } catch (e) {}
    const p1 = parsed.find((x) => x.id === "p1");
    const p2 = parsed.find((x) => x.id === "p2");
    const p3 = parsed.find((x) => x.id === "p3");
    const p4 = parsed.find((x) => x.id === "p4");
    const p5 = parsed.find((x) => x.id === "p5");
    const e1 = p1 && p1.entries && p1.entries[0];
    const e2 = p2 && p2.entries && p2.entries[0];
    assert("p1: single best held (MP4s only)", !!(p1 && p1.entries.length === 1), JSON.stringify(p1));
    assert("p1: 1080p MP4 beats 720p/480p", !!(e1 && e1.url.indexOf("video_1080p.mp4") !== -1), e1 && e1.url);
    assert("p1: kind MP4", e1 && e1.kind === "MP4", e1 && e1.kind);
    assert("p2: single best held (MP4 + HLS)", !!(p2 && p2.entries.length === 1), JSON.stringify(p2));
    assert("p2: HLS master REPLACES the 1080p MP4 highlight", !!(e2 && e2.url.endsWith("/hls/master.m3u8")), e2 && e2.url);
    assert("p2: kind HLS", e2 && e2.kind === "HLS", e2 && e2.kind);

    const s1 = stepOf(p3, "p3s1");
    const s2 = stepOf(p3, "p3s2");
    const s3 = stepOf(p3, "p3s3");
    const s4 = stepOf(p3, "p3s4");
    assert("p3s1: initial 720p/1080p settle on 1080p MP4", !!(s1 && s1.url.indexOf("video_1080p.mp4") !== -1 && s1.kind === "MP4"), JSON.stringify(s1));
    assert("p3s2: appended 4k UPGRADES the held best", !!(s2 && s2.url.indexOf("video_2160p.mp4") !== -1 && s2.kind === "MP4"), JSON.stringify(s2));
    assert("p3s3: appended HLS master REPLACES the held 4k", !!(s3 && s3.url.endsWith("/hls/master.m3u8") && s3.kind === "HLS"), JSON.stringify(s3));
    assert("p3s4: appended 8k does NOT replace the held HLS master", !!(s4 && s4.url.endsWith("/hls/master.m3u8") && s4.kind === "HLS"), JSON.stringify(s4));
    assert("p3: single best held at every step", !!(p3 && p3.steps && p3.steps.every((x) => x.entries.length === 1)), JSON.stringify(p3));

    const a1 = stepOf(p4, "p4s1");
    const a2 = stepOf(p4, "p4s2");
    const a3 = stepOf(p4, "p4s3");
    const a4 = stepOf(p4, "p4s4");
    const a5 = stepOf(p4, "p4s5");
    assert("p4s1: initial 720p link settles on 720p MP4", !!(a1 && a1.url.indexOf("video_720p.mp4") !== -1 && a1.kind === "MP4"), JSON.stringify(a1));
    assert("p4s2: appended 1080p ANCHOR auto-captured (no Scan click), best UPGRADES", !!(a2 && a2.url.indexOf("video_1080p.mp4") !== -1 && a2.kind === "MP4"), JSON.stringify(a2));
    assert("p4s3: appended 2160p VIDEO auto-captured (no Scan click), best UPGRADES", !!(a3 && a3.url.indexOf("video_2160p.mp4") !== -1 && a3.kind === "MP4"), JSON.stringify(a3));
    assert("p4s4: appended HLS master ANCHOR auto-captured, replaces the 2160p", !!(a4 && a4.url.endsWith("/hls/master.m3u8") && a4.kind === "HLS"), JSON.stringify(a4));
    assert("p4s5: appended 8k ANCHOR auto-captured but HLS master STAYS", !!(a5 && a5.url.endsWith("/hls/master.m3u8") && a5.kind === "HLS"), JSON.stringify(a5));
    assert("p4: single best held at every step (auto-capture)", !!(p4 && p4.steps && p4.steps.every((x) => x.entries.length === 1)), JSON.stringify(p4));

    const h = p5 && p5.steps && p5.steps.find((x) => x.id === "p5hidden");
    const b1 = stepOf(p5, "p5s1");
    const b2 = stepOf(p5, "p5s2");
    assert("p5s1: initial 720p link settles on 720p MP4", !!(b1 && b1.url.indexOf("video_720p.mp4") !== -1 && b1.kind === "MP4"), JSON.stringify(b1));
    assert("p5: window was actually hidden during the append", !!(h && h.hidden && h.hidden.hidden === true && h.hidden.state === "hidden"), JSON.stringify(h && h.hidden));
    assert("p5: observer skipped while hidden (held best unchanged)", !!(h && h.entries.length === 1 && h.entries[0].url.indexOf("video_720p.mp4") !== -1), JSON.stringify(h && h.entries));
    assert("p5s2: visibilitychange catch-up scan captured the hidden append (best UPGRADES to 1080p)", !!(b2 && b2.url.indexOf("video_1080p.mp4") !== -1 && b2.kind === "MP4"), JSON.stringify(b2));
    assert("p5: single best held at every step", !!(p5 && p5.steps && p5.steps.every((x) => x.entries.length === 1)), JSON.stringify(p5));
  }

  if (typeof child.pid === "number") {
    try { spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch (e) {}
  }
  server.close();
  fs.rmSync(tmpApp, { recursive: true, force: true });
  console.log("\n=== " + passed + " passed, " + failed + " failed ===\n");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
