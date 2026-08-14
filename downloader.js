// Download engine: queue, segmented (multi-connection) downloads with proxy
// rotation, pause / resume / cancel, and global speed limit.

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const { pipeline } = require("stream/promises");
const { createWriteStream, createReadStream } = fs;
const { once } = require("events");
const { URL } = require("url");
const { transport } = require("./proxy");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_REDIRECTS = 5;
const PART_EXT = ".part";
const PROGRESS_INTERVAL = 300;
const RETRY_DELAY = 1000;
const DEFAULT_MAX_RETRIES = 3;
const MAX_REFRESH = 2;

const STRGV = /get_video\?id=([A-Za-z0-9]+)&expires=(\d+)&ip=([^&\s"'<>]+)&token=([^&\s"'<>]+)/i;

const CNIFRAME = /(?:<iframe[^>]*src=["']|data-src=["'])([^"']*pornhub\.com\/embed\/[^"']+)["']/i;
const CNVIDEO = /<video[^>]*>\s*<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/i;
const CNIFRAME2 = /src=["'](https?:\/\/[^"']*streamtape\.com\/[^"']+)["']/i;
// cnporn's own embed iframe (lazy data-src, plain src, or data-server="/embed/<uuid>")
// and the mp4/m3u8 "file" entries baked into the embed page's player setup.
const CNEMBED = /(?:data-src|src|data-server)=["']([^"']*\/embed\/[^"']+)["']/i;
const CNSOURCES = /"file"\s*:\s*"([^"]+\.(?:mp4|m3u8)[^"]*)"/i;

const HLS_RE = /\.m3u8([?#]|$)/i;
const HLS_MASTER_RE = /#EXT-X-STREAM-INF/i;
const HLS_AES_RE = /#EXT-X-KEY:METHOD=AES-128/i;

// supjav's player iframe (supjav.php?l=<OLID>) reverses the id and reloads
// ?c=<reversed>, which emits a streamtape/fstape embed page OR (8/2026) a
// turbovidhls.com/t/<id> JWPlayer page hosting HLS via turboviplay.com.
const SJ_PLAYER_RE = /(?:supjav|supremejav)\.(?:com|ph|net)[^"'\s]*\bsupjav\.php/i;
const SJ_OLID = /[?&]l=([0-9a-f]+)/i;

// turbovidhls player page: the m3u8 playlist lives in the #video_player div's
// data-hash attribute (a cdn2.turboviplay.com/data1/<hex>/<hex>.m3u8 URL).
const TVH_EMBED_RE = /turbovidhls\.com\/t\//i;
const TVH_HASH_RE = /<div[^>]*id=["']video_player["'][^>]*data-hash=["']([^"']+\.m3u8[^"']*)["']/i;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// True when a failure means the direct URL likely expired (signed token) and
// re-resolving the original page may yield a fresh one.
function isExpiredError(err) {
  const status = err && err.status;
  if (status === 403 || status === 404 || status === 410) return true;
  return /expired|token|forbidden|access denied/i.test(String(err && err.message));
}

// Parse the start offset from a `Content-Range: bytes START-END/TOTAL` header.
function contentRangeStart(header) {
  if (!header) return null;
  const m = /^bytes\s+(\d+)-/i.exec(String(header).trim());
  return m ? parseInt(m[1], 10) : null;
}

// Parse the TOTAL size from a `Content-Range: bytes START-END/TOTAL` header.
// Range-answering servers report a partial content-length, so the total from
// Content-Range is the only trustworthy size when a probe sends Range.
function contentRangeTotal(header) {
  if (!header) return null;
  const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(String(header).trim());
  return m ? parseInt(m[1], 10) : null;
}

// True when a failure is likely the proxy's fault (rotating to another proxy
// may fix it). 403/404/410 are excluded — those mean the URL itself is stale.
function isProxyFailure(err) {
  if (!err) return false;
  if (err.status && err.status >= 500) return true;
  return /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EPROTO|socket hang up|proxy/i.test(
    String(err.code || "") + " " + String(err.message)
  );
}

function categorizeError(err) {
  if (!err) return "unknown";
  if (err.category) return err.category;
  if (err.aborted) return "aborted";
  if (err.status) return "http";
  if (/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket/i.test(String(err.code || "") + " " + String(err.message))) return "network";
  if (isExpiredError(err)) return "expired";
  if (/size mismatch/i.test(String(err.message))) return "size";
  return "unknown";
}

async function resolveStreamtape(videoPageUrl, { proxyManager, config }, baseHeaders = {}) {
  // Already a signed direct link (get_video?id=..&expires=..&ip=..&token=..):
  // normalize &stream=1 and pass through. Fetching it would download the video
  // file itself — STRGV targets the embed page's HTML, not this.
  if (/get_video\?/i.test(videoPageUrl)) {
    const norm = /stream=1/i.test(videoPageUrl) ? videoPageUrl : videoPageUrl + "&stream=1";
    return { resolvedUrl: norm, proxy: null, agent: null };
  }
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const proxy = config.autoProxy ? await proxyManager.pickBest(videoPageUrl, 6000) : null;
  const agent = proxy ? proxyManager.agentFor(proxy, videoPageUrl) : null;
  let html;
  try {
    html = await fetchHtml(videoPageUrl, agent, baseHeaders, 0, maxRetries);
  } catch (err) {
    throw new Error("Streamtape: failed to fetch page - " + err.message);
  }

  // The embed page bakes the signed direct URL into the HTML
  // (get_video?id=..&expires=..&ip=..&token=..); the player builds it from
  // #botlink and appends &stream=1. Returning the /e/ page itself would
  // download the player HTML as the "video", so fail instead of falling back.
  const gv = html.match(STRGV);
  if (!gv) throw new Error("Could not find video source on Streamtape page.");
  // fstape is a streamtape clone — same embed/HTML/get_video structure
  const host = /fstape\.com/i.test(videoPageUrl) ? "fstape.com" : "streamtape.com";
  const apiUrl =
    "https://" + host + "/get_video?id=" + gv[1] +
    "&expires=" + gv[2] +
    "&ip=" + gv[3] +
    "&token=" + gv[4] +
    "&stream=1";
  return { resolvedUrl: apiUrl, proxy, agent };
}

async function fetchHtml(url, agent, headers = {}, retries = 0, maxRetries = DEFAULT_MAX_RETRIES) {
  const mod = transport(url);
  try {
    return await new Promise((resolve, reject) => {
      const req = mod.request(url, {
        method: "GET",
        agent,
        headers: { "User-Agent": UA, ...headers }
      }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => body += c);
        res.on("end", () => resolve(body));
      });
      req.on("error", reject);
      req.setTimeout(30000, () => req.destroy(new Error("HTML fetch timeout")));
      req.end();
    });
  } catch (err) {
    if (retries < maxRetries) {
      await delay(RETRY_DELAY * (retries + 1));
      return fetchHtml(url, agent, headers, retries + 1, maxRetries);
    }
    throw new Error("Failed to fetch page after " + maxRetries + " retries: " + err.message);
  }
}

// supjav's player iframe: the app receives supjav.php?l=<OLID> from the
// userscript (its frame.src/defaultSrc), never the Cloudflare-403'd page.
// The player reverses the id and loads ?c=<reversed>, which 302s straight to a
// streamtape/fstape embed, or (since 8/2026) a turbovidhls.com/t/<id> player
// page hosting HLS. Resolve streamtape/fstape to the signed direct URL; fetch
// the turbovidhls page and pull the m3u8 from #video_player[data-hash] so the
// HLS engine can download it.
async function resolveSupjav(videoPageUrl, { proxyManager, config }, baseHeaders = {}) {
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const proxy = config.autoProxy ? await proxyManager.pickBest(videoPageUrl, 6000) : null;
  const agent = proxy ? proxyManager.agentFor(proxy, videoPageUrl) : null;
  const olid = SJ_OLID.exec(videoPageUrl);
  if (!olid) throw new Error("Supjav: no player id (supjav.php?l=...) in URL");
  const rev = olid[1].split("").reverse().join("");
  const cUrl = new URL("?c=" + rev, videoPageUrl).href;
  let result;
  try {
    result = await requestWithRedirects(cUrl, {
      method: "GET",
      headers: { ...baseHeaders, Referer: baseHeaders.Referer || videoPageUrl },
      agent,
      maxRetries
    });
  } catch (err) {
    throw new Error("Supjav: failed to fetch player - " + err.message);
  }
  result.res.resume();
  const embed = result.finalUrl;
  if (/streamtape|fstape\.com\/e\//i.test(embed)) {
    return { resolvedUrl: embed, proxy, agent, origin: "supjav-player" };
  }
  if (TVH_EMBED_RE.test(embed)) {
    let html;
    try {
      html = await fetchHtml(embed, agent, baseHeaders, 0, maxRetries);
    } catch (err) {
      throw new Error("Supjav: failed to fetch turbovidhls player - " + err.message);
    }
    const h = html.match(TVH_HASH_RE);
    if (!h) throw new Error("Supjav: no m3u8 (data-hash) on turbovidhls player page");
    return { resolvedUrl: h[1].trim(), proxy, agent, origin: "supjav-turbovid-hls" };
  }
  throw new Error("Supjav: player did not redirect to a streamtape/fstape embed or turbovidhls player");
}

async function resolveCnPorn(videoPageUrl, { proxyManager, config }, baseHeaders = {}) {
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const proxy = config.autoProxy ? await proxyManager.pickBest(videoPageUrl, 6000) : null;
  const agent = proxy ? proxyManager.agentFor(proxy, videoPageUrl) : null;
  let html;
  try {
    html = await fetchHtml(videoPageUrl, agent, baseHeaders, 0, maxRetries);
  } catch (err) {
    throw new Error("CnPorn: failed to fetch page - " + err.message);
  }

  let iframeMatch = html.match(CNIFRAME) || html.match(CNIFRAME2);
  let embedUrl = iframeMatch ? iframeMatch[1].trim() : null;

  if (!embedUrl) {
    const ce = html.match(CNEMBED);
    if (ce) {
      const raw = ce[1].trim();
      embedUrl = /^https?:\/\//i.test(raw) ? raw : new URL(raw, videoPageUrl).href;
    }
  }

  if (!embedUrl) {
    const mv = html.match(CNVIDEO);
    if (mv) {
      return { resolvedUrl: mv[1].trim(), proxy, agent, origin: "cnporn-direct" };
    }
    throw new Error("CnPorn: no embed/iframe/video source found");
  }

  // cnporn's own /embed/<uuid> page: fetch it and pull the player's sources
  // array (an m3u8 playlist, or a direct mp4 when the site offers one).
  if (/cnporn\.org\/embed\//i.test(embedUrl)) {
    let embedHtml;
    try {
      embedHtml = await fetchHtml(embedUrl, agent, baseHeaders, 0, maxRetries);
    } catch (err) {
      throw new Error("CnPorn: failed to fetch embed - " + err.message);
    }
    const s = embedHtml.match(CNSOURCES);
    if (!s) throw new Error("CnPorn: no video source on embed page");
    const src = s[1].trim().replace(/\\\//g, "/"); // JSON-escaped slashes
    return { resolvedUrl: src, proxy, agent, origin: /\.mp4([?#]|$)/i.test(src) ? "cnporn-direct" : "cnporn-hls" };
  }

  if (/pornhub\.com\/embed\//i.test(embedUrl)) {
    return { resolvedUrl: embedUrl, proxy, agent, origin: "pornhub-embed" };
  }
  if (/streamtape\.com/i.test(embedUrl)) {
    return { resolvedUrl: embedUrl, proxy, agent, origin: "streamtape-embed" };
  }
   return { resolvedUrl: embedUrl, proxy, agent, origin: "generic-embed" };
 }

const XVEMBED = /(?:<iframe[^>]*src=["']|data-src=["'])([^"']*xvideos\.com\/embedframe[^"']+)["']/i;
const XVDIRECT = /<video[^>]*>\s*<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/i;

async function resolveXVideos(videoPageUrl, { proxyManager, config }, baseHeaders = {}) {
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const proxy = config.autoProxy ? await proxyManager.pickBest(videoPageUrl, 6000) : null;
  const agent = proxy ? proxyManager.agentFor(proxy, videoPageUrl) : null;
  let html;
  try {
    html = await fetchHtml(videoPageUrl, agent, baseHeaders, 0, maxRetries);
  } catch (err) {
    throw new Error("XVideos: failed to fetch page - " + err.message);
  }

  let embedMatch = html.match(XVEMBED);
  let embedUrl = embedMatch ? embedMatch[1].trim() : null;

  if (!embedUrl) {
    const direct = html.match(XVDIRECT);
    if (direct) {
      return { resolvedUrl: direct[1].trim(), proxy, agent, origin: "xvideos-direct" };
    }
    throw new Error("XVideos: no embed/iframe/video source found");
  }

  return { resolvedUrl: embedUrl, proxy, agent, origin: "xvideos-embed" };
}

const XHEMBED = /src=["'](https?:\/\/[^"']*xhamster\.com\/xembed[^"']+)["']/i;
const XHPLAY = /<a\b(?=[^>]*class=["'][^"']*ht-prev[^"']*["'])[^>]*href=["']([^"']*xhamster\.com\/videos\/[^"']+)["']/i;
const XHMP4 = /<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/i;

async function resolveXHamster(videoPageUrl, { proxyManager, config }, baseHeaders = {}) {
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const proxy = config.autoProxy ? await proxyManager.pickBest(videoPageUrl, 6000) : null;
  const agent = proxy ? proxyManager.agentFor(proxy, videoPageUrl) : null;
  let html;
  try {
    html = await fetchHtml(videoPageUrl, agent, baseHeaders, 0, maxRetries);
  } catch (err) {
    throw new Error("XHamster: failed to fetch page - " + err.message);
  }

  const direct = html.match(XHMP4);
  if (direct) {
    return { resolvedUrl: direct[1].trim(), proxy, agent, origin: "xhamster-direct" };
  }

  let embedMatch = html.match(XHEMBED);
  let embedUrl = embedMatch ? embedMatch[1].trim() : null;

  if (!embedUrl) {
    const playMatch = html.match(XHPLAY);
    if (playMatch) {
      return { resolvedUrl: playMatch[1].trim(), proxy, agent, origin: "xhamster-play" };
    }
    throw new Error("XHamster: no embed/video source found");
  }

  return { resolvedUrl: embedUrl, proxy, agent, origin: "xhamster-embed" };
}

// Detect the site and follow the re-resolution chain to a final direct URL.
// Returns null for URLs with no resolver (generic mp4 pass through untouched).
async function resolveUrl(url, { proxyManager, config }, baseHeaders = {}) {
  if (/(?:streamtape|fstape)\.com/i.test(url)) {
    const r = await resolveStreamtape(url, { proxyManager, config }, baseHeaders);
    return r.resolvedUrl;
  }
  if (SJ_PLAYER_RE.test(url)) {
    const r = await resolveSupjav(url, { proxyManager, config }, baseHeaders);
    if (/streamtape|fstape\.com/i.test(r.resolvedUrl)) {
      const r2 = await resolveStreamtape(r.resolvedUrl, { proxyManager, config }, { ...baseHeaders, Referer: r.resolvedUrl });
      return r2.resolvedUrl;
    }
    if (HLS_RE.test(r.resolvedUrl)) return r.resolvedUrl;
    return r.resolvedUrl;
  }
  if (/cnporn\.org/i.test(url)) {
    const r = await resolveCnPorn(url, { proxyManager, config }, baseHeaders);
    if (/streamtape\.com/i.test(r.resolvedUrl) || r.origin === "streamtape-embed") {
      const r2 = await resolveStreamtape(r.resolvedUrl, { proxyManager, config }, baseHeaders);
      return r2.resolvedUrl;
    }
    return r.resolvedUrl;
  }
  if (/xvideos\.com/i.test(url)) {
    const r = await resolveXVideos(url, { proxyManager, config }, baseHeaders);
    if (/streamtape\.com/i.test(r.resolvedUrl)) {
      const r2 = await resolveStreamtape(r.resolvedUrl, { proxyManager, config }, baseHeaders);
      return r2.resolvedUrl;
    }
    return r.resolvedUrl;
  }
  if (/xhamster\.com/i.test(url)) {
    const r = await resolveXHamster(url, { proxyManager, config }, baseHeaders);
    if (/xvideos\.com/i.test(r.resolvedUrl)) {
      const r2 = await resolveXVideos(r.resolvedUrl, { proxyManager, config }, baseHeaders);
      if (/streamtape\.com/i.test(r2.resolvedUrl)) {
        const r3 = await resolveStreamtape(r2.resolvedUrl, { proxyManager, config }, baseHeaders);
        return r3.resolvedUrl;
      }
      return r2.resolvedUrl;
    }
    return r.resolvedUrl;
  }
  return null;
}

function sanitizeName(name) {
  const clean = String(name || "video").replace(/[\\/:*?"<>|\r\n\t]+/g, "_").trim().slice(0, 180) || "video";
  return clean.replace(/\.(mp4|m4v|webm|mov|mkv|flv|m3u8)$/i, "");
}

function isHlsUrl(u) {
  return HLS_RE.test(String(u || ""));
}

// Some CDNs prepend a fake 1x1 PNG (anti-bot decoy) to the real MPEG-TS
// segment. Strip anything up to the end of the PNG IEND chunk so ffmpeg
// muxes actual video, not a png stream. Returns the stripped buffer.
function stripPngPrefix(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return buf;
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const next = pos + 12 + len;
    if (next > buf.length) return buf;
    if (type === "IEND") return buf.slice(next);
    pos = next;
  }
  return buf;
}

// Turn an HLS playlist body into segment URLs. Relative URIs resolve against
// the playlist's own URL. AES-128 keys aren't supported (segments would be
// encrypted garbage).
function parseHlsPlaylist(text, baseUrl) {
  if (HLS_AES_RE.test(String(text))) throw new Error("HLS: AES-128 encrypted playlists are not supported");
  const segs = [];
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    segs.push(new URL(t, baseUrl).href);
  }
  return segs;
}

// Pick the highest-quality variant from a master playlist.
function pickHlsVariant(text, baseUrl) {
  let best = null;
  let bestScore = -1;
  const blocks = String(text).split(/#EXT-X-STREAM-INF/i).slice(1);
  for (const block of blocks) {
    const tagEnd = block.indexOf("\n");
    const tag = (tagEnd === -1 ? block : block.slice(0, tagEnd)).trim();
    const uriLine = (tagEnd === -1 ? "" : block.slice(tagEnd + 1).trim());
    if (!uriLine) continue;
    const res = /RESOLUTION=\s*(\d+)x(\d+)/i.exec(tag);
    const bw = /BANDWIDTH=\s*(\d+)/i.exec(tag);
    const score = (res ? parseInt(res[2], 10) : 0) * 1000000 + (bw ? parseInt(bw[1], 10) : 0);
    if (score > bestScore) {
      bestScore = score;
      best = new URL(uriLine, baseUrl).href;
    }
  }
  return best;
}

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

// streamtape/fstape embed URLs carry the video name as a slug
// (/v/<id>/My-Video-Name); use it when the sender gave no title so files
// aren't just "video.mp4".
function titleFromReferer(referer) {
  try {
    const u = new URL(referer);
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

async function requestWithRedirects(targetUrl, { method = "GET", headers = {}, agent = null, retries = 0, maxRetries = DEFAULT_MAX_RETRIES, onReq = null } = {}) {
  let current = targetUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let urlObj;
    try {
      urlObj = new URL(current);
    } catch (e) {
      throw new Error("Invalid URL: " + current);
    }
    try {
      const mod = transport(current);
      const result = await new Promise((resolve, reject) => {
        const req = mod.request(urlObj, {
          method,
          agent,
          headers: { "User-Agent": UA, ...headers }
        }, (res) => {
          if (onReq) onReq(req, false);
          resolve({ status: res.statusCode, headers: res.headers, res, finalUrl: current });
        });
        if (onReq) onReq(req, true);
        req.on("error", (err) => {
          if (onReq) onReq(req, false);
          reject(err);
        });
        req.setTimeout(45000, () => {
          const err = new Error("Request timeout");
          err.code = "ETIMEDOUT";
          req.destroy(err);
        });
        req.end();
      });

      const code = result.status;
      if (code >= 300 && code < 400 && result.headers.location) {
        result.res.resume();
        const loc = new URL(result.headers.location, current).href;
        const nextOrigin = new URL(loc).origin;
        if (headers.Range && nextOrigin !== new URL(current).origin) {
          delete headers.Range;
        }
        current = loc;
        continue;
      }
      return result;
    } catch (err) {
      if (retries < maxRetries && (err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.code === "ECONNREFUSED")) {
        await delay(RETRY_DELAY * (retries + 1));
        return requestWithRedirects(targetUrl, { method, headers, agent, retries: retries + 1, maxRetries, onReq });
      }
      throw err;
    }
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
    this.history = [];
    this._speedBytes = 0;
    this._speedStart = Date.now();
    this._loadHistory();
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
         "ID,File,Size,Status,Duration,Completed,Duration(ms)",
         ...this.history.map((h) =>
           [h.id, `"${h.fileName}"`, h.total, h.status, h.timestamp, h.endTime ? Math.round((h.endTime - h.timestamp) / 1000) : ""].join(",")
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

    _saveHistory() {
      try {
        fsp.writeFile(this.historyPath, JSON.stringify(this.history, null, 2), "utf8").catch(() => {});
      } catch (e) { /* ignore */ }
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
      const current = valid.length ? valid[valid.length - 1].speed : 0;
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

    get dir() {
    return this.config.downloadDir || path.join(os.homedir(), "Downloads", "DeepGrab");
  }

    get historyPath() {
      return path.join(this.dir, "history.json");
    }

   async enqueue({ url, title, referer, resolvedUrl = null, scheduledStart = null, scheduledStop = null, label = "" }) {
    const id = "dl-" + (++this._id) + "-" + Date.now();
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
      scheduledStart: scheduledStart || null,
      scheduledStop: scheduledStop || null,
      lastEmit: 0,
      _lastBytes: 0,
      _proxy: null,
      refreshCount: 0,
      errorCategory: "",
      _activeRes: new Set(),
      _samples: [],
      public() {
        return {
          id: this.id,
          url: this.url,
          title: this.title,
          label: this.label || "",
          kind: this.kind || "mp4",
          fileName: this.fileName,
          status: this.status,
          total: this.total,
          received: this.received,
          speed: this.speed,
          proxy: this.proxy,
          error: this.error,
          errorCategory: this.errorCategory,
          refreshCount: this.refreshCount,
          finalPath: this.finalPath,
          scheduledStart: this.scheduledStart,
          scheduledStop: this.scheduledStop,
          samples: this._samples.slice(-120).map((s) => ({ time: s.time, speed: s.speed }))
        };
      }
    };
     this.items.set(id, item);
     this.emit(item);
     if (item.scheduledStart && Date.now() < item.scheduledStart) {
       item.status = "scheduled";
       this.emit(item);
     }
     this.pump();
     if (item.scheduledStart && Date.now() < item.scheduledStart) {
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
       due.forEach((i) => { i.status = "queued"; this.emit(i); });
       this.pump();
     }
     if (due.length || Array.from(this.items.values()).some((i) => i.status === "scheduled")) {
       clearTimeout(this._scheduleTimer);
       this._scheduleTimer = setTimeout(() => this.checkScheduled(), 30000);
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
        // Expired direct URL (e.g. streamtape signed token) — re-resolve the
        // original page and retry from scratch with the fresh URL.
        if (!isExpiredError(err)) throw err;
        // get_video links are passed through (resolved === original), so the
        // usual "resolved differs from url" test can't gate them; a signed link
        // with a streamtape/fstape referer is still refreshable — from the page.
        const refreshable =
          (item._resolvedUrl && item._resolvedUrl !== item.url) || isSignedRefreshable(item);
        if (!refreshable) throw err;
        let fresh = null;
        try {
          fresh = await resolveUrl(refreshSourceUrl(item), { proxyManager: this.proxyManager, config: this.config }, baseHeaders);
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
      const r = await resolveUrl(item.url, { proxyManager: this.proxyManager, config: this.config }, baseHeaders);
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
        await this.runSegmented(item, info, baseHeaders);
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
  }

   async probe(item, baseHeaders, actualUrl) {
    let proxy = null;
    if (this.config.autoProxy) {
      proxy = item._proxy || null;
      if (!proxy) {
        proxy = await this.proxyManager.pickBest(item.url, 6000);
        item._proxy = proxy;
      }
    }
    item.proxy = proxy ? proxy.url : "direct";
    const agent = proxy ? this.proxyManager.agentFor(proxy, item.url) : null;
    const result = await requestWithRedirects(actualUrl || item.url, {
      method: "HEAD",
      headers: { ...baseHeaders, Range: "bytes=0-0" },
      agent,
      onReq: (req, on) => this._trackReq(item, req, on)
    });
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

   async downloadSegment(item, seg, baseHeaders, attempt = 0) {
     const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES;
     let proxy = item._proxy || null;
     if (this.config.autoProxy && !proxy) {
       proxy = await this.proxyManager.pickBest(item.url, 5000);
       item._proxy = proxy;
     }
     const agent = proxy ? this.proxyManager.agentFor(proxy, item.url) : null;
     try {
       const existing = await fsp.stat(seg.partPath).catch(() => null);
       const resumeStart = seg.start + (existing ? existing.size : 0);
       const headers = { ...baseHeaders, Range: `bytes=${resumeStart}-${seg.end}` };

       const actualUrl = item._resolvedUrl || item.url;
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

       let mode = "w";
       if (status === 200) {
         // Server ignored Range and restarted at byte 0 — truncate the part
         // so a stale partial can never corrupt the merge.
         await fsp.rm(seg.partPath, { force: true }).catch(() => {});
       } else if (resumeStart > seg.start) {
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
    async runSingle(item, info, baseHeaders, attempt = 0) {
    let proxy = item._proxy || null;
    if (this.config.autoProxy && !proxy) {
      proxy = await this.proxyManager.pickBest(item.url, 6000);
      item._proxy = proxy;
    }
    item.proxy = proxy ? proxy.url : "direct";
    const agent = proxy ? this.proxyManager.agentFor(proxy, item.url) : null;
    try {
      const existing = await fsp.stat(item.finalPath).catch(() => null);
      const resumeStart = existing ? existing.size : 0;
      const headers = resumeStart > 0
        ? { ...baseHeaders, Range: `bytes=${resumeStart}-` }
        : baseHeaders;

      const actualUrl = item._resolvedUrl || item.url;

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
    let body = await fetchHtml(playlistUrl, agent, baseHeaders, 0, maxRetries);
    if (item.status !== "running") this.throwAborted();

    // Master playlist -> pick the best variant and fetch its media playlist.
    if (HLS_MASTER_RE.test(body)) {
      const variant = pickHlsVariant(body, playlistUrl);
      if (!variant) throw new Error("HLS: no usable variant in master playlist");
      body = await fetchHtml(variant, agent, baseHeaders, 0, maxRetries);
      playlistUrl = variant;
      if (item.status !== "running") this.throwAborted();
    }

    const segs = parseHlsPlaylist(body, playlistUrl);
    if (!segs.length) throw new Error("HLS: no segments in playlist");

    await fsp.mkdir(item.tempDir, { recursive: true });
    item.finalPath = path.join(this.dir, item.fileName);

    for (let i = 0; i < segs.length; i++) {
      if (item.status !== "running") this.throwAborted();
      const segPath = path.join(item.tempDir, "seg" + i + PART_EXT);
      const existing = await fsp.stat(segPath).catch(() => null);
      if (existing && existing.size > 0) continue; // resume: skip done segments
      await this.downloadHlsSegment(item, segs[i], segPath, baseHeaders);
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
    await this.runFfmpeg(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", "-f", "mp4", tmpOut]);
    await fsp.rm(item.finalPath, { force: true }).catch(() => {});
    await fsp.rename(tmpOut, item.finalPath);
    await fsp.rm(item.tempDir, { recursive: true, force: true }).catch(() => {});
  }

  runFfmpeg(ffmpeg, args) {
    return new Promise((resolve, reject) => {
      const cp = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
      let errOut = "";
      cp.stderr.on("data", (c) => {
        errOut += c;
        if (errOut.length > 4000) errOut = errOut.slice(-4000);
      });
      cp.on("error", (e) => reject(new Error("ffmpeg failed to start: " + e.message)));
      cp.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("ffmpeg remux failed (" + code + "): " + errOut.split("\n").slice(-3).join("\n")));
      });
    });
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
      try { res.destroy(err); } catch (e) { /* ignore */ }
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
     return this.enqueue({ url: last.url, title: last.title, referer: last.referer || "" });
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
  }

   remove(id) {
     const item = this.items.get(id);
     if (!item) return;
     if (["done", "error", "cancelled"].includes(item.status)) {
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
          timestamp: Date.now(),
          endTime: Date.now(),
          _samples: item._samples.slice(-120)
        };
       this.history.push(histEntry);
       if (this.history.length > 500) this.history = this.history.slice(-500);
       this._saveHistory();
       this.items.delete(id);
       if (item.tempDir) {
         fsp.rm(item.tempDir, { recursive: true, force: true }).catch(() => {});
       }
       this.onUpdate({ _removed: id });
     }
   }
 }

module.exports = { DownloadManager, sanitizeName, requestWithRedirects, resolveUrl, isExpiredError, categorizeError, resolveStreamtape, resolveSupjav, resolveCnPorn, resolveXVideos, resolveXHamster, isHlsUrl, parseHlsPlaylist, pickHlsVariant };
