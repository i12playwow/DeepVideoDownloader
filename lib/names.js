// Filename sanitization and deriving display titles from embed URL slugs.

const { URL } = require("url");

function sanitizeName(name) {
  const clean = String(name || "video")
    .replace(/[<>:"/\\|?*\r\n\t]+/g, "_")
    .replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, "_")  // fallback: keep printable Unicode + ASCII
    .trim()
    .replace(/^\.+|\.+$/g, "")  // strip leading/trailing dots
    .slice(0, 180) || "video";
  return clean.replace(/\.(mp4|m4v|webm|mov|mkv|flv|m3u8)$/i, "");
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

// Fallback title derived straight from a URL when the sender gave neither a
// title nor a usable referer (bulk URL paste, the windowed addPending path).
// Uses the last meaningful path segment (a movie code like "abc-123" or the
// media file stem) so files don't all land as "video.mp4".
const MEDIA_EXT_RE = /\.(mp4|m4v|webm|mov|mkv|flv|ts|m3u8)([?#]|$)/i;
const SKIP_SEG_RE = /^(supjav\.php|video|watch|player|embed|index|play|stream|hls|hd|sd|360p|720p|1080p)$/i;
function titleFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    if (!parts.length) return u.hostname;
    let seg = parts[parts.length - 1];
    seg = seg.split(/[?#]/)[0];
    seg = seg.replace(MEDIA_EXT_RE, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    if (seg && !SKIP_SEG_RE.test(seg)) return decodeURIComponent(seg).trim() || u.hostname;
    return u.hostname;
  } catch (e) {
    return "";
  }
}

module.exports = { sanitizeName, titleFromReferer, titleFromUrl };