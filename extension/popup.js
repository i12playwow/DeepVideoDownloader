const statusEl = document.getElementById("status");
const rescanBtn = document.getElementById("rescan");
const urlInput = document.getElementById("url");
const sendBtn = document.getElementById("send");
const foundListEl = document.getElementById("found-list");
const addAllBtn = document.getElementById("add-all");
const monitorBtn = document.getElementById("monitor");

let found = []; // {url, title, pageUrl, kind, size, mime, added, error}

function setStatus(s) {
  statusEl.textContent = s;
  statusEl.className = s;
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
    setStatus(r.ok ? "connected" : "disconnected");
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

function foundItem(v) {
  const li = document.createElement("li");
  const info = document.createElement("div");
  info.className = "dv-info";
  const title = document.createElement("div");
  title.className = "dv-title";
  title.textContent = v.title || (v.url ? v.url.split("/").pop() : "");
  title.title = v.url || "";
  const meta = document.createElement("div");
  meta.className = "dv-meta" + (v.error ? " dv-err" : "");
  meta.textContent = v.error ? "✕ " + v.error : fmtSize(v.size || 0);
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
      else { btn.disabled = false; btn.textContent = "+ Add"; setStatus("disconnected"); }
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
    setStatus(r && r.ok ? "connected" : "disconnected");
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
      setStatus("connected");
      loadFound();
    } else {
      setStatus("disconnected");
    }
  });
});

urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendBtn.click();
});

// Re-scan the active tab. The action icon used to re-scan on click; with the
// panel wired to the icon, the button keeps the behavior reachable.
rescanBtn.addEventListener("click", () => {
  rescanBtn.disabled = true;
  rescanBtn.textContent = "Scanning…";
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (tab && tab.id != null) {
      chrome.tabs.sendMessage(tab.id, { type: "dv-rescan" }, (r) => {
        void chrome.runtime.lastError; // content script may be absent (chrome:// etc.)
        if (r && r.ok) {
          rescanBtn.textContent = "Found " + (r.count || 0) + " video" + (r.count === 1 ? "" : "s") + " ✓";
        }
        setTimeout(() => {
          rescanBtn.disabled = false;
          rescanBtn.textContent = "Re-scan this page";
        }, 1200);
      });
    } else {
      setTimeout(() => {
        rescanBtn.disabled = false;
        rescanBtn.textContent = "Re-scan this page";
      }, 200);
    }
  });
});

// Auto-monitor toggle: reflects/sets the background's dv_monitor flag.
function renderMonitor(on) {
  monitorBtn.textContent = "Auto monitor: " + (on ? "ON" : "OFF");
  monitorBtn.className = on ? "monitor-on" : "monitor-off";
}
function loadMonitor() {
  chrome.runtime.sendMessage({ type: "dv-monitor-get" }, (r) => {
    if (r) renderMonitor(r.on === true);
  });
}
monitorBtn.addEventListener("click", () => {
  const next = !monitorBtn.classList.contains("monitor-on");
  chrome.runtime.sendMessage({ type: "dv-monitor-set", on: next }, (r) => {
    if (r) renderMonitor(r.on === true);
  });
});

// background broadcasts dv-found-updated whenever the found list / sizes change,
// and desktop-status when the WS link changes. Refresh live while the popup is open.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "dv-found-updated") loadFound();
  else if (msg && msg.type === "desktop-status") setStatus(msg.ok ? "connected" : "disconnected");
  else if (msg && msg.type === "dv-monitor-changed") renderMonitor(msg.on === true);
});

refreshStatus();
loadFound();
loadMonitor();
