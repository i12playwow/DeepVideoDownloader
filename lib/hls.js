// HLS playlist parsing, variant selection, and the PNG-decoy strip for
// tiktokcdn segments. Pure functions — no I/O, no state.

const { URL } = require("url");

const HLS_RE = /\.m3u8([?#]|$)/i;
const HLS_MASTER_RE = /#EXT-X-STREAM-INF/i;
const HLS_AES_RE = /#EXT-X-KEY:METHOD=AES-128/i;

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

// Some CDNs (turbosplayer behind sextb pages) inject AD-IMAGE URLs into
// "master.m3u8" media playlists as fake segments — downloading them fetches
// thousands of ad images, not video. A segment URL is an ad artifact when it
// is a tiktokcdn ad-site host/path or an image-shaped link (~tplv/…~…image,
// .jpg/.png/…). Real signed tiktokcdn .ts/.m4s segments (supjav/turbovidhls,
// PNG-decoy case) never match.
const AD_SITE_HOST_RE = /(?:^|[-.])ad-site[^-]*tiktokcdn\.com/i;
const AD_SITE_PATH_RE = /\/ad-site-/i;
const AD_IMAGE_EXT_RE = /\.(?:image|jpe?g|png|webp|gif)(?:$|[?#])/i;
function isAdSegmentUrl(u) {
  const s = String(u || "");
  if (!s) return false;
  try {
    const url = new URL(s);
    if (AD_SITE_HOST_RE.test(url.hostname)) return true;
  } catch (e) { /* fall through to path checks */ }
  return AD_SITE_PATH_RE.test(s) || AD_IMAGE_EXT_RE.test(s);
}

// Split a parsed segment list into video vs ad-image segments.
function classifySegments(segs) {
  let video = 0, ad = 0;
  for (const u of segs || []) {
    if (isAdSegmentUrl(u)) ad++;
    else video++;
  }
  return { video, ad };
}

// HLS variant/master family: a master playlist like
//   https://host/<hash>/playlist.m3u8
// and its quality variants like
//   https://host/<hash>/720p/video.m3u8
// describe the SAME stream. Capturing both (the extension relays whatever the
// player pulled) downloads the full-res master AND the player-chosen variant —
// duplicating the download (seen as the 997MB + 406MB 360p pair). matchHlsMaster
// returns the master URL(s) a variant URL belongs to, so the downloader can
// treat the variant as redundant once the master is downloaded/queued.
// Returns [] for master playlists themselves, plain .mp4, or unrelated URLs.
function matchHlsMaster(url) {
  try {
    const u = new URL(String(url || ""));
    const segs = u.pathname.split("/").filter(Boolean);
    if (!segs.length || !/\.m3u8([?#]|$)/i.test(u.pathname)) return [];
    const name = segs[segs.length - 1].replace(/\.m3u8.*$/i, "");
    const dir = segs.length >= 2 ? segs[segs.length - 2] : ""; // path segment holding the playlist
    // A variant media playlist is named "video.m3u8" (surrit), or lives under a
    // quality dir (<hash>/360p/video.m3u8, <hash>/hls/index.m3u8). Canonical
    // master names (playlist/master/index/manifest.m3u8) are NOT variants.
    const fileNameIsVariant = /^video$/i.test(name);
    const dirIsQuality = /(?:\d{3,4}p|hls|sd|hd|uhd|fhd|v\d+|default|low|high)/i.test(dir);
    // Non-canonical masters carry NO quality marker, so a captured variant named
    // <stem>_<qual>.m3u8 (mux.dev style: x36xhzz_360p.m3u8) maps back to the
    // same-dir <stem>.m3u8 master even though it isn't named playlist/master.
    const stemMaster = /^(.+?)[_-](?:\d{3,4}p|\d{3,4}x\d{3,4}|hevc|avc|hls|sd|hd|uhd|fhd|low|high|default)$/i.exec(name);
    if (!fileNameIsVariant && !dirIsQuality && !stemMaster) return [];
    const out = [];
    if (stemMaster) {
      const baseS = "/" + segs.slice(0, segs.length - 1).join("/") + "/";
      const c = u.origin + baseS + stemMaster[1] + ".m3u8";
      if (c !== u.origin + u.pathname && !out.includes(c)) out.push(c);
    }
    // Parent dir takes precedence (surrit: <hash>/playlist.m3u8 above <hash>/360p/video.m3u8);
    // same-dir as a secondary fallback (<hash>/video.m3u8 + <hash>/master.m3u8).
    const cut = segs.length - (dirIsQuality ? 2 : 1);
    const base = (cut > 0 ? "/" + segs.slice(0, cut).join("/") : "") + "/";
    for (const n of ["playlist.m3u8", "master.m3u8", "index.m3u8"]) {
      const c = u.origin + base + n;
      if (c !== u.origin + u.pathname && !out.includes(c)) out.push(c);
    }
    if (dirIsQuality) {
      const cut2 = segs.length - 1;
      const base2 = "/" + segs.slice(0, cut2).join("/") + "/";
      for (const n of ["playlist.m3u8", "master.m3u8", "index.m3u8"]) {
        const c = u.origin + base2 + n;
        if (c !== u.origin + u.pathname && !out.includes(c)) out.push(c);
      }
    }
    return out;
  } catch (e) { return []; }
}

module.exports = { HLS_RE, HLS_MASTER_RE, HLS_AES_RE, isHlsUrl, stripPngPrefix, parseHlsPlaylist, pickHlsVariant, matchHlsMaster, isAdSegmentUrl, classifySegments };