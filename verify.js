const fs = require("fs");
const p = "C:\\dvdbak\\dist\\win-unpacked\\resources\\app.asar";
const buf = fs.readFileSync(p);
const s = buf.toString("ascii", 0, 200);
const jsonStart = s.indexOf('{"files');
let headerSize = 0;
for (const off of [4,8,12]) {
  const cand = buf.readUInt32LE(off);
  try { const t = buf.toString("utf8", jsonStart, jsonStart + cand); if (t.trim().endsWith("}")) { headerSize = cand; break; } } catch(e){}
}
let dataStart = jsonStart + headerSize;
while (buf[dataStart] === 0) dataStart++;
const header = JSON.parse(buf.toString("utf8", jsonStart, jsonStart + headerSize));
function walk(node, path, out) {
  if (node.files) { for (const k of Object.keys(node.files)) walk(node.files[k], path + "/" + k, out); }
  else out.push({ path: path.slice(1), off: node.offset, size: node.size });
}
const files = []; walk(header, "", files);
const bh = files.find(f => f.path === "browser.html");
const content = buf.toString("utf8", dataStart + bh.off, dataStart + bh.off + bh.size);
console.log("browser.html length:", content.length, "has <webview>:", content.includes("<webview"), "has reportContentRect:", content.includes("reportContentRect"));
const mh = files.find(f => f.path === "main.js");
const mc = buf.toString("utf8", dataStart + mh.off, dataStart + mh.off + mh.size);
console.log("main.js has BrowserView:", mc.includes("BrowserView"), "has bv-content-rect:", mc.includes("bv-content-rect"));
