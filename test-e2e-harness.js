"use strict";
// Local end-to-end harness — exercises the REAL app code (downloader.js +
// lib/resolvers.js + lib/browser-open.js + lib/ws-bridge.js) with no external
// network, no Cloudflare. Mock server on 127.0.0.1 stands in for the final
// stream and the supjav page. Requires ffmpeg on PATH for HLS download
// assertions (they auto-skip otherwise, like test-hls-parallel.js).
// Run: node test-e2e-harness.js
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { WebSocketServer, WebSocket } = require("ws");
const { DownloadManager } = require("./downloader");
const { ProxyManager } = require("./proxy");
const { DEFAULT_CONFIG } = require("./config");
const { resolveJavAggregator } = require("./lib/resolvers");
const browserOpen = require("./lib/browser-open");
const wsBridge = require("./lib/ws-bridge");

let passed = 0, failed = 0, skipped = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log("  PASS  " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? " -> " + detail : "")); }
}
function skip(label, why) { skipped++; console.log("  SKIP  " + label + " (" + why + ")"); }
function hasFfmpeg() { return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0; }
function makeTs(outFile) {
  const r = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=duration=0.2:size=16x16:rate=10",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mpegts", outFile], { stdio: "ignore" });
  return r.status === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0;
}
function waitForCondition(pred, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve(true);
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

function startServer(portRef, segBytesFn) {
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    const hits = server._dvHits || (server._dvHits = []);
    hits.push(url);
    const m3u8 = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\nseg0.ts\nseg1.ts\n";
    if (url === "/hup/master.m3u8") {
      const b = Buffer.from(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360\n360p/video.m3u8\n" +
        "#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\n1080p/video.m3u8\n"
      );
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": b.length });
      return res.end(b);
    }
    if (url === "/dup/playlist.m3u8") {
      const b = Buffer.from(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\n1080p/video.m3u8\n"
      );
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": b.length });
      return res.end(b);
    }
    if (/^\/(?:hup|dup)\/\d+p\/video\.m3u8$/.test(url)) {
      const body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n" +
        "http://127.0.0.1:" + portRef.port + "/seg0.ts\nhttp://127.0.0.1:" + portRef.port + "/seg1.ts\n";
      const b = Buffer.from(body);
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": b.length });
      return res.end(b);
    }
    if (url === "/ad/allad.m3u8") {
      const p = "http://127.0.0.1:" + portRef.port;
      const body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n" +
        p + "/adseg/ad-img-0.image\n" + p + "/adseg/ad-img-1.image\n" + p + "/adseg/ad-img-2.image\n";
      const b = Buffer.from(body);
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": b.length });
      return res.end(b);
    }
    if (url === "/ad/mixed.m3u8") {
      const p = "http://127.0.0.1:" + portRef.port;
      const body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n" +
        p + "/adseg/ad-img-0.image\n" + p + "/seg0.ts\n" + p + "/adseg/ad-img-1.image\n" + p + "/seg1.ts\n";
      const b = Buffer.from(body);
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": b.length });
      return res.end(b);
    }
    if (/^\/adseg\//.test(url)) { res.writeHead(404); return res.end(); }
    if (url === "/" || url.endsWith(".m3u8")) {
      const b = Buffer.from(m3u8);
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": b.length });
      return res.end(b);
    }
    if (/^\/seg\d+\.ts$/.test(url)) {
      const b = segBytesFn();
      res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": b.length });
      return res.end(b);
    }
    if (url === "/cf.html") {
      const b = Buffer.from("<html><body>Just a moment...</body></html>");
      res.writeHead(200, { "Content-Type": "text/html", "Content-Length": b.length });
      return res.end(b);
    }
    if (url === "/direct.html") {
      const body = "<html><body><script>var src='http://127.0.0.1:" + portRef.port + "/playlist.m3u8';</script></body></html>";
      const b = Buffer.from(body);
      res.writeHead(200, { "Content-Type": "text/html", "Content-Length": b.length });
      return res.end(b);
    }
    if (url === "/junk.html") {
      const b = Buffer.from("<!DOCTYPE html><html><body>not a video</body></html>");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": b.length });
      return res.end(b);
    }
    if (url === "/octet.html") {
      const b = Buffer.from("<html><body>lied-about-content-type</body></html>");
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": b.length });
      return res.end(b);
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => {
    server.on("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

(async () => {
  console.log("\n=== local e2e harness ===\n");
  const ff = hasFfmpeg();
  if (!ff) console.log("  (ffmpeg not on PATH — HLS download assertions will SKIP)\n");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dvw-e2e-"));
  let segBytes = Buffer.from("FAKE");
  if (ff) {
    const segTs = path.join(tmp, "seg.ts");
    if (!makeTs(segTs)) { console.log("  SKIP  cannot generate .ts"); ff && (ff = false); }
    else segBytes = fs.readFileSync(segTs);
  }
  const portRef = {};
  const srv = await startServer(portRef, () => segBytes);
  if (!srv) { console.log("  FAIL  mock server did not start"); process.exit(1); }
  portRef.port = srv.port;
  const { server, port } = srv;
  const base = "http://127.0.0.1:" + port;

  const config = Object.assign({}, DEFAULT_CONFIG, {
    downloadDir: tmp, saveHistory: false, thumbnails: false, autoProxy: false,
    proxies: [], hlsConcurrency: 4, ffmpegPath: "ffmpeg", maxRetries: 0, hostDelayMs: 0
  });
  const dm = new DownloadManager({ config, proxyManager: new ProxyManager(config), onUpdate: () => {} });
  const waitFor = async (dmInst, id, timeoutMs) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const it = dmInst.items.get(id);
      if (it && (it.status === "done" || it.status === "error" || it.status === "cancelled")) return it;
      await new Promise((r) => setTimeout(r, 100));
    }
    return dmInst.items.get(id);
  };

  // ---- A: real HLS download from local m3u8 (direct enqueue) ----
  console.log("-- A: real HLS download (direct enqueue) --");
  if (!ff) skip("A download", "no ffmpeg");
  else {
    try {
      const id = await dm.enqueue({ url: base + "/playlist.m3u8", title: "e2e-hls" });
      const it = await waitFor(dm, id, 40000);
      assert("A status=done", it && it.status === "done", "status=" + (it && it.status));
      assert("A final mp4 non-empty", it && it.finalPath && fs.existsSync(it.finalPath) && fs.statSync(it.finalPath).size > 0, it && it.finalPath);
    } catch (e) { assert("A enqueue", false, e.message); }
  }

  // ---- B: requires-browser wiring ----
  console.log("\n-- B: requires-browser wiring --");
  try {
    await resolveJavAggregator(base + "/cf.html", { proxyManager: new ProxyManager(config), config }, {});
    assert("B1 resolver throws requires-browser on CF page", false, "no error");
  } catch (e) {
    assert("B1 resolver throws requires-browser on CF page", e.category === "requires-browser", "category=" + e.category);
  }
  const { isCfChallengeHtml } = require("./lib/errors");
  assert("B3 isCfChallengeHtml catches checking-your-browser interstitial",
    isCfChallengeHtml("<title>Checking your browser...</title><script>window._cf_chl_opt={cType:'managed'}</script>"));
  assert("B3b isCfChallengeHtml catches classic Just a moment",
    isCfChallengeHtml("<title>Just a moment</title>"));
  assert("B3c isCfChallengeHtml passes real pages through",
    !isCfChallengeHtml("<html><body><video src='a.mp4'>video page</body></html>"));
  try {
    await resolveJavAggregator("https://sextb.net/hodv-22062-rm", { proxyManager: new ProxyManager(config), config, fetchHtml: async () => "<title>Checking your browser...</title><script>window._cf_chl_opt={cZone:'sextb.net',cType:'managed'}</script>" }, {});
    assert("B4 sextb-style interstitial -> requires-browser", false, "no error");
  } catch (e) { assert("B4 sextb-style interstitial -> requires-browser", e.category === "requires-browser", "cat=" + e.category); }
  const resolvers = require("./lib/resolvers");
  const origResolve = resolvers.resolveUrl;
  resolvers.resolveUrl = async (u) => {
    if (String(u).includes("SENTINEL-RB")) { const e = new Error("rb"); e.category = "requires-browser"; throw e; }
    return origResolve(u);
  };
  const dmPath = require.resolve("./downloader");
  delete require.cache[dmPath];
  const { DownloadManager: DM2 } = require("./downloader");
  let rbFired = null;
  const dm2 = new DM2({ config, proxyManager: new ProxyManager(config), onUpdate: () => {}, onRequiresBrowser: (u) => { rbFired = u; } });
  try {
    const id = await dm2.enqueue({ url: base + "/SENTINEL-RB", title: "e2e-rb" });
    const it = await waitFor(dm2, id, 20000);
    assert("B2 item errorCategory=requires-browser", it && it.errorCategory === "requires-browser", "cat=" + (it && it.errorCategory));
    assert("B2 onRequiresBrowser fired with url", rbFired === base + "/SENTINEL-RB", "fired=" + rbFired);
  } catch (e) { assert("B2 enqueue", false, e.message); }
  delete require.cache[dmPath];
  resolvers.resolveUrl = origResolve;

  // ---- C: aggregator direct m3u8 extraction ----
  console.log("\n-- C: aggregator direct m3u8 extraction --");
  let extracted = null;
  try {
    extracted = await resolveJavAggregator(base + "/direct.html", { proxyManager: new ProxyManager(config), config }, {});
    assert("C extracts local m3u8 url", typeof extracted === "string" && extracted.endsWith("/playlist.m3u8"), "got=" + extracted);
  } catch (e) { assert("C resolve", false, e.message); }
  if (ff && extracted && extracted.endsWith("/playlist.m3u8")) {
    try {
      const id = await dm.enqueue({ url: extracted, title: "e2e-c", force: true });
      const it = await waitFor(dm, id, 40000);
      assert("C download completes", it && it.status === "done", "status=" + (it && it.status));
    } catch (e) { assert("C enqueue", false, e.message); }
  } else if (!ff) skip("C download", "no ffmpeg");

  // ---- D: browser-open module (real throttle + skip) ----
  console.log("\n-- D: browser-open throttle + supjav.php skip --");
  const { SJ_PLAYER_RE } = require("./lib/resolvers");
  assert("D supjav.php?l= matches SJ_PLAYER_RE", SJ_PLAYER_RE.test("https://supjav.com/x/supjav.php?l=ABC123"));
  assert("D page url does NOT match SJ_PLAYER_RE", !SJ_PLAYER_RE.test("https://supjav.com/271556.html"));
  let calls = 0, maxActive = 0, active = 0;
  browserOpen.setOpener((u) => {
    calls++; active++;
    if (active > maxActive) maxActive = active;
    setTimeout(() => { active--; }, 30);
  });
  const ten = [];
  for (let i = 0; i < 10; i++) ten.push("https://supjav.com/" + i + ".html");
  browserOpen.queueBrowserOpen("chrome-extension://abc/suspended.html");
  browserOpen.queueBrowserOpen(ten[0]);
  for (const u of ten) browserOpen.queueBrowserOpen(u);
  browserOpen.queueBrowserOpen("https://supjav.com/x/supjav.php?l=ZZZ");
  assert("D non-http ignored immediately", active <= 3);
  await new Promise((r) => setTimeout(r, browserOpen.BROWSER_OPEN_GAP_MS * 6));
  assert("D at most BROWSER_OPEN_MAX concurrent", maxActive <= browserOpen.BROWSER_OPEN_MAX, "max=" + maxActive);
  assert("D all 10 distinct opened (no supjav.php, no dup, no ext)", calls === 10, "calls=" + calls);
  assert("D supjav.php entry not opened", calls === 10);

  // ---- F: queueBrowserOpenMany (explicit bulk "open in browser") ----
  console.log("\n-- F: queueBrowserOpenMany (explicit bulk) --");
  let callsF = 0, maxActiveF = 0, activeF = 0;
  browserOpen.setOpener((u) => {
    callsF++; activeF++;
    if (activeF > maxActiveF) maxActiveF = activeF;
    setTimeout(() => { activeF--; }, 30);
  });
  const bulk = [];
  for (let i = 0; i < 20; i++) bulk.push("https://supjav.com/x/supjav.php?l=BULK" + i);
  browserOpen.queueBrowserOpenMany(bulk);
  browserOpen.queueBrowserOpenMany(bulk[0]); // duplicate -> NOT deduplicated in explicit bulk
  await new Promise((r) => setTimeout(r, browserOpen.BROWSER_OPEN_GAP_MS * 12));
  assert("F at most BROWSER_OPEN_MAX concurrent (bulk)", maxActiveF <= browserOpen.BROWSER_OPEN_MAX, "max=" + maxActiveF);
  assert("F all 20 + duplicate opened (no iframe skip, no dedupe)", callsF === 21, "calls=" + callsF);

  // ---- E: REAL extension->app WebSocket `download` (the sendToDesktop contract) ----
  console.log("\n-- E: extension -> app WebSocket download --");
  if (!ff) skip("E WS download", "no ffmpeg");
  else {
    const wsServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    wsServer.on("connection", (ws) => {
      ws.on("message", async (data) => {
        let msg; try { msg = JSON.parse(data.toString()); } catch (e) { return; }
        try {
          await wsBridge.handleWsMessage(msg, {
            dm,
            gatherCookieHeader: async () => "",
            probeUrl: async () => ({ size: 0 }),
            send: (o) => { try { ws.send(JSON.stringify(o)); } catch (e) {} }
          });
        } catch (e) {}
      });
    });
    await new Promise((r) => wsServer.on("listening", r));
    const wsPort = wsServer.address().port;
    const client = new WebSocket("ws://127.0.0.1:" + wsPort);
    await new Promise((r) => client.on("open", r));
    const responses = [];
    client.on("message", (d) => { try { responses.push(JSON.parse(d.toString())); } catch (e) {} });

    // a) the download message the extension actually sends
    client.send(JSON.stringify({ type: "download", url: base + "/playlist.ws.m3u8", title: "e2e-ws", referer: base, sources: [{ kind: "link", url: base + "/playlist.ws.m3u8", label: "" }] }));
    const accepted = await (async () => {
      const ok = await waitForCondition(() => responses.some((x) => x.type === "accepted"), 10000);
      return ok ? responses.find((x) => x.type === "accepted") : null;
    })();
    assert("E WS accepted response with id", accepted && Array.isArray(accepted.ids) && accepted.ids.length === 1, JSON.stringify(accepted));
    if (accepted) {
      const it = await waitFor(dm, accepted.ids[0], 40000);
      assert("E WS download completes (status=done)", it && it.status === "done", it && it.status);
      assert("E final mp4 non-empty", it && it.finalPath && fs.existsSync(it.finalPath) && fs.statSync(it.finalPath).size > 0, it && it.finalPath);
    }
    // b) ping/pong + error branches
    client.send(JSON.stringify({ type: "ping" }));
    const gotPong = await waitForCondition(() => responses.some((x) => x.type === "pong"), 5000);
    assert("E ping -> pong", gotPong);
    client.send(JSON.stringify({ type: "download" }));
    const gotErr = await waitForCondition(() => responses.some((x) => x.type === "error" && x.message === "No usable source"), 5000);
    assert("E empty download -> No usable source error", gotErr);

    client.close();
    wsServer.close();
  }

  // ---- W: WS pairing policy (isAllowedWsOrigin) ----
  console.log("-- W: WS origin pairing policy --");
  const allow = (o) => wsBridge.isAllowedWsOrigin(o);
  assert("W extension origin allowed", allow("chrome-extension://abc123"), "chrome ext");
  assert("W firefox extension origin allowed", allow("moz-extension://abc-123"), "moz ext");
  assert("W no Origin header allowed (native client)", allow(""), "no origin");
  assert("W no Origin header allowed (undefined)", allow(undefined), "undefined origin");
  assert("W https website origin rejected", !allow("https://evil.example.com"), "web origin");
  assert("W http website origin rejected", !allow("http://127.0.0.1:9999"), "http origin");
  assert("W file origin rejected", !allow("file:///C:/x.html"), "file origin");
  assert("W null origin rejected", !allow("null"), "null origin");

  // ---- G: supjav list-page resolution (mock fetch) ----
  console.log("\n-- G: supjav list-page resolution --");
  const pmForG = new ProxyManager(config);
  const listHtml1 = '<html><body><a href="http://supjav.com/271556.html">A</a><a href="http://supjav.com/271557.html">B</a><a href="http://supjav.com/271558.html">C</a><a href="http://supjav.com/page/2">Next</a></body></html>';
  const listHtml2 = '<html><body><a href="http://supjav.com/271559.html">D</a><a href="http://supjav.com/271560.html">E</a></body></html>';
  const mockFetch = async (url) => url === "http://supjav.com/list" ? listHtml1 : url === "http://supjav.com/page/2" ? listHtml2 : "";
  try {
    const list = await resolveJavAggregator("http://supjav.com/list", { proxyManager: pmForG, config, fetchHtml: mockFetch }, {});
    assert("G1 returns array of 5 movie links", Array.isArray(list) && list.length === 5, "len=" + (list && list.length));
    assert("G1 includes first movie", Array.isArray(list) && list.includes("http://supjav.com/271556.html"));
    assert("G1 includes last movie from page2", Array.isArray(list) && list.includes("http://supjav.com/271560.html"));
  } catch (e) { assert("G1 resolver list", false, e.message); }
  const singleHtml = '<html><body><a href="http://supjav.com/271999.html">X</a></body></html>';
  try {
    await resolveJavAggregator("http://supjav.com/271999.html", { proxyManager: pmForG, config, fetchHtml: async () => singleHtml }, {});
    assert("G2 single video page does NOT expand to list", false, "returned instead of throw");
  } catch (e) { assert("G2 single video page does NOT expand to list", true); }

  // ---- G3: sextb list-page resolution (mock fetch) ----
  console.log("\n-- G3: sextb list-page resolution --");
  const sextbHtml1 = '<html><body>' +
    '<a href="https://sextb.net/oba-031-rm">A</a>' +
    '<a href="https://sextb.net/pfes-095-sub">B</a>' +
    '<a href="https://sextb.net/33lbuabc">C</a>' +
    '<a href="https://sextb.net/genre/censored">list</a>' +
    '<a href="https://sextb.net/page/2">Next</a></body></html>';
  const sextbHtml2 = '<html><body><a href="https://sextb.net/259luxu-1255">D</a><a href="https://sextb.net/k8m71ayc">E</a></body></html>';
  const sextbFetch = async (url) => url === "https://sextb.net/" ? sextbHtml1 : url === "https://sextb.net/page/2" ? sextbHtml2 : "";
  try {
    const list = await resolveJavAggregator("https://sextb.net/", { proxyManager: pmForG, config, fetchHtml: sextbFetch }, {});
    assert("G3 returns array of 5 movie links", Array.isArray(list) && list.length === 5, "len=" + (list && list.length));
    assert("G3 includes first movie", Array.isArray(list) && list.includes("https://sextb.net/oba-031-rm"));
    assert("G3 includes homepage slug movie", Array.isArray(list) && list.includes("https://sextb.net/33lbuabc"));
    assert("G3 excludes genre list link", Array.isArray(list) && !list.includes("https://sextb.net/genre/censored"));
    assert("G3 includes last movie from page2", Array.isArray(list) && list.includes("https://sextb.net/259luxu-1255"));
  } catch (e) { assert("G3 resolver list", false, e.message); }

  // ---- R: movie page with >=3 related links never expands to a list ----
  console.log("\n-- R: movie pages are not lists --");
  const sextbMovieHtml = '<html><body>' +
    '<a href="https://sextb.net/rel-001">R1</a>' +
    '<a href="https://sextb.net/rel-002">R2</a>' +
    '<a href="https://sextb.net/rel-003">R3</a></body></html>';
  try {
    const r = await resolveJavAggregator("https://sextb.net/oba-031-rm", { proxyManager: pmForG, config, fetchHtml: async () => sextbMovieHtml }, {});
    assert("R sextb movie page with 3+ links is NOT a list", false, "expanded: " + (r && r.length));
  } catch (e) { assert("R sextb movie page with 3+ links is NOT a list", true, e.message); }
  let sextbCat = null;
  try {
    sextbCat = await resolveJavAggregator("https://sextb.net/genre/censored", { proxyManager: pmForG, config, fetchHtml: async () => sextbMovieHtml }, {});
    assert("R sextb list URL still expands", Array.isArray(sextbCat) && sextbCat.length === 3, "len=" + (sextbCat && sextbCat.length));
  } catch (e) { assert("R sextb list URL still expands", false, e.message); }
  try {
    await resolveJavAggregator("http://supjav.com/271999.html", { proxyManager: pmForG, config, fetchHtml: async () => '<html><body><a href="http://supjav.com/271557.html">r1</a><a href="http://supjav.com/271558.html">r2</a><a href="http://supjav.com/271560.html">r3</a></body></html>' }, {});
    assert("R supjav movie page with 3+ links is NOT a list", false, "expanded");
  } catch (e) {
    assert("R supjav movie page with 3+ links is NOT a list", true, e.message);
    assert("R unsourcable movie page -> requires-browser", e.category === "requires-browser", "cat=" + e.category);
  }
  const dmPathR = require.resolve("./downloader");
  delete require.cache[dmPathR];

  // ---- H: DownloadManager list expansion (monkeypatch resolver -> array) ----
  console.log("\n-- H: DownloadManager list expansion --");
  const resolversMod = require("./lib/resolvers");
  const origResolveH = resolversMod.resolveUrl;
  resolversMod.resolveUrl = async (u) => String(u).includes("LISTURL") ? [base + "/a.m3u8", base + "/b.m3u8"] : u;
  const dmPathH = require.resolve("./downloader");
  delete require.cache[dmPathH];
  const { DownloadManager: DMH } = require("./downloader");
  const dmH = new DMH({ config, proxyManager: new ProxyManager(config), onUpdate: () => {} });
  try {
    const pid = await dmH.enqueue({ url: base + "/LISTURL", title: "e2e-list" });
    await waitFor(dmH, pid, 20000);
    assert("H parent marked done", dmH.items.get(pid) && dmH.items.get(pid).status === "done", "status=" + (dmH.items.get(pid) && dmH.items.get(pid).status));
    assert("H parent lists 2 children", dmH.items.get(pid) && dmH.items.get(pid).listCount === 2, "listCount=" + (dmH.items.get(pid) && dmH.items.get(pid).listCount));
    assert("H two children enqueued (total 3 items)", dmH.items.size === 3, "size=" + dmH.items.size);
  } catch (e) { assert("H enqueue/list", false, e.message); }
  delete require.cache[dmPathH];
  resolversMod.resolveUrl = origResolveH;

  // ---- I: chrome-extension wrapper unwrapping ----
  console.log("\n-- I: chrome-extension wrapper unwrapping --");
  const { unwrapExtensionUrl } = require("./lib/urls");
  assert("I suspended.html uri unwraps",
    unwrapExtensionUrl("chrome-extension://hlofigcdgjlnalbkeeinfcjceabpamci/html/suspended.html#ttl=%5BReducing%20Mosaic%5DSONE-841&pos=0&uri=https%3A%2F%2Fsupjav.com%2F366173.html") === "https://supjav.com/366173.html",
    unwrapExtensionUrl("chrome-extension://hlofigcdgjlnalbkeeinfcjceabpamci/html/suspended.html#ttl=x&pos=0&uri=https%3A%2F%2Fsupjav.com%2F366173.html"));
  assert("I raw#fragment unwraps",
    unwrapExtensionUrl("chrome-extension://abc/lazyloading.html#https://supjav.com/334352.html") === "https://supjav.com/334352.html",
    unwrapExtensionUrl("chrome-extension://abc/lazyloading.html#https://supjav.com/334352.html"));
  assert("I double-encoded unwraps",
    unwrapExtensionUrl("chrome-extension://abc/x.html#https%253A%252F%252Fsupjav.com%252Fa") === "https://supjav.com/a",
    unwrapExtensionUrl("chrome-extension://abc/x.html#https%253A%252F%252Fsupjav.com%252Fa"));
  assert("I http(s) passes through unchanged",
    unwrapExtensionUrl("https://supjav.com/271999.html") === "https://supjav.com/271999.html");
  assert("I no-inner-url stays untouched",
    unwrapExtensionUrl("chrome-extension://jinjaccalgkegednnccohejagnlnfdag/options/index.html#scripts") === "chrome-extension://jinjaccalgkegednnccohejagnlnfdag/options/index.html#scripts");
  const dmPathI = require.resolve("./downloader");
  delete require.cache[dmPathI];
  const { DownloadManager: DMI } = require("./downloader");
  const dmi = new DMI({ config: Object.assign({}, config, { skipDuplicates: false }), proxyManager: new ProxyManager(config), onUpdate: () => {} });
  const wrapper = "chrome-extension://hlofigcdgjlnalbkeeinfcjceabpamci/html/suspended.html#pos=0&uri=" + encodeURIComponent(base + "/playlist.m3u8");
  try {
    const wid = await dmi.enqueue({ url: wrapper, title: "e2e-unwrap" });
    const wit = await waitFor(dmi, wid, 40000);
    assert("I wrapper enqueues with normalized url", wit && wit.url === base + "/playlist.m3u8", "url=" + (wit && wit.url));
    if (ff) assert("I wrapper download completes", wit && wit.status === "done", "status=" + (wit && wit.status));
    else skip("I wrapper E2E download", "no ffmpeg");
  } catch (e) { assert("I wrapper enqueue", false, e.message); }
  try {
    await dmi.enqueue({ url: "chrome-extension://jinjaccalgkegednnccohejagnlnfdag/options/index.html#scripts", title: "e2e-junk" });
    assert("I bare chrome-extension throws at enqueue", false, "no error");
  } catch (e) { assert("I bare chrome-extension throws at enqueue", /Unsupported URL/.test(e.message), e.message); }
  const prePending = dmi.items.size;
  dmi.addPending([wrapper, "chrome-extension://abc/junk#scripts", base + "/playlist.m3u8"]);
  assert("I addPending unwraps wrapper, keeps http, drops junk", dmi.items.size === prePending + 2, "size=" + dmi.items.size + " (pre=" + prePending + ")");
  try {
    await dmi.enqueue({ url: "https://sextb.net/feed", title: "e2e-feed" });
    assert("I /feed throws at enqueue", false, "no error");
  } catch (e) { assert("I /feed throws at enqueue", /Unsupported URL/.test(e.message), e.message); }
  try {
    await dmi.enqueue({ url: "https://sextb.net/rss", title: "e2e-rss" });
    assert("I /rss throws at enqueue", false, "no error");
  } catch (e) { assert("I /rss throws at enqueue", /Unsupported URL/.test(e.message), e.message); }
  const prePending2 = dmi.items.size;
  dmi.addPending(["https://sextb.net/feed", "https://sextb.net/hodv-22062-rm"]);
  assert("I addPending drops feed, keeps real page", dmi.items.size === prePending2 + 1, "size=" + dmi.items.size + " (pre=" + prePending2 + ")");
  delete require.cache[dmPathI];

  // ---- J: variant->master upgrade (captured 360p URL downloads 1080p) ----
  console.log("\n-- J: HLS variant -> master upgrade --");
  const dmPathJ = require.resolve("./downloader");
  delete require.cache[dmPathJ];
  const { DownloadManager: DMJ } = require("./downloader");
  const dmJ = new DMJ({ config, proxyManager: new ProxyManager(config), onUpdate: () => {} });
  try {
    const jid = await dmJ.enqueue({ url: base + "/hup/360p/video.m3u8", title: "e2e-upgrade" });
    const jit = await waitFor(dmJ, jid, 40000);
    const jhits = (server._dvHits || []).filter((h) => h.includes("/hup"));
    assert("J sibling master probed", jhits.includes("/hup/master.m3u8"), "hits=" + jhits.join(","));
    assert("J best variant (1080p) fetched", jhits.includes("/hup/1080p/video.m3u8"), "hits=" + jhits.join(","));
    if (ff) assert("J upgrade download completes", jit && jit.status === "done", "status=" + (jit && jit.status));
    else skip("J upgrade E2E download", "no ffmpeg");
  } catch (e) { assert("J variant->master upgrade", false, e.message); }
  delete require.cache[dmPathJ];

  // ---- K: HLS variant vs master dedupe ----
  console.log("\n-- K: HLS variant -> master dedupe --");
  const dmPathK = require.resolve("./downloader");
  delete require.cache[dmPathK];
  const { DownloadManager: DMK } = require("./downloader");
  const dmK = new DMK({ config, proxyManager: new ProxyManager(config), onUpdate: () => {} });
  const kHitsBefore = (server._dvHits || []).length;
  try {
    const mid = await dmK.enqueue({ url: base + "/dup/playlist.m3u8", title: "e2e-dup-master" });
    const mit = await waitFor(dmK, mid, 40000);
    assert("K master downloads", mit && mit.status === "done", "status=" + (mit && mit.status));
    const vid = await dmK.enqueue({ url: base + "/dup/720p/video.m3u8", title: "e2e-dup-variant" });
    const vit = await waitFor(dmK, vid, 15000);
    assert("K variant becomes duplicate", vit && vit.status === "duplicate", "status=" + (vit && vit.status));
    const kHits = (server._dvHits || []).slice(kHitsBefore);
    assert("K variant m3u8 never fetched", kHits.indexOf("/dup/720p/video.m3u8") === -1,
      "dup hits=" + JSON.stringify(kHits.filter((h) => h.includes("/dup"))));
  } catch (e) { assert("K variant->master dedupe", false, e.message); }
  delete require.cache[dmPathK];

  // ---- L: HTML pages never download as .mp4 junk ----
  console.log("\n-- L: HTML junk rejection --");
  const { isHtmlContentType, looksLikeHtmlHead } = require("./lib/errors");
  assert("L0 isHtmlContentType text/html", isHtmlContentType("text/html; charset=utf-8"));
  assert("L0 isHtmlContentType xhtml", isHtmlContentType("application/xhtml+xml"));
  assert("L0 video/octet pass through", !isHtmlContentType("video/mp4") && !isHtmlContentType("application/octet-stream") && !isHtmlContentType(""));
  assert("L0 looksLikeHtmlHead catches doctype", looksLikeHtmlHead(Buffer.from("<!DOCTYPE html><html>")));
  assert("L0 looksLikeHtmlHead catches BOM header", looksLikeHtmlHead(Buffer.from("\uFEFF<html>")));
  assert("L0 mp4 ftyp header is not html", !looksLikeHtmlHead(Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])));
  const dmPathL = require.resolve("./downloader");
  delete require.cache[dmPathL];
  const { DownloadManager: DML } = require("./downloader");
  const dml = new DML({ config, proxyManager: new ProxyManager(config), onUpdate: () => {} });
  for (const [label, path] of [["L1 content-type text/html", "/junk.html"], ["L2 octet-stream with html body", "/octet.html"]]) {
    try {
      const id = await dml.enqueue({ url: base + path, title: "e2e-junk" });
      const it = await waitFor(dml, id, 20000);
      assert(label + " errors as not-video", it && it.status === "error" && it.errorCategory === "not-video",
        "status=" + (it && it.status) + " cat=" + (it && it.errorCategory) + " (" + (it && it.error) + ")");
      assert(label + " leaves no .mp4 file", !it.finalPath || !fs.existsSync(it.finalPath), it && it.finalPath);
      assert(label + " not marked downloaded", !dml.isDownloaded(base + path), base + path);
    } catch (e) { assert(label + " junk rejection", false, e.message); }
  }
  delete require.cache[dmPathL];

  // ---- M: JAV nav-slug guardrail (autoloop crawl storm defense) ----
  console.log("\n-- M: JAV nav-slug guardrail --");
  const { isJavNavPage } = require("./downloader");
  assert("M nav slug invite-ads rejected", isJavNavPage("https://sextb.net/invite-ads"));
  assert("M nav slug genres rejected", isJavNavPage("https://sextb.net/genres"));
  assert("M nav slug private rejected", isJavNavPage("https://sextb.net/private"));
  assert("M nav slug new-releases rejected", isJavNavPage("https://sextb.net/new-releases"));
  assert("M nav slug dmca rejected", isJavNavPage("https://sextb.net/dmca"));
  assert("M base host rejected", isJavNavPage("https://sextb.net/"));
  assert("M movie slug with digits kept", !isJavNavPage("https://sextb.net/oba-031-rm"));
  assert("M movie fc2 slug kept", !isJavNavPage("https://sextb.net/fc2ppv-4967128"));
  assert("M supjav .html page kept", !isJavNavPage("https://supjav.com/271557.html"));
  assert("M streamtape untouched", !isJavNavPage("https://streamtape.com/v/abc123/"));
  const dmPathM = require.resolve("./downloader");
  delete require.cache[dmPathM];
  const { DownloadManager: DMM } = require("./downloader");
  const dmm = new DMM({ config, proxyManager: new ProxyManager(config), onUpdate: () => {} });
  for (const bad of ["https://sextb.net/genres", "https://sextb.net/invite-ads", "https://sextb.net/dmca"]) {
    try { await dmm.enqueue({ url: bad, title: "e2e-nav" }); assert("M enqueue " + bad.split("/")[3], false, "no error"); }
    catch (e) { assert("M enqueue rejects " + bad.split("/")[3], /Unsupported URL/.test(e.message), e.message); }
  }
  try {
    await dmm.enqueue({ url: "https://sextb.net/oba-031-rm", title: "e2e-real" });
    assert("M enqueue accepts real movie slug", true);
  } catch (e) { assert("M enqueue accepts real movie slug", false, e.message); }
  delete require.cache[dmPathM];

  // ---- M2: supjav CF-walled movie page guard (crawl-storm kill switch) ----
  console.log("\n-- M2: supjav CF-wall movie page guard --");
  const { isCfwalledSupjavMovie } = require("./lib/resolvers");
  assert("M2 supjav movie page flagged",
    isCfwalledSupjavMovie("https://supjav.com/452555.html") &&
    isCfwalledSupjavMovie("https://www.supjav.com/453774.html") &&
    isCfwalledSupjavMovie("https://m.supjav.com/271557.html"),
    "movie page not flagged");
  assert("M2 supjav player URL kept",
    !isCfwalledSupjavMovie("https://supjav.com/x/supjav.php?l=ABC123"),
    "player flagged");
  assert("M2 supjav list URL kept", !isCfwalledSupjavMovie("https://supjav.com/list"), "list flagged");
  assert("M2 sextb movie slug kept", !isCfwalledSupjavMovie("https://sextb.net/oba-031-rm"), "sextb flagged");
  assert("M2 supremejav untouched", !isCfwalledSupjavMovie("https://supremejav.com/123.html"), "supremejav flagged");
  const dmPathM2 = require.resolve("./downloader");
  delete require.cache[dmPathM2];
  const { DownloadManager: DMM2 } = require("./downloader");
  const dmm2 = new DMM2({ config, proxyManager: new ProxyManager(config), onUpdate: () => {} });
  try {
    await dmm2.enqueue({ url: "https://supjav.com/452555.html", title: "e2e-movie" });
    assert("M2 enqueue rejects supjav movie page", false, "no error");
  } catch (e) {
    assert("M2 enqueue rejects supjav movie page", /Unsupported URL/.test(e.message), e.message);
    assert("M2 message explains the CF wall", /Cloudflare/i.test(e.message), e.message);
  }
  try {
    await dmm2.enqueue({ url: "https://supjav.com/x/supjav.php?l=ABC123", title: "e2e-player" });
    assert("M2 enqueue accepts supjav player URL", true);
  } catch (e) { assert("M2 enqueue accepts supjav player URL", false, e.message); }
  const preM2 = dmm2.items.size;
  dmm2.addPending(["https://supjav.com/452555.html", "https://supjav.com/453774.html",
    "https://supjav.com/x/supjav.php?l=DEF456", "https://sextb.net/oba-031-rm"]);
  assert("M2 addPending drops movie pages, keeps player+sextb",
    dmm2.items.size === preM2 + 2, "size=" + dmm2.items.size + " (pre=" + preM2 + ")");
  delete require.cache[dmPathM2];

  // ---- M3: ws-bridge skips CF-walled source without aborting the batch ----
  console.log("\n-- M3: ws-bridge supjav source filtering --");
  const sendM3 = [];
  const dm3Hook = {
    enqueue: async (a) => { const g = a.url.match(/\/([^/]+)\.m3u8/); return g ? g[1] : "id-" + a.url.length; }
  };
  await wsBridge.handleWsMessage({
    type: "download",
    url: "https://supjav.com/452555.html",
    sources: [
      { kind: "link", url: "https://supjav.com/452555.html", label: "" },
      { kind: "iframe", url: "https://supjav.com/x/supjav.php?l=ABC123", label: "" }
    ]
  }, { dm: dm3Hook, gatherCookieHeader: async () => "", send: (o) => sendM3.push(o) });
  const acceptedM3 = sendM3.find((o) => o.type === "accepted");
  assert("M3 batch skips movie page, accepts player", !!acceptedM3 && Array.isArray(acceptedM3.ids) && acceptedM3.ids.length === 1, "accepted=" + JSON.stringify(acceptedM3));
  const sentM3B = [];
  await wsBridge.handleWsMessage({
    type: "download",
    sources: [{ kind: "link", url: "https://supjav.com/452555.html", label: "" }]
  }, { dm: dm3Hook, gatherCookieHeader: async () => "", send: (o) => sentM3B.push(o) });
  const errM3 = sentM3B.find((o) => o.type === "error");
  assert("M3 all-blocked batch sends actionable error", !!errM3 && /[Cc]loudflare/.test(errM3.message), "err=" + (errM3 && errM3.message));

  // ---- O: crawl throttle (burst passes, sustained crawls capped) ----
  console.log("\n-- O: crawl throttle --");
  const { makeCrawlThrottle } = require("./lib/ws-bridge");
  const t0 = 1000000;
  const th = makeCrawlThrottle();
  assert("O cold burst passes (10 in 2s)", [0, 100, 200, 300, 400, 500, 600, 700, 800, 900]
    .every((d) => !th(t0 + d)), "burst throttled");
  assert("O idle reset allows a new burst", [t0 + 30000 + 0, t0 + 30000 + 50]
    .every((d) => !th(d)), "2nd burst throttled");
  const th2 = makeCrawlThrottle();
  const res = [];
  for (let i = 0; i < 30; i++) res.push(th2(t0 + i * 500));
  assert("O first 8s passes", res.slice(0, 16).every((r) => r === false), "early burst");
  assert("O sustained dribble becomes throttled", res.slice(24, 30).some((r) => r === true), "dribble never throttled: " + res.join(","));
  const th3 = makeCrawlThrottle({ sustainedPerMin: 8 });
  assert("O sustainedPerMin honored (only >8 in window throttled)", th3(t0 + 1) === false && th3(t0 + 60000) === false, "cfg ignored");

  // ---- P: dotless-host junk (word-hash crawl URLs like https://Mouth) ----
  console.log("\n-- P: dotless-host junk --");
  const { isJunkHost } = require("./downloader");
  assert("P dotless host junk", isJunkHost("https://Mouth"));
  assert("P dotless host junk 2", isJunkHost("http://That/video"));
  assert("P real host kept", !isJunkHost("https://sextb.net/oba-031-rm"));
  assert("P lowercase real host kept", !isJunkHost("https://streamtape.com/v/abc/"));
  assert("P loopback kept", !isJunkHost("http://127.0.0.1:8080/x.m3u8"));
  assert("P localhost kept", !isJunkHost("http://localhost:8765"));
  const dmPathP = require.resolve("./downloader");
  delete require.cache[dmPathP];
  const { DownloadManager: DMP } = require("./downloader");
  const dmp = new DMP({ config, proxyManager: new ProxyManager(config), onUpdate: () => {} });
  try { await dmp.enqueue({ url: "https://Mouth", title: "e2e-junkhost" }); assert("P enqueue rejects dotless host", false, "no error"); }
  catch (e) { assert("P enqueue rejects dotless host", /Unsupported URL/.test(e.message), e.message); }
  delete require.cache[dmPathP];

  // ---- P0: isJunkUrl (dev/portal hosts, 0.0.0.N residuals, group-list paths) ----
  console.log("\n-- P0: isJunkUrl --");
  const { isJunkUrl } = require("./downloader");
  const junkUrls = [
    "https://github.com/tashfeenahmed/freellmapi/releases/tag/v0.9.2",
    "https://ai.google.dev/gemini-api/docs/pricing",
    "https://aistudio.google.com/projects",
    "https://policies.google.com/privacy",
    "https://mail.google.com/mail/u/0/?ogbl#inbox",
    "https://www.firecrawl.dev/signin?x=1",
    "https://my.jdownloader.org/",
    "https://violentmonkey.github.io/",
    "https://webextension.org/",
    "https://www.internetdownloadmanager.com/",
    "https://www.vn-zoom.com/",
    "https://supjav.com/category/cast/itou-mayuki/page/5",
    "https://1", "https://5"
  ];
  for (const ju of junkUrls) assert("P0 junk rejected: " + ju, isJunkUrl(ju), "accepted junk");
  const legitUrls = [
    "https://supjav.com/452555.html",
    "https://supjav.com/supjav.php?l=abc",
    "https://streamtape.com/get_video?id=DCV221&expires=1&token=aaa",
    "https://surrit.com/abc/playlist.m3u8?token=t1",
    "https://fourhoi.com/dldss-468/preview.mp4",
    "https://missav.ws/en/mkmp-537-uncensored-leak",
    "https://lk1.supremejav.com/452555",
    "https://sextb.net/en/abc-123.html",
    "https://127.0.0.1:8765/x",
    "https://cdn.example.com/x/abc.mp4"
  ];
  for (const lu of legitUrls) assert("P0 legit kept: " + lu, !isJunkUrl(lu), "rejected legit");

  // ---- P1: titleFromUrl auto-titles for bulk pastes ----
  // Export-shape pins FIRST: the 1.3.7 crash class was downloader.js calling a
  // destructured titleFromUrl that lib/names.js did not yet export (TypeError
  // at the effectiveTitle line, only on empty-title enqueues). If names.js ever
  // drops/renames an export downloader relies on, these typeof asserts fail
  // loudly at test time instead of throwing later on a live enqueue path.
  console.log("\n-- P1: titleFromUrl (export shape + behavior) --");
  const namesApi = require("./lib/names");
  assert("P1 names exports sanitizeName fn", typeof namesApi.sanitizeName === "function", typeof namesApi.sanitizeName);
  assert("P1 names exports titleFromReferer fn", typeof namesApi.titleFromReferer === "function", typeof namesApi.titleFromReferer);
  assert("P1 names exports titleFromUrl fn", typeof namesApi.titleFromUrl === "function", typeof namesApi.titleFromUrl);
  const { titleFromUrl } = namesApi;
  assert("P1 slug title", titleFromUrl("https://sextb.net/video/abc-123/") === "abc 123", titleFromUrl("https://sextb.net/video/abc-123/"));
  assert("P1 movie slug", titleFromUrl("https://missav.ws/en/mkmp-537-uncensored-leak") === "mkmp 537 uncensored leak", titleFromUrl("https://missav.ws/en/mkmp-537-uncensored-leak"));
  assert("P1 mp4 stem", titleFromUrl("https://fourhoi.com/dldss-468/preview.mp4") === "preview", titleFromUrl("https://fourhoi.com/dldss-468/preview.mp4"));
  assert("P1 media ext with query stripped", titleFromUrl("https://cdn.example/x/clip.m3u8?token=t1") === "clip", titleFromUrl("https://cdn.example/x/clip.m3u8?token=t1"));
  assert("P1 generic seg falls back to host", titleFromUrl("https://supjav.com/x/supjav.php?l=ABC123") === "supjav.com", titleFromUrl("https://supjav.com/x/supjav.php?l=ABC123"));
  assert("P1 skip seg (watch) falls back to host", titleFromUrl("https://x.com/watch") === "x.com", titleFromUrl("https://x.com/watch"));
  assert("P1 root path falls back to host", titleFromUrl("https://x.com") === "x.com", titleFromUrl("https://x.com"));
  assert("P1 percent-encoded slug decoded", titleFromUrl("https://x.com/mkmp%20537") === "mkmp 537", titleFromUrl("https://x.com/mkmp%20537"));
  assert("P1 malformed URL yields empty title", titleFromUrl("not a url") === "", titleFromUrl("not a url"));

  // ---- P2: engine module export-shape contract ----
  // downloader.js destructures exactly these names from its lib modules
  // (require lines 17-22). The 1.3.7 titleFromUrl crash was a destructured
  // name the module did not export - any future drop/rename/ret-type fails
  // loudly here instead of throwing later on a live enqueue path.
  console.log("-- P2: downloader lib import contract --");
  const modErrors = require("./lib/errors");
  const modHttp = require("./lib/http");
  const modHls = require("./lib/hls");
  const modNames = require("./lib/names");
  const modResolvers = require("./lib/resolvers");
  const modUrls = require("./lib/urls");
  const P2_TABLE = [
    [modErrors, "errors", "fn", ["isExpiredError","isProxyFailure","isRateLimited","isCloudflareBlocked","categorizeError","isHtmlContentType","looksLikeHtmlHead","notVideoError"]],
    [modHttp, "http", "fn", ["requestWithRedirects","fetchHtml","delay","contentRangeStart","contentRangeTotal"]],
    [modHttp, "http", "number", ["DEFAULT_MAX_RETRIES"]],
    [modHls, "hls", "fn", ["isHlsUrl","parseHlsPlaylist","pickHlsVariant","pickHlsVariants","isIFrameOnlyPlaylist","stripPngPrefix","matchHlsMaster","isAdSegmentUrl"]],
    [modHls, "hls", "regexp", ["HLS_MASTER_RE","QUALITY_DIR_RE"]],
    [modNames, "names", "fn", ["sanitizeName","titleFromReferer","titleFromUrl"]],
    [modResolvers, "resolvers", "fn", ["resolveUrl","resolveStreamtape","resolveSupjav","resolveCnPorn","resolveXVideos","resolveXHamster","isCfwalledSupjavMovie"]],
    [modResolvers, "resolvers", "regexp", ["SJ_PLAYER_RE"]],
    [modUrls, "urls", "fn", ["unwrapExtensionUrl"]]
  ];
  for (const [m, mn, ty, lst] of P2_TABLE) {
    for (const n of lst) {
      const v = m[n];
      const ok = ty === "fn" ? typeof v === "function" : ty === "regexp" ? v instanceof RegExp : typeof v === "number";
      assert("P2 " + mn + " exports " + n + " (" + ty + ")", ok, typeof v);
    }
  }

  // ---- P3: main.js module export-shape contract ----
  // main.js destructures exactly these names from downloader.js, proxy.js and
  // config.js (require lines 13-17). Same drift guard as P2, for the main-
  // process boundary: a dropped/renamed/ret-typed export fails here loudly.
  console.log("-- P3: main.js import contract --");
  const modDownloader = require("./downloader");
  const modProxy = require("./proxy");
  const modConfig = require("./config");
  const P3_TABLE = [
    [modDownloader, "downloader", "fn", ["DownloadManager", "requestWithRedirects"]],
    [modProxy, "proxy", "fn", ["ProxyManager"]],
    [modConfig, "config", "object", ["DEFAULT_CONFIG"]],
    [modConfig, "config", "fn", ["loadConfig", "saveConfig", "validateConfig"]]
  ];
  for (const [m, mn, ty, lst] of P3_TABLE) {
    for (const n of lst) {
      const v = m[n];
      const ok = ty === "fn" ? typeof v === "function" : ty === "object" ? typeof v === "object" && v !== null : v instanceof RegExp;
      assert("P3 " + mn + " exports " + n + " (" + ty + ")", ok, typeof v);
    }
  }

  // ---- P4: extension background drift (isAdUrl / isJunkUrl) ----
  // background.js hand-maintains AD_DOMAINS and isJunkUrl that content.js and
  // downloader.js also define. Both sides must reject the same hosts; the
  // 2026-09-03 supjav ad-network hosts landed in content.js only and leaked
  // through background's webRequest capture until aligned. Guards that drift.
  console.log("-- P4: extension background contract --");
  const fs4 = require("fs");
  const contentSrc4 = fs4.readFileSync("extension/content.js", "utf8");
  const bgSrc4 = fs4.readFileSync("extension/background.js", "utf8");
  const adMarker4 = "const AD_DOMAINS = ";
  const iAdC4 = contentSrc4.indexOf(adMarker4);
  const iAdB4 = bgSrc4.indexOf(adMarker4);
  const litC4 = iAdC4 >= 0 ? contentSrc4.slice(iAdC4 + adMarker4.length, contentSrc4.indexOf(";", iAdC4)) : "";
  const litB4 = iAdB4 >= 0 ? bgSrc4.slice(iAdB4 + adMarker4.length, bgSrc4.indexOf(";", iAdB4)) : "";
  assert("P4 content.js AD_DOMAINS literal found", litC4.length > 10, "len " + litC4.length);
  assert("P4 background.js AD_DOMAINS literal found", litB4.length > 10, "len " + litB4.length);
  assert("P4 AD_DOMAINS literals identical (content == background)", litC4 === litB4, "content=" + litC4.length + " bg=" + litB4.length);
  // Load background.js as a service worker under a chrome stub so its real
  // isJunkUrl / isAdUrl run against the same corpus as the engine copies.
  const chromeStub4 = {
    storage: { local: { get: function () {}, set: function () { return Promise.resolve(); } } },
    runtime: { sendMessage: function () { return Promise.resolve(); }, onMessage: { addListener: function () {} }, onInstalled: { addListener: function () {} }, onStartup: { addListener: function () {} } },
    action: { onClicked: { addListener: function () {} } },
    tabs: {}, tabGroups: {}, windows: {}, cookies: {},
    webRequest: { onBeforeRequest: { addListener: function () {} }, onHeadersReceived: { addListener: function () {} } }
  };
  function WsStub4() {}
  WsStub4.OPEN = 1; WsStub4.CONNECTING = 0; WsStub4.CLOSING = 2; WsStub4.CLOSED = 3;
  let bgApi4 = null;
  try {
    const bgFactory4 = new Function("chrome", "WebSocket", "self", "console",
      bgSrc4 + "\n;return { isJunkUrl: isJunkUrl, isAdUrl: isAdUrl };");
    bgApi4 = bgFactory4(chromeStub4, WsStub4, {}, console);
    assert("P4 background.js loads under chrome stub", !!bgApi4 && typeof bgApi4.isJunkUrl === "function", "load failed");
  } catch (e) {
    assert("P4 background.js loads under chrome stub", false, e.message);
  }
  if (bgApi4) {
    const contentAd4 = new Function("return " + litC4)();
    const adHosts4 = ["eix304.com", "tapioni.com", "mnaspm.com", "mayzaent.com", "googletagmanager.com", "www.googletagmanager.com", "djsalcbhew47.lol", "doubleclick.net", "adsterra.com", "googlesyndication.com"];
    for (const h of adHosts4) {
      assert("P4 ad host rejected by content+background: " + h,
        contentAd4.test(h) && bgApi4.isAdUrl("https://" + h + "/x"),
        "content=" + contentAd4.test(h) + " bg=" + bgApi4.isAdUrl("https://" + h + "/x"));
    }
    const legitAd4 = ["supjav.com", "streamtape.com", "tiktokcdn.com", "cdn.example.com", "surrit.com"];
    for (const h of legitAd4) {
      assert("P4 legit host not an ad: " + h,
        !contentAd4.test(h) && !bgApi4.isAdUrl("https://" + h + "/x"),
        "content=" + contentAd4.test(h) + " bg=" + bgApi4.isAdUrl("https://" + h + "/x"));
    }
    // Host-level junk parity only: the engine also rejects supjav/sextb
    // group-LISTING paths that the browser never captures (not video-shaped),
    // so those URLs legitimately differ and are not in the corpus.
    const { isJunkUrl: dlJunk4 } = require("./downloader");
    const junkUrls4 = ["https://github.com/user/repo", "https://accounts.google.com/signin", "https://ai.google.dev/aistudio", "https://firecrawl.dev/signin", "https://www.jdownloader.org/", "https://violentmonkey.github.io/", "https://webextension.org/", "https://www.internetdownloadmanager.com/", "https://www.vn-zoom.com/", "https://en.wikipedia.org/wiki/JAV", "https://1", "https://Mouth"];
    for (const u of junkUrls4) {
      assert("P4 bg+engine both reject: " + u,
        bgApi4.isJunkUrl(u) === true && dlJunk4(u) === true,
        "bg=" + bgApi4.isJunkUrl(u) + " dl=" + dlJunk4(u));
    }
    const legitUrls4 = ["https://supjav.com/452555.html", "https://supjav.com/supjav.php?l=ABC123", "https://streamtape.com/get_video?id=DCV221", "https://surrit.com/abc/playlist.m3u8", "https://fourhoi.com/dldss-468/preview.mp4", "https://missav.ws/en/mkmp-537-uncensored-leak", "https://sextb.net/en/abc-123.html", "https://127.0.0.1:8765/x", "https://www.supremejav.com/452555"];
    // bare localhost is dotless, so BOTH guards reject it today; pin parity, not the value.
    assert("P4 bg+engine parity on bare localhost",
      bgApi4.isJunkUrl("http://localhost:8765/x") === dlJunk4("http://localhost:8765/x"),
      "bg=" + bgApi4.isJunkUrl("http://localhost:8765/x") + " dl=" + dlJunk4("http://localhost:8765/x"));
    for (const u of legitUrls4) {
      assert("P4 bg+engine both accept: " + u,
        bgApi4.isJunkUrl(u) === false && dlJunk4(u) === false,
        "bg=" + bgApi4.isJunkUrl(u) + " dl=" + dlJunk4(u));
    }
  }

  // ---- P5: preload / renderer IPC contract ----
  // Every window.api.<method> a renderer file calls must exist in the preload
  // it runs under, and every ipc channel a preload touches must have an ipcMain
  // handler in main.js. A dropped expose / on-handler would otherwise surface
  // only as not-a-function when the user clicks that control.
  console.log("-- P5: window.api + IPC channel contract --");
  const fs5 = require("fs");
  const preloadSrc5 = fs5.readFileSync("preload.js", "utf8");
  const browserPreloadSrc5 = fs5.readFileSync("browser-preload.js", "utf8");
  const mainSrc5 = fs5.readFileSync("main.js", "utf8");
  const rendererSrc5 = fs5.readFileSync("renderer.js", "utf8");
  const browserHtmlSrc5 = fs5.readFileSync("browser.html", "utf8");
  const isIdent5 = (ch) => {
    const c = ch.charCodeAt(0);
    return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || ch === "_" || ch === "$";
  };
  const apiKeysOf5 = (src) => {
    const out = [];
    const mk = "exposeInMainWorld(\"api\", {";
    let a = src.indexOf(mk);
    if (a < 0) return out;
    a += mk.length;
    const close = src.indexOf("});", a);
    if (close < 0) return out;
    const body = src.slice(a, close).split("\n");
    for (const ln of body) {
      const t = ln.trim();
      const colon = t.indexOf(":");
      if (colon <= 0) continue;
      const k = t.slice(0, colon);
      if (k.length && Array.prototype.every.call(k, isIdent5)) out.push(k);
    }
    return out;
  };
  const apiUsesOf5 = (src) => {
    const out = [];
    const mk = "window.api.";
    let a = 0;
    while ((a = src.indexOf(mk, a)) !== -1) {
      let b = a + mk.length;
      let name = "";
      while (b < src.length && isIdent5(src[b])) { name += src[b]; b++; }
      if (name) out.push(name);
      a = b;
    }
    return out;
  };
  const channelsOf5 = (src, needle) => {
    if (needle.slice(-2) === '("') needle = needle.slice(0, -2);
    const out = [];
    let a = 0;
    while ((a = src.indexOf(needle, a)) !== -1) {
      const q = src.indexOf("\"", a + needle.length);
      if (q !== -1) {
        const e = src.indexOf("\"", q + 1);
        if (e !== -1) out.push(src.slice(q + 1, e));
        a = e + 1;
      } else { a = a + needle.length; }
    }
    return out;
  };
  const uniq5 = (arr) => Array.from(new Set(arr));
  const preloadKeys5 = apiKeysOf5(preloadSrc5);
  const browserKeys5 = apiKeysOf5(browserPreloadSrc5);
  assert("P5 preload.js exposes api methods", preloadKeys5.length >= 20, "count " + preloadKeys5.length);
  assert("P5 browser-preload.js exposes api methods", browserKeys5.length >= 15, "count " + browserKeys5.length);
  for (const u of uniq5(apiUsesOf5(rendererSrc5))) {
    assert("P5 renderer.js uses exposed api." + u, preloadKeys5.indexOf(u) !== -1, "missing from preload.js");
  }
  for (const u of uniq5(apiUsesOf5(browserHtmlSrc5))) {
    assert("P5 browser.html uses exposed api." + u, browserKeys5.indexOf(u) !== -1, "missing from browser-preload.js");
  }
  const reqOf5 = (src) => uniq5(channelsOf5(src, "ipcRenderer.invoke(\"").concat(channelsOf5(src, "ipcRenderer.send(\"")));
  const onOf5 = (src) => uniq5(channelsOf5(src, "ipcRenderer.on(\""));
  const preloadReq5 = reqOf5(preloadSrc5);
  const browserReq5 = reqOf5(browserPreloadSrc5);
  const allOn5 = uniq5(onOf5(preloadSrc5).concat(onOf5(browserPreloadSrc5)));
  // Handlers were extracted to lib/ipc.js (registerIpc(ctx)); scan both
  // files so a moved registration still satisfies the contract.
  const ipcSrc5 = fs5.existsSync("lib/ipc.js") ? fs5.readFileSync("lib/ipc.js", "utf8") : "";
  const mainCh5 = uniq5(channelsOf5(mainSrc5, "ipcMain.handle(\"").concat(channelsOf5(mainSrc5, "ipcMain.on(\""))
    .concat(channelsOf5(ipcSrc5, "ipcMain.handle(\"")).concat(channelsOf5(ipcSrc5, "ipcMain.on(\"")));
  for (const c of preloadReq5.concat(browserReq5)) {
    assert("P5 ipc channel handled in main.js: " + c, mainCh5.indexOf(c) !== -1, "no ipcMain handler found");
  }
  const mainPush5 = uniq5(channelsOf5(mainSrc5, "webContents.send(\"").concat(channelsOf5(fs5.readFileSync("lib/browser.js", "utf8"), "webContents.send(\"")));
  for (const c of mainPush5) {
    assert("P5 push channel listened in a preload: " + c, allOn5.indexOf(c) !== -1, "no ipcRenderer.on listener");
  }
  for (const c of allOn5) {
    assert("P5 preload listener has a sender in main.js: " + c, mainPush5.indexOf(c) !== -1, "no webContents.send sender");
  }
  delete require.cache[require.resolve("./downloader")];

  // ---- Q: ffmpeg discovery (fallback when "ffmpeg" is not on PATH) ----
  console.log("\n-- Q: ffmpeg discovery --");
  const { findFfmpeg } = require("./downloader");
  const jf = "C:\\Program Files\\JavLuv\\ffmpeg.exe";
  assert("Q resolves bogus configured path via fallback", findFfmpeg({ ffmpegPath: "totally/missing/ffmpeg.exe" }) !== null, "no fallback found");
  assert("Q preferred working config value wins or fallback still resolves", findFfmpeg({ ffmpegPath: jf }) === jf || findFfmpeg({ ffmpegPath: jf }) !== null, "config value unused");
  const found = findFfmpeg({ ffmpegPath: "totally/missing/ffmpeg.exe" });
  const { spawnSync } = require("child_process");
  const ver = spawnSync(found, ["-version"], { stdio: "ignore" });
  assert("Q resolved path really spawns ffmpeg", !ver.error && ver.status === 0, "resolved ffmpeg does not spawn");
  const dmPathQ = require.resolve("./downloader");
  delete require.cache[dmPathQ];
  const { DownloadManager: DMQ } = require("./downloader");
  const dmq = new DMQ({ config: { ffmpegPath: "totally/missing/ffmpeg.exe" }, proxyManager: new ProxyManager(config), onUpdate: () => {} });
  assert("Q manager cache finds a real ffmpeg", dmq._resolveFfmpeg() !== null, "manager ffmpeg null");
  delete require.cache[dmPathQ];

  // ---- S: ad-polluted HLS playlists (tiktokcdn ad-image segments) ----
  console.log("\n-- S: ad-polluted HLS rejection + mixed-stream filtering --");
  const dmPathS = require.resolve("./downloader");
  delete require.cache[dmPathS];
  const { DownloadManager: DMS, isAdSegmentUrl: isAdSeg } = require("./downloader");
  assert("S ad-site tiktokcdn host detected",
    isAdSeg("https://p16-ad-site-sign-sg.tiktokcdn.com/ad-site-i18n-sg/a~tplv-d5opwmad15-ttam-origin.image"));
  assert("S .image shaped URL detected", isAdSeg("http://cdn.example/ad-inject/thing.webp"));
  assert("S real signed tiktokcdn .ts kept", !isAdSeg("https://v16-webapp-sign-sg.tiktokcdn.com/vod/video/seg.ts"));
  assert("S real .m4s kept", !isAdSeg("http://cdn.example/hls/stream-0.m4s"));
  const dms = new DMS({ config, proxyManager: new ProxyManager(config), onUpdate: () => {} });
  server._dvHits = [];
  try {
    const id = await dms.enqueue({ url: base + "/ad/allad.m3u8", title: "e2e-adall" });
    const it = await waitFor(dms, id, 30000);
    assert("S all-ad playlist errors with ad-polluted message",
      it && it.status === "error" && /ad-images/.test(it.error || ""),
      "status=" + (it && it.status) + " err=" + (it && it.error));
    assert("S all-ad playlist fetches ZERO ad segments",
      !server._dvHits.some((h) => h.indexOf("/adseg") !== -1), server._dvHits.join(","));
  } catch (e) { assert("S all-ad enqueue", false, e.message); }
  if (!ff) skip("S mixed playlist download", "no ffmpeg");
  else {
    server._dvHits = [];
    try {
      const id = await dms.enqueue({ url: base + "/ad/mixed.m3u8", title: "e2e-admix" });
      const it = await waitFor(dms, id, 40000);
      assert("S mixed playlist downloads OK", it && it.status === "done",
        "status=" + (it && it.status) + " err=" + (it && it.error));
      assert("S mixed fetched only real segments + no ads",
        server._dvHits.indexOf("/seg0.ts") !== -1 && server._dvHits.indexOf("/seg1.ts") !== -1 &&
        !server._dvHits.some((h) => h.indexOf("/adseg") !== -1), server._dvHits.join(","));
      assert("S mixed final mp4 exists", it && it.finalPath && fs.existsSync(it.finalPath) && fs.statSync(it.finalPath).size > 0, it && it.finalPath);
    } catch (e) { assert("S mixed enqueue", false, e.message); }
  }
  delete require.cache[dmPathS];

  // ---- T: fetchHtml caps oversized responses instead of crashing main ----
  console.log("\n-- T: fetchHtml oversized-response cap --");
  const { fetchHtml: bigFetch } = require("./lib/http");
  const bigServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const timer = setInterval(() => {
      try { res.write(chunk); } catch (e) { clearInterval(timer); }
    }, 10);
    res.on("error", () => clearInterval(timer));
    res.on("close", () => clearInterval(timer));
  });
  await new Promise((res) => bigServer.listen(0, "127.0.0.1", res));
  const bigPort = bigServer.address().port;
  try {
    const err = await bigFetch("http://127.0.0.1:" + bigPort + "/", null, {}, 0, 1);
    assert("T oversized fetch rejects cleanly", false, "resolved instead of rejecting");
  } catch (e) {
    assert("T oversized fetch rejects cleanly", !!e && e.status === 413, e && e.message);
  } finally {
    bigServer.close();
  }

  // ---- U: cookie bridge (extension-supplied cookieHeader passes through to dm.enqueue) ----
  console.log("\n-- U: cookie bridge --");
  {
    const dmPathU = require.resolve("./downloader");
    delete require.cache[dmPathU];
    const { DownloadManager: DMU } = require("./downloader");
    const { WebSocketServer } = require("ws");
    const dmU = new DMU({ config, proxyManager: new ProxyManager(config), onUpdate: () => {} });
    const wssU = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const responses = [];
    wssU.on("connection", (ws) => {
      ws.on("message", async (data) => {
        let msg; try { msg = JSON.parse(data.toString()); } catch (e) { return; }
        try {
          await wsBridge.handleWsMessage(msg, {
            dm: dmU,
            gatherCookieHeader: async () => "fallback=1",
            probeUrl: async () => ({ size: 0 }),
            send: (o) => { try { ws.send(JSON.stringify(o)); } catch (e) {} }
          });
        } catch (e) {}
      });
    });
    await new Promise((r) => wssU.on("listening", r));
    const wsPort = wssU.address().port;
    const client = new WebSocket("ws://127.0.0.1:" + wsPort);
    await new Promise((r) => client.on("open", r));
    client.on("message", (d) => { try { responses.push(JSON.parse(d.toString())); } catch (e) {} });
    client.send(JSON.stringify({ type: "download", url: base + "/hup/master.m3u8", title: "e2e-cookie", referer: base, cookieHeader: "session=abc" }));
    await waitForCondition(() => responses.some((x) => x.type === "accepted"), 10000);
    const acceptedMsg = responses.find((x) => x.type === "accepted");
    const it = acceptedMsg && dmU.items.get(acceptedMsg.id);
    assert("U cookieHeader passed through to enqueue", it && it.cookieHeader === "session=abc", JSON.stringify(it ? it.cookieHeader : null));
    responses.length = 0;
    client.send(JSON.stringify({ type: "download", url: base + "/hup/master.m3u8", title: "e2e-cookie-fallback", referer: base }));
    await waitForCondition(() => responses.some((x) => x.type === "accepted"), 10000);
    const acceptedMsg2 = responses.find((x) => x.type === "accepted");
    const it2 = acceptedMsg2 && dmU.items.get(acceptedMsg2.id);
    assert("U no cookieHeader -> gatherCookieHeader fallback", it2 && it2.cookieHeader === "fallback=1", JSON.stringify(it2 ? it2.cookieHeader : null));
    client.close(); wssU.close();
  }

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\n=== " + passed + " passed, " + failed + " failed, " + skipped + " skipped ===\n");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
