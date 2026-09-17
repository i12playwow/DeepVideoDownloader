#!/usr/bin/env node
// Regenerates the gitignored test-video.mp4 fixture on demand (npm run fixture).
//
// Why a script: the fixture is a regenerable binary, deliberately untracked
// (see the 1.3.12 fixture-triage bullet in AGENTS.md), and the two opt-in live
// suites that use it each self-provision — but SILENTLY:
//   - test-extension-live.js generates it via ffmpeg when missing and SKIPs
//     the whole suite with one console line when ffmpeg is unavailable
//   - test-engine-regression.js takes the fixture as an argv argument and
//     simply fails if the file is absent
// This script makes the provisioning explicit and loud: same ffmpeg invocation
// (byte-similar testsrc + 440 Hz sine, same codec/rate flags), fail-loud
// diagnostics when ffmpeg is missing, --force to overwrite an existing
// fixture, and `--check` for gates that only want to verify presence.
//
// Usage:
//   npm run fixture                 # create test-video.mp4 if missing
//   npm run fixture -- --force      # regenerate even if it exists
//   npm run fixture -- --check      # exit 0 if present, 1 if missing (no ffmpeg)
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const FIXTURE = path.join(__dirname, "..", "test-video.mp4");
const args = process.argv.slice(2);

if (args.includes("--check")) {
  if (fs.existsSync(FIXTURE)) {
    console.log("OK   test-video.mp4 present (" + fs.statSync(FIXTURE).size + " bytes)");
    process.exit(0);
  }
  console.log("MISS test-video.mp4 absent — run: npm run fixture");
  process.exit(1);
}

if (fs.existsSync(FIXTURE) && !args.includes("--force")) {
  console.log("SKIP test-video.mp4 already exists (" + fs.statSync(FIXTURE).size +
    " bytes) — use --force to regenerate");
  process.exit(0);
}

// Identical flags to test-extension-live.js's silent generator: a 15 s
// testsrc+440 Hz-sine clip, x264/aac at a low bitrate. Any ffmpeg that can
// produce this can produce the suites' fixture, and vice versa.
const r = spawnSync("ffmpeg", [
  "-y", "-f", "lavfi", "-i", "testsrc=duration=15:size=640x480:rate=15",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=15",
  "-c:v", "libx264", "-pix_fmt", "yuv420p",
  "-b:v", "200k", "-maxrate", "200k", "-bufsize", "400k",
  "-c:a", "aac", "-shortest", FIXTURE,
], { stdio: ["ignore", "ignore", "pipe"] });

if (r.status !== 0 || !fs.existsSync(FIXTURE)) {
  const err = (r.stderr || "").toString().trim().split(/\r?\n/).slice(-3).join(" | ");
  console.error("FAIL could not generate test-video.mp4" + (err ? " — " + err : ""));
  if (r.error && r.error.code === "ENOENT") {
    console.error("     ffmpeg was not found on PATH. Install it, or point PATH at");
    console.error("     the bundled binary (vendor/ffmpeg/ffmpeg.exe after npm run dist).");
  }
  process.exit(1);
}
console.log("OK   generated test-video.mp4 (" + fs.statSync(FIXTURE).size + " bytes)");
