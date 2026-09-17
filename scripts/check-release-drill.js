"use strict";
// Enforces the AGENTS.md release checklist. Two independent gates:
//
// 1. BUNDLE SOURCE - the tracked ffmpeg binary is the ONLY source of the
//    resources/ffmpeg.exe that ships in the installer (package.json
//    build.extraResources), and electron-builder exits 0 when that source is
//    missing (it only logs "file source doesn't exist") - that is how 1.3.10
//    shipped ffmpeg-less. scripts/check-dist-artifact.js catches the ARTIFACT,
//    but only at the end of a full `npm run dist`; this gate catches the SOURCE
//    where it is cheap, so `npm run check` cannot stay green while the shipped
//    ffmpeg's only source is gone. Nothing offline checked it until 2026-09-15,
//    when vendor/ffmpeg/ffmpeg.exe was deleted in a working tree and both
//    `npm run check` and `npm test` passed (check.js only syntax-checks JS).
//    Acceptance is deliberately the same rule as the artifact-side twin -
//    exists, and > 50 MB - so the two gates can never disagree.
//
// 2. DRILL EVIDENCE - a commit that bumps the package version must carry a link
//    to a green boot-verify drill run (local output or a CI run URL). The
//    offline gates never boot the app, so the drill is the only real-app gate.
//    This gate skips gracefully when git history is unavailable (shallow CI
//    clones) so `npm run check` never breaks for external reasons; gate 1 needs
//    no git and always runs.
// NOTE: regexes deliberately use [0-9]/[ ]/[.] classes - no backslash escapes.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const MIN_BUNDLE_BYTES = 52428800; // 50 MB (check-dist-artifact.js uses the same)

let failed = false;

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch (e) {
    return null; // no git / shallow clone / bare env: skip enforcement
  }
}

// ---- gate 1: every extraResources source exists and is the real binary ----
function checkBundleSource() {
  const extra = (require("../package.json").build || {}).extraResources || [];
  const sources = extra.map((e) => (typeof e === "string" ? e : e && e.from)).filter(Boolean);
  if (!sources.length) {
    console.log("OK   bundle source gate (no extraResources to verify)");
    return;
  }
  for (const rel of sources) {
    const p = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    if (!fs.existsSync(p)) {
      console.log("FAIL bundle source gate: " + rel + " is missing");
      console.log("     It is the only source of the resources/ffmpeg.exe the installer ships");
      console.log("     (package.json build.extraResources) and electron-builder exits 0 without it.");
      console.log("     Restore the tracked binary: git checkout -- " + rel);
      failed = true;
      continue;
    }
    const size = fs.statSync(p).size;
    if (size < MIN_BUNDLE_BYTES) {
      console.log("FAIL bundle source gate: " + rel + " is only " + size + " bytes (expected > " + MIN_BUNDLE_BYTES + ")");
      console.log("     Likely a shim, placeholder or truncated copy - not the real binary.");
      failed = true;
      continue;
    }
    console.log("OK   bundle source gate (" + rel + " present, " + (size / 1048576).toFixed(1) + " MB)");
  }
}

// ---- gate 2: a version bump carries proof of a green boot-verify drill ----
function checkDrillEvidence() {
  const current = require("../package.json").version;

  // Did HEAD's diff to its parent touch the "version" field?
  const diff = git(["diff", "HEAD~1", "HEAD", "-U0", "--", "package.json"]);
  if (diff == null) {
    console.log("SKIP release-drill gate (git history unavailable)");
    return;
  }
  const versionTouched = /^[-+] *"version":/m.test(diff);
  if (!versionTouched) {
    console.log("OK   release-drill gate (version not bumped in HEAD)");
    return;
  }

  const mOld = /^- *"version": *"([^"]+)"/m.exec(diff);
  const oldVersion = mOld ? mOld[1] : null;
  const msg = git(["log", "-1", "--format=%B"]) || "";

  // Accepted evidence of a green drill, per AGENTS.md:
  //  - a GitHub Actions run URL for this repo (watched through to success)
  //  - a `drill:` marker quoting the drill's summary with equal pass counts
  //    and at least 8 checks (today's drill prints "8 checks: 8 passed, 0 failed")
  const hasCiRunUrl = /github[.]com[/][^/ ]+[/][^/ ]+[/]actions[/]runs[/][0-9]+/i.test(msg);
  const mLocal = /drill:[ ]+[^ ]/.test(msg) && /([0-9]+) *checks?: *([0-9]+) *passed, *0 *failed/i.exec(msg);
  const hasLocalProof = !!(mLocal && Number(mLocal[1]) === Number(mLocal[2]) && Number(mLocal[1]) >= 8);

  if (hasCiRunUrl || hasLocalProof) {
    console.log("OK   release-drill gate (v" + oldVersion + " -> " + current + " has a linked drill run)");
    return;
  }
  console.log("FAIL release-drill gate: version bump " + (oldVersion ? oldVersion + " -> " : "to ") + current +
    " without a green boot-verify drill (AGENTS.md release checklist).");
  console.log("     Include one in the commit message:");
  console.log("       - a CI run URL: https://github.com/<owner>/<repo>/actions/runs/<id>");
  console.log("       - or a local-run marker: drill: 8 checks: 8 passed, 0 failed (exit 0)");
  failed = true;
}

checkBundleSource();
checkDrillEvidence();
process.exit(failed ? 1 : 0);
