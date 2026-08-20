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

module.exports = { HLS_RE, HLS_MASTER_RE, HLS_AES_RE, isHlsUrl, stripPngPrefix, parseHlsPlaylist, pickHlsVariant };