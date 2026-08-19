"use strict";
// Copies the extension source files shared verbatim between the Chrome MV3 build
// (extension/) and the Firefox build (extension-firefox/). Firefox differs only in
// manifest.json (gecko id, event page); background.js/content.js/styles.css must stay
// byte-identical (see AGENTS.md). Run `node sync-extension.js` (or `npm.cmd run sync-ext`)
// after editing any shared extension file, then reload the extension in both browsers.
const fs = require("fs");
const path = require("path");

const SHARED = ["background.js", "content.js", "styles.css"];
const src = path.join(__dirname, "extension");
const dst = path.join(__dirname, "extension-firefox");

let failed = false;
for (const f of SHARED) {
  const s = path.join(src, f);
  const d = path.join(dst, f);
  if (!fs.existsSync(s)) { console.error("MISSING " + s); failed = true; continue; }
  fs.copyFileSync(s, d);
  if (fs.readFileSync(s).equals(fs.readFileSync(d))) {
    console.log("synced " + f);
  } else {
    console.error("FAIL " + f);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);