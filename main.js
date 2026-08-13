// Electron main: window + WebSocket server (127.0.0.1:8765) + download manager wiring.

const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { WebSocketServer } = require("ws");
const { DownloadManager } = require("./downloader");
const { ProxyManager } = require("./proxy");

const CONFIG_PATH = path.join(__dirname, "config.json");
const DEFAULT_CONFIG = {
  port: 8765,
  downloadDir: path.join(os.homedir(), "Downloads", "DeepGrab"),
  concurrency: 3,
  segments: 4,
  speedLimitKB: 0,
  autoProxy: true,
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
        fileName: item.fileName,
        status: item.status,
        progress: item.total ? item.received / item.total : 0,
        speed: item.speed,
        proxy: item.proxy,
        error: item.error
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
          const ids = await dm.enqueueSources({
            url: msg.url,
            title: msg.title,
            referer: msg.referer,
            sources: msg.sources
          });
          ws.send(JSON.stringify({ type: "accepted", ids, id: ids[0] || null, url: msg.url }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "error", message: e.message }));
        }
      }
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    });
    ws.on("error", () => {});
  });

  wss.on("error", (err) => {
    console.error("[ws] " + err.message);
    if (err.code === "EADDRINUSE") {
      dialog.showErrorBox(
        "Port " + config.port + " in use",
        "The WebSocket server could not bind to ws://127.0.0.1:" + config.port +
        ". The browser extension cannot connect. Free the port or change it in Settings and restart."
      );
      app.quit();
    }
  });

  console.log(`[ws] listening on ws://127.0.0.1:${config.port}`);
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

// ---------------- IPC ----------------
ipcMain.handle("settings-get", () => config);
ipcMain.handle("settings-save", (e, next) => {
  config = { ...config, ...next };
  saveConfig(config);
  proxyManager = new ProxyManager(config);
  dm.proxyManager = proxyManager;
  dm.config = config;
  return { ok: true };
});

ipcMain.handle("downloads-list", () => dm.list());

ipcMain.handle("download-pause", (e, id) => { dm.pause(id); return { ok: true }; });
ipcMain.handle("download-resume", (e, id) => { dm.resume(id); return { ok: true }; });
ipcMain.handle("download-cancel", (e, id) => { dm.cancel(id); return { ok: true }; });
ipcMain.handle("download-remove", (e, id) => { dm.remove(id); return { ok: true }; });

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

// ---------------- App lifecycle ----------------
app.whenReady().then(() => {
  startWsServer();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("quit", () => {
  if (wss) wss.close();
});
