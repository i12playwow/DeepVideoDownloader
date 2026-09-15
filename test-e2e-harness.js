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

    // a) the download message the extension actually sends. A per-request id is
    // echoed back so a response correlates to the exact request even when the
    // same URL is re-sent (family-dedupe / retry mis-route protection).
    const reqId = "e2e-req-" + Date.now();
    client.send(JSON.stringify({ type: "download", reqId, url: base + "/playlist.ws.m3u8", title: "e2e-ws", referer: base, sources: [{ kind: "link", url: base + "/playlist.ws.m3u8", label: "" }] }));
    const accepted = await (async () => {
      const ok = await waitForCondition(() => responses.some((x) => x.type === "accepted"), 10000);
      return ok ? responses.find((x) => x.type === "accepted") : null;
    })();
    assert("E WS accepted response with id", accepted && Array.isArray(accepted.ids) && accepted.ids.length === 1, JSON.stringify(accepted));
    assert("E accepted echoes reqId", accepted && accepted.reqId === reqId, "reqId=" + (accepted && accepted.reqId));
    if (accepted) {
      const it = await waitFor(dm, accepted.ids[0], 40000);
      assert("E WS download completes (status=done)", it && it.status === "done", it && it.status);
      assert("E final mp4 non-empty", it && it.finalPath && fs.existsSync(it.finalPath) && fs.statSync(it.finalPath).size > 0, it && it.finalPath);
      // the enqueued item carries the request id (echoed by status pushes)
      assert("E enqueued item stores reqId", it.reqId === reqId, "item.reqId=" + (it && it.reqId));
    }
    // b) ping/pong + error branches + probe reqId echo
    client.send(JSON.stringify({ type: "ping", reqId }));
    const gotPong = await waitForCondition(() => responses.some((x) => x.type === "pong"), 5000);
    assert("E ping -> pong", gotPong);
    const pong = responses.find((x) => x.type === "pong");
    assert("E pong echoes reqId", pong && pong.reqId === reqId, "pong.reqId=" + (pong && pong.reqId));
    client.send(JSON.stringify({ type: "download", reqId }));
    const gotErr = await waitForCondition(() => responses.some((x) => x.type === "error" && x.code === "NO_USABLE_SOURCE"), 5000);
    assert("E empty download -> NO_USABLE_SOURCE error", gotErr);
    const err = responses.find((x) => x.type === "error" && x.code === "NO_USABLE_SOURCE");
    assert("E error echoes reqId", err && err.reqId === reqId, "error.reqId=" + (err && err.reqId));
    assert("E error carries structured envelope", err && err.message === "No usable source" && err.retryable === false && err.retryAfter == null,
      JSON.stringify(err));
    client.send(JSON.stringify({ type: "probe", reqId, url: base + "/playlist.ws.m3u8" }));
    const gotPr = await waitForCondition(() => responses.some((x) => x.type === "probe-result"), 5000);
    assert("E probe -> probe-result", gotPr);
    const pr = responses.find((x) => x.type === "probe-result");
    assert("E probe-result echoes reqId", pr && pr.reqId === reqId, "probe-result.reqId=" + (pr && pr.reqId));

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

  // ---- V: WS protocol handshake (protocolVersion) ----
  // The app refuses a client that claims a NEWER wire protocol than it
  // implements, but keeps older and legacy (no protocolVersion) clients working.
  console.log("-- V: WS protocol version handshake --");
  const comp = (cv) => wsBridge.isProtocolCompatible(cv);
  assert("V PROTOCOL_VERSION exported", Number.isInteger(wsBridge.PROTOCOL_VERSION) && wsBridge.PROTOCOL_VERSION >= 1, "v=" + wsBridge.PROTOCOL_VERSION);
  assert("V legacy client (no protocolVersion) accepted", comp(undefined), "undefined");
  assert("V empty-string protocolVersion accepted as legacy", comp(""), "empty string");
  assert("V same version accepted", comp(wsBridge.PROTOCOL_VERSION), "equal");
  // The current protocol is v1, so no positive older version exists yet; the
  // branch still runs once a future bump makes PROTOCOL_VERSION - 1 valid.
  if (wsBridge.PROTOCOL_VERSION > 1) {
    assert("V older version accepted", comp(wsBridge.PROTOCOL_VERSION - 1), "older");
  } else {
    assert("V older version accepted (none below v1 yet)", true, "skip - v1 is the floor");
  }
  assert("V numeric string version accepted", comp(String(wsBridge.PROTOCOL_VERSION)), "numeric string");
  assert("V newer version rejected", !comp(wsBridge.PROTOCOL_VERSION + 1), "newer");
  assert("V much newer version rejected", !comp(999), "999");
  assert("V non-numeric version rejected", !comp("abc"), "abc");
  assert("V negative version rejected", !comp(-1), "negative");

  // ---- V2: structured error envelope (errorReply + ERROR_CODES) ----
  // Every error reply must carry the closed code set + retryable flag; the flat
  // legacy shape ({message, url}) is gone from ws-bridge/main.js replies.
  console.log("-- V2: structured error envelope --");
  const er = wsBridge.errorReply(wsBridge.ERROR_CODES.NO_USABLE_SOURCE, "No usable source", { url: "u", reqId: "r1" });
  assert("V2 errorReply builds type/code/message/url", er.type === "error" && er.code === "NO_USABLE_SOURCE" && er.message === "No usable source" && er.url === "u", JSON.stringify(er));
  assert("V2 errorReply defaults retryable=false, no retryAfter", er.retryable === false && er.retryAfter == null, JSON.stringify(er));
  assert("V2 errorReply echoes reqId", er.reqId === "r1", JSON.stringify(er));
  const erPace = wsBridge.errorReply(wsBridge.ERROR_CODES.PACE_LIMITED, "Pace limit", { retryable: true, retryAfter: 60 });
  assert("V2 PACE_LIMITED is retryable with retryAfter=60", erPace.retryable === true && erPace.retryAfter === 60, JSON.stringify(erPace));
  assert("V2 closed code set exported", typeof wsBridge.ERROR_CODES === "object" &&
    ["NO_USABLE_SOURCE", "CLOUDFLARE_CHALLENGED", "ENQUEUE_FAILED", "PACE_LIMITED", "PROTOCOL_MISMATCH", "INTERNAL"]
      .every((c) => wsBridge.ERROR_CODES[c] === c), JSON.stringify(wsBridge.ERROR_CODES));

  // ---- V3: status push builder (errorCode + retryable vs engine transient rules) ----
  // isTransientError (lib/status.js) is the single owner of the transient
  // rule: downloader.js's pump catch calls it to decide auto-requeue, and
  // main.js's statusPayload calls it for the push's retryable flag. This
  // table pins that shared rule; test-download-features.js pins it through
  // the engine (5xx requeues, errorStatus threading).
  console.log("-- V3: status push builder --");
  const { statusPayload, isTransientError, errorCodeFor } = require("./lib/status");
  const v3cases = [
    // [category, httpStatus, expected retryable, expected errorCode]
    ["network", 0, true, "NETWORK"],
    ["rate-limited", 0, true, "RATE_LIMITED"],
    ["blocked", 0, true, "BLOCKED"],
    ["http", 500, true, "HTTP"],
    ["http", 502, true, "HTTP"],
    ["http", 503, true, "HTTP"],
    ["http", 599, true, "HTTP"],
    ["http", 499, false, "HTTP"],
    ["http", 404, false, "HTTP"],
    ["http", 0, false, "HTTP"],
    ["expired", 0, false, "EXPIRED"],
    ["not-video", 0, false, "NOT_VIDEO"],
    ["requires-browser", 0, false, "REQUIRES_BROWSER"],
    ["norange", 0, false, "NORANGE"],
    ["", 0, false, ""],
    [undefined, 0, false, ""]
  ];
  for (const [cat, st, wantRetryable, wantCode] of v3cases) {
    const label = cat || "(none)";
    assert("V3 " + label + "/" + st + " retryable=" + wantRetryable, isTransientError(cat, st) === wantRetryable, "got " + isTransientError(cat, st));
    assert("V3 " + label + " errorCode=" + wantCode, errorCodeFor(cat) === wantCode, "got " + errorCodeFor(cat));
  }
  // statusPayload: full shape, reqId echo, errorStatus passthrough, and the
  // same engine rule applied end-to-end (500 retryable, 404 not).
  const v3base = { id: "i1", reqId: "r9", url: "http://x/a.mp4", label: "", fileName: "a.mp4", status: "error", total: 0, received: 0, speed: 0, proxy: "", error: "boom", errorCategory: "http", errorStatus: 503, resolving: false, refreshCount: 0, finalPath: "", thumb: "" };
  const p503 = statusPayload(v3base);
  assert("V3 payload http/503 retryable", p503.retryable === true, JSON.stringify(p503));
  assert("V3 payload errorCode HTTP + errorStatus passthrough", p503.errorCode === "HTTP" && p503.errorStatus === 503, JSON.stringify(p503));
  assert("V3 payload reqId echo", p503.reqId === "r9", JSON.stringify(p503));
  const p404 = statusPayload({ ...v3base, errorStatus: 404 });
  assert("V3 payload http/404 NOT retryable", p404.retryable === false, JSON.stringify(p404));
  const pNet = statusPayload({ ...v3base, errorCategory: "network", errorStatus: 0 });
  assert("V3 payload network retryable regardless of status", pNet.retryable === true, JSON.stringify(pNet));
  const pOk = statusPayload({ ...v3base, status: "done", errorCategory: "", errorStatus: 0, error: "" });
  assert("V3 payload done item not retryable, no errorCode", pOk.retryable === false && pOk.errorCode === "" && pOk.errorStatus === 0, JSON.stringify(pOk));
  assert("V3 payload progress zero-guard", statusPayload({ ...v3base, total: 1000, received: 250 }).progress === 0.25, "progress");

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
  // The host core (isJunkHostUrl) and the supjav/sextb list-path rule
  // (isJunkListPath) live in extension/guards.js — shared with the extension;
  // the engine's isJunkUrl is the composition plus its fetchable-scheme gate.
  console.log("\n-- P0: isJunkUrl --");
  const { isJunkUrl } = require("./downloader");
  const guardsApi0 = require("./extension/guards.js");
  assert("P0 engine imports the shared guards core",
    typeof guardsApi0.isJunkHostUrl === "function" && typeof guardsApi0.isJunkListPath === "function",
    "guards.js core shape wrong");
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
  // Parity: the engine result must EQUAL the shared core it is composed from
  // (junk = host-core OR list-path; legit = neither), so the engine can never
  // silently disagree with the module the extension runs.
  for (const ju of junkUrls) {
    const viaGuards = guardsApi0.isJunkHostUrl(ju) || guardsApi0.isJunkListPath(ju);
    assert("P0 engine result equals guards composition: " + ju,
      isJunkUrl(ju) === true && viaGuards === true,
      "engine=" + isJunkUrl(ju) + " guards=" + viaGuards);
  }
  for (const lu of legitUrls) {
    const viaGuards = guardsApi0.isJunkHostUrl(lu) || guardsApi0.isJunkListPath(lu);
    assert("P0 engine result equals guards composition: " + lu,
      isJunkUrl(lu) === false && viaGuards === false,
      "engine=" + isJunkUrl(lu) + " guards=" + viaGuards);
  }
  // The asymmetry is deliberate: the extension's isJunkUrl (host core only)
  // skips the list-path rule — capture sees URL-shaped links, the engine is
  // the list-expansion authority. Pin it so a future "fix" that merges the
  // list-path rule into the extension gate is at least a conscious change.
  assert("P0 extension gate intentionally skips the list-path rule",
    guardsApi0.isJunkUrl("https://supjav.com/category/cast/itou-mayuki/page/5") === false,
    "extension gate now rejects list paths");

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

  // ---- P4: extension capture-guard single source (extension/guards.js) ----
  // guards.js is THE source for AD_DOMAINS/isAdUrl, ST_GETVIDEO_RE and
  // JUNK_BASE_RE/isJunkUrl: the manifest injects it before content.js and
  // background.js importScripts it (typeof-guarded for these offline evals),
  // so the service worker and the content scripts run ONE code object that
  // cannot drift (the 2026-09-03 supjav ad-host leak was exactly that drift).
  // These pins assert the wiring exists AND the shared guards still agree with
  // the engine's own copies.
  console.log("-- P4: extension capture-guard single source --");
  const fs4 = require("fs");
  const guardsSrc4 = fs4.readFileSync("extension/guards.js", "utf8");
  const contentSrc4 = fs4.readFileSync("extension/content.js", "utf8");
  const bgSrc4 = fs4.readFileSync("extension/background.js", "utf8");
  const manifest4 = JSON.parse(fs4.readFileSync("extension/manifest.json", "utf8"));
  const contentJs4 = manifest4.content_scripts.flatMap((cs) => cs.js || []);
  const gi4 = contentJs4.indexOf("guards.js");
  assert("P4 manifest injects guards.js before content.js",
    gi4 >= 0 && gi4 < contentJs4.indexOf("content.js"),
    "content_scripts js[] = " + JSON.stringify(contentJs4));
  assert("P4 background.js importScripts guards.js",
    /typeof\s+importScripts\s*===?\s*"function"\s*\)?\s*;?\s*importScripts\("guards\.js"\)/.test(bgSrc4.replace(/\r?\n/g, " ")),
    "guarded importScripts(guards.js) missing");
  assert("P4 content.js has no local AD_DOMAINS copy", !contentSrc4.includes("const AD_DOMAINS"), "drifted copy leaked back");
  assert("P4 background.js has no local AD_DOMAINS copy", !bgSrc4.includes("const AD_DOMAINS"), "drifted copy leaked back");
  // The engine is the third consumer of the same module — no local literal.
  assert("P4 downloader.js has no local JUNK_BASE_RE copy", !fs4.readFileSync("downloader.js", "utf8").includes("const JUNK_BASE_RE"), "drifted copy leaked back");
  const guardsApi4 = require("./extension/guards.js");
  assert("P4 guards.js exports the shared guard names",
    typeof guardsApi4.isAdUrl === "function" && typeof guardsApi4.isJunkUrl === "function" &&
    guardsApi4.AD_DOMAINS instanceof RegExp && guardsApi4.ST_GETVIDEO_RE instanceof RegExp,
    "require(guards.js) shape wrong");
  assert("P4 ST_GETVIDEO_RE matches streamtape get_video only",
    guardsApi4.ST_GETVIDEO_RE.test("https://streamtape.com/get_video?id=x") && !guardsApi4.ST_GETVIDEO_RE.test("https://streamtape.com/v/abc"),
    "regex shape wrong");
  // background.js expects guards.js globals (importScripts in the real SW);
  // every offline eval of its source below must mirror that wiring.
  const bgWithGuards = (src) => guardsSrc4 + "\n" + src;
  // Load background.js as a service worker under a chrome stub so its real
  // isJunkUrl / isAdUrl run against the same corpus as the engine copies.
  const chromeStub4 = {
    storage: { local: { get: function () {}, set: function () { return Promise.resolve(); } } },
    runtime: { sendMessage: function () { return Promise.resolve(); }, onMessage: { addListener: function () {} }, onInstalled: { addListener: function () {} }, onStartup: { addListener: function () {} } },
    action: { onClicked: { addListener: function () {} } },
    tabs: { onRemoved: { addListener: function () {} } }, tabGroups: {}, windows: {}, cookies: {},
    webRequest: { onBeforeRequest: { addListener: function () {} }, onHeadersReceived: { addListener: function () {} } }
  };
  function WsStub4() {}
  WsStub4.OPEN = 1; WsStub4.CONNECTING = 0; WsStub4.CLOSING = 2; WsStub4.CLOSED = 3;
  let bgApi4 = null;
  try {
    // Simulate the SW runtime: guards.js source first (as importScripts would
    // load it), then background.js in the same scope — the exact global wiring
    // the service worker gets. guards.js's module.exports block is inert here.
    const bgFactory4 = new Function("chrome", "WebSocket", "self", "console",
      guardsSrc4 + "\n" + bgSrc4 + "\n;return { isJunkUrl: isJunkUrl, isAdUrl: isAdUrl };");
    bgApi4 = bgFactory4(chromeStub4, WsStub4, {}, console);
    assert("P4 background.js loads under chrome stub with guards", !!bgApi4 && typeof bgApi4.isJunkUrl === "function", "load failed");
  } catch (e) {
    assert("P4 background.js loads under chrome stub with guards", false, e.message);
  }
  if (bgApi4) {
    const adHosts4 = ["eix304.com", "tapioni.com", "mnaspm.com", "mayzaent.com", "googletagmanager.com", "www.googletagmanager.com", "djsalcbhew47.lol", "doubleclick.net", "adsterra.com", "googlesyndication.com"];
    for (const h of adHosts4) {
      assert("P4 ad host rejected by guards+background: " + h,
        guardsApi4.isAdUrl("https://" + h + "/x") && bgApi4.isAdUrl("https://" + h + "/x"),
        "guards=" + guardsApi4.isAdUrl("https://" + h + "/x") + " bg=" + bgApi4.isAdUrl("https://" + h + "/x"));
    }
    const legitAd4 = ["supjav.com", "streamtape.com", "tiktokcdn.com", "cdn.example.com", "surrit.com"];
    for (const h of legitAd4) {
      assert("P4 legit host not an ad: " + h,
        !guardsApi4.isAdUrl("https://" + h + "/x") && !bgApi4.isAdUrl("https://" + h + "/x"),
        "guards=" + guardsApi4.isAdUrl("https://" + h + "/x") + " bg=" + bgApi4.isAdUrl("https://" + h + "/x"));
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

  // ---- P6: popup Send message contract ----
  // popup.js's Send button dispatches {type:"send", url, title, referer} to the
  // background SW. The SW MUST reply through grabUrl; a future edit that removes
  // the "send" case leaves the callback undefined and the popup falsely shows
  // "disconnected" — the exact defect this guards.
  console.log("-- P6: background.js send-case contract --");
  const fs6 = require("fs");
  const bgSrc6 = fs6.readFileSync("extension/background.js", "utf8");
  assert("P6 background.js has a send case", bgSrc6.includes('case "send":'), "missing");
  const neg6 = bgSrc6.replace(/\n    case "send":[\s\S]*?\n      return true;/, "");
  assert("P6 negative source strips only the send case", neg6 !== bgSrc6 && !neg6.includes('case "send":'), "strip failed");
  const runSend6 = (bgSource) => {
    let listener = null;
    const wsInstance = {
      readyState: 1, // WebSocket.OPEN
      _msg: [],
      addEventListener(type, cb) { (this._msg[type] = this._msg[type] || []).push(cb); },
      removeEventListener() {},
      send(data) {
        // act like the desktop app: ack the download request immediately
        let m; try { m = JSON.parse(data); } catch (e) { return; }
        if (m.type === "download") {
          const reply = JSON.stringify({ type: "accepted", url: m.url, id: "P6-test" });
          for (const cb of this._msg.message || []) cb({ data: reply });
        }
      },
      close() {},
    };
    const chrome6 = {
      storage: { local: { get() {}, set() { return Promise.resolve(); } } },
      runtime: {
        sendMessage() { return Promise.resolve(); },
        onMessage: { addListener(fn) { listener = fn; } },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
      },
      action: { onClicked: { addListener() {} } },
      tabs: { onRemoved: { addListener() {} } },
      tabGroups: {}, windows: {},
      cookies: { getAll() { return Promise.resolve([]); } },
      webRequest: { onBeforeRequest: { addListener() {} }, onHeadersReceived: { addListener() {} } },
    };
    function WsStub6() { return wsInstance; }
    WsStub6.OPEN = 1; WsStub6.CONNECTING = 0; WsStub6.CLOSING = 2; WsStub6.CLOSED = 3;
    WsStub6.prototype.addEventListener = function () {};
    WsStub6.prototype.removeEventListener = function () {};
    new Function("chrome", "WebSocket", "self", "console", bgWithGuards(bgSource) + "\n;return true;")(chrome6, WsStub6, {}, console);
    if (!listener) throw new Error("P6 listener not captured");
    return Promise.race([
      new Promise((resolve) => {
        listener({ type: "send", url: "http://127.0.0.1:9/x.mp4", title: "", referer: "http://127.0.0.1:9/page/" }, {}, resolve);
      }),
      new Promise((resolve) => setTimeout(() => resolve(undefined), 1500)),
    ]);
  };
  const before6 = await runSend6(neg6);
  assert("P6 pre-fix (case removed) replies nothing", before6 === undefined, "got " + JSON.stringify(before6));
  const after6 = await runSend6(bgSrc6);    assert("P6 send case replies ok through grabUrl", after6 && after6.ok === true && after6.error === "", JSON.stringify(after6));

  // ---- P7: dv-rescan ingests into the SW's canonical found list ----
  // The popup's Re-scan routes through the SW: dv-rescan forwards to the tab's
  // content script, ingests the returned videos into `found` (dedupe by url),
  // and replies {ok, count: found.length}. A future edit that reintroduces a
  // second truth — answering with the content report's own length instead of
  // the SW list after ingestion, or skipping the ingestion — must fail here.
  console.log("-- P7: dv-rescan single-owner contract --");
  const fs7 = require("fs");
  const bgSrc7 = fs7.readFileSync("extension/background.js", "utf8");
  // negative 1: the ingestion loop is removed -> canonical list stays at seeds
  const neg7a = bgSrc7.replace(/if \(Array\.isArray\(r\.videos\)\) \{[\s\S]*?\n        \}/, "        /* P7 ingestion stripped */");
  // negative 2: the reply trusts the content report's length instead of found
  const neg7b = bgSrc7.replace("count: found.length", "count: (r && Array.isArray(r.videos)) ? r.videos.length : found.length");
  const runRescan7 = (bgSource, contentVideos) => {
    let listener = null;
    let sentToTab = null;
    const wsInstance = {
      readyState: 1, // WebSocket.OPEN
      _msg: [],
      addEventListener(type, cb) { (this._msg[type] = this._msg[type] || []).push(cb); },
      removeEventListener() {},
      send(data) {
        let m; try { m = JSON.parse(data); } catch (e) { return; }
        if (m.type === "download") {
          const reply = JSON.stringify({ type: "accepted", url: m.url, id: "P7-test" });
          for (const cb of this._msg.message || []) cb({ data: reply });
        }
      },
      close() {},
    };
    const chrome7 = {
      storage: { local: { get() {}, set() { return Promise.resolve(); } } },
      runtime: {
        sendMessage() { return Promise.resolve(); },
        onMessage: { addListener(fn) { listener = fn; } },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
      },
      action: { onClicked: { addListener() {} } },
      tabs: {
        onRemoved: { addListener() {} },
        sendMessage(tabId, msg) { sentToTab = { tabId, msg }; return Promise.resolve({ ok: true, videos: contentVideos }); },
      },
      tabGroups: {}, windows: {},
      cookies: { getAll() { return Promise.resolve([]); } },
      webRequest: { onBeforeRequest: { addListener() {} }, onHeadersReceived: { addListener() {} } },
    };
    function WsStub7() { return wsInstance; }
    WsStub7.OPEN = 1; WsStub7.CONNECTING = 0; WsStub7.CLOSING = 2; WsStub7.CLOSED = 3;
    WsStub7.prototype.addEventListener = function () {};
    WsStub7.prototype.removeEventListener = function () {};
    new Function("chrome", "WebSocket", "self", "console", bgWithGuards(bgSource) + "\n;return true;")(chrome7, WsStub7, {}, console);
    if (!listener) throw new Error("P7 listener not captured");
    return {
      seed(url) { listener({ type: "video-found", url }, { tab: { id: 1 } }, () => {}); },
      rescan() {
        return Promise.race([
          new Promise((resolve) => listener({ type: "dv-rescan", tabId: 42 }, {}, resolve)),
          new Promise((resolve) => setTimeout(() => resolve(undefined), 1500)),
        ]);
      },
      sentToTab: () => sentToTab,
    };
  };
  const seedA7 = "http://127.0.0.1:9/v/seed-a.mp4";
  const seedZ7 = "http://127.0.0.1:9/v/seed-z.mp4";
  const newB7 = "http://127.0.0.1:9/v/new-b.mp4";
  // the content report carries seedA (already canonical) + newB
  const videos7 = [
    { url: seedA7, title: "dup", pageUrl: "http://127.0.0.1:9/page/", kind: "mp4" },
    { url: newB7, title: "new", pageUrl: "http://127.0.0.1:9/page/", kind: "mp4" },
  ];
  const d7 = runRescan7(bgSrc7, videos7);
  d7.seed(seedA7); d7.seed(seedZ7);
  const after7 = await d7.rescan();
  const st7 = d7.sentToTab();
  assert("P7 dv-rescan forwards to the tab's content script", st7 && st7.tabId === 42 && st7.msg && st7.msg.type === "dv-rescan", JSON.stringify(st7));
  // canonical = seeds (seedA + seedZ) + newB from the report = 3; the report's
  // own length is 2, so a page-local-count reply would be caught.
  assert("P7 reply count is SW found.length after ingestion (3, deduped)", after7 && after7.ok === true && after7.count === 3, "reply=" + JSON.stringify(after7));
  const dA7 = runRescan7(neg7a, videos7);
  dA7.seed(seedA7); dA7.seed(seedZ7);
  const negResA7 = await dA7.rescan();
  assert("P7 NEGATIVE: stripped ingestion yields count 2 (guard bites)", negResA7 && negResA7.count === 2, "reply=" + JSON.stringify(negResA7));
  const dB7 = runRescan7(neg7b, videos7);
  dB7.seed(seedA7); dB7.seed(seedZ7);
  const negResB7 = await dB7.rescan();
  assert("P7 NEGATIVE: content-length reply yields count 2 (guard bites)", negResB7 && negResB7.count === 2, "reply=" + JSON.stringify(negResB7));

  // ---- P8: send-time pageUrl survival across an MV3 SW eviction ----
  // The webRequest capture path persists the found entry FIRST and backfills
  // pageUrl from chrome.tabs.get afterwards; an MV3 eviction can kill the
  // service worker between the two, so the persisted entry keeps pageUrl ""
  // forever. A harvest then sends referer "" to the desktop app, which skips
  // its dv-close-tab auto-close relay (the auto-close-movies-tab F5 FAIL). The
  // SW must resolve referer from the LIVE tab at send time (it is guaranteed
  // alive there) and persist the resolved pageUrl back into the entry.
  console.log("-- P8: send-time pageUrl survival (SW-death race) --");
  const fs8 = require("fs");
  const bgSrc8 = fs8.readFileSync("extension/background.js", "utf8").replace(/\r\n/g, "\n");
  const neg8 = bgSrc8.replace(/    if \(!referer\) \{[\s\S]*?\n    \}\n    finishSend\(referer\);/, "    finishSend(referer);");
  assert("P8 negative source strips only the send-time resolution", neg8 !== bgSrc8 && !neg8.includes("if (!referer) {"), "strip failed");
  const runHarvest8 = async (bgSource) => {
    let listener = null;
    let wreq = null;
    let allowGet = false;
    const downloads = [];
    const persisted = [];
    const TAB = "http://127.0.0.1:9/movies/close-me/";
    const wsInstance = {
      readyState: 1, // WebSocket.OPEN
      _msg: [],
      onmessage: null,
      addEventListener(type, cb) { (this._msg[type] = this._msg[type] || []).push(cb); },
      removeEventListener() {},
      send(data) {
        let m; try { m = JSON.parse(data); } catch (e) { return; }
        if (m.type === "download") downloads.push(m);
      },
      close() {},
    };
    const chrome8 = {
      storage: { local: { get() { return Promise.resolve({}); }, set(obj) { persisted.push(JSON.stringify(obj)); return Promise.resolve(); } } },
      runtime: {
        sendMessage() { return Promise.resolve(); },
        onMessage: { addListener(fn) { listener = fn; } },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
      },
      action: { onClicked: { addListener() {} } },
      tabs: {
        onRemoved: { addListener() {} },
        // While the SW is "dead" (before the harvest) every tabs.get hangs —
        // the capture-time pageUrl backfill is exactly the call an MV3 eviction
        // kills mid-flight. At harvest/send time the SW is alive and resolves.
        get() {
          if (!allowGet) return new Promise(() => {});
          return Promise.resolve({ id: 7, url: TAB, title: "close-me" });
        },
      },
      tabGroups: {}, windows: {},
      cookies: { getAll() { return Promise.resolve([]); } },
      webRequest: { onBeforeRequest: { addListener(fn) { wreq = fn; } }, onHeadersReceived: { addListener() {} } },
    };
    function WsStub8() { return wsInstance; }
    WsStub8.OPEN = 1; WsStub8.CONNECTING = 0; WsStub8.CLOSING = 2; WsStub8.CLOSED = 3;
    WsStub8.prototype.addEventListener = function () {};
    WsStub8.prototype.removeEventListener = function () {};
    new Function("chrome", "WebSocket", "self", "console", bgWithGuards(bgSource) + "\n;return true;")(chrome8, WsStub8, {}, console);
    if (!wreq) throw new Error("P8 webRequest listener not captured");
    if (!wsInstance.onmessage) throw new Error("P8 ws.onmessage not wired");
    // webRequest capture of the tab's video: addFound persists pageUrl "" and
    // the capture-time tabs.get backfill hangs (the eviction under test).
    wreq({ url: "http://127.0.0.1:9/v/mov-close-me.mp4", tabId: 7, type: "media" });
    await new Promise((r) => setTimeout(r, 50));
    allowGet = true; // the SW is alive at harvest/send time
    // the desktop app drives the harvest over the WS (dv-monitor-grab)
    wsInstance.onmessage({ data: JSON.stringify({ type: "dv-monitor-grab" }) });
    await waitForCondition(() => downloads.length >= 1, 2000);
    return { downloads, persisted };
  };
  const pos8 = await runHarvest8(bgSrc8);
  const dl8 = pos8.downloads.find((m) => m.type === "download");
  assert("P8 harvest sends referer resolved from the live tab (not \"\")",
    dl8 && dl8.referer === "http://127.0.0.1:9/movies/close-me/", "referer=" + JSON.stringify(dl8 && dl8.referer));
  assert("P8 resolved pageUrl persisted back into the found entry",
    pos8.persisted.length > 0 && pos8.persisted[pos8.persisted.length - 1].includes('"pageUrl":"http://127.0.0.1:9/movies/close-me/"'), "not persisted");
  const negRes8 = await runHarvest8(neg8);
  const dlNeg8 = negRes8.downloads.find((m) => m.type === "download");
  assert("P8 NEGATIVE: send-time resolution stripped -> referer \"\" (guard bites)",
    dlNeg8 && dlNeg8.referer === "", "referer=" + JSON.stringify(dlNeg8 && dlNeg8.referer));

  // ---- P9: popup mirror sync contract ----
  // popup.js must follow the SW's autoGrab mirror: re-render on the
  // dv-monitor-changed / desktop-status pushes AND re-pull on visibility/focus.
  // A push can be missed while the popup page is hidden/throttled, and a stale
  // toggle label used to make the next click send the WRONG direction (the F6
  // preamble flake). Guards the push + resync pair as one contract.
  console.log("-- P9: popup mirror sync contract --");
  const fs9 = require("fs");
  const popupSrc9 = fs9.readFileSync("extension/popup.js", "utf8");
  const bgSrc9b = fs9.readFileSync("extension/background.js", "utf8");
  const checkPopupSync9 = (src) =>
    src.includes('msg.type === "dv-monitor-changed"') &&
    src.includes('msg.type === "desktop-status"') &&
    src.includes('msg.type === "dv-found-updated"') &&
    src.includes('"visibilitychange"') &&
    src.includes("resyncFromSw() { refreshStatus(); loadMonitor(); loadFound(); }");
  assert("P9 popup handles the SW mirror pushes (dv-monitor-changed + desktop-status)",
    checkPopupSync9(popupSrc9), "push handlers missing");
  assert("P9 SW broadcasts dv-monitor-changed whenever the mirror flips",
    bgSrc9b.includes('sendMessage({ type: "dv-monitor-changed", on: autoGrab })'), "broadcast missing");
  const neg9a = popupSrc9.replace('  else if (msg && msg.type === "dv-monitor-changed") renderMonitor(msg.on === true);', "  /* P9 push handler stripped */");
  assert("P9 NEGATIVE: dv-monitor-changed handler stripped -> guard bites",
    neg9a !== popupSrc9 && !checkPopupSync9(neg9a), "guard missed the strip");
  const neg9b = popupSrc9.replace(/document\.addEventListener\("visibilitychange",[^\n]*/, "/* P9 visibility resync stripped */");
  assert("P9 NEGATIVE: visibility resync stripped -> guard bites",
    neg9b !== popupSrc9 && !checkPopupSync9(neg9b), "guard missed the strip");
  const neg9c = popupSrc9.replace("resyncFromSw() { refreshStatus(); loadMonitor(); loadFound(); }", "resyncFromSw() { refreshStatus(); loadMonitor(); }");
  assert("P9 NEGATIVE: found-list pull stripped from the resync -> guard bites",
    neg9c !== popupSrc9 && !checkPopupSync9(neg9c), "guard missed the strip");

  // ---- P10: always-on link crawler contract (content.js) ----
  // The always-on background crawler must auto-send every captured link match
  // (video URL, JAV movie page, host dl entry) WITHOUT the manual "Send"
  // toggle (grabOn) that gates maybeAutoDownload. Guards that (a) the default
  // config carries autoCrawl ON, (b) maybeAutoCrawl exists and is gated only by
  // config.autoCrawl (not grabOn), and (c) every link capture path (best-only
  // + non-best-only tryCapture, tryCaptureMoviePage, tryCaptureDl) calls it.
  // A future edit that reverts to per-click sending silently loses the feature.
  console.log("-- P10: always-on link crawler contract --");
  const fs10 = require("fs");
  const contentSrc10 = fs10.readFileSync("extension/content.js", "utf8");
  const checkCrawler10 = (src) =>
    src.includes("autoCrawl: true") &&
    src.includes("function maybeAutoCrawl(url)") &&
    src.includes("if (!config.autoCrawl || !isCrawlHost(url)) return;") &&
    !/maybeAutoDownload\([^)]*\);\s*$/.test(src.slice(src.indexOf("function maybeAutoCrawl"), src.indexOf("function flushAutoPending"))) &&
    (src.match(/maybeAutoCrawl\(clean\)/g) || []).length >= 4;
  assert("P10 content.js defines the always-on crawler (autoCrawl default ON + maybeAutoCrawl)",
    checkCrawler10(contentSrc10), "crawler contract missing");
  // Each capture site must route through maybeAutoCrawl.
  const crawlerSites10 = [
    ["tryCapture best-only video link", contentSrc10.slice(contentSrc10.indexOf("function tryCapture"), contentSrc10.indexOf("const DEFAULT_VIDEO_SELECTORS"))],
    ["tryCapture non-best-only video link", contentSrc10.slice(contentSrc10.indexOf("function tryCapture"), contentSrc10.indexOf("function scanVideoElements"))],
    ["tryCaptureMoviePage", contentSrc10.slice(contentSrc10.indexOf("function tryCaptureMoviePage"), contentSrc10.indexOf("function isSupjavDlUrl"))],
    ["tryCaptureDl", contentSrc10.slice(contentSrc10.indexOf("function tryCaptureDl"), contentSrc10.indexOf("function extractCnPorn"))]
  ];
  for (const [name, slice] of crawlerSites10) {
    assert("P10 " + name + " auto-sends its link match (maybeAutoCrawl call)",
      slice.includes("maybeAutoCrawl("), name + " missing auto-crawl call");
  }
  // The crawler is scoped to the JAV families (supjav/supremejav, sextb,
  // cnporn, missav): isCrawlHost must match each family and reject other hosts.
  // isCrawlHost closes over isSupjavHostname/isSextbHostname, so eval all
  // three declarations in one scope and return the real function.
  const crawlFns10 = ["isSupjavHostname", "isSextbHostname", "isCrawlHost"]
    .map((f) => contentSrc10.match(new RegExp("function " + f + "\\(h\\) \\{[\\s\\S]*?\\n  \\}"))[0])
    .join("\n");
  const isCrawlHost10 = new Function(crawlFns10 + "\nreturn isCrawlHost;")();
  const crawlHosts10 = [
    ["supjav.com", "supjav list page"],
    ["supremejav.net", "supremejav mirror"],
    ["sextb.net", "sextb movie page"],
    ["sextb.cc", "sextb mirror"],
    ["cnporn.org", "cnporn embed page"],
    ["missav.ai", "missav player"],
    ["missav123.ws", "missav mirror"],
    ["missav.live", "missav live mirror"]
  ];
  for (const [host, label] of crawlHosts10) {
    assert("P10 isCrawlHost matches " + label + " (" + host + ")",
      isCrawlHost10(host), host + " must be a crawl host");
  }
  for (const host of ["youtube.com", "vimeo.com", "example.com", "notmissav.com", "cnporn.net"]) {
    assert("P10 isCrawlHost rejects " + host,
      !isCrawlHost10(host), host + " must NOT be a crawl host");
  }
  // Production calls the gate with FULL captured URLs (tryCapture* pass the
  // absolute link, not the hostname) — a call-site/hostname mismatch once
  // silently killed the crawler for every host. Pin the URL-shaped contract:
  // the same families must match and cross-host CDN/media links must not.
  const crawlUrls10 = [
    ["http://supjav.com:8080/movie/code-123.html", "supjav movie page URL"],
    ["https://www.supremejav.net/v/1.mp4", "supremejav media URL"],
    ["https://sextb.cc/watch/abc", "sextb page URL"],
    ["http://cnporn.org/embed/uuid", "cnporn embed URL"],
    ["https://missav123.ws/video/xyz", "missav mirror URL"]
  ];
  for (const [url, label] of crawlUrls10) {
    assert("P10 isCrawlHost matches " + label + " (" + url + ")",
      isCrawlHost10(url), url + " must be a crawl host");
  }
  for (const url of ["http://cdn.example.com/v/x.mp4", "http://127.0.0.1:50556/movie/code-456.html", "http://www.notmissav.com/v/x.mp4"]) {
    assert("P10 isCrawlHost rejects " + url,
      !isCrawlHost10(url), url + " must NOT be a crawl host");
  }
  const neg10a = contentSrc10.replace("autoCrawl: true", "autoCrawl: false");
  assert("P10 NEGATIVE: autoCrawl default flipped OFF -> guard bites",
    neg10a !== contentSrc10 && !checkCrawler10(neg10a), "guard missed the autoCrawl flip");
  // Negative drills: strip the crawler gate and each call site in turn; the
  // guard must bite so the feature can never silently regress to manual sends.
  const neg10b = contentSrc10.replace("if (!config.autoCrawl || !isCrawlHost(url)) return;", "/* P10 gate stripped */");
  assert("P10 NEGATIVE: maybeAutoCrawl gate stripped -> guard bites",
    neg10b !== contentSrc10 && !checkCrawler10(neg10b), "guard missed the gate strip");
  const neg10d = contentSrc10.replace("|| !isCrawlHost(url)", "/* P10 host gate stripped */");
  assert("P10 NEGATIVE: isCrawlHost gate stripped -> guard bites",
    neg10d !== contentSrc10 && !checkCrawler10(neg10d), "guard missed the host-gate strip");
  // Strip the FIRST maybeAutoCrawl(clean) call (the best-only tryCapture site,
  // which is uniquely followed by "return;"). Source files carry CRLF, so
  // rebuild the drill on the normalized line content, not raw \r\n layout.
  const bestOnlyRegion10 = contentSrc10.slice(contentSrc10.indexOf("if (config.bestOnly)"), contentSrc10.indexOf("const DEFAULT_VIDEO_SELECTORS"));
  const neg10c = contentSrc10.replace(bestOnlyRegion10, bestOnlyRegion10.replace("maybeAutoCrawl(clean);", "/* P10 call site stripped */"));
  assert("P10 NEGATIVE: one capture call site stripped -> guard bites",
    neg10c !== contentSrc10 && (neg10c.match(/maybeAutoCrawl\(clean\)/g) || []).length !== 4,
    "guard missed a call-site strip (count=" + ((neg10c.match(/maybeAutoCrawl\(clean\)/g) || []).length) + ")");

  // ---- P11: extension error-status consumption contract ----
  // The app's status push carries structured error fields (lib/status.js:
  // errorStatus = raw HTTP status, errorCode = machine code, retryable = the
  // single-source transient rule). The SW must store them on the found entry
  // EXACTLY as pushed (the app is the single owner; a retry/done push carries
  // them cleared, so the mirror is self-clearing), and the popup must render
  // retryable failures distinctly from terminal ones (amber ⟳ vs red ✕).
  // Guards the last unshipped seam of the status-push feature — fields that
  // used to be emitted into the void.
  console.log("-- P11: extension error-status consumption contract --");
  const fs11 = require("fs");
  const bgSrc11 = fs11.readFileSync("extension/background.js", "utf8").replace(/\r\n/g, "\n");
  const popupSrc11 = fs11.readFileSync("extension/popup.js", "utf8");
  const runStatus11 = async (bgSource) => {
    let listener = null;
    let wreq = null;
    const wsInstance = {
      readyState: 1, // WebSocket.OPEN
      onmessage: null,
      addEventListener() {},
      removeEventListener() {},
      send() {},
      close() {},
    };
    const chrome11 = {
      storage: { local: { get() { return Promise.resolve({}); }, set() { return Promise.resolve(); } } },
      runtime: {
        sendMessage() { return Promise.resolve(); },
        onMessage: { addListener(fn) { listener = fn; } },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
      },
      action: { onClicked: { addListener() {} } },
      tabs: { onRemoved: { addListener() {} }, get() { return Promise.resolve(null); } },
      tabGroups: {}, windows: {},
      cookies: { getAll() { return Promise.resolve([]); } },
      webRequest: { onBeforeRequest: { addListener(fn) { wreq = fn; } }, onHeadersReceived: { addListener() {} } },
    };
    function WsStub11() { return wsInstance; }
    WsStub11.OPEN = 1; WsStub11.CONNECTING = 0; WsStub11.CLOSING = 2; WsStub11.CLOSED = 3;
    new Function("chrome", "WebSocket", "self", "console", bgWithGuards(bgSource) + "\n;return true;")(chrome11, WsStub11, {}, console);
    if (!wreq || !wsInstance.onmessage) throw new Error("P11 sandbox wiring failed");
    const URL = "http://127.0.0.1:9/v/status-test.mp4";
    wreq({ url: URL, tabId: 5, type: "media" }); // seed the found entry
    await new Promise((r) => setTimeout(r, 30));
    const getFound = () => new Promise((resolve) => { listener({ type: "get-found" }, {}, (r) => resolve(r)); });
    const push = (data) => wsInstance.onmessage({ data: JSON.stringify(data) });
    // All three steps observe the SAME live entry object, so snapshot the
    // fields at each step — later pushes would otherwise mutate the earlier
    // captures and every assert would read the final (cleared) state.
    const snap = (e) => e && { error: e.error, errorCode: e.errorCode, errorStatus: e.errorStatus, retryable: e.retryable };
    // retryable failure (http 502 -> the engine auto-requeues): fields land on the entry
    push({ type: "status", url: URL, status: "error", error: "server error", errorCode: "HTTP", errorStatus: 502, retryable: true });
    await new Promise((r) => setTimeout(r, 30));
    const e1 = snap((await getFound()).found.find((x) => x.url === URL));
    // terminal failure (http 404 -> NOT auto-retried): retryable false
    push({ type: "status", url: URL, status: "error", error: "not found", errorCode: "HTTP", errorStatus: 404, retryable: false });
    await new Promise((r) => setTimeout(r, 30));
    const e2 = snap((await getFound()).found.find((x) => x.url === URL));
    // done push carries the fields cleared -> the mirror sheds the stale error
    push({ type: "status", url: URL, status: "done", error: "", errorCode: "", errorStatus: 0, retryable: false });
    await new Promise((r) => setTimeout(r, 30));
    const e3 = snap((await getFound()).found.find((x) => x.url === URL));
    return { e1, e2, e3 };
  };
  const st11 = await runStatus11(bgSrc11);
  assert("P11 SW stores the structured fields from a retryable push (errorStatus 502 / errorCode / retryable true)",
    !!(st11.e1 && st11.e1.error === "server error" && st11.e1.errorCode === "HTTP" && st11.e1.errorStatus === 502 && st11.e1.retryable === true),
    JSON.stringify(st11.e1));
  assert("P11 SW mirrors a terminal push (errorStatus 404, retryable false)",
    !!(st11.e2 && st11.e2.error === "not found" && st11.e2.errorStatus === 404 && st11.e2.retryable === false),
    JSON.stringify(st11.e2));
  assert("P11 SW sheds stale error fields when the done push carries them empty (self-clearing mirror)",
    !!(st11.e3 && st11.e3.error === "" && !st11.e3.errorCode && st11.e3.errorStatus === 0 && st11.e3.retryable === false),
    JSON.stringify(st11.e3));
  // popup presentation contract: retryable and terminal get distinct classes/text
  // (explicit "Retryable error:"/"Terminal error:" labels for a11y + tooltip).
  const checkPopupErr11 = (src) =>
    src.includes('" dv-retry"') && src.includes('" dv-err"') &&
    src.includes("errorStatus") && src.includes("errorCode") && src.includes("retryable") &&
    src.includes('"⟳ Retryable error: "') && src.includes('"✕ Terminal error: "');
  assert("P11 popup renders retryable (⟳ dv-retry) vs terminal (✕ dv-err) distinctly from the push fields",
    checkPopupErr11(popupSrc11), "popup error presentation missing");
  const neg11 = popupSrc11.replace('v.retryable ? " dv-retry" : " dv-err"', '" dv-err"');
  assert("P11 NEGATIVE: retryable class collapsed into terminal -> guard bites",
    neg11 !== popupSrc11 && !checkPopupErr11(neg11), "guard missed the collapse");

  // Desktop renderer presentation mirrors the popup: the same pushed fields
  // produce a visible amber ⟳ retryable marker or red ✕ terminal marker in
  // both the progress detail and status badge, with an accessible label.
  const rendererSrc11 = fs11.readFileSync("renderer.js", "utf8");
  const checkRendererErr11 = (src) =>
    src.includes("errorStatus") && src.includes("errorCode") && src.includes("retryable") &&
    src.includes('marker: retryable ? "⟳" : "✕"') &&
    src.includes('className: retryable ? "error-retryable" : "error-terminal"') &&
    src.includes('label: retryable ? "Retryable error" : "Terminal error"') &&
    src.includes("errorMarkup") && src.includes("statusBadge") &&
    src.includes("aria-label");
  assert("P11 desktop renderer mirrors retryable (amber ⟳) vs terminal (red ✕) markers",
    checkRendererErr11(rendererSrc11), "desktop error presentation missing");
  const negRenderer11 = rendererSrc11.replace('className: retryable ? "error-retryable" : "error-terminal"', 'className: "error-terminal"');
  assert("P11 NEGATIVE: desktop retryable class collapsed into terminal -> guard bites",
    negRenderer11 !== rendererSrc11 && !checkRendererErr11(negRenderer11), "guard missed the desktop collapse");

  // ---- P12: link-state / compat surfacing contract ----
  // The app advertises its build version + wire protocol in `hello`, and refuses
  // a client claiming a NEWER protocol (PROTOCOL_MISMATCH reply + close 1008).
  // That refusal used to look exactly like an outage: the popup showed a bare
  // "disconnected" and the user had no way to know the fix is updating the app.
  // The SW must derive the whole link state (status + a human reason + the compat
  // code) in linkState() and hand it to the popup, which renders it without
  // re-deriving anything. Drives the real background.js under the chrome stub:
  // capture its desktop-status broadcasts, feed it a hello + a mismatch reply,
  // and read the state back through the production getStatus boundary.
  console.log("-- P12: link-state / compat surfacing contract --");
  const fs12 = require("fs");
  const bgSrc12 = fs12.readFileSync("extension/background.js", "utf8").replace(/\r\n/g, "\n");
  const popupSrc12 = fs12.readFileSync("extension/popup.js", "utf8");
  const popupHtml12 = fs12.readFileSync("extension/popup.html", "utf8");
  const runLink12 = async (bgSource, helloProtocol) => {
    let listener = null;
    const sent = []; // SW -> popup broadcasts (sendMessage with no callback)
    const wsInstance = {
      readyState: 1, // WebSocket.OPEN
      onopen: null,
      onclose: null,
      onmessage: null,
      addEventListener() {},
      removeEventListener() {},
      send() {},
      close() {},
    };
    const chrome12 = {
      storage: { local: { get() { return Promise.resolve({}); }, set() { return Promise.resolve(); } } },
      runtime: {
        sendMessage(msg, cb) {
          if (typeof cb !== "function" && msg && msg.type === "desktop-status") sent.push(msg);
          return Promise.resolve();
        },
        onMessage: { addListener(fn) { listener = fn; } },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
      },
      action: { onClicked: { addListener() {} } },
      tabs: { onRemoved: { addListener() {} }, get() { return Promise.resolve(null); }, query() { return Promise.resolve([]); } },
      tabGroups: {}, windows: {},
      cookies: { getAll() { return Promise.resolve([]); } },
      webRequest: { onBeforeRequest: { addListener() {} }, onHeadersReceived: { addListener() {} } },
    };
    function WsStub12() { return wsInstance; }
    WsStub12.OPEN = 1; WsStub12.CONNECTING = 0; WsStub12.CLOSING = 2; WsStub12.CLOSED = 3;
    new Function("chrome", "WebSocket", "self", "console", bgWithGuards(bgSource) + "\n;return true;")(chrome12, WsStub12, {}, console);
    if (typeof wsInstance.onmessage !== "function" || typeof wsInstance.onopen !== "function") throw new Error("P12 sandbox wiring failed");
    const getState = () => new Promise((resolve) => { listener({ type: "getStatus" }, {}, (r) => resolve(r)); });
    const push = (data) => wsInstance.onmessage({ data: JSON.stringify(data) });
    const connecting = await getState(); // status at eval time, before any handshake
    wsInstance.onopen(); // the app accepted the socket
    push({ type: "hello", version: "1.3.12", protocolVersion: helloProtocol == null ? 1 : helloProtocol, port: 8765 });
    const helloState = await getState();
    const helloBroadcast = sent[sent.length - 1];
    push({ type: "error", code: "PROTOCOL_MISMATCH", message: "Extension is newer than the app", url: "", retryable: false });
    const mismatch = await getState();
    return { connecting, helloState, mismatch, helloBroadcast, lastBroadcast: sent[sent.length - 1] };
  };
  const st12 = await runLink12(bgSrc12);
  assert("P12 pre-handshake state reads as connecting with a reason",
    !!(st12.connecting && st12.connecting.ok === false && st12.connecting.status === "connecting" && /Connecting/.test(st12.connecting.detail || "")),
    JSON.stringify(st12.connecting));
  assert("P12 app hello identity reaches the popup link state (version + protocol)",
    !!(st12.helloState && st12.helloState.ok === true && st12.helloState.status === "online" &&
      st12.helloState.appVersion === "1.3.12" && st12.helloState.appProtocol === 1 &&
      /1\.3\.12/.test(st12.helloState.detail || "") && /protocol v1/.test(st12.helloState.detail || "") && st12.helloState.code === ""),
    JSON.stringify(st12.helloState));
  assert("P12 the hello identity is broadcast to the popup, not only pullable",
    !!(st12.helloBroadcast && st12.helloBroadcast.type === "desktop-status" && st12.helloBroadcast.appVersion === "1.3.12" && st12.helloBroadcast.appProtocol === 1),
    JSON.stringify(st12.helloBroadcast));
  assert("P12 a PROTOCOL_MISMATCH refusal is surfaced as the actionable cause (not a bare disconnected)",
    !!(st12.mismatch && st12.mismatch.ok === false && st12.mismatch.status === "offline" && st12.mismatch.code === "extension-newer" &&
      /Update Deep Video Downloader/.test(st12.mismatch.detail || "")),
    JSON.stringify(st12.mismatch));
  assert("P12 the mismatch is pushed to the popup too (lastBroadcast carries the code)",
    !!(st12.lastBroadcast && st12.lastBroadcast.type === "desktop-status" && st12.lastBroadcast.code === "extension-newer"),
    JSON.stringify(st12.lastBroadcast));
  // Version skew the OTHER way: an app whose advertised protocol is behind ours
  // is still accepted by the app (only a newer client is refused), so the SW has
  // to flag the skew itself. Drive it by evaluating the same source with a bumped
  // extension protocol against a v1 hello.
  const skewSrc12 = bgSrc12.replace("const EXT_PROTOCOL_VERSION = 1;", "const EXT_PROTOCOL_VERSION = 2;");
  assert("P12 version-skew drill hook applied (EXT_PROTOCOL_VERSION bump)",
    skewSrc12 !== bgSrc12, "drill could not bump EXT_PROTOCOL_VERSION");
  const skew12 = await runLink12(skewSrc12);
  assert("P12 an app advertising an older protocol is flagged app-older with an update hint",
    !!(skew12.helloState && skew12.helloState.code === "app-older" && skew12.helloState.ok === true &&
      /Update Deep Video Downloader/.test(skew12.helloState.detail || "")),
    JSON.stringify(skew12.helloState));
  assert("P12 an incompatible app backs off to the slow retry beat",
    bgSrc12.includes('compat === "extension-newer" ? RECONNECT_INCOMPATIBLE_DELAY : RECONNECT_DELAY') &&
    bgSrc12.includes("const RECONNECT_INCOMPATIBLE_DELAY"), "backoff wiring missing");
  // The popup now NAMES the app it is paired with, so the hello version must be
  // the real build: a hardcoded literal would show every user a bogus version.
  const appSrc12 = fs12.readFileSync("main.js", "utf8");
  assert("P12 the app hello advertises the real build version (not a hardcoded literal)",
    appSrc12.includes("version: APP_VERSION") && appSrc12.includes("const APP_VERSION = app.getVersion()"),
    "hello version is not derived from the app build");
  const checkLink12 = (bgSrc, popupSrc, htmlSrc) =>
    bgSrc.includes("function linkState()") &&
    bgSrc.includes('m.type === "hello"') &&
    bgSrc.includes('m.code === "PROTOCOL_MISMATCH"') &&
    bgSrc.includes('compat = "extension-newer"') &&
    bgSrc.includes("sendResponse(linkState())") &&
    popupSrc.includes("function renderDetail(s)") &&
    popupSrc.includes('s.code === "extension-newer"') &&
    popupSrc.includes('actionable ? "compat" : ""') &&
    htmlSrc.includes('id="status-detail"');
  assert("P12 SW derives + popup renders the link reason (linkState / renderDetail / status-detail slot)",
    checkLink12(bgSrc12, popupSrc12, popupHtml12), "link-state surfacing missing");
  const neg12a = bgSrc12.replace('if (m && m.type === "hello") {', "if (false) { /* P12 hello branch stripped */");
  assert("P12 NEGATIVE: app hello branch stripped -> guard bites",
    neg12a !== bgSrc12 && !checkLink12(neg12a, popupSrc12, popupHtml12), "guard missed the hello strip");
  const neg12b = bgSrc12.replace('sendResponse(linkState())', 'sendResponse({ ok: wsStatus === "online" })');
  assert("P12 NEGATIVE: link state downgraded to the legacy {ok} reply -> guard bites",
    neg12b !== bgSrc12 && !checkLink12(neg12b, popupSrc12, popupHtml12), "guard missed the reply downgrade");
  const neg12c = popupSrc12.replace('actionable ? "compat" : ""', '""');
  assert("P12 NEGATIVE: popup compat styling stripped -> guard bites",
    neg12c !== popupSrc12 && !checkLink12(bgSrc12, neg12c, popupHtml12), "guard missed the popup strip");

  // ---- P13: port following + heartbeat (extension) and fan-out + paired-client
  //          registry (app window) ----
  // The app's WS port is configurable and it falls forward to a free neighbour,
  // so an extension pinned to 8765 silently loses the link. The SW must
  // remember the port the app answered on, sweep the neighbourhood when an
  // attempt finds nothing, and refuse to sit on a port that never greets it.
  // It must also notice a socket that stopped answering (heartbeat) instead of
  // reporting progress forever. On the app side, auto-grab pushes (close-tab /
  // monitor-grab) must reach EVERY paired extension — the user's real Chrome and
  // the app's built-in browser can both be connected — and the window must show
  // who is paired. Drives the real background.js under a stub WebSocket so the
  // connect sequence is observable, plus source pins for the app-side wiring.
  console.log("-- P13: port following + heartbeat + paired-client fan-out --");
  const fs13 = require("fs");
  const bgSrc13 = fs13.readFileSync("extension/background.js", "utf8").replace(/\r\n/g, "\n");
  const mainSrc13 = fs13.readFileSync("main.js", "utf8").replace(/\r\n/g, "\n");
  const ipcSrc13 = fs13.readFileSync("lib/ipc.js", "utf8");
  const preloadSrc13 = fs13.readFileSync("preload.js", "utf8");
  const rendererSrc13 = fs13.readFileSync("renderer.js", "utf8");
  const htmlSrc13 = fs13.readFileSync("renderer.html", "utf8");
  const runBridge13 = (bgSource) => {
    let listener = null;
    const sockets = [];
    const stored = [];
    class WsStub13 {
      constructor(url) {
        this.url = url;
        this.readyState = 0; // CONNECTING
        this.sent = [];
        this.closed = 0;
        this.onopen = null; this.onclose = null; this.onmessage = null; this.onerror = null;
        sockets.push(this);
      }
      send(data) { this.sent.push(String(data)); }
      // Faithful close: a real socket fires onclose exactly once (the SW's
      // reconnect path depends on it, and the hello-watch close must be
      // observable as a reconnect — not a silent no-op).
      close() {
        if (this.readyState === 3) return;
        this.closed++;
        this.readyState = 3;
        const cb = this.onclose;
        if (cb) setTimeout(cb, 0);
      }
      addEventListener() {}
      removeEventListener() {}
    }
    WsStub13.OPEN = 1; WsStub13.CONNECTING = 0; WsStub13.CLOSING = 2; WsStub13.CLOSED = 3;
    const chrome13 = {
      storage: {
        local: {
          get() { return Promise.resolve({}); },
          set(obj) { stored.push(obj); return Promise.resolve(); }
        }
      },
      runtime: {
        sendMessage() { return Promise.resolve(); },
        onMessage: { addListener(fn) { listener = fn; } },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
      },
      action: { onClicked: { addListener() {} } },
      tabs: { onRemoved: { addListener() {} }, get() { return Promise.resolve(null); }, query() { return Promise.resolve([]); } },
      tabGroups: {}, windows: {},
      cookies: { getAll() { return Promise.resolve([]); } },
      webRequest: { onBeforeRequest: { addListener() {} }, onHeadersReceived: { addListener() {} } },
    };
    new Function("chrome", "WebSocket", "self", "console", bgWithGuards(bgSource) + "\n;return true;")(chrome13, WsStub13, {}, console);
    const open = (s) => { s.readyState = 1; s.onopen(); };
    const closeFromPeer = (s) => { s.readyState = 3; s.onclose(); };
    const push = (s, data) => s.onmessage({ data: JSON.stringify(data) });
    const frames = (s) => s.sent.map((x) => { try { return JSON.parse(x); } catch (e) { return {}; } });
    const state = () => new Promise((resolve) => { listener({ type: "getStatus" }, {}, (r) => resolve(r)); });
    return { sockets, stored, open, closeFromPeer, push, frames, state };
  };
  // ---- port following: sweep, hello-proves-the-port, and no progress on a
  // stranger's port ----
  const b13 = runBridge13(bgSrc13);
  assert("P13 the extension connects to the default port from the WS_URL literal (8765)",
    b13.sockets.length === 1 && /:8765$/.test(b13.sockets[0].url), JSON.stringify(b13.sockets.map((s) => s.url)));
  b13.open(b13.sockets[0]);
  assert("P13 a fresh socket still announces itself with hello",
    b13.frames(b13.sockets[0]).some((f) => f.type === "hello"), JSON.stringify(b13.frames(b13.sockets[0])));
  // Nothing greets us: the socket is dropped instead of being treated as the app.
  const strangerDropped = await waitForCondition(() => b13.sockets[0].closed >= 1, 6000);
  assert("P13 a socket that never greets is dropped (not the app)", strangerDropped,
    "closed=" + b13.sockets[0].closed);
  // ...and the sweep moves on to the next port in the neighbourhood.
  const swept = await waitForCondition(() => b13.sockets.length >= 2, 8000);
  assert("P13 an unproven port is swept past (8765 -> 8766)",
    swept && /:8766$/.test(b13.sockets[1].url), JSON.stringify(b13.sockets.map((s) => s.url)));
  // The app's hello proves the port: it is remembered, and the link line names it.
  b13.open(b13.sockets[1]);
  b13.push(b13.sockets[1], { type: "hello", version: "1.3.12", protocolVersion: 1, port: 8766 });
  const proven = await b13.state();
  assert("P13 the port that answered with a hello is remembered for the next SW wake",
    b13.stored.some((o) => o.dv_ws_port === 8766), JSON.stringify(b13.stored));
  assert("P13 the link line names the port the app answered on",
    !!proven && proven.ok === true && proven.port === 8766 && /port 8766/.test(proven.detail || ""), JSON.stringify(proven));
  // A proven port is retried in place (a dropped socket is not a port change).
  b13.closeFromPeer(b13.sockets[1]);
  const retried = await waitForCondition(() => b13.sockets.length >= 3, 8000);
  assert("P13 a proven port is retried in place rather than swept past",
    retried && /:8766$/.test(b13.sockets[2].url), JSON.stringify(b13.sockets.map((s) => s.url)));
  // ---- heartbeat: ping on the wire, pong keeps it alive, a missed pong reconnects
  const hb13 = runBridge13(bgSrc13
    .replace("const PING_INTERVAL_MS = 20000;", "const PING_INTERVAL_MS = 300;")
    .replace("const PONG_TIMEOUT_MS = 8000;", "const PONG_TIMEOUT_MS = 250;"));
  assert("P13 heartbeat drill hook applied (ping/pong constants shrunk)",
    hb13.sockets.length >= 1, "drill could not shrink the heartbeat constants");
  hb13.open(hb13.sockets[0]);
  const pinged = await waitForCondition(() => hb13.frames(hb13.sockets[0]).some((f) => f.type === "ping"), 4000);
  assert("P13 the extension pings the app on its heartbeat interval", pinged,
    JSON.stringify(hb13.frames(hb13.sockets[0])));
  hb13.push(hb13.sockets[0], { type: "pong" });
  await new Promise((r) => setTimeout(r, 400));
  assert("P13 a pong keeps the socket alive (no false reconnect)",
    hb13.sockets[0].closed === 0, "closed=" + hb13.sockets[0].closed);
  const wentStale = await waitForCondition(() => hb13.sockets[0].closed >= 1, 6000);
  assert("P13 a missed pong deadline closes the dead socket", wentStale, "closed=" + hb13.sockets[0].closed);
  const staleState = await hb13.state();
  assert("P13 the popup learns the app stopped responding (stale, not silent)",
    !!staleState && staleState.stale === true && /stopped responding/.test(staleState.detail || ""), JSON.stringify(staleState));
  // ---- app side: fan-out to EVERY paired extension + the paired-client panel ----
  const checkBridge13 = (mainSrc, ipcSrc, preloadSrc, rendererSrc, htmlSrc) =>
    mainSrc.includes("const extClients = clients.filter(") &&
    // BOTH auto-grab pushes (close-tab and monitor-grab) fan out, not just one.
    (mainSrc.match(/for \(const c of extClients\)/g) || []).length >= 2 &&
    // The old first-extension-only lookup must not come back.
    !mainSrc.includes("clients.find((c) => c.readyState === 1 && c.isExtension)") &&
    mainSrc.includes("function describeClient(") &&
    mainSrc.includes("ws.meta = {") &&
    mainSrc.includes("function clientSnapshot()") &&
    mainSrc.includes("function pushClients()") &&
    mainSrc.includes("const WS_KEEPALIVE_MS") &&
    ipcSrc.includes('ipcMain.handle("clients-list"') &&
    preloadSrc.includes('onClients: (cb) => ipcRenderer.on("ws-clients"') &&
    rendererSrc.includes("function renderBridge(snap)") &&
    rendererSrc.includes("window.api.onClients(") &&
    htmlSrc.includes('id="bridgeClients"') && htmlSrc.includes('id="bridgeSummary"');
  assert("P13 app pushes auto-grab to every extension + tracks and shows the paired clients",
    checkBridge13(mainSrc13, ipcSrc13, preloadSrc13, rendererSrc13, htmlSrc13), "paired-client wiring missing");
  const neg13a = mainSrc13.replace("const extClients = clients.filter((c) => c.readyState === 1 && c.isExtension);",
    "const extClients = [clients.find((c) => c.readyState === 1 && c.isExtension)];");
  assert("P13 NEGATIVE: fan-out narrowed back to the first extension -> guard bites",
    neg13a !== mainSrc13 && !checkBridge13(neg13a, ipcSrc13, preloadSrc13, rendererSrc13, htmlSrc13), "guard missed the narrowing");
  const neg13b = mainSrc13.replace("for (const c of extClients) {", "for (const c of extClients.slice(0, 1)) {");
  assert("P13 NEGATIVE: one auto-grab push fanned out to a single client -> guard bites",
    neg13b !== mainSrc13 && !checkBridge13(neg13b, ipcSrc13, preloadSrc13, rendererSrc13, htmlSrc13), "guard missed the single-client push");
  const neg13c = mainSrc13.replace("function describeClient(", "function describeClientRemoved(");
  assert("P13 NEGATIVE: client labelling stripped -> guard bites",
    neg13c !== mainSrc13 && !checkBridge13(neg13c, ipcSrc13, preloadSrc13, rendererSrc13, htmlSrc13), "guard missed the label strip");
  const neg13d = rendererSrc13.replace("window.api.onClients(", "window.api.onClientsRemoved(");
  assert("P13 NEGATIVE: renderer push subscription stripped -> guard bites",
    neg13d !== rendererSrc13 && !checkBridge13(mainSrc13, ipcSrc13, preloadSrc13, neg13d, htmlSrc13), "guard missed the renderer strip");

  // ---- P14: pace-limited retry (the app's retryAfter is honored) ----
  // The app's crawl throttle refuses a sustained flood with PACE_LIMITED
  // (`retryable: true`, `retryAfter: 60`). The SW used to drop those fields and
  // treat the refusal as terminal, so a throttled harvest stalled: the entry sat
  // in `found` with added:false and nothing ever re-sent it. The SW must queue
  // the url for the window the app asked for, STOP the pass on the first refusal
  // (each extra send only pushes the throttle's rolling window further out), and
  // re-send when the window closes. Drives the real background.js against a stub
  // WebSocket that plays the app: it refuses the first download with PACE_LIMITED
  // and accepts the retry that follows the window.
  console.log("-- P14: pace-limited retry honors the app's retryAfter --");
  const fs14 = require("fs");
  const bgSrc14 = fs14.readFileSync("extension/background.js", "utf8").replace(/\r\n/g, "\n");
  const popupSrc14 = fs14.readFileSync("extension/popup.js", "utf8").replace(/\r\n/g, "\n");
  const mainSrc14 = fs14.readFileSync("main.js", "utf8").replace(/\r\n/g, "\n");
  const runPace14 = (bgSource) => {
    let listener = null;
    const stored = [];
    const sockets = [];
    class WsStub14 {
      constructor(url) {
        this.url = url;
        this.readyState = 0; // CONNECTING
        this.sent = [];
        this.closed = 0;
        this.onopen = null; this.onclose = null; this.onmessage = null; this.onerror = null;
        this.msgListeners = []; // sendInner's addEventListener("message") correlation hook
        sockets.push(this);
      }
      send(data) { this.sent.push(String(data)); }
      close() {
        if (this.readyState === 3) return;
        this.closed++;
        this.readyState = 3;
        const cb = this.onclose;
        if (cb) setTimeout(cb, 0);
      }
      addEventListener(type, fn) { if (type === "message") this.msgListeners.push(fn); }
      removeEventListener(type, fn) { this.msgListeners = this.msgListeners.filter((f) => f !== fn); }
    }
    WsStub14.OPEN = 1; WsStub14.CONNECTING = 0; WsStub14.CLOSING = 2; WsStub14.CLOSED = 3;
    const chrome14 = {
      storage: {
        local: {
          get() { return Promise.resolve({}); },
          set(obj) { stored.push(obj); return Promise.resolve(); }
        }
      },
      runtime: {
        sendMessage() { return Promise.resolve(); },
        onMessage: { addListener(fn) { listener = fn; } },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
      },
      action: { onClicked: { addListener() {} } },
      tabs: { onRemoved: { addListener() {} }, get() { return Promise.resolve(null); }, query() { return Promise.resolve([]); } },
      tabGroups: {}, windows: {},
      cookies: { getAll() { return Promise.resolve([]); } },
      webRequest: { onBeforeRequest: { addListener() {} }, onHeadersReceived: { addListener() {} } },
    };
    new Function("chrome", "WebSocket", "self", "console", bgWithGuards(bgSource) + "\n;return true;")(chrome14, WsStub14, {}, console);
    const frames = (s) => s.sent.map((x) => { try { return JSON.parse(x); } catch (e) { return {}; } });
    // Deliver an app -> client message to BOTH handlers: the SW's onmessage and
    // the per-request correlation listener sendInner registers.
    const deliver = (s, data) => {
      const ev = { data: JSON.stringify(data) };
      if (typeof s.onmessage === "function") s.onmessage(ev);
      for (const fn of s.msgListeners.slice()) fn(ev);
    };
    const seed = (v, tabId) => listener({ type: "video-found", ...v }, { tab: { id: tabId } }, () => {});
    const foundState = () => new Promise((resolve) => { listener({ type: "get-found" }, {}, (r) => resolve(r)); });
    const request = (msg) => new Promise((resolve) => { listener(msg, {}, (r) => resolve(r)); });
    return { sockets, stored, deliver, frames, seed, foundState, request };
  };
  const p14 = runPace14(bgSrc14);
  const sock14 = p14.sockets[0];
  sock14.readyState = 1;
  sock14.onopen();
  p14.deliver(sock14, { type: "hello", version: "1.3.12", protocolVersion: 1, port: 8765 });
  const A14 = "http://127.0.0.1/movies/a.mp4";
  const B14 = "http://127.0.0.1/movies/b.mp4";
  p14.seed({ url: A14, title: "a.mp4", pageUrl: "http://127.0.0.1/movies/a/", kind: "mp4" }, 1);
  p14.seed({ url: B14, title: "b.mp4", pageUrl: "http://127.0.0.1/movies/b/", kind: "mp4" }, 1);
  const seeded14 = await p14.foundState();
  assert("P14 drill seeded two pending videos",
    !!(seeded14 && Array.isArray(seeded14.found) && seeded14.found.length === 2),
    JSON.stringify(seeded14 && seeded14.found && seeded14.found.map((x) => x.url)));
  const downloads14 = () => p14.frames(sock14).filter((f) => f.type === "download");
  // The app drives the harvest; the first video is refused the way the throttle does.
  p14.deliver(sock14, { type: "dv-monitor-grab" });
  const firstSent14 = await waitForCondition(() => downloads14().length >= 1, 4000);
  const dl14 = downloads14()[0];
  assert("P14 the harvest sends the first pending video to the app",
    firstSent14 && !!dl14 && dl14.url === A14, JSON.stringify(dl14));
  p14.deliver(sock14, {
    type: "error", code: "PACE_LIMITED", message: "Pace limit: too many downloads in the last minute.",
    url: A14, reqId: dl14 && dl14.reqId, retryable: true, retryAfter: 1
  });
  await new Promise((r) => setTimeout(r, 300));
  assert("P14 a pace refusal stops the pass instead of hammering every remaining video",
    downloads14().length === 1, JSON.stringify(downloads14().map((f) => f.url)));
  const result14 = p14.frames(sock14).filter((f) => f.type === "dv-monitor-result").pop();
  assert("P14 the harvest reply reports the app's window (retryAfter) instead of stalling silently",
    !!(result14 && result14.sent === 0 && result14.remaining === 2 && result14.retryAfter === 1), JSON.stringify(result14));
  const marked14 = await p14.foundState();
  const aMarked14 = (marked14.found || []).find((x) => x.url === A14);
  assert("P14 the throttled entry is flagged retryable (PACE_LIMITED) rather than left silent",
    !!(aMarked14 && aMarked14.retryable === true && aMarked14.errorCode === "PACE_LIMITED"), JSON.stringify(aMarked14));
  assert("P14 the queued retry is persisted, so an MV3 eviction cannot lose it",
    p14.stored.some((o) => Array.isArray(o.dv_pace_retry) && o.dv_pace_retry.length >= 1),
    JSON.stringify(p14.stored));
  // The window closes: the refused send is retried (and the deferred tail with it).
  const retried14 = await waitForCondition(() => downloads14().filter((f) => f.url === A14).length >= 2, 6000);
  assert("P14 a throttled send is retried after the app's retryAfter window", retried14,
    JSON.stringify(downloads14().map((f) => f.url)));
  // Accept everything outstanding (the retry, then the deferred tail) and confirm
  // the pending list actually drains — the stall this drill exists to prevent.
  const answered14 = new Set();
  const answer14 = () => {
    for (const f of downloads14()) {
      const key = f.reqId || f.url;
      if (answered14.has(key)) continue;
      answered14.add(key);
      p14.deliver(sock14, { type: "accepted", id: "dl-" + f.url, url: f.url, reqId: f.reqId });
    }
  };
  let drained14 = await p14.foundState();
  const drainStart14 = Date.now();
  while (drained14 && drained14.found.length && Date.now() - drainStart14 < 6000) {
    answer14();
    await new Promise((r) => setTimeout(r, 100));
    drained14 = await p14.foundState();
  }
  assert("P14 the retried harvest drains the pending list (nothing left stalled)",
    !!(drained14 && drained14.found.length === 0),
    JSON.stringify(drained14 && drained14.found.map((x) => x.url)));
  // A raw Send (the popup's URL box) has no pending entry to re-send, so its
  // refusal must stay a plain refusal and SAY so — promising a retry the SW will
  // not make is the same lie as reporting a queued retry as a failure.
  const rawUrl14 = "http://127.0.0.1/raw.mp4";
  const rawReply14 = await new Promise((resolve) => {
    p14.request({ type: "send", url: rawUrl14, title: "", referer: "" }).then(resolve);
    waitForCondition(() => p14.frames(sock14).some((f) => f.type === "download" && f.url === rawUrl14), 4000).then((ok) => {
      const f = p14.frames(sock14).find((x) => x.type === "download" && x.url === rawUrl14);
      if (ok && f) {
        p14.deliver(sock14, {
          type: "error", code: "PACE_LIMITED", message: "Pace limit: too many downloads in the last minute.",
          url: rawUrl14, reqId: f.reqId, retryable: true, retryAfter: 1
        });
      }
    });
  });
  assert("P14 a raw Send with no pending entry is not promised a retry (queued stays false)",
    !!(rawReply14 && rawReply14.ok === false && rawReply14.retryable === true && !rawReply14.queued),
    JSON.stringify(rawReply14));
  // Source pins: the app must keep advertising the window (the extension is the
  // consumer), and the popup must say a queued send is retrying, not failed.
  const checkPace14 = (bgSrc, popupSrc, appSrc) =>
    bgSrc.includes("retryable: !!r.retryable") &&
    bgSrc.includes("deferPaceRetry(url, r.retryAfter)") &&
    bgSrc.includes("async function runHarvest()") &&
    bgSrc.includes("retryAfterMs = paceRetryMs(r.retryAfter)") &&
    bgSrc.includes("PACE_QUEUE_KEY") &&
    bgSrc.includes("restorePaceQueue();") &&
    bgSrc.includes("queued: true") &&
    bgSrc.includes("reply.retryAfter = Math.round(r.retryAfterMs / 1000)") &&
    popupSrc.includes('if (r.queued) return "⟳ "') &&
    appSrc.includes("retryAfter: 60");
  assert("P14 the pace window is honored end to end (SW queue + popup wording + app advertisement)",
    checkPace14(bgSrc14, popupSrc14, mainSrc14), "pace-retry wiring missing");
  const neg14a = bgSrc14.replace("retryable: !!r.retryable", "retryable: false");
  assert("P14 NEGATIVE: the structured retryable flag dropped in grabUrl -> guard bites",
    neg14a !== bgSrc14 && !checkPace14(neg14a, popupSrc14, mainSrc14), "guard missed the flag drop");
  const neg14b = bgSrc14.replace("deferPaceRetry(url, r.retryAfter);", "");
  assert("P14 NEGATIVE: the refusal no longer queued -> guard bites",
    neg14b !== bgSrc14 && !checkPace14(neg14b, popupSrc14, mainSrc14), "guard missed the queue removal");
  const neg14c = bgSrc14.replace("retryAfterMs = paceRetryMs(r.retryAfter);", "retryAfterMs = 0;");
  assert("P14 NEGATIVE: the harvest stops reporting the window -> guard bites",
    neg14c !== bgSrc14 && !checkPace14(neg14c, popupSrc14, mainSrc14), "guard missed the window drop");
  const neg14d = popupSrc14.replace('if (r.queued) return "⟳ "', 'if (false) return "⟳ "');
  assert("P14 NEGATIVE: a queued retry reads as a hard failure again -> guard bites",
    neg14d !== popupSrc14 && !checkPace14(bgSrc14, neg14d, mainSrc14), "guard missed the popup revert");
  const neg14f = popupSrc14.replace('if (r.queued) return "⟳ "', 'if (r.retryable) return "⟳ "');
  assert("P14 NEGATIVE: the popup promises a retry the SW never queued -> guard bites",
    neg14f !== popupSrc14 && !checkPace14(bgSrc14, neg14f, mainSrc14), "guard missed the unqueued promise");
  const neg14e = mainSrc14.replace("retryAfter: 60", "retryAfter: 0");
  assert("P14 NEGATIVE: the app stops advertising the window -> guard bites",
    neg14e !== mainSrc14 && !checkPace14(bgSrc14, popupSrc14, neg14e), "guard missed the app revert");

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
