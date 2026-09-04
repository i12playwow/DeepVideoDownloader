// Minimal static server for the renderer demo preview. Serves the project root
// (script lives in .freebuff/) so styles.css / renderer.js / demo-api-shim.js
// load as real files. Binds 127.0.0.1:8123 (walks up to :8173 if busy).
// Logs "LISTENING http://127.0.0.1:<port>/" once up; the preview registers that.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json"
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch (e) { res.writeHead(400).end(); return; }
  if (urlPath === "/") urlPath = "/demo-renderer.html";
  const filePath = path.join(ROOT, urlPath);
  // Containment via path.relative, not string prefix: a sibling directory
  // whose absolute path starts with ROOT (e.g. "deep-video-downloader-bak")
  // would satisfy a startsWith(ROOT) check after %2e%2e traversal. relative()
  // escapes that class and every other outside path deterministically.
  const rel = path.relative(ROOT, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) { res.writeHead(403); res.end("forbidden"); return; }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end("not found"); return; }
    const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": st.size
    });
    if (req.method === "HEAD") { res.end(); return; }
    fs.createReadStream(filePath).pipe(res);
  });
});

function listen(port, attempts) {
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE" && attempts < 50) { listen(port + 1, attempts + 1); return; }
    console.error("demo-server failed on port " + port + ": " + e.message);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log("LISTENING http://127.0.0.1:" + server.address().port + "/");
  });
}
listen(8123, 0);
