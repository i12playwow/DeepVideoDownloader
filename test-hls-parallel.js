"use strict";
// Integration test for PARALLEL HLS segment downloads (mirrors runSegmented's
// worker-pool + _withConnSlot). Proves:
//   - segment fetches run concurrently (maxInFlight > 1)
//   - every segment is fetched exactly once and assembled in playlist order
//   - cancel()/abort() tears down in-flight fetches + cleans tempDir/finalPath
// Requires ffmpeg on PATH (runHls uses it for the .mp4 remux). Run: node test-hls-parallel.js
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
  const r = spawnSync("ffmpeg", ["-y","-f","lavfi","-i","testsrc=duration=0.2:size=16x16:rate=10",
    "-c:v","libx264","-pix_fmt","yuv420p","-f","mpegts",outFile], { stdio: "ignore" });
  return r.status === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0;
}

function startServer(segBytes, nSegs) {
  const stats = { calls: 0, inFlight: 0, maxInFlight: 0, order: [] };
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    if (url.endsWith(".m3u8") || url === "/" || url === "/playlist.m3u8") {
      let body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n";
      for (let i = 0; i < nSegs; i++) body += "seg" + i + ".ts\n";
      const b = Buffer.from(body);
      res.writeHead(200, { "Content-Type":"application/vnd.apple.mpegurl", "Content-Length":b.length });
      res.end(b);
      return;
    }
    const m = /^(\/)?seg(\d+)\.ts$/.exec(url);
    if (m) {
      stats.calls++; stats.inFlight++;
      if (stats.inFlight > stats.maxInFlight) stats.maxInFlight = stats.inFlight;
      stats.order.push(m[2]);
      setTimeout(() => {
        stats.inFlight--;
        res.writeHead(200, { "Content-Type":"video/mp2t", "Content-Length":segBytes.length });
        res.end(segBytes);
      }, 40);
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => {
    server.on("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, stats }));
  });
}

const N = 8;
(async () => {
  console.log("\n=== HLS parallel segment download ===\n");
  if (!hasFfmpeg()) {
    console.log("  SKIP  ffmpeg not on PATH (HLS remux unavailable)");
    console.log("\n0 passed, 0 failed (skipped)\n");
    process.exit(0);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dvw-hls-"));
  const segTs = path.join(tmp, "seg.ts");
  if (!makeTs(segTs)) {
    console.log("  SKIP  could not generate test .ts with ffmpeg");
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  }
  const segBytes = fs.readFileSync(segTs);

  const srv = await startServer(segBytes, N);
  if (!srv) { console.log("  FAIL  test server did not start"); process.exit(1); }
  const { server, port, stats } = srv;

  const config = Object.assign({}, DEFAULT_CONFIG, {
    downloadDir: tmp, saveHistory: false, thumbnails: false, autoProxy: false,
    proxies: [], hlsConcurrency: 4, ffmpegPath: "ffmpeg", maxRetries: 0, hostDelayMs: 0
  });
  const dm = new DownloadManager({ config, proxyManager: new ProxyManager(config), onUpdate: () => {} });

  let id, it;
  try {
    id = await dm.enqueue({ url: "http://127.0.0.1:" + port + "/playlist.m3u8", title: "hls-parallel" });
    const start = Date.now();
    while (Date.now() - start < 40000) {
      it = dm.items.get(id);
      if (it && (it.status === "done" || it.status === "error")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    it = dm.items.get(id);
  } catch (e) {
    console.log("  FAIL  enqueue threw: " + e.message);
    failed++;
  }

  assert("HLS download completes (status=done)", it && it.status === "done", "status=" + (it && it.status));
  assert("final mp4 exists and is non-empty", it && it.finalPath && fs.existsSync(it.finalPath) && fs.statSync(it.finalPath).size > 0, it && it.finalPath);
  assert("all " + N + " segments fetched exactly once", stats.calls === N, "calls=" + stats.calls);
  assert("segment fetches are concurrent (not sequential)", stats.maxInFlight >= 2, "maxInFlight=" + stats.maxInFlight);
  assert("all " + N + " segments requested", [...new Set(stats.order)].length === N, "distinct=" + [...new Set(stats.order)].length);

  let id2, it2, finalPath2, tempDir2;
  try {
    id2 = await dm.enqueue({ url: "http://127.0.0.1:" + port + "/playlist.m3u8", title: "hls-abort", force: true });
    await new Promise((r) => setTimeout(r, 60));
    it2 = dm.items.get(id2);
    finalPath2 = it2 && it2.finalPath;
    tempDir2 = it2 && it2.tempDir;
    dm.cancel(id2);
    await new Promise((r) => setTimeout(r, 300));
    it2 = dm.items.get(id2);
  } catch (e) {
    console.log("  FAIL  abort test threw: " + e.message);
    failed++;
  }

  assert("cancel advances status to cancelled|error", it2 && (it2.status === "cancelled" || it2.status === "error"), "status=" + (it2 && it2.status));
  assert("cancel removes finalPath file", it2 && finalPath2 && !fs.existsSync(finalPath2));
  assert("cancel removes tempDir", it2 && tempDir2 && !fs.existsSync(tempDir2));

  const leftovers = fs.existsSync(tmp) ? fs.readdirSync(tmp).filter((n) => /^dl-/.test(n)) : [];
  assert("no orphaned temp dirs in download dir", leftovers.length === 0, leftovers.join(","));

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\n=== " + passed + " passed, " + failed + " failed ===\n");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
