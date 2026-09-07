"use strict";
// Integration tests for downloader.js runHls + error temp-dir lifecycle
// (validated 2026-09-03). Drives the REAL download engine against a local mock
// HLS server:
//   - master.m3u8    advertises an I-frame-only 1080p rendition ABOVE a real
//                    360p one; the engine must TRY the top variant, see
//                    #EXT-X-I-FRAMES-ONLY in its media playlist, skip it, and
//                    download the real 360p rendition
//   - iframe/media.m3u8 enqueued DIRECTLY is a keyframe index, not video ->
//                    error before any byte is written -> temp dir swept
//                    immediately (nothing to resume)
//   - bad-master.m3u8 where EVERY variant is I-frame-only -> error naming the
//                    all-variants cause -> temp dir swept immediately
//   - flaky/media.m3u8 whose seg2 404s AFTER seg0/seg1 downloaded -> error
//                    WITH partial bytes -> temp dir RETAINED for resume until
//                    the item leaves the map (remove())
// Requires ffmpeg on PATH (runHls uses it for the .mp4 remux).
// Run: node test-hls-iframe.js
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { DownloadManager } = require("./downloader");
const { ProxyManager } = require("./proxy");
const { DEFAULT_CONFIG } = require("./config");

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log("  PASS  " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? " -> " + detail : "")); }
}
function hasFfmpeg() {
  const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return r.status === 0;
}
function makeTs(outFile) {
  const r = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=duration=0.2:size=16x16:rate=10",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mpegts", outFile], { stdio: "ignore" });
  return r.status === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0;
}

const IFRAME_MEDIA =
  "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n" +
  "#EXT-X-I-FRAMES-ONLY\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\niframe0.ts\n";
const MASTER =
  "#EXTM3U\n#EXT-X-VERSION:3\n" +
  "#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\niframe/media.m3u8\n" +
  "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nreal/media.m3u8\n";
const BAD_MASTER =
  "#EXTM3U\n#EXT-X-VERSION:3\n" +
  "#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\niframe/media.m3u8\n" +
  "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\niframe/low.m3u8\n";

function startServer(segBytes, nSegs) {
  const stats = { log: [], iframeTs: 0, realCalls: {} };
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    stats.log.push(url);
    const send = (body, type) => {
      const b = Buffer.from(body);
      res.writeHead(200, { "Content-Type": type, "Content-Length": b.length });
      res.end(b);
    };
    if (url === "/master.m3u8") return send(MASTER, "application/vnd.apple.mpegurl");
    if (url === "/bad-master.m3u8") return send(BAD_MASTER, "application/vnd.apple.mpegurl");
    if (/^\/iframe\/[^/]+\.m3u8$/.test(url)) return send(IFRAME_MEDIA, "application/vnd.apple.mpegurl");
    if (url === "/real/media.m3u8") {
      let b = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n";
      for (let i = 0; i < nSegs; i++) b += "#EXTINF:1.0,\nseg" + i + ".ts\n";
      return send(b, "application/vnd.apple.mpegurl");
    }
    const m = /^\/real\/seg(\d+)\.ts$/.exec(url);
    if (m) {
      stats.realCalls[m[1]] = (stats.realCalls[m[1]] || 0) + 1;
      res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": segBytes.length });
      res.end(segBytes);
      return;
    }
    if (/\.ts$/.test(url)) {
      // Should never be reached for iframe0.ts (the I-frame rendition is
      // skipped before any of its segments are fetched).
      stats.iframeTs++;
      res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": segBytes.length });
      res.end(segBytes);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.on("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, stats }));
  });
}

// Segment failures must land AFTER sibling segments complete so the retained
// temp dir deterministically holds partial data. Separate server: seg0/seg1
// succeed (30ms), seg2 404s late (120ms).
function startFlakyServer(segBytes) {
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    if (url === "/flaky/media.m3u8") {
      const b = Buffer.from("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n" +
        "#EXTINF:1.0,\nseg0.ts\n#EXTINF:1.0,\nseg1.ts\n#EXTINF:1.0,\nseg2.ts\n");
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": b.length });
      res.end(b);
      return;
    }
    const m = /^\/flaky\/seg(\d+)\.ts$/.exec(url);
    if (m) {
      const delay = m[1] === "2" ? 120 : 30;
      setTimeout(() => {
        if (m[1] === "2") { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": segBytes.length });
        res.end(segBytes);
      }, delay);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.on("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function waitTerminal(dm, id, ms) {
  const start = Date.now();
  let it;
  while (Date.now() - start < ms) {
    it = dm.items.get(id);
    if (it && (it.status === "done" || it.status === "error")) return it;
    await new Promise((r) => setTimeout(r, 100));
  }
  return it;
}

function dlDirs(tmp) {
  return fs.existsSync(tmp) ? fs.readdirSync(tmp).filter((n) => /^dl-/.test(n)) : [];
}
async function waitNoDlDirs(tmp, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (!dlDirs(tmp).length) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !dlDirs(tmp).length;
}
async function waitPathGone(p, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (!fs.existsSync(p)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !fs.existsSync(p);
}

const N = 4;
(async () => {
  console.log("\n=== HLS I-frame-only guard + error temp-dir lifecycle ===\n");
  if (!hasFfmpeg()) {
    console.log("  SKIP  ffmpeg not on PATH (HLS remux unavailable)");
    console.log("\n0 passed, 0 failed (skipped)\n");
    process.exit(0);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dvw-ifr-"));
  const segTs = path.join(tmp, "seg.ts");
  if (!makeTs(segTs)) {
    console.log("  SKIP  could not generate test .ts with ffmpeg");
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  }
  const segBytes = fs.readFileSync(segTs);

  const srv = await startServer(segBytes, N);
  const srv2 = await startFlakyServer(segBytes);
  if (!srv || !srv2) { console.log("  FAIL  test server did not start"); process.exit(1); }
  const { server, port, stats } = srv;
  const base = "http://127.0.0.1:" + port;
  const base2 = "http://127.0.0.1:" + srv2.port;

  const config = Object.assign({}, DEFAULT_CONFIG, {
    downloadDir: tmp, saveHistory: false, thumbnails: false, autoProxy: false,
    proxies: [], hlsConcurrency: 4, ffmpegPath: "ffmpeg", maxRetries: 0, hostDelayMs: 0
  });
  const dm = new DownloadManager({ config, proxyManager: new ProxyManager(config), onUpdate: () => {} });

  // --- Scenario 1: best variant is I-frame-only, real rendition below it ---
  let id1, it1;
  try {
    id1 = await dm.enqueue({ url: base + "/master.m3u8", title: "ifr-master" });
    it1 = await waitTerminal(dm, id1, 40000);
  } catch (e) {
    console.log("  FAIL  scenario 1 enqueue threw: " + e.message);
    failed++;
  }
  const iIframe = stats.log.indexOf("/iframe/media.m3u8");
  const iReal = stats.log.indexOf("/real/media.m3u8");
  const realSegs = Object.keys(stats.realCalls);

  assert("I-frame-only top variant is attempted first", iIframe !== -1 && iReal !== -1 && iIframe < iReal,
    "log=" + stats.log.join(","));
  assert("engine skips it and downloads the real rendition (status=done)", it1 && it1.status === "done",
    "status=" + (it1 && it1.status) + " error=" + (it1 && it1.error));
  assert("final mp4 exists and is non-empty", it1 && it1.finalPath && fs.existsSync(it1.finalPath) && fs.statSync(it1.finalPath).size > 0,
    it1 && it1.finalPath);
  assert("no I-frame .ts segments were fetched", stats.iframeTs === 0, "iframeTs=" + stats.iframeTs);
  assert("all " + N + " real segments fetched exactly once",
    realSegs.length === N && realSegs.every((s) => stats.realCalls[s] === 1),
    JSON.stringify(stats.realCalls));

  // --- Scenario 2: I-frame-only media playlist enqueued directly (no bytes
  // ever written -> temp dir swept on error) ---
  let id2, it2;
  try {
    id2 = await dm.enqueue({ url: base + "/iframe/media.m3u8", title: "ifr-direct" });
    it2 = await waitTerminal(dm, id2, 40000);
  } catch (e) {
    console.log("  FAIL  scenario 2 enqueue threw: " + e.message);
    failed++;
  }
  const logBefore = stats.log.length;
  assert("direct I-frame-only media playlist rejected (status=error)", it2 && it2.status === "error",
    "status=" + (it2 && it2.status));
  assert("error names the I-frame-only cause", it2 && /I-frame-only/.test(it2.error || ""),
    "error=" + (it2 && it2.error));
  assert("no segments fetched for the direct I-frame enqueue",
    stats.log.length === logBefore && stats.iframeTs === 0,
    "log=" + stats.log.slice(logBefore).join(","));
  assert("empty temp dir swept immediately on early error", await waitNoDlDirs(tmp, 3000),
    "left=" + dlDirs(tmp).join(","));

  // --- Scenario 3: master where EVERY variant is I-frame-only ---
  let id3, it3;
  try {
    id3 = await dm.enqueue({ url: base + "/bad-master.m3u8", title: "ifr-all" });
    it3 = await waitTerminal(dm, id3, 40000);
  } catch (e) {
    console.log("  FAIL  scenario 3 enqueue threw: " + e.message);
    failed++;
  }
  assert("all-I-frame master rejected (status=error)", it3 && it3.status === "error",
    "status=" + (it3 && it3.status));
  assert("error names the all-variants-I-frame cause", it3 && /all master variants are I-frame-only/.test(it3.error || ""),
    "error=" + (it3 && it3.error));
  assert("empty temp dir swept immediately on early error", await waitNoDlDirs(tmp, 3000),
    "left=" + dlDirs(tmp).join(","));

  // --- Scenario 4: real HLS dies mid-segments (seg2 404 after seg0/seg1
  // landed) -> temp dir RETAINED with partials until the item leaves the map ---
  let id4, it4;
  try {
    id4 = await dm.enqueue({ url: base2 + "/flaky/media.m3u8", title: "ifr-flaky" });
    it4 = await waitTerminal(dm, id4, 40000);
  } catch (e) {
    console.log("  FAIL  scenario 4 enqueue threw: " + e.message);
    failed++;
  }
  const retainedDir = it4 && it4.tempDir;
  const retainedData = retainedDir && fs.existsSync(retainedDir)
    ? fs.readdirSync(retainedDir).filter((n) => { try { return fs.statSync(path.join(retainedDir, n)).size > 0; } catch (e) { return false; } }).length
    : 0;
  assert("mid-segment failure errors (status=error)", it4 && it4.status === "error",
    "status=" + (it4 && it4.status) + " error=" + (it4 && it4.error));
  assert("error names the failed segment", it4 && /HTTP 404/.test(it4.error || ""),
    "error=" + (it4 && it4.error));
  assert("temp dir RETAINED with partial segments (resume-ready)", retainedData >= 1,
    "dir=" + retainedDir + " nonEmpty=" + retainedData + " left=" + dlDirs(tmp).join(","));
  dm.remove(id4);
  assert("retained temp dir removed when item leaves the map", retainedDir ? await waitPathGone(retainedDir, 3000) : false,
    "dir=" + retainedDir);

  assert("no orphaned temp dirs remain", await waitNoDlDirs(tmp, 3000), "left=" + dlDirs(tmp).join(","));

  server.close();
  srv2.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\n=== " + passed + " passed, " + failed + " failed ===\n");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
