"use strict";
// Offline tests for lib/cf-fallback.js and its wiring into lib/http.js
// fetchHtml: challenge detection, the fallback router (page fetches fall
// back, .m3u8 never does, cfFallback:false opts out), the cf-browser child
// bridge protocol (--out - base64 block), failure semantics
// (requires-browser + warmup cooldown), and regex parity with lib/errors.
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
const { fetchHtml } = require("./lib/http");

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

  console.log("\n=== 5: packaged layout (script resolution, child env, packaging lists) ===\n");
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-pack-"));

    // The bridge runs the script as a SEPARATE process, so a packaged build
    // must hand it a real path: scripts/cf-browser.js ships asar-unpacked and
    // the unpacked twin wins when it exists; dev runs (no process.resourcesPath)
    // use the repo-relative path that resolveScriptPath() also exposes as SCRIPT.
    assert("SCRIPT_RELATIVE names the runtime script",
      cf._internal.SCRIPT_RELATIVE === path.join("scripts", "cf-browser.js"),
      "got=" + cf._internal.SCRIPT_RELATIVE);
    assert("dev SCRIPT is the tracked script on disk",
      cf._internal.SCRIPT === path.join(__dirname, "scripts", "cf-browser.js") && fs.existsSync(cf._internal.SCRIPT),
      "got=" + cf._internal.SCRIPT);

    const fakeResources = path.join(tmp, "resources");
    const fakeLib = path.join(fakeResources, "app.asar", "lib");
    const inAsar = path.join(fakeResources, "app.asar", "scripts", "cf-browser.js");
    const devResolved = cf._internal.resolveScriptPath({ dirname: fakeLib, resourcesPath: undefined });
    assert("no resourcesPath (dev) -> repo-relative path", devResolved === inAsar, "got=" + devResolved);
    const asarResolved = cf._internal.resolveScriptPath({ dirname: fakeLib, resourcesPath: fakeResources });
    assert("packaged, no unpacked twin -> app.asar path (asar-aware child)", asarResolved === inAsar, "got=" + asarResolved);

    const fakeUnpacked = path.join(fakeResources, "app.asar.unpacked", "scripts", "cf-browser.js");
    fs.mkdirSync(path.dirname(fakeUnpacked), { recursive: true });
    fs.writeFileSync(fakeUnpacked, "// stub");
    const packedResolved = cf._internal.resolveScriptPath({ dirname: fakeLib, resourcesPath: fakeResources });
    assert("packaged -> asar-unpacked twin preferred", packedResolved === fakeUnpacked, "got=" + packedResolved);

    // The child is spawned via process.execPath, which inside the app is
    // electron.exe: ELECTRON_RUN_AS_NODE makes it the plain Node runtime the
    // script needs instead of a SECOND Electron app. Proved on the wire by a
    // stub child that echoes its own environment.
    const envStub = path.join(tmp, "stub-env.js");
    fs.writeFileSync(envStub, [
      "const html = '<html>node=' + String(process.env.ELECTRON_RUN_AS_NODE) + '</html>';",
      "process.stdout.write('---CFB64---' + Buffer.from(html, 'utf8').toString('base64'));",
      "process.exit(0);",
    ].join("\n"));
    cf._state.scriptPath = envStub;
    cf._state.timeoutMs = 15000;
    cf._state.lastWarmupFail = 0;
    const envHtml = await cf.fetchViaCfBrowser("https://example.test/env");
    assert("child spawned as plain Node (ELECTRON_RUN_AS_NODE=1)", envHtml === "<html>node=1</html>", "got=" + envHtml);
    delete cf._state.scriptPath;
    delete cf._state.timeoutMs;
    cf._state.lastWarmupFail = 0;

    // Packaging lists: the runtime script must ship inside the installer
    // (build.files) as a real file (build.asarUnpack) with its only dependency
    // ws unpacked next to it. check-release-drill.js enforces the same rule on
    // every `npm run check`; these pins keep the expectation beside the code
    // that needs it.
    const build = require("./package.json").build || {};
    const fileList = (build.files || []).map(String);
    const unpackList = (build.asarUnpack || []).map(String);
    assert("build.files ships the runtime script", fileList.includes("scripts/cf-browser.js"), "files=" + fileList.join(","));
    assert("build.asarUnpack ships it as a real file", unpackList.includes("scripts/cf-browser.js"), "unpack=" + unpackList.join(","));
    assert("build.asarUnpack ships ws with it", unpackList.some((e) => e.startsWith("node_modules/ws")), "unpack=" + unpackList.join(","));

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
