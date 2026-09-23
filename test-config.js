"use strict";
// Offline tests for config.js (parseConfig / validateConfig / loadConfig).
// Run: node test-config.js   (no Electron, no network required)
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DEFAULT_CONFIG, parseConfig, validateConfig, loadConfig } = require("./config");

let passed = 0, failed = 0;
// Tiny scratch dir for the file round-trips (the loadConfig section below has
// its own tmp; this one lives beside the sections that need it earlier).
const tmp0 = fs.mkdtempSync(path.join(os.tmpdir(), "cfg0-"));
const p0 = (n) => path.join(tmp0, n);
function assert(label, cond, detail) {
  if (cond) { passed++; console.log("  PASS  " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? " -> " + detail : "")); }
}
// Capture console.warn (validateConfig warns on dropped proxies) without polluting output.
function withWarnCapture(fn) {
  const msgs = [];
  const orig = console.warn;
  console.warn = (m) => { msgs.push(m); };
  try { fn(); } finally { console.warn = orig; }
  return msgs;
}

console.log("\n=== parseConfig ===\n");
assert("undefined -> defaults", parseConfig(undefined, DEFAULT_CONFIG).port === 8765);
assert("empty -> defaults", parseConfig("", DEFAULT_CONFIG).downloadDir === DEFAULT_CONFIG.downloadDir);
assert("null -> defaults", parseConfig(null, DEFAULT_CONFIG).proxies.length === 2);
assert("default idleTabMinutes 0", DEFAULT_CONFIG.idleTabMinutes === 0);
assert("BOM stripped", parseConfig("\uFEFF" + JSON.stringify({ port: 9999 }), DEFAULT_CONFIG).port === 9999);
assert("malformed -> defaults", parseConfig("{bad json", DEFAULT_CONFIG).port === 8765);
assert("array root -> defaults", parseConfig("[]", DEFAULT_CONFIG).port === 8765);
const merged = parseConfig(JSON.stringify({ concurrency: 1 }), DEFAULT_CONFIG);
assert("partial merges with defaults", merged.concurrency === 1 && merged.port === 8765);

console.log("\n=== validateConfig ===\n");
const warns = withWarnCapture(() => {
  const c = validateConfig({
    proxies: ["http://127.0.0.1:7890", "ws://127.0.0.1:8765", "socks5://127.0.0.1:1080", "", "nope://x", 42]
  });
  assert("drops ws:// proxy", !c.proxies.includes("ws://127.0.0.1:8765"), JSON.stringify(c.proxies));
  assert("keeps http proxy", c.proxies.includes("http://127.0.0.1:7890"));
  assert("keeps socks5 proxy", c.proxies.includes("socks5://127.0.0.1:1080"));
  assert("drops empty + non-string + bad scheme", c.proxies.length === 2, JSON.stringify(c.proxies));
});
assert("warned for each dropped proxy", warns.length === 2, "got " + warns.length);

const cn = validateConfig({ port: "8765", concurrency: "4", segments: "2" });
assert("coerces port string->number", typeof cn.port === "number" && cn.port === 8765, typeof cn.port);
assert("coerces concurrency string->number", typeof cn.concurrency === "number" && cn.concurrency === 4, cn.concurrency);
assert("coerces segments", cn.segments === 2, cn.segments);

const cb = validateConfig({ autoProxy: true, thumbnails: false, saveHistory: 1 });
assert("keeps true bool", cb.autoProxy === true);
assert("keeps false bool", cb.thumbnails === false);
assert("truthy number -> true", cb.saveHistory === true);

// cfBrowserFallback: the automatic CF-browser-fallback kill switch.
assert("cfBrowserFallback defaults ON", DEFAULT_CONFIG.cfBrowserFallback === true);
const ccf = validateConfig({ cfBrowserFallback: 0 });
assert("cfBrowserFallback 0 -> false (bool coerced)", ccf.cfBrowserFallback === false, ccf.cfBrowserFallback);
const ccfStr = validateConfig({ cfBrowserFallback: "" });
assert("cfBrowserFallback empty string -> false", ccfStr.cfBrowserFallback === false, ccfStr.cfBrowserFallback);
const ccfOff = loadConfig((() => { const f = path.join(os.tmpdir(), "cfg-cfoff.json"); fs.writeFileSync(f, JSON.stringify({ cfBrowserFallback: false })); return f; })());
assert("cfBrowserFallback:false survives loadConfig round-trip", ccfOff.cfBrowserFallback === false, ccfOff.cfBrowserFallback);

const cd = validateConfig({ downloadDir: 0 });
assert("bad downloadDir -> default", cd.downloadDir === DEFAULT_CONFIG.downloadDir);
const cEmpty = validateConfig({ proxies: ["garbage://x", "ftp://y"] });
assert("all-bad proxies -> default list", JSON.stringify(cEmpty.proxies) === JSON.stringify(DEFAULT_CONFIG.proxies), cEmpty.proxies.join(","));

console.log("\n=== validateConfig: cfBrowserFallback ===\n");
assert("defaults to true (fallback on)", DEFAULT_CONFIG.cfBrowserFallback === true);
const cfbOff = validateConfig({ cfBrowserFallback: false });
assert("keeps explicit false", cfbOff.cfBrowserFallback === false);
assert("0 -> false", validateConfig({ cfBrowserFallback: 0 }).cfBrowserFallback === false);
assert("stringy truthy -> true", validateConfig({ cfBrowserFallback: "yes" }).cfBrowserFallback === true);
assert("null passes through unconsumed (consumer gates on !== false)", validateConfig({ cfBrowserFallback: null }).cfBrowserFallback !== false);

console.log("\n=== validateConfig: proxyRules ===\n");
const warnsR = withWarnCapture(() => {
  const cr = validateConfig({
    proxyRules: [
      { host: "supjav.com", proxy: "http://127.0.0.1:7890" },
      { host: "*.mayzaent.com", proxy: "direct" },
      { host: "go.mnaspm.com", proxy: "not-a-proxy" },
      "garbage",
      { host: "", proxy: "direct" },
      { host: "x.com", proxy: 5 }
    ]
  });
  assert("keeps valid host+proxy rule", cr.proxyRules.some((r) => r.host === "supjav.com" && r.proxy === "http://127.0.0.1:7890"));
  assert("keeps direct rule", cr.proxyRules.some((r) => r.host === "*.mayzaent.com" && r.proxy === "direct"));
  assert("drops invalid proxy rule", !cr.proxyRules.some((r) => r.host === "go.mnaspm.com"));
  assert("drops non-object rule", !cr.proxyRules.some((r) => r === "garbage"));
  assert("drops empty-host / bad-proxy rules", cr.proxyRules.length === 2, "len=" + cr.proxyRules.length);
});
assert("warned for invalid proxyRules entries", warnsR.length >= 1, "got " + warnsR.length);

const crNon = validateConfig({ proxyRules: "nope" });
assert("non-array proxyRules -> []", Array.isArray(crNon.proxyRules) && crNon.proxyRules.length === 0);

console.log("\n=== siteRules cf overrides ===\n");
const cs = validateConfig({ siteRules: [
  { host: "supjav.com", folder: "D:/Jav", start: true }, // no cf: rule shape unchanged
  { host: "slowcf.example.com", cf: "cf:off" },          // renderer token string coerces
  { host: "*.always-cf.com", cf: true },
  { host: "junk.example.com", cf: "maybe" },              // garbage token -> dropped
  { host: "num.example.com", cf: 0 },                     // outside the grammar -> dropped (no silent 0->false)
  { host: "", folder: "X" },                              // hostless rule dropped as before
  "garbage"
] });
assert("valid rule keeps host/folder/start", cs.siteRules.some((r) => r.host === "supjav.com" && r.folder === "D:/Jav" && r.start === true));
assert("rule without cf stays cf-less (no key)", cs.siteRules.every((r) => r.host !== "supjav.com" || !("cf" in r)), JSON.stringify(cs.siteRules[0]));
assert("cf:'cf:off' -> false", cs.siteRules.some((r) => r.host === "slowcf.example.com" && r.cf === false));
assert("cf:'cf:on'/true -> true", cs.siteRules.some((r) => r.host === "*.always-cf.com" && r.cf === true));
assert("garbage cf token dropped", cs.siteRules.every((r) => r.host !== "junk.example.com" || !("cf" in r)));
assert("cf:0 dropped (strict grammar, no silent coercion)", cs.siteRules.every((r) => r.host !== "num.example.com" || !("cf" in r)));
assert("hostless + non-object rules dropped", cs.siteRules.length === 5, "len=" + cs.siteRules.length);
const csNon = validateConfig({ siteRules: "nope" });
assert("non-array siteRules -> []", Array.isArray(csNon.siteRules) && csNon.siteRules.length === 0);
fs.writeFileSync(p0("siterule.json"), JSON.stringify({ siteRules: [{ host: "off.example.com", cf: "cf:off" }] }));
assert("siteRules cf token round-trips a file", loadConfig(p0("siterule.json")).siteRules[0].cf === false);

console.log("\n=== loadConfig (real repo config.json) ===\n");
const real = loadConfig(path.join(__dirname, "config.json"));
assert("real config has no ws:// proxy", !real.proxies.includes("ws://127.0.0.1:8765"), JSON.stringify(real.proxies));
assert("real config keeps valid proxies", real.proxies.length >= 2 && real.proxies.includes("socks5://127.0.0.1:1080"), JSON.stringify(real.proxies));
assert("real config port", real.port === 8765, real.port);

console.log("\n=== loadConfig (temp files) ===\n");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
const p = (n) => path.join(tmp, n);
assert("missing file -> defaults", loadConfig(p("missing.json")).port === 8765);
fs.writeFileSync(p("bom.json"), "\uFEFF" + JSON.stringify({ port: 7777 }));
assert("BOM file parsed + validated", loadConfig(p("bom.json")).port === 7777);
fs.writeFileSync(p("bad.json"), "{not valid json");
assert("malformed file -> defaults", loadConfig(p("bad.json")).port === 8765);
fs.writeFileSync(p("partial.json"), JSON.stringify({ concurrency: 5 }));
const partial = loadConfig(p("partial.json"));
assert("partial file merges defaults", partial.concurrency === 5 && partial.port === 8765);
fs.writeFileSync(p("ws.json"), JSON.stringify({ proxies: ["ws://127.0.0.1:8765", "http://h:1"] }));
const fromFile = loadConfig(p("ws.json"));
assert("ws:// dropped from file config", fromFile.proxies.length === 1 && fromFile.proxies[0] === "http://h:1", JSON.stringify(fromFile.proxies));
fs.writeFileSync(p("cf.json"), JSON.stringify({ cfBrowserFallback: false }));
assert("cfBrowserFallback:false persists through a file round-trip", loadConfig(p("cf.json")).cfBrowserFallback === false);
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(tmp0, { recursive: true, force: true });

console.log("\n=== " + passed + " passed, " + failed + " failed ===\n");
process.exit(failed ? 1 : 0);
