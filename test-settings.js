"use strict";
// Offline tests for lib/settings.js createSettings (the runtime settings
// controller: schema whitelist, validation fallbacks, persistence, apply-once,
// and live application of external config.json edits via the file watcher).
// Run: node test-settings.js   (no Electron, no network required)
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DEFAULT_CONFIG } = require("./config");
const { createSettings } = require("./lib/settings");

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log("  PASS  " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? " -> " + detail : "")); }
}
function withWarnCapture(fn) {
  const msgs = [];
  const orig = console.warn;
  console.warn = (m) => { msgs.push(m); };
  try { fn(); } finally { console.warn = orig; }
  return msgs;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-settings-"));
const p = (n) => path.join(tmp, n);

console.log("\n=== boot (absent file) ===\n");
{
  const s = createSettings({ configPath: p("missing.json"), onApply: null });
  assert("absent file -> defaults", s.get().port === 8765 && Array.isArray(s.get().proxies));
  assert("boot does not write config.json", !fs.existsSync(p("missing.json")));
}

console.log("\n=== whitelist ===\n");
{
  const s = createSettings({ configPath: p("wl.json"), onApply: null });
  s.update({ port: 9123, hacker: "x", extensionPath: "nope", downloadDir: "/tmp/dv" });
  assert("schema keys applied", s.get().port === 9123 && s.get().downloadDir === "/tmp/dv");
  assert("unknown key dropped", !("hacker" in s.get()), Object.keys(s.get()).join(","));
  assert("non-schema key dropped (extensionPath)", !("extensionPath" in s.get()));
  s.update(null);
  assert("null update keeps state", s.get().port === 9123);
  s.update("garbage");
  assert("non-object update keeps state", s.get().port === 9123);
}

console.log("\n=== validation fallbacks ===\n");
{
  const s = createSettings({ configPath: p("val.json"), onApply: null });
  const warns = withWarnCapture(() => {
    s.update({ proxies: ["http://127.0.0.1:7890", "ws://127.0.0.1:8765", "socks5://127.0.0.1:1080", "", "nope://x", 42] });
  });
  assert("drops ws:// / empty / bad-scheme proxies", s.get().proxies.length === 2, JSON.stringify(s.get().proxies));
  assert("keeps valid proxies", s.get().proxies.includes("http://127.0.0.1:7890") && s.get().proxies.includes("socks5://127.0.0.1:1080"));
  assert("warned for each dropped proxy", warns.length === 2, "got " + warns.length);
  withWarnCapture(() => s.update({ proxies: ["garbage://x", "ftp://y"] }));
  assert("all-bad proxies -> default list", JSON.stringify(s.get().proxies) === JSON.stringify(DEFAULT_CONFIG.proxies), s.get().proxies.join(","));
  s.update({ port: "8766", concurrency: "4" });
  assert("string->number coercion", s.get().port === 8766 && s.get().concurrency === 4, JSON.stringify([s.get().port, s.get().concurrency]));
  withWarnCapture(() => {
    s.update({ proxyRules: [{ host: "supjav.com", proxy: "http://127.0.0.1:7890" }, { host: "x.com", proxy: 5 }, "garbage"] });
  });
  assert("bad proxyRules entries dropped", s.get().proxyRules.length === 1 && s.get().proxyRules[0].host === "supjav.com", JSON.stringify(s.get().proxyRules));
}

console.log("\n=== persistence ===\n");
{
  const s = createSettings({ configPath: p("persist.json"), onApply: null });
  withWarnCapture(() => s.update({ port: 9111, proxies: ["ws://127.0.0.1:8765", "http://h:1"] }));
  assert("update writes config.json", fs.existsSync(p("persist.json")));
  const onDisk = JSON.parse(fs.readFileSync(p("persist.json"), "utf8"));
  assert("persisted file carries validated state", onDisk.port === 9111 && onDisk.proxies.length === 1 && onDisk.proxies[0] === "http://h:1", JSON.stringify(onDisk.proxies));
  const s2 = createSettings({ configPath: p("persist.json"), onApply: null });
  assert("restart loads persisted state", s2.get().port === 9111, s2.get().port);
  assert("restart re-validates proxies on boot", s2.get().proxies.length === 1);
  fs.writeFileSync(p("badboot.json"), "{not valid json");
  const s3 = createSettings({ configPath: p("badboot.json"), onApply: null });
  assert("malformed config.json at boot -> defaults", s3.get().port === 8765);
}

console.log("\n=== apply-once ===\n");
{
  let applied = [];
  const s = createSettings({ configPath: p("apply.json"), onApply: (c) => { applied.push(c); } });
  s.update({ port: 9001 });
  assert("onApply fired once", applied.length === 1, "got " + applied.length);
  assert("onApply receives validated config", applied[0].port === 9001);
  assert("update returns the applied config", s.update({ concurrency: 2 }) === s.get() && applied.length === 2);
  assert("get() reflects state across updates", s.get().port === 9001 && s.get().concurrency === 2);
  s.update({ port: 9001 }); // same value again
  assert("re-apply same value still fires onApply", applied.length === 3, "got " + applied.length);
  s.update({});
  s.update(null);
  assert("empty/null updates fire onApply (old settings-save parity)", applied.length === 5, "got " + applied.length);
}

console.log("\n=== file watch (external edits apply live) ===\n");
(async () => {
  let applied = 0;
  const ws = createSettings({ configPath: p("watch.json"), onApply: () => { applied++; }, watch: true });
  const edit = (obj) => fs.writeFileSync(p("watch.json"), typeof obj === "string" ? obj : JSON.stringify(obj), "utf8");

  ws.update({ port: 9123 });
  assert("own update applies once", applied === 1 && ws.get().port === 9123, "applied=" + applied);
  await sleep(800); // let the watcher's echo of our own save land
  assert("own save does not self-apply (no loop)", applied === 1 && ws.get().port === 9123, "applied=" + applied);

  edit({ port: 9444, concurrency: 6, hacker: "x" });
  await sleep(800);
  assert("external edit applies live", ws.get().port === 9444 && ws.get().concurrency === 6, JSON.stringify([ws.get().port, ws.get().concurrency]));
  assert("external edit fired onApply once", applied === 2, "applied=" + applied);
  assert("unknown key in external edit dropped", !("hacker" in ws.get()));

  edit({ proxies: ["ws://bad", "http://ok:1"] });
  await sleep(800);
  assert("external edit validated (bad proxy dropped)", ws.get().proxies.length === 1 && ws.get().proxies[0] === "http://ok:1", JSON.stringify(ws.get().proxies));

  edit({ concurrency: 8 }); // port omitted -> file is authoritative, resets to default
  await sleep(800);
  assert("omitted key resets to default", ws.get().port === 8765 && ws.get().concurrency === 8, JSON.stringify([ws.get().port, ws.get().concurrency]));

  edit("{not valid json"); // transient/partial write
  await sleep(800);
  assert("malformed external edit keeps last good state", ws.get().concurrency === 8, "concurrency=" + ws.get().concurrency);

  ws.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\n=== " + passed + " passed, " + failed + " failed ===\n");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("watch suite crashed:", e); process.exit(1); });