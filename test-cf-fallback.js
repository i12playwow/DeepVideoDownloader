"use strict";
// Offline tests for lib/cf-fallback.js and its wiring into lib/http.js
// fetchHtml: challenge detection, the fallback router (page fetches fall
// back, .m3u8 never does, cfFallback:false opts out), the cf-browser child
// bridge protocol (--out - base64 block), failure semantics
// (requires-browser + warmup cooldown), the UI engagement event hook
// (setEventHook: one fire per engagement, observer failures swallowed), and
// regex parity with lib/errors.
// Run: node test-cf-fallback.js   (no Electron, no real browser required)
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log("  PASS  " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? " -> " + detail : "")); }
}

const cf = require("./lib/cf-fallback");
const { isCfChallengeHtml } = require("./lib/errors");
const httpLib = require("./lib/http");
const { fetchHtml } = httpLib;

async function main() {
  console.log("\n=== 1: challenge detection ===\n");
  {
    const challenges = [
      "<title>Just a moment...</title>",
      "<title>Checking your browser before accessing</title>",
      "<div id='challenge-stage'></div>",
      "enable JavaScript and cookies to continue",
      "Attention Required! | Cloudflare",
    ];
    for (const c of challenges) {
      assert("detects: " + c.slice(0, 40), cf.isCfChallengeBody(c));
      // regex parity with lib/errors (same page must trip both modules)
      assert("  parity with lib/errors", isCfChallengeHtml(c));
    }
    const normal = [
      "<html><body><video src='a.mp4'>video page</body></html>",
      "<title>SupJav - Watch Free Jav Online</title>",
      "<a href='/list'>just a moment of browsing</a>",
    ];
    // NOTE: "just a moment" inside arbitrary content WILL trip the regex —
    // that is the lib/errors behavior this fallback intentionally shares
    // (false positives cost one browser round-trip that returns the same
    // page). Assert the known-conservative behavior instead of pretending.
    assert("conservative on 'just a moment' in content (same as lib/errors)", cf.isCfChallengeBody(normal[2]) === isCfChallengeHtml(normal[2]));
    assert("passes real page through", !cf.isCfChallengeBody(normal[0]) && !cf.isCfChallengeBody(normal[1]));
    assert("empty/null safe", !cf.isCfChallengeBody("") && !cf.isCfChallengeBody(null) && !cf.isCfChallengeBody(undefined));
  }

  console.log("\n=== 2: fetchHtml router (local fixture server) ===\n");
  {
    const CHALLENGE = "<html><head><title>Just a moment...</title></head><body>cf</body></html>";
    const REAL = "<html><body><a href='/v/1'>item</a></body></html>";
    const served = [];
    const srv = http.createServer((req, res) => {
      served.push(req.url);
      if (req.url === "/challenged.m3u8") {
        res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
        res.end("#EXTM3U\n#EXT-X-TARGETDURATION:10\n");
      } else if (req.url === "/challenge" || req.url.startsWith("/challenge-fail")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(CHALLENGE);
      } else if (req.url === "/normal") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(REAL);
      } else { res.writeHead(404); res.end("no"); }
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const base = "http://127.0.0.1:" + srv.address().port;

    // capture what the fallback module hands to the browser bridge
    const calls = [];
    const origBridge = cf._state.fetchViaCfBrowser;
    cf._state.fetchViaCfBrowser = async (url) => {
      calls.push(url);
      if (String(url).includes("fail")) throw new Error("stub browser failure");
      return REAL; // stub browser returns the real page
    };
    cf._state.lastWarmupFail = 0;

    const got = await fetchHtml(base + "/challenge", null);
    assert("challenge page -> fallback engaged", calls.length === 1 && calls[0] === base + "/challenge", "calls=" + JSON.stringify(calls));
    assert("fallback HTML returned to caller", got === REAL, "got=" + String(got).slice(0, 40));

    served.length = 0;
    const plain = await fetchHtml(base + "/normal", null);
    assert("normal page -> no fallback", calls.length === 1 && plain === REAL);

    const m3u8 = await fetchHtml(base + "/challenged.m3u8", null);
    assert(".m3u8 challenge -> NO fallback (raw text preserved)", calls.length === 1 && m3u8.startsWith("#EXTM3U"), "m3u8=" + m3u8.slice(0, 12));

    const opted = await fetchHtml(base + "/challenge", null, {}, 0, 3, { cfFallback: false });
    assert("cfFallback:false opts out (challenge body returned as-is)", calls.length === 1 && opted === CHALLENGE);

    // failure semantics: bridge failure -> requires-browser (contract held at
    // the router boundary even though the stub throws a plain error)
    cf._state.lastWarmupFail = 0;
    let threw = null;
    try { await fetchHtml(base + "/challenge-fail", null); } catch (e) { threw = e; }
    assert("bridge failure -> requires-browser category", threw && threw.category === "requires-browser", "cat=" + (threw && threw.category));

    // ---- install-wide kill switch (cfBrowserFallback config toggle) ----
    // Disabled: the router must return challenge bodies untouched and never
    // reach the bridge (no browser window, no spawn — config off means off).
    cf._state.lastWarmupFail = 0;
    const hookCalls = [];
    cf.setEventHook((u) => hookCalls.push(u));
    httpLib.setFallbackEnabled(false);
    calls.length = 0;
    const disabledBody = await fetchHtml(base + "/challenge", null);
    assert("disabled router returns challenge body untouched", disabledBody === CHALLENGE, "got=" + String(disabledBody).slice(0, 30));
    assert("disabled router never reaches the bridge", calls.length === 0, "calls=" + JSON.stringify(calls));
    assert("disabled router never fires the toast hook", hookCalls.length === 0, "fired=" + JSON.stringify(hookCalls));

    // re-enabled: the exact same request routes to the bridge again
    httpLib.setFallbackEnabled(true);
    calls.length = 0;
    const reEnabled = await fetchHtml(base + "/challenge", null);
    assert("re-enabled router routes to the bridge again", calls.length === 1 && reEnabled === REAL, "calls=" + JSON.stringify(calls));
    assert("re-enabled router fires the toast hook", hookCalls.length === 1, "fired=" + JSON.stringify(hookCalls));
    cf.setEventHook(null);

    cf._state.fetchViaCfBrowser = origBridge;
    cf._state.lastWarmupFail = 0;
    srv.close();

    // cooldown is a REAL-bridge behavior: point scriptPath at a failing stub
    // and verify the second immediate call is suppressed without spawning
    const failStub = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cfb-cd-")), "fail.js");
    fs.writeFileSync(failStub, "process.exit(9);");
    cf._state.scriptPath = failStub;
    cf._state.timeoutMs = 10000;
    cf._state.lastWarmupFail = 0;
    let spawned = 0;
    const origExec = cf._state.execCfBrowserFetch;
    cf._state.execCfBrowserFetch = (...a) => { spawned++; return origExec(...a); };
    threw = null;
    try { await cf.fetchViaCfBrowser("https://example.test/cd-a"); } catch (e) { threw = e; }
    assert("real bridge failure -> requires-browser", threw && threw.category === "requires-browser", "cat=" + (threw && threw.category));
    assert("real bridge spawned once", spawned === 1, "spawned=" + spawned);
    threw = null;
    try { await cf.fetchViaCfBrowser("https://example.test/cd-b"); } catch (e) { threw = e; }
    assert("cooldown suppresses immediate re-warm (no spawn)", threw && threw.category === "requires-browser" && spawned === 1, "spawned=" + spawned);
    cf._state.execCfBrowserFetch = origExec;
    delete cf._state.scriptPath;
    delete cf._state.timeoutMs;
    cf._state.lastWarmupFail = 0;
  }

  console.log("\n=== 3: child bridge protocol (stub cf-browser scripts) ===\n");
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-test-"));
    const stub = path.join(tmp, "stub-cf-browser.js");
    // Emits stderr noise + the ---CFB64--- block, exit 0
    fs.writeFileSync(stub, `
      console.error("[cf] noise line");
      const html = "<html><body>STUB-RENDER-" + process.argv[2].slice(-4) + "</body></html>";
      process.stdout.write("---CFB64---" + Buffer.from(html, "utf8").toString("base64") + "\\n");
      process.exit(0);
    `);
    cf._state.scriptPath = stub;
    cf._state.timeoutMs = 15000;
    cf._state.lastWarmupFail = 0;

    const html = await cf.fetchViaCfBrowser("https://example.test/page-xyz1");
    assert("stub bridge decodes base64 HTML block", html === "<html><body>STUB-RENDER-xyz1</body></html>", "got=" + String(html).slice(0, 60));

    // failure exit code -> requires-browser
    const stubFail = path.join(tmp, "stub-fail.js");
    fs.writeFileSync(stubFail, `console.error("boom"); process.exit(3);`);
    cf._state.scriptPath = stubFail;
    let threw = null;
    try { await cf.fetchViaCfBrowser("https://example.test/fail"); } catch (e) { threw = e; }
    assert("nonzero child exit -> requires-browser", threw && threw.category === "requires-browser", "cat=" + (threw && threw.category));

    // missing marker -> requires-browser
    const stubNoMarker = path.join(tmp, "stub-nomarker.js");
    fs.writeFileSync(stubNoMarker, `console.log("plain stdout junk"); process.exit(0);`);
    cf._state.scriptPath = stubNoMarker;
    threw = null;
    try { await cf.fetchViaCfBrowser("https://example.test/junk"); } catch (e) { threw = e; }
    assert("missing CFB64 marker -> requires-browser", threw && threw.category === "requires-browser", "cat=" + (threw && threw.category));

    // hanging child -> killed at timeoutMs -> requires-browser
    const stubHang = path.join(tmp, "stub-hang.js");
    fs.writeFileSync(stubHang, `setInterval(()=>{}, 1000);`);
    cf._state.scriptPath = stubHang;
    cf._state.timeoutMs = 1200;
    threw = null;
    const t0 = Date.now();
    try { await cf.fetchViaCfBrowser("https://example.test/hang"); } catch (e) { threw = e; }
    assert("hanging child killed at timeout -> requires-browser", threw && threw.category === "requires-browser", "cat=" + (threw && threw.category));
    assert("timeout actually enforced (~1.2s, not 120s)", Date.now() - t0 < 10000, "took=" + (Date.now() - t0) + "ms");

    // serialization: two concurrent calls must not overlap (chain order)
    const stubSlow = path.join(tmp, "stub-slow.js");
    fs.writeFileSync(stubSlow, `
      setTimeout(() => {
        process.stdout.write("---CFB64---" + Buffer.from("<html>SLOW-DONE</html>", "utf8").toString("base64") + "\\n");
        process.exit(0);
      }, 300);
    `);
    cf._state.scriptPath = stubSlow;
    cf._state.timeoutMs = 15000;
    cf._state.lastWarmupFail = 0;
    const pair = await Promise.all([
      cf.fetchViaCfBrowser("https://example.test/slow-a"),
      cf.fetchViaCfBrowser("https://example.test/slow-b"),
    ]);
    assert("concurrent calls serialized through one chain", pair[0] === "<html>SLOW-DONE</html>" && pair[1] === "<html>SLOW-DONE</html>");

    fs.rmSync(tmp, { recursive: true, force: true });
    delete cf._state.scriptPath;
    delete cf._state.timeoutMs;
  }

  console.log("\n=== 4: fetchPageWithFallback guard rails ===\n");
  {
    const orig = cf._state.fetchViaCfBrowser;
    let bridgeCalls = 0;
    cf._state.fetchViaCfBrowser = async () => { bridgeCalls++; return "<html>ok</html>"; };
    const out1 = await cf.fetchPageWithFallback("https://x.test/a", "<html>normal</html>");
    assert("non-challenge body passes through untouched", out1 === "<html>normal</html>" && bridgeCalls === 0);
    const out2 = await cf.fetchPageWithFallback("https://x.test/b", "<title>Just a moment...</title>");
    assert("challenge body routes to bridge", out2 === "<html>ok</html>" && bridgeCalls === 1);
    cf._state.fetchViaCfBrowser = orig;
  }

  console.log("\n=== 5: engagement event hook (setEventHook -> renderer toast) ===\n");
  {
    const orig = cf._state.fetchViaCfBrowser;
    cf._state.fetchViaCfBrowser = async () => "<html>ok</html>";
    cf._state.lastWarmupFail = 0;

    // exactly one fire per engagement, with the URL handed over
    let fired = [];
    cf.setEventHook((url) => fired.push(url));
    await cf.fetchPageWithFallback("https://x.test/hook-a", "<title>Just a moment...</title>");
    assert("hook fires once on engagement", fired.length === 1 && fired[0] === "https://x.test/hook-a", "fired=" + JSON.stringify(fired));

    // pass-through (non-challenge) must stay silent
    fired = [];
    await cf.fetchPageWithFallback("https://x.test/hook-b", "<html>normal</html>");
    assert("hook silent on non-challenge pass-through", fired.length === 0, "fired=" + JSON.stringify(fired));

    // an engagement that then fails still fired (the user must be told why a
    // browser window opened, even when the fallback cannot finish)
    cf._state.fetchViaCfBrowser = async () => { throw new Error("stub boom"); };
    fired = [];
    let threw = null;
    try { await cf.fetchPageWithFallback("https://x.test/hook-c", "<title>Just a moment...</title>"); } catch (e) { threw = e; }
    assert("hook fired before bridge failure (user still informed)", fired.length === 1 && threw && threw.category === "requires-browser", "fired=" + JSON.stringify(fired));

    // a throwing observer must never break or delay the fetch path
    cf._state.fetchViaCfBrowser = async () => "<html>ok</html>";
    cf.setEventHook(() => { throw new Error("observer exploded"); });
    const out3 = await cf.fetchPageWithFallback("https://x.test/hook-d", "<title>Just a moment...</title>");
    assert("throwing observer does not break the fetch", out3 === "<html>ok</html>");

    // clearing the hook goes back to fully silent
    cf.setEventHook(null);
    fired = [];
    await cf.fetchPageWithFallback("https://x.test/hook-e", "<title>Just a moment...</title>");
    assert("cleared hook (null) is silent", fired.length === 0, "fired=" + JSON.stringify(fired));

    cf._state.fetchViaCfBrowser = orig;
    cf._state.lastWarmupFail = 0;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
