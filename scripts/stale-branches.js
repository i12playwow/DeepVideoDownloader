"use strict";
// Stale-branch report: for every remote branch except master, classify how its
// tip relates to master and how long it has been untouched.
//
// Verdicts (in precedence order):
//   merged         tip is an ancestor of master (ordinary merge) -> safe delete
//   tree-identical tip's TREE equals master's TREE (typical squash residue) -> safe delete
//   metadata-drift tree differs only in version metadata (package.json/
//                  package-lock.json version bumps) -> safe delete after eyeball
//   needs-review   unique content not present in master -> do NOT delete
// A branch (any verdict except needs-review) older than STALE_DAYS also gets
// the "stale" flag in the summary.
//
// Modes:
//   node scripts/stale-branches.js            human-readable report
//   node scripts/stale-branches.js --json     machine-readable (for CI summaries)
//   node scripts/stale-branches.js --fail-on-needs-review
//        exit 1 if any branch has unique content (for a CI annotation)
//
// Read-only: runs `git fetch --prune`, `git ls-remote`, `git merge-base`,
// `git diff-tree`, `git diff`, `git log` — never mutates refs.

const { execFileSync } = require("child_process");

const STALE_DAYS = 14;

function git(args, cwd) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...(cwd ? { cwd } : {}),
  }).trim();
}

// The version-metadata files whose sole drift makes a branch deletable.
const METADATA_FILES = new Set(["package.json", "package-lock.json"]);

function isMetadataOnlyDiff(diffText) {
  // diff --git a/<file> b/<file> headers; any non-metadata file -> not metadata
  const files = [...diffText.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]);
  if (files.length === 0) return false; // empty diff is handled by tree compare
  return files.every((f) => METADATA_FILES.has(f.replace(/\\/g, "/")));
}

function classifyBranch(tip, master, cwd) {
  // merged: `git merge-base --is-ancestor tip master` exits 0
  let ancestor = false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", tip, master], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...(cwd ? { cwd } : {}) });
    ancestor = true;
  } catch (e) {
    if (e.status !== 1) throw e;
  }
  if (ancestor) return "merged";

  // tree-identical: same content, no ancestry (squash-merge residue)
  const tipTree = git(["diff-tree", "--format=%T", "--no-commit-id", "-r", tip], cwd);
  const masterTree = git(["diff-tree", "--format=%T", "--no-commit-id", "-r", master], cwd);
  if (tipTree === masterTree) return "tree-identical";

  // metadata-drift: only version metadata differs from master
  const touched = git(["diff", "--name-only", master + ".." + tip], cwd).split("\n").map((f) => f.replace(/\\/g, "/")).filter(Boolean);
  if (touched.length > 0 && touched.every((f) => METADATA_FILES.has(f))) {
    return "metadata-drift";
  }
  return "needs-review";
}

function branchAgeDays(tip, cwd) {
  const ts = git(["log", "-1", "--format=%ct", tip], cwd);
  return Math.max(0, Math.floor((Date.now() / 1000 - Number(ts)) / 86400));
}

function collect() {
  git(["fetch", "--prune", "origin"]);
  const out = git(["ls-remote", "--heads", "origin"]);
  const master = out.split("\n").find((l) => l.endsWith("refs/heads/master"));
  if (!master) throw new Error("no refs/heads/master on origin");
  const masterSha = master.split("\t")[0];
  const branches = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const [sha, ref] = line.split("\t");
    const name = ref.replace("refs/heads/", "");
    if (name === "master") continue;
    branches.push({ name, sha });
  }
  return { masterSha, branches };
}

function report(opts) {
  const { masterSha, branches } = collect();
  const rows = branches.map((b) => {
    let verdict;
    try {
      verdict = classifyBranch(b.sha, masterSha);
    } catch (e) {
      verdict = "needs-review (" + e.message.slice(0, 60) + ")";
    }
    let age = null;
    try { age = branchAgeDays(b.sha, opts.cwd); } catch (e) { age = null; }
    const stale = age !== null && age >= STALE_DAYS;
    return { name: b.name, sha: b.sha.slice(0, 9), verdict, ageDays: age, stale };
  });

  if (opts.json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), master: masterSha.slice(0, 9), staleAfterDays: STALE_DAYS, branches: rows }, null, 2));
  } else {
    console.log("stale-branch report (master " + masterSha.slice(0, 9) + ", stale >= " + STALE_DAYS + "d)");
    if (rows.length === 0) console.log("  no remote branches besides master — clean");
    for (const r of rows) {
      const flag = r.stale ? " [STALE " + r.ageDays + "d]" : "";
      console.log("  " + r.name + " (" + r.sha + "): " + r.verdict + flag);
    }
    const deletable = rows.filter((r) => r.verdict !== "needs-review").length;
    console.log("  summary: " + rows.length + " branch(es), " + deletable + " safe-to-delete candidate(s)");
  }
  if (opts.failOnNeedsReview && rows.some((r) => r.verdict === "needs-review")) {
    console.error("FAIL: branch(es) with unique content need review before any deletion");
    return 1;
  }
  return 0;
}

module.exports = { classifyBranch, STALE_DAYS };

if (require.main === module) {
  const opts = {
    json: process.argv.includes("--json"),
    failOnNeedsReview: process.argv.includes("--fail-on-needs-review"),
  };
  process.exit(report(opts));
}
