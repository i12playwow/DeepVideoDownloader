"use strict";
// Headless DownloadManager regression suite (see AGENTS.md Verification).
// Usage: node test-engine-regression.js <path-to-video-fixture> [port]
// The video fixture is not committed (test-video.mp4 is gitignored) — create one
// locally, e.g. with ffmpeg. Exits non-zero on any failure.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DownloadManager } = require(path.join(__dirname, "downloader.js"));

const FIX = process.argv[2];
if (!FIX || !fs.existsSync(FIX)) { console.error("usage: node test-engine-regression.js <video> [port]"); process.exit(2); }
const PORT = parseInt(process.argv[3] || "8011", 10);
const DL = fs.mkdtempSync(path.join(os.tmpdir(), "dv-reg-"));
const hash = (p) => require("crypto").createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const SRC_HASH = hash(FIX);

let pass = 0, fail = 0;
const ok = (l, cond, d) => { if (cond) { pass++; console.log("PASS " + l); } else { fail++; console.log("FAIL " + l + (d ? " -> " + d : "")); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRangeServer() {
  return http.createServer((req, res) => {
    const f = FIX;
    const size = fs.statSync(f).size;
    const range = req.headers.range;
    if (req.method === "HEAD") { res.writeHead(200, { "Content-Length": size, "Accept-Ranges": "bytes" }); res.end(); return; }
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let s = m && m[1] !== "" ? parseInt(m[1], 10) : 0;
      let e = m && m[2] !== "" ? parseInt(m[2], 10) : size - 1;
      if (isNaN(e) || e >= size) e = size - 1;
      if (s > e) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return; }
      res.writeHead(206, { "Content-Length": e - s + 1, "Content-Range": `bytes ${s}-${e}/${size}` });
      fs.createReadStream(f, { start: s, end: e }).pipe(res); return;
    }
    res.writeHead(200, { "Content-Length": size });
    fs.createReadStream(f).pipe(res);
  });
}
function makeNoRangeServer() {
  return http.createServer((req, res) => {
    const size = fs.statSync(FIX).size;
    if (req.method === "HEAD") { res.writeHead(200, { "Content-Length": size }); res.end(); return; }
    res.writeHead(200, { "Content-Length": size });
    fs.createReadStream(FIX).pipe(res);
  });
}

function mkDM(extra) {
  return new DownloadManager({
    config: Object.assign({ downloadDir: DL, autoProxy: false, saveHistory: false, thumbnails: false, skipDuplicates: false, concurrency: 2, segments: 4, maxRetries: 2 }, extra || {}),
    proxyManager: { pickBest: async () => null, agentFor: () => null },
    onUpdate: () => {}
  });
}
async function waitFor(dm, id, statuses, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const it = dm.items.get(id);
    if (it && statuses.includes(it.status)) return it;
    await sleep(100);
  }
  return dm.items.get(id);
}
function filesIn(dir) {
  try { return fs.readdirSync(dir); } catch (e) { return []; }
}

(async () => {
  const rs = makeRangeServer(); rs.listen(PORT, "127.0.0.1");
  const ns = makeNoRangeServer(); ns.listen(PORT + 1, "127.0.0.1");
  const URL = `http://127.0.0.1:${PORT}/vid.mp4`;
  const NORANGE_URL = `http://127.0.0.1:${PORT + 1}/vid.mp4`;
  await sleep(300);

  // 1. Segmented download byte-identical
  {
    const dm = mkDM();
    const id = await dm.enqueue({ url: URL, title: "seg" });
    ok("enqueue returns id", typeof id === "string" && id.length > 0, id);
    const it = await waitFor(dm, id, ["done", "error"]);
    ok("segmented -> done", it && it.status === "done", it && it.status);
    const out = path.join(DL, "seg.mp4");
    ok("segmented byte-identical", fs.existsSync(out) && hash(out) === SRC_HASH);
    dm.remove(id);
  }

  // 2. Pause -> resume (back-to-back, AbortError guard) — slow DM for mid-flight timing
  {
    const dm = mkDM({ speedLimitKB: 30 });
    const id = await dm.enqueue({ url: URL, title: "pauseres" });
    await sleep(50);
    dm.pause(id);
    await sleep(50);
    const p = dm.items.get(id);
    ok("pause -> paused", p && p.status === "paused", p && p.status);
    dm.resume(id);
    const it = await waitFor(dm, id, ["done", "error"]);
    ok("pause->resume -> done", it && it.status === "done", it && it.status);
    const out = path.join(DL, "pauseres.mp4");
    ok("pause->resume byte-identical", fs.existsSync(out) && hash(out) === SRC_HASH);
    const partials = filesIn(DL).filter((f) => f.startsWith("_"));
    ok("no orphaned partials", partials.length === 0, partials.join(","));
    dm.remove(id);
  }

  // 3. Cancel mid-flight (no 0-byte finalPath, no tempDir). The cleanup rms are
  // async fire-and-forget, so wait for them to settle before inspecting.
  {
    const dm = mkDM({ speedLimitKB: 30 });
    const id = await dm.enqueue({ url: URL, title: "cancel" });
    await sleep(50);
    dm.cancel(id);
    const it = await waitFor(dm, id, ["cancelled", "error"]);
    ok("cancel -> cancelled", it && it.status === "cancelled", it && it.status);
    await sleep(800);
    const leftover = filesIn(DL).filter((f) => f === "cancel.mp4" || f.startsWith("dl-"));
    ok("cancel leaves no finalPath/tempDir", leftover.length === 0, leftover.join(","));
    dm.remove(id);
  }

  // 4. norange fallback (server ignores Range) -> single, byte-identical
  {
    const dm = mkDM();
    const id = await dm.enqueue({ url: NORANGE_URL, title: "norange" });
    const it = await waitFor(dm, id, ["done", "error"]);
    ok("norange fallback -> done", it && it.status === "done", it && it.status);
    const out = path.join(DL, "norange.mp4");
    ok("norange byte-identical", fs.existsSync(out) && hash(out) === SRC_HASH);
    dm.remove(id);
  }

  // 5. Scheduling (ISO-string dates — enqueue normalizes them to numeric ms):
  //    elapsed start..stop -> paused; future start -> scheduled; live set-stop -> paused.
  {
    const dm = mkDM({ speedLimitKB: 30 });
    const past = await dm.enqueue({ url: URL, title: "schedpast", scheduledStart: new Date(Date.now() - 60000).toISOString(), scheduledStop: new Date(Date.now() - 30000).toISOString() });
    const pastIt = await waitFor(dm, past, ["paused", "done", "error"]);
    ok("elapsed window -> paused", pastIt && pastIt.status === "paused", pastIt && pastIt.status);
    dm.remove(past);

    const fut = await dm.enqueue({ url: URL, title: "schedfut", scheduledStart: new Date(Date.now() + 30000).toISOString() });
    const futIt = dm.items.get(fut);
    ok("future start -> scheduled", futIt && futIt.status === "scheduled", futIt && futIt.status);
    dm.cancel(fut);
    await waitFor(dm, fut, ["cancelled"]);

    const live = await dm.enqueue({ url: URL, title: "schedlive", scheduledStop: new Date(Date.now() + 1500).toISOString() });
    await sleep(400);
    ok("live item running before stop", (dm.items.get(live) || {}).status === "running");
    const liveIt = await waitFor(dm, live, ["paused", "done", "error"]);
    ok("live set-stop -> paused", liveIt && liveIt.status === "paused", liveIt && liveIt.status);
    dm.remove(live);
  }

  // 6. _activeDirSync fallback chain
  {
    const dm0 = mkDM();
    ok("no dir2/3 -> primary", dm0.dir === DL, dm0.dir);
    const dm1 = mkDM({ minFreeMB: 0 });
    ok("minFreeMB 0 -> primary", dm1.dir === DL, dm1.dir);
    const dm2 = mkDM({ downloadDir2: path.join(DL, "d2"), minFreeMB: 100000000 });
    ok("forced full -> dir2", dm2.dir === path.join(DL, "d2"), dm2.dir);
    const dm3 = mkDM({ downloadDir2: path.join(DL, "d2"), downloadDir3: path.join(DL, "d3"), minFreeMB: 100000000 });
    ok("forced full both -> dir3", dm3.dir === path.join(DL, "d3"), dm3.dir);
    ok("dir3 created", fs.existsSync(path.join(DL, "d3")));
  }

  rs.close(); ns.close();
  fs.rmSync(DL, { recursive: true, force: true });
  console.log("\n=== " + pass + " passed, " + fail + " failed ===");
  process.exit(fail ? 1 : 0);
})();