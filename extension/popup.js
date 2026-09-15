const statusEl = document.getElementById("status");
const statusDetailEl = document.getElementById("status-detail");
const feedbackEl = document.getElementById("feedback");
const rescanBtn = document.getElementById("rescan");
const urlInput = document.getElementById("url");
const sendBtn = document.getElementById("send");
const foundListEl = document.getElementById("found-list");
const addAllBtn = document.getElementById("add-all");
const monitorBtn = document.getElementById("monitor");

let found = []; // {url, title, pageUrl, kind, size, mime, added, error}

// The SW owns link state (linkState() in background.js) and the popup renders
// exactly what it is handed — it never re-derives the reason. A bare state
// string is still accepted defensively, but the SW always sends the full
// payload (status, detail, and the compat code) so the pill can be backed by a
// reason line: which app we are paired with (version + protocol), or why the
// link is down.
function setStatus(state) {
  const s = typeof state === "string" ? { status: state, ok: state === "connected" } : (state || {});
  const pill = s.ok ? "connected" : (s.status === "connecting" ? "connecting" : "disconnected");
  statusEl.textContent = pill === "disconnected" ? "disconnected" : (pill === "connecting" ? "connecting…" : "connected");
  statusEl.className = pill;
  renderDetail(s);
}

// Reason line under the pill. A protocol mismatch is the one link failure the
// user can act on (update the app), so it is colored as actionable instead of
// reading like a plain outage.
function renderDetail(s) {
  if (!statusDetailEl) return;
  const actionable = s.code === "extension-newer" || s.code === "app-older";
  statusDetailEl.textContent = s.detail || "";
  statusDetailEl.className = actionable ? "compat" : "";
}

// Operation feedback (Send / Add / Send all). The status pill is reserved for
// the WS link state — an operation rejection (Desktop app offline, unsupported
// URL, pace limit) must never masquerade as a link failure, so the real reason
// from the reply is surfaced here instead.
let feedbackTimer = 0;
// tone: false = ok (green), true = error (red), "warn" = amber — a queued retry
// is neither a success nor a dead end, and the amber matches the ⟳ retryable
// convention the found rows use.
function showFeedback(text, tone) {
  clearTimeout(feedbackTimer);
  feedbackEl.textContent = text || "";
  feedbackEl.className = text ? (tone === "warn" ? "fb-warn" : (tone ? "fb-err" : "fb-ok")) : "";
  if (text) feedbackTimer = setTimeout(() => { feedbackEl.textContent = ""; feedbackEl.className = ""; }, 5000);
}

// A retryable refusal (the app's pace limit) is not always a dead end: when the
// SW actually QUEUED a retry (`queued` — it has a pending entry to re-send) it
// re-sends after the app's own retryAfter window, so say that instead of
// dressing it up as the same ✕ a terminal failure gets. A raw Send has nothing
// to re-send, so its refusal stays a plain ✕. Both fields come from the SW's
// reply, never re-derived here.
function refuseFeedback(r, fallback) {
  const reason = r.error || fallback;
  if (r.queued) return "⟳ " + reason + " — queued, retrying in " + (r.retryAfter || 60) + "s";
  return "✕ " + reason;
}

function fmtSize(b) {
  if (!b) return "size —";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return (b / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + " " + u[i];
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "getStatus" }, (r) => {
    if (!r) return;
    setStatus(r);
  });
}

function loadFound() {
  chrome.runtime.sendMessage({ type: "get-found" }, (resp) => {
    if (resp && Array.isArray(resp.found)) {
      found = resp.found;
      renderFound();
    } else {
      refreshStatus();
    }
  });
}

function renderFound() {
  foundListEl.innerHTML = "";
  if (!found.length) {
    foundListEl.appendChild(emptyItem("No videos found yet."));
  } else {
    for (const v of found) {
      foundListEl.appendChild(foundItem(v));
    }
  }
  const pending = found.filter((f) => !f.added).length;
  addAllBtn.disabled = pending === 0;
  addAllBtn.textContent = pending ? `Send all (${pending}) to desktop` : "Found all added ✓";
}

function emptyItem(text) {
  const li = document.createElement("li");
  li.className = "dv-empty";
  li.textContent = text;
  return li;
}

// Structured error line for a failed download: the human `error` text plus the
// machine-readable HTTP status / code from the push (errorStatus/errorCode,
// built by lib/status.js in the app) when one is present and not already in
// the text.
function errorDetail(v) {
  let s = v.error || "";
  const code = v.errorStatus ? "HTTP " + v.errorStatus : (v.errorCode || "");
  if (code && s.indexOf(code) === -1) s = (s ? s + " · " : "") + code;
  return s;
}

function foundItem(v) {
  const li = document.createElement("li");
  const info = document.createElement("div");
  info.className = "dv-info";
  const title = document.createElement("div");
  title.className = "dv-title";
  title.textContent = v.title || (v.url ? v.url.split("/").pop() : "");
  title.title = v.url || "";
  const meta = document.createElement("div");
  meta.className = "dv-meta";
  const err = v.error || v.errorCode ? errorDetail(v) : "";
  // Distinct terminal-vs-retryable presentation: a retryable failure (network /
  // 5xx — the engine auto-requeues it with backoff) renders amber with ⟳,
  // a terminal failure (404/403/expired/…) renders red with ✕. The flag comes
  // straight off the status push (mirrored by the SW), never re-derived here.
  if (err) {
    meta.className += v.retryable ? " dv-retry" : " dv-err";
    const label = (v.retryable ? "⟳ Retryable error: " : "✕ Terminal error: ") + err;
    // The same explicit label feeds text, assistive technology, and the native
    // tooltip (parity with the desktop renderer's presentation).
    meta.textContent = label;
    meta.setAttribute("aria-label", label);
    meta.title = label;
  } else {
    meta.textContent = fmtSize(v.size || 0);
  }
  info.appendChild(title);
  info.appendChild(meta);
  li.appendChild(info);

  const badge = document.createElement("span");
  badge.className = "dv-kind " + (v.kind === "m3u8" ? "hls" : "mp4");
  badge.textContent = v.kind === "m3u8" ? "HLS" : "MP4";
  li.appendChild(badge);

  const btn = document.createElement("button");
  btn.className = "dv-add" + (v.added ? " dv-done" : "");
  btn.textContent = v.added ? "Added ✓" : "+ Add";
  btn.disabled = !!v.added;
  btn.addEventListener("click", () => {
    if (v.added) return;
    btn.disabled = true;
    btn.textContent = "…";
    chrome.runtime.sendMessage({ type: "add-to-list", url: v.url, title: v.title || "", pageUrl: v.pageUrl || "" }, (r) => {
      if (r && r.ok) { v.added = true; renderFound(); }
      else if (r) { btn.disabled = false; btn.textContent = "+ Add"; showFeedback(refuseFeedback(r, "Could not add"), r.queued ? "warn" : true); }
      else { btn.disabled = false; btn.textContent = "+ Add"; refreshStatus(); } // no SW reply — show the true link state
    });
  });
  li.appendChild(btn);
  return li;
}

addAllBtn.addEventListener("click", () => {
  const urls = found.filter((f) => !f.added).map((f) => f.url);
  if (!urls.length) return;
  addAllBtn.disabled = true;
  addAllBtn.textContent = "Sending…";
  chrome.runtime.sendMessage({ type: "add-all-found", urls }, (r) => {
    loadFound();
    if (r && r.ok) { showFeedback("Sent " + r.added + " of " + r.total + " to desktop ✓" +
      (r.queued ? " — rest queued, retrying in " + (r.retryAfter || 60) + "s" : ""), r.queued ? "warn" : false); }
    else if (r) { showFeedback(refuseFeedback(r, "Nothing sent"), r.queued ? "warn" : true); }
    else { refreshStatus(); } // no SW reply — show the true link state
  });
});

sendBtn.addEventListener("click", () => {
  const url = urlInput.value.trim();
  if (!url) return;
  sendBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "send", url, title: "", referer: "" }, (r) => {
    sendBtn.disabled = false;
    if (r && r.ok) {
      urlInput.value = "";
      showFeedback("Sent to desktop app ✓", false);
      loadFound();
    } else if (r) {
      // The app answered and refused — surface the real reason; do NOT flip the
      // status pill, which reflects the WS link, not the operation's outcome.
      showFeedback(refuseFeedback(r, "Not sent"), r.queued ? "warn" : true);
    } else {
      refreshStatus(); // no reply at all — show the true link state
    }
  });
});

urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendBtn.click();
});

// Re-scan the active tab. Routed through the service worker so the button's
// "Found N videos" feedback reads the SW's authoritative found list — the same
// list the panel renders — after the content script has reported its scan.
rescanBtn.addEventListener("click", () => {
  rescanBtn.disabled = true;
  rescanBtn.textContent = "Scanning…";
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    const done = (r) => {
      if (r && r.ok) {
        loadFound(); // refresh the list to match the authoritative count
        rescanBtn.textContent = "Found " + (r.count || 0) + " video" + (r.count === 1 ? "" : "s") + " ✓";
      } else {
        rescanBtn.textContent = "Nothing to scan on this page";
      }
      setTimeout(() => {
        rescanBtn.disabled = false;
        rescanBtn.textContent = "Re-scan this page";
      }, 1200);
    };
    if (tab && tab.id != null) {
      chrome.runtime.sendMessage({ type: "dv-rescan", tabId: tab.id }, done);
    } else {
      done(null);
    }
  });
});

// Auto-monitor toggle: reflects/sets the background's autoGrab mirror.
// monitorOn is the rendered state — never parse the DOM for it.
let monitorOn = false;
function renderMonitor(on) {
  monitorOn = on === true;
  monitorBtn.textContent = "Auto monitor: " + (monitorOn ? "ON" : "OFF");
  monitorBtn.className = monitorOn ? "monitor-on" : "monitor-off";
}
function loadMonitor() {
  chrome.runtime.sendMessage({ type: "dv-monitor-get" }, (r) => {
    if (r) renderMonitor(r.on === true);
  });
}
function resyncFromSw() { refreshStatus(); loadMonitor(); loadFound(); }
monitorBtn.addEventListener("click", () => {
  const next = !monitorOn;
  chrome.runtime.sendMessage({ type: "dv-monitor-set", on: next }, (r) => {
    if (r) renderMonitor(r.on === true);
  });
});

// background broadcasts dv-found-updated whenever the found list / sizes change,
// desktop-status when the WS link changes, and dv-monitor-changed whenever the
// autoGrab mirror flips — refresh live while the popup is open. Re-pull on
// visibility/focus too: a push can be MISSED while the popup page is hidden or
// throttled, and a stale toggle label used to make the next click send the
// wrong direction.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "dv-found-updated") loadFound();
  else if (msg && msg.type === "desktop-status") setStatus(msg);
  else if (msg && msg.type === "dv-monitor-changed") renderMonitor(msg.on === true);
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) resyncFromSw(); });
window.addEventListener("focus", resyncFromSw);

refreshStatus();
loadFound();
loadMonitor();
