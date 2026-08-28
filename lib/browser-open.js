// Throttled auto-open queue for requires-browser URLs.
//
// When many Cloudflare/anti-bot links are pasted at once, opening a browser
// tab per item would choke the browser. We open them a few at a time, spaced
// out, dedupe by URL, and skip intermediate player iframes (e.g. supjav.php?l=)
// which only resolve inside an already-open page.
//
// The actual tab-opener is injected by main.js via setOpener(createBrowserWindow)
// so this module stays testable outside Electron.

const { SJ_PLAYER_RE } = require("./resolvers");

const browserOpenQueue = [];
const browserOpenSeen = new Set();
let browserOpenActive = 0;
const BROWSER_OPEN_MAX = 3;        // concurrent browser-tab opens
const BROWSER_OPEN_GAP_MS = 2500;  // spacing between opens
let opener = function () {};

function setOpener(fn) {
  if (typeof fn === "function") opener = fn;
}

// filter: skip intermediate player iframes (supjav.php?l=); dedupe: ignore repeats.
function enqueueOpen(url, { filter = true, dedupe = true } = {}) {
  if (!/^https?:/i.test(url)) return;
  if (filter && SJ_PLAYER_RE.test(url)) return;
  if (dedupe && browserOpenSeen.has(url)) return;
  if (dedupe) browserOpenSeen.add(url);
  browserOpenQueue.push(url);
  pumpBrowserOpens();
}

// Auto path (requires-browser): skip supjav iframes + dedupe.
function queueBrowserOpen(url) {
  enqueueOpen(url, { filter: true, dedupe: true });
}

// Explicit user "open in browser" of a batch: open a few at a time, but honor
// the user's intent (no iframe skip, no dedupe). This is what stops a paste of
// dozens of supjav URLs from spawning dozens of heavy tabs at once.
function queueBrowserOpenMany(urls) {
  const list = Array.isArray(urls) ? urls : [urls];
  for (const u of list) enqueueOpen(u, { filter: false, dedupe: false });
}

function pumpBrowserOpens() {
  while (browserOpenActive < BROWSER_OPEN_MAX && browserOpenQueue.length) {
    browserOpenActive++;
    const u = browserOpenQueue.shift();
    try { opener(u); } catch (e) { /* ignore */ }
    setTimeout(() => { browserOpenActive--; pumpBrowserOpens(); }, BROWSER_OPEN_GAP_MS);
  }
}

module.exports = { queueBrowserOpen, queueBrowserOpenMany, pumpBrowserOpens, setOpener, BROWSER_OPEN_MAX, BROWSER_OPEN_GAP_MS };
