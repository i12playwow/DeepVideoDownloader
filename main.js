// Electron main: window + WebSocket server (127.0.0.1:8765) + download manager wiring.

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});

const { app, BrowserWindow, BrowserView, ipcMain, shell, clipboard, session, Tray, Menu, nativeImage, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const { WebSocketServer } = require("ws");
const { DownloadManager, requestWithRedirects } = require("./downloader");
const { ProxyManager } = require("./proxy");
const browserOpen = require("./lib/browser-open");
const wsBridge = require("./lib/ws-bridge");
const { createSettings } = require("./lib/settings");
const { createBuiltinBrowser } = require("./lib/browser");
const { registerIpc } = require("./lib/ipc");

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

// Runtime settings state + the single mutation path live in lib/settings.js.
// The onApply hook rebuilds the engine singletons below; it is only invoked
// later, by settings.update from the settings-save IPC, so referencing the
// `let` bindings declared after this block is safe (no TDZ hit at boot).
const settings = createSettings({
  watch: true, // external config.json edits apply live (lib/settings.js)
  configPath: CONFIG_PATH,
  onApply: (cfg) => {
    proxyManager = new ProxyManager(cfg);
    dm.config = cfg;
    dm.proxyManager = proxyManager; // drop stale bad/latency proxy state
    pushAutoGrabState(); // keep the extension's auto-grab mirror in sync
  }
});
let proxyManager = new ProxyManager(settings.get());
let dm = new DownloadManager({ config: settings.get(), proxyManager, onUpdate: pushUpdate, cookieProvider: (url) => cookieHeaderFor(url), onRequiresBrowser: (url) => browserOpen.queueBrowserOpen(url) });

// Auto-grab: push the current autoGrab state to every connected extension.
// Sent on hello-time applies, on setting changes, and it also triggers an
// immediate harvest when the setting just turned ON, so enabling the toggle
// grabs everything the extension has already found.
function pushAutoGrabState(justEnabled = false) {
  const clients = wss ? Array.from(wss.clients) : [];
  const on = !!settings.get().autoGrab;
  for (const c of clients) {
    if (c.readyState !== 1 || !c.isExtension) continue;
    try {
      c.send(JSON.stringify({ type: "dv-auto-grab", on }));
      if (on && justEnabled) c.send(JSON.stringify({ type: "dv-monitor-grab" }));
    } catch (e) { /* ignore */ }
  }
}
// Built-in capture browser (Deep Grab extension) lives in lib/browser.js;
// getConfig + cookieHeaderFor are the only main.js-owned inputs it needs.
const browser = createBuiltinBrowser({ getConfig: () => settings.get(), cookieHeaderFor });
browserOpen.setOpener(browser.openTab);
let mainWindow = null;
let wss = null;
let tray = null;
let quitting = false;

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
    const ext = clients.find((c) => c.readyState === 1 && c.isExtension);
    // autoGrab: when the setting is on, each completed download closes its
    // source tab and harvests everything new the extension has found.
    if (ext && batch.some((it) => it.status === "done") && settings.get().autoGrab) {
      const doneItems = batch.filter((it) => it.status === "done" && it.url);
      for (const it of doneItems) {
        if (it.referer) {
          try { ext.send(JSON.stringify({ type: "dv-close-tab", pageUrl: it.referer })); } catch (e) { /* ignore */ }
        }
      }
      try { ext.send(JSON.stringify({ type: "dv-monitor-grab" })); } catch (e) { /* ignore */ }
    }
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
      resolving: !!item.resolving,
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
  if (settings.get().autoCloseTab) {
    for (const item of batch) {
      if (item.status === "done" || item.status === "error" || item.status === "cancelled") {
        browser.closeTabForUrl(item.referer || item.url);
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
  wss = new WebSocketServer({ host: "127.0.0.1", port: settings.get().port });

  const crawlThrottle = wsBridge.makeCrawlThrottle();

    wss.on("connection", (ws, req) => {
    // Pairing policy: only the Deep Grab extension (chrome-/moz-extension://)
    // and native loopback clients (no Origin header) may talk to the local
    // server. A website can open ws://127.0.0.1:<port> freely, so any other
    // Origin is refused at the handshake (see lib/ws-bridge.js).
    const origin = (req && req.headers && req.headers.origin) || "";
    if (!wsBridge.isAllowedWsOrigin(origin)) {
      console.warn("[ws] rejected connection from origin: " + (origin || "(none)"));
      try { ws.close(1008, "origin not allowed"); } catch (e) { /* ignore */ }
      return;
    }
    ws.send(JSON.stringify({ type: "hello", version: "1.0.0", port: settings.get().port }));
    ws.isExtension = origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://");
    ws.monitorEnabled = false;
    if (wss) wss._extWs = ws; // extension socket handle for autoGrab / monitor pushes
    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        return;
      }
      if (msg.type === "hello") {
        // Tell the extension the authoritative autoGrab state right after its hello.
        try { ws.send(JSON.stringify({ type: "dv-auto-grab", on: !!settings.get().autoGrab })); } catch (e) { /* ignore */ }
      }
      if (msg.type === "dv-monitor-set") {
        // Popup button -> app setting. Persist via the single settings path;
        // onApply re-broadcasts the state and harvests when just enabled.
        settings.update({ autoGrab: msg.on === true });
        pushAutoGrabState(msg.on === true);
        return;
      }
      if (msg.type === "download" && crawlThrottle()) {
        try {
          ws.send(JSON.stringify({ type: "error", message: "Pace limit: too many downloads in the last minute.", url: msg.url }));
        } catch (e) { /* ignore */ }
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
    console.log(`[ws] listening on ws://127.0.0.1:${settings.get().port}`);
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

// System tray: keeps the app (download engine + WebSocket server on 8765)
// running in the background even when every window is closed, so captures
// relayed from the Deep Grab browser keep downloading. Tray "Show" recreates
// the main window; "Quit" performs a clean shutdown (flush + wss.close).
const TRAY_ICON_B64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR4nGNgGF5AzmH9f2Iw0QbAwKgBA2EALkA/A8hOSEMTAAAXkvsxE79GJAAAAABJRU5ErkJggg==";
function createTray() {
  if (tray) return tray;
  const img = nativeImage.createFromDataURL("data:image/png;base64," + TRAY_ICON_B64);
  tray = new Tray(img.resize({ width: 16, height: 16 }));
  tray.setToolTip("Deep Video Downloader");
  const menu = Menu.buildFromTemplate([
    {
      label: "Open Deep Video Downloader",
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) createWindow();
        else { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
        startClipboardMonitor();
      }
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => { quitting = true; app.quit(); }
    }
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
    else createWindow();
  });
  return tray;
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

// Resolve the Deep Grab extension folder (same precedence as lib/browser.js loadExtension).
function extensionDir() {
  return browser.resolveExtensionDir();
}

// One-click install: launch a real Chrome/Edge/Brave with Deep Grab loaded.
// Chromium only honors --load-extension on a NON-default profile, so we run a
// dedicated user-data-dir that persists — the extension stays loaded every time
// that profile is opened, without touching the user's normal profile.

// If the dedicated profile was left in a "Crashed" exit state, Chrome auto-restores
// its saved tab session on the next launch. Over time that session can balloon to
// hundreds of tabs (and GBs of RAM). Clear stale session files so the browser
// opens fresh instead of restoring a runaway crashed session.
function clearStaleBrowserSessions(profile) {
  try {
    const prefsFile = path.join(profile, "Default", "Preferences");
    if (fs.existsSync(prefsFile)) {
      let exitType = "";
      try {
        const prefs = JSON.parse(fs.readFileSync(prefsFile, "utf8"));
        exitType = (prefs.profile && prefs.profile.exit_type) || "";
      } catch (e) { /* unreadable profile -> leave sessions alone */ }
      if (exitType === "Crashed") {
        const sessionsDir = path.join(profile, "Default", "Sessions");
        if (fs.existsSync(sessionsDir)) {
          const removed = [];
          for (const f of fs.readdirSync(sessionsDir)) {
            const fp = path.join(sessionsDir, f);
            try { fs.unlinkSync(fp); removed.push(f); }
            catch (e) { console.error("[browser] session clear error:", f, e.message); }
          }
          if (removed.length) console.log("[browser] cleared", removed.length, "stale session file(s):", removed.join(", "));
        }
      }
    }
  } catch (e) {
    console.error("[browser] session clear failure:", e.message);
  }
}

function launchExtensionInBrowser(browser) {
  const name = String(browser || "chrome").toLowerCase();
  const exe = findBrowser(name);
  if (!exe) return { error: "not-found", browser: name };
  const ext = extensionDir();
  if (!ext) return { error: "no-extension", browser: name };
  const profile = path.join(app.getPath("userData"), "browser-profile-" + name);
  clearStaleBrowserSessions(profile);
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

  // All renderer/extension channels live in lib/ipc.js; this ctx object is
  // the seam between the module and the app state main.js owns (settings,
  // proxyManager, the built-in browser's tabs/timers).
  registerIpc({
    ipcMain,
    shell,
    dialog,
    dm,
    settings,
    getProxyManager: () => proxyManager,
    browser: {
      open: (urls) => browser.open(urls),
      getTabs: () => browser.drainPendingTabs(),
      external: (url, b) => openInExternalBrowser(url, b),
      install: (b) => launchExtensionInBrowser(b)
    },
    bv: browser.bv
  });


  app.whenReady().then(() => {
    startWsServer();
    createWindow();
    createTray();
    browser.loadExtension();
    startClipboardMonitor();
    browser.startIdleSweeper();
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
    // Keep the app alive in the background (tray) once every window is closed:
    // the download engine + WebSocket server on 8765 must keep running so m3u8
    // captures relayed from the Deep Grab browser keep downloading. Exit only
    // via the tray "Quit" (which sets `quitting` and calls app.quit()).
    if (quitting) { app.quit(); return; }
    stopClipboardMonitor();
    if (process.platform === "darwin") return;
    // On Windows/Linux keep running behind the tray icon instead of quitting.
  });

  app.on("quit", () => {
    stopClipboardMonitor();
    settings.close(); // stop the config.json watcher
    if (tray) tray.destroy();
    if (dm && typeof dm.flush === "function") dm.flush();
    if (wss) wss.close();
  });
} else {
  app.quit();
}


