"use strict";
// Offline tests for the HLS helpers in downloader.js (parseHlsPlaylist /
// pickHlsVariant / stripPngPrefix). No Electron, no network, no ffmpeg needed.
// Run: node test-hls.js
const { parseHlsPlaylist, pickHlsVariant, pickHlsVariants, isIFrameOnlyPlaylist, stripPngPrefix, matchHlsMaster, canonicalKeys } = require("./downloader");
const { DownloadManager } = require("./downloader");
const { DEFAULT_CONFIG } = require("./config");

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log("  PASS  " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? " -> " + detail : "")); }
}

const BASE = "https://example.com/master.m3u8";

console.log("\n=== parseHlsPlaylist (media playlists) ===\n");
const playlist = "#EXTM3U\n#EXT-X-VERSION:3\nsegment-1.ts\nsegment-2.ts\nsegment-3.ts\n";
const segs = parseHlsPlaylist(playlist, BASE);
assert("parses 3 segments", segs.length === 3, "got " + segs.length);
assert("resolves relative URI 1", segs[0] === "https://example.com/segment-1.ts", segs[0]);
assert("resolves relative URI 3", segs[2] === "https://example.com/segment-3.ts", segs[2]);
assert("skips comments/tags", parseHlsPlaylist("#EXTM3U\n#EXT-X-DISCONTINUITY\na.ts\n", BASE)[0] === "https://example.com/a.ts");
assert("absolute URIs pass through", parseHlsPlaylist("#EXTM3U\nhttps://cdn.example/a.ts\n", BASE)[0] === "https://cdn.example/a.ts");

let threw = false;
try { parseHlsPlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\nseg.ts\n", BASE); }
catch (e) { threw = /AES-128/.test(String(e.message)); }
assert("AES-128 playlist throws", threw);

console.log("\n=== pickHlsVariant (master playlists) ===\n");
const master = [
  "#EXTM3U",
  "#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360",
  "https://example.com/low.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720",
  "https://example.com/high.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=50000,RESOLUTION=416x234",
  "https://example.com/mobile.m3u8",
  ""
].join("\n");
assert("picks highest-resolution variant", pickHlsVariant(master, BASE) === "https://example.com/high.m3u8", pickHlsVariant(master, BASE));

const master2 = [
  "#EXTM3U",
  "#EXT-X-STREAM-INF:BANDWIDTH=1000000",
  "https://example.com/a.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=3000000",
  "https://example.com/b.m3u8"
].join("\n");
assert("picks higher bandwidth on tie", pickHlsVariant(master2, BASE) === "https://example.com/b.m3u8");
assert("empty master -> null", pickHlsVariant("#EXTM3U\n", BASE) === null);

console.log("\n=== pickHlsVariants (ranked list) + I-frame guard ===\n");
const ranked = pickHlsVariants(master, BASE);
assert("returns variants best-first", ranked.length === 3 && ranked[0] === "https://example.com/high.m3u8" && ranked[2] === "https://example.com/mobile.m3u8", JSON.stringify(ranked));
assert("single pick == head of ranked list", pickHlsVariant(master, BASE) === ranked[0]);
assert("empty master -> []", pickHlsVariants("#EXTM3U\n", BASE).length === 0);
const iframeMaster = master + "\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=999999999,RESOLUTION=3840x2160,URI=\"iframe-1080.m3u8\"";
assert("I-FRAME-STREAM-INF lines never become candidates",
  pickHlsVariants(iframeMaster, BASE).every((u) => !/iframe/.test(u)) && pickHlsVariants(iframeMaster, BASE).length === 3,
  JSON.stringify(pickHlsVariants(iframeMaster, BASE)));
assert("master with I-frame lines picks identically to plain master",
  JSON.stringify(pickHlsVariants(iframeMaster, BASE)) === JSON.stringify(pickHlsVariants(master, BASE)));
const tagBeforeUri = [
  "#EXTM3U",
  "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720",
  "#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,URI=\"iframe-720.m3u8\"",
  "video-720.m3u8",
  ""
].join("\n");
assert("tag line where a URI belongs is skipped, next block still parsed",
  JSON.stringify(pickHlsVariants(tagBeforeUri, BASE)) === JSON.stringify(["https://example.com/video-720.m3u8"]),
  JSON.stringify(pickHlsVariants(tagBeforeUri, BASE)));
const iframesOnly = "#EXTM3U\n#EXT-X-I-FRAMES-ONLY\n#EXTINF:6.0,\nseg-0.ts\n";
assert("I-frame-only media playlist flagged", isIFrameOnlyPlaylist(iframesOnly));
assert("normal media playlist not flagged", !isIFrameOnlyPlaylist(playlist) && !isIFrameOnlyPlaylist("#EXTM3U\n"));
assert("null/empty not flagged", !isIFrameOnlyPlaylist(null) && !isIFrameOnlyPlaylist(""));

console.log("\n=== matchHlsMaster (variant/master family) ===\n");
const fam = (u) => (matchHlsMaster(u) || []);
assert("quality-dir variant maps to parent master",
  fam("https://surrit.com/abc/360p/video.m3u8").includes("https://surrit.com/abc/playlist.m3u8"),
  JSON.stringify(fam("https://surrit.com/abc/360p/video.m3u8")));
assert("quality-dir variant also lists master.m3u8/index.m3u8",
  fam("https://surrit.com/abc/720p/video.m3u8").includes("https://surrit.com/abc/master.m3u8") &&
  fam("https://surrit.com/abc/720p/video.m3u8").includes("https://surrit.com/abc/index.m3u8"));
assert("non-quality video.m3u8 maps to same-dir masters",
  fam("https://host/xyz/video.m3u8").includes("https://host/xyz/playlist.m3u8") &&
  fam("https://host/xyz/video.m3u8").includes("https://host/xyz/master.m3u8"),
  JSON.stringify(fam("https://host/xyz/video.m3u8")));
assert("master playback itself is NOT a variant (no candidates)",
  fam("https://surrit.com/abc/playlist.m3u8").length === 0, JSON.stringify(fam("https://surrit.com/abc/playlist.m3u8")));
assert("master.m3u8 itself is NOT a variant",
  fam("https://host/xyz/master.m3u8").length === 0);
assert("mp4 url returns no candidates", fam("https://surrit.com/abc/video.mp4").length === 0);
assert("candidates never include the input url",
  fam("https://surrit.com/abc/360p/video.m3u8").indexOf("https://surrit.com/abc/360p/video.m3u8") === -1);
assert("query/fragment stripped from candidates",
  fam("https://surrit.com/abc/360p/video.m3u8?t=1").every((c) => !/[?#]/.test(c)));
assert("mux-style variant maps to non-canonical stem master",
  fam("https://test-streams.mux.dev/x36xhzz/x36xhzz_360p.m3u8").includes("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"),
  JSON.stringify(fam("https://test-streams.mux.dev/x36xhzz/x36xhzz_360p.m3u8")));
assert("mux-style 1080p variant maps to stem master",
  fam("https://test-streams.mux.dev/x36xhzz/x36xhzz_1080p.m3u8").includes("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"));
assert("mux-style non-canonical master itself is NOT a variant",
  fam("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8").length === 0,
  JSON.stringify(fam("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8")));
assert("hyphen qualifier variant maps to stem master",
  fam("https://cdn.example/hls/stream-360p.m3u8").includes("https://cdn.example/hls/stream.m3u8"));
assert("4k-dir variant maps to parent master",
  fam("https://surrit.com/abc/4k/video.m3u8").includes("https://surrit.com/abc/playlist.m3u8"),
  JSON.stringify(fam("https://surrit.com/abc/4k/video.m3u8")));
assert("8k-dir variant maps to parent master",
  fam("https://surrit.com/abc/8k/video.m3u8").includes("https://surrit.com/abc/playlist.m3u8"),
  JSON.stringify(fam("https://surrit.com/abc/8k/video.m3u8")));
assert("2160p-dir variant maps to parent master (regression)",
  fam("https://surrit.com/abc/2160p/video.m3u8").includes("https://surrit.com/abc/playlist.m3u8"),
  JSON.stringify(fam("https://surrit.com/abc/2160p/video.m3u8")));
assert("qhd/wqhd/medium dirs map to parent master",
  fam("https://surrit.com/abc/qhd/video.m3u8").includes("https://surrit.com/abc/playlist.m3u8") &&
  fam("https://surrit.com/abc/wqhd/video.m3u8").includes("https://surrit.com/abc/playlist.m3u8") &&
  fam("https://surrit.com/abc/medium/video.m3u8").includes("https://surrit.com/abc/playlist.m3u8"),
  JSON.stringify([fam("https://surrit.com/abc/qhd/video.m3u8"), fam("https://surrit.com/abc/medium/video.m3u8")]));
assert("4k/8k stem-suffix variant maps to stem master",
  fam("https://cdn.example/hls/movie_4k.m3u8").includes("https://cdn.example/hls/movie.m3u8") &&
  fam("https://cdn.example/hls/movie_8k.m3u8").includes("https://cdn.example/hls/movie.m3u8"),
  JSON.stringify([fam("https://cdn.example/hls/movie_4k.m3u8"), fam("https://cdn.example/hls/movie_8k.m3u8")]));

console.log("\n=== canonicalKeys (rotating signed URLs dedupe) ===\n");
assert("streamtape get_video keys by stable id",
  canonicalKeys("https://streamtape.com/get_video?id=ABC&expires=1&token=x").includes("st:ABC") &&
  canonicalKeys("https://streamtape.com/get_video?id=ABC&expires=2&token=y")[0] === "st:ABC",
  JSON.stringify(canonicalKeys("https://streamtape.com/get_video?id=ABC&expires=2&token=y")));
assert("fstape host also keys by id",
  canonicalKeys("https://fstape.com/get_video?id=ZZZ&token=q").includes("st:ZZZ"));
assert("hls url gets query-insensitive path key",
  canonicalKeys("https://surrit.com/abc/playlist.m3u8?token=1").includes("hls:https://surrit.com/abc/playlist.m3u8") &&
  canonicalKeys("https://surrit.com/abc/playlist.m3u8?token=2")[0] === "hls:https://surrit.com/abc/playlist.m3u8");
assert("tapecontent CDN blob keys by parent dir",
  (() => {
    const k = canonicalKeys("https://908357261.tapecontent.net/radosgw/A/B/file.mp4?stream=1");
    return k.includes("cdn:https://908357261.tapecontent.net/radosgw/A/B/");
  })(), JSON.stringify(canonicalKeys("https://908357261.tapecontent.net/radosgw/A/B/file.mp4?stream=1")));
assert("plain mp4 / page urls have no canonical key",
  canonicalKeys("https://fourhoi.com/dldss-468/preview.mp4").length === 0 &&
  canonicalKeys("https://supjav.com/454435.html").length === 0,
  JSON.stringify(canonicalKeys("https://fourhoi.com/dldss-468/preview.mp4")));
assert("empty input yields no keys", canonicalKeys("").length === 0 && canonicalKeys(null).length === 0);

console.log("\n=== isSignedGetVideoExpired (streamtape get_video returning HTML = expired signed token) ===\n");
const { isSignedGetVideoExpired } = require("./downloader");
const nv = { category: "not-video", message: "Not a video: server returned text/html at https://streamtape.com/get_video?id=ABC&expires=1&ip=x&token=t" };
const exp403 = { status: 403, message: "expired" };
assert("signed streamtape get_video + not-video -> true (the live failure)",
  isSignedGetVideoExpired({ _resolvedUrl: "https://streamtape.com/get_video?id=ABC&expires=1&ip=x&token=t", url: "https://supjav.com/452555.html" }, nv));
assert("fstape get_video + not-video -> true",
  isSignedGetVideoExpired({ _resolvedUrl: "https://fstape.com/get_video?id=Z&expires=2&ip=x&token=t" }, nv));
assert("get_video via item.url (no _resolvedUrl) + not-video -> true",
  isSignedGetVideoExpired({ url: "https://streamtape.com/get_video?id=ABC&expires=1&ip=x&token=t" }, nv));
assert("non-get_video url + not-video -> false",
  !isSignedGetVideoExpired({ _resolvedUrl: "https://fourhoi.com/dldss-468/preview.mp4" }, nv));
assert("non-streamtape host get_video + not-video -> false",
  !isSignedGetVideoExpired({ _resolvedUrl: "https://example.com/get_video?id=ABC" }, nv));
assert("signed get_video + non-not-video error (403 expired) -> false (handled by isExpiredError)",
  !isSignedGetVideoExpired({ _resolvedUrl: "https://streamtape.com/get_video?id=ABC&expires=1&ip=x&token=t" }, exp403));
assert("no error -> false",
  !isSignedGetVideoExpired({ _resolvedUrl: "https://streamtape.com/get_video?id=ABC&expires=1&ip=x&token=t" }, null));

console.log("\n=== enqueue chain dedupe (capture storm -> duplicate, not re-download) ===\n");
(async () => {
  const os = require("os");
  const fsMod = require("fs");
  const pathMod = require("path");
  const tmp = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), "dvw-canon-"));
  const config = Object.assign({}, DEFAULT_CONFIG, {
    downloadDir: tmp, saveHistory: false, thumbnails: false, autoProxy: false,
    proxies: [], concurrency: 0, maxRetries: 0, hostDelayMs: 0
  });
  const dm = new DownloadManager({ config, proxyManager: null, onUpdate: () => {} });
  const a = await dm.enqueue({ url: "https://streamtape.com/get_video?id=DCV221&expires=1&token=aaa" });
  const b = await dm.enqueue({ url: "https://streamtape.com/get_video?id=DCV221&expires=9&token=zzz" });
  assert("same streamtape id captured again while queued -> duplicate, not re-download",
    (dm.items.get(b) || {}).status === "duplicate" && (dm.items.get(b) || {}).duplicate === true,
    JSON.stringify({ a: (dm.items.get(a) || {}).status, b: (dm.items.get(b) || {}).status }));
  const h1 = await dm.enqueue({ url: "https://surrit.com/abc/playlist.m3u8?token=t1" });
  const h2 = await dm.enqueue({ url: "https://surrit.com/abc/playlist.m3u8?token=t2" });
  assert("signed m3u8 re-capture with new token -> duplicate while queued",
    (dm.items.get(h2) || {}).status === "duplicate",
    JSON.stringify({ p1: (dm.items.get(h1) || {}).status, p2: (dm.items.get(h2) || {}).status }));
  const x = await dm.enqueue({ url: "https://fourhoi.com/dldss-468/preview.mp4" });
  const x2 = await dm.enqueue({ url: "https://fourhoi.com/dldss-468/preview.mp4" });
  assert("exact same plain mp4 queued twice -> duplicate",
    (dm.items.get(x2) || {}).status === "duplicate",
    JSON.stringify({ x: (dm.items.get(x) || {}).status, x2: (dm.items.get(x2) || {}).status }));
  const y = await dm.enqueue({ url: "https://streamtape.com/get_video?id=OTHER&expires=1&token=aaa" });
  assert("different streamtape id is NOT a duplicate",
    (dm.items.get(y) || {}).status !== "duplicate",
    JSON.stringify((dm.items.get(y) || {}).status));

  console.log("\n=== on-disk duplicate (file already available) ===\n");
  const realPath = pathMod.join(tmp, "Already Downloaded.mp4");
  fsMod.writeFileSync(realPath, Buffer.alloc(2 * 1024 * 1024, 7));
  const d1 = await dm.enqueue({ url: "https://fourhoi.com/xyz-001/preview.mp4", title: "Already Downloaded" });
  const d1s = (dm.items.get(d1) || {}).status;
  assert("same-title real file on disk -> duplicate, not re-download",
    d1s === "duplicate", JSON.stringify({ status: d1s, file: "Already Downloaded.mp4" }));
  const stubPath = pathMod.join(tmp, "Tiny Stub.mp4");
  fsMod.writeFileSync(stubPath, Buffer.alloc(100));
  const d2 = await dm.enqueue({ url: "https://fourhoi.com/xyz-002/preview.mp4", title: "Tiny Stub" });
  assert("tiny stub (< threshold) does NOT block re-download",
    (dm.items.get(d2) || {}).status !== "duplicate", JSON.stringify({ status: (dm.items.get(d2) || {}).status }));
  fsMod.rmSync(tmp, { recursive: true, force: true });
  console.log("\n=== " + passed + " passed, " + failed + " failed ===\n");
  process.exit(failed ? 1 : 0);
})();

console.log("\n=== stripPngPrefix (tiktokcdn decoy) ===\n");
function pngChunk(type, dataLen) {
  const b = Buffer.alloc(12 + dataLen);
  b.writeUInt32BE(dataLen, 0);
  b.write(type, 4, "ascii");
  return b;
}
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = pngChunk("IHDR", 13); // 25 bytes
const iend = pngChunk("IEND", 0);  // 12 bytes
const video = Buffer.from("MP4VIDEO-AFTER-PNG");
const blob = Buffer.concat([SIG, ihdr, iend, video]);
const stripped = stripPngPrefix(blob);
assert("strips PNG prefix -> video", stripped.toString() === video.toString(), "got: " + stripped.toString().slice(0, 20));
assert("stripped length == video", stripped.length === video.length, stripped.length);

const mp4 = Buffer.from("ftypmp42");
assert("non-PNG buffer untouched", stripPngPrefix(mp4).toString() === "ftypmp42");
const short = Buffer.from([0x89, 0x50]);
assert("short buffer untouched", stripPngPrefix(short).length === 2);
const noEndBlob = Buffer.concat([SIG, ihdr, Buffer.from("tail-bytes")]);
const noEndResult = stripPngPrefix(noEndBlob);
assert("PNG without IEND untouched", noEndResult.equals(noEndBlob), "was modified");

console.log("\n=== isAdSegmentUrl / classifySegments (ad-polluted playslists) ===\n");
const { isAdSegmentUrl, classifySegments } = require("./lib/hls");
const AD_SEGS = [
  "https://p16-ad-site-sign-sg.tiktokcdn.com/ad-site-i18n-sg/0d3d...~tplv-d5opwmad15-ttam-origin.image",
  "https://p19-ad-site-i18n-sg.tiktokcdn.com/ad-site-i18n-sg/abc~tplv-d5opwmad15-ttam-origin.image",
  "https://cdn.x.example/ad-inject/some-image.webp"
];
const REAL_SEGS = [
  "https://v16-webapp-sign-sg.tiktokcdn.com/vod/video/seg000.ts",
  "https://v19-webapp-sign-sg.tiktokcdn.com/vod/video/seg001.ts",
  "https://supjavcdn.example/hls/video-0000.ts",
  "https://cdn.example/hls/stream-0.m4s"
];
assert("ad-site tiktokcdn host matches", AD_SEGS.every(isAdSegmentUrl), AD_SEGS.map(isAdSegmentUrl).join(","));
assert("image-shaped /ad-site- path matches", isAdSegmentUrl("https://a.com/~tplv-x-ttam-origin.image"));
assert("real signed tiktokcdn .ts NOT matched", REAL_SEGS.every((u) => !isAdSegmentUrl(u)), REAL_SEGS.map(isAdSegmentUrl).join(","));
assert("real .m4s NOT matched", !isAdSegmentUrl("https://cdn.example/hls/stream-0.m4s"));
assert("empty/undefined NOT matched", !isAdSegmentUrl("") && !isAdSegmentUrl(null));
assert("mixed classify counts", (() => {
  const c = classifySegments([...AD_SEGS, ...REAL_SEGS]);
  return c.ad === AD_SEGS.length && c.video === REAL_SEGS.length;
})(), JSON.stringify(classifySegments([...AD_SEGS, ...REAL_SEGS])));
