"use strict";
// Download-history persistence: owns the history array, the dedupe set of
// downloaded URLs, and their two JSON files (history.json / downloaded.json) in
// the active download dir. Writes are debounced (~500ms) during bulk runs, with
// a synchronous flush for app quit / clear-history so the latest state never
// gets lost to a pending timer. `dir` is a function so the active-dir fallback
// chain (_activeDirSync) stays in the DownloadManager.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { matchHlsMaster } = require("./hls");

// Signed / rotating media URLs (streamtape get_video expires/token, tapecontent
// blob paths, signed m3u8 query tokens) are a brand-new string on every capture
// of the SAME stream, so exact-URL dedupe never matches and the movie re-downloads
// under a timestamped name. canonicalKeys() returns stable keys that describe the
// CONTENT a URL points at; the downloader dedupes on them alongside the raw URL.
// Returns [] for everything with no stable identity (plain mp4s, page URLs).
function canonicalKeys(u) {
  const s = String(u || "");
  const out = [];
  if (!s) return out;
  try {
    const url = new URL(s);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    // streamtape/fstape get_video: the id is stable, expires/token rotate.
    if (/^(?:[^/]+\.)?(?:streamtape|fstape)\.com$/i.test(host) && /^\/get_video\/?$/i.test(url.pathname)) {
      const id = url.searchParams.get("id");
      if (id) out.push("st:" + id);
    }
    // HLS playlists: forget the query so a re-captured master/variant with a
    // fresh signed token still dedupes against the recorded one.
    if (/\.m3u8([?#]|$)/i.test(url.pathname)) out.push("hls:" + url.origin + url.pathname);
    // streamtape CDN: the deep radosgw parent dir is unique per file, so keying
    // on it catches the resolved tapecontent capture without keying on the tail.
    if (/(?:^|\.)tapecontent\.net$/i.test(host)) {
      const p = url.pathname.split("/").filter(Boolean).slice(0, -1).join("/");
      if (p) out.push("cdn:" + url.origin + "/" + p + "/");
    }
  } catch (e) { /* malformed URL: no canonical identity */ }
  return out;
}

class HistoryStore {
  // dir: () => active download dir; saveHistory: () => boolean (persistence toggle)
  constructor({ dir, saveHistory = () => true }) {
    this._dir = dir;
    this._saveHistoryEnabled = saveHistory;
    this.history = [];
    this.downloaded = new Set(); // URLs that reached "done" (for duplicate handling)
    this._persistTimer = null;   // debounced writer for history/downloaded.json
  }

  get historyPath() {
    return path.join(this._dir(), "history.json");
  }

  get downloadedPath() {
    return path.join(this._dir(), "downloaded.json");
  }

  load() {
    try {
      const data = fs.readFileSync(this.historyPath, "utf8");
      this.history = JSON.parse(data);
    } catch (e) {
      this.history = [];
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.downloadedPath, "utf8"));
      if (Array.isArray(data)) this.downloaded = new Set(data);
    } catch (e) {
      this.downloaded = new Set();
    }
  }

  _saveHistoryNow() {
    if (this._saveHistoryEnabled() === false) return; // history persistence toggle
    try {
      fsp.writeFile(this.historyPath, JSON.stringify(this.history), "utf8").catch(() => {});
    } catch (e) { /* ignore */ }
  }

  _saveDownloadedNow() {
    try {
      fsp.writeFile(this.downloadedPath, JSON.stringify(Array.from(this.downloaded)), "utf8").catch(() => {});
    } catch (e) { /* ignore */ }
  }

  // Debounced persistence: coalesce the many per-completion history/downloaded
  // writes during a bulk run into one disk write every ~500ms.
  saveSoon() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._saveHistoryNow();
      this._saveDownloadedNow();
    }, 500);
  }

  // Write any pending history/downloaded changes immediately (e.g. on quit).
  // Synchronous so a graceful quit deterministically persists the latest
  // state before teardown (a pending debounce timer otherwise loses <500ms).
  flushSync() {
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    try {
      if (this._saveHistoryEnabled() !== false) {
        fs.writeFileSync(this.historyPath, JSON.stringify(this.history), "utf8");
      }
    } catch (e) { /* ignore */ }
    try {
      fs.writeFileSync(this.downloadedPath, JSON.stringify(Array.from(this.downloaded)), "utf8");
    } catch (e) { /* ignore */ }
  }

  isDownloaded(url) {
    const u = String(url || "");
    if (this.downloaded.has(u)) return true;
    for (const k of canonicalKeys(u)) {
      if (this.downloaded.has(k)) return true;
    }
    // Redundant quality variant: once its master playlist is recorded as
    // downloaded, a later <N>p/video.m3u8 capture of the SAME stream is a dup.
    for (const c of matchHlsMaster(u)) {
      if (this.downloaded.has(c)) return true;
    }
    return false;
  }

  markDownloaded(url) {
    const u = String(url || "");
    this.downloaded.add(u);
    for (const k of canonicalKeys(u)) this.downloaded.add(k);
    this.saveSoon();
  }

  // Append a terminal item to history (capped) and schedule persistence.
  push(entry, cap) {
    this.history.push(entry);
    if (this.history.length > cap) this.history = this.history.slice(-cap);
    this.saveSoon();
  }

  list() {
    return this.history.map((i) => ({
      ...i,
      status: i.status,
      timestamp: i.timestamp
    }));
  }

  exportCSV() {
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

  exportJSON() {
    return JSON.stringify(this.history, null, 2);
  }
}

module.exports = { HistoryStore, canonicalKeys };
