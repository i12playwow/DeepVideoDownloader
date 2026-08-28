const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  onTabsUpdate: (cb) => ipcRenderer.on("browser-tabs-update", (e, list, activeId) => cb(list, activeId)),
  onNavState: (cb) => ipcRenderer.on("browser-nav-state", (e, st) => cb(st)),
  onAddTabs: (cb) => ipcRenderer.on("browser-add-tabs", (e, urls) => cb(urls)),
  onOpenTabs: (cb) => ipcRenderer.on("browser-open-tabs", (e, urls) => cb(urls)),
  newTab: () => ipcRenderer.send("bv-new-tab"),
  closeTab: (id) => ipcRenderer.send("bv-close", id),
  activate: (id) => ipcRenderer.send("bv-activate", id),
  groupTabs: () => ipcRenderer.send("bv-group"),
  closeDuplicates: () => ipcRenderer.send("bv-dupes"),
  closeOthers: () => ipcRenderer.send("bv-close-others"),
  closeDomain: () => ipcRenderer.send("bv-close-domain"),
  closeAll: () => ipcRenderer.send("bv-close-all"),
  setGroupMode: (on) => ipcRenderer.send("bv-group-mode", on),
  navigate: (url) => ipcRenderer.send("bv-navigate", url),
  back: () => ipcRenderer.send("bv-back"),
  forward: () => ipcRenderer.send("bv-forward"),
  reload: () => ipcRenderer.send("bv-reload"),
  setNewTabMode: (on) => ipcRenderer.send("bv-newtab-mode", on),
  toggleAutoScroll: () => ipcRenderer.send("bv-autoscroll"),
  reportContentRect: (rect) => ipcRenderer.send("bv-content-rect", rect)
});
