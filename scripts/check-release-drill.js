"use strict";
// Enforces the AGENTS.md release checklist. Three independent gates:
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
//    clones) so `npm run check` never breaks for external reasons; gates 1 and
//    3 need no git and always run.
//
// 3. RUNTIME SCRIPT PACKAGED - lib/cf-fallback.js spawns scripts/cf-browser.js
//    as a separate process at runtime. build.files is an EXPLICIT list (it
//    replaces electron-builder's default "**/*"), so a script that is not
//    listed is simply absent from the installer while the dev tree keeps
//    working - every Cloudflare fallback then dies in spawn() and silently
//    degrades to "requires-browser", exactly the silent-in-dev/absent-in-the-
//    installer class as the ffmpeg bundle in gate 1. The child is a separate
//    process, so the script ships asar-UNPACKED; ws (its only dependency) must
//    be unpacked next to it or the child cannot require it.
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

// Minimal glob matcher for the build lists: "**" crosses path separators,
// "*" does not. Entries are app-dir-relative POSIX-ish paths.
function globToRe(entry) {
  const esc = String(entry).split(path.sep).join("/").replace(/^\.\//, "");
  let re = "";
  for (let i = 0; i < esc.length; i++) {
    const c = esc[i];
    if (c === "*") {
      if (esc[i + 1] === "*") { re += ".*"; i++; } else { re += "[^/]*"; }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

// True when a package.json build list (files / asarUnpack) ships `rel`:
// exact match, a directory entry that contains it, or a glob that matches it.
function listCovers(list, rel) {
  const norm = String(rel).split(path.sep).join("/");
  return (list || []).some((entry) => {
    const e = String(entry).split(path.sep).join("/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (e === norm) return true;
    if (norm.startsWith(e + "/")) return true;
    return e.includes("*") && globToRe(e).test(norm);
  });
}

// ---- gate 3: every runtime-spawned script ships in the installer ----
function checkRuntimeScripts() {
  const build = require("../package.json").build || {};
  const files = build.files || [];
  const unpacked = build.asarUnpack || [];
  const rel = require("../lib/cf-fallback")._internal.SCRIPT_RELATIVE;
  const scriptAbs = path.join(ROOT, rel);
  let bad = false;

  if (!fs.existsSync(scriptAbs)) {
    console.log("FAIL runtime script gate: " + rel + " is missing from the working tree");
    failed = true;
    return;
  }
  if (!listCovers(files, rel)) {
    console.log("FAIL runtime script gate: " + rel + " is not covered by package.json build.files");
    console.log("     lib/cf-fallback.js spawns it as a separate process at runtime, and files is an");
    console.log("     explicit list - the dev tree works, the INSTALLER has no such file and every");
    console.log("     Cloudflare fallback degrades to requires-browser. Add \"" + rel.replace(/\\/g, "/") + "\" to build.files.");
    failed = true;
    bad = true;
  }
  if (!listCovers(unpacked, rel)) {
    console.log("FAIL runtime script gate: " + rel + " is not asar-UNPACKED (package.json build.asarUnpack)");
    console.log("     The child is a separate process: it needs a real file path, not app.asar/" + rel.replace(/\\/g, "/") + ".");
    console.log("     Add \"" + rel.replace(/\\/g, "/") + "\" to build.asarUnpack.");
    failed = true;
    bad = true;
  }
  if (!listCovers(unpacked, "node_modules/ws/index.js")) {
    console.log("FAIL runtime script gate: node_modules/ws is not asar-UNPACKED next to the script");
    console.log("     The child requires ws; from an unpacked path Node cannot see app.asar/node_modules.");
    console.log("     Add \"node_modules/ws/**\" to build.asarUnpack.");
    failed = true;
    bad = true;
  }
  if (!bad) {
    console.log("OK   runtime script gate (" + rel.replace(/\\/g, "/") + " packaged, asar-unpacked with ws)");
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
checkRuntimeScripts();
checkDrillEvidence();
process.exit(failed ? 1 : 0);
