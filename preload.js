const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getSettings: () => ipcRenderer.invoke("settings-get"),
  saveSettings: (s) => ipcRenderer.invoke("settings-save", s),
  list: () => ipcRenderer.invoke("downloads-list"),
  pause: (id) => ipcRenderer.invoke("download-pause", id),
  resume: (id) => ipcRenderer.invoke("download-resume", id),
  cancel: (id) => ipcRenderer.invoke("download-cancel", id),
  remove: (id) => ipcRenderer.invoke("download-remove", id),
  testProxies: (url) => ipcRenderer.invoke("test-proxies", url),
  openDir: () => ipcRenderer.invoke("open-dir"),
  onUpdate: (cb) => ipcRenderer.on("download-update", (e, item) => cb(item))
});
