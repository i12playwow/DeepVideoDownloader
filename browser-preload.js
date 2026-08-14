const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getInitialTabs: () => ipcRenderer.invoke("browser-get-tabs"),
  onOpenTabs: (cb) => ipcRenderer.on("browser-open-tabs", (e, urls) => cb(urls)),
  onAddTabs: (cb) => ipcRenderer.on("browser-add-tabs", (e, urls) => cb(urls))
});
