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
let dm = new DownloadManager({ config, proxyManager, onUpdate: pushUpdate, cookieProvider: (url) => cookieHeaderFor(url) });
let mainWindow = null;
let wss = null;

function pushUpdate(item) {
  if (item && item._removed) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("download-update", item);
    }
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("download-update", item);
  }
  // relay status back to the extension over WebSocket
  const clients = wss ? Array.from(wss.clients) : [];
  clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({
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
    }
  });
  // Auto-close the built-in browser tab that produced this download and move
  // to the next, when enabled (matches by the source page / referer URL).
  if (
    config.autoCloseTab &&
    browserWindow && !browserWindow.isDestroyed() &&
    (item.status === "done" || item.status === "error" || item.status === "cancelled")
  ) {
    const ref = item.referer || item.url;
    bvCloseTabForUrl(ref);
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
       if (msg.type === "download") {
         try {
            // `sources` (array of {kind,url,label}) may accompany a download:
            // enqueue every `kind:"link"` entry AND every `kind:"iframe"` entry
            // as its own download (label appended to the file name); fall back to
            // plain `url` when no usable source exists. `iframe` carries the
            // player page (e.g. supjav.php?l=<OLID>) which resolvers turn into a
            // direct URL, so it must be enqueued — only `server` (often a
            // `javascript:` pseudo-URL) is ignored.
            const links = Array.isArray(msg.sources)
              ? msg.sources.filter((s) => s && (s.kind === "link" || s.kind === "iframe") && typeof s.url === "string")
              : [];
           const usable = links.length
             ? links
             : (typeof msg.url === "string" ? [{ kind: "link", url: msg.url, label: "" }] : []);
           if (!usable.length) {
             ws.send(JSON.stringify({ type: "error", message: "No usable source", url: msg.url || "" }));
             return;
           }
           const ids = [];
            for (const s of usable) {
              const cookieHeader = await gatherCookieHeader([s.url, msg.referer]);
              const id = await dm.enqueue({
                url: s.url,
                title: msg.title,
                referer: msg.referer,
                label: s.label || "",
                cookieHeader,
                scheduledStart: msg.scheduledStart ? new Date(msg.scheduledStart).getTime() : null,
                scheduledStop: msg.scheduledStop ? new Date(msg.scheduledStop).getTime() : null
              });
              ids.push(id);
            }
          ws.send(JSON.stringify({ type: "accepted", id: ids[0], ids, url: msg.url }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "error", message: e.message, url: msg.url }));
        }
      }
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
      if (msg.type === "probe") {
        probeUrl(msg.url).then((r) => {
          ws.send(JSON.stringify({ type: "probe-result", url: msg.url, ...r }));
        });
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
  browserTabs.forEach((e) => list.push({ id: e.id, title: e.title || e.url, url: e.url }));
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
      url: wc.getURL()
    });
  } catch (e) { /* ignore */ }
}

function bvAddTab(url) {
  if (!browserWindow || browserWindow.isDestroyed()) return null;
  const id = "bv" + (++browserSeq);
  const view = new BrowserView({
    webPreferences: {
      session: browserSession(),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  view.setBackgroundColor("#0f172a");
  const entry = { id, view, url: url || "https://www.google.com", title: "" };
  browserTabs.set(id, entry);

  view.webContents.on("page-title-updated", (ev, title) => { entry.title = title; bvPushTabs(); });
  view.webContents.on("did-navigate", (ev, u) => { entry.url = u; bvPushTabs(); bvPushNav(); });
  view.webContents.on("did-navigate-in-page", (ev, u) => { entry.url = u; bvPushTabs(); });
  view.webContents.on("did-start-loading", () => bvPushNav());
  view.webContents.on("did-stop-loading", () => { entry.url = view.webContents.getURL(); bvPushTabs(); bvPushNav(); });

  view.webContents.loadURL(entry.url).catch(() => {});
  bvActivate(id);
  return id;
}

function bvActivate(id) {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const e = browserTabs.get(id);
  if (!e) return;
  browserTabs.forEach((en) => { try { browserWindow.removeBrowserView(en.view); } catch (e2) { /* ignore */ } });
  try { browserWindow.addBrowserView(e.view); } catch (e2) { /* ignore */ }
  activeBrowserId = id;
  bvPositionActive();
  bvPushTabs();
  bvPushNav();
}

function bvCloseTab(id) {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const e = browserTabs.get(id);
  if (!e) return;
  try { browserWindow.removeBrowserView(e.view); } catch (e2) { /* ignore */ }
  try { e.view.webContents.destroy(); } catch (e2) { /* ignore */ }
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

function sendBrowserTabs(urls, kind) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!browserWindow || browserWindow.isDestroyed()) { pendingTabs = pendingTabs.concat(list); return; }
  list.forEach((u) => bvAddTab(u));
}

function createBrowserWindow(urls) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (browserWindow && !browserWindow.isDestroyed()) {
    browserWindow.show(); browserWindow.focus();
    list.forEach((u) => bvAddTab(u));
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
    browserTabs.forEach((e) => { try { e.view.webContents.destroy(); } catch (e2) { /* ignore */ } });
    browserTabs.clear();
    activeBrowserId = null;
    browserWindow = null;
  });
  browserWindow.loadFile(path.join(__dirname, "browser.html")).catch(() => {});
  browserWindow.webContents.once("did-finish-load", () => {
    const l = pendingTabs; pendingTabs = [];
    if (l.length) l.forEach((u) => bvAddTab(u));
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
ipcMain.handle("downloads-add", async (e, url) => {
  if (!url || typeof url !== "string") return { ok: false, error: "Invalid URL" };
  try {
    let title = "video";
    try {
      const u = new URL(url);
      title = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
    } catch (err) { /* keep default title */ }
    const id = await dm.enqueue({ url, title, referer: "" });
    return { ok: true, id, duplicate: id !== null && dm.isDownloaded(url) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
// Batch import — hands URLs to the windowed loader (addPending) so thousands of
// URLs are pulled into the active map a few at a time instead of materializing
// them all at once.
ipcMain.handle("downloads-add-many", async (e, urls) => {
  if (!Array.isArray(urls)) return { ok: false, error: "Invalid list" };
  const n = dm.addPending(urls);
  return { ok: true, count: n };
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
  ipcMain.handle("browser-external", (e, url, browser) => openInExternalBrowser(url, browser));
  ipcMain.handle("extension-install", (e, browser) => launchExtensionInBrowser(browser));

  app.whenReady().then(() => {
    startWsServer();
    createWindow();
    loadBrowserExtension();
    startClipboardMonitor();
    registerFileAssociations();
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
