"use strict";
// Offline tests for proxy.js: matchHost patterns + ProxyManager.pickBest rules.
// Run: node test-proxy.js   (no Electron, no network — testLatency is mocked)
const { ProxyManager, matchHost, parseProxyUrl } = require("./proxy");

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log("  PASS  " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? " -> " + detail : "")); }
}

console.log("\n=== matchHost ===\n");
assert("exact match", matchHost("supjav.com", "supjav.com"));
assert("exact case-insensitive", matchHost("Supjav.COM", "supjav.com"));
assert("exact non-match", !matchHost("supjav.com", "sextb.com"));
assert("*.suffix matches subdomain", matchHost("*.mayzaent.com", "go.mayzaent.com"));
assert("*.suffix matches root", matchHost("*.mayzaent.com", "mayzaent.com"));
assert("*.suffix no-match", !matchHost("*.mayzaent.com", "go.other.com"));
assert("glob matches", matchHost("*.example.*", "a.example.b"));
assert("regex matches", matchHost("/^go\\./", "go.mayzaent.com"));
assert("regex no-match", !matchHost("/^nx\\./", "go.mayzaent.com"));
assert("empty pattern no-match", !matchHost("", "host.com"));

// Build a ProxyManager with a mocked proxy pool + latency (no real network).
function makePM(rules, pool, deadUrls) {
  const pm = new ProxyManager({ proxies: pool, proxyRules: rules, autoProxy: true });
  pm.list = () => pool.map(parseProxyUrl).filter(Boolean);
  pm.testLatency = async (p) => (deadUrls && deadUrls.has(p.url)) ? null : { ms: 5, status: 200 };
  return pm;
}
const urlOf = (s) => parseProxyUrl(s).url;

console.log("\n=== pickBest: per-host rules ===\n");
(async () => {
  // 1) rule designates a specific proxy -> that proxy is returned
  let pm = makePM([{ host: "supjav.com", proxy: "http://a:1" }], ["http://a:1", "socks5://b:2"]);
  let r = await pm.pickBest("https://supjav.com/x");
  assert("rule returns designated proxy", r && r.url === urlOf("http://a:1"), r && r.url);

  // 2) rule 'direct' -> null (no proxy)
  pm = makePM([{ host: "go.mnaspm.com", proxy: "direct" }], ["http://a:1"]);
  r = await pm.pickBest("https://go.mnaspm.com/x");
  assert("rule direct -> null", r === null);

  // 3) dead rule proxy -> fall back to auto pool
  pm = makePM([{ host: "supjav.com", proxy: "http://dead:9" }], ["http://a:1", "http://dead:9"], new Set([urlOf("http://dead:9")]));
  r = await pm.pickBest("https://supjav.com/x");
  assert("dead rule proxy falls back to pool", r && r.url === urlOf("http://a:1"), r && r.url);

  // 4) invalid rule proxy -> fall through to auto pool
  pm = makePM([{ host: "supjav.com", proxy: "!!bad" }], ["http://a:1"]);
  r = await pm.pickBest("https://supjav.com/x");
  assert("invalid rule proxy falls through to pool", r && r.url === urlOf("http://a:1"), r && r.url);

  // 5) no rule -> lowest-latency proxy from pool
  pm = makePM([], ["http://a:1", "socks5://b:2"]);
  r = await pm.pickBest("https://unrelated.com/x");
  assert("no rule -> pool proxy selected", r && (r.url === urlOf("http://a:1") || r.url === urlOf("socks5://b:2")), r && r.url);

  // 6) no rule + empty pool -> null
  pm = makePM([], []);
  r = await pm.pickBest("https://unrelated.com/x");
  assert("empty pool -> null", r === null);

  // 7) suffix rule matches subdomain
  pm = makePM([{ host: "*.mayzaent.com", proxy: "socks5://b:2" }], ["http://a:1", "socks5://b:2"]);
  r = await pm.pickBest("https://go.mayzaent.com/file");
  assert("*.suffix rule matches subdomain", r && r.url === urlOf("socks5://b:2"), r && r.url);

  console.log("\n=== " + passed + " passed, " + failed + " failed ===\n");
  process.exit(failed ? 1 : 0);
})();
