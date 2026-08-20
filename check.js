"use strict";
// Syntax-check every .js file in the repo: root JS, extension/, extension-firefox/,
// and test-*.js fixtures. Exits non-zero on any failure. Run via `npm.cmd run check`.
// This is the repo's only "lint" — there is no linter/typecheck (see AGENTS.md).
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const files = [];
for (const f of ["main.js", "downloader.js", "proxy.js", "preload.js", "renderer.js", "browser-preload.js", "config.js", "sync-extension.js"]) {
  const p = path.join(__dirname, f);
  if (fs.existsSync(p)) files.push(p);
}
for (const d of ["extension", "extension-firefox"]) {
  const dir = path.join(__dirname, d);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    if (/- Copy/i.test(f)) continue;          // stale backups (see AGENTS.md: ignore)
    if (f.endsWith(".user.js")) continue;    // Tampermonkey userscripts (not CommonJS)
    if (d === "extension-firefox") continue;  // Firefox MV3 bundle (browser ESM; same logic as extension/*.js)
    files.push(path.join(dir, f));
  }
}
for (const f of fs.readdirSync(__dirname)) if (/^test-.*\.js$/.test(f)) files.push(path.join(__dirname, f));

let fail = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    console.log("OK   " + path.relative(__dirname, f));
  } catch (e) {
    console.log("FAIL " + path.relative(__dirname, f));
    fail++;
  }
}
console.log("\n" + (files.length - fail) + " passed, " + fail + " failed (" + files.length + " files)");
process.exit(fail ? 1 : 0);