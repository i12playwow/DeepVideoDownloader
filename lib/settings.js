"use strict";
// Runtime settings lifecycle. Schema + parse/validate/load/save primitives
// live in ../config (pure, unit-tested via test-config.js); this module is
// the stateful controller that owns the live config, its config.json path,
// and the single mutation path the renderer can reach. main.js keeps only
// the app.isPackaged path selection and registers `onApply`, the engine hook
// that rebuilds ProxyManager / repoints DownloadManager after a change.
// Pure-Node (no `electron` dependency), mirroring the config.js layering.
const { DEFAULT_CONFIG, loadConfig, validateConfig, saveConfig } = require("../config");

function createSettings({ configPath, onApply }) {
  let config = loadConfig(configPath); // never throws: defaults on read/parse error
  const SETTABLE = new Set(Object.keys(DEFAULT_CONFIG));

  return {
    // Live config object (the same reference-style semantics callers relied
    // on before: reads see the current validated state at all times).
    get: () => config,
    // Renderer write path: only schema-known keys pass through, then the
    // merged result is validated, persisted, and applied to the engine.
    update: (next) => {
      const clean = {};
      if (next && typeof next === "object") {
        for (const k of Object.keys(next)) if (SETTABLE.has(k)) clean[k] = next[k];
      }
      config = validateConfig({ ...config, ...clean });
      saveConfig(configPath, config);
      if (onApply) onApply(config);
      return config;
    }
  };
}

module.exports = { createSettings };
