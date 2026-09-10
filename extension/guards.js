// Shared URL-guard core for the Deep Grab extension: the ad-network blocklist,
// the junk-host blocklist, and the streamtape get_video matcher. Loaded as a
// classic script BEFORE content.js (extension/manifest.json content_scripts)
// and via importScripts("guards.js") at the top of background.js, so both
// files call the SAME functions — a host added here is rejected everywhere
// (the 2026-09-03 supjav ad-network drift landed in content.js only and leaked
// through background's webRequest capture until aligned). Top-level
// declarations make the names visible to both consumers in the browser
// (isolated-world global for the content script, worker global for the SW);
// under Node the same code is module.exports'd for the harness.
//
// This file must stay dependency-free: no chrome.*, no imports — it is shared
// verbatim between two script contexts.

// Ad-network hosts whose streams/players must never be captured as videos.
const AD_DOMAINS = /(?:^|\.)(?:doubleclick\.net|googlesyndication\.com|adservice\.google\.com|ads\.youtube\.com|adroll\.com|criteo\.com|taboola\.com|outbrain\.com|adnxs\.com|amazon-adsystem\.com|adform\.net|adcolony\.com|smartadserver\.com|rubiconproject\.com|pubmatic\.com|openx\.net|appnexus\.com|casalemedia\.com|adsrvr\.org|exoclick\.com|popads\.net|propellerads\.com|mgid\.com|revcontent\.com|adsterra\.com|juicyads\.com|eix304\.com|tapioni\.com|mnaspm\.com|mayzaent\.com|googletagmanager\.com|djsalcbhew47\.lol)$/i;
function isAdUrl(u) {
  if (!u) return false;
  try { return AD_DOMAINS.test(new URL(u, typeof location !== "undefined" && location.href ? location.href : undefined).hostname); } catch (e) { return false; }
}

// streamtape/fstape serve the file from /get_video?.. (no extension) — match it
// by host so webRequest captures it in suspended/background tabs too.
const ST_GETVIDEO_RE = /^https?:\/\/(?:[^/]*\.)?(?:streamtape|fstape)\.com\/get_video\?/i;

// Dev/portal/tooling hosts that never serve JAV media. They leak into the
// capture flow when the user's real Chrome browses them while Deep Grab is
// active (github, google accounts/policies/mail, firecrawl, download managers,
// violentmonkey, etc.). Rejecting here keeps them from ever reaching the app.
const JUNK_BASE_RE = /(?:^|\.)(github\.io|github\.com|google\.com|google\.dev|googleapis\.com|firecrawl\.dev|jdownloader\.org|violentmonkey\.github\.io|webextension\.org|internetdownloadmanager\.com|vn-zoom\.com|wikipedia\.org)$/i;
function isJunkUrl(u) {
  if (!u || !/^(?:https?):/i.test(u)) return false;
  try {
    const host = new URL(u).hostname.toLowerCase().replace(/^www\./, "");
    if (host && !/[.:]/.test(host)) return true;
    if (/^0\.0\.0\.[0-9]+$/.test(host)) return true;
    return JUNK_BASE_RE.test(host);
  } catch (e) { return false; }
}

if (typeof module === "object" && module.exports) {
  module.exports = { AD_DOMAINS, isAdUrl, ST_GETVIDEO_RE, JUNK_BASE_RE, isJunkUrl };
}