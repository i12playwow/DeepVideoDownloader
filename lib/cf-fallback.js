// Cloudflare fallback: when a plain-HTTP page fetch comes back as a CF
// challenge interstitial, re-fetch it through scripts/cf-browser.js (a real
// headed Chrome driven over CDP). The browser behind the bridge is warm by
// default: the first challenge pays the solve (~8s auto, longer if the
// challenge demands a human click), and every later fetch on the same
// profile returns in a couple of seconds with cf_clearance already in the
// live cookie jar.
//
// Wiring: lib/http.js fetchHtml() calls fetchViaCfBrowser() when
// isCfChallengeBody() fires, so every resolver AND m3u8/playlist fetch gets
// the fallback for free. The bridge is serialized per profile (one fetch at
// a time through the warm browser); other hosts do not queue behind it.
// Per-install opt-out: config.json `cfBrowserFallback: false` (config.js
// BOOLEAN_FIELDS, applied via setCfBrowserFallback) disables the router here
// — challenge bodies then return untouched so resolvers fail with their
// usual requires-browser / cf-blocked errors instead of spawning the browser
// bridge. Each skipped host logs ONE concise [cf-fallback] line (deduped per
// host, so a batch of pages on the same site stays quiet) so the user can
// see the toggle took effect. A config.siteRules `cf` token (config.js; the
// renderer's "cf:off"/"cf:on") overrides per host and wins over the
// install-wide toggle. The per-call opts.cfFallback === false in lib/http.js
// still wins (and stays silent — programmatic, not user intent).
// The injected-fetch seams resolvers already accept (injectedFetch) keep
// unit tests offline.
//
// Failure semantics: if the browser fallback also fails, the thrown error
// carries category "requires-browser" — the existing manual-browse flow
// (onRequiresBrowser -> browser-open) stays the last resort.

const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { normalizeCf } = require("../config");

const SCRIPT = path.join(__dirname, "..", "scripts", "cf-browser.js");
const BROWSER_TIMEOUT_MS = 120000; // includes potential interactive challenge
const WARMUP_COOLDOWN_MS = 30000; // don't re-warm a dying browser more often than this

// Reuse lib/errors' regex via a local copy of the exact markers it checks:
// kept in sync by test-cf-fallback.js which cross-checks both modules.
const CF_PAGE_RE = /checking your browser|just a moment|cf-challenge|cf-chl|challenge-form|challenge-stage|attention required|verify you are human|enable javascript and cookies/i;

function isCfChallengeBody(body) {
  return !!(body && CF_PAGE_RE.test(String(body)));
}

// The module-level knobs tests overwrite.
const state = {
  fetchViaCfBrowser: null, // assigned below; tests replace this seam
  scriptPath: null,        // tests point this at a stub cf-browser script
  timeoutMs: null,         // tests shorten the child kill timer
  lastWarmupFail: 0,       // timestamp of last bridge failure (cooldown gate)
  onEngaged: null,         // UI observer (renderer toast): fires once per engagement
  configEnabled: true,     // config.json cfBrowserFallback (setCfBrowserFallback)
  siteRules: [],           // per-site cf overrides ({ host, cf }) — setCfFallbackSiteRules
};

// Hosts already told the user about: the disabled-skip log fires once per
// host, not once per challenge page (a crawl of one site must not spam).
const skipLogged = new Set();

// UI surfacing hook: main.js registers a callback that fires once per
// engagement (a plain-HTTP fetch hit a CF challenge and the cf-browser is
// taking over — a visible Chrome window may appear on screen). The observer
// must never break or delay the fetch, so it is wrapped in its own guard.

// Serialized bridge: at most one child cf-browser fetch at a time per
// profile dir. A stuck child is killed after BROWSER_TIMEOUT_MS.
let chain = Promise.resolve();

function runBridged(url) {
  const run = chain.catch(() => {}).then(() => state.execCfBrowserFetch(url));
  chain = run.catch(() => {});
  return run;
}

function execCfBrowserFetch(url) {
  return new Promise((resolve, reject) => {
    let child;
    let stdout = "", stderr = "";
    let settled = false;
    const timeoutMs = state.timeoutMs || BROWSER_TIMEOUT_MS;
    const done = (fn, val) => { if (!settled) { settled = true; clearTimeout(killTimer); fn(val); } };
    const killTimer = setTimeout(() => {
      try { child && child.kill(); } catch { /* ignore */ }
      done(reject, new Error("cf-browser fetch timed out after " + timeoutMs + "ms"));
    }, timeoutMs);

    try {
      child = spawn(process.execPath, [state.scriptPath || SCRIPT, url, "--out", "-", "--timeout", String(timeoutMs - 5000 > 0 ? timeoutMs - 5000 : 5000)], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      return done(reject, e);
    }
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => done(reject, e));
    child.on("exit", (code) => {
      const i = stdout.indexOf("---CFB64---");
      if (code !== 0) {
        return done(reject, new Error("cf-browser exit " + code + (stderr ? ": " + stderr.slice(-300) : "")));
      }
      if (i < 0) {
        return done(reject, new Error("cf-browser produced no HTML block" + (stderr ? ": " + stderr.slice(-300) : "")));
      }
      const b64 = stdout.slice(i + "---CFB64---".length).replace(/\s+/g, "");
      let html;
      try { html = Buffer.from(b64, "base64").toString("utf8"); }
      catch (e) { return done(reject, new Error("cf-browser HTML block undecodable: " + e.message)); }
      if (!html) return done(reject, new Error("cf-browser returned empty HTML"));
      done(resolve, html);
    });
  });
}

// Public bridge the http layer calls. `hostKey` separates serialization
// queues; today we use the profile dir so distinct profiles never contend.
async function fetchViaCfBrowser(url, { profileDir } = {}) {
  profileDir = profileDir || process.env.CF_BROWSER_PROFILE ||
    path.join(os.tmpdir(), "deep-video-downloader-cf-profile");
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch { /* ignore */ }

  const now = Date.now();
  if (now - state.lastWarmupFail < WARMUP_COOLDOWN_MS) {
    const e = new Error("cf-browser browser unavailable (recent warmup failure); manual browse required for " + url);
    e.category = "requires-browser";
    throw e;
  }
  try {
    const html = await runBridged(url);
    state.lastWarmupFail = 0;
    return html;
  } catch (err) {
    state.lastWarmupFail = Date.now();
    const e = new Error("cf-browser fallback failed for " + url + ": " + (err && err.message));
    e.category = "requires-browser";
    e.cause = err;
    throw e;
  }
}

state.fetchViaCfBrowser = fetchViaCfBrowser;
state.execCfBrowserFetch = execCfBrowserFetch; // seam: tests spy on real spawns

// Host-pattern matcher, same shapes as downloader.js _siteRuleFor: exact
// host or "*.suffix" subdomain tree. Compared lowercase (URL hostnames are
// already lowercase; this also forgives a hand-edited "Example.com" rule).
function hostMatchesPattern(host, pattern) {
  const h = String(host || "").toLowerCase();
  const pat = String(pattern || "").trim().toLowerCase();
  if (!h || !pat) return false;
  if (pat.startsWith("*.")) return h.endsWith(pat.slice(1));
  return h === pat;
}

// Per-host cf override from config.siteRules' optional `cf` field (rules
// without it are inert here). Returns true (force on), false (force off) or
// null (no override — follow the install-wide toggle).
function siteCfOverride(host) {
  const rules = state.siteRules;
  if (!host || !rules || !rules.length) return null;
  for (const r of rules) {
    if (r && r.cf !== undefined && hostMatchesPattern(host, r.host)) return r.cf;
  }
  return null;
}

// Single integration knob lib/http.js uses. Returns the fetched HTML or
// throws with category "requires-browser". The wrap here (not only inside
// fetchViaCfBrowser) guarantees the contract even when the bridge seam is
// replaced by a test double that throws a plain error.
async function fetchPageWithFallback(url, plainHtml) {
  if (!isCfChallengeBody(plainHtml)) return plainHtml; // caller only routes challenges here
  let host = "";
  try { host = new URL(url).hostname; } catch { /* unparseable: dedupe/log under the raw url */ }
  const label = host || url;
  // Gate order: a siteRules cf override wins; no override follows the
  // install-wide config toggle. A skip logs ONE concise line per host so the
  // user can see the toggle took effect; a live fallback clears any stale
  // skip note so a later disable logs again.
  const site = siteCfOverride(host);
  if (site === false || (site === null && state.configEnabled === false)) {
    if (!skipLogged.has(label)) {
      skipLogged.add(label);
      console.log("[cf-fallback] challenge on " + label + " skipped (browser fallback disabled: " +
        (site === false ? "site rule" : "cfBrowserFallback: false") + ")");
    }
    return plainHtml; // challenge fails through to the resolvers' own requires-browser handling
  }
  skipLogged.delete(label);
  try {
    if (state.onEngaged) {
      try { state.onEngaged(url); } catch { /* an observer failure never breaks the fetch */ }
    }
    return await state.fetchViaCfBrowser(url);
  } catch (err) {
    if (err && err.category) throw err;
    const e = new Error("cf-browser fallback failed for " + url + ": " + (err && err.message));
    e.category = "requires-browser";
    e.cause = err;
    throw e;
  }
}

// Register the engagement observer (main.js pushes a debounced renderer
// toast). Pass null to clear. Returns nothing; never throws.
function setEventHook(fn) {
  state.onEngaged = typeof fn === "function" ? fn : null;
}

// Install-wide toggle + per-site overrides, driven from config.json's
// cfBrowserFallback / siteRules (main.js boot + onApply) so a settings save
// or a hand-edited config.json applies live without a restart. `on !== false`
// keeps the default for undefined; a rules arg replaces the override list.
function setCfBrowserFallback(on, siteRules) {
  state.configEnabled = on !== false;
  if (siteRules !== undefined) setCfFallbackSiteRules(siteRules);
}

// Per-site overrides ({ host, cf }) — rules without a cf field are inert here
// (they still drive folder/start in downloader.js); non-array args clear. cf
// goes through config.js' normalizeCf so the renderer's "cf:off"/"cf:on"
// tokens mean the same thing on every path (anything outside that grammar
// drops the override, mirroring validateConfig).
function setCfFallbackSiteRules(rules) {
  state.siteRules = Array.isArray(rules)
    ? rules.reduce((acc, r) => {
        if (!r || typeof r !== "object" || typeof r.host !== "string") return acc;
        const cf = normalizeCf(r.cf);
        if (cf !== undefined) acc.push({ host: r.host, cf });
        return acc;
      }, [])
    : [];
}

function cfBrowserFallbackEnabled() {
  return state.configEnabled !== false;
}

module.exports = {
  isCfChallengeBody,
  fetchPageWithFallback,
  fetchViaCfBrowser,
  setEventHook,
  setCfBrowserFallback,
  setCfFallbackSiteRules,
  cfBrowserFallbackEnabled,
  _state: state, // test seam: replace fetchViaCfBrowser / scriptPath / timeoutMs / onEngaged
  _internal: { SCRIPT, BROWSER_TIMEOUT_MS, WARMUP_COOLDOWN_MS, execCfBrowserFetch, skipLogged },
};
