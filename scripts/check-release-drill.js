"use strict";
// Enforces the AGENTS.md release checklist: a commit that bumps the package
// version must carry a link to a green boot-verify drill run (local output or
// a CI run URL). The offline gates never boot the app, so the drill is the
// only real-app gate. Skips gracefully when git history is unavailable
// (shallow CI clones) so `npm run check` never breaks for external reasons.
// NOTE: regexes deliberately use [0-9]/[ ]/[.] classes - no backslash escapes.
const { execFileSync } = require("child_process");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: __dirname + "/..", encoding: "utf8" }).trim();
  } catch (e) {
    return null; // no git / shallow clone / bare env: skip enforcement
  }
}

const current = require("../package.json").version;

// Did HEAD's diff to its parent touch the "version" field?
const diff = git(["diff", "HEAD~1", "HEAD", "-U0", "--", "package.json"]);
if (diff == null) {
  console.log("SKIP release-drill gate (git history unavailable)");
  process.exit(0);
}
const versionTouched = /^[-+] *"version":/m.test(diff);
if (!versionTouched) {
  console.log("OK   release-drill gate (version not bumped in HEAD)");
  process.exit(0);
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
  process.exit(0);
}
console.log("FAIL release-drill gate: version bump " + (oldVersion ? oldVersion + " -> " : "to ") + current +
  " without a green boot-verify drill (AGENTS.md release checklist).");
console.log("     Include one in the commit message:");
console.log("       - a CI run URL: https://github.com/<owner>/<repo>/actions/runs/<id>");
console.log("       - or a local-run marker: drill: 8 checks: 8 passed, 0 failed (exit 0)");
process.exit(1);
