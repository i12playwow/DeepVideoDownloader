"use strict";
// Config handling for the Electron main process, factored into a pure-Node
// module (no `electron` dependency) so it can be unit-tested headlessly via
// `node test-config.js`. main.js keeps only the app.isPackaged path selection
// and delegates read/parse/validate here so the rules are shared + testable.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { parseProxyUrl } = require("./proxy");

const DEFAULT_CONFIG = {
  port: 8765,
  downloadDir: path.join(os.homedir(), "Downloads", "DeepGrab"),
  downloadDir2: "",
  downloadDir3: "",
  minFreeMB: 500,
  concurrency: 8,
  segments: 4,
  speedLimitKB: 0,
  maxRetries: 3,
  maxRefresh: 2,
  hostDelayMs: 120,
  idleTabMinutes: 0,
  autoProxy: true,
  ffmpegPath: "ffmpeg",
  theme: "dark",
  saveHistory: true,
  skipDuplicates: true,
  autoCloseTab: true,
  thumbnails: true,
  maxHistory: 2000,
  liveWindow: 0,
  autoTrimAt: 500,
  proxies: [
    "http://127.0.0.1:7890",
    "socks5://127.0.0.1:1080"
  ],
  // Per-host proxy rules: route a URL host to a specific proxy (or "direct").
  // Each entry: { host: "<pattern>", proxy: "<proxyUrl | 'direct'>" }.
  // Patterns match exact host, "*.suffix", "*" glob, or "/regex/" literal.
  // Rules only apply when autoProxy is ON (see proxy.js pickBest).
  proxyRules: [],
  // Global schedule window: only START new downloads between these local
  // "HH:MM" times (empty = off). Running downloads are never interrupted; a
  // start after end (e.g. 23:00 -> 07:00) spans midnight.
  scheduleWindowStart: "",
  scheduleWindowEnd: "",
  // Auto-retry failed downloads: after an item reaches a terminal error
  // (anything except requires-browser), requeue it after N minutes (0 = off).
  autoRetryMinutes: 0,
  // Per-site automation rules for NEW downloads, matched by host:
  // { host, folder, start } — folder overrides the destination (unless the
  // caller picked one), start lets the item begin even outside the window.
  siteRules: []
};

// Numeric fields that should be numbers — coerce stringy values coming from a
// hand-edited config.json.
const NUMERIC_FIELDS = [
  "port", "minFreeMB", "concurrency", "segments", "speedLimitKB",
  "maxRetries", "maxRefresh", "hostDelayMs", "idleTabMinutes", "maxHistory", "autoTrimAt", "liveWindow", "autoRetryMinutes"
];
// Boolean toggles.
const BOOLEAN_FIELDS = [
  "autoProxy", "saveHistory", "skipDuplicates", "autoCloseTab", "thumbnails"
];
// String path fields.
const STRING_FIELDS = ["downloadDir", "downloadDir2", "downloadDir3", "ffmpegPath", "theme", "scheduleWindowStart", "scheduleWindowEnd"];

// Parse raw config text (already read from disk) into a config object.
// Strips a leading UTF-8 BOM (a Notepad/PowerShell save artifact that would
// otherwise make JSON.parse throw and silently reset to defaults), tolerates
// malformed JSON, and merges with DEFAULT_CONFIG. Pure function.
function parseConfig(rawText, defaults) {
  const d = defaults || DEFAULT_CONFIG;
  let parsed = {};
  try {
    const text = (rawText || "").replace(/^\uFEFF/, "");
    if (text.trim()) parsed = JSON.parse(text);
  } catch (e) {
    parsed = {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    parsed = {};
  }
  return Object.assign({}, d, parsed);
}

// Normalize/coerce a config: fix bad types, drop bogus proxy schemes (e.g. the
// ws://127.0.0.1:8765 placeholder that slipped into config.json), and warn on
// dropped entries. Returns a new object (does not mutate its input).
function validateConfig(config) {
  const c = Object.assign({}, config || {});

  for (const f of NUMERIC_FIELDS) {
    if (c[f] == null) continue;
    const n = Number(c[f]);
    c[f] = Number.isFinite(n) && n >= 0 ? n : DEFAULT_CONFIG[f];
  }
  for (const f of BOOLEAN_FIELDS) {
    if (c[f] == null) continue;
    c[f] = !!c[f];
  }
  for (const f of STRING_FIELDS) {
    if (c[f] == null || typeof c[f] !== "string") c[f] = DEFAULT_CONFIG[f];
  }

  // Proxies: keep only valid http/https/socks URIs (parseProxyUrl returns null
  // for ws:// and other unsupported schemes). Drop garbage and warn.
  if (Array.isArray(c.proxies)) {
    const cleaned = [];
    for (const p of c.proxies) {
      if (typeof p !== "string") continue;
      const s = p.trim();
      if (!s) continue;
      const parsed = parseProxyUrl(s);
      if (parsed) {
        cleaned.push(s);
      } else {
        console.warn("[config] dropping invalid proxy entry: " + s);
      }
    }
    c.proxies = cleaned.length ? cleaned : DEFAULT_CONFIG.proxies;
  } else {
    c.proxies = DEFAULT_CONFIG.proxies;
  }

  // Per-host proxy rules: array of { host, proxy }. `proxy` is "direct" or any
  // valid proxy URL (arbitrary — not required to be in the proxies list).
  if (Array.isArray(c.proxyRules)) {
    const cleanedRules = [];
    for (const r of c.proxyRules) {
      if (!r || typeof r !== "object" || Array.isArray(r)) continue;
      const host = typeof r.host === "string" ? r.host.trim() : "";
      const proxy = typeof r.proxy === "string" ? r.proxy.trim() : "";
      if (!host || !proxy) continue;
      if (proxy !== "direct" && !parseProxyUrl(proxy)) {
        console.warn("[config] dropping invalid proxyRules entry: " + JSON.stringify(r));
        continue;
      }
      cleanedRules.push({ host, proxy });
    }
    c.proxyRules = cleanedRules;
  } else {
    c.proxyRules = [];
  }


  // Schedule window: keep only sane "HH:MM" times; anything else disables the
  // window for that edge (both empty = window off).
  for (const edge of ["scheduleWindowStart", "scheduleWindowEnd"]) {
    const v = c[edge];
    const m = typeof v === "string" ? /^([0-9]{1,2}):([0-9]{2})$/.exec(v) : null;
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) c[edge] = "";
  }

  // Per-site automation rules: array of { host, folder?, start? }. host is
  // required; folder may be empty (rule then only controls the window bypass).
  if (Array.isArray(c.siteRules)) {
    const cleanedRules = [];
    for (const r of c.siteRules) {
      if (!r || typeof r !== "object" || Array.isArray(r)) continue;
      const host = typeof r.host === "string" ? r.host.trim() : "";
      if (!host) continue;
      const folder = typeof r.folder === "string" ? r.folder.trim() : "";
      cleanedRules.push({ host, folder, start: !!r.start });
    }
    c.siteRules = cleanedRules;
  } else {
    c.siteRules = [];
  }

  return c;
}

// Read + parse + validate a config file. Never throws — falls back to defaults
// on any read/parse error (mirrors the old loadConfig() behavior in main.js).
function loadConfig(configPath) {
  let raw = "";
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (e) {
    return Object.assign({}, DEFAULT_CONFIG);
  }
  return validateConfig(parseConfig(raw));
}

// Persist a config object. Best-effort (read-only app.asar, offline, etc.).
function saveConfig(configPath, config) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  } catch (e) { /* ignore */ }
}

module.exports = {
  DEFAULT_CONFIG,
  parseConfig,
  validateConfig,
  loadConfig,
  saveConfig
};
