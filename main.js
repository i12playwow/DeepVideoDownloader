// Electron main: window + WebSocket server (127.0.0.1:8765) + download manager wiring.

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});

const { app, BrowserWindow, ipcMain, shell, clipboard } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const { WebSocketServer } = require("ws");
const { DownloadManager, requestWithRedirects } = require("./downloader");
const { ProxyManager } = require("./proxy");

const CONFIG_PATH = path.join(__dirname, "config.json");
const DEFAULT_CONFIG = {
  port: 8765,
  downloadDir: path.join(os.homedir(), "Downloads", "DeepGrab"),
  concurrency: 3,
  segments: 4,
  speedLimitKB: 0,
  maxRetries: 3,
  maxRefresh: 2,
  autoProxy: true,
  ffmpegPath: "ffmpeg",
  theme: "dark",
  proxies: [
    "http://127.0.0.1:7890",
    "socks5://127.0.0.1:1080"
  ]
};

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (e) {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  } catch (e) { /* ignore */ }
}

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

let config = loadConfig();
let proxyManager = new ProxyManager(config);
let dm = new DownloadManager({ config, proxyManager, onUpdate: pushUpdate });
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
        finalPath: item.finalPath
      }));
    }
  });
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
           // enqueue every `kind:"link"` entry as its own download (label
           // appended to the file name); fall back to plain `url` when no
           // usable source exists. Non-`link` kinds (iframe, server) are
           // ignored — they are player pages, not direct files.
           const links = Array.isArray(msg.sources)
             ? msg.sources.filter((s) => s && s.kind === "link" && typeof s.url === "string")
             : [];
           const usable = links.length
             ? links
             : (typeof msg.url === "string" ? [{ kind: "link", url: msg.url, label: "" }] : []);
           const ids = [];
           for (const s of usable) {
             const id = await dm.enqueue({
               url: s.url,
               title: msg.title,
               referer: msg.referer,
               label: s.label || "",
               scheduledStart: msg.scheduledStart ? new Date(msg.scheduledStart).getTime() : null,
               scheduledStop: msg.scheduledStop ? new Date(msg.scheduledStop).getTime() : null
             });
             ids.push(id);
           }
          ws.send(JSON.stringify({ type: "accepted", id: ids[0], ids, url: msg.url }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "error", message: e.message }));
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

// ---------------- clipboard monitoring ----------------
const VIDEO_DOMAINS = [
  "streamtape.com",
  "cnporn.org",
  "xvideos.com",
  "xhamster.com",
  "pornhub.com",
  "javhub.net"
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
    if (!config.autoProxy) return;
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
  config = { ...config, ...next };
  saveConfig(config);
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
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
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
  if (item.status === "scheduled") dm.checkScheduled();
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

ipcMain.handle("open-dir", () => {
  fs.mkdirSync(config.downloadDir, { recursive: true });
  shell.openPath(config.downloadDir);
  return { ok: true };
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

  app.whenReady().then(() => {
    startWsServer();
    createWindow();
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
    if (wss) wss.close();
  });
} else {
  app.quit();
}
