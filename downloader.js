// Download engine: queue, segmented (multi-connection) downloads with proxy
// rotation, pause / resume / cancel, and global speed limit.

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { pipeline } = require("stream/promises");
const { createWriteStream, createReadStream } = fs;
const { once } = require("events");
const { URL } = require("url");
const { transport } = require("./proxy");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_REDIRECTS = 5;
const PART_EXT = ".part";
const PROGRESS_INTERVAL = 300;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sanitizeName(name) {
  return String(name || "video").replace(/[\\/:*?"<>|\r\n\t]+/g, "_").trim().slice(0, 180) || "video";
}

async function requestWithRedirects(targetUrl, { method = "GET", headers = {}, agent = null } = {}) {
  let current = targetUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let urlObj;
    try {
      urlObj = new URL(current);
    } catch (e) {
      throw new Error("Invalid URL: " + current);
    }
    const mod = transport(current);
    const result = await new Promise((resolve, reject) => {
      const req = mod.request(urlObj, {
        method,
        agent,
        headers: { "User-Agent": UA, ...headers }
      }, (res) => {
        resolve({ status: res.statusCode, headers: res.headers, res, finalUrl: current });
      });
      req.on("error", reject);
      req.setTimeout(45000, () => req.destroy(new Error("Request timeout")));
      req.end();
    });

    const code = result.status;
    if (code >= 300 && code < 400 && result.headers.location) {
      result.res.resume();
      const loc = new URL(result.headers.location, current).href;
      const nextOrigin = new URL(loc).origin;
      if (headers.Range && nextOrigin !== new URL(current).origin) {
        delete headers.Range; // range headers may not survive cross-origin redirect
      }
      current = loc;
      continue;
    }
    return result;
  }
  throw new Error("Too many redirects");
}

class DownloadManager {
  constructor({ config, proxyManager, onUpdate }) {
    this.config = config;
    this.proxyManager = proxyManager;
    this.onUpdate = onUpdate || (() => {});
    this.items = new Map();
    this.active = 0;
    this._id = 0;
    this._winBytes = 0;   // global speed-limit window
    this._winStart = Date.now();
  }

  list() {
    return Array.from(this.items.values()).map((i) => i.public());
  }

  get dir() {
    return this.config.downloadDir || path.join(os.homedir(), "Downloads", "DeepGrab");
  }

  // Enqueue a single download; label (e.g. a source tag) is appended to the file name.
  async enqueue({ url, title, referer, label = "" }) {
    if (!/^https?:/i.test(String(url || ""))) {
      throw new Error("Invalid URL: " + url);
    }
    const id = "dl-" + (++this._id) + "-" + Date.now();
    const nameBase = sanitizeName(title) + (label ? " [" + sanitizeName(label) + "]" : "");
    const item = {
      id,
      url,
      title,
      referer,
      label,
      fileName: nameBase + ".mp4",
      status: "queued",
      total: 0,
      received: 0,
      speed: 0,
      proxy: "",
      error: "",
      tempDir: "",
      finalPath: "",
      lastEmit: 0,
      _lastBytes: 0,
      _activeReses: new Set(),
      public() {
        return {
          id: this.id,
          url: this.url,
          title: this.title,
          label: this.label,
          fileName: this.fileName,
          status: this.status,
          total: this.total,
          received: this.received,
          speed: this.speed,
          proxy: this.proxy,
          error: this.error,
          finalPath: this.finalPath
        };
      }
    };
    this.items.set(id, item);
    this.emit(item);
    this.pump();
    return id;
  }

  // Expand an extension source list (kind "link" = direct download) into
  // individual enqueues. Falls back to the plain url field.
  async enqueueSources({ url, title, referer, sources }) {
    const usable = (Array.isArray(sources) ? sources : [])
      .filter((s) => s && s.kind === "link" && /^https?:/i.test(String(s.url || "")))
      .map((s) => ({ url: s.url, label: s.label || "" }));
    const list = usable.length
      ? usable
      : url && /^https?:/i.test(String(url))
        ? [{ url, label: "" }]
        : [];
    if (!list.length) throw new Error("No usable download source");
    const ids = [];
    for (const s of list) {
      ids.push(await this.enqueue({ url: s.url, title, referer, label: s.label }));
    }
    return ids;
  }

  async pump() {
    while (this.active < (this.config.concurrency || 3)) {
      const next = Array.from(this.items.values()).find((i) => i.status === "queued");
      if (!next) break;
      next.status = "running";
      this.active++;
      this.emit(next);
      this.run(next)
        .catch((err) => {
          if (next.status === "paused" || next.status === "cancelled") return;
          next.status = "error";
          next.error = err.message || String(err);
          next.speed = 0;
          this.emit(next);
        })
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  async throttle(bytes) {
    const rate = (this.config.speedLimitKB || 0) * 1024;
    if (!rate) return;
    this._winBytes += bytes;
    const now = Date.now();
    const expectedMs = (this._winBytes / rate) * 1000;
    const sleep = Math.max(0, expectedMs - (now - this._winStart));
    if (sleep > 0) await delay(Math.min(sleep, 500));
    if (now - this._winStart >= 1000) {
      this._winBytes = 0;
      this._winStart = Date.now();
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
      this.emit(item);
    }
  }

  emit(item) {
    this.onUpdate(item.public());
  }

  // ---------------- main flow ----------------
  async run(item) {
    await fsp.mkdir(this.dir, { recursive: true });
    item.tempDir = path.join(this.dir, item.id);
    await fsp.mkdir(item.tempDir, { recursive: true });
    item.finalPath = path.join(this.dir, item.fileName);
    if (fs.existsSync(item.finalPath) && !item.received) {
      const now = new Date();
      const base = sanitizeName(item.title) + (item.label ? " [" + sanitizeName(item.label) + "]" : "");
      item.fileName = base + "_" + now.getTime() + ".mp4";
      item.finalPath = path.join(this.dir, item.fileName);
    }

    const baseHeaders = item.referer ? { Referer: item.referer } : {};

    const info = await this.probe(item, baseHeaders);
    item.total = info.length;
    this.emit(item);

    if (item.total > 2 * 1024 * 1024 && info.acceptRanges && (this.config.segments || 1) > 1) {
      await this.runSegmented(item, info, baseHeaders);
    } else {
      await this.runSingle(item, info, baseHeaders);
    }

    if (item.status === "cancelled") return;

    const stat = await fsp.stat(item.finalPath);
    if (item.total && stat.size !== item.total) {
      throw new Error(`Size mismatch: got ${stat.size}, expected ${item.total}`);
    }
    await fsp.rm(item.tempDir, { recursive: true, force: true }).catch(() => {});
    if (item.status === "cancelled") return;
    item.status = "done";
    item.speed = 0;
    this.emit(item);
  }

  async probe(item, baseHeaders) {
    let proxy = null;
    if (this.config.autoProxy) proxy = await this.proxyManager.pickBest(item.url, 6000);
    item.proxy = proxy ? proxy.url : "direct";
    item._probeProxy = proxy;
    const agent = proxy ? this.proxyManager.agentFor(proxy, item.url) : null;
    const result = await requestWithRedirects(item.url, {
      method: "HEAD",
      headers: baseHeaders,
      agent
    });
    const length = parseInt(result.headers["content-length"] || "0", 10);
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
        await this.downloadSegment(item, seg, baseHeaders);
      }
    });
    await Promise.all(workers);

    const out = createWriteStream(item.finalPath);
    for (const seg of segments) {
      await pipeline(createReadStream(seg.partPath), out, { end: false });
    }
    await new Promise((resolve, reject) => {
      out.end((err) => (err ? reject(err) : resolve()));
    });
  }

  async downloadSegment(item, seg, baseHeaders) {
    let proxy = null;
    if (this.config.autoProxy) proxy = await this.proxyManager.pickBest(item.url, 5000);
    const agent = proxy ? this.proxyManager.agentFor(proxy, item.url) : null;
    const existing = await fsp.stat(seg.partPath).catch(() => null);
    const segLen = seg.end - seg.start + 1;
    if (existing && existing.size >= segLen) return; // segment already complete
    const resumeStart = seg.start + (existing ? existing.size : 0);
    const headers = { ...baseHeaders, Range: `bytes=${resumeStart}-${seg.end}` };

    const result = await requestWithRedirects(item.url, { method: "GET", headers, agent });
    const res = result.res;
    const status = result.status;
    if (status !== 206 && status !== 200) {
      res.resume();
      throw new Error("Segment failed: HTTP " + status);
    }
    // 200 means the server ignored Range and restarted; rewrite the part from scratch
    const flags = status === 200 ? "w" : existing ? "a" : "w";
    await this.streamToFile(item, res, seg.partPath, flags);
  }

  // ---------------- single stream ----------------
  async runSingle(item, info, baseHeaders) {
    const proxy = item._probeProxy;
    item.proxy = proxy ? proxy.url : "direct";
    const agent = proxy ? this.proxyManager.agentFor(proxy, item.url) : null;

    const existing = await fsp.stat(item.finalPath).catch(() => null);
    const resumeStart = existing ? existing.size : 0;
    const headers = resumeStart > 0
      ? { ...baseHeaders, Range: `bytes=${resumeStart}-` }
      : baseHeaders;

    const result = await requestWithRedirects(item.url, { method: "GET", headers, agent });
    const res = result.res;
    const status = result.status;

    let mode = "w";
    if (status === 200) {
      // server ignored the range and restarted; discard partial file
      item.received = 0;
      item._lastBytes = 0;
    } else if (status === 206) {
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
      throw new Error("Download failed: HTTP " + status);
    }
    await this.streamToFile(item, res, item.finalPath, mode);
  }

  async streamToFile(item, res, filePath, flags) {
    item._activeReses.add(res);
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
      item._activeReses.delete(res);
    }
  }

  // ---------------- controls ----------------
  abort(item) {
    const err = new Error("Aborted by user");
    for (const res of item._activeReses) {
      try { res.destroy(err); } catch (e) { /* ignore */ }
    }
  }

  pause(id) {
    const item = this.items.get(id);
    if (!item || !["running", "queued"].includes(item.status)) return;
    item.status = "paused";
    this.abort(item);
    this.emit(item);
  }

  resume(id) {
    const item = this.items.get(id);
    if (!item) return;
    if (item.status === "paused" || item.status === "error") {
      item.status = "queued";
      item.error = "";
      item.speed = 0;
      this.emit(item);
      this.pump();
    }
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
    this.emit(item);
  }

  remove(id) {
    const item = this.items.get(id);
    if (!item) return;
    if (["done", "error", "cancelled"].includes(item.status)) {
      this.items.delete(id);
      this.onUpdate({ _removed: id });
    }
  }
}

module.exports = { DownloadManager, sanitizeName, requestWithRedirects };
