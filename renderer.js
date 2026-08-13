const $ = (id) => document.getElementById(id);
const fmtBytes = (b) => {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return (b / Math.pow(1024, i)).toFixed(i > 1 ? 2 : 0) + " " + u[i];
};
const fmtSpeed = (s) => (s ? fmtBytes(s) + "/s" : "—");

let items = new Map();

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function statusClass(st) {
  return "st-" + st;
}

function render() {
  const tbody = $("dlsBody");
  tbody.innerHTML = "";
  if (!items.size) {
    tbody.innerHTML = '<tr id="emptyRow"><td colspan="7">No downloads yet. Find an MP4 in the browser and it will appear here.</td></tr>';
    return;
  }
  for (const it of items.values()) {
    const tr = document.createElement("tr");
    const pct = it.total ? Math.min(100, (it.received / it.total) * 100) : 0;
    const done = it.status === "done" || it.status === "cancelled";

    tr.innerHTML = `
      <td class="name" title="${esc(it.url)}">
        <div>${esc(it.fileName)}</div>
        <div class="sub">${esc(it.url)}</div>
      </td>
      <td>${fmtBytes(it.total)}</td>
      <td class="wide">
        <div class="bar-wrap"><div class="bar" style="width:${pct}%"></div></div>
        <div class="pct">${pct.toFixed(1)}%${it.error ? ' — <span style="color:var(--red)">' + esc(it.error) + '</span>' : ""}</div>
      </td>
      <td class="speed">${done ? "—" : fmtSpeed(it.speed)}</td>
      <td class="proxy" title="${esc(it.proxy)}">${esc(it.proxy)}</td>
      <td class="status ${statusClass(it.status)}">${esc(it.status)}</td>
      <td class="actions">${actionButtons(it)}</td>`;
    tbody.appendChild(tr);
  }
}

function actionButtons(it) {
  let html = "";
  if (it.status === "running") {
    html += `<button data-act="pause" data-id="${it.id}">⏸</button>`;
  }
  if (it.status === "paused" || it.status === "error") {
    html += `<button data-act="resume" data-id="${it.id}">▶</button>`;
  }
  if (it.status === "queued") {
    html += `<button data-act="pause" data-id="${it.id}">⏸</button>`;
  }
  if (["running", "queued", "paused", "error"].includes(it.status)) {
    html += `<button data-act="cancel" data-id="${it.id}" class="danger">✕</button>`;
  }
  if (["done", "error", "cancelled"].includes(it.status)) {
    html += `<button data-act="remove" data-id="${it.id}">🗑</button>`;
  }
  return html;
}

$("dlsBody").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  window.api[act](id);
});

async function loadAll() {
  const list = await window.api.list();
  items = new Map(list.map((i) => [i.id, i]));
  render();
}

window.api.onUpdate((item) => {
  if (item._removed) {
    items.delete(item._removed);
  } else {
    items.set(item.id, item);
  }
  render();
});

// ---------------- settings ----------------
async function loadSettings() {
  const s = await window.api.getSettings();
  $("wsHint").textContent = "ws://127.0.0.1:" + (s.port || 8765);
  $("downloadDir").value = s.downloadDir;
  $("concurrency").value = s.concurrency;
  $("segments").value = s.segments;
  $("speedLimitKB").value = s.speedLimitKB;
  $("autoProxy").checked = !!s.autoProxy;
  $("proxies").value = (s.proxies || []).join("\n");
}

$("save").addEventListener("click", async () => {
  await window.api.saveSettings({
    downloadDir: $("downloadDir").value.trim(),
    concurrency: Math.max(1, parseInt($("concurrency").value || "1", 10)),
    segments: Math.max(1, parseInt($("segments").value || "1", 10)),
    speedLimitKB: Math.max(0, parseInt($("speedLimitKB").value || "0", 10)),
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

loadSettings();
loadAll();
setInterval(loadAll, 2000);
