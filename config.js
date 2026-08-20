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
  ]
};

// Numeric fields that should be numbers — coerce stringy values coming from a
// hand-edited config.json.
const NUMERIC_FIELDS = [
  "port", "minFreeMB", "concurrency", "segments", "speedLimitKB",
  "maxRetries", "maxRefresh", "hostDelayMs", "maxHistory", "autoTrimAt", "liveWindow"
];
// Boolean toggles.
const BOOLEAN_FIELDS = [
  "autoProxy", "saveHistory", "skipDuplicates", "autoCloseTab", "thumbnails"
];
// String path fields.
const STRING_FIELDS = ["downloadDir", "downloadDir2", "downloadDir3", "ffmpegPath", "theme"];

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
