"use strict";
// Offline tests for scripts/stale-branches.js classifyBranch: verdict tiers
// (merged / tree-identical / metadata-drift / needs-review) against REAL temp
// git repos built per-case, so the git plumbing is exercised for true, not
// mocked. Run: node test-stale-branches.js   (no network required)
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { classifyBranch, STALE_DAYS } = require("./scripts/stale-branches");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try {
    const ok = typeof fn === "function" ? fn() : fn;
    if (ok !== true) throw new Error("expected true, got " + ok);
    pass++; console.log("  PASS " + name);
  }
  catch (e) { fail++; console.error("  FAIL " + name + ": " + e.message); }
};

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}
function write(dir, file, content) {
  fs.writeFileSync(path.join(dir, file), content);
}
function commitAll(dir, msg) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", msg]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stale-branches-"));

console.log("\n=== STALE_DAYS constant ===\n");
t("stale threshold is 14 days", () => STALE_DAYS === 14);

console.log("\n=== merged: tip is an ancestor of master ===\n");
{
  const d = path.join(tmp, "merged");
  initRepo(d);
  write(d, "a.txt", "one\n");
  commitAll(d, "base");
  git(d, ["checkout", "-q", "-b", "feature"]);
  write(d, "feat.txt", "feat\n");
  commitAll(d, "feature work");
  git(d, ["checkout", "-q", "master"]);
  git(d, ["merge", "-q", "--no-ff", "-m", "merge feature", "feature"]);
  const featureTip = git(d, ["rev-parse", "feature"]);
  const masterTip = git(d, ["rev-parse", "master"]);
  t("ancestor tip -> merged", classifyBranch(featureTip, masterTip, d) === "merged");
}

console.log("\n=== tree-identical: squash-merge residue (no ancestry, same tree) ===\n");
{
  const d = path.join(tmp, "squashed");
  initRepo(d);
  write(d, "app.js", "v1\n");
  commitAll(d, "base");
  git(d, ["checkout", "-q", "-b", "feat-x"]);
  write(d, "app.js", "v2\n");
  commitAll(d, "feat work");
  const featTip = git(d, ["rev-parse", "feat-x"]);
  // squash-merge: new commit on master with the SAME tree, no ancestry
  git(d, ["checkout", "-q", "master"]);
  git(d, ["checkout", "-q", "-b", "tmp-squash", featTip]);
  git(d, ["checkout", "-q", "master"]);
  git(d, ["read-tree", "-u", "--reset", "tmp-squash^{tree}"]);
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "feat work (squashed) (#1)"]);
  git(d, ["branch", "-q", "-D", "tmp-squash"]);
  const masterTip = git(d, ["rev-parse", "master"]);
  t("identical tree, no ancestry -> tree-identical", classifyBranch(featTip, masterTip, d) === "tree-identical");
}

console.log("\n=== metadata-drift: only package.json/lock version differ ===\n");
{
  const d = path.join(tmp, "metadata");
  initRepo(d);
  write(d, "app.js", "v1\n");
  write(d, "package.json", '{\n  "name": "x",\n  "version": "1.0.0"\n}\n');
  write(d, "package-lock.json", '{\n  "version": "1.0.0"\n}\n');
  commitAll(d, "base");
  git(d, ["checkout", "-q", "-b", "release-1.0.1"]);
  write(d, "package.json", '{\n  "name": "x",\n  "version": "1.0.1"\n}\n');
  commitAll(d, "version bump");
  const featTip = git(d, ["rev-parse", "release-1.0.1"]);
  // master stays at 1.0.0 (release branch not yet merged) -> drift only in metadata
  const masterTip = git(d, ["rev-parse", "master"]);
  t("version-only diff -> metadata-drift", classifyBranch(featTip, masterTip, d) === "metadata-drift");

  // but a branch touching a real file must NOT be metadata-drift
  write(d, "app.js", "v2\n");
  commitAll(d, "real change too");
  const featTip2 = git(d, ["rev-parse", "release-1.0.1"]);
  t("code + metadata diff -> needs-review", classifyBranch(featTip2, masterTip, d) === "needs-review");
}

console.log("\n=== needs-review: unique content ===\n");
{
  const d = path.join(tmp, "unique");
  initRepo(d);
  write(d, "a.txt", "one\n");
  commitAll(d, "base");
  git(d, ["checkout", "-q", "-b", "wip"]);
  write(d, "wip.txt", "unmerged\n");
  commitAll(d, "wip");
  const wipTip = git(d, ["rev-parse", "wip"]);
  const masterTip = git(d, ["rev-parse", "master"]);
  t("unique file -> needs-review", classifyBranch(wipTip, masterTip, d) === "needs-review");
  t("master vs itself -> merged", classifyBranch(masterTip, masterTip, d) === "merged");
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
