// Keeps the live demo in sync with the real app:
//   1. Regenerates demo-renderer.html from renderer.html (injects the
//      demo-api-shim.js <script> before renderer.js; suffixes " (demo)" title).
//   2. Method check: every window.api.* call renderer.js makes (static + the
//      dynamic data-act/batch set) must exist on the shim's runtime surface.
//   3. Markup check: every element ID renderer.js queries ($("id"),
//      getElementById, querySelector("#id")) must exist in the generated
//      markup. Missing IDs used UNGUARDED fail the sync (they would throw in
//      the real app too); missing IDs only referenced behind an `if (!el)` /
//      `if (el)` guard are warnings.
//   4. Attribute check: data-act="X" values renderer.js emits are special-cased
//      in the click routers or must be backed by a shim method (the api
//      fall-through window.api[act](id)); and every data-browse="X" button in
//      the markup must target an existing id="X" (a dangling value makes that
//      Browse button a silent no-op).
//   5. data-sel check: row templates render `<input type="checkbox"
//      data-sel="…">` per download; the change handlers bound to the table
//      body consume them (closest("input[data-sel]") → dataset.sel). The
//      values are runtime item ids, so drift is structural: each such handler's
//      table must be fed by a template that renders the checkbox on a
//      type="checkbox" input, and the markup must declare the column
//      (<th class="sel">).
// Usage:
//   node sync-demo.js              # generate + drift checks; exit 1 on failure
//   node sync-demo.js --watch      # rerun on renderer.html/renderer.js changes
//   node sync-demo.js --selftest   # assert scan outputs against current sources
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const SRC_HTML = path.join(ROOT, "renderer.html");
const SRC_JS = path.join(ROOT, "renderer.js");
const SHIM_JS = path.join(ROOT, "demo-api-shim.js");
const OUT_HTML = path.join(ROOT, "demo-renderer.html");

// Attribute-level scans of renderer.js. data-act="X" literals in the row
// templates fall through to window.api[act](id) unless a click router
// special-cases them (act === "…" / btn.dataset.act === "…" comparisons); the
// #batch* button ids route to window.api[method](id) the same way. Deriving
// these from source (instead of a hand-maintained list) means a new row action
// can't silently escape the shim-coverage check.
const DATA_ACT_RE = /data-act="([^"]+)"/g;
const SPECIAL_ACT_RE = /\bact\s*===\s*"([^"]+)"/g;
const BATCH_BTN_RE = /(?:\[|,\s*)"batch([A-Za-z]+)"/g;

function emittedActs(src) {
  return new Set([...src.matchAll(DATA_ACT_RE)].map((m) => m[1]));
}

function specialActs(src) {
  return new Set([...src.matchAll(SPECIAL_ACT_RE)].map((m) => m[1]));
}

function batchActs(src) {
  return new Set([...src.matchAll(BATCH_BTN_RE)].map((m) => m[1].toLowerCase()));
}

function generate() {
  let html = fs.readFileSync(SRC_HTML, "utf8");
  if (!/<script\s+src="renderer\.js"><\/script>/.test(html)) {
    throw new Error("renderer.html: renderer.js <script> tag not found — generator is stale");
  }
  if (!html.includes('<script src="demo-api-shim.js"></script>')) {
    html = html.replace(
      /<script\s+src="renderer\.js"><\/script>/,
      '<script src="demo-api-shim.js"></script>\n  <script src="renderer.js"></script>'
    );
  }
  if (!/<title>[^<]*\(demo\)<\/title>/.test(html)) {
    html = html.replace(/<title>([^<]*)<\/title>/, "<title>$1 (demo)</title>");
  }
  fs.writeFileSync(OUT_HTML, html);
  return html;
}

// Runtime probe: execute demo-api-shim.js in a vm sandbox and list the keys it
// exposes on window.api. Authoritative — survives shim restructures.
function shimMethods() {
  const code = fs.readFileSync(SHIM_JS, "utf8");
  const window = {};
  const sandbox = {
    window,
    console: { log() {}, error() {} },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    Date, Math, JSON, Array, String, Number, Object, Promise, RegExp, isNaN, decodeURIComponent
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "demo-api-shim.js" });
  return Object.keys(window.api || {});
}

function shimBehaviors() {
  // Two demo-critical invariants of the shim runtime, exercised together in
  // the live schedule flow: (1) window.prompt is stubbed to return null so
  // native dialogs never block the preview, and (2) api.schedule stores the
  // start/stop times on the item and flips it to "scheduled" — the API is
  // the surface renderer.js drives after its prompt() dialog (which the stub
  // intentionally aborts), so the storing side is what must stay healthy.
  const code = fs.readFileSync(SHIM_JS, "utf8");
  const window = {};
  const sandbox = {
    window,
    console: { log() {}, error() {} },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    Date, Math, JSON, Array, String, Number, Object, Promise, RegExp, isNaN, decodeURIComponent
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "demo-api-shim.js" });
  const api = window.api;
  const list = () => api.list();
  const byId = (items, id) => items.find((i) => i.id === id);
  const statusOf = async (id) => {
    const it = byId(await list(), id);
    return it ? it.status : null;
  };
  const resume = (id) => api.resume(id).then(() => statusOf(id));
  const promptIsNull = typeof window.prompt === "function" && window.prompt("test") === null;

  return (async () => {
    // queue-wide controls: pauseAll freezes running/queued/scheduled,
    // resumeAll brings paused back; retryFailed skips requires-browser.
    await api.pauseAll();
    const afterPauseAll = await list();
    const pausedAll = afterPauseAll.every((x) => ["paused", "error", "done", "duplicate", "cancelled"].includes(x.status));
    const pauseCount = afterPauseAll.filter((x) => x.status === "paused").length;
    await api.resumeAll();
    const afterResumeAll = await list();
    const resumedD1 = byId(afterResumeAll, "d1") ? byId(afterResumeAll, "d1").status : null;
    const resumeCount = afterResumeAll.filter((x) => x.status === "queued").length;
    const retryFailedCount = (await api.retryFailed()).count;
    await api.retry("d5");
    const d5AfterRetry = await statusOf("d5");
    // global schedule window: outside it new downloads stay queued unless a
    // site rule carries start (bypass); inside they run. folder rule applies.
    const two = (d) => String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const t0 = new Date();
    await api.saveSettings({
      scheduleWindowStart: two(new Date(t0.getTime() - 2 * 3600 * 1000)),
      scheduleWindowEnd: two(new Date(t0.getTime() - 3600 * 1000)),
      siteRules: [{ host: "bypass.example.com", folder: "D:/RulesFolder", start: true }]
    });
    await api.add("https://gated.example.com/v.mp4");
    const gatedItem = (await list())[0];
    const closedStatus = gatedItem.status;
    await api.add("https://bypass.example.com/v.mp4");
    const bypassItem = (await list())[0];
    const bypassStatus = bypassItem.status;
    const folderOverride = bypassItem.dirOverride;
    await api.saveSettings({ scheduleWindowStart: "", scheduleWindowEnd: "", siteRules: [] });
    await api.add("https://open.example.com/v.mp4");
    const openStatus = (await list())[0].status;
    // resume contract per state (seed ids; sandbox ticker is inert so no
    // background advance): d3 queued -> running, then scheduled -> running;
    // d4 paused -> running; d5 error -> running; terminal states rejected.
    const rQueued = await resume("d3");
    await api.schedule({ id: "d3", mode: "set", scheduledStart: "2026-09-05T10:00", scheduledStop: "2026-09-05T12:00" });
    const sched = byId(await list(), "d3");
    const rScheduled = await resume("d3");
    const rPaused = await resume("d4");
    const rError = await resume("d5");
    const rDone = await resume("d7");
    const rDuplicate = await resume("d6");
    await api.cancel("d2");
    const rCancelled = await resume("d2");

    // proxy contract per rule class (proxy.js pickBest semantics), then OFF.
    await api.saveSettings({ autoProxy: true });
    const addOne = async (url) => {
      await api.addMany([url]);
      const items = await list();
      return items[0].proxy;
    };
    const pExact = await addOne("https://supjav.com/p.mp4");
    const pWildcard = await addOne("https://cdn2.mayzaent.com/p.mp4");
    const pDirectRule = await addOne("https://go.mnaspm.com/p.mp4");
    const pNoRule = await addOne("https://example.com/p.mp4");
    await api.saveSettings({ autoProxy: false });
    const pAutoProxyOff = await addOne("https://supjav.com/p.mp4");
    await api.saveSettings({ autoProxy: true });




    return {
      promptIsNull,
      scheduled: sched ? { id: sched.id, status: sched.status, start: sched.scheduledStart, stop: sched.scheduledStop } : null,
      resume: { paused: rPaused, error: rError, scheduled: rScheduled, queued: rQueued,
        done: rDone, duplicate: rDuplicate, cancelled: rCancelled },
      proxy: { exact: pExact, wildcard: pWildcard, directRule: pDirectRule,
        noRule: pNoRule, autoProxyOff: pAutoProxyOff },
      queue: { pausedAll, pauseCount, resumedD1, resumeCount, retryFailedCount, d5AfterRetry },
      window: { closedStatus, bypassStatus, folderOverride, openStatus }
    };
  })();
}
// Drive the REAL app modules (downloader.js DownloadManager.resume, proxy.js
// ProxyManager.pickBest) headlessly, so the selftest guards the app itself
// rather than only the demo shim. Both are plain CommonJS with npm deps only.
function appGuards() {
  const os = require("os");
  const { DownloadManager } = require(path.join(ROOT, "downloader.js"));
  const { ProxyManager } = require(path.join(ROOT, "proxy.js"));

  // DownloadManager.resume per state. A fresh temp download dir keeps the
  // constructor's history/downloaded loads on an empty tree; pump and
  // checkScheduled are stubbed so resume never starts real downloads.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepgrab-selftest-"));
  const dm = new DownloadManager({
    config: { downloadDir: dir, saveHistory: false },
    proxyManager: null,
    onUpdate: () => {}
  });
  dm.pump = () => {};
  dm.checkScheduled = () => {};
  const states = ["paused", "error", "scheduled", "queued", "running", "done", "duplicate", "cancelled"];
  const resume = {};
  for (const st of states) {
    // public() exists on real items; emit(item) calls it (onUpdate is a no-op).
    const item = { id: st, status: st, public: function () { return this; } };
    if (st === "error") item.error = "stale";
    dm.items.set(st, item);
    dm.resume(st);
    resume[st] = item.status;
  }
  // an error resume must also clear the error and re-arm the queue pump
  const errItem = dm.items.get("error");
  const errorCleared = errItem.error === "" && dm._queuedIds.has("error") && errItem.speed === 0;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }

  // ProxyManager.pickBest per rule class, latency stubbed so no network is
  // touched: the dead rule proxy exercises the fall-back-to-pool branch.
  const pm = new (class extends ProxyManager {
    constructor() {
      super({
        proxies: ["http://127.0.0.1:7890", "socks5://127.0.0.1:1080"],
        proxyRules: [
          { host: "supjav.com", proxy: "http://127.0.0.1:7890" },
          { host: "*.mayzaent.com", proxy: "socks5://127.0.0.1:1080" },
          { host: "go.mnaspm.com", proxy: "direct" },
          { host: "dead.example.com", proxy: "http://127.0.0.1:9999" }
        ],
        ua: "DeepGrab-selftest"
      });
    }
    testLatency(p) { return Promise.resolve(p.url.includes("9999") ? null : { ms: 1, status: 200 }); }
  })();
  const pick = async (url) => {
    const p = await pm.pickBest(url, 100);
    return p ? p.url.replace(/\/$/, "") : null; // URL.href adds a trailing slash
  };
  return (async () => {
    const proxy = {
      exact: await pick("https://supjav.com/452555.html"),
      wildcard: await pick("https://cdn2.mayzaent.com/p.mp4"),
      directRule: await pick("https://go.mnaspm.com/p.mp4"),
      deadRule: await pick("https://dead.example.com/p.mp4"),
      noRule: await pick("https://example.com/p.mp4")
    };
    return { resume, errorCleared, proxy };
  })();
}
function neededMethods(src) {
  const called = new Set();
  for (const m of src.matchAll(/window\.api\.([A-Za-z_$][\w$]*)/g)) called.add(m[1]);
  const special = specialActs(src);
  for (const act of emittedActs(src)) if (!special.has(act)) called.add(act);
  for (const act of batchActs(src)) called.add(act);
  return called;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Element IDs renderer.js queries, each tagged guarded/unguarded. A usage is
// guarded when the $("id") result is assigned to a variable on the same line
// and an `if (var)` / `if (!var)` check follows within a few lines (the
// renderer.js pattern for optional elements). Inline/chained uses are not.
function neededIds() {
  const lines = fs.readFileSync(SRC_JS, "utf8").split(/\r?\n/);
  const usage = new Map(); // id -> { guarded, unguarded }
  const idRe = /\$\("([^"]+)"\)|\$\('([^']+)'\)|getElementById\("([^"]+)"\)|querySelector\("#([A-Za-z_][\w-]*)"\)/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    idRe.lastIndex = 0;
    while ((m = idRe.exec(line)) !== null) {
      const id = m[1] || m[2] || m[3] || m[4];
      const set = usage.get(id) || { guarded: false, unguarded: false };
      const assignRe = new RegExp("(?:const|let|var)\\s+(\\w+)\\s*=\\s*\\$\\([\"']" + escRe(id) + "[\"']\\)");
      const assign = assignRe.exec(line);
      let guarded = false;
      if (assign) {
        const varName = assign[1];
        for (let j = i + 1; j <= Math.min(i + 4, lines.length - 1); j++) {
          if (new RegExp("if\\s*\\(!?" + escRe(varName) + "\\)").test(lines[j])) { guarded = true; break; }
        }
      }
      if (guarded) set.guarded = true; else set.unguarded = true;
      usage.set(id, set);
    }
  }
  return usage;
}

// Markup check: which neededIds are absent from the given html.
// Returns { missingGuarded: [...], missingUnguarded: [...] }.
function markupDrift(html, ids = neededIds()) {
  const have = new Set();
  for (const m of html.matchAll(/id="([^"]+)"/g)) have.add(m[1]);
  const missingUnguarded = [], missingGuarded = [];
  for (const [id, flags] of ids) {
    if (have.has(id)) continue;
    if (flags.unguarded) missingUnguarded.push(id); else missingGuarded.push(id);
  }
  return { missingGuarded, missingUnguarded };
}

// Attribute-level markup coupling: renderer.js fills the input whose id equals
// the Browse button's data-browse value ($(btn.dataset.browse)). The values are
// authored in the markup, so a dangling one is drift — the guard in renderer.js
// (`if (!inp) return`) makes it a silent no-op, never a crash.
function browseTargets(html) {
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const all = [...html.matchAll(/data-browse="([^"]+)"/g)].map((m) => m[1]);
  return { total: all.length, dangling: all.filter((v) => !ids.has(v)) };
}

// ---- data-sel attribute coupling -------------------------------------------
// Unlike data-act/data-browse the attribute VALUE is a runtime item id
// (data-sel="${esc(it.id)}"), so nothing enumerable exists to diff. What can
// drift is structure, and it drifts silently: a selection-change handler whose
// table's row template stops rendering the checkbox (or renders it on a
// non-checkbox element) never fires; a handler table whose markup lost the
// column misaligns. Each side below is derived from source, not hand-listed.

// Change listeners bound via $("id").addEventListener("change", …) whose block
// references data-sel / dataset.sel — the selection-change handlers. Returns
// [{ id, line, ref }] where ref is the query form used (closest(...),
// querySelectorAll(...), or plain dataset.sel reads).
function selHandlers(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const bind = /\$\("([A-Za-z_][\w-]*)"\)\.addEventListener\("change"/.exec(lines[i]);
    if (!bind) continue;
    let ref = null;
    // listener block runs until its closing ");" (renderer.js style), capped
    // at 25 lines so a runaway window can't bleed into later code.
    for (let j = i; j < Math.min(lines.length, i + 25); j++) {
      if (/data-sel|dataset\.sel/.test(lines[j])) {
        ref = /closest\(/.test(lines[j]) ? "closest(input[data-sel])" :
          /querySelectorAll\(/.test(lines[j]) ? "querySelectorAll(input[data-sel])" : "dataset.sel";
        break;
      }
      if (j > i && /^\s*\}\);/.test(lines[j])) break;
    }
    if (ref) out.push({ id: bind[1], line: i + 1, ref });
  }
  return out;
}

// Lines where a row template emits data-sel="…", tagged with the template
// function they sit in and whether the attribute lands on a type="checkbox"
// input (the only element the handlers' input[data-sel] selectors can match).
function selEmitters(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  let fn = "<top-level>";
  for (let i = 0; i < lines.length; i++) {
    const decl = /^function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i]);
    if (decl) fn = decl[1];
    else {
      const arrow = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(lines[i]);
      if (arrow) fn = arrow[1];
    }
    if (!lines[i].includes("data-sel=")) continue;
    const around = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
    const checkbox = /<input\b(?=[^>]*\btype="checkbox")(?=[^>]*\bdata-sel=)[^>]*>/.test(around);
    out.push({ fn, line: i + 1, checkbox });
  }
  return out;
}

// Top-level function bodies as text chunks (a chunk runs from one `function
// name(` to the next, so trailing top-level code rides on the last one).
function fnChunks(src) {
  const decls = [...src.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => ({ name: m[1], index: m.index }));
  const chunks = [];
  let prev = 0, prevName = "<top-level>";
  for (const d of decls) {
    chunks.push({ name: prevName, text: src.slice(prev, d.index) });
    prev = d.index;
    prevName = d.name;
  }
  chunks.push({ name: prevName, text: src.slice(prev) });
  return chunks.filter((c) => c.text.trim());
}

// Render-path cross-check: for each handler-bound body id, is there a function
// that both touches the body ($("id")) and renders the checkbox — either by
// calling a checkbox-emitting template or by emitting data-sel itself? An id
// with no such path means the handler can never fire.
function selRenderPaths(src, handlerIds, emitterFns) {
  const chunks = fnChunks(src);
  return handlerIds.map((id) => {
    const bodyRe = new RegExp('\\$\\(\\"' + escRe(id) + '\\"\\)');
    const via = chunks
      .filter((c) => bodyRe.test(c.text))
      .filter((c) =>
        c.text.includes("data-sel=") ||
        [...emitterFns].some((f) => f !== "<top-level>" && new RegExp("\\b" + escRe(f) + "\\s*\\(").test(c.text))
      )
      .map((c) => c.name);
    return { id, via };
  });
}

// Markup column contract: the table hosting each data-sel change handler must
// declare the checkbox column in its <thead> (<th class="sel">) — the header
// row the per-row checkboxes line up under (and where the select-all lives).
function selColumns(html, handlerIds) {
  return handlerIds.map((id) => {
    const bodyAt = html.indexOf('<tbody id="' + id + '"');
    if (bodyAt === -1) return { id, ok: false, why: 'no <tbody id="' + id + '"> in markup' };
    const tableAt = html.lastIndexOf("<table", bodyAt);
    const theadEnd = html.indexOf("</thead>", tableAt);
    if (theadEnd === -1) return { id, ok: false, why: "no </thead> after enclosing <table>" };
    const thead = html.slice(tableAt, theadEnd);
    const selTh = [...thead.matchAll(/<th\b[^>]*>/g)].some((x) => /class="[^"]*\bsel\b[^"]*"/.test(x[0]));
    return { id, ok: selTh, why: selTh ? "" : 'table has no <th class="sel"> column for the row checkboxes' };
  });
}

// ---- self-test -------------------------------------------------------------
// The drift checks above are only as trustworthy as the scans that feed them.
// SELF_GOLDEN snapshots what each scan must derive from the CURRENT sources
// (captured from the known-good renderer.js/renderer.html on 2026-09-04). A
// future edit to the scanner — a regex, a classification, the chunking — that
// silently changes a derivation now fails `--selftest` instead of drifting.
// When renderer.js legitimately grows a new action/table/id, update
// SELF_GOLDEN (the watcher's own drift checks keep exercising the scans live).
const SELF_GOLDEN = {
  emitted: ["cancel", "forceDownload", "history-date", "history-error", "move", "pause", "remove", "resume", "retry", "schedule"],
  special: ["history-date", "history-error", "move", "schedule"],
  batch: ["cancel", "pause", "remove", "resume"],
  apiRouted: ["cancel", "forceDownload", "pause", "remove", "resume", "retry"],
  browseTotal: 3,
  idCount: 60,
  selHandlers: [{ id: "dlsBody", ref: "closest(input[data-sel])" }],
  selEmitters: [{ fn: "rowHtml", checkbox: true }],
  selPathVia: ["render"],
  shimExposed: 33
};

const sorted = (xs) => [...xs].sort();
// Order-insensitive array equality: SELF_GOLDEN lists stay readable in any
// order, so a golden edit can't fail the self-test merely for being unsorted.
const same = (a, b) =>
  a.length === b.length && a.every((v) => b.some((w) => JSON.stringify(v) === JSON.stringify(w)));

async function selfTest() {
  const src = fs.readFileSync(SRC_JS, "utf8");
  const html = fs.readFileSync(SRC_HTML, "utf8");
  let pass = 0, fail = 0, skipped = 0;
  const check = (name, got, expected, ok) => {
    if (ok) pass++;
    else {
      fail++;
      console.error("SELF-TEST FAIL: " + name + " — expected " + JSON.stringify(expected) + ", got " + JSON.stringify(got));
    }
  };

  const emitted = sorted(emittedActs(src));
  check("emittedActs", emitted, SELF_GOLDEN.emitted, same(emitted, SELF_GOLDEN.emitted));
  const special = sorted(specialActs(src));
  check("specialActs", special, SELF_GOLDEN.special, same(special, SELF_GOLDEN.special));
  const batch = sorted(batchActs(src));
  check("batchActs", batch, SELF_GOLDEN.batch, same(batch, SELF_GOLDEN.batch));
  const apiRouted = sorted(emitted.filter((a) => !special.includes(a)));
  check("api-routed acts (emitted − special)", apiRouted, SELF_GOLDEN.apiRouted, same(apiRouted, SELF_GOLDEN.apiRouted));

  const browse = browseTargets(html);
  check("browseTargets total", browse.total, SELF_GOLDEN.browseTotal, browse.total === SELF_GOLDEN.browseTotal);
  check("browseTargets dangling", browse.dangling, [], browse.dangling.length === 0);

  const ids = neededIds();
  check("neededIds count", ids.size, SELF_GOLDEN.idCount, ids.size === SELF_GOLDEN.idCount);
  const drift = markupDrift(html, ids);
  check("markup drift unguarded", drift.missingUnguarded, [], drift.missingUnguarded.length === 0);
  check("markup drift guarded", drift.missingGuarded, [], drift.missingGuarded.length === 0);

  const handlers = selHandlers(src).map(({ id, ref }) => ({ id, ref }));
  check("selHandlers", handlers, SELF_GOLDEN.selHandlers, same(handlers, SELF_GOLDEN.selHandlers));
  const emitters = selEmitters(src).map(({ fn, checkbox }) => ({ fn, checkbox }));
  check("selEmitters", emitters, SELF_GOLDEN.selEmitters, same(emitters, SELF_GOLDEN.selEmitters));
  const paths = selRenderPaths(src, SELF_GOLDEN.selHandlers.map((h) => h.id), SELF_GOLDEN.selEmitters.map((e) => e.fn));
  check("selRenderPaths", paths.map((p) => p.via), [SELF_GOLDEN.selPathVia],
    paths.length === 1 && same(paths[0].via, SELF_GOLDEN.selPathVia));
  const cols = selColumns(html, SELF_GOLDEN.selHandlers.map((h) => h.id));
  check("selColumns", cols.map((c) => ({ id: c.id, ok: c.ok })), [{ id: "dlsBody", ok: true }],
    cols.length === 1 && cols[0].ok && cols[0].id === SELF_GOLDEN.selHandlers[0].id);

  if (fs.existsSync(SHIM_JS)) {
    const exposed = shimMethods();
    check("shim exposed methods", exposed.length, SELF_GOLDEN.shimExposed, exposed.length === SELF_GOLDEN.shimExposed);
    const needed = sorted(neededMethods(src));
    const missing = needed.filter((m) => !exposed.includes(m));
    check("neededMethods ⊆ shim", missing, [], missing.length === 0);
    const beh = await shimBehaviors();
    check("shim prompt stub returns null (dialog-safe)", beh.promptIsNull, true, beh.promptIsNull === true);
    const wantSched = { id: "d3", status: "scheduled", start: "2026-09-05T10:00", stop: "2026-09-05T12:00" };
    const gotSched = beh.scheduled;
    check("shim schedule stores start/stop as scheduled", gotSched, wantSched,
      !!gotSched && gotSched.id === wantSched.id && gotSched.status === wantSched.status &&
        gotSched.start === wantSched.start && gotSched.stop === wantSched.stop);
    // resume guard contract: resumable states flip to running, terminal states
    // are rejected with state unchanged (mirrors downloader.js resume()).
    const wantResume = { paused: "running", error: "running", scheduled: "running", queued: "running",
      done: "done", duplicate: "duplicate", cancelled: "cancelled" };
    check("shim resume per state", beh.resume, wantResume,
      !!beh.resume && JSON.stringify(beh.resume) === JSON.stringify(wantResume));
    // proxy contract per rule class (mirrors proxy.js pickBest).
    const wantProxy = { exact: "http://127.0.0.1:7890", wildcard: "socks5://127.0.0.1:1080",
      directRule: "direct", noRule: "http://127.0.0.1:7890", autoProxyOff: "direct" };
    check("shim proxyFor per class", beh.proxy, wantProxy,


      !!beh.proxy && JSON.stringify(beh.proxy) === JSON.stringify(wantProxy));
    // queue-wide controls + retry: pauseAll freezes running/queued/scheduled,
    // resumeAll brings paused back, retryFailed skips requires-browser but
    // explicit retry flips an errored item to running.
    const wantQueue = { pausedAll: true, pauseCount: 4, resumedD1: "queued", resumeCount: 4, retryFailedCount: 0, d5AfterRetry: "running" };
    check("shim queue-wide controls + retry", beh.queue, wantQueue,
      !!beh.queue && JSON.stringify(beh.queue) === JSON.stringify(wantQueue));
    // global schedule window + site rules: outside the window new downloads
    // stay queued unless a rule carries start (bypass); inside they run;
    // folder rules apply to the item.
    const wantWindow = { closedStatus: "queued", bypassStatus: "running", folderOverride: "D:/RulesFolder", openStatus: "running" };
    check("shim window gating + site rules", beh.window, wantWindow,
      !!beh.window && JSON.stringify(beh.window) === JSON.stringify(wantWindow));

    // real app guard contracts (not the shim): DownloadManager.resume
    // transitions only paused/error/scheduled -> queued (pump starts them),
    // rejects terminal/active states; ProxyManager.pickBest honors per-host
    // rules with pool fallback. These assert the app code itself.
    const app = await appGuards();
    const wantAppResume = { paused: "queued", error: "queued", scheduled: "queued", queued: "queued",
      running: "running", done: "done", duplicate: "duplicate", cancelled: "cancelled" };
    check("app resume per state (real DownloadManager)", app.resume, wantAppResume,
      !!app.resume && JSON.stringify(app.resume) === JSON.stringify(wantAppResume) && app.errorCleared === true);
    const wantAppProxy = { exact: "http://127.0.0.1:7890", wildcard: "socks5://127.0.0.1:1080",
      directRule: null, deadRule: "http://127.0.0.1:7890", noRule: "http://127.0.0.1:7890" };
    check("app pickBest per class (real ProxyManager)", app.proxy, wantAppProxy,
      !!app.proxy && JSON.stringify(app.proxy) === JSON.stringify(wantAppProxy));
  } else {
    skipped++;
    console.error("selftest: skipping shim-method assertions (" + SHIM_JS + " not present)");
  }

  if (fail) {
    console.error("selftest: " + fail + " assertion(s) FAILED");
    return false;
  }
  console.log("selftest: " + pass + " assertions passed (scan outputs match SELF_GOLDEN)" +
    (skipped ? "; " + skipped + " skipped" : ""));
  return true;
}

function sync() {
  const html = generate();
  const src = fs.readFileSync(SRC_JS, "utf8");
  let ok = true;

  // method coverage (static window.api.* calls + data-act api fall-throughs +
  // #batch* routes, all derived from renderer.js)
  const implemented = new Set(shimMethods());
  const missingMethods = [...neededMethods(src)].filter((m) => !implemented.has(m));
  if (missingMethods.length) {
    ok = false;
    console.error("MISSING mock methods (renderer.js calls them, demo-api-shim.js doesn't): " + missingMethods.join(", "));
    console.error("Add mock logic for them (see .freebuff/run.md), then rerun this generator.");
  }

  // markup coverage
  const ids = neededIds();
  const drift = markupDrift(html, ids);
  const total = ids.size;
  if (drift.missingUnguarded.length || drift.missingGuarded.length) {
    console.error("MARKUP DRIFT: " + total + " element IDs queried by renderer.js, " +
      (drift.missingUnguarded.length + drift.missingGuarded.length) + " missing from renderer.html markup:");
    if (drift.missingUnguarded.length) {
      ok = false;
      console.error("  unguarded (would throw in the real app too): " + drift.missingUnguarded.join(", "));
    }
    if (drift.missingGuarded.length) {
      console.error("  guarded-only (tolerated, but check intent): " + drift.missingGuarded.join(", "));
    }
  }

  // attribute coverage: data-browse targets resolve, data-act routing classified
  const browse = browseTargets(html);
  if (browse.dangling.length) {
    ok = false;
    console.error("DATA-BROWSE DRIFT: " + browse.dangling.length + " of " + browse.total +
      " Browse button(s) target a missing element id (the button would silently do nothing): " +
      browse.dangling.join(", "));
  }

  // data-sel coverage: selection-change handlers must be fed by row templates
  // that render the checkbox on a checkbox input, in a table whose header
  // declares the column. Every failure below is a silent death of row
  // selection in the real app, so each is a hard failure.
  const handlers = selHandlers(src);
  const emitters = selEmitters(src);
  const nonCheckbox = emitters.filter((e) => !e.checkbox);
  const emitterFns = [...new Set(emitters.filter((e) => e.checkbox).map((e) => e.fn))];
  const noEmitter = handlers.length > 0 && emitterFns.length === 0;
  if (nonCheckbox.length) {
    ok = false;
    console.error("DATA-SEL DRIFT: data-sel is rendered on a non-checkbox element (" +
      nonCheckbox.map((e) => e.fn + ":" + e.line).join(", ") +
      ") — change handlers' input[data-sel] selectors can never match it.");
  }
  if (noEmitter) {
    ok = false;
    console.error("DATA-SEL DRIFT: " + handlers.length + " selection-change handler(s) on " +
      handlers.map((h) => h.id).join(", ") + " query input[data-sel] (" + handlers[0].ref +
      ") but no row template renders a data-sel checkbox.");
  }
  const paths = selRenderPaths(src, handlers.map((h) => h.id), emitterFns);
  const orphanHandlers = paths.filter((p) => p.via.length === 0);
  // when no checkbox template exists at all (noEmitter above), every handler is
  // orphaned by construction — the root-cause message already covers it
  if (orphanHandlers.length && !noEmitter) {
    ok = false;
    console.error("DATA-SEL DRIFT: rows for " + orphanHandlers.map((p) => p.id).join(", ") +
      " are never built by a checkbox-rendering template (" + emitterFns.join(", ") +
      ") — the handler would never fire.");
  }
  const cols = selColumns(html, handlers.map((h) => h.id));
  const missingCols = cols.filter((c) => !c.ok);
  if (missingCols.length) {
    ok = false;
    console.error("DATA-SEL DRIFT: " + missingCols.map((c) => c.id + ": " + c.why).join("; "));
  }

  const emitted = emittedActs(src);
  const special = specialActs(src);
  const apiActs = [...emitted].filter((a) => !special.has(a));
  const selOk = !nonCheckbox.length && !noEmitter && !orphanHandlers.length && !missingCols.length;

  const driftNote = missingMethods.length || drift.missingUnguarded.length || drift.missingGuarded.length ||
    browse.dangling.length || !selOk ? " — DRIFT ABOVE" : "";
  console.log("demo-renderer.html regenerated; shim covers all " + implemented.size +
    " exposed methods (" + neededMethods(src).size + " called); markup has " + (total - drift.missingUnguarded.length - drift.missingGuarded.length) + "/" + total + " queried IDs; data-browse " +
    (browse.total - browse.dangling.length) + "/" + browse.total + " resolve; data-act " + emitted.size +
    " emitted (" + special.size + " special-cased, " + apiActs.length + " api-routed); data-sel " +
    handlers.length + " selection handler(s)" + (handlers.length ? " (" + handlers.map((h) => h.id).join(", ") + ", " + handlers[0].ref + ") fed by " +
      (emitterFns.length ? emitterFns.join(", ") : "no checkbox template") : "") + "; sel column " +
    (cols.length - missingCols.length) + "/" + cols.length + driftNote + ".");
  return ok;
}

if (require.main === module) {
  if (process.argv.includes("--watch")) {
    console.log("watching " + SRC_HTML + " and " + SRC_JS + " for changes…");
    let timer = null;
    for (const file of [SRC_HTML, SRC_JS]) {
      fs.watch(file, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          try { sync(); } catch (e) { console.error("sync failed: " + e.message); }
        }, 200);
      });
    }
  } else if (process.argv.includes("--selftest")) {
    selfTest()
      .then((ok) => process.exit(ok ? 0 : 1))
      .catch((e) => {
        console.error("selftest failed: " + e.message);
        process.exit(1);
      });
  } else {
    try {
      process.exit(sync() ? 0 : 1);
    } catch (e) {
      console.error("sync failed: " + e.message);
      process.exit(1);
    }
  }
} else {
  // Internals stay private — --selftest is the probe surface for the scans.
  module.exports = { sync, generate, selfTest };
}
