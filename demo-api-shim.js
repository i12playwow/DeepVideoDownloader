// Mock window.api for the renderer demo page (.freebuff/demo-renderer.html).
// Stands in for Electron preload.js (contextBridge IPC): provides demo state,
// simulates live download progress, and answers every call renderer.js makes.
// Loaded BEFORE renderer.js so window.api exists when it boots.

(function () {
  const MB = 1024 * 1024;
  const now = Date.now();
  const hr = 3600 * 1000;

  // ---- demo store -------------------------------------------------------
  // Active items: shape mirrors what rowHtml/actionButtons in renderer.js read.
  let items = [
    { id: "d1", url: "https://surrit.com/v/LUXU-1892/playlist.m3u8", fileName: "LUXU-1892 (Surrit) [1080p].mp4",
      total: 1892 * MB, received: 1849 * MB, speed: 9.4 * MB, status: "running", proxy: "direct" },
    { id: "d2", url: "https://cdn2.turboviplay.com/media/SIMW-010/master.m3u8", fileName: "SIMW-010 (Turboviplay) [720p].mp4",
      total: 976 * MB, received: 143 * MB, speed: 4.1 * MB, status: "running", proxy: "http://127.0.0.1:7890" },
    { id: "d3", url: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_30MB.mp4",
      fileName: "Big_Buck_Bunny_1080_10s_30MB.mp4", total: 30 * MB, received: 0, speed: 0, status: "queued", proxy: "direct" },
    { id: "d4", url: "https://supjav.com/452555.html", fileName: "SDMM-238 (supjav) [480p].mp4",
      total: 612 * MB, received: 240 * MB, speed: 0, status: "paused", proxy: "socks5://127.0.0.1:1080",
      scheduledStart: new Date(now + 2 * hr).toISOString(), scheduledStop: new Date(now + 4 * hr).toISOString() },
    { id: "d5", url: "https://sextb.net/video/9999.html", fileName: "SSIS-999 (sextb) [720p].mp4",
      total: 0, received: 0, speed: 0, status: "error", proxy: "direct",
      error: "403 — requires-browser: Cloudflare wall, open in the built-in browser", errorCategory: "requires-browser", refreshCount: 2 },
    { id: "d6", url: "https://missav.ai/dupe/MMK-123", fileName: "MMK-123 (missav) [1080p].mp4",
      total: 1540 * MB, received: 1540 * MB, speed: 0, status: "duplicate", proxy: "direct" },
    { id: "d7", url: "https://example.com/finished.mp4", fileName: "PRED-777 (finished) [1080p].mp4",
      total: 880 * MB, received: 880 * MB, speed: 0, status: "done", proxy: "direct" }
  ];

  let history = [
    { id: "h1", url: "https://example.com/a.mp4", fileName: "JUFE-444 (done) [1080p].mp4", total: 733 * MB,
      endTime: now - 2 * hr, timestamp: now - 2 * hr, status: "done", finalPath: "C:\\Users\\Demo\\Downloads\\DeepGrab\\JUFE-444.mp4" },
    { id: "h2", url: "https://example.com/b.mp4", fileName: "MIAA-555 (done) [720p].mp4", total: 402 * MB,
      endTime: now - 5 * hr, timestamp: now - 5 * hr, status: "done" },
    { id: "h3", url: "https://example.com/c.mp4", fileName: "SVDVD-666 (error) [1080p].mp4", total: 21 * MB,
      endTime: now - 26 * hr, timestamp: now - 26 * hr, status: "error", error: "expired direct link (1.2.9+ auto-refreshes up to 2×)" },
    { id: "h4", url: "https://example.com/d.mp4", fileName: "HMN-777 (cancelled).mp4", total: 190 * MB,
      endTime: now - 30 * hr, timestamp: now - 30 * hr, status: "cancelled" }
  ];

  const settings = {
    downloadDir: "C:\\Users\\Demo\\Downloads\\DeepGrab",
    downloadDir2: "D:\\Downloads",
    downloadDir3: "",
    minFreeMB: 500,
    concurrency: 4,
    segments: 4,
    speedLimitKB: 0,
    maxRetries: 3,
    maxRefresh: 2,
    autoProxy: true,
    saveHistory: true,
    skipDuplicates: true,
    autoCloseTab: false,
    thumbnails: false,
    idleTabMinutes: 0,
    proxies: ["http://127.0.0.1:7890", "socks5://127.0.0.1:1080"],
    proxyRules: [
      { host: "supjav.com", proxy: "http://127.0.0.1:7890" },
      { host: "*.mayzaent.com", proxy: "socks5://127.0.0.1:1080" },
      { host: "go.mnaspm.com", proxy: "direct" }
    ],
    theme: "dark",
    scheduleWindowStart: "",
    scheduleWindowEnd: "",
    autoRetryMinutes: 0,
    autoRetryMax: 5,
    siteRules: []
  };

  // ---- bandwidth ring ---------------------------------------------------
  const RING = 40;
  let bwSamples = [];
  let bwId = 0;
  function bandwidthStats() {
    const running = items.filter((i) => i.status === "running");
    const current = running.reduce((a, i) => a + (i.speed || 0), 0);
    bwSamples.push({ id: bwId++, speed: current });
    if (bwSamples.length > RING) bwSamples.splice(0, bwSamples.length - RING);
    const speeds = bwSamples.map((s) => s.speed);
    const avg = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
    const peak = speeds.length ? Math.max(...speeds) : 0;
    return { current, avg, peak, samples: bwSamples.slice() };
  }

  // ---- event fan-out ----------------------------------------------------
  let updateCb = null, historyCb = null, clipboardCb = null, fileCb = null;
  function emit(batch) { if (updateCb) updateCb(batch); }
  function emitHistory() { if (historyCb) historyCb(); }
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const pushHistory = (item) => {
    history.unshift(clone({ id: "h" + Date.now() + Math.floor(Math.random() * 1e4), url: item.url, fileName: item.fileName,
      total: item.total || item.received, endTime: Date.now(), timestamp: Date.now(), status: item.status,
      error: item.error, finalPath: item.status === "done" ? (item.finalPath || settings.downloadDir + "\\" + item.fileName) : undefined }));
    if (history.length > 50) history.length = 50;
  };

  // ---- live simulation --------------------------------------------------
  let seq = 0;
  setInterval(() => {
    const now = Date.now();
    // automation: scheduled items whose start passed become queued; errored
    // items requeue after autoRetryMinutes (requires-browser is excluded)
    for (const it of items) {
      if (it.status === "scheduled" && it.scheduledStart && now >= new Date(it.scheduledStart).getTime()) {
        it.status = "queued"; it.scheduledStart = null;
      }
      if (it.status === "error" && settings.autoRetryMinutes > 0 && it.errorCategory !== "requires-browser" && !it._autoRetryAt) {
        const max = settings.autoRetryMax || 0;
        if (max > 0 && (it._autoRetries || 0) >= max) {
          it.error = "Auto-retry exhausted after " + (it._autoRetries || 0) + " cycles";
        } else {
          it._autoRetries = (it._autoRetries || 0) + 1;
          it._autoRetryAt = now + settings.autoRetryMinutes * 60000;
        }
      }
      if (it.status === "error" && it._autoRetryAt && now >= it._autoRetryAt) {
        it.status = "queued"; it.error = ""; it.errorCategory = ""; it._autoRetryAt = null;
      }
    }
    // global schedule window: only START new downloads inside the window
    const inWin = windowOpen();
    let runningCount = items.filter((x) => x.status === "running").length;
    for (const it of items) {
      if (it.status !== "queued") continue;
      if (runningCount >= settings.concurrency) break;
      if (!inWin && !it._windowBypass) continue;
      it.status = "running"; it.speed = 2 * MB; runningCount++;
    }
    const batch = [];
    let terminal = false;
    for (const it of items) {
      if (it.status !== "running") continue;
      seq++;
      it.speed = Math.round((2 + Math.random() * 8) * MB); // 2-10 MB/s
      it.received = Math.min(it.total, it.received + it.speed);
      const done = it.received >= it.total;
      if (done) { it.status = "done"; it.speed = 0; pushHistory(it); terminal = true; }
      batch.push(it);
    }
    if (batch.length) emit(batch);
    if (terminal) emitHistory(); // renderer reloads history ~1.5s later
  }, 1000);

  // ---- the mock bridge --------------------------------------------------
  const api = {
    onUpdate: (cb) => { updateCb = cb; },
    onHistoryUpdated: (cb) => { historyCb = cb; },
    onClipboardUrl: (cb) => { clipboardCb = cb; },
    onFileOpened: (cb) => { fileCb = cb; },

    getSettings: async () => clone(settings),
    saveSettings: async (s) => { Object.assign(settings, s); return { ok: true }; },
    list: async () => clone(items),
    history: async () => clone(history),
    bandwidthStats: async () => bandwidthStats(),

    getActiveDir: async () => settings.downloadDir,
    chooseDir: async () => "C:\\Users\\Demo\\Downloads\\Picked",
    openDir: async () => { toast("Opening folder (demo)"); return { ok: true }; },
    showInFolder: async (p) => { toast("Show in folder (demo): " + p); return { ok: true }; },

    moveDownload: async (id, dir) => { toast("Moved to " + dir); return { ok: true }; },
    schedule: async (payload) => {
      const it = items.find((i) => i.id === payload.id);
      if (it) {
        it.scheduledStart = payload.scheduledStart || null;
        it.scheduledStop = payload.scheduledStop || null;
        if (it.scheduledStart || it.scheduledStop) it.status = "scheduled";
        emit([it]);
      }
      return { ok: true };
    },

    pause: async (id) => {
      const it = items.find((i) => i.id === id);
      if (it && (it.status === "running" || it.status === "queued")) { it.status = "paused"; it.speed = 0; emit([it]); }
      return { ok: true };
    },
    resume: async (id) => {
      const it = items.find((i) => i.id === id);
      if (it && (it.status === "paused" || it.status === "error" || it.status === "scheduled" || it.status === "queued")) {
        it.status = "running"; it.speed = 2 * MB; emit([it]);
      }
      return { ok: true };
    },
    cancel: async (id) => {
      const it = items.find((i) => i.id === id);
      if (it && it.status !== "done" && it.status !== "cancelled") {
        it.status = "cancelled"; it.speed = 0; pushHistory(it); emit([it]); emitHistory();
      }
      return { ok: true };
    },
    remove: async (id) => {
      items = items.filter((i) => i.id !== id);
      emit([{ _removed: id }]);
      return { ok: true };
    },
    forceDownload: async (id) => {
      const it = items.find((i) => i.id === id);
      if (it) { it.status = "running"; it.speed = 2 * MB; it.received = 0; emit([it]); }
      return { ok: true };
    },
    retry: async (id) => {
      const it = items.find((x) => x.id === id);
      if (it && it.status === "error") { it.total = it.total || Math.round((30 + Math.random() * 900) * MB); it.status = "running"; it.error = ""; it.errorCategory = ""; it._autoRetryAt = null; it._autoRetries = 0; it.speed = 2 * MB; emit([it]); }
      return { ok: true };
    },
    pauseAll: async () => {
      let n = 0;
      for (const it of items) {
        if (it.status === "running" || it.status === "queued" || it.status === "scheduled") { it.status = "paused"; it.speed = 0; n++; }
      }
      if (n) emit(items.filter((x) => x.status === "paused"));
      return { ok: true, count: n };
    },
    resumeAll: async () => {
      let n = 0;
      for (const it of items) {
        if (it.status === "paused") { it.status = "queued"; it.speed = 0; n++; }
      }
      if (n) emit(items.filter((x) => x.status === "queued"));
      return { ok: true, count: n };
    },
    retryFailed: async () => {
      let n = 0;
      for (const it of items) {
        if (it.status === "error" && it.errorCategory !== "requires-browser") {
          it.total = it.total || Math.round((30 + Math.random() * 900) * MB); it.status = "running"; it.error = ""; it.errorCategory = ""; it._autoRetryAt = null; it._autoRetries = 0; it.speed = 2 * MB; n++;
        }
      }
      if (n) emit(items.filter((x) => x.status === "running"));
      return { ok: true, count: n };
    },
    resumeLast: async () => {
      const last = history.find((h) => h.status === "done");
      if (!last) return { ok: true, id: null };
      const it = { id: "d" + Date.now(), url: last.url, fileName: last.fileName, total: last.total,
        received: 0, speed: 2 * MB, status: "running", proxy: "direct" };
      items.unshift(it); emit([it]);
      return { ok: true, id: it.id };
    },
    clearHistory: async () => { history = []; return { ok: true }; },

    add: async (url, dirOverride) => { enqueue([url]); return { ok: true }; },
    addMany: async (urls) => { enqueue(urls); return { ok: true, count: urls.length }; },

    openBrowser: async () => { toast("Built-in browser would open here (demo)"); return { ok: true }; },
    openExternal: async (url, browser) => { toast("Opened in " + browser + " (demo): " + url); return { ok: true }; },
    installExtension: async (target) => { toast("Deep Grab launched in " + target + " on a dedicated profile (demo)"); return { ok: true, browser: target }; },
    testProxies: async (url) => settings.proxies.map((p, i) => ({ proxy: p, ms: i === 0 ? 96 : 183 })),
    exportHistory: async (fmt) => { toast("Exported " + history.length + " history entries as " + fmt.toUpperCase() + " (demo)"); return { ok: true }; }
  };

  // Mirror the real app per-host proxy assignment (proxy.js pickBest): with
  // autoProxy OFF every download is direct; ON, the first matching proxyRules
  // entry wins (exact, "*.suffix", glob, or "/regex/" pattern, case-insensitive;
  // an explicit "direct" rule wins too), and with no rule the pool first proxy
  // stands in for latency testing.
  // Global schedule window mirror (real app: DownloadManager._inScheduleWindow)
  function windowOpen(now) {
    const s = settings.scheduleWindowStart, e = settings.scheduleWindowEnd;
    if (!s || !e) return true;
    const mins = (t) => { const p = String(t).split(":").map(Number); return p[0] * 60 + p[1]; };
    const d = now || new Date();
    const nm = d.getHours() * 60 + d.getMinutes();
    const sm = mins(s), em = mins(e);
    return sm <= em ? (nm >= sm && nm < em) : (nm >= sm || nm < em);
  }

  // Per-site automation rule for a URL host (exact or *.suffix)
  function siteRuleFor(url) {
    let host = "";
    const u = String(url || "");
    const at = u.indexOf("://");
    if (at > 0) {
      const rest = u.slice(at + 3);
      host = rest.split("/")[0].split("?")[0].split("#")[0].split(":")[0].toLowerCase();
    }
    for (const r of settings.siteRules || []) {
      const pat = String(r.host || "").trim().toLowerCase();
      if (!pat) continue;
      if (pat.startsWith("*.")) { if (host.endsWith(pat.slice(1))) return r; }
      else if (host === pat) return r;
    }
    return null;
  }

  function proxyFor(url) {
    if (!settings.autoProxy) return "direct";
    let host = "";
    const u = String(url || "");
    const at = u.indexOf("://");
    if (at > 0) {
      const rest = u.slice(at + 3);
      host = rest.split("/")[0].split("?")[0].split("#")[0].split(":")[0].toLowerCase();
    }
    if (!host) return "direct";
    for (const r of settings.proxyRules || []) {
      const pat = String(r.host || "").trim().toLowerCase();
      if (!pat) continue;
      let match = false;
      if (pat.length > 1 && pat.startsWith("/") && pat.endsWith("/")) {
        try { match = new RegExp(pat.slice(1, -1), "i").test(host); } catch (e) { match = false; }
      } else if (pat.startsWith("*.") && !pat.slice(2).includes("*")) {
        const suffix = pat.slice(1);
        match = host === suffix.slice(1) || host.endsWith(suffix);
      } else if (pat.includes("*")) {
        const segs = pat.split("*");
        match = host.startsWith(segs[0]);
        let rest = host.slice(segs[0].length);
        for (let k = 1; match && k < segs.length; k++) {
          const idx = rest.indexOf(segs[k]);
          if (idx === -1) match = false;
          else rest = rest.slice(idx + segs[k].length);
        }
      } else {
        match = host === pat;
      }
      if (match) return r.proxy;
    }
    const pool = (settings.proxies || []).filter((p) => typeof p === "string" && p.trim());
    return pool.length ? pool[0] : "direct";
  }

  function enqueue(urls) {
    for (const raw of urls) {
      const u = String(raw);
      const name = decodeURIComponent((u.split("/").pop() || "download").split("?")[0]) || "download";
      const rule = siteRuleFor(u);
      const inWin = windowOpen();
      const startNow = items.filter((x) => x.status === "running").length < settings.concurrency && (inWin || (rule && rule.start));
      items.unshift({ id: "d" + Date.now() + Math.floor(Math.random() * 1e4), url: u,
        fileName: /\.(mp4|mkv|m3u8|ts|webm)$/i.test(name) ? name : name + ".mp4",
        total: Math.round((30 + Math.random() * 900) * MB), received: 0, speed: 0,
        status: startNow ? "running" : "queued",
        dirOverride: rule && rule.folder ? rule.folder : null,
        _windowBypass: !!(rule && rule.start),
        proxy: proxyFor(u) });
    }
    emit(clone(items.slice(0, urls.length)));
  }

  function toast(msg) {
    try {
      if (typeof window.showToast === "function") {
        window.showToast("🧪 Demo: " + msg, [{ label: "Dismiss", className: "btn ghost", onClick: () => {} }]);
        return;
      }
    } catch (e) { /* showToast not ready yet */ }
    console.log("Demo: " + msg);
  }

  // Renderer.js calls alert()/confirm()/prompt() in several flows; native
  // dialogs would block the preview. Route them to toasts/defaults instead.
  window.alert = (m) => { try { toast(m); } catch (e) { console.log("alert:", m); } };
  window.confirm = () => true;
  window.prompt = () => null;

  // expose for the live demo: clipboard/file-open events can be fired manually
  window.__demo = {
    api,
    fireClipboard: (url) => { if (clipboardCb) clipboardCb({ url }); },
    fireFileOpened: (path, name) => { if (fileCb) fileCb({ path, name }); },
    get state() { return { items: items.map((i) => ({ id: i.id, status: i.status, received: i.received })), history: history.length }; }
  };

  window.api = api;
})();
