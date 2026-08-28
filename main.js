// Electron main: window + WebSocket server (127.0.0.1:8765) + download manager wiring.

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});

const { app, BrowserWindow, BrowserView, ipcMain, shell, clipboard, session } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const { WebSocketServer } = require("ws");
const { DownloadManager, requestWithRedirects } = require("./downloader");
const { ProxyManager } = require("./proxy");
const browserOpen = require("./lib/browser-open");
const wsBridge = require("./lib/ws-bridge");
const { DEFAULT_CONFIG, loadConfig, saveConfig, validateConfig } = require("./config");

// Dev builds read/write config.json next to main.js (gitignored). Packaged
// apps must NOT write into the read-only app.asar — use the writable userData
// dir so settings actually persist in an installed build.
const CONFIG_PATH = app.isPackaged
  ? path.join(app.getPath("userData"), "config.json")
  : path.join(__dirname, "config.json");
// Config defaults + (de)serialization/validation live in ./config (unit-tested via `node test-config.js`).




// HEAD the URL to learn its size + content type for the extension's rules.
async function probeUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, size: 0, mime: "", error: "Invalid URL" };
  }
  try {
    const result = await requestWithRedirects(url, {
      method: "HEAD",
      headers: { Range: "bytes=0-0" },
      retries: 0,
      maxRetries: 1
    });
    const cr = /bytes\s+\d+-\d+\/(\d+)/i.exec(result.headers["content-range"] || "");
    const size = cr ? parseInt(cr[1], 10) : parseInt(result.headers["content-length"] || "0", 10);
    const mime = (result.headers["content-type"] || "").split(";")[0].trim();
    return { ok: true, size: Number.isFinite(size) ? size : 0, mime };
  } catch (e) {
    return { ok: false, size: 0, mime: "", error: e.message };
  }
}

let config = loadConfig(CONFIG_PATH);
let proxyManager = new ProxyManager(config);
let dm = new DownloadManager({ config, proxyManager, onUpdate: pushUpdate, cookieProvider: (url) => cookieHeaderFor(url), onRequiresBrowser: (url) => browserOpen.queueBrowserOpen(url) });
let mainWindow = null;
let wss = null;

// Batched renderer/extension updates: progress ticks fire up to several times
// per second per download; coalescing them into a ~100ms flush window keeps
// IPC + WS traffic proportional to what the user sees, not to disk throughput.
const UPDATE_FLUSH_MS = 100;
const updateQueue = [];
let updateFlushTimer = null;

function pushUpdate(item) {
  updateQueue.push(item);
  if (!updateFlushTimer) {
    updateFlushTimer = setTimeout(flushUpdates, UPDATE_FLUSH_MS);
  }
}

function flushUpdates() {
  updateFlushTimer = null;
  if (!updateQueue.length) return;
  const batch = updateQueue.splice(0, updateQueue.length);
  if (mainWindow && !mainWindow.isDestroyed() && batch.length) {
    mainWindow.webContents.send("download-update", batch.length === 1 ? batch[0] : batch);
  }
  // relay status back to the extension over WebSocket (one status per entry)
  const clients = wss ? Array.from(wss.clients) : [];
  if (clients.length && clients.some((c) => c.readyState === 1)) {
    const payloads = batch.map((item) => JSON.stringify({
      type: "status",
      id: item.id,
      url: item.url,
      label: item.label,
      fileName: item.fileName,
      status: item.status,
      total: item.total,
      received: item.received,
      progress: item.total ? item.received / item.total : 0,
      speed: item.speed,
      proxy: item.proxy,
      error: item.error,
      errorCategory: item.errorCategory,
      refreshCount: item.refreshCount,
      finalPath: item.finalPath,
      thumb: item.thumb || ""
    }));
    clients.forEach((client) => {
      if (client.readyState === 1) {
        for (const p of payloads) {
          try { client.send(p); } catch (e) { /* ignore */ }
        }
      }
    });
  }
  // Auto-close the built-in browser tab that produced each finished download
  // and move to the next, when enabled (matches by source page / referer URL).
  if (config.autoCloseTab && browserWindow && !browserWindow.isDestroyed()) {
    for (const item of batch) {
      if (item.status === "done" || item.status === "error" || item.status === "cancelled") {
        bvCloseTabForUrl(item.referer || item.url);
      }
    }
  }
}

async function cookieHeaderFor(url) {
  if (!url || !/^https?:/i.test(url)) return "";
  try {
    const sess = session.fromPartition("persist:deepgrab-browser");
    const cs = await sess.cookies.get({ url });
    return cs.map((c) => encodeURIComponent(c.name) + "=" + encodeURIComponent(c.value)).join("; ");
  } catch (e) {
    return "";
  }
}

async function gatherCookieHeader(urls) {
  const parts = [];
  const seen = new Set();
  for (const u of urls) {
    const s = await cookieHeaderFor(u);
    for (const pair of s.split("; ")) {
      if (pair && !seen.has(pair)) { seen.add(pair); parts.push(pair); }
    }
  }
  return parts.join("; ");
}

function startWsServer() {
  wss = new WebSocketServer({ host: "127.0.0.1", port: config.port });

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "hello", version: "1.0.0", port: config.port }));
    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        return;
      }
      try {
        await wsBridge.handleWsMessage(msg, {
          dm,
          gatherCookieHeader,
          probeUrl,
          send: (o) => { try { ws.send(JSON.stringify(o)); } catch (e) { /* ignore */ } }
        });
      } catch (e) {
        try { ws.send(JSON.stringify({ type: "error", message: e.message, url: msg.url })); } catch (_) {}
      }
    });
    ws.on("error", () => {});
  });

  wss.on("listening", () => {
    console.log(`[ws] listening on ws://127.0.0.1:${config.port}`);
  });

  wss.on("error", (err) => {
    console.error("[ws] " + err.message);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    title: "Deep Video Downloader",
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, "renderer.html"));
  mainWindow.on("closed", () => { mainWindow = null; });
}

// ---------------- built-in browser (Deep Grab extension) ----------------
let browserWindow = null;
// Throttled auto-open queue for requires-browser URLs lives in lib/browser-open
// (so it's unit-testable). Wire its opener: open a single tab (creating the
// browser window if needed); bulk opens go through queueBrowserOpenMany so they
// are themselves concurrency-capped instead of opening everything at once.
function openTab(u) {
  if (!browserWindow || browserWindow.isDestroyed()) createBrowserWindow(u);
  else bvAddTab(u);
}
browserOpen.setOpener(openTab);

// Real browser UA for the built-in browser. Anti-bot/Cloudflare sites serve a
// stripped or "verify you are human" partial page to the default Electron UA; a
// normal Chrome UA lets the managed challenge complete and the page render fully.
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function browserSession() {
  const ses = session.fromPartition("persist:deepgrab-browser");
  try { ses.setUserAgent(BROWSER_UA); } catch (e) { /* session not ready yet */ }
  return ses;
}

// Resolve the Deep Grab extension folder: honor config.extensionPath only if it
// actually holds a manifest (a stale path silently disabled the browser's
// extension), otherwise fall back to the packaged asar.unpacked copy and then
// __dirname/extension (dev). Returns the real path or null.
function resolveExtensionDir() {
  const candidates = [
    config.extensionPath,
    app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked", "extension") : null,
    path.join(__dirname, "extension")
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "manifest.json"))) return c;
  }
  return null;
}

async function loadBrowserExtension() {
  const extPath = resolveExtensionDir();
  if (!extPath) {
    console.warn("[browser] Deep Grab extension not found (checked config.extensionPath, asar.unpacked, __dirname/extension)");
    return;
  }
  console.log("[browser] loading Deep Grab extension from:", extPath);
  try {
    const ses = browserSession();
    if (ses.getAllExtensions().length === 0) {
      let info;
      try {
        info = await ses.loadExtension(extPath);
      } catch (e1) {
        // some Electron builds require explicit file access for unpacked ext
        console.warn("[browser] loadExtension failed, retrying with allowFileAccess:", e1.message);
        info = await ses.loadExtension(extPath, { allowFileAccess: true });
      }
      console.log("[browser] loaded Deep Grab extension:", info && info.id);
    }
  } catch (e) {
    console.error("[browser] failed to load extension:", e.message);
  }
}

let pendingTabs = [];
let browserTabs = new Map();   // id -> { id, view, url, title }
let activeBrowserId = null;
let browserSeq = 0;
// When on, page-initiated navigations (link clicks, location.href) open a new
// tab instead of replacing the current one. Address-bar Go / back / forward /
// reload are unaffected (Electron doesn't fire will-navigate for them).
let bvNewTabMode = true;
// Auto group-by-site: keep tabs sorted by domain as new ones are added
// (persisted renderer-side via localStorage; sent here on startup + toggle).
let bvGroupMode = false;
// Per-tab infinite scroll loops: entry id -> setInterval handle. Each tick
// scrolls ~85% of a viewport and, when already at the bottom, clicks any
// common "load more" / next-page control before scrolling again.
const autoScrollTimers = new Map();
const autoScrollState = new Map(); // id -> { h, still, next } for UI diagnostics
// Finds the element that actually scrolls (window OR an inner overflow div),
// fires a wheel nudge for lazy-loaders, clicks non-anchor "load more" buttons,
// and reports the next-page link so the main process can turn the page itself
// (paginated sites like supjav have no infinite scroll — ?page=2 / › / Next).
const LOAD_MORE_JS = `(function(){
  function scroller() {
    var se = document.scrollingElement || document.documentElement;
    if (se && se.scrollHeight > se.clientHeight + 100) return se;
    var best = null, bestH = 0;
    var els = document.querySelectorAll('div, main, section, ul');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.scrollHeight > el.clientHeight + 200 && el.scrollHeight > bestH) {
        var oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll' || el === document.body) { best = el; bestH = el.scrollHeight; }
      }
    }
    return best || se;
  }
  function nextPageUrl() {
    var nx = document.querySelector('a[rel="next"], .pagination .next, .next.page-numbers');
    if (nx && nx.href && /^https?:/.test(nx.href)) return nx.href;
    var cands = document.querySelectorAll('[class*="pagination"] a, [class*="pager"] a, [class*="page-num"] a, nav a');
    for (var i = 0; i < cands.length; i++) {
      var a = cands[i];
      var t = String(a.textContent || '').trim();
      if ((t === '\u203a' || t === '>' || /^(next|\u4e0b\u4e00\u9875)$/i.test(t)) && a.href && /^https?:/.test(a.href)) return a.href;
    }
    return '';
  }
  var btnSels = ['button[class*="load-more"]','button[class*="show-more"]','button[class*="more"]','[role="button"][class*="more"]'];
  var sc = scroller();
  if (!sc) return { h: 0, next: '' };
  var step = Math.max(300, (sc.clientHeight || window.innerHeight) * 0.85);
  var atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 300;
  var next = '';
  if (atBottom) {
    next = nextPageUrl();
    for (var i = 0; !next && i < btnSels.length; i++) {
      var el = document.querySelector(btnSels[i]);
      if (el && el.offsetWidth > 0 && el.offsetHeight > 0) { el.click(); break; }
    }
  }
  try { sc.dispatchEvent(new WheelEvent('wheel', { deltaY: step, bubbles: true, cancelable: true })); } catch (e2) {}
  window.scrollBy(0, step);
  if (sc !== document.documentElement && sc !== document.scrollingElement) sc.scrollBy(0, step);
  try { window.dispatchEvent(new Event('scroll')); } catch (e3) {}
  return { h: sc.scrollHeight, next: next };
})()`;

function stopAutoScroll(id) {
  const t = autoScrollTimers.get(id);
  if (t) clearInterval(t);
  autoScrollState.delete(id);
  if (!autoScrollTimers.delete(id)) return;
  bvPushNav();
}

// Paginated listings (supjav/jable WordPress themes) use /page/N/ paths or
// ?page=N — derive the next page from the URL when the DOM has no next link.
function candidateNextPage(url) {
  try {
    const u = new URL(url);
    const m = /^(.*\/page\/)(\d+)(\/?)$/.exec(u.pathname);
    if (m) { u.pathname = m[1] + (parseInt(m[2], 10) + 1) + m[3]; return u.href; }
    const q = u.searchParams.get("page");
    if (q && /^\d+$/.test(q)) { u.searchParams.set("page", String(parseInt(q, 10) + 1)); return u.href; }
    if (/\/\d+\/?$/.test(u.pathname) && !/\.\w+$/.test(u.pathname)) {
      u.pathname = u.pathname.replace(/(\d+)(\/?)$/, (s, n, sl) => (parseInt(n, 10) + 1) + sl);
      return u.href;
    }
  } catch (e) { /* not a paginated URL */ }
  return "";
}

// HEAD-check a candidate page so we never navigate into a 404. 403 is allowed
// optimistically: it usually means Cloudflare answers our HEAD but the browser
// view already has clearance and renders fine.
async function urlReachable(url) {
  try {
    const cookie = await cookieHeaderFor(url);
    const res = await requestWithRedirects(url, {
      method: "HEAD",
      headers: cookie ? { Cookie: cookie } : {},
      retries: 0,
      maxRetries: 1
    });
    try { res.res.resume(); } catch (e) { /* ignore */ }
    return res.status < 400 || res.status === 403;
  } catch (e) {
    return false;
  }
}

function startAutoScroll(id) {
  if (autoScrollTimers.has(id)) return;
  let lastH = -1;
  let stillTicks = 0;
  let lastNav = "";
  autoScrollState.set(id, { h: 0, still: 0, next: "" });
  const timer = setInterval(() => {
    const en = browserTabs.get(id);
    if (!en || en.view.webContents.isDestroyed()) { stopAutoScroll(id); return; }
    en.view.webContents.executeJavaScript(LOAD_MORE_JS, true).then(async (r) => {
      const h = r ? r.h : 0;
      let next = (r && r.next) || "";
      // Stuck at bottom ~4s -> turn the page in THIS tab. Prefer a link found
      // in the DOM; otherwise derive /page/N+1 / ?page=N from the URL.
      if (stillTicks > 10 && !next && h > 0) next = candidateNextPage(en.view.webContents.getURL());
      const st = autoScrollState.get(id) || { h: 0, still: 0, next: "" };
      st.h = h; st.still = stillTicks; st.next = next;
      autoScrollState.set(id, st);
      bvPushNav();
      if (next && next !== lastNav && stillTicks > 10) {
        const cur = en.view.webContents.getURL().split("#")[0];
        if (next.split("#")[0] !== cur && await urlReachable(next)) {
          lastNav = next;
          stillTicks = 0;
          lastH = -1;
          en.view.webContents.loadURL(next).catch(() => {});
          return;
        }
      }
      if (h === lastH) { if (++stillTicks > 50) stopAutoScroll(id); }
      else { stillTicks = 0; lastH = h; }
    }).catch(() => { /* mid-navigation — keep looping */ });
  }, 400);
  autoScrollTimers.set(id, timer);
}
let browserContentRect = { x: 0, y: 86, width: 1200, height: 850 - 86 };

function bvPositionActive() {
  if (!browserWindow || browserWindow.isDestroyed() || !activeBrowserId) return;
  const e = browserTabs.get(activeBrowserId);
  if (!e) return;
  try { e.view.setBounds(browserContentRect); } catch (e2) { /* ignore */ }
}

function bvPushTabs() {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const list = [];
  browserTabs.forEach((e) => list.push({ id: e.id, title: e.title || e.url, url: e.url, suspended: !!e.suspended }));
  try { browserWindow.webContents.send("browser-tabs-update", list, activeBrowserId); } catch (e) { /* ignore */ }
}

function bvPushNav() {
  if (!browserWindow || browserWindow.isDestroyed() || !activeBrowserId) return;
  const e = browserTabs.get(activeBrowserId);
  if (!e) return;
  const wc = e.view.webContents;
  try {
    browserWindow.webContents.send("browser-nav-state", {
      canGoBack: wc.canGoBack(),
      canGoForward: wc.canGoForward(),
      url: wc.getURL(),
      autoscroll: autoScrollTimers.has(e.id),
      autoInfo: autoScrollState.get(e.id) || null
    });
  } catch (e) { /* ignore */ }
}

// Shared factory so a suspended tab can be revived with identical wiring.
function bvMakeView(entry) {
  const view = new BrowserView({
    webPreferences: {
      session: browserSession(),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  view.setBackgroundColor("#0f172a");
  view.webContents.on("page-title-updated", (ev, title) => { entry.title = title; bvPushTabs(); });
  view.webContents.on("did-navigate", (ev, u) => { entry.url = u; bvRedirecting = false; bvPushTabs(); bvPushNav(); });
  view.webContents.on("did-navigate-in-page", (ev, u) => { entry.url = u; bvPushTabs(); });
  view.webContents.on("did-start-loading", () => bvPushNav());
  view.webContents.on("did-stop-loading", () => { entry.url = view.webContents.getURL(); entry.lastActive = Date.now(); bvPushTabs(); bvPushNav(); });

  // target=_blank / window.open become tabs instead of popup windows.
  // background-tab disposition (middle-click) lands without stealing focus.
  view.webContents.setWindowOpenHandler(({ url: u, disposition }) => {
    if (/^https?:/i.test(u)) bvAddTab(u, { activate: disposition !== "background-tab" });
    return { action: "deny" };
  });
  // New-tab mode: intercept user-initiated navigations and spawn a tab instead
  // of replacing the current one. Redirects (server 302 / refresh) follow in
  // place so a redirecting page does not cascade into an endless tab loop.
  let bvRedirecting = false;
  view.webContents.on("will-redirect", () => { bvRedirecting = true; });
  view.webContents.on("will-navigate", (ev, u) => {
    if (!bvNewTabMode || !/^https?:/i.test(u)) return;
    if (bvRedirecting) { bvRedirecting = false; return; }
    if (u === entry.url) return;
    ev.preventDefault();
    bvAddTab(u);
  });
  return view;
}

function bvAddTab(url, opts) {
  const activate = !(opts && opts.activate === false);
  if (!browserWindow || browserWindow.isDestroyed()) return null;
  const id = "bv" + (++browserSeq);
  const entry = { id, url: url || "https://www.google.com", title: "", lastActive: Date.now(), suspended: false };
  entry.view = bvMakeView(entry);
  browserTabs.set(id, entry);

  entry.view.webContents.loadURL(entry.url).catch(() => {});
  if (activate) bvActivate(id);
  else bvPushTabs();
  if (bvGroupMode) bvGroupByDomain();
  return id;
}

// OPTIMIZER: unload an idle tab's webContents to free memory but keep the
// strip entry; clicking the tab revives it by reloading its last URL.
function bvSuspendTab(id) {
  const e = browserTabs.get(id);
  if (!e || e.suspended || !e.view) return;
  try {
    const wc = e.view.webContents;
    if (wc && !wc.isDestroyed()) {
      e.url = wc.getURL() || e.url;
      stopAutoScroll(id);
      try { browserWindow.removeBrowserView(e.view); } catch (e2) { /* ignore */ }
      try { wc.destroy(); } catch (e3) { /* ignore */ }
    }
  } catch (e2) { /* ignore */ }
  e.view = null;
  e.suspended = true;
  bvPushTabs();
}

function bvActivate(id) {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const e = browserTabs.get(id);
  if (!e) return;
  e.lastActive = Date.now();
  if (e.suspended || !e.view) {
    e.suspended = false;
    e.view = bvMakeView(e);
    e.view.webContents.loadURL(e.url).catch(() => {});
  }
  browserTabs.forEach((en) => { try { browserWindow.removeBrowserView(en.view); } catch (e2) { /* ignore */ } });
  try { browserWindow.addBrowserView(e.view); } catch (e2) { /* ignore */ }
  activeBrowserId = id;
  bvPositionActive();
  bvPushTabs();
  bvPushNav();
}

function bvCloseTab(id) {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  stopAutoScroll(id);
  const e = browserTabs.get(id);
  if (!e) return;
  if (e.view) {
    try { browserWindow.removeBrowserView(e.view); } catch (e2) { /* ignore */ }
    try { e.view.webContents.destroy(); } catch (e2) { /* ignore */ }
  }
  browserTabs.delete(id);
  if (activeBrowserId === id) {
    const first = browserTabs.keys().next();
    if (!first.done) bvActivate(first.value);
    else bvAddTab("https://www.google.com");
  } else {
    bvPushTabs();
  }
}

function bvCloseTabForUrl(url) {
  if (!url) return;
  let toClose = null;
  browserTabs.forEach((e) => { if (!toClose && e.url === url) toClose = e.id; });
  if (toClose) bvCloseTab(toClose);
}

function domainOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return (url || "").toLowerCase(); }
}
function normTabUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    if (u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.href.toLowerCase();
  } catch (e) { return (url || "").toLowerCase(); }
}

// ORGANIZER: close tabs whose URL duplicates another (keep the first / active).
function bvCloseDuplicates() {
  const seen = new Set();
  const toClose = [];
  browserTabs.forEach((e) => {
    const key = normTabUrl(e.url);
    if (seen.has(key)) toClose.push(e.id);
    else seen.add(key);
  });
  toClose.forEach((id) => bvCloseTab(id));
  if (toClose.length) console.log("[browser] closed " + toClose.length + " duplicate tab(s)");
}

// ORGANIZER: sort tabs so same-site tabs are adjacent.
function bvGroupByDomain() {
  const entries = [...browserTabs.entries()].sort((a, b) => domainOf(a[1].url).localeCompare(domainOf(b[1].url)));
  browserTabs = new Map(entries);
  if (activeBrowserId) bvActivate(activeBrowserId);
  bvPushTabs();
}

// ORGANIZER: close every tab except the active one.
function bvCloseOthers() {
  const keep = activeBrowserId;
  [...browserTabs.keys()].forEach((id) => { if (id !== keep) bvCloseTab(id); });
}

// ORGANIZER: close every tab on the active tab's domain.
function bvCloseDomain() {
  if (!activeBrowserId) return;
  const dom = domainOf(browserTabs.get(activeBrowserId).url);
  [...browserTabs.keys()].forEach((id) => { if (domainOf(browserTabs.get(id).url) === dom) bvCloseTab(id); });
}

// ORGANIZER: close all tabs (a fresh blank tab is left by bvCloseTab).
function bvCloseAll() {
  [...browserTabs.keys()].forEach((id) => bvCloseTab(id));
}

// OPTIMIZER: auto-suspend tabs idle longer than idleTabMinutes (unload the
// webContents to free memory; the strip entry stays and reloads on click).
function startIdleTabSweeper() {
  setInterval(() => {
    const mins = (config && Number(config.idleTabMinutes)) || 0;
    if (!mins || !browserWindow || browserWindow.isDestroyed()) return;
    const cutoff = Date.now() - mins * 60000;
    [...browserTabs.keys()].forEach((id) => {
      if (id === activeBrowserId) return;          // never suspend the active tab
      if (autoScrollTimers.has(id)) return;         // don't interrupt captures
      const e = browserTabs.get(id);
      if (e && e.lastActive && e.lastActive < cutoff) {
        console.log("[browser] idle suspend: " + (e.title || e.url));
        bvSuspendTab(id);
      }
    });
  }, 30000);
}

function sendBrowserTabs(urls, kind) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!browserWindow || browserWindow.isDestroyed()) { pendingTabs = pendingTabs.concat(list); return; }
  list.forEach((u) => bvAddTab(u));
}

function createBrowserWindow(urls) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (browserWindow && !browserWindow.isDestroyed()) {
    browserWindow.show(); browserWindow.focus();
    browserOpen.queueBrowserOpenMany(list);
    return;
  }
  pendingTabs = list;
  browserWindow = new BrowserWindow({
    width: 1200,
    height: 850,
    title: "Deep Grab Browser",
    backgroundColor: "#0f172a",
    webPreferences: {
      session: browserSession(),
      webviewTag: false,
      preload: path.join(__dirname, "browser-preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  browserWindow.on("resize", () => bvPositionActive());
  browserWindow.on("closed", () => {
    autoScrollTimers.forEach((t) => clearInterval(t));
    autoScrollTimers.clear();
    browserTabs.forEach((e) => { try { e.view.webContents.destroy(); } catch (e2) { /* ignore */ } });
    browserTabs.clear();
    activeBrowserId = null;
    browserWindow = null;
  });
  browserWindow.loadFile(path.join(__dirname, "browser.html")).catch(() => {});
  browserWindow.webContents.once("did-finish-load", () => {
    const l = pendingTabs; pendingTabs = [];
    if (l.length) browserOpen.queueBrowserOpenMany(l);
    else bvAddTab("https://www.google.com");
  });
}

// Locate an installed external browser executable (Chrome/Edge/Brave), or null.
function findBrowser(name) {
  const candidates = {
    chrome: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe")
    ],
    edge: [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
    ],
    brave: [
      "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      path.join(os.homedir(), "AppData", "Local", "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
    ]
  };
  return (candidates[name] || []).find((p) => fs.existsSync(p)) || null;
}

// Open a URL in an external browser (chrome/edge/brave/default).
function openInExternalBrowser(url, browser) {
  const target = String(browser || "default").toLowerCase();
  // only http(s) ever reaches the shell — reject file:/javascript:/ms-msdt: etc.
  let s = String(url || "").trim();
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = "https://" + s;
  let href;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return { error: "invalid-url", browser: target };
    href = u.href;
  } catch (e) {
    return { error: "invalid-url", browser: target };
  }
  if (target === "default") {
    shell.openExternal(href).catch(() => {});
    return { ok: true, browser: target, exe: "system-default" };
  }
  const exe = findBrowser(target);
  if (!exe) return { error: "not-found", browser: target };
  execFile(exe, [href], (err) => {
    if (err) console.error("[browser] launch error:", err.message);
  });
  return { ok: true, browser: target, exe };
}

// Resolve the Deep Grab extension folder (same precedence as loadBrowserExtension).
function extensionDir() {
  return resolveExtensionDir();
}

// One-click install: launch a real Chrome/Edge/Brave with Deep Grab loaded.
// Chromium only honors --load-extension on a NON-default profile, so we run a
// dedicated user-data-dir that persists — the extension stays loaded every time
// that profile is opened, without touching the user's normal profile.
function launchExtensionInBrowser(browser) {
  const name = String(browser || "chrome").toLowerCase();
  const exe = findBrowser(name);
  if (!exe) return { error: "not-found", browser: name };
  const ext = extensionDir();
  if (!ext) return { error: "no-extension", browser: name };
  const profile = path.join(app.getPath("userData"), "browser-profile-" + name);
  execFile(exe, [
    "--user-data-dir=" + profile,
    "--load-extension=" + ext,
    "--no-first-run",
    "chrome://extensions"
  ], (err) => {
    if (err) console.error("[browser] extension launch error:", err.message);
  });
  return { ok: true, browser: name, exe, profile, extension: ext };
}

// ---------------- clipboard monitoring ----------------
const VIDEO_DOMAINS = [
  "streamtape.com",
  "fstape.com",
  "cnporn.org",
  "xvideos.com",
  "xhamster.com",
  "pornhub.com",
  "javhub.net",
  "jable.tv",
  "missav.ws",
  "missav.ai",
  "missav.com",
  "missav.live",
  "missav.xyz",
  "supjav.com",
  "supremejav.com"
];

let lastClipboardContent = "";
let clipboardMonitor = null;

function isValidVideoUrl(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return VIDEO_DOMAINS.some((domain) => lower.includes(domain)) && /^https?:\/\//.test(lower);
}

function startClipboardMonitor() {
  if (clipboardMonitor) return;
  clipboardMonitor = setInterval(() => {
    try {
      const content = clipboard.readText();
      if (content !== lastClipboardContent && isValidVideoUrl(content)) {
        lastClipboardContent = content;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("clipboard-url", { url: content.trim() });
        }
      }
    } catch (e) {
      // ignore clipboard errors
    }
  }, 5000);
}

function stopClipboardMonitor() {
  if (clipboardMonitor) {
    clearInterval(clipboardMonitor);
    clipboardMonitor = null;
  }
}

// ---------------- IPC ----------------
ipcMain.handle("settings-get", () => config);
ipcMain.handle("settings-save", (e, next) => {
  const allowed = new Set(Object.keys(DEFAULT_CONFIG));
  const clean = {};
  if (next && typeof next === "object") {
    for (const k of Object.keys(next)) if (allowed.has(k)) clean[k] = next[k];
  }
  config = validateConfig({ ...config, ...clean });
  saveConfig(CONFIG_PATH, config);
  proxyManager = new ProxyManager(config);
  dm.config = config;
  dm.proxyManager = proxyManager; // drop stale bad/latency proxy state
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
  const { dialog } = require("electron");
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
  const n = dm.addPending(urls, typeof dirOverride === "string" && dirOverride.trim() ? dirOverride : null);
  return { ok: true, count: n };
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
  const list = proxyManager.list();
  const results = [];
  await Promise.all(list.map(async (p) => {
    const lat = await proxyManager.testLatency(p, testUrl, 6000);
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
  const { dialog } = require("electron");
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

// ---------------- File associations (open .mp4/.m3u8/... with this app) ----------------
const ASSOC_EXT_LIST = ["mp4", "m4v", "webm", "mov", "mkv", "flv", "m3u8"];
const ASSOC_EXT = /\.(mp4|m4v|webm|mov|mkv|flv|m3u8)$/i;
const ASSOC_APP_KEY = "HKCU\\Software\\Classes\\Applications\\DeepVideoDownloader.exe";

function regRun(args) {
  return new Promise((resolve) => {
    execFile("reg.exe", args, { windowsHide: true }, () => resolve());
  });
}

function regValueExists(key, name) {
  return new Promise((resolve) => {
    execFile("reg.exe", ["query", key, "/v", name], { windowsHide: true }, (err) => {
      resolve(err === null);
    });
  });
}

const ASSOC_MARKER_KEY = "HKCU\\Software\\DeepVideoDownloader";

// Registers the app in the "Open with" menu for video files every launch, and
// makes it the default player exactly once (tracked by a HKCU marker). If the
// user later picks another default in Windows settings, this never overrides it.
async function registerFileAssociations() {
  if (process.platform !== "win32" || !app.isPackaged) return;
  const exe = process.execPath;
  const alreadyDefault = await regValueExists(ASSOC_MARKER_KEY, "DefaultAssocSet");
  for (const ext of ASSOC_EXT_LIST) {
    const progId = `DeepVideoDownloader.${ext}`;
    await regRun(["add", `HKCU\\Software\\Classes\\${progId}`, "/t", "REG_SZ", "/d", `${ext.toUpperCase()} video`, "/f"]);
    await regRun(["add", `HKCU\\Software\\Classes\\${progId}\\DefaultIcon`, "/t", "REG_SZ", "/d", `"${exe}",0`, "/f"]);
    await regRun(["add", `HKCU\\Software\\Classes\\${progId}\\shell\\open\\command`, "/t", "REG_SZ", "/d", `"${exe}" "%1"`, "/f"]);
    await regRun(["add", `${ASSOC_APP_KEY}\\SupportedTypes`, "/v", ext, "/t", "REG_SZ", "/d", "", "/f"]);
    await regRun(["add", `${ASSOC_APP_KEY}\\shell\\open\\command`, "/t", "REG_SZ", "/d", `"${exe}" "%1"`, "/f"]);
    if (!alreadyDefault) {
      await regRun(["add", `HKCU\\Software\\Classes\\.${ext}`, "/ve", "/t", "REG_SZ", "/d", progId, "/f"]);
    }
  }
  if (!alreadyDefault) {
    await regRun(["add", ASSOC_MARKER_KEY, "/v", "DefaultAssocSet", "/t", "REG_SZ", "/d", "1", "/f"]);
  }
}

function openedFileFromArgv(argv) {
  return (argv || []).find((a) => {
    if (!a || typeof a !== "string") return false;
    if (a.startsWith("-")) return false;
    if (/^https?:\/\//i.test(a)) return a;
    if (/^[a-z]:[\\/]/i.test(a) && ASSOC_EXT.test(a)) return a;
    return false;
  }) || null;
}

function handleOpenedFile(target) {
  if (/^https?:\/\//i.test(target)) {
    dm.enqueue({ url: target, title: "", referer: "" })
      .then((id) => console.log("[file-open] enqueued " + id))
      .catch((e) => console.error("[file-open] " + e.message));
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const info = { path: target, name: path.basename(target) };
  try {
    const st = fs.statSync(target);
    info.size = st.size;
  } catch (e) { /* file may not exist yet */ }
  mainWindow.webContents.send("file-opened", info);
}

const gotLock = app.requestSingleInstanceLock();

if (gotLock) {
  app.on("second-instance", (event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const target = openedFileFromArgv(argv);
    if (target) handleOpenedFile(target);
  });

  ipcMain.handle("browser-open", (e, urls) => { createBrowserWindow(urls); });
  ipcMain.handle("browser-nav", (e, url) => { createBrowserWindow(url); });
  ipcMain.handle("browser-get-tabs", () => { const t = pendingTabs; pendingTabs = []; return t; });
  ipcMain.on("bv-new-tab", () => { if (browserWindow && !browserWindow.isDestroyed()) bvAddTab("https://www.google.com"); });
ipcMain.on("bv-close", (e, id) => { bvCloseTab(id); });
ipcMain.on("bv-activate", (e, id) => { bvActivate(id); });
ipcMain.on("bv-dupes", () => { bvCloseDuplicates(); });
ipcMain.on("bv-group", () => { bvGroupByDomain(); });
ipcMain.on("bv-close-others", () => { bvCloseOthers(); });
ipcMain.on("bv-close-domain", () => { bvCloseDomain(); });
ipcMain.on("bv-close-all", () => { bvCloseAll(); });
ipcMain.on("bv-group-mode", (e, on) => { bvGroupMode = !!on; if (bvGroupMode) bvGroupByDomain(); });
  ipcMain.on("bv-navigate", (e, url) => {
    if (!activeBrowserId) return;
    const en = browserTabs.get(activeBrowserId);
    if (!en) return;
    let u = String(url || "").trim();
    if (!u) return;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) u = "https://" + u;
    en.view.webContents.loadURL(u).catch(() => {});
  });
  ipcMain.on("bv-back", () => { if (activeBrowserId) { const en = browserTabs.get(activeBrowserId); if (en) en.view.webContents.goBack(); } });
  ipcMain.on("bv-forward", () => { if (activeBrowserId) { const en = browserTabs.get(activeBrowserId); if (en) en.view.webContents.goForward(); } });
  ipcMain.on("bv-reload", () => { if (activeBrowserId) { const en = browserTabs.get(activeBrowserId); if (en) en.view.webContents.reload(); } });
  ipcMain.on("bv-content-rect", (e, rect) => {
    if (rect && typeof rect.width === "number" && typeof rect.height === "number") {
      browserContentRect = { x: rect.x || 0, y: rect.y || 0, width: rect.width, height: rect.height };
      bvPositionActive();
    }
  });
  ipcMain.on("bv-newtab-mode", (e, on) => { bvNewTabMode = !!on; });
  ipcMain.on("bv-autoscroll", () => {
    if (!activeBrowserId) return;
    if (autoScrollTimers.has(activeBrowserId)) stopAutoScroll(activeBrowserId);
    else startAutoScroll(activeBrowserId);
    bvPushNav();
  });
  ipcMain.handle("browser-external", (e, url, browser) => openInExternalBrowser(url, browser));
  ipcMain.handle("extension-install", (e, browser) => launchExtensionInBrowser(browser));

  app.whenReady().then(() => {
    startWsServer();
    createWindow();
    loadBrowserExtension();
    startClipboardMonitor();
    startIdleTabSweeper();
    registerFileAssociations();
    // Backfill thumbnails for old downloads (missing .thumb.jpg) after startup
    // settles; each new thumb nudges the renderer to refresh the history list.
    setTimeout(() => {
      dm.backfillThumbs(() => {
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("history-updated"); } catch (e) { /* ignore */ }
      }).then((n) => { if (n) console.log("[thumbs] backfilled " + n + " thumbnail(s)"); }).catch(() => {});
    }, 8000);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    const target = openedFileFromArgv(process.argv);
    if (target) handleOpenedFile(target);
  });

  app.on("window-all-closed", () => {
    stopClipboardMonitor();
    if (process.platform !== "darwin") app.quit();
  });

  app.on("quit", () => {
    stopClipboardMonitor();
    if (dm && typeof dm.flush === "function") dm.flush();
    if (wss) wss.close();
  });
} else {
  app.quit();
}
