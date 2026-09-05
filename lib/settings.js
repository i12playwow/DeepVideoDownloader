"use strict";
// Runtime settings lifecycle. Schema + parse/validate/load/save primitives
// live in ../config (pure, unit-tested via test-config.js); this module is
// the stateful controller that owns the live config, its config.json path,
// and the single mutation path the renderer can reach. main.js keeps only
// the app.isPackaged path selection and registers `onApply`, the engine hook
// that rebuilds ProxyManager / repoints DownloadManager after a change.
// Pure-Node (no `electron` dependency), mirroring the config.js layering.
const fs = require("fs");
const path = require("path");
const { DEFAULT_CONFIG, loadConfig, validateConfig, saveConfig } = require("../config");

// Plain-shape deep equality (primitives, nested objects/arrays). The file
// watcher uses it to skip no-op events — including the echo of the normalized
// write settings.update itself performs — so an external edit applies exactly
// once instead of looping.
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || a === null || b === null || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function createSettings({ configPath, onApply, watch = false }) {
  let config = loadConfig(configPath); // never throws: defaults on read/parse error
  const SETTABLE = new Set(Object.keys(DEFAULT_CONFIG));

  let watcher = null;
  let watchTimer = null;

  // External config.json edits are routed through update() (below) so they
  // apply live without a restart. We watch the FILE itself: a directory watch
  // on Windows hits a libuv assertion when the event filename comes back in a
  // different path form (e.g. 8.3 short vs long name), and a file watch
  // survives atomic editor saves via rename. The watcher is re-armed by every
  // update(), so a config.json that does not exist at boot is picked up once
  // the app (or the user) creates it. Bursts are debounced; a transient
  // unreadable/unparseable file (editor mid-write, atomic-save gap) is skipped
  // and re-checked on the next event, never clobbering the live config.
  const onChange = () => {
    if (watchTimer) return;
    watchTimer = setTimeout(() => {
      watchTimer = null;
      let raw;
      try { raw = fs.readFileSync(configPath, "utf8"); } catch (e) { return; }
      try { JSON.parse(raw.replace(/^\uFEFF/, "")); } catch (e) { return; }
      const loaded = loadConfig(configPath);
      if (!deepEqual(loaded, config)) update(loaded);
    }, 250);
  };
  const rearm = () => {
    if (watcher) { try { watcher.close(); } catch (e) { /* ignore */ } watcher = null; }
    try {
      watcher = fs.watch(configPath, onChange);
      watcher.on("error", () => { /* file removed: re-armed on the next update() */ });
    } catch (e) { watcher = null; } // file absent yet: armed once it exists
  };
  const close = () => {
    if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
    if (watcher) { try { watcher.close(); } catch (e) { /* ignore */ } watcher = null; }
  };

  // Single mutation path: schema-whitelisted keys merged over the live config,
  // then validated, persisted, and applied to the engine. `next` is usually a
  // renderer partial; the file watcher passes the full loaded config, whose
  // defaults-merge makes the file authoritative (omitted keys reset).
  const update = (next) => {
    const clean = {};
    if (next && typeof next === "object") {
      for (const k of Object.keys(next)) if (SETTABLE.has(k)) clean[k] = next[k];
    }
    config = validateConfig({ ...config, ...clean });
    saveConfig(configPath, config);
    if (watch) rearm();
    if (onApply) onApply(config);
    return config;
  };

  if (watch) rearm();

  return {
    // Live config object (the same reference-style semantics callers relied
    // on before: reads see the current validated state at all times).
    get: () => config,
    update,
    close
  };
}

module.exports = { createSettings };