// Background service worker: aggregates videos found by content scripts and
// forwards them to the Deep Video Downloader desktop app over WebSocket.

const WS_URL = "ws://127.0.0.1:8765";
const FOUND_CAP = 500;
const RECONNECT_DELAY = 3000;
const SEND_TIMEOUT = 20000;

let ws = null;
let wsStatus = "offline"; // "connecting" | "online" | "offline"
let reconnectTimer = null;

let found = []; // {url, title, pageUrl, kind, size, mime, added, ts}
let captured = new Map(); // url -> { id, ts }
let capturedIds = new Set(); // streamtape/fstape video ids already sent
const pendingSend = new Set(); // urls currently being sent (dedupe guard)

// One-by-one pipeline: start/stop from the popup. Processes streamtape/fstape
// tabs sequentially — activate → signal content.js to autoplay → app accepts →
// close tab → next. Default state is OFF (pipelineRunning=false).
const PIPELINE_TIMEOUT = 25000;
let pipelineRunning = false;
let pipelineQueue = []; // tabIds
let pipelineTabId = null;
let pipelineTimer = null;
let pipelineRestorePending = false;

const PROBE_CONCURRENCY = 4;
const PROBE_TIMEOUT = 20000;
let probeQueue = [];
let probeActive = 0;
const probing = new Set();

const NET_VIDEO_RE = /\.(mp4|m4v|webm|mov|mkv|flv|m3u8)([?#]|$)/i;
// streamtape/fstape serve the file from /get_video?.. (no extension) — match it
// by host so webRequest captures it in suspended/background tabs too.
const ST_GETVIDEO_RE = /^https?:\/\/(?:[^/]*\.)?(?:streamtape|fstape)\.com\/get_video\?/i;

// Ad-network hosts whose streams/players must never be captured as videos.
const AD_DOMAINS = /(?:^|\.)(?:doubleclick\.net|googlesyndication\.com|adservice\.google\.com|ads\.youtube\.com|adroll\.com|criteo\.com|taboola\.com|outbrain\.com|adnxs\.com|amazon-adsystem\.com|adform\.net|adcolony\.com|smartadserver\.com|rubiconproject\.com|pubmatic\.com|openx\.net|appnexus\.com|casalemedia\.com|adsrvr\.org|exoclick\.com|popads\.net|propellerads\.com|mgid\.com|revcontent\.com|adsterra\.com|juicyads\.com)$/i;
function isAdUrl(u) {
  if (!u) return false;
  try { return AD_DOMAINS.test(new URL(u).hostname); } catch (e) { return false; }
}

function persist() {
  chrome.storage.local.set({
    found: found.slice(0, FOUND_CAP),
    captured: Array.from(captured.entries()),
    capturedIds: Array.from(capturedIds)
  }).catch(() => {});
}

// Pipeline state is memory-only otherwise — MV3 evicts idle service workers,
// so persist it so the cascade resumes on the next SW wake.
function persistPipeline() {
  chrome.storage.local.set({
    dv_pipeline: { running: pipelineRunning, queue: pipelineQueue, current: pipelineTabId }
  }).catch(() => {});
}

function loadPersisted() {
  chrome.storage.local.get(["found", "captured", "capturedIds"], (data) => {
    data = data || {};
    // merge, don't overwrite: a video-found that arrived while the SW was
    // waking would otherwise be clobbered by the persisted snapshot
    const byUrl = new Map(found.map((x) => [x.url, x]));
    for (const p of (Array.isArray(data.found) ? data.found : [])) if (!byUrl.has(p.url)) byUrl.set(p.url, p);
    found = Array.from(byUrl.values());
    for (const [u, v] of (Array.isArray(data.captured) ? data.captured : [])) if (!captured.has(u)) captured.set(u, v);
    for (const id of (Array.isArray(data.capturedIds) ? data.capturedIds : [])) capturedIds.add(id);
  });
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: "desktop-status", ok: wsStatus === "online" }).catch(() => {});
}

function broadcastFound() {
  chrome.runtime.sendMessage({ type: "dv-found-updated" }).catch(() => {});
}

// ----- size probing (asks the desktop app to HEAD the url) -----
function queueProbe(url) {
  if (!url || probing.has(url)) return;
  const entry = found.find((x) => x.url === url);
  if (entry && entry.size > 0) return;
  probing.add(url);
  probeQueue.push(url);
  pumpProbes();
}

function pumpProbes() {
  while (probeActive < PROBE_CONCURRENCY && probeQueue.length) {
    const url = probeQueue.shift();
    probeActive++;
    doProbe(url).finally(() => { probeActive--; pumpProbes(); });
  }
}

function doProbe(url) {
  return new Promise((resolve) => {
    const release = () => { probing.delete(url); resolve(); };
    if (!ws || ws.readyState !== WebSocket.OPEN) { release(); return; }
    try {
      ws.send(JSON.stringify({ type: "probe", url }));
    } catch (e) { release(); return; }
    setTimeout(release, PROBE_TIMEOUT);
  });
}

function reQueueUnknownSizes() {
  found.forEach((x) => { if (!x.size) queueProbe(x.url); });
}

function setStatus(status) {
  wsStatus = status;
  broadcastStatus();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY);
}

function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try { if (ws) ws.close(); } catch (e) { /* ignore */ }
  setStatus("connecting");
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    setStatus("offline");
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    setStatus("online");
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reQueueUnknownSizes();
  };

  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m && m.type === "status") {
      // Desktop app reports download progress; update matching entry's size/error.
      const entry = found.find((x) => x.url === m.url);
      if (!entry) return;
      let changed = false;
      if (m.total && entry.size !== m.total) { entry.size = m.total; changed = true; }
      if (m.status === "error" && m.error && entry.error !== m.error) { entry.error = m.error; changed = true; }
      if (m.status === "done" && entry.error) { entry.error = ""; changed = true; }
      if (changed) { persist(); broadcastFound(); }
    } else if (m && m.type === "probe-result") {
      probing.delete(m.url);
      const entry = found.find((x) => x.url === m.url);
      if (entry) {
        entry.size = m.size || entry.size;
        if (m.mime) entry.mime = m.mime;
        persist();
        broadcastFound();
      }
    }
  };

  ws.onclose = () => {
    setStatus("offline");
    scheduleReconnect();
  };

  ws.onerror = () => {
    try { ws.close(); } catch (e) { /* ignore */ }
  };
}

// Send a download request and wait for the app's ack/error.
function waitForOpen(ms) {
  return new Promise((resolve) => {
    if (!ws) return resolve(false);
    if (ws.readyState === WebSocket.OPEN) return resolve(true);
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return resolve(false);
    const timer = setTimeout(() => resolve(false), ms);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(true); }, { once: true });
  });
}

function sendToDesktop(url, title, referer) {
  return new Promise((resolve) => {
    const state = ws ? ws.readyState : -1;
    if (state !== WebSocket.OPEN && state !== WebSocket.CONNECTING) {
      // SW wake or dropped socket: start (re)connecting instead of failing fast
      connect();
    }
    waitForOpen(6000).then((opened) => {
      if (!opened) { resolve({ ok: false, error: "Desktop app offline" }); return; }
      sendInner(resolve, url, title, referer);
    });
  });
}

function sendInner(resolve, url, title, referer) {
  const timer = setTimeout(() => {
    ws.removeEventListener("message", onMsg);
    resolve({ ok: false, error: "Desktop app timeout" });
  }, SEND_TIMEOUT);

  function onMsg(ev) {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === "accepted" && m.url === url) {
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      resolve({ ok: true, id: m.id });
    } else if (m.type === "error" && m.url === url) {
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      resolve({ ok: false, error: m.message });
    }
  }
  ws.addEventListener("message", onMsg);
  try {
    ws.send(JSON.stringify({ type: "download", url, title, referer }));
  } catch (e) {
    clearTimeout(timer);
    ws.removeEventListener("message", onMsg);
    resolve({ ok: false, error: "socket closed" });
  }
}

function markCaptured(url, id) {
  captured.set(url, { id, ts: Date.now() });
  const vid = videoIdOf(url);
  if (vid) capturedIds.add(vid);
  const entry = found.find((x) => x.url === url);
  if (entry) {
    entry.added = true;
    maybeCloseTab(entry);
    pipelineTabDone(entry.tabId);
  }
  persist();
  broadcastFound();
}

// streamtape/fstape video identity: the id from a get_video URL, or the embed
// path segment (/v/<id>/<name>). Signed URLs carry a fresh token per page load,
// so exact-URL dedupe misses repeats of the same video — this catches them.
function videoIdOf(url) {
  try {
    const u = new URL(url);
    if (!/streamtape\.com|fstape\.com/i.test(u.hostname)) return "";
    const gv = u.searchParams.get("id");
    if (gv) return gv;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && /^[ev]$/i.test(parts[0])) return parts[1];
    return "";
  } catch (e) {
    return "";
  }
}

function isDuplicate(url) {
  if (captured.has(url)) return true;
  if (pendingSend.has(url)) return true;
  const vid = videoIdOf(url);
  return !!vid && capturedIds.has(vid);
}

// Close the source tab once the desktop app accepted the download (the app
// "got the url") — not on capture, so a failed send leaves the tab open.
// Restricted to streamtape/fstape get_video embeds, gated by the
// dv.autoCloseTab setting, and window-agnostic (tabId identifies any window).
function maybeCloseTab(entry) {
  if (!entry || !entry.tabId || entry.tabId <= 0) return;
  chrome.storage.local.get({ dv: {} }).then((data) => {
    if ((data.dv || {}).autoCloseTab === false) return;
    chrome.tabs.get(entry.tabId).then((tab) => {
      if (!tab || !/streamtape\.com|fstape\.com/i.test(tab.url || "")) return;
      if (entry.url && /get_video\?/i.test(entry.url)) {
        chrome.tabs.remove(entry.tabId).catch(() => {});
      }
    }).catch(() => {});
  }).catch(() => {});
}

// ----- one-by-one pipeline -----
function broadcastPipelineState() {
  chrome.runtime.sendMessage({
    type: "pipeline-state",
    running: pipelineRunning,
    pending: pipelineQueue.length
  }).catch(() => {});
}

function closePipelineTab(tabId) {
  chrome.storage.local.get({ dv: {} }).then((data) => {
    if ((data.dv || {}).autoCloseTab === false) return;
    chrome.tabs.get(tabId).then((tab) => {
      if (!tab) return;
      if (/streamtape\.com|fstape\.com/i.test(tab.url || "")) {
        chrome.tabs.remove(tabId).catch(() => {});
      }
    }).catch(() => {});
  }).catch(() => {});
}

function sendAutoplaySignal(tabId, attempt) {
  chrome.tabs.sendMessage(tabId, { type: "dv-autoplay-now" }).catch(() => {
    // content script may not be injected yet (tab still loading) — retry a few times
    if (attempt < 3) setTimeout(() => sendAutoplaySignal(tabId, attempt + 1), 1500);
  });
}

function activatePipelineTab(tabId) {
  chrome.tabs.get(tabId).then((tab) => {
    if (!tab) return;
    if (tab.windowId != null) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    chrome.tabs.update(tabId, { active: true }).catch(() => {});
  }).catch(() => {});
  // tell the tab's content script to signal the userscript to autoplay
  sendAutoplaySignal(tabId, 0);
}

function stopPipeline() {
  pipelineRestorePending = false;
  pipelineRunning = false;
  if (pipelineTimer) { clearTimeout(pipelineTimer); pipelineTimer = null; }
  pipelineQueue = [];
  pipelineTabId = null;
  persist();
  persistPipeline();
  broadcastPipelineState();
}

function processNext() {
  if (!pipelineRunning) { pipelineTabId = null; return; }
  const tabId = pipelineQueue.shift();
  if (!tabId) {
    // queue exhausted — done
    pipelineRunning = false;
    pipelineTabId = null;
    persist();
    persistPipeline();
    broadcastPipelineState();
    return;
  }
  pipelineTabId = tabId;
  activatePipelineTab(tabId);
  persistPipeline();
  pipelineTimer = setTimeout(() => {
    // no capture/accept in time (no video, or content script not ready) — move on
    if (pipelineTabId === tabId) {
      closePipelineTab(tabId);
      pipelineTabId = null;
      processNext();
    }
  }, PIPELINE_TIMEOUT);
}

// Resume a pipeline interrupted by MV3 service-worker eviction.
function restorePipeline() {
  pipelineRestorePending = true;
  chrome.storage.local.get({ dv_pipeline: null }, (data) => {
    if (!pipelineRestorePending) return; // user started/stopped meanwhile
    pipelineRestorePending = false;
    const p = (data && data.dv_pipeline) || null;
    if (!p || !p.running) return;
    pipelineRunning = true;
    pipelineQueue = Array.isArray(p.queue) ? p.queue : [];
    const resume = () => {
      pipelineTabId = null;
      persistPipeline();
      broadcastPipelineState();
      processNext();
    };
    if (p.current && Number.isInteger(p.current)) {
      chrome.tabs.get(p.current).then((tab) => {
        if (tab) pipelineQueue.unshift(p.current);
        resume();
      }).catch(() => resume());
    } else {
      resume();
    }
  });
}

function advancePipeline() {
  if (pipelineTimer) { clearTimeout(pipelineTimer); pipelineTimer = null; }
  pipelineTabId = null;
  processNext();
}

// Called whenever the pipeline's current tab finished (video accepted or
// duplicate-skip closed it) so the cascade advances.
function pipelineTabDone(tabId) {
  if (tabId && tabId === pipelineTabId) advancePipeline();
}

function startPipeline(quantity) {
  stopPipeline();
  const limit = Math.max(0, parseInt(quantity, 10) || 0);
  chrome.tabs.query({}).then((tabs) => {
    pipelineQueue = tabs
      .filter((t) => t.url && /streamtape\.com|fstape\.com/i.test(t.url))
      .map((t) => t.id)
      .filter((id) => id != null);
    if (limit > 0) pipelineQueue = pipelineQueue.slice(0, limit);
    if (!pipelineQueue.length) {
      pipelineRunning = false;
      persist();
      persistPipeline();
      broadcastPipelineState();
      return;
    }
    pipelineRunning = true;
    persist();
    persistPipeline();
    broadcastPipelineState();
    processNext();
  }).catch(() => {});
}

function addFound(msg) {
  if (!msg.url) return;
  if (isDuplicate(msg.url) || found.some((x) => x.url === msg.url)) return;
  found.push({
    url: msg.url,
    title: msg.title || "",
    pageUrl: msg.pageUrl || "",
    kind: msg.kind === "m3u8" ? "m3u8" : "mp4",
    size: 0,
    mime: "",
    added: captured.has(msg.url),
    tabId: msg.tabId || 0,
    ts: Date.now()
  });
  if (found.length > FOUND_CAP) found = found.slice(-FOUND_CAP);
  persist();
  broadcastFound();
  queueProbe(msg.url);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg && msg.type) {
    case "video-found":
      addFound({ ...msg, tabId: sender.tab ? sender.tab.id : 0 });
      break;

    case "get-found":
      sendResponse({
        found,
        captured: Array.from(captured.keys()).map((url) => ({ url })),
        pipelineRunning,
        pipelinePending: pipelineQueue.length
      });
      break;

    case "add-to-list":
      (async () => {
        const entry = found.find((x) => x.url === msg.url);
        if (entry && sender.tab && !entry.tabId) entry.tabId = sender.tab.id;
        if (isDuplicate(msg.url)) {
          // already captured/downloaded: close the tab, skip re-sending
          if (entry) {
            entry.added = true;
            maybeCloseTab(entry);
            pipelineTabDone(entry.tabId);
            persist();
            broadcastFound();
          }
          sendResponse({ ok: true, skipped: true });
          return;
        }
        pendingSend.add(msg.url);
        const r = await sendToDesktop(msg.url, msg.title || "", msg.pageUrl || "");
        pendingSend.delete(msg.url);
        if (r.ok) markCaptured(msg.url, r.id);
        sendResponse({ ok: r.ok, error: r.error || "" });
      })();
      return true; // keep the channel open for the async reply

    case "add-all-found": {
      const list = Array.isArray(msg.urls) && msg.urls.length
        ? msg.urls.map((u) => found.find((x) => x.url === u)).filter(Boolean)
        : found;
      const pending = list.filter((x) => !x.added);
      (async () => {
        let okCount = 0;
        let err = "";
        for (const f of pending) {
          if (isDuplicate(f.url)) {
            // already captured/downloaded: close the tab, skip re-sending
            f.added = true;
            maybeCloseTab(f);
            pipelineTabDone(f.tabId);
            persist();
            broadcastFound();
            continue;
          }
          pendingSend.add(f.url);
          const r = await sendToDesktop(f.url, f.title || "", f.pageUrl || "");
          pendingSend.delete(f.url);
          if (r.ok) { markCaptured(f.url, r.id); okCount++; }
          else { err = r.error || ""; break; }
        }
        sendResponse({ ok: okCount > 0, added: okCount, total: pending.length, error: err });
      })();
      return true;
    }

    case "remove-found": {
      const urls = Array.isArray(msg.urls) ? msg.urls : [];
      if (urls.length) {
        const remove = new Set(urls);
        found = found.filter((x) => !remove.has(x.url));
        for (const u of urls) captured.delete(u);
        capturedIds = new Set();
        for (const u of captured.keys()) { const vid = videoIdOf(u); if (vid) capturedIds.add(vid); }
        persist();
        broadcastFound();
      }
      sendResponse({ ok: true, removed: urls.length });
      break;
    }

    case "open-new-tab":
      if (msg.url) {
        chrome.tabs.create({ url: msg.url, active: false }).catch(() => {});
      }
      break;

    case "desktop-status":
      sendResponse({ ok: wsStatus === "online" });
      break;

    case "pipeline-start":
      if (pipelineRunning) {
        sendResponse({ running: true, pending: pipelineQueue.length });
        break;
      }
      startPipeline(msg.quantity);
      sendResponse({ running: pipelineRunning, pending: pipelineQueue.length });
      break;

    case "pipeline-stop":
      stopPipeline();
      sendResponse({ running: false, pending: 0 });
      break;
  }
});

chrome.runtime.onInstalled.addListener(() => { connect(); });
chrome.runtime.onStartup.addListener(() => { connect(); });

connect();
loadPersisted();
restorePipeline();

// streamtape/fstape embed URLs carry the video name as a slug
// (/v/<id>/My-Video-Name); the embed <title> is generic/empty, so prefer it.
function slugTitle(url) {
  try {
    const u = new URL(url);
    if (!/streamtape\.com|fstape\.com/i.test(u.hostname)) return "";
    const parts = u.pathname.split("/").filter(Boolean);
    let name = "";
    if (parts.length >= 3 && /^[ev]$/i.test(parts[0])) name = parts.slice(2).join(" ");
    else if (parts.length >= 2) name = parts[parts.length - 1];
    if (!name || /^[ev]$/i.test(name)) return "";
    return decodeURIComponent(name).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  } catch (e) {
    return "";
  }
}

// ----- auto-group tabs that play video (so they're easy to find) -----
const groupedTabs = new Set();
function groupVideoTab(tabId) {
  if (tabId <= 0 || groupedTabs.has(tabId)) return;
  groupedTabs.add(tabId);
  chrome.tabs.get(tabId).then((tab) => {
    if (!tab || tab.groupId !== -1) return;
    return chrome.tabs.group({ tabIds: [tabId] });
  }).then((groupId) => {
    if (groupId) return chrome.tabGroups.update(groupId, { title: "Deep Grab", color: "blue" });
  }).catch(() => {});
}

// ----- network capture (works for suspended/background tabs, like IDM) -----
chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (!details.url || (!NET_VIDEO_RE.test(details.url) && !ST_GETVIDEO_RE.test(details.url))) return;
  if (isAdUrl(details.url)) return; // bypass ads — don't capture ad streams
  addFound({ url: details.url, title: "", tabId: details.tabId, kind: /\.m3u8([?#]|$)/i.test(details.url) ? "m3u8" : "mp4" });
  if (details.tabId > 0) {
    groupVideoTab(details.tabId);
    chrome.tabs.get(details.tabId).then((tab) => {
      const entry = found.find((x) => x.url === details.url);
      if (!entry || !tab) return;
      if (!entry.title) entry.title = slugTitle(tab.url || "") || tab.title || "";
      if (tab.url && !entry.pageUrl) entry.pageUrl = tab.url;
      if (entry.title || entry.pageUrl) {
        persist();
        broadcastFound();
      }
    }).catch(() => {});
  }
}, { urls: ["<all_urls>"] }, []);

chrome.webRequest.onHeadersReceived.addListener((details) => {
  if (!details.url || !NET_VIDEO_RE.test(details.url)) return;
  if (isAdUrl(details.url)) return;
  const entry = found.find((x) => x.url === details.url);
  if (!entry) return;
  let size = 0;
  let mime = "";
  for (const h of details.responseHeaders || []) {
    const name = String(h.name || "").toLowerCase();
    const val = String(h.value || "");
    if (name === "content-length") {
      size = parseInt(val, 10) || 0;
    } else if (name === "content-range") {
      const m = val.match(/\/(\d+)\s*$/);
      if (m) size = parseInt(m[1], 10) || size;
    } else if (name === "content-type") {
      mime = val;
    }
  }
  if (size) entry.size = size;
  if (mime) entry.mime = mime;
  persist();
  broadcastFound();
}, { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "object", "other"] }, ["responseHeaders", "extraHeaders"]);