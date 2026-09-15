// Background service worker: aggregates videos found by content scripts and
// forwards them to the Deep Video Downloader desktop app over WebSocket.

// Shared capture guards (AD_DOMAINS/isAdUrl, ST_GETVIDEO_RE, JUNK_BASE_RE/
// isJunkUrl) live in guards.js — the same file the manifest injects before
// content.js, so the SW and the content scripts can never drift again (the
// 2026-09-03 supjav ad-host leak was exactly that drift). typeof-guarded:
// the offline harness evals this file under new Function with no worker
// global, and no top-level code here calls a guard function.
if (typeof importScripts === "function") importScripts("guards.js");

const WS_URL = "ws://127.0.0.1:8765";
const FOUND_CAP = 10000;
const RECONNECT_DELAY = 3000;
// Retry cadence while the app refuses us as too new. It cannot accept this
// build no matter how often we knock, and the app already closed the socket,
// so retrying at the normal 3s only floods it; a 60s beat still recovers on its
// own once the user updates the app with the browser left open.
const RECONNECT_INCOMPATIBLE_DELAY = 60000;
const SEND_TIMEOUT = 20000;
// The app's crawl throttle answers a sustained flood with PACE_LIMITED
// (retryable, `retryAfter` seconds — the WS analogue of HTTP 429). Those
// refusals are QUEUED rather than dropped: see the pace queue below. The
// default only covers an app that omits retryAfter; the app sends 60.
const PACE_RETRY_DEFAULT_S = 60;
const PACE_RETRY_MAX_S = 300; // clamp a bogus window so a retry can never park forever
const PACE_QUEUE_KEY = "dv_pace_retry";
// Port following. The app's WS port is configurable and it falls forward to the
// next free neighbour when the configured one is taken, so assuming 8765 would
// silently lose the link. The extension remembers the last port that answered
// with a hello and, when an attempt finds nothing, sweeps the 8765
// neighbourhood (the same fallback shape the NewTV bridge scans for).
const PORT_SCAN_COUNT = 10;
const HELLO_WATCH_MS = 2500;
const WS_PORT_KEY = "dv_ws_port";
// Heartbeat. A loopback socket can read OPEN long after the app is gone (killed
// process, half-open socket), so a ping every 20s with an 8s pong deadline turns
// that into a real reconnect instead of a link that never reports progress.
const PING_INTERVAL_MS = 20000;
const PONG_TIMEOUT_MS = 8000;

// Per-request id so an ack can be correlated to the exact request that sent it,
// even when the same URL is re-sent (family-dedupe / retry). Monotonic counter +
// random suffix is unique per SW lifetime, which is all the ack window needs.
let reqSeq = 0;
function nextReqId() {
  reqSeq = (reqSeq + 1) % 0xffffffff;
  return "r" + reqSeq.toString(36) + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

let ws = null;
let wsStatus = "offline"; // "connecting" | "online" | "offline"
let reconnectTimer = null;
// Port following: `wsPort` is what the live socket targets, `preferredPort` the
// last port the app answered on (persisted), `portCandidates` the sweep order,
// `candidateIndex` the next one to try when nothing answers.
let wsPort = 0;
let preferredPort = 0;
let portCandidates = [];
let candidateIndex = 0;
let helloSeen = false; // the CURRENT socket proved it is the app
let helloWatch = null; // drops a socket that never greets us
// Heartbeat: pingTimer sends, pongTimer is the deadline, `staleAt` records a
// missed deadline so the popup can say "stopped responding" instead of nothing.
let pingTimer = null;
let pongTimer = null;
let lastPongAt = 0;
let staleAt = 0;

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

// Wire protocol version this extension speaks. The app refuses a client that
// claims a NEWER protocol than it implements (PROTOCOL_MISMATCH -> close); an
// older or legacy (no field) client is always accepted, so this only needs to
// be bumped alongside a breaking message-shape change on BOTH sides.
const EXT_PROTOCOL_VERSION = 1;

// Identity of the app on the other end, taken from its `hello`
// ({version, protocolVersion, port}). Cosmetic except for `protocolVersion`,
// which is what lets a mismatch be explained to the user instead of showing up
// as a bare "disconnected".
let appInfo = null;
// "" | "extension-newer" (the app refused us) | "app-older" (the app's
// advertised protocol is behind ours). The only link failure the user can fix
// by updating a side, so it is surfaced loudly rather than retried forever in
// silence.
let compat = "";

// Everything the popup needs to explain the link, in one payload. Deriving the
// reason here keeps the SW the single owner of link state: the popup renders
// what it is handed and never re-derives it (the drift class the autoGrab
// mirror already avoids).
function linkState() {
  const on = wsStatus === "online";
  const appProtocol = (appInfo && appInfo.protocolVersion) || 0;
  let detail;
  if (compat === "extension-newer") {
    detail = "Update Deep Video Downloader: the app speaks protocol v" + (appProtocol || "?") + " but this extension needs v" + EXT_PROTOCOL_VERSION + ".";
  } else if (compat === "app-older") {
    detail = "Update Deep Video Downloader: the app speaks protocol v" + appProtocol + ", this extension v" + EXT_PROTOCOL_VERSION + ".";
  } else if (on) {
    detail = appInfo && appInfo.version
      ? "Deep Video Downloader v" + appInfo.version + " \u00b7 protocol v" + appProtocol + " \u00b7 port " + wsPort
      : "Connected to the desktop app on port " + wsPort;
  } else if (staleAt) {
    detail = "Desktop app stopped responding \u2014 reconnecting\u2026";
  } else if (wsStatus === "connecting") {
    detail = "Connecting to the desktop app on port " + wsPort + "\u2026";
  } else {
    detail = "Desktop app not running \u2014 searching ports " + portRangeLabel() + ".";
  }
  return {
    ok: on,
    status: wsStatus,
    detail,
    code: compat,
    appVersion: (appInfo && appInfo.version) || "",
    appProtocol,
    extensionProtocol: EXT_PROTOCOL_VERSION,
    port: wsPort,
    lastPongAt,
    stale: !!staleAt
  };
}

function broadcastStatus() {
  chrome.runtime.sendMessage(Object.assign({ type: "desktop-status" }, linkState())).catch(() => {});
}

// Real build version of this extension. The app shows it next to the paired
// client in its window, so a hardcoded literal would display a version that is
// not installed. typeof-guarded: the offline harness evals this file with a
// chrome stub that has no getManifest.
function extensionVersion() {
  try { return chrome.runtime.getManifest().version || "0"; } catch (e) { return "0"; }
}

function sendHello() {
  try { ws.send(JSON.stringify({ type: "hello", v: extensionVersion(), protocolVersion: EXT_PROTOCOL_VERSION })); } catch (e) { /* ignore */ }
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
      ws.send(JSON.stringify({ type: "probe", reqId: nextReqId(), url }));
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

// ----- auto grab (app-driven) -----
// The DESKTOP APP owns the autoGrab setting (its settings UI and the popup
// button both flip it over the WS bridge). The background mirrors the last
// known state so the popup can render instantly, even while offline.
let autoGrab = false;
let pendingMonitorReply = null;
function setAutoGrabState(on) {
  autoGrab = on === true;
  if (pendingMonitorReply) { try { pendingMonitorReply({ on: autoGrab }); } catch (e) {} pendingMonitorReply = null; }
  chrome.runtime.sendMessage({ type: "dv-monitor-changed", on: autoGrab }).catch(() => {});
}

// One grab of a found video: dedupe check, send to desktop, mark captured.
// Returns { ok, skipped?, error? }. Used by the popup's add-to-list and by
// the app-initiated dv-monitor-grab message.
async function grabUrl(url, title, pageUrl) {
  if (isDuplicate(url)) {
    const entry = found.find((x) => x.url === url);
    if (entry) {
      entry.added = true;
      maybeCloseTab(entry);
      pipelineTabDone(entry.tabId);
      persist();
      broadcastFound();
    }
    return { ok: true, skipped: true };
  }
  pendingSend.add(url);
  const r = await sendToDesktop(url, title || "", pageUrl || "");
  pendingSend.delete(url);
  if (r.ok) { markCaptured(url, r.id); removeFound(url); }
  // Structured failure passthrough. The app's `error` envelope carries the
  // machine-readable code plus the retryable/retryAfter pair, and the pace path
  // below is the only thing that acts on them — dropping them here is exactly
  // what let a throttled send look terminal.
  return { ok: r.ok, error: r.error || "", code: r.code || "", retryable: !!r.retryable, retryAfter: r.retryAfter || 0 };
}

// ----- pace-limited retry queue -----
// The app's crawl throttle refuses a sustained flood with PACE_LIMITED
// (`retryable: true`, `retryAfter: 60`). Treating that as terminal left a
// throttled harvest stalled: the entry stayed in `found` with added:false and
// nothing ever re-sent it. Defer the url for the window the app asked for and
// re-send it when the window closes. Keyed by url so a video is queued at most
// once, and persisted because MV3 can evict this worker long before a 60s
// window elapses (same reason the pipeline state is persisted).
let paceQueue = new Map(); // url -> { dueAt }
let paceTimer = null;

// Honor the app's own window (retryAfter), clamped to something sane; a missing
// or bogus value falls back to the throttle's documented 60s so a client that
// never got a window still retries instead of stalling.
function paceRetryMs(retryAfter) {
  const secs = Number(retryAfter) > 0 ? Number(retryAfter) : PACE_RETRY_DEFAULT_S;
  return Math.min(Math.max(secs, 1), PACE_RETRY_MAX_S) * 1000;
}

function persistPaceQueue() {
  const list = Array.from(paceQueue.entries()).map(([url, v]) => ({ url, dueAt: v.dueAt }));
  try { chrome.storage.local.set({ [PACE_QUEUE_KEY]: list }).catch(() => {}); } catch (e) { /* storage unavailable */ }
}

function armPaceTimer() {
  if (paceTimer) { clearTimeout(paceTimer); paceTimer = null; }
  let soonest = Infinity;
  for (const v of paceQueue.values()) if (v.dueAt < soonest) soonest = v.dueAt;
  if (!isFinite(soonest)) return;
  paceTimer = setTimeout(() => { paceTimer = null; flushPaceQueue(); }, Math.max(0, soonest - Date.now()));
}

// Queue one url for a re-send after the app's window. Idempotent per url (a
// re-refusal just moves the deadline out), which is what lets several callers
// defer overlapping sets — a harvest's tail, a bulk's tail — without duplicating
// sends. Returns the window it used, in milliseconds.
function deferPaceRetry(url, retryAfter) {
  if (!url) return 0;
  const ms = paceRetryMs(retryAfter);
  paceQueue.set(url, { dueAt: Date.now() + ms });
  persistPaceQueue();
  armPaceTimer();
  return ms;
}

// Re-send everything whose window has closed. An entry that is gone from the
// found list (the user removed it, or it was handed over meanwhile) is dropped —
// only videos that are still pending are retried.
async function flushPaceQueue() {
  const due = [];
  const now = Date.now();
  for (const [url, v] of paceQueue) if (v.dueAt <= now) due.push(url);
  for (const url of due) {
    paceQueue.delete(url);
    const entry = found.find((x) => x.url === url);
    if (!entry || entry.added || isDuplicate(url)) continue;
    await grabOrDefer(url, entry.title, entry.pageUrl);
  }
  persistPaceQueue();
  armPaceTimer();
}

// grabUrl that HONORS the pace window: a retryable refusal for a video the
// harvest still owns is deferred on the app's retryAfter and recorded on the
// entry (so the panel shows why it is still pending instead of leaving it
// silent). Every send path — the harvest, Add, Add all, the popup's Send — goes
// through here. Only a url with a pending entry is queued: a raw Send from the
// popup's URL box has nothing to re-send (and its signed one-off url may be
// stale by the time the window closes), so it stays a plain refusal the user can
// repeat. The reply says which one happened (`queued`), and the popup renders
// that rather than guessing.
async function grabOrDefer(url, title, pageUrl) {
  const r = await grabUrl(url, title, pageUrl);
  if (!r.ok && r.retryable) {
    const entry = found.find((x) => x.url === url);
    if (entry) {
      deferPaceRetry(url, r.retryAfter);
      entry.error = r.error || "";
      entry.errorCode = r.code || "";
      entry.retryable = true;
      persist();
      broadcastFound();
      return Object.assign({}, r, { queued: true });
    }
  }
  return r;
}

// Harvest: send every found-but-not-yet-grabbed video. The throttle is
// per-socket and shared with every other download, so the FIRST pace refusal
// ends this pass instead of hammering the remaining entries — each extra send
// pushes the throttle's rolling window further out and delays the retry. The
// refused entry is already queued by grabOrDefer; the rest of the pass is
// deferred on the same window and picked up by the pace queue.
async function runHarvest() {
  const pending = found.slice();
  let sent = 0;
  let retryAfterMs = 0;
  for (let i = 0; i < pending.length; i++) {
    const f = pending[i];
    if (f.added || isDuplicate(f.url)) continue;
    const r = await grabOrDefer(f.url, f.title, f.pageUrl);
    if (r.ok && !r.skipped) { sent++; continue; }
    if (r.retryable) {
      retryAfterMs = paceRetryMs(r.retryAfter);
      for (let j = i + 1; j < pending.length; j++) {
        const g = pending[j];
        if (!g.added && !isDuplicate(g.url)) deferPaceRetry(g.url, r.retryAfter);
      }
      break;
    }
  }
  return { sent, retryAfterMs };
}

// Restore a queue left behind by an evicted worker, so a retry scheduled before
// the eviction still lands after it.
function restorePaceQueue() {
  try {
    chrome.storage.local.get([PACE_QUEUE_KEY], (data) => {
      const list = (data || {})[PACE_QUEUE_KEY];
      if (!Array.isArray(list)) return;
      const now = Date.now();
      for (const it of list) {
        if (!it || !it.url) continue;
        const dueAt = Number(it.dueAt) || now;
        const prev = paceQueue.get(it.url);
        if (!prev || dueAt < prev.dueAt) paceQueue.set(it.url, { dueAt });
      }
      armPaceTimer();
    });
  } catch (e) { /* storage unavailable */ }
}

function wsUrlFor(port) {
  return "ws://127.0.0.1:" + port;
}

// The port baked into WS_URL is the DEFAULT (the boot-verify and popup drills
// patch that literal to their isolated port), so it is read, never hardcoded a
// second time.
function defaultPort() {
  try { return Number(new URL(WS_URL).port) || 8765; } catch (e) { return 8765; }
}

// Sweep order: the remembered port first (a browser restart then reconnects
// straight to a fallback port), then the default and its neighbours. Both are
// always in the list, so a stale remembered port can never hide the app.
function buildPortCandidates(preferred) {
  const out = [];
  const add = (p) => { if (p > 0 && p <= 65535 && out.indexOf(p) === -1) out.push(p); };
  add(preferred);
  const base = defaultPort();
  add(base);
  for (let i = 1; i < PORT_SCAN_COUNT; i++) add(base + i);
  return out;
}

function portRangeLabel() {
  const base = defaultPort();
  return base + "-" + (base + PORT_SCAN_COUNT - 1);
}

function nextCandidate() {
  if (!portCandidates.length) portCandidates = buildPortCandidates(preferredPort);
  const p = portCandidates[candidateIndex % portCandidates.length];
  candidateIndex = (candidateIndex + 1) % portCandidates.length;
  return p;
}

// Remember the port the app actually answered on — storage keeps it across MV3
// evictions and browser restarts.
function rememberPort(port) {
  wsPort = port;
  preferredPort = port;
  candidateIndex = 0;
  portCandidates = buildPortCandidates(port);
  try { chrome.storage.local.set({ [WS_PORT_KEY]: port }).catch(() => {}); } catch (e) { /* storage unavailable */ }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  // A socket that never greeted us means the app is not on that port (changed
  // setting, or a neighbour claimed by something else) — sweep to the next one.
  const nextPort = helloSeen ? wsPort : nextCandidate();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(nextPort);
  }, compat === "extension-newer" ? RECONNECT_INCOMPATIBLE_DELAY : RECONNECT_DELAY);
}

// ----- heartbeat (dead-socket detection) -----
function stopHeartbeat() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
}

function startHeartbeat() {
  stopHeartbeat();
  lastPongAt = Date.now();
  staleAt = 0;
  pingTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "ping", reqId: nextReqId() }));
    } catch (e) {
      aliveFail();
      return;
    }
    if (pongTimer) clearTimeout(pongTimer);
    pongTimer = setTimeout(aliveFail, PONG_TIMEOUT_MS);
  }, PING_INTERVAL_MS);
}

// The socket still reads OPEN but the app stopped answering: close it so onclose
// drives a normal reconnect, and tell the popup why the link blinked.
function aliveFail() {
  if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
  staleAt = Date.now();
  try { ws.close(); } catch (e) { /* ignore */ }
  broadcastStatus();
}

function connect(port) {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (helloWatch) { clearTimeout(helloWatch); helloWatch = null; }
  stopHeartbeat();
  try { if (ws) ws.close(); } catch (e) { /* ignore */ }
  helloSeen = false;
  if (port) wsPort = port;
  if (!wsPort) wsPort = portCandidates.length ? portCandidates[0] : defaultPort();
  // Resume the sweep AFTER the port we are about to try, so the first failure
  // moves to a different port instead of re-trying this one at the head.
  const candidateAt = portCandidates.indexOf(wsPort);
  candidateIndex = candidateAt >= 0 ? (candidateAt + 1) % portCandidates.length : 0;
  setStatus("connecting");
  try {
    ws = new WebSocket(wsUrlFor(wsPort));
  } catch (e) {
    setStatus("offline");
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    setStatus("online");
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    // A fresh socket re-decides the pairing: the app re-sends its hello, so a
    // stale identity/mismatch from the previous socket must not linger.
    appInfo = null;
    compat = "";
    reQueueUnknownSizes();
    sendHello();
    startHeartbeat();
    // Only the app greets a new socket (hello, see lib/ws-bridge.js). Anything
    // else answering in our port neighbourhood is dropped so the sweep moves on
    // instead of talking to a stranger.
    helloWatch = setTimeout(() => {
      helloWatch = null;
      if (helloSeen) return;
      try { ws.close(); } catch (e) { /* ignore */ }
    }, HELLO_WATCH_MS);
  };

  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m && m.type === "hello") {
      // App handshake: it proves this socket really is the app (not another
      // local server on a neighbouring port), so the port is remembered as good
      // and the sweep stops here. Its build version, the wire protocol it
      // implements, and the port it listens on feed the popup's link line. A
      // protocol strictly below ours means the app is an older build that can
      // still talk to us (only a NEWER client is refused) — flag the version
      // skew so the popup can suggest updating it.
      helloSeen = true;
      staleAt = 0;
      lastPongAt = Date.now();
      if (helloWatch) { clearTimeout(helloWatch); helloWatch = null; }
      rememberPort(wsPort);
      appInfo = {
        version: String(m.version || ""),
        protocolVersion: Number(m.protocolVersion) || 0,
        port: Number(m.port) || 0
      };
      compat = appInfo.protocolVersion && appInfo.protocolVersion < EXT_PROTOCOL_VERSION ? "app-older" : "";
      broadcastStatus();
    } else if (m && m.type === "error" && m.code === "PROTOCOL_MISMATCH") {
      // The app refuses a client that claims a NEWER wire protocol than it
      // implements (it also closes the socket). Surface the mismatch as the
      // fixable cause instead of leaving the popup at a bare "disconnected" —
      // scheduleReconnect then backs off to a slow beat for this state.
      compat = "extension-newer";
      setStatus("offline");
    } else if (m && m.type === "pong") {
      // Heartbeat reply: the app is alive on this socket.
      if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
      lastPongAt = Date.now();
      staleAt = 0;
    } else if (m && m.type === "dv-auto-grab") {
      setAutoGrabState(m.on === true);
    } else if (m && m.type === "dv-close-tab") {
      // Auto-grab lifecycle: a download whose referer is this page finished.
      // Close the matching movie tab (scheme+host+path match; query/hash vary).
      const target = String(m.pageUrl || "").split("#")[0];
      if (target) {
        let base = target;
        try { const u = new URL(target); base = u.origin + u.pathname; } catch (e) {}
        chrome.tabs.query({}, (tabs) => {
          const hit = (tabs || []).find((t) => {
            try { const u2 = new URL(t.url || ""); return u2.origin + u2.pathname === base; } catch (e) { return false; }
          });
          if (hit) chrome.tabs.remove(hit.id).catch(() => {});
        });
      }
    } else if (m && m.type === "status") {
      // Desktop app reports download progress; update matching entry's
      // size/error. The app is the single owner of the structured error
      // fields (errorCode/errorStatus/retryable — lib/status.js): mirror them
      // EXACTLY from the push. An error push carries them; a retry/done push
      // carries them cleared, which is how a requeued item sheds its stale
      // error. Re-deriving the retryable rule here ("5xx is transient") would
      // be the drift class this mirror exists to avoid.
      const entry = found.find((x) => x.url === m.url);
      if (!entry) return;
      let changed = false;
      if (m.total && entry.size !== m.total) { entry.size = m.total; changed = true; }
      const errText = m.error || "";
      const errCode = m.errorCode || "";
      const errStatus = m.errorStatus || 0;
      const retryable = !!m.retryable;
      if (entry.error !== errText || entry.errorCode !== errCode || Number(entry.errorStatus) !== errStatus || entry.retryable !== retryable) {
        entry.error = errText; entry.errorCode = errCode; entry.errorStatus = errStatus; entry.retryable = retryable;
        changed = true;
      }
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
    } else if (m && m.type === "dv-monitor-grab") {
      // App-driven harvest (autoGrab): send every found (not yet grabbed) video.
      // A throttled pass reports how long it backed off for, so the app and the
      // client can never disagree about the retry window.
      (async () => {
        let r = { sent: 0, retryAfterMs: 0 };
        try { r = await runHarvest(); } catch (e) { /* keep the reply best-effort */ }
        const reply = { type: "dv-monitor-result", sent: r.sent, remaining: found.length };
        if (r.retryAfterMs) reply.retryAfter = Math.round(r.retryAfterMs / 1000);
        try { ws.send(JSON.stringify(reply)); } catch (e) { /* ignore */ }
      })();
    }
  };

  ws.onclose = () => {
    stopHeartbeat();
    if (helloWatch) { clearTimeout(helloWatch); helloWatch = null; }
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
    // Only fetchable schemes reach the desktop engine (chrome-extension pages
    // like …/suspended.html#uri=<url> are unwrapped/rejected there).
    if (!/^(?:https?|blob):/i.test(url || "")) {
      resolve({ ok: false, error: "Unsupported URL" });
      return;
    }
    if (isJunkUrl(url)) {
      resolve({ ok: false, error: "Unsupported URL" });
      return;
    }
    const finishSend = (ref) => {
      const state = ws ? ws.readyState : -1;
      if (state !== WebSocket.OPEN && state !== WebSocket.CONNECTING) {
        // SW wake or dropped socket: start (re)connecting instead of failing fast
        connect();
      }
      waitForOpen(6000).then((opened) => {
        if (!opened) { resolve({ ok: false, error: "Desktop app offline" }); return; }
        sendInner(resolve, url, title, ref);
      });
    };
    if (!referer) {
      // The capture path persists the entry first and backfills pageUrl from
      // chrome.tabs.get afterwards — an MV3 SW eviction can kill the worker
      // between the two, leaving pageUrl "" in storage forever. The desktop
      // item then carries referer "" and the app skips its dv-close-tab
      // auto-close relay, so resolve the referer from the live tab at SEND
      // time (the SW is guaranteed alive here) and persist it.
      const entry = found.find((x) => x.url === url);
      if (entry && entry.tabId > 0) {
        chrome.tabs.get(entry.tabId).then((tab) => {
          if (tab && tab.url) {
            referer = tab.url;
            if (!entry.pageUrl) { entry.pageUrl = tab.url; persist(); broadcastFound(); }
          }
          finishSend(referer);
        }).catch(() => finishSend(referer));
        return;
      }
    }
    finishSend(referer);
  });
}

// Extract cookies for a list of URLs using the Chrome cookies API.
// These are forwarded to the desktop engine so it can authenticate
// requests without needing access to the Electron session.
async function extractCookies(urls) {
  const seen = new Set();
  const parts = [];
  for (const url of urls) {
    try {
      const cookies = await chrome.cookies.getAll({ url });
      for (const c of cookies) {
        const pair = c.name + "=" + c.value;
        if (!seen.has(pair)) { seen.add(pair); parts.push(pair); }
      }
    } catch (e) { /* no cookies for this URL */ }
  }
  return parts.join("; ");
}

function sendInner(resolve, url, title, referer) {
  const cookieHeader = null; // populated asynchronously below
  // Per-request id so a response can be correlated to this exact request even
  // when the same URL is sent twice (family-dedupe/retry can otherwise mis-route
  // the ack). Backward compatible: a server that does not echo reqId is matched
  // by the old url-compare path.
  const reqId = nextReqId();
  const timer = setTimeout(() => {
    ws.removeEventListener("message", onMsg);
    resolve({ ok: false, error: "Desktop app timeout" });
  }, SEND_TIMEOUT);

  function onMsg(ev) {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type !== "accepted" && m.type !== "error") return;
    const mine = m.reqId != null ? m.reqId === reqId : m.url === url;
    if (m.type === "accepted" && mine) {
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      resolve({ ok: true, id: m.id });
    } else if (m.type === "error" && mine) {
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      // Structured envelope ({code, message, retryable, retryAfter}) with a
      // fallback to the legacy flat {message} shape for older apps.
      resolve({ ok: false, error: m.message, code: m.code || "", retryable: !!m.retryable, retryAfter: m.retryAfter || 0 });
    }
  }
  ws.addEventListener("message", onMsg);
  extractCookies([url, referer]).then((cookieHeader) => {
    try {
      ws.send(JSON.stringify({ type: "download", reqId, url, title, referer, cookieHeader }));
    } catch (e) {
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      resolve({ ok: false, error: "socket closed" });
    }
  });
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

// Remove a URL from the Found list once it has been handed to the app, so the
// panel only shows videos still pending collection.
function removeFound(url) {
  found = found.filter((x) => x.url !== url);
  captured.delete(url);
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
  if (found.some((x) => x.url === msg.url)) return;
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
        const r = await grabOrDefer(msg.url, msg.title, msg.pageUrl);
        sendResponse(r);
      })();
      return true; // keep the channel open for the async reply

    case "send":
      // popup "Send" button: hand a raw URL to the desktop app, same path as
      // add-to-list (the popup sends the origin page as `referer`).
      (async () => {
        const r = await grabOrDefer(msg.url, msg.title || "", msg.pageUrl || msg.referer || "");
        sendResponse(r);
      })();
      return true;

    case "dv-rescan":
      // Popup's Re-scan button. The tab's content script runs its scanners and
      // reports the videos it holds on this page; ingest that report into the
      // canonical `found` list (dedupe by url), then answer with the SW's own
      // count so the button feedback and the panel list can never diverge.
      (async () => {
        const tabId = msg.tabId;
        let r = null;
        if (tabId) {
          try { r = await chrome.tabs.sendMessage(tabId, { type: "dv-rescan" }); }
          catch (e) { r = null; }
        }
        if (!r || !r.ok) {
          try { sendResponse({ ok: false, error: "Page has no Deep Grab content script" }); } catch (e) {}
          return;
        }
        if (Array.isArray(r.videos)) {
          for (const v of r.videos) {
            if (!v || !v.url) continue;
            addFound({
              url: v.url,
              title: v.title || "",
              pageUrl: v.pageUrl || "",
              kind: v.kind === "m3u8" ? "m3u8" : "mp4",
              tabId
            });
          }
        }
        try { sendResponse({ ok: true, count: found.length }); } catch (e) {}
      })();
      return true;

    case "dv-monitor-get":
      sendResponse({ on: autoGrab });
      break;

    case "dv-monitor-set":
      // The desktop app owns the setting; forward over WS and wait for the
      // authoritative echo (hello carries autoGrab after the app applies it).
      (async () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) { sendResponse({ on: autoGrab, offline: true }); return; }
        ws.send(JSON.stringify({ type: "dv-monitor-set", on: msg.on === true }));
        pendingMonitorReply = sendResponse;
        setTimeout(() => { if (pendingMonitorReply === sendResponse) { try { sendResponse({ on: autoGrab, stale: true }); } catch (e) {} pendingMonitorReply = null; } }, 4000);
      })();
      return true;

    case "add-all-found": {
      const list = Array.isArray(msg.urls) && msg.urls.length
        ? msg.urls.map((u) => found.find((x) => x.url === u)).filter(Boolean)
        : found;
      const pending = list.filter((x) => !x.added);
      (async () => {
        let okCount = 0;
        let err = "";
        let retryAfter = 0;
        for (let i = 0; i < pending.length; i++) {
          const f = pending[i];
          if (isDuplicate(f.url)) {
            // already captured/downloaded: close the tab, skip re-sending
            f.added = true;
            maybeCloseTab(f);
            pipelineTabDone(f.tabId);
            persist();
            broadcastFound();
            continue;
          }
          const r = await grabOrDefer(f.url, f.title || "", f.pageUrl || "");
          if (r.ok) { okCount++; continue; }
          err = r.error || "";
          // Throttled: defer the TAIL of this bulk on the app's window too, so
          // "Add all" still lands instead of leaving the rest pending forever.
          if (r.retryable) {
            retryAfter = r.retryAfter || 0;
            for (let j = i + 1; j < pending.length; j++) {
              const g = pending[j];
              if (!g.added && !isDuplicate(g.url)) deferPaceRetry(g.url, r.retryAfter);
            }
          }
          break;
        }
        sendResponse({ ok: okCount > 0, added: okCount, total: pending.length, error: err, retryable: retryAfter > 0, retryAfter, queued: retryAfter > 0 });
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
    case "getStatus":
      // Full link state (superset of the legacy {ok}): content.js reads `ok`,
      // the popup renders `status`/`detail`/`code`/`appVersion`.
      sendResponse(linkState());
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

preferredPort = defaultPort();
wsPort = preferredPort;
portCandidates = buildPortCandidates(preferredPort);
connect(wsPort);
loadPersisted();
restorePipeline();
restorePaceQueue();
// A remembered fallback port is only an optimization: connect() already went out
// on the default, so this just re-aims the next attempt (and reconnects at once
// when the stored port is a different, proven one). The storage callback never
// fires under the offline harness stubs, which is fine — the synchronous path
// above is the contract they drive.
try {
  chrome.storage.local.get([WS_PORT_KEY], (data) => {
    const stored = Number((data || {})[WS_PORT_KEY]) || 0;
    if (!(stored > 0 && stored <= 65535)) return;
    preferredPort = stored;
    portCandidates = buildPortCandidates(stored);
    candidateIndex = 0;
    if (!helloSeen && wsPort !== stored) connect(stored);
  });
} catch (e) { /* storage unavailable */ }

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

// ----- auto-group tabs by category: actress / tag / movies -----
// Video-playing tabs are filed into a named group per page category so long
// browsing sessions stay findable: pages whose path looks like an actress /
// cast listing group under "Actress", tag/genre listing pages under "Tags",
// and everything else (watch pages, unknown layouts) under "Movies".
const groupedTabs = new Map(); // tabId -> category it was filed under
function classifyTabGroup(url) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    if (/\/(?:actress|actor|cast|star|idol|model)s?\//.test(p)) return "actress";
    if (/\/(?:tag|tags|genre|genres|category|categories)(?:\/|$)/.test(p)) return "tag";
  } catch (e) { /* fall through */ }
  return "movies";
}
const GROUP_STYLES = {
  actress: { title: "Actress", color: "purple" },
  tag: { title: "Tags", color: "cyan" },
  movies: { title: "Movies", color: "blue" }
};
async function groupVideoTab(tabId) {
  if (tabId <= 0) return;
  // Firefox has no tab groups (no chrome.tabGroups/tabs.group) — skip there
  // explicitly instead of relying on the catch below swallowing a TypeError.
  if (!chrome.tabGroups) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return;
    const cat = classifyTabGroup(tab.url || "");
    const prev = groupedTabs.get(tabId);
    if (prev === cat) return; // already filed correctly
    if (!prev && tab.groupId !== -1) return; // the user grouped it themselves
    if (prev && tab.groupId !== -1) await chrome.tabs.ungroup(tabId).catch(() => {});
    groupedTabs.set(tabId, cat);
    const style = GROUP_STYLES[cat] || GROUP_STYLES.movies;
    const groups = await chrome.tabGroups.query({ title: style.title }).catch(() => []);
    if (groups.length) {
      await chrome.tabs.group({ tabIds: [tabId], groupId: groups[0].id });
    } else {
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, { title: style.title, color: style.color });
    }
  } catch (e) { /* tab gone mid-flight */ }
}
// Keep the map from growing forever across long sessions.
chrome.tabs.onRemoved.addListener((tabId) => groupedTabs.delete(tabId));

// ----- network capture (works for suspended/background tabs, like IDM) -----
chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (!details.url || (!NET_VIDEO_RE.test(details.url) && !ST_GETVIDEO_RE.test(details.url))) return;
  if (isAdUrl(details.url)) return; // bypass ads — don't capture ad streams
  console.log("[dv] capture", details.url);
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
