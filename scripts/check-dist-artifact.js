"use strict";
// Gate wired into `npm run dist`: proves the installer build actually carried
// the bundled ffmpeg. electron-builder exits 0 even when an extraResources
// source is missing (it only logs "file source doesn't exist"), which is
// exactly how 1.3.10's first installer silently shipped without ffmpeg.
// Acceptance: resources/ffmpeg.exe exists in win-unpacked and is > 50 MB
// (the real binary is ~98 MB; a shim or placeholder is far smaller).
const fs = require("fs");
const path = require("path");

const ffmpegPath = path.join("dist", "win-unpacked", "resources", "ffmpeg.exe");
const MIN_BYTES = 52428800; // 50 MB

if (!fs.existsSync(ffmpegPath)) {
  console.error(`FAIL dist-artifact gate: ${ffmpegPath} is missing — the installer shipped WITHOUT bundled ffmpeg.`);
  console.error(`  Restore the bundle source (vendor/ffmpeg/ffmpeg.exe) and rebuild: npm run dist`);
  process.exit(1);
}

const size = fs.statSync(ffmpegPath).size;
if (size < MIN_BYTES) {
  console.error(`FAIL dist-artifact gate: ${ffmpegPath} is only ${size} bytes (expected > ${MIN_BYTES}) — likely a shim or truncated copy, not the real binary.`);
  process.exit(1);
}

console.log(`OK   dist-artifact gate (${ffmpegPath} present, ${(size / 1048576).toFixed(1)} MB)`);
