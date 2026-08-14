const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getSettings: () => ipcRenderer.invoke("settings-get"),
  saveSettings: (s) => ipcRenderer.invoke("settings-save", s),
  list: () => ipcRenderer.invoke("downloads-list"),
  history: () => ipcRenderer.invoke("downloads-history"),
  bandwidthStats: () => ipcRenderer.invoke("bandwidth-stats"),
  exportHistory: (format) => ipcRenderer.invoke("downloads-export", format),
  clearHistory: () => ipcRenderer.invoke("downloads-clear-history"),
  pause: (id) => ipcRenderer.invoke("download-pause", id),
  resume: (id) => ipcRenderer.invoke("download-resume", id),
  resumeLast: () => ipcRenderer.invoke("download-resume-last"),
  cancel: (id) => ipcRenderer.invoke("download-cancel", id),
  remove: (id) => ipcRenderer.invoke("download-remove", id),
  add: (url) => ipcRenderer.invoke("downloads-add", url),
  schedule: (data) => ipcRenderer.invoke("download-schedule", data),
  testProxies: (url) => ipcRenderer.invoke("test-proxies", url),
  openDir: () => ipcRenderer.invoke("open-dir"),
  showInFolder: (p) => ipcRenderer.invoke("open-path", p),
  onUpdate: (cb) => ipcRenderer.on("download-update", (e, item) => cb(item)),
  onClipboardUrl: (cb) => ipcRenderer.on("clipboard-url", (e, data) => cb(data)),
  onFileOpened: (cb) => ipcRenderer.on("file-opened", (e, data) => cb(data))
});
