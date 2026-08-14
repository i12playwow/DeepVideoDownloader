const $ = (id) => document.getElementById(id);
const fmtBytes = (b) => {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return (b / Math.pow(1024, i)).toFixed(i > 1 ? 2 : 0) + " " + u[i];
};
const fmtSpeed = (s) => (s ? fmtBytes(s) + "/s" : "—");

function fmtSched(it) {
  if (!it.scheduledStart && !it.scheduledStop) return "—";
  let parts = [];
  if (it.scheduledStart) parts.push("▶ " + new Date(it.scheduledStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  if (it.scheduledStop) parts.push("⏹ " + new Date(it.scheduledStop).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  return parts.join("<br>");
}

function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

let items = new Map();
let historyItems = new Map();
let showing = "active";
let selected = new Set();

function updateBatchBar() {
  const bar = $("batchBar");
  bar.style.display = showing === "active" ? "flex" : "none";
  const count = selected.size;
  const hasSel = count > 0;
  $("batchCount").textContent = hasSel ? count + " selected" : "";
  ["batchPause", "batchResume", "batchCancel", "batchRemove"].forEach((id) => {
    $(id).disabled = !hasSel;
  });
  const visibleIds = new Set(Array.from(items.values()).map((i) => i.id));
  let visSel = 0;
  for (const id of selected) if (visibleIds.has(id)) visSel++;
  const selAll = $("selAll");
  selAll.disabled = showing === "history";
  selAll.checked = visibleIds.size > 0 && visSel === visibleIds.size;
  selAll.indeterminate = visSel > 0 && visSel < visibleIds.size;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function statusClass(st) {
  return "st-" + st;
}

function errorColor(it) {
  return it.errorCategory === "expired" ? "var(--amber)" : "var(--red)";
}

function render() {
  const tbody = $("dlsBody");
  const displayItems = showing === "history" ? Array.from(historyItems.values()) : Array.from(items.values());

  if (!displayItems.length) {
    tbody.innerHTML = `<tr id="emptyRow"><td colspan="9">${showing === "history" ? "No history yet." : "No downloads yet. Find an MP4 in the browser and it will appear here."}</td></tr>`;
    updateBatchBar();
    return;
  }
  tbody.innerHTML = "";
  for (const it of displayItems) {
    const tr = document.createElement("tr");
    const pct = it.total ? Math.min(100, (it.received / it.total) * 100) : 0;
    const done = it.status === "done" || it.status === "cancelled";

    tr.innerHTML = `
      <td class="sel">${showing === "history" ? "" : `<input type="checkbox" data-sel="${esc(it.id)}" ${selected.has(it.id) ? "checked" : ""}>`}</td>
      <td class="name" title="${esc(it.url)}">
        <div>${esc(it.fileName)}</div>
        <div class="sub">${esc(it.url)}</div>
      </td>
      <td>${fmtBytes(it.total)}</td>
      <td class="wide">
        <div class="bar-wrap"><div class="bar" style="width:${pct}%"></div></div>
        <div class="pct">${pct.toFixed(1)}%${it.error ? ' — <span style="color:' + errorColor(it) + '">' + esc(it.error) + '</span>' : ""}${it.refreshCount ? '<div class="refreshed">↻ refreshed ' + it.refreshCount + '×</div>' : ""}</div>
      </td>
      <td class="speed">${done ? "—" : fmtSpeed(it.speed)}</td>
      <td class="proxy" title="${esc(it.proxy)}">${esc(it.proxy)}</td>
      <td class="sched">${fmtSched(it)}</td>
      <td class="status ${statusClass(it.status)}">${esc(it.status)}</td>
      <td class="actions">${showing === "history" ? histActionButtons(it) : actionButtons(it)}</td>`;
    tbody.appendChild(tr);
  }
  updateBatchBar();
}

function actionButtons(it) {
  let html = "";
  if (it.status === "running") {
    html += `<button data-act="pause" data-id="${it.id}">⏸</button>`;
  }
  if (it.status === "paused" || it.status === "error" || it.status === "scheduled") {
    html += `<button data-act="resume" data-id="${it.id}">▶</button>`;
  }
  if (it.status === "queued") {
    html += `<button data-act="pause" data-id="${it.id}">⏸</button>`;
  }
  const showSched = ["queued", "scheduled", "paused"].includes(it.status);
  if (showSched) {
    html += `<button data-act="schedule" data-id="${it.id}" class="ghost">📅</button>`;
  }
  if (["running", "queued", "paused", "scheduled", "error"].includes(it.status)) {
    html += `<button data-act="cancel" data-id="${it.id}" class="danger">✕</button>`;
  }
  if (["done", "error", "cancelled"].includes(it.status)) {
    html += `<button data-act="remove" data-id="${it.id}">🗑</button>`;
  }
  return html;
}

function histActionButtons(it) {
  let html = "";
  if (it.error) {
    html += `<button data-act="history-error" data-id="${it.id}" title="${esc(it.error)}" class="ghost">ⓘ</button>`;
  }
  html += `<button data-act="history-date" data-id="${it.id}" title="${fmtDate(it.timestamp)}">📅</button>`;
  return html;
}

$("dlsBody").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  if (act === "schedule") {
    e.preventDefault();
    const it = items.get(id);
    const start = prompt("Start time (YYYY-MM-DDTHH:MM) or leave blank:", it.scheduledStart ? new Date(it.scheduledStart).toISOString().slice(0, 16) : "");
    if (start === null) return;
    const stop = prompt("Stop time (YYYY-MM-DDTHH:MM) or leave blank:", it.scheduledStop ? new Date(it.scheduledStop).toISOString().slice(0, 16) : "");
    if (stop === null) return;
    window.api.schedule({
      id,
      mode: "set",
      scheduledStart: start || null,
      scheduledStop: stop || null
    });
  } else if (act === "history-error" || act === "history-date") {
    const it = historyItems.get(id);
    if (it && act === "history-error") {
      alert("Error: " + it.error);
    } else if (it && act === "history-date") {
      alert("Completed: " + fmtDate(it.endTime || it.timestamp));
    }
  } else {
    window.api[act](id);
  }
});

$("dlsBody").addEventListener("change", (e) => {
  const cb = e.target.closest("input[data-sel]");
  if (!cb) return;
  if (cb.checked) selected.add(cb.dataset.sel);
  else selected.delete(cb.dataset.sel);
  updateBatchBar();
});

$("selAll").addEventListener("change", () => {
  const active = Array.from(items.values());
  if ($("selAll").checked) active.forEach((i) => selected.add(i.id));
  else active.forEach((i) => selected.delete(i.id));
  render();
});

["batchPause", "batchResume", "batchCancel", "batchRemove"].forEach((btnId) => {
  const method = btnId.replace("batch", "").toLowerCase();
  $(btnId).addEventListener("click", () => {
    const ids = Array.from(selected);
    ids.forEach((id) => window.api[method](id));
  });
});

async function loadAll() {
  const list = await window.api.list();
  items = new Map(list.map((i) => [i.id, i]));
  render();
}

async function loadHistory() {
  const hist = await window.api.history();
  historyItems = new Map(hist.map((i) => [i.id, i]));
  render();
}

window.api.onUpdate((item) => {
  if (item._removed) {
    items.delete(item._removed);
    selected.delete(item._removed);
  } else {
    items.set(item.id, item);
  }
  render();
});

// ---------------- settings ----------------
async function loadSettings() {
  const s = await window.api.getSettings();
  $("downloadDir").value = s.downloadDir;
  $("concurrency").value = s.concurrency;
  $("segments").value = s.segments;
  $("speedLimitKB").value = s.speedLimitKB;
  $("maxRetries").value = s.maxRetries ?? 3;
  $("maxRefresh").value = s.maxRefresh ?? 2;
  $("autoProxy").checked = !!s.autoProxy;
  $("proxies").value = (s.proxies || []).join("\n");
  applyTheme(s.theme || "dark");
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  $("themeToggle").textContent = theme === "dark" ? "☀️ Light mode" : "🌙 Dark mode";
  window.api.saveSettings({ theme });
}

$("themeToggle").addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  applyTheme(current === "dark" ? "light" : "dark");
});

$("save").addEventListener("click", async () => {
  await window.api.saveSettings({
    downloadDir: $("downloadDir").value.trim(),
    concurrency: Math.max(1, parseInt($("concurrency").value || "1", 10)),
    segments: Math.max(1, parseInt($("segments").value || "1", 10)),
    speedLimitKB: Math.max(0, parseInt($("speedLimitKB").value || "0", 10)),
    maxRetries: Math.max(0, parseInt($("maxRetries").value || "3", 10)),
    maxRefresh: Math.max(0, parseInt($("maxRefresh").value || "2", 10)),
    autoProxy: $("autoProxy").checked,
    proxies: $("proxies").value.split("\n").map((p) => p.trim()).filter(Boolean)
  });
});

$("testProxies").addEventListener("click", async () => {
  const res = await window.api.testProxies($("testUrl").value.trim());
  const ul = $("proxyResults");
  ul.innerHTML = "";
  res.forEach((r) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="${r.ms == null ? "fail" : "ok"}">${r.ms == null ? "✗ fail" : "✓ " + r.ms + " ms"}</span><span>${esc(r.proxy)}</span>`;
    ul.appendChild(li);
  });
});

  $("openDir").addEventListener("click", () => window.api.openDir());
  $("openBrowser").addEventListener("click", () => window.api.openBrowser());
  const parseUrls = () => {
    return String($("browserUrl").value || "")
      .split(/[\n,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((u) => (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u) ? u : "https://" + u));
  };
  const browserGo = () => {
    const urls = parseUrls();
    if (!urls.length) { window.api.openBrowser(); return; }
    const target = $("browserTarget").value;
    if (target === "builtin") {
      // built-in window shows one page at a time; open the first
      window.api.openBrowser(urls[0]);
      window.api.browserNav(urls[0]);
      if (urls.length > 1) {
        alert("The built-in browser shows one page at a time — opened the first URL. Use Chrome/Edge/Brave to open all.");
      }
    } else {
      let notFound = false;
      urls.forEach((u) => {
        window.api.openExternal(u, target).then((r) => { if (r && r.error === "not-found") notFound = true; });
      });
      setTimeout(() => { if (notFound) alert("Could not find " + target + " on this system."); }, 800);
    }
  };
  $("browserGo").addEventListener("click", browserGo);
  $("browserUrl").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) browserGo(); });
  $("browserBack").addEventListener("click", () => window.api.browserBack());
  $("browserFwd").addEventListener("click", () => window.api.browserForward());
  $("browserReload").addEventListener("click", () => window.api.browserReload());
  window.api.onBrowserState((s) => {
    if (s.url) $("browserUrl").value = s.url;
    $("browserBack").disabled = !s.canBack;
    $("browserFwd").disabled = !s.canForward;
  });

$("resumeLast").addEventListener("click", async () => {
  const res = await window.api.resumeLast();
  if (!res.ok) {
    alert("Failed to resume: " + (res.error || "unknown error"));
  } else if (!res.id) {
    alert("Nothing to resume — no finished downloads yet.");
  }
});

$("showActive").addEventListener("click", () => {
  showing = "active";
  $("showActive").classList.add("active");
  $("showHistory").classList.remove("active");
  render();
});

$("showHistory").addEventListener("click", () => {
  showing = "history";
  $("showHistory").classList.add("active");
  $("showActive").classList.remove("active");
  loadHistory();
  render();
});

$("exportJson").addEventListener("click", () => window.api.exportHistory("json"));
$("exportCsv").addEventListener("click", () => window.api.exportHistory("csv"));

$("clearHistory").addEventListener("click", async () => {
  if (!confirm("Clear all download history?")) return;
  const res = await window.api.clearHistory();
  if (res.ok) {
    historyItems = new Map();
    render();
  }
});

// ---------------- clipboard monitoring ----------------
window.api.onClipboardUrl((data) => {
  const notification = document.createElement("div");
  notification.className = "clipboard-notify";
  const title = document.createElement("div");
  title.style.cssText = "font-size: 11px; margin-bottom: 6px;";
  title.textContent = "📋 Video URL detected in clipboard";
  const row = document.createElement("div");
  row.style.cssText = "display: flex; gap: 6px;";
  const addBtn = document.createElement("button");
  addBtn.className = "btn";
  addBtn.style.cssText = "font-size: 10px; padding: 4px 8px;";
  addBtn.textContent = "Add download";
  addBtn.addEventListener("click", async () => {
    const res = await window.api.add(data.url);
    if (!res.ok) {
      alert("Failed to add download: " + (res.error || "unknown error"));
    }
    notification.remove();
  });
  const dismissBtn = document.createElement("button");
  dismissBtn.className = "btn ghost";
  dismissBtn.style.cssText = "font-size: 10px; padding: 4px 8px;";
  dismissBtn.textContent = "Dismiss";
  dismissBtn.addEventListener("click", () => notification.remove());
  row.appendChild(addBtn);
  row.appendChild(dismissBtn);
  notification.appendChild(title);
  notification.appendChild(row);
  notification.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    z-index: 9999;
    max-width: 300px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  `;
  document.body.appendChild(notification);

  setTimeout(() => {
    if (notification.parentElement) {
      notification.remove();
    }
   }, 15000);
});

// ---------------- file opened via Windows file association ----------------
window.api.onFileOpened((data) => {
  const notification = document.createElement("div");
  notification.className = "clipboard-notify";
  const title = document.createElement("div");
  title.style.cssText = "font-size: 11px; margin-bottom: 6px;";
  title.textContent = "🎬 Opened: " + (data.name || data.path);
  const row = document.createElement("div");
  row.style.cssText = "display: flex; gap: 6px;";
  const folderBtn = document.createElement("button");
  folderBtn.className = "btn";
  folderBtn.style.cssText = "font-size: 10px; padding: 4px 8px;";
  folderBtn.textContent = "Show in folder";
  folderBtn.addEventListener("click", async () => {
    await window.api.showInFolder(data.path);
    notification.remove();
  });
  const dismissBtn = document.createElement("button");
  dismissBtn.className = "btn ghost";
  dismissBtn.style.cssText = "font-size: 10px; padding: 4px 8px;";
  dismissBtn.textContent = "Dismiss";
  dismissBtn.addEventListener("click", () => notification.remove());
  row.appendChild(folderBtn);
  row.appendChild(dismissBtn);
  notification.appendChild(title);
  notification.appendChild(row);
  notification.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    z-index: 9999;
    max-width: 300px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  `;
  document.body.appendChild(notification);
  setTimeout(() => {
    if (notification.parentElement) notification.remove();
  }, 15000);
});

// ---------------- bandwidth charting ----------------
let bwChart = null;

function drawBandwidthChart(samples) {
  const canvas = $("bwChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  if (!samples.length) {
    ctx.fillStyle = "var(--muted)";
    ctx.font = "11px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("No bandwidth data yet", w / 2, h / 2);
    return;
  }

  const max = Math.max(...samples.map((s) => s.speed), 1);
  const barWidth = (w / Math.max(samples.length, 1)) - 1;

  ctx.fillStyle = "#3b82f6";
  samples.forEach((s, i) => {
    const height = (s.speed / max) * (h - 10);
    ctx.fillRect(i * (barWidth + 1), h - height, barWidth, height);
  });
}

async function updateBandwidth() {
  const stats = await window.api.bandwidthStats();
  const el = $("bwStats");
  if (el) {
    el.innerHTML = `Current: ${fmtSpeed(stats.current)} | Avg: ${fmtSpeed(stats.avg)} | Peak: ${fmtSpeed(stats.peak)}`;
  }
  drawBandwidthChart(stats.samples);
}

loadSettings();
loadAll();
loadHistory();
updateBandwidth();
setInterval(loadAll, 2000);
setInterval(updateBandwidth, 5000);
