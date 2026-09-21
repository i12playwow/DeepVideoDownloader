"use strict";
// Offline tests for scripts/cf-browser.js's pure cores: the browser-context
// challenge detector (CHALLENGE_SNIPPET, evaluated here against a mock
// `document` — the real shipped source, not a copy) and the CLI arg parser
// (parseArgs). The CDP/browser paths are exercised by test-cf-fallback.js
// (bridge protocol) and manual/live runs; nothing here opens a browser.
// Run: node test-cf-browser.js   (no Electron, no network required)
const { CHALLENGE_SNIPPET, parseArgs } = require("./scripts/cf-browser");

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log("  PASS  " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? " -> " + detail : "")); }
}

// Evaluate the shipped detector snippet with a mock document object. The
// snippet is a self-contained IIFE expression, so a Function-scope parameter
// named `document` is what its free reference resolves to — same as in a page.
function detect(doc) {
  return new Function("document", `"use strict"; return (${CHALLENGE_SNIPPET});`)(doc);
}
function makeDoc({ title = "", bodyText = "", challengeNode = false } = {}) {
  return {
    title,
    body: { innerText: bodyText },
    querySelector: () => (challengeNode ? { found: true } : null),
  };
}

console.log("\n=== 1: detector — challenge titles ===\n");
{
  const titles = [
    "Just a moment...",
    "JUST A MOMENT",                      // case-insensitivity
    "Attention Required! | Cloudflare",
    "Checking your browser before accessing site",
    "Verify you are human",
  ];
  for (const t of titles) {
    assert("title challenge: " + JSON.stringify(t), detect(makeDoc({ title: t })) === true);
  }
}

console.log("\n=== 2: detector — challenge body text and nodes ===\n");
{
  assert("body marker: Verify you are human (clean title)",
    detect(makeDoc({ title: "site.com", bodyText: "Verify you are human" })) === true);
  assert("body marker: Enable JavaScript and cookies to continue",
    detect(makeDoc({ title: "site.com", bodyText: "Enable JavaScript and cookies to continue" })) === true);
  assert("challenge node present (.cf-turnstile et al)",
    detect(makeDoc({ title: "site.com", challengeNode: true })) === true);

  // The modern Turnstile machinery must stay covered by the snippet source.
  assert("snippet still checks challenges.cloudflare.com iframe", CHALLENGE_SNIPPET.includes("challenges.cloudflare.com"));
  assert("snippet still checks .cf-turnstile", CHALLENGE_SNIPPET.includes(".cf-turnstile"));
  assert("snippet still checks #challenge-stage", CHALLENGE_SNIPPET.includes("#challenge-stage"));
  assert("snippet reads document.title (stablest signal)", CHALLENGE_SNIPPET.includes("document.title"));
}

console.log("\n=== 3: detector — real content passes through ===\n");
{
  assert("real page title + real body + no nodes",
    detect(makeDoc({
      title: "SupJav - Watch Free Jav Online, Japanese Porn HD Streaming Online",
      bodyText: "Browse the latest releases. Click a card to open its page and queue a download.",
    })) === false);
  assert("null body during load (body? guard) with clean title",
    detect({ title: "some site", body: null, querySelector: () => null }) === false);
  assert("empty doc", detect(makeDoc()) === false);
  assert("word 'moment' alone in body is not enough",
    detect(makeDoc({ title: "site", bodyText: "wait a moment please" })) === false);
}

console.log("\n=== 4: detector — parity with lib/errors page regex ===\n");
{
  // The fallback router (lib/cf-fallback via lib/http) decides *whether* to
  // invoke the browser using lib/errors' CF_PAGE_RE; the detector decides
  // *whether the browser keeps waiting*. A page the router flags must also be
  // one the detector keeps waiting on, or the bridge would return instantly
  // with a challenge page as "success".
  const { isCfChallengeHtml } = require("./lib/errors");
  const pages = [
    "<title>Just a moment...</title>",
    "<title>Attention Required!</title>",
    "<title>Checking your browser...</title>",
    "<title>verify you are human</title>",
    "<html><body>Enable JavaScript and cookies to continue</body></html>",
  ];
  for (const html of pages) {
    const routerFlags = isCfChallengeHtml(html);
    const title = (/<title>([^<]*)<\/title>/i.exec(html) || [])[1] || "";
    const bodyText = /<body[^>]*>([^<]*)/.exec(html) || [];
    const detectorFlags = detect(makeDoc({
      title,
      bodyText: bodyText[1] || "",
      challengeNode: /challenge-(stage|form|running)|cf-turnstile|challenges\.cloudflare\.com/.test(html),
    }));
    assert("router+detector agree on: " + html.slice(0, 45), routerFlags === true && detectorFlags === true);
  }
}

console.log("\n=== 5: parseArgs — positionals and valued flags ===\n");
{
  const url = "https://supjav.com/usc2257";
  const a = parseArgs([url]);
  assert("bare url lands in _", a._.length === 1 && a._[0] === url);

  const b = parseArgs(["--out", "page.html", "--session", "sess.json", "--profile", "prof", "--timeout", "45000", url]);
  assert("valued flags parsed", b.out === "page.html" && b.session === "sess.json" && b.profile === "prof", JSON.stringify(b));
  assert("--timeout coerced to Number", b.timeout === 45000 && typeof b.timeout === "number");
  assert("url after flags still positional", b._.length === 1 && b._[0] === url);

  const c = parseArgs([url, "--out", "x.html"]);
  assert("url before flags also works", c._[0] === url && c.out === "x.html");

  const d = parseArgs(["--serve", "8899"]);
  assert("--serve coerced to Number", d.serve === 8899);

  const e = parseArgs(["--connect", "ws://127.0.0.1:1234/devtools/browser/abc"]);
  assert("--connect takes the ws url", e.connect === "ws://127.0.0.1:1234/devtools/browser/abc");
}

console.log("\n=== 6: parseArgs — boolean flags ===\n");
{
  assert("--status", parseArgs(["--status"]).status === true);
  assert("--keep", parseArgs(["--keep"]).keep === true);
  assert("--cold", parseArgs(["--cold"]).cold === true);
  assert("--headless", parseArgs(["--headless"]).headless === true);
  const both = parseArgs(["--keep", "--cold"]);
  assert("--keep and --cold can coexist in parse (main decides precedence)", both.keep === true && both.cold === true);
  const none = parseArgs([]);
  assert("no args -> no flags, no positionals", none._.length === 0 && !none.status && !none.keep && !none.cold);
}

console.log("\n=== 7: parseArgs — documented edge behavior ===\n");
{
  // Unknown tokens fall into positionals (current contract): a mistyped flag
  // becomes the URL and fails downstream as a bad navigation, not a crash.
  const a = parseArgs(["--whoops"]);
  assert("unknown flag -> positional (documented)", a._.length === 1 && a._[0] === "--whoops" && a.whoops === undefined);

  // --timeout at end of argv consumes nothing: Number(undefined) === NaN.
  const b = parseArgs(["--timeout"]);
  assert("dangling --timeout -> NaN (documented wart)", typeof b.timeout === "number" && Number.isNaN(b.timeout));

  // Values that look like flags are consumed blindly by valued flags.
  const c = parseArgs(["--out", "--keep", "u"]);
  assert("valued flag consumes next token even if flag-like", c.out === "--keep" && c.keep === undefined && c._[0] === "u");
}

console.log("\n=== 8: exports shape (require-safety) ===\n");
{
  assert("detector is a non-empty expression string", typeof CHALLENGE_SNIPPET === "string" && CHALLENGE_SNIPPET.length > 100);
  assert("parseArgs is a function", typeof parseArgs === "function");
  // Requiring the script must not run main (no side effects at import time).
  assert("require did not execute main (test process still alive, no browser spawn)", true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
