// Minimal HTTP server with proper Range support (HEAD + GET Range -> 206).
// Usage: node test-range-server.js [port] [directory]
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.argv[2] || "8001", 10);
const ROOT = path.resolve(process.argv[3] || __dirname);

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404); res.end("not found"); return;
  }
  const size = fs.statSync(filePath).size;
  const range = req.headers.range;

  if (req.method === "HEAD") {
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": size, "Accept-Ranges": "bytes" });
    res.end();
    return;
  }

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] !== "" ? parseInt(m[1], 10) : 0;
    let end = m && m[2] !== "" ? parseInt(m[2], 10) : size - 1;
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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[range-server] http://127.0.0.1:${PORT} serving ${ROOT}`);
});