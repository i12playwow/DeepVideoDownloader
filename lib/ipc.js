// Renderer <-> main IPC channel registration. Every ipcMain.handle/on lives
// here so main.js is lifecycle/window code only and the full channel surface
// is reviewable in one file. `ctx` carries the app singletons and closures
// main.js owns: { ipcMain, shell, dialog, dm, settings,
//   getProxyManager, browser: { open, getTabs, external, install },
//   bv: { newTab, close, activate, dupes, group, closeOthers, closeDomain,
//         closeAll, groupMode, navigate, back, forward, reload, contentRect,
//         newtabMode, autoscroll },
//   bridge: { snapshot, push } (paired WS clients — main.js owns the registry;
//           `push` broadcasts a fresh snapshot to the window),
//   statusLog: { recent, clear } (the Status log panel's ring — main.js owns it
//           and pushes "status-log" itself; recent serves the pull-on-load,
//           clear empties the ring for the panel's Clear button)
// The bv.* closures read/write the built-in browser state (browserTabs,
// activeBrowserId, ...) from main.js scope. settings.update (lib/settings.js)
// validates + persists the merged config; main.js's onApply hook rebuilds
// proxyManager/dm from the result.
"use strict";
const fs = require("fs");
const { URL } = require("url");
function registerIpc(ctx) {
  const { ipcMain, shell, dialog, clipboard, dm, settings, getProxyManager, browser, bv, bridge } = ctx;

// ---------------- IPC ----------------
ipcMain.handle("settings-get", () => settings.get());
ipcMain.handle("settings-save", (e, next) => { // whitelist + validate + persist + apply (lib/settings.js)
  settings.update(next);
  return { ok: true };
});
ipcMain.handle("status-log-recent", () => ctx.statusLog.recent()); // Status log panel pull-on-load (ring lives in main.js)
ipcMain.handle("status-log-clear", () => { ctx.statusLog.clear(); return { ok: true }; });
ipcMain.handle("copy-text", (e, text) => { // copy arbitrary text (the Status log panel's Copy action); text must be a string
  if (typeof text !== "string") throw new Error("copy-text expects a string");
  clipboard.writeText(text);
  return { ok: true };
});

ipcMain.handle("downloads-list", () => dm.list());
ipcMain.handle("downloads-history", () => dm.listHistory());
ipcMain.handle("bandwidth-stats", () => dm.getBandwidthStats());
ipcMain.handle("downloads-clear-history", () => {
  dm.history = [];
  dm._saveHistory();
  return { ok: true };
});
ipcMain.handle("downloads-export", async (e, format = "json") => {
  const data = dm.exportHistory(format);
  const result = await dialog.showSaveDialog({
    title: "Export Download History",
    defaultPath: format === "csv" ? "downloads-history.csv" : "downloads-history.json",
    filters: [{ name: format === "csv" ? "CSV" : "JSON", pattern: format === "csv" ? "*.csv" : "*.json" }]
  });
  if (!result.canceled && result.filePath) {
    fs.writeFileSync(result.filePath, data, "utf8");
    return { ok: true, path: result.filePath };
  }
  return { ok: false, canceled: true };
});

ipcMain.handle("download-pause", (e, id) => { dm.pause(id); return { ok: true }; });
ipcMain.handle("download-resume", (e, id) => { dm.resume(id); return { ok: true }; });
ipcMain.handle("download-pause-all", () => ({ ok: true, count: dm.pauseAll() }));
ipcMain.handle("download-resume-all", () => ({ ok: true, count: dm.resumeAll() }));
ipcMain.handle("download-retry-failed", () => ({ ok: true, count: dm.retryFailed() }));
ipcMain.handle("download-retry", (e, id) => ({ ok: dm.retry(id) }));
ipcMain.handle("download-prioritize", (e, id) => ({ ok: dm.prioritize(id) }));
ipcMain.handle("download-resume-last", async () => {
  try {
    const id = await dm.resumeLast();
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("download-cancel", (e, id) => { dm.cancel(id); return { ok: true }; });
ipcMain.handle("download-remove", (e, id) => { dm.remove(id); return { ok: true }; });
ipcMain.handle("downloads-add", async (e, url, dirOverride) => {
  if (!url || typeof url !== "string") return { ok: false, error: "Invalid URL" };
  try {
    let title = "video";
    try {
      const u = new URL(url);
      title = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
    } catch (err) { /* keep default title */ }
    const id = await dm.enqueue({ url, title, referer: "", dirOverride: typeof dirOverride === "string" && dirOverride.trim() ? dirOverride : null });
    return { ok: true, id, duplicate: id !== null && dm.isDownloaded(url) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
// Batch import — hands URLs to the windowed loader (addPending) so thousands of
// URLs are pulled into the active map a few at a time instead of materializing
// them all at once.
ipcMain.handle("downloads-add-many", async (e, urls, dirOverride) => {
  if (!Array.isArray(urls)) return { ok: false, error: "Invalid list" };
  const r = dm.addPending(urls, typeof dirOverride === "string" && dirOverride.trim() ? dirOverride : null);
  return { ok: true, ...r, count: r.added };
});
// JAV-code enqueue — the queue panel's JAV code input (renderer.html #javCode).
// Resolution runs through the CLI's own chain (scripts/jav-dl.js _internals, the
// exact functions the CLI drives: slug sweep incl. the -uncensored-leak/-sub
// suffixes, then the MissAV-search/Wayback-mirror fallback), read through
// process.env so the app boot's JAVDL_SITE keeps the drill offline. The
// DOWNLOAD goes to the app's own DownloadManager — same engine class the CLI
// constructs — so the item gets the queue table, progress bars, pause/resume,
// auto-retry, site-rule folders and history like every other download. The
// resolve is fire-and-forget (a MissAV sweep can take seconds and surrit can
// gate the probe for minutes) — the handler returns immediately, the UI tracks
// the item in the table and the [jav] lines ride the Status log.
let javDlMod = null; // cached require: resolution seams + JAVDL_SITE coupling
// Sync validation + slug normalization shared by the single-code and batch
// paths — both must reject garbage identically and with the same messages.
function javValidateCode(code) {
  if (typeof code !== "string" || !code.trim()) return { ok: false, error: "give a JAV code (e.g. IPZ-721)" };
  if (!javDlMod) {
    try { javDlMod = require("../scripts/jav-dl.js"); }
    catch (err) { return { ok: false, error: "jav-dl resolution unavailable: " + err.message };
    }
  }
  try { return { ok: true, slug: javDlMod.normalizeCode(code) }; }
  catch (err) { return { ok: false, error: err.message }; }
}
// Compact the per-stage miss tags into the not-found receipt:
// ["slug:404","slug:404",...,"search: no result anchors","mirror: 0 wayback rows"]
// -> "slug sweep: 8×404; search: no result anchors; mirror: 0 wayback rows".
function javSummarizeMiss(missLog) {
  const slugTags = {};
  const other = [];
  for (const e of missLog) {
    if (e.startsWith("slug:")) { const t = e.slice(5); slugTags[t] = (slugTags[t] || 0) + 1; }
    else other.push(e);
  }
  const parts = [];
  const slugCounts = Object.entries(slugTags).map(([t, n]) => (n > 1 ? n + "×" + t : t)).join(", ");
  if (slugCounts) parts.push("slug sweep: " + slugCounts);
  parts.push(...other);
  return parts.join("; ");
}
// The whole resolve + enqueue arc for ONE normalized slug. Resolves to a result
// object and never throws: status "queued"|"skipped"|"not-found"|"error". The
// single-code path ignores the result (fire-and-forget); the batch chain
// collects one per code for its summary. A missLog collector rides the
// resolution ctx so the not-found receipt names WHERE the chain died
// (slug sweep / missav search / wayback mirror — per-stage reasons), and the
// enqueued item carries the stage that landed the stream (javStage) so the
// queue table can badge it.
async function javResolveJob(slug, dirOverride, log) {
  const J = javDlMod._internals;
  const missLog = [];
  let m3u8 = null, referer = "", label = slug, stage = "";
  try {
    log("[jav] resolving " + slug + " ...");
    const rctx = { proxyManager: null, config: { maxRetries: 2 }, paceHost: null, missLog }; // the CLI resolution context shape (main.js owns the app ctx)
    const hit = await J.resolveBySlug(slug, rctx);
    if (hit) { m3u8 = hit.m3u8; label = hit.slug; referer = J.SITE + "/"; stage = hit.stage || "slug"; }
    else {
      const fb = await J.fallbackResolve(slug, slug, missLog);
      if (fb) { m3u8 = fb.m3u8; label = fb.label; referer = fb.referer || referer; stage = fb.stage || "fallback"; }
    }
  } catch (err) {
    const why = missLog.length ? " — " + javSummarizeMiss(missLog) : "";
    log("[jav] " + slug + ": " + err.message + why);
    return { ok: false, status: "error", error: err.message };
  }
  if (!m3u8) {
    const why = missLog.length ? " — " + javSummarizeMiss(missLog) : "";
    log("[jav] " + slug + ": not found (MissAV slugs + search/mirror fallback exhausted)" + why);
    return { ok: false, status: "not-found" };
  }
  log("[jav] " + slug + " -> " + label + " [" + stage + "]: " + m3u8);
  try {
    const id = await dm.enqueue({ url: m3u8, title: label, referer,
      dirOverride: typeof dirOverride === "string" && dirOverride.trim() ? dirOverride : null,
      markDuplicate: false, javStage: stage });
    if (!id) { log("[jav] " + slug + ": already downloaded or queued — skipped"); return { ok: false, status: "skipped" }; }
    log("[jav] " + slug + " queued (" + id + ")");
    return { ok: true, status: "queued", id };
  } catch (err) {
    log("[jav] " + slug + ": enqueue failed — " + err.message);
    return { ok: false, status: "error", error: err.message };
  }
}
function javResolveAndEnqueue(code, dirOverride, log) {
  const v = javValidateCode(code);
  if (!v.ok) return v;
  const slug = v.slug;
  (async () => { await javResolveJob(slug, dirOverride, log); })();
  return { ok: true, slug };
}
// Console primary + additive Status-log mirror (the cf-fallback/proxy sink convention):
// the resolve/queue lines survive a window close in app.log AND stream into the panel.
const javLog = (ctx) => (line) => { try { console.log(line); } catch (err2) { /* stdout gone */ }
  try { ctx.statusLog.push(line); } catch (err2) { /* window closing */ } };
ipcMain.handle("jav-add", (e, code, dirOverride) => {
  const log = javLog(ctx);
  try { return javResolveAndEnqueue(code, dirOverride, log); }
  catch (err) { return { ok: false, error: err.message }; }
});
// Batch variant of jav-add: a pasted list resolves ONE code at a time (the
// MissAV sweep is the serial bottleneck — parallelism buys nothing but gate
// risk) under the same fire-and-forget contract: the invoke returns the
// accepted list immediately while each code's [jav] lines stream into the
// Status log, closing with a batch-done summary. A dead code neither kills the
// batch nor enqueues junk — it is skipped and named in the summary.
ipcMain.handle("jav-add-batch", (e, codes, dirOverride) => {
  if (!Array.isArray(codes)) return { ok: false, error: "Invalid code list" };
  const log = javLog(ctx);
  // Validate every token up front (normalizeCode is sync), then dedupe
  // order-preserving on the normalized slug — "abc-123" and "ABC-123" are one
  // code. Empty and non-string tokens are not errors, just not codes.
  const items = [];
  const seen = new Set();
  let rawCount = 0;
  for (const raw of codes) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (!t) continue;
    rawCount++;
    const v = javValidateCode(t);
    const key = v.ok ? v.slug : t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(v.ok ? { code: t, slug: v.slug } : { code: t, error: v.error });
  }
  if (!items.length) return { ok: false, error: "No usable JAV code in the list" };
  const dropped = rawCount - items.length;
  log("[jav] batch: " + items.length + " code" + (items.length === 1 ? "" : "s") +
    (dropped ? " (" + dropped + " duplicate/invalid dropped)" : "") + " — resolving one at a time");
  for (const it of items) { if (it.error) log("[jav] " + it.code + ": " + it.error); }
  (async () => {
    for (const it of items) {
      if (!it.slug) continue;
      let r;
      try { r = await javResolveJob(it.slug, dirOverride, log); }
      catch (err) { r = { status: "error", error: err.message }; }
      Object.assign(it, r);
    }
    const q = items.filter((i) => i.status === "queued").length;
    const s = items.filter((i) => i.status === "skipped").length;
    const f = items.filter((i) => i.error || (i.status && i.status !== "queued" && i.status !== "skipped"));
    log("[jav] batch done: " + q + " queued" +
      (s ? ", " + s + " skipped (already downloaded/queued)" : "") +
      (f.length ? ", " + f.length + " not resolved (" + f.map((i) => i.slug || i.code).join(", ") + ")" : ""));
  })();
  return { ok: true, total: items.length, dropped, codes: items.map((i) => i.slug || i.code) };
});
// Relocate a finished download (and its thumbnail) to another folder.
ipcMain.handle("download-move", async (e, id, destDir) => {
  if (!id || typeof destDir !== "string" || !destDir.trim()) return { ok: false, error: "missing id or folder" };
  try { fs.statSync(destDir); } catch (err) { /* created on demand */ }
  return await dm.moveDownloaded(id, destDir);
});
ipcMain.handle("downloads-force", (e, id) => ({ ok: dm.forceDownload(id) }));
ipcMain.handle("download-schedule", (e, { id, mode, scheduledStart, scheduledStop }) => {
  const item = dm.items.get(id);
  if (!item) return { ok: false, error: "Item not found" };
  if (mode === "set") {
    item.scheduledStart = scheduledStart ? new Date(scheduledStart).getTime() : null;
    item.scheduledStop = scheduledStop ? new Date(scheduledStop).getTime() : null;
  } else if (mode === "clear") {
    item.scheduledStart = null;
    item.scheduledStop = null;
    if (item.status === "scheduled") item.status = "queued";
  }
  dm.emit(item);
  dm.checkScheduled(); // arms the stop-time sweep even for a running item
  return { ok: true };
});

ipcMain.handle("test-proxies", async (e, target) => {
  const testUrl = target && /^https?:/.test(target) ? target : "https://www.google.com";
  const pm = getProxyManager();
  const list = pm.list();
  const results = [];
  await Promise.all(list.map(async (p) => {
    const lat = await pm.testLatency(p, testUrl, 6000);
    results.push({
      proxy: p.url,
      ms: lat ? lat.ms : null,
      status: lat ? lat.status : "fail"
    });
  }));
  return results;
});

// Who is paired with the local WS server right now (the Extension bridge panel):
// client class, browser, wire protocol, and activity timestamps.
ipcMain.handle("clients-list", () => bridge.snapshot());

ipcMain.handle("get-active-dir", () => dm.dir);
// Native folder picker for the Settings storage inputs (returns "" on cancel).
ipcMain.handle("select-dir", async () => {
  const res = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return "";
  return res.filePaths[0];
});
ipcMain.handle("open-dir", () => {
  try {
    const active = dm.dir; // opens the folder downloads currently land in
    fs.mkdirSync(active, { recursive: true });
    shell.openPath(active);
    return { ok: true, dir: active };
  } catch (e) {
    return { ok: false, dir: "", error: String(e.message || e) };
  }
});

ipcMain.handle("open-path", (e, p) => {
  if (!p || typeof p !== "string") return { ok: false };
  shell.showItemInFolder(p);
  return { ok: true };
});

  ipcMain.handle("browser-open", (e, urls) => { browser.open(urls); });
  ipcMain.handle("browser-nav", (e, url) => { browser.open(url); });
  ipcMain.handle("browser-get-tabs", () => browser.getTabs());
  ipcMain.on("bv-new-tab", () => { bv.newTab(); });
ipcMain.on("bv-close", (e, id) => { bv.close(id); });
ipcMain.on("bv-activate", (e, id) => { bv.activate(id); });
ipcMain.on("bv-dupes", () => { bv.dupes(); });
ipcMain.on("bv-group", () => { bv.group(); });
ipcMain.on("bv-close-others", () => { bv.closeOthers(); });
ipcMain.on("bv-close-domain", () => { bv.closeDomain(); });
ipcMain.on("bv-close-all", () => { bv.closeAll(); });
ipcMain.on("bv-group-mode", (e, on) => { bv.groupMode(on); });
  ipcMain.on("bv-navigate", (e, url) => { bv.navigate(url); });
  ipcMain.on("bv-back", () => { bv.back(); });
  ipcMain.on("bv-forward", () => { bv.forward(); });
  ipcMain.on("bv-reload", () => { bv.reload(); });
  ipcMain.on("bv-content-rect", (e, rect) => { bv.contentRect(rect); });
  ipcMain.on("bv-newtab-mode", (e, on) => { bv.newtabMode(on); });
  ipcMain.on("bv-autoscroll", () => { bv.autoscroll(); });
  ipcMain.handle("browser-external", (e, url, b) => browser.external(url, b));
  ipcMain.handle("extension-install", (e, b) => browser.install(b));
}

module.exports = { registerIpc };
