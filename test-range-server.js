// Minimal HTTP server with proper Range support (HEAD + GET Range -> 206).
// Usage: node test-range-server.js [port] [directory]
// Self-test (no server left running, exits nonzero on any failure):
//        node test-range-server.js --selftest
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SELF_TEST = process.argv.includes("--selftest");
const PORT = parseInt(process.argv[2] || "8001", 10);
const ROOT = path.resolve(process.argv[3] || __dirname);

function createServer(root) {
  return http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const filePath = path.join(root, urlPath);
    let stat;
    try { stat = fs.statSync(filePath); } catch {}
    if (!filePath.startsWith(root) || !stat || stat.isDirectory()) {
      res.writeHead(404); res.end("not found"); return;
    }
    const size = stat.size;
    const range = req.headers.range;

    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": size, "Accept-Ranges": "bytes" });
      res.end();
      return;
    }

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start, end;
      if (m && m[1] === "") {
        // suffix-byte-range-spec (RFC 7233 §2.1): "bytes=-N" = final N bytes
        const n = m[2] !== "" ? parseInt(m[2], 10) : NaN;
        start = isNaN(n) || n <= 0 ? size : Math.max(size - n, 0);
        end = size - 1;
      } else {
        start = m && m[1] !== "" ? parseInt(m[1], 10) : 0;
        end = m && m[2] !== "" ? parseInt(m[2], 10) : size - 1;
      }
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= size) end = size - 1;
      if (start > end) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return; }
      res.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes"
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": size, "Accept-Ranges": "bytes" });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function runSelfTest() {
  let pass = 0, fail = 0;
  const ok = (label, cond, detail) => {
    if (cond) { pass++; console.log("PASS " + label); }
    else { fail++; console.log("FAIL " + label + (detail ? " -> " + detail : "")); }
  };

  // Hard deadline: a stalled response must FAIL the suite, never hang `npm test`.
  const DEADLINE_MS = 20000;
  const deadline = setTimeout(() => {
    console.log("FAIL self-test timed out after " + DEADLINE_MS + "ms (server hang?)");
    process.exit(1);
  }, DEADLINE_MS);

  // deterministic fixture: 1000 bytes, value = index & 0xff
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dgb-range-selftest-"));
  const data = Buffer.alloc(1000);
  for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
  const fixtureName = "/fixture.bin";
  const fixture = path.join(dir, fixtureName);
  fs.writeFileSync(fixture, data);
  const size = data.length;

  const server = createServer(dir);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;

  // agent:false so each connection closes when the response ends (no keep-alive
  // sockets pinning server.close() open)
  const req = (opts) => new Promise((resolve, reject) => {
    const r = http.request(Object.assign({ host: "127.0.0.1", port, agent: false }, opts), (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on("error", reject);
    r.end();
  });

  try {
    // HEAD
    const head = await req({ method: "HEAD", path: fixtureName });
    ok("HEAD -> 200", head.status === 200, "status=" + head.status);
    ok("HEAD Accept-Ranges: bytes", head.headers["accept-ranges"] === "bytes", "ar=" + head.headers["accept-ranges"]);
    ok("HEAD Content-Length matches file", parseInt(head.headers["content-length"], 10) === size, "len=" + head.headers["content-length"]);

    // no-Range GET -> 200 full body
    const whole = await req({ method: "GET", path: fixtureName });
    ok("plain GET -> 200 full length", whole.status === 200 && whole.body.length === size && whole.body.equals(data), "status=" + whole.status + " len=" + whole.body.length);

    // exact-range GET
    const part = await req({ method: "GET", path: fixtureName, headers: { Range: "bytes=100-199" } });
    ok("exact Range -> 206", part.status === 206, "status=" + part.status);
    ok("Content-Range exact", part.headers["content-range"] === `bytes 100-199/${size}`, "cr=" + part.headers["content-range"]);
    ok("payload length 100", part.body.length === 100, "len=" + part.body.length);
    ok("payload byte-exact", part.body.equals(data.subarray(100, 200)));

    // suffix-byte-range-spec (the RFC 7233 regression fixed 2026-09-04)
    const tail = await req({ method: "GET", path: fixtureName, headers: { Range: "bytes=-9" } });
    ok("suffix Range -> 206 with final 9 bytes", tail.status === 206 && tail.body.length === 9, "status=" + tail.status + " len=" + tail.body.length);
    ok("suffix Content-Range exact", tail.headers["content-range"] === `bytes ${size - 9}-${size - 1}/${size}`, "cr=" + tail.headers["content-range"]);
    ok("suffix payload byte-exact", tail.body.equals(data.subarray(size - 9, size)));

    // suffix larger than the file -> whole file
    const bigTail = await req({ method: "GET", path: fixtureName, headers: { Range: "bytes=-99999" } });
    ok("oversized suffix Range -> whole file", bigTail.status === 206 && bigTail.body.length === size, "status=" + bigTail.status + " len=" + bigTail.body.length);
    ok("oversized suffix byte-exact", bigTail.body.equals(data));

    // open-ended range
    const open = await req({ method: "GET", path: fixtureName, headers: { Range: "bytes=0-" } });
    ok("open-ended Range -> 206 full length", open.status === 206 && open.body.length === size && open.body.equals(data), "status=" + open.status + " len=" + open.body.length);

    // missing file
    const miss = await req({ method: "GET", path: "/nope.bin" });
    ok("missing file -> 404", miss.status === 404, "status=" + miss.status);

    // out-of-bounds absolute range -> 416 with total size
    const oob = await req({ method: "GET", path: fixtureName, headers: { Range: `bytes=${size}-${size + 50}` } });
    ok("out-of-bounds Range -> 416", oob.status === 416, "status=" + oob.status);
    ok("416 carries total Content-Range", oob.headers["content-range"] === `bytes */${size}`, "cr=" + oob.headers["content-range"]);

    // invalid suffix syntax "bytes=-" -> 416
    const bad = await req({ method: "GET", path: fixtureName, headers: { Range: "bytes=-" } });
    ok("empty suffix spec -> 416", bad.status === 416, "status=" + bad.status);

    // directory path -> 404
    const dirProbe = await req({ method: "GET", path: "/" });
    ok("directory -> 404", dirProbe.status === 404, "status=" + dirProbe.status);
  } catch (e) {
    fail++;
    console.log("FAIL self-test request error: " + e.message);
  }

  clearTimeout(deadline);

  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n=== self-test: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

if (SELF_TEST) {
  runSelfTest().catch((e) => { console.error("self-test crashed: " + e.stack); process.exit(1); });
} else {
  const server = createServer(ROOT);
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[range-server] http://127.0.0.1:${PORT} serving ${ROOT}`);
  });
}
