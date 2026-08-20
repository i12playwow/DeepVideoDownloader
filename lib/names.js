// Filename sanitization and deriving display titles from embed URL slugs.

const { URL } = require("url");

function sanitizeName(name) {
  const clean = String(name || "video").replace(/[\\/:*?"<>|\r\n\t]+/g, "_").trim().slice(0, 180) || "video";
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

module.exports = { sanitizeName, titleFromReferer };