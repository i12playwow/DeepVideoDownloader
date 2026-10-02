"use strict";
// Offline tests for scripts/jav-dl.js — the JAV-code CLI's seams that the boot
// drill can only reach end-to-end. Run: node test-jav-dl.js (pure Node; the
// only network is loopback: the surrit-relay selftest + one local origin).
//
// Covers:
//   1 parseArgs        — flag/positional grammar incl. --no-fallback/--no-relay
//   2 normalizeCode    — code -> slug
//   3 buildQueue       — positionals + --from-file dedupe, missing-file error
//   4 relayUrl/unrelayUrl — path-embedded rewrite round-trip (the Phase M wire
//                        format) incl. the no-relay-listening passthrough
//   5 urlSlug          — m3u8 -> output basename
//   6 python-engine seams — JAVDL_PY env contract + argv shapes (the engine-
//                        exhaustion fallback must hand --url the UN-relayed
//                        upstream), availability probing
//   7 runPyEngine/pyFallback — real stub engines: success, exit-3, missing
//                        engine/interpreter, the hang guard, per-code
//                        idempotence + re-arm across codes
//   8 relayEnabled     — --no-relay flag + JAVDL_RELAY=0|false|force
//   9 LIVE relay selftest + reuse contract — python scripts/surrit-relay.py
//                        --selftest must pass, a live relay must forward to a
//                        local origin, and ensureRelay() must ADOPT an already-
//                        listening relay (stopRelay() leaves it alive — only a
//                        relay the CLI spawned dies with it).

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const m = require("./scripts/jav-dl.js");
const I = m._internals;

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log("  PASS  " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? " -> " + detail : "")); }
}
function section(name) { console.log("\n=== " + name + " ===\n"); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "javdl-test-"));
// Saved FIRST so every restore below puts back exactly what the caller had —
// including PATH, which section 7 deliberately clobbers to prove the
// missing-interpreter path, and which a naive process.env.PATH read after the
// clobber could not restore.
const ENV_KEYS = ["JAVDL_PY", "JAVDL_RELAY", "JAVDL_RELAY_PORT", "JAVDL_RELAY_HOSTS", "PATH", "PROBE"];
const envSaved = {};
for (const k of ENV_KEYS) { envSaved[k] = process.env[k]; }
// JAVDL_* start clean; PATH stays live — sections 7/9 spawn real interpreters.
for (const k of ["JAVDL_PY", "JAVDL_RELAY", "JAVDL_RELAY_PORT", "JAVDL_RELAY_HOSTS", "PROBE"]) {
  if (k in process.env) delete process.env[k];
}
const PYTHON = process.platform === "win32" ? "python" : "python3"; // probed in section 7

// ------------------------------------------------------------------ 1 parse
section("1: parseArgs");
{
  const a = m.parseArgs(["ipz-721", "midv-832"]);
  assert("positionals", a.codes.length === 2 && a.codes[0] === "ipz-721" && a.codes[1] === "midv-832");
  const b = m.parseArgs(["--url", "https://surrit.com/x/playlist.m3u8", "-o", "k.mp4", "--quality", "480", "--limit", "3", "--retry-wait-min", "5"]);
  assert("valued flags", b.url === "https://surrit.com/x/playlist.m3u8" && b.out === "k.mp4"
    && b.quality === "480" && b.limit === 3 && b.retryWaitMin === 5);
  const c = m.parseArgs(["--list-only", "--force", "--no-fallback", "--no-relay", "--from-file", "q.txt"]);
  assert("boolean flags", c.listOnly && c.force && c.noFallback && c.noRelay && c.fromFile === "q.txt");
  assert("defaults", m.parseArgs([]).quality === "best" && m.parseArgs([]).noRelay === false
    && m.parseArgs([]).noFallback === false);
}

// ------------------------------------------------------------ 2 normalizeCode
section("2: normalizeCode");
assert("case + space -> dash", m.normalizeCode("IPZ 721") === "ipz-721");
assert("trim + punctuation", m.normalizeCode("  bvd--777!! ") === "bvd-777");
{
  let threw = false;
  try { m.normalizeCode("   "); } catch (e) { threw = true; }
  assert("empty throws", threw);
}

// ---------------------------------------------------------------- 3 buildQueue
section("3: buildQueue");
{
  const list = path.join(tmp, "q.txt");
  fs.writeFileSync(list, "b\n# comment\n\nc\nb\n");
  const q = m.buildQueue(["a", "--from-file", list]);
  assert("positional + file, deduped in order", JSON.stringify(q) === JSON.stringify(["a", "b", "c"]));
  let threw = false;
  try { m.buildQueue(["--from-file", path.join(tmp, "nope.txt")]); } catch (e) { threw = true; }
  assert("missing list file throws", threw);
}

// ------------------------------------------------------- 4 relayUrl/unrelayUrl
section("4: relayUrl <-> unrelayUrl round-trip");
{
  const master = "https://surrit.com/bdd77700-1111-2222-3333-444444444444/playlist.m3u8";
  assert("https rewrite", I.relayUrl(master, 8931)
    === "http://127.0.0.1:8931/https/surrit.com/bdd77700-1111-2222-3333-444444444444/playlist.m3u8");
  assert("query preserved", I.relayUrl("http://h.example/p?x=1", 5)
    === "http://127.0.0.1:5/http/h.example/p?x=1");
  assert("bare origin gets a path", I.relayUrl("https://surrit.com", 5)
    === "http://127.0.0.1:5/https/surrit.com/");
  assert("non-http scheme untouched", I.relayUrl("ftp://h/p", 5) === "ftp://h/p");
  assert("no port + no live relay = passthrough", I.relayUrl(master) === master);
  assert("round-trip restores scheme+authority",
    I.unrelayUrl(I.relayUrl(master, 8931)) === master);
  assert("unrelay keeps host port + query",
    I.unrelayUrl("http://127.0.0.1:5/http/h.example:8443/p?x=1") === "http://h.example:8443/p?x=1");
  assert("unrelay of a bare-origin rewrite",
    I.unrelayUrl("http://127.0.0.1:5/https/surrit.com/") === "https://surrit.com/");
  assert("unrelay passthrough for non-relay URLs",
    I.unrelayUrl("https://surrit.com/u/playlist.m3u8") === "https://surrit.com/u/playlist.m3u8");
}

// ------------------------------------------------------------------ 5 urlSlug
section("5: urlSlug");
assert("surrit uuid segment", I.urlSlug("https://surrit.com/bdd77700-1111-2222-3333-444444444444/playlist.m3u8")
  === "bdd77700-1111-2222-3333-444444444444");
assert("first path segment", I.urlSlug("https://example.com/a/b/c.m3u8") === "a");
assert("empty path -> stream", I.urlSlug("https://example.com") === "stream");
assert("garbage -> stream", I.urlSlug("not a url") === "stream");
assert("percent-decoding", I.urlSlug("https://x.example/caf%C3%A9/v.m3u8") === "caf\u00e9");

// ----------------------------------------------------- 6 python-engine seams
section("6: JAVDL_PY env contract + argv shapes");
{
  const stub = path.join(tmp, "engine.py");
  fs.writeFileSync(stub, "# stub\n");
  process.env.JAVDL_PY = stub;
  assert("explicit path", I.pyEnginePath() === stub);
  assert("available when the file exists", I.pyEngineAvailable() === true);
  process.env.JAVDL_PY = path.join(tmp, "missing-engine.py");
  assert("unavailable when the file is missing", I.pyEngineAvailable() === false);
  process.env.JAVDL_PY = stub;

  const out = path.join(tmp, "x.mp4");
  const a = I.pyEngineArgs({ code: "ipz-721" }, out);
  assert("code-mode argv", a[0] === stub
    && JSON.stringify(a.slice(1)) === JSON.stringify(["ipz-721", "-o", out, "--force"]));
  // The engine-exhaustion fallback for --url mode must hand the engine the
  // TRUE upstream, never a relay-rewritten loopback URL (this process's relay
  // dies with the run; the engine must fetch surrit directly).
  const relayed = "http://127.0.0.1:8931/https/surrit.com/uuid/playlist.m3u8";
  const b = I.pyEngineArgs({ url: relayed }, out);
  assert("url-mode argv un-relays the m3u8", JSON.stringify(b.slice(1)) === JSON.stringify(
    ["--url", "https://surrit.com/uuid/playlist.m3u8", "-o", out, "--force"]));

  process.env.JAVDL_PY = "0";
  assert("JAVDL_PY=0 disables the stage", I.pyFallbackEnabled() === false && I.pyEngineAvailable() === false);
  process.env.JAVDL_PY = "false";
  assert("JAVDL_PY=false disables the stage", I.pyFallbackEnabled() === false);
  process.env.JAVDL_PY = stub;
  assert("any other value enables", I.pyFallbackEnabled() === true);
  delete process.env.JAVDL_PY;
  assert("default path is absolute", path.isAbsolute(I.pyEnginePath()));
  process.env.JAVDL_PY = stub;
}

// ------------------------------------------------ 7 runPyEngine / pyFallback
async function testPyFallback() {
  section("7: runPyEngine / pyFallback against stub engines");
  const mkStub = (body) => {
    const p = path.join(tmp, "stub-" + Math.random().toString(36).slice(2) + ".py");
    fs.writeFileSync(p, body);
    return p;
  };

  const good = mkStub([
    "import sys",
    "out = sys.argv[sys.argv.index('-o') + 1]",
    "open(out, 'wb').write(b'PYENGINE-STUB' * 40)",
  ].join("\n") + "\n");
  process.env.JAVDL_PY = good;
  const out1 = path.join(tmp, "ok-001.mp4");
  const ok = await I.pyFallback({ code: "ok-001" }, {}, tmp);
  assert("success -> true + file on disk", ok === true && fs.existsSync(out1) && fs.statSync(out1).size > 0);

  // Per-code idempotence: processCode's resolve-miss hook AND the queue loop's
  // not-found branch both fire for one failed code — the engine must run ONCE.
  const probe = path.join(tmp, "probe.log");
  const counting = mkStub([
    "import sys, os",
    "open(os.environ['PROBE'], 'a').write(sys.argv[1] + '\\n')",
    "sys.exit(3)",
  ].join("\n") + "\n");
  process.env.JAVDL_PY = counting;
  process.env.PROBE = probe;
  const r1 = await I.pyFallback({ code: "fb-001" }, {}, tmp);
  const r2 = await I.pyFallback({ code: "fb-001" }, {}, tmp);
  const lines = fs.existsSync(probe) ? fs.readFileSync(probe, "utf8").trim().split("\n") : [];
  assert("failure -> false, engine ran exactly once", r1 === false && r2 === false
    && lines.filter((l) => l === "fb-001").length === 1, JSON.stringify(lines));
  const r3 = await I.pyFallback({ code: "fb-002" }, {}, tmp);
  assert("a failed attempt re-arms for the next code", r3 === false
    && fs.readFileSync(probe, "utf8").includes("fb-002"));
  delete process.env.PROBE;

  const missing = mkStub("# never runs\n");
  fs.unlinkSync(missing);
  process.env.JAVDL_PY = missing;
  const r4 = await I.pyFallback({ code: "fb-003" }, {}, tmp);
  assert("missing engine file -> clean false", r4 === false);

  // The hang guard: a wedged engine must be killed at the timeout, not left to
  // wait out a download-sized budget.
  const hanging = mkStub("import time\ntime.sleep(60)\n");
  process.env.JAVDL_PY = hanging;
  const t0 = Date.now();
  const r5 = await I.runPyEngine({ code: "hang-001" }, path.join(tmp, "hang-001.mp4"), 1500);
  const dt = Date.now() - t0;
  assert("timeout guard kills a hung engine", r5.ok === false && /timed out/.test(r5.err || "") && dt < 10000,
    "dt=" + dt + "ms err=" + String(r5.err || "").slice(0, 60));

  // A missing INTERPRETER (not a missing script) must surface the same way.
  process.env.JAVDL_PY = good;
  process.env.PATH = "";
  const r6 = await I.runPyEngine({ code: "nopy-001" }, path.join(tmp, "nopy-001.mp4"), 15000);
  assert("missing python interpreter -> clean false, no crash", r6.ok === false);
  process.env.PATH = envSaved.PATH; // restored by the final loop anyway
  delete process.env.JAVDL_PY;
}

// -------------------------------------------------------------- 8 relayEnabled
async function testRelayEnabled() {
  section("8: relayEnabled (--no-relay flag + JAVDL_RELAY env)");
  assert("default on", I.relayEnabled({}) === true);
  assert("--no-relay wins", I.relayEnabled({ noRelay: true }) === false);
  process.env.JAVDL_RELAY = "0";
  assert("JAVDL_RELAY=0 disables", I.relayEnabled({}) === false);
  process.env.JAVDL_RELAY = "false";
  assert("JAVDL_RELAY=false disables", I.relayEnabled({}) === false);
  process.env.JAVDL_RELAY = "force";
  assert("JAVDL_RELAY=force still enabled", I.relayEnabled({}) === true);
  assert("force + --no-relay still off", I.relayEnabled({ noRelay: true }) === false);
  delete process.env.JAVDL_RELAY;
  // The documented CLI spelling must actually reach the flag.
  assert("--no-relay parses through", m.parseArgs(["--no-relay"]).noRelay === true);
}

// ------------------------------------------ 9 LIVE relay selftest + lifecycle
async function testRelayLive() {
  section("9: live surrit-relay selftest + ensureRelay/stopRelay reuse contract");
  const relay = path.join(__dirname, "scripts", "surrit-relay.py");
  const py = process.platform === "win32" ? "python" : "python3";
  const st = spawnSync(py, [relay, "--selftest"], { encoding: "utf8", timeout: 60000 });
  assert("python --selftest passes", st.status === 0 && /selftest OK/.test(st.stdout || ""),
    "status=" + st.status + " out=" + String(st.stdout || "").slice(-120) + String(st.stderr || "").slice(-120));

  // Local origin the relay will forward to.
  const origin = http.createServer((req, res) => {
    if (req.url === "/missing") { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("gone"); return; }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("GET " + req.url + "\nuser-agent: " + (req.headers["user-agent"] || "")
      + "\naccept-encoding: " + (req.headers["accept-encoding"] || "") + "\n");
  });
  await new Promise((r) => origin.listen(0, "127.0.0.1", r));
  const originPort = origin.address().port;
  const freePort = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const child = spawn(py, [relay, "--port", String(freePort), "--allow", "127.0.0.1"], { stdio: ["ignore", "pipe", "pipe"] });
  let banner = "";
  child.stdout.on("data", (c) => { banner += c; });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await sleep(200); up = /listening on/.test(banner); }
  assert("relay listening banner", up, banner.slice(-120));
  if (up) {
    const get = (p) => new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port: freePort, path: p, timeout: 8000 }, (res) => {
        let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, body: b }));
      });
      req.on("error", (e) => resolve({ status: -1, body: String(e) }));
    });
    const fwd = await get("/http/127.0.0.1:" + originPort + "/hello?x=1");
    assert("relay forwards to a local origin", fwd.status === 200 && /GET \/hello\?x=1/.test(fwd.body), fwd.body.slice(0, 120));
    assert("upstream shape pinned (identity encoding)", /accept-encoding: identity/.test(fwd.body), fwd.body.slice(0, 160));
    const nf = await get("/http/127.0.0.1:" + originPort + "/missing");
    assert("status passthrough", nf.status === 404 && nf.body === "gone", JSON.stringify(nf));
    const denied = await get("/http/evil.example.com/x");
    assert("allowlist fails closed", denied.status === 403, "status=" + denied.status);

    // THE reuse contract (Phase M, as a unit test): an already-listening relay
    // is ADOPTED on the configured port, never respawned — and stopRelay()
    // must leave an adopted relay alive (only a self-spawned one is killed).
    process.env.JAVDL_RELAY_PORT = String(freePort);
    const port = await I.ensureRelay(10000);
    assert("ensureRelay adopts the live port", port === freePort, "got " + port + " want " + freePort);
    assert("adopted relay survived the run so far", child.exitCode === null);
    I.stopRelay();
    await sleep(300);
    assert("stopRelay does NOT kill an adopted relay", child.exitCode === null);
    delete process.env.JAVDL_RELAY_PORT;
  }
  try { child.kill(); } catch (e) { /* best effort */ }
  origin.close();
}

(async () => {
  await testPyFallback();
  await testRelayEnabled();
  await testRelayLive();
})().then(() => {
  // Restore the caller's env (the suite mutated it heavily).
  for (const k of ENV_KEYS) {
    if (envSaved[k] === undefined) delete process.env[k];
    else process.env[k] = envSaved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error("SUITE ERROR: " + ((e && e.stack) || e));
  process.exit(1);
});
