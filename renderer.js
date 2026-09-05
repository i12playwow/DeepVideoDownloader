const $ = (id) => document.getElementById(id);
// Local-time "YYYY-MM-DDTHH:MM" for the schedule prompt. toISOString() would
// return UTC, but new Date("YYYY-MM-DDTHH:MM") parses as local — the prefill
// must be local or it's off by the timezone offset.
function toLocalInput(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
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
let activeVisible = true;
let historyVisible = true;
let selected = new Set();

// Cached flat arrays of items/history — rebuilt once per update batch instead of
// copying the Map inside every render/summary/batch-bar call (cheap with a few
// dozen items, wasteful with thousands).
let itemList = [];
let historyList = [];

function updateBatchBar() {
  const bar = $("batchBar");
  bar.style.display = activeVisible ? "flex" : "none";
  const count = selected.size;
  const hasSel = count > 0;
  let selBytes = 0;
  for (const id of selected) {
    const it = items.get(id);
    if (it && it.total) selBytes += it.total;
  }
  $("batchCount").textContent = hasSel ? count + " selected \u00B7 " + fmtBytes(selBytes) : "";
  ["batchPause", "batchResume", "batchCancel", "batchRemove"].forEach((id) => {
    $(id).disabled = !hasSel;
  });
  const visibleIds = new Set(itemList.map((i) => i.id));
  let visSel = 0;
  for (const id of selected) if (visibleIds.has(id)) visSel++;
  const selAll = $("selAll");
  selAll.disabled = !activeVisible;
  selAll.checked = visibleIds.size > 0 && visSel === visibleIds.size;
  selAll.indeterminate = visSel > 0 && visSel < visibleIds.size;
}

$("pauseAll").addEventListener("click", () => window.api.pauseAll());
$("resumeAll").addEventListener("click", () => window.api.resumeAll());
$("retryFailed").addEventListener("click", () => window.api.retryFailed());

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function statusClass(st) {
  return "st-" + st;
}

function errorColor(it) {
  return (it.errorCategory === "expired" || it.errorCategory === "requires-browser") ? "var(--amber)" : "var(--red)";
}

// Virtualized list: only rows in the viewport are in the DOM, with spacer rows
// keeping the scrollbar sized to the full list. Keeps the UI smooth with
// thousands of queued downloads. ROW_H is an approximate fixed row height.
const ROW_H = 40;
let renderTimer = null;

function spacer(px) {
  const tr = document.createElement("tr");
  tr.style.height = px + "px";
  tr.style.border = "none";
  tr.innerHTML = '<td colspan="9" style="border:none;padding:0;"></td>';
  return tr;
}

function rowHtml(it, showing) {
  const pct = it.total ? Math.min(100, (it.received / it.total) * 100) : 0;
  const done = it.status === "done" || it.status === "cancelled";
  return `
      <td class="sel">${showing === "history" ? "" : `<input type="checkbox" data-sel="${esc(it.id)}" ${selected.has(it.id) ? "checked" : ""}>`}</td>
      <td class="name-cell" title="${esc(it.url)}">
        ${it.thumb ? `<img class="thumb" src="file:///${String(it.thumb).replace(/\\/g, "/")}" alt="" onerror="this.remove()">` : ""}
        <div class="name-col">
          <div class="name">${esc(it.fileName)}</div>
          <div class="sub">${esc(it.url)}</div>
        </div>
      </td>
      <td>${fmtBytes(it.total)}</td>
      <td class="wide">
        <div class="bar-wrap"><div class="bar" style="width:${pct}%"></div></div>
        <div class="pct">${pct.toFixed(1)}%${it.error ? ' — <span style="color:' + errorColor(it) + '">' + esc(it.error) + '</span>' : ""}${it.refreshCount ? '<div class="refreshed">↻ refreshed ' + it.refreshCount + '×</div>' : ""}${it.retryCount ? '<div class="refreshed">↻ retry ' + it.retryCount + '×</div>' : ""}</div>
      </td>
      <td class="speed">${done ? "—" : fmtSpeed(it.speed)}</td>
      <td class="proxy" title="${esc(it.proxy)}">${esc(it.proxy)}</td>
      <td class="sched">${fmtSched(it)}</td>
      <td class="status"><span class="badge ${statusClass(it.status)}">${esc(it.status)}</span></td>
      <td class="actions">${showing === "history" ? histActionButtons(it) : actionButtons(it)}</td>`;
}

let searchQuery = "";

function filteredItems() {
  if (!searchQuery) return itemList;
  const q = searchQuery.toLowerCase();
  return itemList.filter((it) =>
    (it.fileName || "").toLowerCase().includes(q) ||
    (it.url || "").toLowerCase().includes(q)
  );
}

function filteredHistory() {
  if (!searchQuery) return historyList;
  const q = searchQuery.toLowerCase();
  return historyList.filter((it) =>
    (it.fileName || "").toLowerCase().includes(q) ||
    (it.url || "").toLowerCase().includes(q)
  );
}

// Column sorting: per-table { key, dir }, toggled by clicking <th class=sortable>.
const sortState = { active: { key: "", dir: 1 }, history: { key: "", dir: 1 } };
const sortCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
function sortValue(it, key) {
  switch (key) {
    case "name": return (it.fileName || "").toLowerCase();
    case "size": return Number(it.total || 0);
    case "date": return Number(it.endTime || it.timestamp || 0);
    case "status": return it.status || "";
    default: return "";
  }
}
function sortList(list, st) {
  if (!st || !st.key) return list;
  const dir = st.dir;
  return [...list].sort((a, b) => {
    const va = sortValue(a, st.key), vb = sortValue(b, st.key);
    const c = (typeof va === "number" && typeof vb === "number") ? va - vb : sortCollator.compare(String(va), String(vb));
    return c * dir;
  });
}
function refreshSortHeaders() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    const st = sortState[th.dataset.table];
    const label = th.dataset.label || "";
    th.textContent = (st && st.key === th.dataset.sort) ? label + (st.dir === 1 ? " \u25B2" : " \u25BC") : label;
  });
}

function updateSummary() {
  const el = $("dlSummary");
  if (!el) return;
  const counts = { running: 0, queued: 0, paused: 0, scheduled: 0, done: 0, error: 0, duplicate: 0 };
  for (const it of itemList) if (counts[it.status] !== undefined) counts[it.status]++;
  const parts = [];
  [["running", "active"], ["queued", "queued"], ["paused", "paused"], ["scheduled", "scheduled"],
   ["done", "done"], ["error", "error"], ["duplicate", "duplicate"]].forEach(([k, label]) => {
    if (counts[k]) parts.push(counts[k] + " " + label);
  });
  el.textContent = parts.join(" · ");
}

function render() {
  const tbody = $("dlsBody");
  const displayItems = sortList(filteredItems(), sortState.active);
  const total = displayItems.length;

  if (!total) {
    tbody.innerHTML = `<tr id="emptyRow"><td class="empty" colspan="9">No downloads yet. Find an MP4 in the browser and it will appear here.</td></tr>`;
    updateBatchBar();
    updateSummary();
    return;
  }
  const scroll = $("dlsScroll");
  const st = scroll.scrollTop || 0;
  const vh = scroll.clientHeight || 400;
  const start = Math.max(0, Math.floor(st / ROW_H) - 6);
  const end = Math.min(total, Math.ceil((st + vh) / ROW_H) + 6);
  tbody.innerHTML = "";
  if (start > 0) tbody.appendChild(spacer(start * ROW_H));
  for (let i = start; i < end; i++) {
    const tr = document.createElement("tr");
    tr.innerHTML = rowHtml(displayItems[i], "active");
    tbody.appendChild(tr);
  }
  if (end < total) tbody.appendChild(spacer((total - end) * ROW_H));
  updateBatchBar();
  updateSummary();
}

// Coalesce rapid updates (status + progress) into one re-render per window.
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 120);
}

function actionButtons(it) {
  let html = "";
  if (it.status === "running") {
    html += `<button data-act="pause" data-id="${it.id}" title="Pause">⏸</button>`;
  }
  if (it.status === "paused" || it.status === "scheduled") {
    html += `<button data-act="resume" data-id="${it.id}" title="Resume">▶</button>`;
  }
  if (it.status === "error") {
    html += `<button data-act="retry" data-id="${it.id}" title="Retry now (fresh resolve, backoff reset)">↻</button>`;
  }
  if (it.status === "queued") {
    html += `<button data-act="pause" data-id="${it.id}">⏸</button>`;
  }
  const showSched = ["queued", "scheduled", "paused"].includes(it.status);
  if (showSched) {
    html += `<button data-act="schedule" data-id="${it.id}" class="ghost" title="Schedule start/stop times">📅</button>`;
  }
  if (["running", "queued", "paused", "scheduled", "error"].includes(it.status)) {
    html += `<button data-act="cancel" data-id="${it.id}" class="danger" title="Cancel">✕</button>`;
  }
  if (["done", "error", "cancelled"].includes(it.status)) {
    if (it.status === "done") html += `<button data-act="move" data-id="${it.id}" title="Move file to another folder">&#8646;</button>`;
    html += `<button data-act="remove" data-id="${it.id}" title="Remove">🗑</button>`;
  }
  if (it.status === "duplicate") {
    html += `<button data-act="forceDownload" data-id="${it.id}" title="Download anyway">▶</button>`;
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
  if (it.status === "done" && it.finalPath) {
    html += `<button data-act="move" data-id="${it.id}" title="Move file to another folder">&#8646;</button>`;
  }
  return html;
}

async function handleMove(id) {
  const dir = await window.api.chooseDir();
  if (!dir) return;
  const r = await window.api.moveDownload(id, dir);
  if (!r.ok) alert("Move failed: " + (r.error || "unknown error"));
  else showToast("Moved to " + dir, [{ label: "Dismiss", className: "btn ghost", onClick: () => {} }]);
  render();
  scheduleHistoryReload();
}

$("dlsBody").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  if (act === "schedule") {
    e.preventDefault();
    const it = items.get(id);
    const start = prompt("Start time (YYYY-MM-DDTHH:MM) or leave blank:", toLocalInput(it.scheduledStart));
    if (start === null) return;
    const stop = prompt("Stop time (YYYY-MM-DDTHH:MM) or leave blank:", toLocalInput(it.scheduledStop));
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
  } else if (act === "move") {
    handleMove(id);
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

document.querySelectorAll("th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const t = th.dataset.table;
    if (!t) return;
    const st = sortState[t];
    if (st.key === th.dataset.sort) st.dir = -st.dir;
    else { st.key = th.dataset.sort; st.dir = 1; }
    refreshSortHeaders();
    if (t === "active") render();
    else renderHistory();
  });
});
refreshSortHeaders();

$("histBody").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const it = historyItems.get(btn.dataset.id);
  if (!it) return;
  if (btn.dataset.act === "history-error") alert("Error: " + it.error);
  else if (btn.dataset.act === "history-date") alert("Completed: " + fmtDate(it.endTime || it.timestamp));
  else if (btn.dataset.act === "move") handleMove(it.id);
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
  itemList = list;
  render();
}

async function loadHistory() {
  const hist = await window.api.history();
  historyItems = new Map(hist.map((i) => [i.id, i]));
  historyList = hist;
  renderHistory();
}

function historyRowHtml(it) {
  return `<tr>
    <td class="name-cell" title="${esc(it.url)}">
      ${it.thumb ? `<img class="thumb" src="file:///${String(it.thumb).replace(/\\/g, "/")}" alt="" onerror="this.remove()">` : ""}
      <div class="name-col"><div class="name">${esc(it.fileName)}</div><div class="sub">${esc(it.url)}</div></div>
    </td>
    <td>${fmtBytes(it.total)}</td>
    <td class="wide">${fmtDate(it.endTime || it.timestamp)}</td>
    <td class="status"><span class="badge ${statusClass(it.status)}">${esc(it.status)}</span></td>
    <td class="actions">${histActionButtons(it)}</td>
  </tr>`;
}

function renderHistory() {
  const tbody = $("histBody");
  if (!tbody) return;
  const count = $("histCount");
  const list = sortList(filteredHistory(), sortState.history);
  if (count) {
    let sum = 0;
    for (const h of list) sum += Number(h.total || 0);
    count.textContent = historyItems.size
      ? historyItems.size + (historyItems.size === 1 ? " entry" : " entries") + " \u00B7 " + fmtBytes(sum)
      : "";
  }
  if (!list.length) {
    tbody.innerHTML = `<tr><td class="empty" colspan="5">${searchQuery ? "No history matches your filter." : "No history yet."}</td></tr>`;
    return;
  }
  // Virtualized like the active list: only rows near the viewport are in the
  // DOM so a multi-thousand-entry history stays responsive.
  const scroll = $("histScroll");
  const st = scroll.scrollTop || 0;
  const vh = scroll.clientHeight || 400;
  const start = Math.max(0, Math.floor(st / ROW_H) - 6);
  const end = Math.min(list.length, Math.ceil((st + vh) / ROW_H) + 6);
  let html = "";
  if (start > 0) html += `<tr style="height:${start * ROW_H}px;"><td colspan="5" style="border:none;padding:0;"></td></tr>`;
  for (let i = start; i < end; i++) html += historyRowHtml(list[i]);
  if (end < list.length) html += `<tr style="height:${(list.length - end) * ROW_H}px;"><td colspan="5" style="border:none;padding:0;"></td></tr>`;
  tbody.innerHTML = html;
}

let histReloadTimer = null;
function scheduleHistoryReload() {
  if (histReloadTimer) return;
  histReloadTimer = setTimeout(() => { histReloadTimer = null; loadHistory(); }, 1500);
}

window.api.onHistoryUpdated(() => scheduleHistoryReload());

window.api.onUpdate((msg) => {
  const batch = Array.isArray(msg) ? msg : [msg];
  let needHistory = false;
  for (const item of batch) {
    if (item && item._removed) {
      items.delete(item._removed);
      selected.delete(item._removed);
    } else if (item) {
      items.set(item.id, item);
      if (["done", "error", "cancelled", "duplicate"].includes(item.status)) needHistory = true;
    }
  }
  itemList = Array.from(items.values());
  if (needHistory) scheduleHistoryReload();
  scheduleRender();
});

$("dlsScroll").addEventListener("scroll", () => {
  if (!renderTimer) render(); // virtualized render is cheap; keep rows in view
});

$("histScroll").addEventListener("scroll", () => {
  if (!renderTimer) renderHistory(); // keep history rows in view
});

$("search").addEventListener("input", () => {
  searchQuery = $("search").value.trim();
  $("dlsScroll").scrollTop = 0;
  if ($("histScroll")) $("histScroll").scrollTop = 0;
  render();
  renderHistory();
});

// ---------------- settings ----------------
async function loadSettings() {
  const s = await window.api.getSettings();
  $("downloadDir").value = s.downloadDir;
  $("downloadDir2").value = s.downloadDir2 || "";
  $("downloadDir3").value = s.downloadDir3 || "";
  $("minFreeMB").value = s.minFreeMB ?? 500;
  $("concurrency").value = s.concurrency;
  $("segments").value = s.segments;
  $("speedLimitKB").value = s.speedLimitKB;
  $("maxRetries").value = s.maxRetries ?? 3;
  $("maxRefresh").value = s.maxRefresh ?? 2;
  $("autoProxy").checked = !!s.autoProxy;
  $("saveHistory").checked = s.saveHistory !== false;
  $("skipDuplicates").checked = s.skipDuplicates !== false;
  $("autoCloseTab").checked = s.autoCloseTab !== false;
  $("thumbnails").checked = s.thumbnails !== false;
  $("idleTabMinutes").value = s.idleTabMinutes ?? 0;
  $("autoRetryMinutes").value = s.autoRetryMinutes ?? 0;
  $("autoRetryMax").value = s.autoRetryMax ?? 5;
  $("scheduleWindowStart").value = s.scheduleWindowStart || "";
  $("scheduleWindowEnd").value = s.scheduleWindowEnd || "";
  $("siteRules").value = (s.siteRules || []).map((r) => [r.host, r.folder || "", r.start ? "start" : ""].filter(Boolean).join("\t")).join("\n");
  $("proxies").value = (s.proxies || []).join("\n");
  $("proxyRules").value = (s.proxyRules || []).map((r) => r.host + "\t" + r.proxy).join("\n");
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

document.querySelectorAll("button[data-browse]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const inp = $(btn.dataset.browse);
    if (!inp) return;
    const dir = await window.api.chooseDir();
    if (dir) inp.value = dir;
  });
});

$("save").addEventListener("click", async () => {
  await window.api.saveSettings({
    downloadDir: $("downloadDir").value.trim(),
    downloadDir2: $("downloadDir2").value.trim(),
    downloadDir3: $("downloadDir3").value.trim(),
    minFreeMB: Math.max(0, parseInt($("minFreeMB").value || "500", 10)),
    concurrency: Math.max(1, parseInt($("concurrency").value || "1", 10)),
    segments: Math.max(1, parseInt($("segments").value || "1", 10)),
    speedLimitKB: Math.max(0, parseInt($("speedLimitKB").value || "0", 10)),
    maxRetries: Math.max(0, parseInt($("maxRetries").value || "3", 10)),
    maxRefresh: Math.max(0, parseInt($("maxRefresh").value || "2", 10)),
    autoProxy: $("autoProxy").checked,
    saveHistory: $("saveHistory").checked,
    skipDuplicates: $("skipDuplicates").checked,
    autoCloseTab: $("autoCloseTab").checked,
    thumbnails: $("thumbnails").checked,
    idleTabMinutes: Math.max(0, parseInt($("idleTabMinutes").value || "0", 10)),
    autoRetryMinutes: Math.max(0, parseInt($("autoRetryMinutes").value || "0", 10)),
    autoRetryMax: Math.max(0, parseInt($("autoRetryMax").value || "0", 10)),
    scheduleWindowStart: $("scheduleWindowStart").value || "",
    scheduleWindowEnd: $("scheduleWindowEnd").value || "",
    siteRules: $("siteRules").value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const t = l.split(/\s+/);
      return { host: t[0] || "", folder: t[1] || "", start: t.includes("start") };
    }).filter((r) => r.host),
    proxies: $("proxies").value.split("\n").map((p) => p.trim()).filter(Boolean),
    proxyRules: $("proxyRules").value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const i = l.search(/\s/);
      const host = (i === -1 ? l : l.slice(0, i)).trim();
      const proxy = (i === -1 ? "" : l.slice(i)).trim();
      return { host, proxy };
    }).filter((r) => r.host && r.proxy)
  });
  refreshActiveDir();
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

  $("openDir").addEventListener("click", async () => { await window.api.openDir(); refreshActiveDir(); });
$("openBrowser").addEventListener("click", () => window.api.openBrowser());
async function refreshActiveDir() {
  try {
    const d = await window.api.getActiveDir();
    if (d) $("activeDir").textContent = "Saving to: " + d;
  } catch (e) { /* ignore */ }
}
refreshActiveDir();
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
    // open each URL as a tab in the built-in browser
    window.api.openBrowser(urls);
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
$("downloadAll").addEventListener("click", async () => {
  const urls = parseUrls();
  if (!urls.length) return;
  const r = await window.api.addMany(urls, destOverride || null);
  const n = r && r.ok ? r.count : 0;
  alert("Enqueued " + n + " of " + urls.length + " URL(s).");
});

// Per-download destination override: when set, newly added URLs skip the
// automatic folder rotation and land in the picked folder instead.
let destOverride = "";
function updateDestUi() {
  const short = destOverride ? (destOverride.split(/[\\/]/).filter(Boolean).pop() || destOverride) : "auto";
  $("pickDestLabel").textContent = short;
  $("pickDest").title = "Destination for added URLs" + (destOverride ? ": " + destOverride : " (automatic rotation)");
  $("clearDest").style.display = destOverride ? "" : "none";
}
$("pickDest").addEventListener("click", async () => {
  const dir = await window.api.chooseDir();
  if (dir) { destOverride = dir; updateDestUi(); }
});
$("clearDest").addEventListener("click", () => { destOverride = ""; updateDestUi(); });
updateDestUi();

$("installExt").addEventListener("click", async () => {
  const target = $("browserTarget").value;
  if (target === "builtin" || target === "default") {
    alert("Pick Chrome, Edge, or Brave in the browser dropdown to install the extension.");
    return;
  }
  const res = await window.api.installExtension(target);
  if (res && res.error === "not-found") {
    showToast(target[0].toUpperCase() + target.slice(1) + " is not installed on this system.", [{ label: "Dismiss", className: "btn ghost", onClick: () => {} }]);
  } else if (res && res.ok) {
    showToast("Deep Grab launched in " + res.browser + " on a dedicated profile — the extension is loaded for that window.", [{ label: "Dismiss", className: "btn ghost", onClick: () => {} }]);
  } else {
    showToast("Could not install: " + ((res && res.error) || "unknown error"), [{ label: "Dismiss", className: "btn ghost", onClick: () => {} }]);
  }
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
  activeVisible = !activeVisible;
  $("showActive").classList.toggle("active", activeVisible);
  $("dlsScroll").style.display = activeVisible ? "" : "none";
  render();
  updateBatchBar();
});

$("showHistory").addEventListener("click", () => {
  historyVisible = !historyVisible;
  $("showHistory").classList.toggle("active", historyVisible);
  const sec = $("historySection");
  if (sec) sec.style.display = historyVisible ? "" : "none";
  if (historyVisible) loadHistory();
});

$("exportJson").addEventListener("click", () => window.api.exportHistory("json"));
$("exportCsv").addEventListener("click", () => window.api.exportHistory("csv"));

$("clearHistory").addEventListener("click", async () => {
  if (!confirm("Clear all download history?")) return;
  const res = await window.api.clearHistory();
  if (res.ok) {
    historyItems = new Map();
    renderHistory();
  }
});

// ---------------- toast notifications ----------------
function showToast(title, actions) {
  const notification = document.createElement("div");
  notification.className = "clipboard-notify";
  const titleEl = document.createElement("div");
  titleEl.className = "notify-title";
  titleEl.textContent = title;
  const row = document.createElement("div");
  row.className = "notify-actions";
  (actions || []).forEach((a) => {
    const btn = document.createElement("button");
    btn.className = a.className || "btn";
    btn.textContent = a.label;
    btn.addEventListener("click", () => { a.onClick(); notification.remove(); });
    row.appendChild(btn);
  });
  notification.appendChild(titleEl);
  notification.appendChild(row);
  document.body.appendChild(notification);
  setTimeout(() => {
    if (notification.parentElement) {
      notification.remove();
    }
  }, 15000);
}

// ---------------- clipboard monitoring ----------------
window.api.onClipboardUrl((data) => {
  showToast("📋 Video URL detected in clipboard", [
    {
      label: "Add download",
      className: "btn",
      onClick: async () => {
        const res = await window.api.add(data.url, destOverride || null);
        if (!res.ok) {
          alert("Failed to add download: " + (res.error || "unknown error"));
        }
      }
    },
    { label: "Dismiss", className: "btn ghost", onClick: () => {} }
  ]);
});

// ---------------- file opened via Windows file association ----------------
window.api.onFileOpened((data) => {
  showToast("🎬 Opened: " + (data.name || data.path), [
    {
      label: "Show in folder",
      className: "btn",
      onClick: () => window.api.showInFolder(data.path)
    },
    { label: "Dismiss", className: "btn ghost", onClick: () => {} }
  ]);
});

// ---------------- bandwidth charting ----------------
let bwChart = null;

// Canvas fillStyle can't resolve CSS var(); pull the computed value instead.
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#94a3b8";
}

function drawBandwidthChart(samples) {
  const canvas = $("bwChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  if (!samples.length) {
    ctx.fillStyle = cssVar("--muted");
    ctx.font = "11px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("No bandwidth data yet", w / 2, h / 2);
    return;
  }

  const max = Math.max(...samples.map((s) => s.speed), 1);
  const barWidth = (w / Math.max(samples.length, 1)) - 1;

  ctx.fillStyle = cssVar("--accent");
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
setInterval(loadAll, 5000);
setInterval(updateBandwidth, 5000);
