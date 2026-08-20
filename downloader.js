// Download engine: queue, segmented (multi-connection) downloads with proxy
// rotation, pause / resume / cancel, global speed limit, scheduling, history,
// thumbnails, and bandwidth stats. Helper modules live in lib/ (errors, http,
// hls, names, resolvers); this file re-exports the public API so consumers
// (main.js, test files) keep requiring "./downloader".

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const { pipeline } = require("stream/promises");
const { createWriteStream, createReadStream } = fs;
const { once } = require("events");
const { URL } = require("url");

const { isExpiredError, isProxyFailure, isRateLimited, isCloudflareBlocked, categorizeError } = require("./lib/errors");
const { requestWithRedirects, fetchHtml, delay, contentRangeStart, contentRangeTotal, DEFAULT_MAX_RETRIES } = require("./lib/http");
const { HLS_MASTER_RE, isHlsUrl, parseHlsPlaylist, pickHlsVariant, stripPngPrefix } = require("./lib/hls");
const { sanitizeName, titleFromReferer } = require("./lib/names");
const { SJ_PLAYER_RE, resolveUrl, resolveStreamtape, resolveSupjav, resolveCnPorn, resolveXVideos, resolveXHamster } = require("./lib/resolvers");

const PART_EXT = ".part";
const PROGRESS_INTERVAL = 300;
const DEFAULT_HLS_CONCURRENCY = 4;
const MAX_REFRESH = 2;

// A signed get_video link (streamtape/fstape) bakes an expiry+token into the
// embed page HTML and dies with 403/410 when it lapses. The only way to get a
// fresh one is to re-fetch the embed page, so refresh against the referer.
// The same applies to cnporn m3u8 playlists (their .ts segments are signed
// tiktokcdn URLs that lapse) and supjav/turbovidhls m3u8 (also signed
// tiktokcdn segments): re-resolve the source page for a fresh playlist.
function isSignedRefreshable(item) {
  const u = item.url || "";
  const ref = item.referer || "";
  return (
    /get_video\?/i.test(u) && /(?:streamtape|fstape)\.com/i.test(ref)
  ) || (
    /\.m3u8([?#]|$)/i.test(u) && /cnporn\.org/i.test(ref)
  ) || (
    /\.m3u8([?#]|$)/i.test(u) && SJ_PLAYER_RE.test(ref)
  );
}

function refreshSourceUrl(item) {
  return isSignedRefreshable(item) ? item.referer : item.url;
}

class DownloadManager {
  constructor({ config, proxyManager, onUpdate }) {
    this.config = config;
    this.proxyManager = proxyManager;
    this.onUpdate = onUpdate || (() => {});
    this.items = new Map();
    this.active = 0;
    this._id = 0;
    this.history = [];
    this._pending = [];       // bulk-import URLs waiting to be loaded into items
    this._downloaded = new Set(); // URLs that reached "done" (for duplicate handling)
    this._hostLast = new Map();   // hostname -> last request time (per-host pacing)
    this._paceChains = new Map(); // hostname -> promise chain serializing _paceHost callers
    this._persistTimer = null;    // debounced writer for history/downloaded.json
    this._speedBytes = 0;
    this._speedStart = Date.now();
    this._connBusy = 0;           // in-flight segmented connections
    this._connWaiters = [];       // semaphore waiters for the global conn cap
    this._loadHistory();
    this._loadDownloaded();
    this._sweepOrphanTempDirs();
  }

  list() {
    return Array.from(this.items.values()).map((i) => i.public());
  }

  listHistory() {
    return this.history.map((i) => ({
      ...i,
      status: i.status,
      timestamp: i.timestamp
    }));
  }

  exportHistory(format = "json") {
    if (format === "csv") {
      const csv = [
        "ID,File,Size,Status,Started,Completed,Duration(s)",
        ...this.history.map((h) =>
          [h.id, `"${h.fileName}"`, h.total, h.status,
           new Date(h.timestamp).toISOString(),
           h.endTime ? new Date(h.endTime).toISOString() : "",
           h.endTime ? Math.round((h.endTime - h.timestamp) / 1000) : ""
          ].join(",")
        )
      ];
      return csv.join("\n");
    }
    return JSON.stringify(this.history, null, 2);
  }

  _loadHistory() {
    try {
      const data = fs.readFileSync(this.historyPath, "utf8");
      this.history = JSON.parse(data);
    } catch (e) {
      this.history = [];
    }
  }

  // Remove orphaned segmented/HLS temp dirs (dl-*) left behind when the app was
  // killed mid-run (taskkill /F, crash). Paused state doesn't survive a restart,
  // so any pre-existing dl-* dir is dead weight; only ids still in the active
  // map are protected (impossible at startup, but the guard keeps a re-run safe).
  async _sweepOrphanTempDirs() {
    try {
      const root = this.dir;
      const entries = await fsp.readdir(root, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory() || !/^dl-\d+-\d+$/.test(e.name)) continue;
        if (this.items.has(e.name)) continue;
        await fsp.rm(path.join(root, e.name), { recursive: true, force: true }).catch(() => {});
      }
    } catch (e) { /* sweep is best-effort */ }
  }

  _saveHistoryNow() {
    if (this.config.saveHistory === false) return; // history persistence toggle
    try {
      fsp.writeFile(this.historyPath, JSON.stringify(this.history, null, 2), "utf8").catch(() => {});
    } catch (e) { /* ignore */ }
  }

  _saveDownloadedNow() {
    try {
      fsp.writeFile(this.downloadedPath, JSON.stringify(Array.from(this._downloaded), null, 0), "utf8").catch(() => {});
    } catch (e) { /* ignore */ }
  }

  // Debounced persistence: coalesce the many per-completion history/downloaded
  // writes during a bulk run into one disk write every ~500ms.
  _persistSoon() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._saveHistoryNow();
      this._saveDownloadedNow();
    }, 500);
  }

  _saveHistory() {
    this._persistSoon();
  }

  getBandwidthStats() {
    const allItems = Array.from(this.items.values()).concat(this.history);
    const speeds = allItems
      .filter((i) => i._samples && i._samples.length > 0)
      .flatMap((i) => i._samples);

    if (!speeds.length) {
      return { current: 0, avg: 0, peak: 0, count: 0, samples: [] };
    }

    const valid = speeds.filter((s) => s.speed > 0);
    const latest = valid.length ? valid.reduce((a, b) => (b.time > a.time ? b : a)) : null;
    const current = latest ? latest.speed : 0;
    const avg = Math.round(valid.reduce((a, s) => a + s.speed, 0) / valid.length);
    const peak = Math.max(...valid.map((s) => s.speed));

    return {
      current,
      avg,
      peak,
      count: valid.length,
      samples: valid.slice(-60).map((s) => ({ time: s.time, speed: s.speed }))
    };
  }

  // Fallback chain: primary -> downloadDir2 -> downloadDir3. Walks the folders
  // in order and uses the first whose drive has >= minFreeMB free (or the last
  // one regardless), so downloads (and their history/downloaded.json) land in
  // the first folder that can take them.
  _activeDirSync() {
    const primary = this.config.downloadDir || path.join(os.homedir(), "Downloads", "DeepGrab");
    const dirs = [primary, this.config.downloadDir2, this.config.downloadDir3].filter(Boolean);
    for (let i = 0; i < dirs.length; i++) {
      const dir = dirs[i];
      let free = Infinity;
      try { const s = fs.statfsSync(dir); free = (s.bavail * s.bsize) / (1024 * 1024); } catch (e) { free = Infinity; }
      const isLast = i === dirs.length - 1;
      if (isLast || free >= (this.config.minFreeMB || 500)) {
        try { fs.mkdirSync(dir, { recursive: true }); return dir; } catch (e) { /* try next */ }
      }
    }
    return primary;
  }

  get dir() {
    return this._activeDirSync();
  }

  get historyPath() {
    return path.join(this.dir, "history.json");
  }

  get downloadedPath() {
    return path.join(this.dir, "downloaded.json");
  }

  _loadDownloaded() {
    try {
      const data = JSON.parse(fs.readFileSync(this.downloadedPath, "utf8"));
      if (Array.isArray(data)) this._downloaded = new Set(data);
    } catch (e) {
      this._downloaded = new Set();
    }
  }

  _saveDownloaded() {
    this._persistSoon();
  }

  // Write any pending history/downloaded changes immediately (e.g. on quit).
  // Synchronous so a graceful quit deterministically persists the latest
  // state before teardown (a pending debounce timer otherwise loses <500ms).
  flush() {
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    try {
      if (this.config.saveHistory !== false) {
        fs.writeFileSync(this.historyPath, JSON.stringify(this.history, null, 2), "utf8");
      }
    } catch (e) { /* ignore */ }
    try {
      fs.writeFileSync(this.downloadedPath, JSON.stringify(Array.from(this._downloaded), null, 0), "utf8");
    } catch (e) { /* ignore */ }
  }

  isDownloaded(url) {
    return this._downloaded.has(String(url || ""));
  }

  _markDownloaded(url) {
    this._downloaded.add(String(url || ""));
    this._saveDownloaded();
  }

  // Move a terminal item to history (frees its slot for the windowed loader).
  _toHistory(item) {
    const histEntry = {
      id: item.id,
      url: item.url,
      title: item.title,
      referer: item.referer,
      fileName: item.fileName,
      total: item.total,
      received: item.received,
      status: item.status,
      error: item.error,
      finalPath: item.finalPath || "",
      thumb: item.thumb || "",
      timestamp: Date.now(),
      endTime: Date.now(),
      _samples: item._samples.slice(-120)
    };
    this.history.push(histEntry);
    const cap = this.config.maxHistory || 500;
    if (this.history.length > cap) this.history = this.history.slice(-cap);
    this._saveHistory();
    this.items.delete(item.id);
    if (item.tempDir) fsp.rm(item.tempDir, { recursive: true, force: true }).catch(() => {});
    this.onUpdate({ _removed: item.id });
    this.refill();
  }

  // On a terminal state: record dedupe, auto-move to history when running a
  // bulk/windowed import (or when the active map grows large), then refill.
  _maybeFinalize(item) {
    if (!item) return;
    if (item.status === "done") this._markDownloaded(item.url);
    const trim =
      (this._pending && this._pending.length > 0) ||
      this.items.size > (this.config.autoTrimAt || 500);
    if (trim) this._toHistory(item);
    else this.refill();
  }

  // Windowed loader: pull queued URLs from the pending list into the active
  // map up to the live cap, so bulk imports stay memory-bounded.
  refill() {
    if (!this._pending || !this._pending.length) return;
    const cap = this.config.liveWindow || (this.config.concurrency || 3) * 4;
    while (this._pending.length && this.items.size < cap) {
      const u = this._pending.shift();
      if (!u) continue;
      // Bulk imports skip already-downloaded URLs silently (no duplicate rows).
      this.enqueue({ url: u, title: "", referer: "", markDuplicate: false }).catch(() => {});
    }
  }

  // Re-download a "duplicate" entry the user explicitly wants anyway.
  forceDownload(id) {
    const item = this.items.get(id);
    if (!item) return false;
    if (item.status === "duplicate") {
      item.duplicate = false;
      item.status = "queued";
      item.error = "";
      item.speed = 0;
      item.lastEmit = Date.now();
      item._lastBytes = item.received;
      this.emit(item);
      this.pump();
      return true;
    }
    return false;
  }

  // Enqueue a whole batch without materializing all of them at once.
  addPending(urls) {
    let added = 0;
    for (const u of urls) {
      const s = typeof u === "string" ? u.trim() : "";
      if (!s) continue;
      this._pending.push(s);
      added++;
    }
    this.refill();
    return added;
  }

  _hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return null; }
  }

  // Per-host pacing: keep a minimum interval between requests to the same host
  // so bulk downloads don't trip Cloudflare rate limits / IP bans. Serialized
  // per host via _paceChains: concurrent callers chain onto the previous
  // caller's granted slot (which sets _hostLast before releasing), so they fire
  // in sequence instead of reading a stale _hostLast and bursting together.
  async _paceHost(url, cooldownMs) {
    const host = this._hostOf(url);
    if (!host) return;
    const min = cooldownMs || this.config.hostDelayMs || 120;
    const prev = this._paceChains.get(host) || Promise.resolve();
    let grant;
    const slot = new Promise((r) => { grant = r; });
    // The chain always resolves so a (never-rejecting) failure can't poison it.
    this._paceChains.set(host, prev.then(() => slot, () => slot));
    await prev.catch(() => {});
    const last = this._hostLast.get(host) || 0;
    const wait = min - (Date.now() - last);
    if (wait > 0) await delay(wait);
    this._hostLast.set(host, Date.now());
    grant();
  }

  async enqueue({ url, title, referer, resolvedUrl = null, scheduledStart = null, scheduledStop = null, label = "", force = false, markDuplicate = true }) {
    // Duplicate handling: an already-downloaded URL becomes a "duplicate" list
    // entry (so the user can "Download anyway"), unless the bulk/windowed path
    // opts out with markDuplicate:false (skip silently — no item to avoid bloat).
    const isDup = !force && this.config.skipDuplicates !== false && this.isDownloaded(url);
    if (isDup && markDuplicate === false) return null;
    const id = "dl-" + (++this._id) + "-" + Date.now();
    // Schedule times arrive as ISO strings / Date objects / ms numbers
    // (renderer, WS, tests). Normalize to numeric ms so the pump() and
    // checkScheduled() `Date.now() >= item.scheduledX` comparisons work.
    const normTs = (v) => (v == null || v === "" ? null : new Date(v).getTime());
    // Fall back to the streamtape/fstape URL slug when the sender gave no title.
    const effectiveTitle = title || titleFromReferer(referer);
    const hls = isHlsUrl(url) || (resolvedUrl && isHlsUrl(resolvedUrl));
    // Resolution is deferred to _runOnce so callers get an id immediately and
    // the WS `accepted` reply never blocks on slow resolver page fetches.
    const item = {
      _resolvedUrl: resolvedUrl,
      id,
      url,
      title: effectiveTitle,
      referer,
      label,
      kind: hls ? "hls" : "mp4",
      fileName: sanitizeName(effectiveTitle) + (label ? "[" + sanitizeName(label) + "]" : "") + ".mp4",
      status: "queued",
      total: 0,
      received: 0,
      speed: 0,
      proxy: "",
      error: "",
      tempDir: "",
      finalPath: "",
      scheduledStart: normTs(scheduledStart),
      scheduledStop: normTs(scheduledStop),
      lastEmit: 0,
      _lastBytes: 0,
      _pathCreated: false, // true once finalPath was created this run (dedupe-rename guard)
      _proxy: null,
      refreshCount: 0,
      errorCategory: "",
      duplicate: false,
      _activeRes: new Set(),
      _samples: [],
      public() {
        return {
          id: this.id,
          url: this.url,
          referer: this.referer,
          title: this.title,
          label: this.label || "",
          kind: this.kind || "mp4",
          fileName: this.fileName,
          status: this.status,
          duplicate: !!this.duplicate,
          total: this.total,
          received: this.received,
          speed: this.speed,
          proxy: this.proxy,
          error: this.error,
          errorCategory: this.errorCategory,
          refreshCount: this.refreshCount,
          finalPath: this.finalPath,
          thumb: this.thumb || "",
          scheduledStart: this.scheduledStart,
          scheduledStop: this.scheduledStop,
          samples: this._samples.slice(-120).map((s) => ({ time: s.time, speed: s.speed }))
        };
      }
    };
    this.items.set(id, item);
    this.emit(item);
    if (isDup) {
      // Already downloaded — show it in the list but don't auto-download.
      item.status = "duplicate";
      item.duplicate = true;
      this.emit(item);
      return id;
    }
    if (item.scheduledStart && Date.now() < item.scheduledStart) {
      item.status = "scheduled";
      this.emit(item);
    }
    this.pump();
    if (item.scheduledStart || item.scheduledStop) {
      this.checkScheduled();
    }
    return id;
  }

  async pump() {
    while (this.active < (this.config.concurrency || 3)) {
      const next = Array.from(this.items.values()).find((i) => i.status === "queued" && !i._running);
      if (!next) break;
      if (next.scheduledStart && Date.now() < next.scheduledStart) {
        next.status = "scheduled";
        this.emit(next);
        continue;
      }
      next.status = "running";
      this.active++;
      this.emit(next);
      this.run(next)
        .catch((err) => {
          if (err.aborted || next.status === "paused" || next.status === "cancelled") return;
          next.status = "error";
          next.error = err.message || String(err);
          next.errorCategory = categorizeError(err);
          next.speed = 0;
          this.emit(next);
          this._maybeFinalize(next);
        })
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  checkScheduled() {
    const now = Date.now();
    const due = Array.from(this.items.values()).filter((i) => i.status === "scheduled" && now >= (i.scheduledStart || 0));
    if (due.length) {
      due.forEach((i) => {
        // Whole start..stop window already elapsed — pause instead of starting.
        if (i.scheduledStop && now >= i.scheduledStop) { this.pause(i.id); return; }
        i.status = "queued"; this.emit(i);
      });
      this.pump();
    }
    // Stop-time enforcement: pause running/queued downloads whose stop time passed.
    const stopDue = Array.from(this.items.values()).filter(
      (i) => i.scheduledStop && now >= i.scheduledStop && (i.status === "running" || i.status === "queued")
    );
    if (stopDue.length) stopDue.forEach((i) => this.pause(i.id));
    // Keep a sweep alive while anything is still scheduled or has a future
    // start/stop time — wake just before the earliest event so both fire on time.
    const scheduledStarts = Array.from(this.items.values())
      .filter((i) => i.status === "scheduled" && (i.scheduledStart || 0) > now)
      .map((i) => i.scheduledStart);
    const nextStart = scheduledStarts.reduce((a, b) => Math.min(a, b), Infinity);
    const nextStop = Array.from(this.items.values())
      .filter((i) => i.scheduledStop && i.scheduledStop > now && ["running", "queued", "scheduled"].includes(i.status))
      .map((i) => i.scheduledStop)
      .reduce((a, b) => Math.min(a, b), Infinity);
    const nextEvent = Math.min(nextStart, nextStop);
    clearTimeout(this._scheduleTimer);
    this._scheduleTimer = null;
    if (Number.isFinite(nextEvent)) {
      const wait = Math.min(30000, Math.max(500, nextEvent - now));
      this._scheduleTimer = setTimeout(() => this.checkScheduled(), wait);
    }
  }

  async throttle(bytes) {
    const rate = (this.config.speedLimitKB || 0) * 1024;
    if (!rate) return;
    this._speedBytes += bytes;
    const now = Date.now();
    const expectedMs = (this._speedBytes / rate) * 1000;
    const sleep = Math.max(0, expectedMs - (now - this._speedStart));
    if (sleep > 0) await delay(Math.min(sleep, 500));
    if (now - this._speedStart >= 1000) {
      this._speedBytes = 0;
      this._speedStart = Date.now();
    }
  }

  tick(item, chunkLen) {
    item.received += chunkLen;
    const now = Date.now();
    if (now - item.lastEmit >= PROGRESS_INTERVAL) {
      const dt = (now - item.lastEmit) / 1000 || 0.3;
      item.speed = Math.max(0, Math.round((item.received - item._lastBytes) / dt));
      item._lastBytes = item.received;
      item.lastEmit = now;
      if (item.speed > 0) {
        item._samples.push({ time: now, speed: item.speed });
        if (item._samples.length > 120) item._samples = item._samples.slice(-120);
      }
      this.emit(item);
    }
  }

  emit(item) {
    this.onUpdate(item.public());
  }

  // ---------------- main flow ----------------
  async run(item) {
    if (item._running) return; // already being processed (guards resume-during-probe)
    item._running = true;
    try {
      await this._runGuarded(item);
    } finally {
      item._running = false;
    }
  }

  async _runGuarded(item) {
    const baseHeaders = item.referer ? { Referer: item.referer } : {};
    const maxRefresh = this.config.maxRefresh ?? MAX_REFRESH;

    for (let attempt = 0; ; attempt++) {
      try {
        await this._runOnce(item, baseHeaders);
        break;
      } catch (err) {
        if (err.aborted || attempt >= maxRefresh) throw err;
        // Rate-limited / Cloudflare-blocked: rotate proxy, back off, and retry
        // the same URL — the video isn't dead and re-resolving the (also blocked)
        // source page would just waste requests.
        if (isRateLimited(err) || isCloudflareBlocked(err)) {
          if (this.proxyManager && item._proxy) this.proxyManager.markBad(item._proxy);
          item._proxy = null;
          await delay(1500 * (attempt + 1));
          item.error = "";
          item.status = "running";
          this.emit(item);
          continue;
        }
        // Expired direct URL (e.g. streamtape signed token) — re-resolve the
        // original page and retry from scratch with the fresh URL.
        if (!isExpiredError(err)) throw err;
        // A bare HTTP 403/404/410 can mean the *proxy* is Cloudflare-blocked
        // (no cf-chl text in the message) rather than a dead URL. Rotate + clear
        // so the retry re-picks instead of hammering the same blocked proxy
        // through every refresh cycle. A genuinely expired URL fails regardless.
        if (item._proxy && this.proxyManager) this.proxyManager.markBad(item._proxy);
        item._proxy = null;
        // get_video links are passed through (resolved === original), so the
        // usual "resolved differs from url" test can't gate them; a signed link
        // with a streamtape/fstape referer is still refreshable — from the page.
        const refreshable =
          (item._resolvedUrl && item._resolvedUrl !== item.url) || isSignedRefreshable(item);
        if (!refreshable) throw err;
        let fresh = null;
        try {
          fresh = await resolveUrl(refreshSourceUrl(item), { proxyManager: this.proxyManager, config: this.config, paceHost: (u) => this._paceHost(u) }, baseHeaders);
        } catch (e) { /* re-resolution failed — keep original error */ }
        if (!fresh || fresh === item._resolvedUrl) throw err;
        item._resolvedUrl = fresh;
        await fsp.rm(item.tempDir, { recursive: true, force: true }).catch(() => {});
        await fsp.rm(item.finalPath, { force: true }).catch(() => {});
        item.received = 0;
        item._lastBytes = 0;
        item.error = "";
        item.errorCategory = "";
        item.refreshCount = (item.refreshCount || 0) + 1;
        item.status = "running";
        this.emit(item);
      }
    }
  }

  async _runOnce(item, baseHeaders) {
    if (item.status !== "running") {
      const err = new Error("Aborted");
      err.aborted = true;
      throw err;
    }

    // resolve lazily (deferred from enqueue); can take seconds via proxies
    if (!item._resolvedUrl) {
      const r = await resolveUrl(item.url, { proxyManager: this.proxyManager, config: this.config, paceHost: (u) => this._paceHost(u) }, baseHeaders);
      if (r) item._resolvedUrl = r;
      if (item.status !== "running") {
        const err = new Error("Aborted");
        err.aborted = true;
        throw err;
      }
    }

    await fsp.mkdir(this.dir, { recursive: true });
    item.tempDir = path.join(this.dir, item.id);
    await fsp.mkdir(item.tempDir, { recursive: true });
    item.finalPath = path.join(this.dir, item.fileName);
    if (fs.existsSync(item.finalPath) && !item.received) {
      const now = new Date();
      item.fileName = sanitizeName(item.title) + (item.label ? "[" + sanitizeName(item.label) + "]" : "") + "_" + now.getTime() + ".mp4";
      item.finalPath = path.join(this.dir, item.fileName);
    }

    const actualUrl = item._resolvedUrl || item.url;

    // Cloudflare/anti-bot pacing: don't hammer a single host with back-to-back requests.
    await this._paceHost(actualUrl);

    if (item.kind === "hls" || isHlsUrl(actualUrl)) {
      item.kind = "hls";
      item.total = 0; // playlist has no byte size — indeterminate progress
      this.emit(item);
      await this.runHls(item, baseHeaders, actualUrl);
    } else {
      const info = await this.probe(item, baseHeaders, actualUrl);
      item.total = info.length;
      this.emit(item);

      // probe can take seconds (proxy latency tests); bail if paused/cancelled meanwhile
      if (item.status !== "running") {
        const err = new Error("Aborted");
        err.aborted = true;
        throw err;
      }

      if (item.total > 2 * 1024 * 1024 && info.acceptRanges && (this.config.segments || 1) > 1) {
        try {
          await this.runSegmented(item, info, baseHeaders);
        } catch (err) {
          if (err.category !== "norange") throw err;
          // Server ignored Range (HTTP 200 full body); a truncated part merge
          // would be corrupt. Kill in-flight segments, drop the partials, and
          // fall back to a single stream from byte 0.
          this.abort(item);
          await fsp.rm(item.tempDir, { recursive: true, force: true }).catch(() => {});
          await fsp.rm(item.finalPath, { force: true }).catch(() => {});
          item.received = 0;
          item._lastBytes = 0;
          await this.runSingle(item, info, baseHeaders);
        }
      } else {
        await this.runSingle(item, info, baseHeaders);
      }
    }

    const stat = await fsp.stat(item.finalPath);
    if (item.total && stat.size !== item.total) {
      throw new Error(`Size mismatch: got ${stat.size}, expected ${item.total}`);
    }
    await fsp.rm(item.tempDir, { recursive: true, force: true }).catch(() => {});
    item.status = "done";
    item.speed = 0;
    this.emit(item);
    // Best-effort preview frame (needs ffmpeg; never fails the download).
    try {
      item.thumb = await this.makeThumb(item);
      if (item.thumb) this.emit(item);
    } catch (e) { /* thumbnails are optional */ }
    this._maybeFinalize(item);
  }

  async probe(item, baseHeaders, actualUrl) {
    let proxy = null;
    if (this.config.autoProxy) {
      proxy = item._proxy || null;
      if (!proxy) {
        proxy = await this.proxyManager.pickBest(actualUrl, 6000);
        item._proxy = proxy;
      }
    }
    item.proxy = proxy ? proxy.url : "direct";
    const agent = proxy ? this.proxyManager.agentFor(proxy, actualUrl) : null;
    let result = await requestWithRedirects(actualUrl || item.url, {
      method: "HEAD",
      headers: { ...baseHeaders, Range: "bytes=0-0" },
      agent,
      onReq: (req, on) => this._trackReq(item, req, on)
    });
    // Some servers reject HEAD outright (405/501). Fall back to a ranged GET and
    // read only the headers — the tiny body is destroyed, never written to disk.
    if (result.status === 405 || result.status === 501) {
      try { result.res.resume(); } catch (e) { /* ignore */ }
      result = await requestWithRedirects(actualUrl || item.url, {
        method: "GET",
        headers: { ...baseHeaders, Range: "bytes=0-0" },
        agent,
        onReq: (req, on) => this._trackReq(item, req, on)
      });
      try { result.res.destroy(); } catch (e) { /* ignore */ }
    }
    const cr = contentRangeTotal(result.headers["content-range"]);
    const length = cr != null ? cr : parseInt(result.headers["content-length"] || "0", 10);
    return {
      finalUrl: result.finalUrl,
      length: Number.isFinite(length) ? length : 0,
      acceptRanges: (result.headers["accept-ranges"] || "").toLowerCase() === "bytes"
    };
  }

  // ---------------- segmented ----------------
  async runSegmented(item, info, baseHeaders) {
    const n = Math.max(2, this.config.segments || 4);
    const partSize = Math.ceil(info.length / n);
    const segments = [];
    for (let i = 0; i < n; i++) {
      const start = i * partSize;
      const end = Math.min(info.length - 1, start + partSize - 1);
      if (start > info.length - 1) break;
      segments.push({ start, end, partPath: path.join(item.tempDir, `part${i}` + PART_EXT) });
    }

    const queue = [...segments];
    const limit = Math.max(1, Math.min(segments.length, this.config.concurrency || 3));
    const workers = Array.from({ length: limit }, async () => {
      while (queue.length) {
        const seg = queue.shift();
        // Global cap across *all* active downloads: a 3-download × 4-segment
        // run must not open 12 connections at once. Semaphore limit is the max
        // of concurrency and per-file segment count so one file's workers don't
        // deadlock waiting on slots another file holds.
        await this._withConnSlot(() => this.downloadSegment(item, seg, baseHeaders));
      }
    });
    try {
      await Promise.all(workers);
    } catch (err) {
      // A segment failed terminally — abort sibling workers so they don't keep
      // streaming into the temp dir while the item is retried or finalized.
      this.abort(item);
      throw err;
    }

    const out = createWriteStream(item.finalPath);
    for (const seg of segments) {
      await pipeline(createReadStream(seg.partPath), out, { end: false });
    }
    await new Promise((resolve, reject) => {
      out.end((err) => (err ? reject(err) : resolve()));
    });
  }

  async downloadSegment(item, seg, baseHeaders, attempt = 0) {
    const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES;
    const actualUrl = item._resolvedUrl || item.url;
    let proxy = item._proxy || null;
    if (this.config.autoProxy && !proxy) {
      proxy = await this.proxyManager.pickBest(actualUrl, 5000);
      item._proxy = proxy;
    }
    const agent = proxy ? this.proxyManager.agentFor(proxy, actualUrl) : null;
    try {
      const existing = await fsp.stat(seg.partPath).catch(() => null);
      const resumeStart = seg.start + (existing ? existing.size : 0);
      const headers = { ...baseHeaders, Range: `bytes=${resumeStart}-${seg.end}` };

      const result = await requestWithRedirects(actualUrl, { method: "GET", headers, agent, maxRetries, onReq: (req, on) => this._trackReq(item, req, on) });
      const res = result.res;
      const status = result.status;
      if (status !== 206 && status !== 200) {
        res.resume();
        const err = new Error("Segment failed: HTTP " + status);
        err.status = status;
        err.category = "http";
        throw err;
      }
      if (status === 200) {
        // Server ignored Range and restarted at byte 0 — a truncated part would
        // silently corrupt the merge. Signal the fallback to a single stream.
        res.resume();
        const err = new Error("Server ignored Range (HTTP 200) — falling back to single stream");
        err.category = "norange";
        throw err;
      }

      let mode = "w";
      if (resumeStart > seg.start) {
        const start = contentRangeStart(result.headers["content-range"]);
        if (start != null && start !== resumeStart) {
          res.resume();
          await fsp.rm(seg.partPath, { force: true }).catch(() => {});
          const err = new Error("Segment range mismatch: server sent " + start + ", expected " + resumeStart);
          err.category = "resume";
          throw err;
        }
        mode = "a";
      }
      await this.streamToFile(item, res, seg.partPath, mode);
    } catch (err) {
      if (attempt < 1) {
        if (isProxyFailure(err) && proxy) {
          this.proxyManager.markBad(proxy);
          item._proxy = null;
          return this.downloadSegment(item, seg, baseHeaders, attempt + 1);
        }
        if (err.category === "resume") {
          return this.downloadSegment(item, seg, baseHeaders, attempt + 1);
        }
      }
      throw err;
    }
  }

  // ---------------- single stream ----------------
  // Global cap on concurrent segment connections across ALL active downloads
  // (see runSegmented). Semaphore limit keeps one file's workers from
  // deadlocking on slots another file holds.
  async _withConnSlot(fn) {
    const limit = Math.max(this.config.concurrency || 3, this.config.segments || 4);
    while (this._connBusy >= limit) {
      await new Promise((resolve) => this._connWaiters.push(resolve));
    }
    this._connBusy++;
    try {
      return await fn();
    } finally {
      this._connBusy--;
      const w = this._connWaiters.shift();
      if (w) w();
    }
  }

  async runSingle(item, info, baseHeaders, attempt = 0) {
    const actualUrl = item._resolvedUrl || item.url;
    let proxy = item._proxy || null;
    if (this.config.autoProxy && !proxy) {
      proxy = await this.proxyManager.pickBest(actualUrl, 6000);
      item._proxy = proxy;
    }
    item.proxy = proxy ? proxy.url : "direct";
    const agent = proxy ? this.proxyManager.agentFor(proxy, actualUrl) : null;
    try {
      const existing = await fsp.stat(item.finalPath).catch(() => null);
      const resumeStart = existing ? existing.size : 0;
      const headers = resumeStart > 0
        ? { ...baseHeaders, Range: `bytes=${resumeStart}-` }
        : baseHeaders;

      const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES;
      const result = await requestWithRedirects(actualUrl, { method: "GET", headers, agent, maxRetries, onReq: (req, on) => this._trackReq(item, req, on) });
      const res = result.res;
      const status = result.status;

      let mode = "w";
      if (status === 200) {
        // server ignored the range and restarted; discard partial file
        item.received = 0;
        item._lastBytes = 0;
      } else if (status === 206) {
        const start = contentRangeStart(result.headers["content-range"]);
        if (resumeStart > 0 && start != null && start !== resumeStart) {
          res.resume();
          await fsp.rm(item.finalPath, { force: true }).catch(() => {});
          item.received = 0;
          item._lastBytes = 0;
          const err = new Error("Resume range mismatch: server sent " + start + ", expected " + resumeStart);
          err.category = "resume";
          throw err;
        }
        if (resumeStart > 0) {
          mode = "a";
          item.received = resumeStart;
          item._lastBytes = resumeStart;
        } else {
          item.received = 0;
          item._lastBytes = 0;
        }
      } else {
        res.resume();
        const err = new Error("Download failed: HTTP " + status);
        err.status = status;
        err.category = "http";
        throw err;
      }
      await this.streamToFile(item, res, item.finalPath, mode);
    } catch (err) {
      if (attempt < 1) {
        if (isProxyFailure(err) && proxy) {
          this.proxyManager.markBad(proxy);
          item._proxy = null;
          return this.runSingle(item, info, baseHeaders, attempt + 1);
        }
        if (err.category === "resume") {
          return this.runSingle(item, info, baseHeaders, attempt + 1);
        }
      }
      throw err;
    }
  }

  // ---------------- HLS ----------------
  async runHls(item, baseHeaders, m3u8Url, attempt = 0) {
    // Fail fast when ffmpeg (needed for the .mp4 remux) isn't available.
    const ffmpeg = this.config.ffmpegPath || "ffmpeg";
    const ver = spawnSync(ffmpeg, ["-version"], { stdio: "ignore" });
    if (ver.error) throw new Error("ffmpeg not found (set ffmpegPath in config.json)");
    if (ver.status !== 0) throw new Error("ffmpeg check failed (" + ver.status + ")");

    const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES;
    let proxy = item._proxy || null;
    if (this.config.autoProxy && !proxy) {
      proxy = await this.proxyManager.pickBest(m3u8Url, 6000);
      item._proxy = proxy;
    }
    const agent = proxy ? this.proxyManager.agentFor(proxy, m3u8Url) : null;
    item.proxy = proxy ? proxy.url : "direct";
    this.emit(item);

    let playlistUrl = m3u8Url;
    await this._paceHost(playlistUrl);
    let body = await fetchHtml(playlistUrl, agent, baseHeaders, 0, maxRetries);
    if (item.status !== "running") this.throwAborted();

    // Master playlist -> pick the best variant and fetch its media playlist.
    if (HLS_MASTER_RE.test(body)) {
      const variant = pickHlsVariant(body, playlistUrl);
      if (!variant) throw new Error("HLS: no usable variant in master playlist");
      await this._paceHost(variant);
      body = await fetchHtml(variant, agent, baseHeaders, 0, maxRetries);
      playlistUrl = variant;
      if (item.status !== "running") this.throwAborted();
    }

    const segs = parseHlsPlaylist(body, playlistUrl);
    if (!segs.length) throw new Error("HLS: no segments in playlist");

    await fsp.mkdir(item.tempDir, { recursive: true });
    item.finalPath = path.join(this.dir, item.fileName);

    const queue = [];
    for (let i = 0; i < segs.length; i++) {
      const segPath = path.join(item.tempDir, "seg" + i + PART_EXT);
      const existing = await fsp.stat(segPath).catch(() => null);
      if (existing && existing.size > 0) continue;
      queue.push({ url: segs[i], path: segPath });
    }

    const limit = Math.max(1, Math.min(queue.length || 1, this.config.hlsConcurrency || DEFAULT_HLS_CONCURRENCY));
    const workers = Array.from({ length: limit }, async () => {
      while (queue.length && item.status === "running") {
        const job = queue.shift();
        if (!job) return;
        await this._withConnSlot(() => this.downloadHlsSegment(item, job.url, job.path, baseHeaders));
        if (item.status !== "running") return;
      }
    });
    try {
      await Promise.all(workers);
    } catch (err) {
      this.abort(item);
      throw err;
    }

    if (item.status !== "running") this.throwAborted();
    await this.remuxToMp4(item, segs.length, ffmpeg);
    if (item.status !== "running") this.throwAborted(); // pause/cancel during ffmpeg
  }

  throwAborted() {
    const err = new Error("Aborted");
    err.aborted = true;
    throw err;
  }

  async downloadHlsSegment(item, segUrl, filePath, baseHeaders, attempt = 0) {
    const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES;
    let proxy = item._proxy || null;
    if (this.config.autoProxy && !proxy) {
      proxy = await this.proxyManager.pickBest(segUrl, 5000);
      item._proxy = proxy;
    }
    const agent = proxy ? this.proxyManager.agentFor(proxy, segUrl) : null;
    try {
      const result = await requestWithRedirects(segUrl, { method: "GET", headers: baseHeaders, agent, maxRetries, onReq: (req, on) => this._trackReq(item, req, on) });
      const res = result.res;
      const status = result.status;
      if (status !== 200) {
        res.resume();
        const err = new Error("HLS segment failed: HTTP " + status);
        err.status = status;
        err.category = "http";
        throw err;
      }
      await this.streamToFile(item, res, filePath, "w");
      const raw = await fsp.readFile(filePath);
      const stripped = stripPngPrefix(raw);
      if (stripped.length !== raw.length) await fsp.writeFile(filePath, stripped);
    } catch (err) {
      if (attempt < 1) {
        if (isProxyFailure(err) && proxy) {
          this.proxyManager.markBad(proxy);
          item._proxy = null;
          return this.downloadHlsSegment(item, segUrl, filePath, baseHeaders, attempt + 1);
        }
      }
      throw err;
    }
  }

  // Concatenate the .ts segments in order and let ffmpeg copy-remux to .mp4.
  async remuxToMp4(item, segCount, ffmpeg) {
    const listPath = path.join(item.tempDir, "concat.txt");
    const lines = [];
    for (let i = 0; i < segCount; i++) {
      const p = path.join(item.tempDir, "seg" + i + PART_EXT);
      lines.push("file '" + String(p).replace(/'/g, "'\\''") + "'");
    }
    await fsp.writeFile(listPath, lines.join("\n"), "utf8");
    const tmpOut = item.finalPath + ".part";
    // Output is <final>.part so ffmpeg can't infer the muxer from the extension — force mp4.
    await this.runFfmpeg(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", "-f", "mp4", tmpOut], item);
    await fsp.rm(item.finalPath, { force: true }).catch(() => {});
    await fsp.rename(tmpOut, item.finalPath);
    await fsp.rm(item.tempDir, { recursive: true, force: true }).catch(() => {});
  }

  runFfmpeg(ffmpeg, args, track) {
    return new Promise((resolve, reject) => {
      const cp = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
      // Track the child so abort()/pause()/cancel() can kill a mid-remux ffmpeg.
      if (track) track._activeRes.add(cp);
      let errOut = "";
      cp.stderr.on("data", (c) => {
        errOut += c;
        if (errOut.length > 4000) errOut = errOut.slice(-4000);
      });
      cp.on("error", (e) => {
        if (track) track._activeRes.delete(cp);
        reject(new Error("ffmpeg failed to start: " + e.message));
      });
      cp.on("close", (code) => {
        if (track) track._activeRes.delete(cp);
        if (code === 0) resolve();
        else reject(new Error("ffmpeg remux failed (" + code + "): " + errOut.split("\n").slice(-3).join("\n")));
      });
    });
  }

  // Best-effort small preview frame extracted from the finished video with
  // ffmpeg (same binary the HLS remux uses). Returns the .thumb.jpg path or ""
  // when thumbnails are disabled, ffmpeg is missing, or extraction fails.
  async makeThumb(item) {
    if (this.config.thumbnails === false) return "";
    if (!item.finalPath || item.status !== "done") return "";
    const thumb = item.finalPath + ".thumb.jpg";
    if (fs.existsSync(thumb)) return thumb;
    const ffmpeg = this.config.ffmpegPath || "ffmpeg";
    const attempt = async (args) => {
      try {
        await this.runFfmpeg(ffmpeg, args);
        return fs.existsSync(thumb) ? thumb : "";
      } catch (e) {
        return "";
      }
    };
    // Fast-seek to ~3s for a representative frame; fall back to the first frame
    // for clips shorter than the seek point.
    return await attempt(["-y", "-ss", "3", "-i", item.finalPath, "-frames:v", "1", "-vf", "scale=96:-1", "-f", "image2", thumb])
      || await attempt(["-y", "-i", item.finalPath, "-frames:v", "1", "-vf", "scale=96:-1", "-f", "image2", thumb]);
  }

  async streamToFile(item, res, filePath, flags) {
    item._activeRes.add(res);
    const out = createWriteStream(filePath, { flags });
    const errP = new Promise((_, reject) => out.once("error", reject));
    errP.catch(() => {});
    try {
      for await (const chunk of res) {
        this.tick(item, chunk.length);
        await this.throttle(chunk.length);
        if (!out.write(chunk)) await Promise.race([once(out, "drain"), errP]);
      }
      out.end();
      await Promise.race([once(out, "finish"), errP]);
    } catch (e) {
      out.destroy();
      try { res.destroy(); } catch (e2) { /* ignore */ }
      if (e.name === "AbortError") {
        const err = new Error("Aborted by user");
        err.aborted = true;
        throw err;
      }
      throw e;
    } finally {
      item._activeRes.delete(res);
    }
  }

  // ---------------- controls ----------------
  // Track in-flight requests/responses so abort() can interrupt both phases.
  _trackReq(item, req, on) {
    if (on) item._activeRes.add(req);
    else item._activeRes.delete(req);
  }

  abort(item) {
    const err = new Error("Aborted by user");
    err.name = "AbortError";
    err.aborted = true;
    for (const res of item._activeRes) {
      try {
        // ChildProcess (ffmpeg remux) has kill(), not destroy().
        if (typeof res.kill === "function") res.kill();
        else res.destroy(err);
      } catch (e) { /* ignore */ }
    }
  }

  pause(id) {
    const item = this.items.get(id);
    if (!item || (item.status !== "running" && item.status !== "scheduled" && item.status !== "queued")) return;
    item.status = "paused";
    this.abort(item);
    this.emit(item);
  }

  resume(id) {
    const item = this.items.get(id);
    if (!item) return;
    if (item.status === "paused" || item.status === "error" || item.status === "scheduled") {
      item.status = "queued";
      item.error = "";
      item.speed = 0;
      this.emit(item);
      this.pump();
      // A scheduled-stop item that was paused can lose its sweep timer (the
      // sweep ignores paused items); re-arm so the stop is still enforced.
      if (item.scheduledStart || item.scheduledStop) this.checkScheduled();
    }
  }

  // Re-queue the most recent finished download (active list or history), using
  // its saved URL/title/referer. Handles interrupted/failed links without the
  // extension. Returns the new id or null when there's nothing to resume.
  async resumeLast() {
    const candidates = [];
    for (const it of this.items.values()) {
      if (["done", "error", "cancelled"].includes(it.status)) candidates.push(it);
    }
    candidates.push(...this.history);
    if (!candidates.length) return null;
    const time = (c) => c.timestamp || (parseInt(String(c.id).split("-")[2], 10) || 0);
    const last = candidates.reduce((a, b) => (time(b) > time(a) ? b : a));
    // force:true so resuming a finished download re-downloads it rather than
    // creating a "duplicate" entry.
    return this.enqueue({ url: last.url, title: last.title, referer: last.referer || "", force: true });
  }

  cancel(id) {
    const item = this.items.get(id);
    if (!item) return;
    if (item.status === "running") {
      item.status = "cancelled";
      this.abort(item);
    } else if (item.status === "queued" || item.status === "paused") {
      item.status = "cancelled";
    }
    fsp.rm(item.tempDir, { recursive: true, force: true }).catch(() => {});
    if (item.finalPath) fsp.rm(item.finalPath, { force: true }).catch(() => {});
    this.emit(item);
    this._maybeFinalize(item);
  }

  remove(id) {
    const item = this.items.get(id);
    if (!item) return;
    if (["done", "error", "cancelled"].includes(item.status)) {
      this._toHistory(item);
    }
  }
}

module.exports = { DownloadManager, sanitizeName, requestWithRedirects, resolveUrl, isExpiredError, categorizeError, resolveStreamtape, resolveSupjav, resolveCnPorn, resolveXVideos, resolveXHamster, isHlsUrl, parseHlsPlaylist, stripPngPrefix, pickHlsVariant };