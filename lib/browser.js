"use strict";
// Built-in capture browser (Deep Grab extension): BrowserView tab map, tab
// organizers, per-tab auto-scroll engine, idle-tab sweeper, and the Deep Grab
// extension loader. Extracted verbatim from main.js; the only app-owned inputs
// are injected via the factory: getConfig (settings reads) and cookieHeaderFor
// (cookie lookup for the auto-scroll HEAD probe). Electron-bound, so not
// unit-testable headlessly; the pure helpers (domainOf/normTabUrl/
// candidateNextPage) are exported for tests.
const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, BrowserView, session } = require("electron");
const { requestWithRedirects } = require("./http");
const browserOpen = require("./browser-open");

function createBuiltinBrowser({ getConfig, cookieHeaderFor }) {
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
    getConfig().extensionPath,
    app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked", "extension") : null,
    path.join(__dirname, "..", "extension")
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
    const mins = Number(getConfig().idleTabMinutes) || 0;
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
      preload: path.join(__dirname, "..", "browser-preload.js"),
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
  browserWindow.loadFile(path.join(__dirname, "..", "browser.html")).catch(() => {});
  browserWindow.webContents.once("did-finish-load", () => {
    const l = pendingTabs; pendingTabs = [];
    if (l.length) browserOpen.queueBrowserOpenMany(l);
    else bvAddTab("https://www.google.com");
  });
}
  return {
    open: (urls) => createBrowserWindow(urls),
    openTab,
    drainPendingTabs: () => { const t = pendingTabs; pendingTabs = []; return t; },
    closeTabForUrl: (url) => bvCloseTabForUrl(url),
    loadExtension: () => loadBrowserExtension(),
    startIdleSweeper: () => startIdleTabSweeper(),
    resolveExtensionDir,
    bv: {
      newTab: () => { if (browserWindow && !browserWindow.isDestroyed()) bvAddTab("https://www.google.com"); },
      close: (id) => bvCloseTab(id),
      activate: (id) => bvActivate(id),
      dupes: () => bvCloseDuplicates(),
      group: () => bvGroupByDomain(),
      closeOthers: () => bvCloseOthers(),
      closeDomain: () => bvCloseDomain(),
      closeAll: () => bvCloseAll(),
      groupMode: (on) => { bvGroupMode = !!on; if (browserWindow && !browserWindow.isDestroyed()) try { browserWindow.webContents.send("browser-group-mode", bvGroupMode); } catch (e) { /* ignore */ } },
      navigate: (url) => {
        if (!activeBrowserId) return;
        const en = browserTabs.get(activeBrowserId);
        if (!en) return;
        let u = String(url || "").trim();
        if (!u) return;
        if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) u = "https://" + u;
        en.view.webContents.loadURL(u).catch(() => {});
      },
      back: () => { if (activeBrowserId) { const en = browserTabs.get(activeBrowserId); if (en) en.view.webContents.goBack(); } },
      forward: () => { if (activeBrowserId) { const en = browserTabs.get(activeBrowserId); if (en) en.view.webContents.goForward(); } },
      reload: () => { if (activeBrowserId) { const en = browserTabs.get(activeBrowserId); if (en) en.view.webContents.reload(); } },
      contentRect: (rect) => {
        if (rect && typeof rect.width === "number" && typeof rect.height === "number") {
          browserContentRect = { x: rect.x || 0, y: rect.y || 0, width: rect.width, height: rect.height };
          bvPositionActive();
        }
      },
      newtabMode: (on) => { bvNewTabMode = !!on; },
      autoscroll: () => {
        if (!activeBrowserId) return;
        if (autoScrollTimers.has(activeBrowserId)) stopAutoScroll(activeBrowserId);
        else startAutoScroll(activeBrowserId);
        bvPushNav();
      }
    }
  };
}

module.exports = { createBuiltinBrowser };

