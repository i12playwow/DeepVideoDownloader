// Renderer <-> main IPC channel registration. Every ipcMain.handle/on lives
// here so main.js is lifecycle/window code only and the full channel surface
// is reviewable in one file. `ctx` carries the app singletons and closures
// main.js owns: { ipcMain, shell, dialog, dm, settings,
//   getProxyManager, browser: { open, getTabs, external, install },
//   bv: { newTab, close, activate, dupes, group, closeOthers, closeDomain,
//         closeAll, groupMode, navigate, back, forward, reload, contentRect,
//         newtabMode, autoscroll } }
// The bv.* closures read/write the built-in browser state (browserTabs,
// activeBrowserId, ...) from main.js scope. settings.update (lib/settings.js)
// validates + persists the merged config; main.js's onApply hook rebuilds
// proxyManager/dm from the result.
"use strict";
const fs = require("fs");
const { URL } = require("url");
function registerIpc(ctx) {
  const { ipcMain, shell, dialog, dm, settings, getProxyManager, browser, bv } = ctx;

// ---------------- IPC ----------------
ipcMain.handle("settings-get", () => settings.get());
ipcMain.handle("settings-save", (e, next) => { // whitelist + validate + persist + apply (lib/settings.js)
  settings.update(next);
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
