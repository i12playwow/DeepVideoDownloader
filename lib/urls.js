"use strict";
// URL normalization for captured item sources. Tab-suspender and lazy-load
// browser extensions rewrite real page URLs into chrome-extension:// wrapper
// pages (e.g. .../suspended.html#ttl=...&pos=0&uri=<real URL>). Those must
// never reach the download engine as-is: Node's http/https libs reject the
// chrome-extension: scheme, so such items would fail with a confusing
// "Protocol not supported" error. Unwrap the embedded http(s) target when one
// exists; otherwise return the input unchanged so callers can decide.

function unwrapExtensionUrl(url) {
  if (!url || typeof url !== "string") return url;
  if (!/^(?:chrome|moz)-extension:\/\//i.test(url)) return url;
  const hash = url.indexOf("#");
  if (hash === -1) return url;
  let frag = url.slice(hash + 1);
  const uri = /[?&]uri=([^&]+)/i.exec(frag);
  if (uri) frag = uri[1];
  let s = frag;
  for (let i = 0; i < 4; i++) {
    const m = /https?:\/\/[^\s"'<>]+/i.exec(s);
    if (m) return m[0];
    let next;
    try { next = decodeURIComponent(s); } catch (e) { break; }
    if (next === s) break;
    s = next;
  }
  return url;
}

module.exports = { unwrapExtensionUrl };