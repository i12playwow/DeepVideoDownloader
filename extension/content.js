// Content script: deep multi-keyword filter, infinite scroll, MP4 sniffing,
// one-click new-tab toggle, found-video panel with per-video "Add to list".

(() => {
  if (window.__DEEPVID_INJECTED__) return;
  window.__DEEPVID_INJECTED__ = true;

  // The extension runs in every frame (manifest all_frames:true). Only the
  // top frame should build the UI and run the periodic scans — otherwise a
  // page full of iframes spawns dozens of toolbars + scan loops that peg the
  // CPU. Network capture still happens globally via background.js webRequest.
  const IS_TOP = (window === window.top);

  // Ad-network hosts whose streams/players must never be captured as videos.
  const AD_DOMAINS = /(?:^|\.)(?:doubleclick\.net|googlesyndication\.com|adservice\.google\.com|ads\.youtube\.com|adroll\.com|criteo\.com|taboola\.com|outbrain\.com|adnxs\.com|amazon-adsystem\.com|adform\.net|adcolony\.com|smartadserver\.com|rubiconproject\.com|pubmatic\.com|openx\.net|appnexus\.com|casalemedia\.com|adsrvr\.org|exoclick\.com|popads\.net|propellerads\.com|mgid\.com|revcontent\.com|adsterra\.com|juicyads\.com|eix304\.com|tapioni\.com|mnaspm\.com|mayzaent\.com|googletagmanager\.com|djsalcbhew47\.lol)$/i;
  const isAdUrl = (u) => {
    if (!u) return false;
    try { return AD_DOMAINS.test(new URL(u, location.href).hostname); } catch (e) { return false; }
  };

  const DEFAULT_CONFIG = {
    autoScroll: true,
    openInNewTab: false,
    matchAll: false,
    loadMoreSelector: "",
    cardSelector: "",
    deepSearch: "",
    videoSelectors: "",
    typeFilter: "all",
    minSizeMB: 0,
    bestOnly: true,
    autoGrab: true,
    autoCloseTab: true,
    pipelineQty: 0,
    // Always-on background link crawler (ON by default = no toggle needed).
    // When set, every captured link match (video URL, JAV movie page, host dl
    // entry) is auto-sent to the desktop app the moment the page scan reports
    // it — unlike maybeAutoDownload, which only fires for the best-only video
    // path while the manual "Send" toggle (grabOn) is armed.
    autoCrawl: true
  };

  let config = { ...DEFAULT_CONFIG };
  let state = {
    keyword: "",
    matchAll: false,
    autoScroll: false,
    newTabMode: false,
    scanTries: 0,
    lastHeight: 0
  };

  // Page-side bookkeeping + render mirror for the in-page toolbar. The
  // service worker's `found` list is the SINGLE canonical source: every scan
  // reports here (video-found) and the toolbar re-syncs from the SW. Do not
  // treat this map as a second truth — counts must come from the SW.
  const found = new Map(); // url -> {title, size, added}
  let selected = new Set(); // urls picked for batch actions
  const autoPending = new Set(); // best-only URLs stashed while offline
  const autoSending = new Set(); // best-only URLs with a send in flight
  let lastRefresh = 0;

  // streamtape/fstape embed URLs carry the video name as a slug
  // (/v/<id>/My-Video-Name); the embed <title> is generic/empty, so prefer it.
  function slugTitle(url) {
    try {
      const u = new URL(url);
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

  // ---------- keyword parsing ----------
  function parseKeywords(raw) {
    return String(raw || "")
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
  }

  function matchesKeywords(text, keywords, matchAll) {
    if (!keywords.length) return true;
    if (matchAll) return keywords.every((k) => text.includes(k));
    return keywords.some((k) => text.includes(k));
  }

  // Size/type rules. Unknown size (0) passes — it is shown until a probe
  // reports the real size, then the list re-renders in real time.
  function matchesRules(v) {
    const t = config.typeFilter || "all";
    if (t !== "all" && v.kind !== t) return false;
    const minB = (config.minSizeMB || 0) * 1024 * 1024;
    if (minB > 0 && v.size > 0 && v.size < minB) return false;
    return true;
  }

  // ---------- DOM helpers ----------
  function domReady(fn) {
    if (document.readyState === "interactive" || document.readyState === "complete") {
      fn();
    } else {
      document.addEventListener("DOMContentLoaded", fn);
    }
  }

  function getCards() {
    let list;
    if (config.cardSelector) {
      list = Array.from(document.querySelectorAll(config.cardSelector));
    } else {
      list = Array.from(document.querySelectorAll("article, li, [class*=post], [class*=item], [class*=card], [class*=entry]"))
        .filter((el) => el.querySelector("a[href]") && el.getBoundingClientRect().width > 40);
      list = list.filter((el) => !list.some((other) => other !== el && other.contains(el)));
    }
    return list;
  }

  function cardText(el) {
    const parts = [
      el.textContent || "",
      el.getAttribute("title") || "",
      el.getAttribute("alt") || "",
      el.getAttribute("data-name") || "",
      el.getAttribute("aria-label") || "",
      Array.from(el.querySelectorAll("img, video, source")).map((m) => (m.getAttribute("alt") || m.getAttribute("title") || m.getAttribute("src") || "")).join(" ")
    ];
    return parts.join(" ").toLowerCase();
  }

  function applyFilter() {
    const keywords = parseKeywords(state.keyword);
    const cards = getCards();
    let shown = 0;
    cards.forEach((el) => {
      if (matchesKeywords(cardText(el), keywords, state.matchAll)) {
        el.style.display = "";
        shown++;
      } else {
        el.style.display = "none";
      }
    });
    const active = keywords.length > 0 && cards.length > 0;
    if (active) document.body.setAttribute("data-dv-filtering", "1");
    else document.body.removeAttribute("data-dv-filtering");
    return shown;
  }

  // ---------- video sniffing ----------
  const ST_GETVIDEO_RE = /^https?:\/\/(?:[^/]*\.)?(?:streamtape|fstape)\.com\/get_video\?/i;
  function looksLikeVideoUrl(u) {
    if (!u) return false;
    if (isAdUrl(u)) return false; // never treat ad-network streams as videos
    try {
      const url = new URL(u, location.href);
      if (/\.(mp4|m4v|webm|mov|mkv|flv|m3u8)([?#]|$)/i.test(url.href)) return true;
      if (ST_GETVIDEO_RE.test(url.href)) return true;
      return /(\/video\/|\/videos\/|\/stream\/|\/media\/|\/playlist\/)/i.test(url.href);
    } catch (e) {
      return false;
    }
  }

  function kindOf(u) {
    return /\.m3u8([?#]|$)/i.test(u) ? "m3u8" : "mp4";
  }

  function tryCapture(url, title, sourceEl) {
    if (isAdUrl(url)) return; // bypass ads — never capture ad-network streams
    // a real <video> element's src is video even when the URL has no video markers
    const isVideoEl = !!(sourceEl && sourceEl.tagName === "VIDEO");
    if (!isVideoEl && !looksLikeVideoUrl(url)) return;
    if (url.startsWith("blob:")) return;
    // Resolve relative <video src="/media/x.mp4"> and protocol-relative srcs to
    // absolute so the element scan catches them (the webRequest net-capture also
    // sees the request, but MV3 webRequest does not wake the SW, so a dead SW at
    // request time would otherwise lose the video entirely).
    const clean = url.startsWith("//") ? location.protocol + url
      : /^[a-z][a-z0-9+.-]*:/i.test(url) ? url
      : (() => { try { return new URL(url, location.href).href; } catch (e) { return url; } })();
    // Only fetchable schemes: tab-suspender/lazy-load chrome-extension pages
    // (…/suspended.html#uri=<url>) and other browser-internal schemes are junk.
    if (!/^(?:https?|blob):/i.test(clean)) return;
    // streamtape/fstape embed <title> is generic/empty, but the URL slug has
    // the video name — prefer it as the fallback title.
    const pageTitle = slugTitle(location.href) || document.title;

    if (config.bestOnly) {
      // Keep exactly ONE entry: an HLS master (the full movie behind most
      // Cloudflare/anti-bot players) outranks any MP4 highlight and is never
      // dropped; among MP4s the highest resolution wins and ties keep the
      // current entry. The keep/replace decision (bestOnlyNext) lives in
      // best-only.js, shared with test-best-only.js so the test cannot drift.
      if (found.has(clean)) return;
      const kind = isHls(clean) ? "m3u8" : "mp4";
      const _rank = kind === "m3u8" ? BEST_ONLY_HLS_RANK : qualityRank(clean, sourceEl);
      const cur = found.size ? found.values().next().value : null;
      if (cur && bestOnlyNext(cur, { url: clean, kind, _rank }) === cur) return;
      if (cur) {
        found.delete(cur.url);
        chrome.runtime.sendMessage({ type: "remove-found", urls: [cur.url] }).catch(() => {});
      }
      const titleText = (title || pageTitle || clean.split("/").pop()).trim();
      found.set(clean, { url: clean, title: titleText, size: 0, added: false, kind, _rank });
      chrome.runtime.sendMessage({ type: "video-found", url: clean, title: titleText, pageUrl: location.href, kind }).catch(() => {});
      maybeAutoDownload(clean);
      // Always-on crawler: same entry also auto-sends when the manual Send
      // toggle is off (autoSending dedupe makes this a no-op if grabOn sent).
      maybeAutoCrawl(clean);
      renderFoundList();
      updateCounts();
      return;
    }

    if (found.has(clean)) return;
    const titleText = (title || pageTitle || clean.split("/").pop()).trim();
    found.set(clean, { url: clean, title: titleText, size: 0, added: false, kind: kindOf(clean) });
    chrome.runtime.sendMessage({ type: "video-found", url: clean, title: titleText, pageUrl: location.href, kind: kindOf(clean) }).catch(() => {});
    // Always-on crawler: non-best-only video links (scanPageLinks) auto-send.
    maybeAutoCrawl(clean);
    renderFoundList();
    updateCounts();
  }

  const DEFAULT_VIDEO_SELECTORS = "video[src], video source[src], video source[type*='mp4'], source[type*='mp4'], source[src*='.mp4'], [data-src*='.mp4'], [data-video*='.mp4'], [data-mp4*='.mp4']";

  function scanVideoElements() {
    const seen = new Set();
    const custom = String(config.videoSelectors || "")
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const selector = custom.length ? DEFAULT_VIDEO_SELECTORS + ", " + custom.join(", ") : DEFAULT_VIDEO_SELECTORS;
    let videoEls = [];
    try {
      videoEls = document.querySelectorAll(selector);
    } catch (e) {
      console.warn("DeepVid: Invalid custom selector, falling back to default.", e);
      videoEls = document.querySelectorAll(DEFAULT_VIDEO_SELECTORS);
    }
    videoEls.forEach((el) => {
      const src = el.getAttribute("src") || el.getAttribute("data-src") || el.getAttribute("data-video") || el.getAttribute("data-mp4") || (el.currentSrc || "");
      if (src && !seen.has(src)) {
        seen.add(src);
        tryCapture(src, (el.getAttribute("title") || el.getAttribute("alt") || "").trim(), el);
      }
    });
  }

  function scanPageLinks() {
    document.querySelectorAll("a[href]").forEach((a) => {
      if (a.href && looksLikeVideoUrl(a.href)) tryCapture(a.href, a.textContent.trim());
    });
  }

  // On supjav list pages (category / popular / search / pagination) the items are
  // movie *pages*, not media files. Capture those page URLs as "link" sources so
  // the desktop resolver can open each one and pull its stream.
  function isSupjavHostname(h) {
    return /(?:supjav|supremejav)\.(?:com|ph|net)$/i.test(h);
  }
  function isSextbHostname(h) {
    return /(?:sextb)\.(?:net|cc)$/i.test(h);
  }
  function isJavHostname(h) {
    return isSupjavHostname(h) || isSextbHostname(h);
  }
  function isSupjavMoviePath(p) {
    if (!/\.html?$/i.test(p)) return false;
    if (/^\/(popular|search|category|tag|actor|genre|studio|series|playlist|page|top|latest|random|ranking|update|hd|cn|us|forum|faq|contact|uncensored|subbed|leak|best|most|watch|trending|censored|english|dubbed|4k|vr|feed|rss|atom|api|ajax|wp-json|wp-admin|author|date|embed|oembed)\b/i.test(p)) return false;
    return true;
  }
  function isSextbMoviePath(p) {
    const m = /^\/([^/]+)\/?$/i.exec(p);
    if (!m) return false;
    if (/^\/(genre|actor|actress|list|jav|category|categories|tag|tags|search|page|top|latest|popular|model|free-cams|user|terms|privacy|contact|faq|about|login|register|stream|watch|studio|studios|series|playlist|invite-ads|private|genres|new-releases|dmca|download|slut|hot|best|most|censored|uncensored|feed|rss|atom|api|ajax|wp-json|wp-content|wp-admin|wp-includes|trackback|xmlrpc|author|date|embed|oembed)\b/i.test(p)) return false;
    return /\d/.test(m[1]);
  }
  function isJavMoviePath(p) {
    return isSupjavMoviePath(p) || isSextbMoviePath(p);
  }
  function scanSupjavList() {
    if (!isJavHostname(location.hostname)) return;
    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.href;
      if (!href) return;
      let u;
      try { u = new URL(href); } catch (e) { return; }
      if (!isJavHostname(u.hostname) || !isJavMoviePath(u.pathname)) return;
      // Skip self-links / in-page anchors (e.g. the Cloudflare "Reload once"
      // banner is <a href="#">, which resolves to `this page` + "#" and must
      // never be misread as a movie/related-link). A movie is a DIFFERENT page.
      const rawHref = (a.getAttribute("href") || "").trim();
      if (rawHref === "" || rawHref === "#" || rawHref.startsWith("#")) return;
      const currentNoHash = location.href.split("#")[0];
      if (u.href.split("#")[0] === currentNoHash) return;
      const title = (a.getAttribute("title") || a.textContent || "").trim() || document.title;
      tryCaptureMoviePage(href, title);
    });
  }
  function tryCaptureMoviePage(url, title) {
    if (isAdUrl(url)) return;
    const clean = url.startsWith("//") ? location.protocol + url : url;
    if (!/^(?:https?):/i.test(clean)) return;
    if (found.has(clean)) return;
    const titleText = (title || clean.split("/").pop()).trim();
    found.set(clean, { url: clean, title: titleText, size: 0, added: false, kind: "link", _rank: 0 });
    chrome.runtime.sendMessage({ type: "video-found", url: clean, title: titleText, pageUrl: location.href, kind: "link" }).catch(() => {});
    // Always-on crawler: JAV movie pages auto-send to the desktop resolver.
    maybeAutoCrawl(clean);
    renderFoundList();
    updateCounts();
  }

  // supjav movie pages expose real download entry points as ?dl= links that
  // redirect (server-side) to the file host (RapidGator / keep2share). Capture
  // them so the user can export / hand them to the desktop resolver.
  function isSupjavDlUrl(raw) {
    if (!/[?&]dl=[^&"'\s]+/i.test(raw)) return false;
    if (/^https?:\/\//i.test(raw)) {
      try { return isSupjavHostname(new URL(raw).hostname); } catch (e) { return false; }
    }
    return true;
  }
  function scanSupjavDl() {
    if (!isJavHostname(location.hostname)) return;
    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href");
      if (!href || !isSupjavDlUrl(href)) return;
      const clean = href.startsWith("//") ? location.protocol + href : href;
      const label = (a.getAttribute("title") || a.textContent || "").trim() || "supjav download";
      tryCaptureDl(clean, label);
    });
  }
  function tryCaptureDl(url, title) {
    if (isAdUrl(url)) return;
    const clean = url.startsWith("//") ? location.protocol + url : url;
    if (!/^(?:https?):/i.test(clean)) return;
    if (found.has(clean)) return;
    const titleText = title || "supjav download";
    found.set(clean, { url: clean, title: titleText, size: 0, added: false, kind: "link", _rank: 0 });
    chrome.runtime.sendMessage({ type: "video-found", url: clean, title: titleText, pageUrl: location.href, kind: "link" }).catch(() => {});
    // Always-on crawler: host dl entries auto-send to the desktop resolver.
    maybeAutoCrawl(clean);
    renderFoundList();
    updateCounts();
  }

  // cnporn.org video pages: the player is a lazy /embed/<uuid> iframe whose
  // sources live in the embed page's inline JS — never in a DOM attribute.
  // Fetch the embed (same-origin) and report the mp4/m3u8 so the user doesn't
  // have to press play first. Each embed is resolved once.
  const resolvedEmbeds = new Set();
  async function extractCnPorn() {
    if (!/cnporn\.org/i.test(location.hostname)) return;
    const embeds = new Set();
    document.querySelectorAll("iframe[data-src], iframe[src], [data-server]").forEach((el) => {
      const v = (el.getAttribute("data-src") || el.getAttribute("src") || el.getAttribute("data-server") || "").trim();
      if (/\/embed\//i.test(v)) {
        embeds.add(/^https?:\/\//i.test(v) ? v : location.origin + (v.startsWith("/") ? "" : "/") + v);
      }
    });
    for (const u of embeds) {
      if (resolvedEmbeds.has(u)) continue;
      resolvedEmbeds.add(u);
      try {
        const html = await (await fetch(u)).text();
        const m = /"file"\s*:\s*"([^"]+\.(?:mp4|m3u8)[^"]*)"/i.exec(html);
        if (!m) continue;
        const url = m[1].replace(/\\\//g, "/");
        if (found.has(url)) continue;
        const h1 = document.querySelector("#video-name, .movie-info h1, h1");
        const title = (h1 ? h1.textContent.trim() : "") || document.title.replace(/\s*-\s*[^-]*$/, "");
        const kind = /\.mp4([?#]|$)/i.test(url) ? "mp4" : "m3u8";
        found.set(url, { url, title, size: 0, added: false, kind, _rank: 0 });
        chrome.runtime.sendMessage({ type: "video-found", url, title, pageUrl: location.href, kind }).catch(() => {});
        renderFoundList();
        updateCounts();
      } catch (e) { /* embed fetch failed — webRequest capture remains the fallback */ }
    }
  }

  // missav.com & anti-bot tube sites: the full video lives on a /player/ or
  // /embed/ page (or lazy iframe) whose source is in the player page's DOM/JS —
  // never in a listing-page attribute. Fetch the player page same-origin (the
  // extension runs in the page, so the request carries the Cloudflare session
  // the browser already solved) and report the mp4/m3u8. Each player resolved once.
  const resolvedMissav = new Set();
  async function extractMissav() {
    if (!/missav\d*\.(ws|ai|com|live|xyz)/i.test(location.hostname)) return;
    const players = new Set();
    document.querySelectorAll("a[href], iframe[src], iframe[data-src]").forEach((el) => {
      const v = (el.getAttribute("href") || el.getAttribute("src") || el.getAttribute("data-src") || "").trim();
      if (!v) return;
      if (/\/player\//i.test(v) || /\/embed\//i.test(v)) {
        players.add(/^https?:\/\//i.test(v) ? v : location.origin + (v.startsWith("/") ? "" : "/") + v);
      }
    });
    for (const u of players) {
      if (resolvedMissav.has(u)) continue;
      resolvedMissav.add(u);
      try {
        const html = await (await fetch(u)).text();
        let m = /<video[^>]*>\s*<source[^>]+src=["']([^"']+\.(?:mp4|m3u8|webm)[^"']*)["']/i.exec(html);
        if (!m) m = /<video[^>]+src=["']([^"']+\.(?:mp4|m3u8|webm)[^"']*)["']/i.exec(html);
        if (!m) m = /["']file["']\s*:\s*["']([^"']+\.(?:mp4|m3u8|webm)[^"']*)["']/i.exec(html);
        if (!m) continue;
        const url = m[1].replace(/\\\//g, "/");
        if (found.has(url)) continue;
        const kind = /\.m3u8([?#]|$)/i.test(url) ? "m3u8" : "mp4";
        const h1 = document.querySelector("#video-name, .movie-info h1, h1");
        const title = (h1 ? h1.textContent.trim() : "") || document.title.replace(/\s*-\s*[^-]*$/, "");
        found.set(url, { url, title, size: 0, added: false, kind, _rank: 0 });
        chrome.runtime.sendMessage({ type: "video-found", url, title, pageUrl: location.href, kind }).catch(() => {});
        renderFoundList();
        updateCounts();
      } catch (e) { /* player fetch failed — webRequest capture remains the fallback */ }
    }
  }

  // supjav movie pages load the actual stream inside a supjav.php?l=<OLID>
  // player iframe (which matches neither /player/ nor /embed/). The app's
  // desktop resolver (resolveSupjav) needs that exact player URL — it reverses
  // the id, fetches ?c=<reversed> and follows the 302 to the streamtape/fstape
  // embed or turbovidhls m3u8, all server-side and headless-friendly. Without
  // it an item stays a raw movie page that only a CF-solved browser tab can
  // open. So capture the iframe's player URL as a `link` source (never the
  // anti-bot gated stream itself) and let resolveUrl resolve it.
  const resolvedSupjav = new Set();
  const SUPJAV_PLAYER_RE = /(?:supjav|supremejav)\.(?:com|ph|net)[^"'\s]*\bsupjav\.php/i;
  async function extractSupjav() {
    if (!isSupjavHostname(location.hostname)) return;
    if (!/\.html?$/i.test(location.pathname) || isAdUrl(location.href)) return;
    const players = new Set();
    document.querySelectorAll("iframe[src], iframe[data-src], [data-server], [data-player]").forEach((el) => {
      const v = (el.getAttribute("src") || el.getAttribute("data-src") || el.getAttribute("data-server") || el.getAttribute("data-player") || "").trim();
      if (!v) return;
      if (SUPJAV_PLAYER_RE.test(v) || /supjav\.php/i.test(v) || /(?:^|[?&])player=/i.test(v)) {
        players.add(/^https?:\/\//i.test(v) ? v : location.origin + (v.startsWith("/") ? "" : "/") + v);
      }
    });
    // In-page reference: some themes inline the player URL in an attribute or
    // data-* on the page (not an iframe). The userscript reads frame src/defaultSrc;
    // also grep the rendered DOM for a direct supjav.php?l= reference.
    document.querySelectorAll("a[href], [data-src], [data-url], [data-frame]").forEach((el) => {
      const v = (el.getAttribute("href") || el.getAttribute("data-src") || el.getAttribute("data-url") || el.getAttribute("data-frame") || "").trim();
      if (v && SUPJAV_PLAYER_RE.test(v)) players.add(/^https?:\/\//i.test(v) ? v : location.origin + (v.startsWith("/") ? "" : "/") + v);
    });
    const seen = new Set(Array.from(found.keys()));
    for (const u of players) {
      if (seen.has(u) || found.has(u)) continue;
      if (resolvedSupjav.has(u)) continue;
      resolvedSupjav.add(u);
      const kind = "link";
      const titleText = (document.title.replace(/\s*-\s*[^-]*$/, "") || location.href.split("/").pop() || "").trim();
      found.set(u, { url: u, title: titleText, size: 0, added: false, kind, _rank: 0 });
      chrome.runtime.sendMessage({ type: "video-found", url: u, title: titleText, pageUrl: location.href, kind }).catch(() => {});
      maybeAutoDownload(u);
      renderFoundList();
      updateCounts();
    }
  }

  function hookNetwork() {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      if (typeof url === "string" && looksLikeVideoUrl(url)) tryCapture(url, document.title);
      return origOpen.apply(this, arguments);
    };

    const origFetch = window.fetch;
    window.fetch = async function (input) {
      let url = typeof input === "string" ? input : input && input.url;
      if (url && typeof url === "string" && looksLikeVideoUrl(url)) tryCapture(url, document.title);
      try {
        const resp = await origFetch.apply(this, arguments);
        if (resp && resp.url && looksLikeVideoUrl(resp.url)) tryCapture(resp.url, document.title);
        return resp;
      } catch (e) {
        throw e;
      }
    };

    document.addEventListener("loadedmetadata", (e) => {
      if (e.target && e.target.currentSrc) tryCapture(e.target.currentSrc, document.title);
    }, true);
    document.addEventListener("canplay", (e) => {
      if (e.target && e.target.currentSrc) tryCapture(e.target.currentSrc, document.title);
    }, true);
    document.addEventListener("play", (e) => {
      if (e.target && e.target.currentSrc) tryCapture(e.target.currentSrc, document.title);
    }, true);
  }

  // ---------- infinite scroll ----------
  function autoScrollTick() {
    if (!state.autoScroll) return;
    const doc = document.documentElement;
    if (doc.scrollHeight > state.lastHeight) state.scanTries = 0;
    state.lastHeight = doc.scrollHeight;
    window.scrollBy(0, window.innerHeight * 0.85);
    const atBottom = window.innerHeight + window.scrollY >= doc.scrollHeight - 300;
    if (atBottom && config.loadMoreSelector) {
      const btn = document.querySelector(config.loadMoreSelector);
      if (btn) btn.click();
    }
    if (atBottom) {
      if (state.scanTries > 14) {
        stopAutoScroll("Reached bottom");
        return;
      }
      state.scanTries++;
    }
  }

  function startAutoScroll() {
    state.autoScroll = true;
    state.scanTries = 0;
    state.lastHeight = document.documentElement.scrollHeight;
    window.clearInterval(window.__DV_SCROLL_ID__);
    window.__DV_SCROLL_ID__ = window.setInterval(autoScrollTick, 350);
    toast("Auto-scroll ON");
  }

  function stopAutoScroll(reason) {
    state.autoScroll = false;
    window.clearInterval(window.__DV_SCROLL_ID__);
    toast(reason || "Auto-scroll OFF");
  }

  // ---------- one-click new tab ----------
  function openInNewTab(href) {
    chrome.runtime.sendMessage({ type: "open-new-tab", url: href })
      .then(() => {})
      .catch(() => {
        // fallback if the background is unavailable
        try { window.open(href, "_blank", "noopener"); } catch (err) { /* blocked */ }
      });
  }

  function handleClick(e) {
    if (!state.newTabMode) return;
    const link = e.target.closest && e.target.closest("a[href]");
    if (!link || !link.href) return;
    const href = link.href;
    if (href === location.href || href.startsWith("javascript:")) return;
    // swallow the event completely so the page's own handlers (React routers,
    // jQuery, etc.) cannot navigate the current tab, then open via background.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    openInNewTab(href);
  }

  function handleAuxClick(e) {
    if (!state.newTabMode) return;
    const link = e.target.closest && e.target.closest("a[href]");
    if (!link || !link.href) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    openInNewTab(link.href);
  }

  // ---------- best-only mode + auto-download ----------
  function toggleBestOnly(on) {
    config.bestOnly = !!on;
    const btn = document.getElementById("dv-best");
    if (btn) btn.classList.toggle("dv-on", config.bestOnly);
    if (config.bestOnly) {
      reevaluateBest();
      scanVideoElements(); // re-capture <source> elements with quality attrs
    }
    renderFoundList();
    updateCounts();
    saveConfig();
  }

  function reevaluateBest() {
    if (!config.bestOnly) return;
    const entries = Array.from(found.values());
    // HLS (full movie master) outranks any MP4 highlight clip.
    const hlsEntry = entries.find((v) => v.kind === "m3u8");
    let bestEntry = null;
    entries.forEach((v) => {
      if (v.kind === "m3u8") { v._rank = 99; return; }
      v._rank = qualityRank(v.url);
      if (!bestEntry || v._rank > bestEntry._rank) bestEntry = v;
    });
    const keep = hlsEntry ? hlsEntry : bestEntry;
    entries.forEach((v) => {
      if (v === keep || !found.has(v.url)) return;
      found.delete(v.url);
      chrome.runtime.sendMessage({ type: "remove-found", urls: [v.url] }).catch(() => {});
    });
    if (keep && !keep.added) maybeAutoDownload(keep.url);
  }

  // Master switch for automatic sending. Default state is taken from the
  // persisted `autoGrab` config (ON by default) so a fresh page load is armed
  // and the full pipeline (CF solve -> capture -> send -> download) runs without
  // pressing "Send". The button can still toggle it per-session at any time.
  let grabOn = config.autoGrab !== false;

  function maybeAutoDownload(url) {
    if (!grabOn || !config.bestOnly) return;
    const v = found.get(url);
    if (!v || v.added || autoSending.has(url)) return;
    autoSending.add(url);
    chrome.runtime.sendMessage({ type: "add-to-list", url, title: v.title, pageUrl: location.href })
      .then(() => {
        v.added = true;
        autoSending.delete(url);
        autoPending.delete(url);
        renderFoundList();
        updateCounts();
      })
      .catch(() => {
        // background unavailable — stash and flush on the next online poll
        autoSending.delete(url);
        autoPending.add(url);
        v.added = false;
      });
  }

  function flushAutoPending() {
    if (!autoPending.size) return;
    const urls = Array.from(autoPending);
    autoPending.clear();
    urls.forEach((u) => { maybeAutoDownload(u); maybeAutoCrawl(u); });
  }

  // Always-on link crawler: auto-send every captured link match to the desktop
  // app (video URL, JAV movie page, host dl entry) without requiring the manual
  // "Send" toggle (grabOn) that gates maybeAutoDownload. Dedupe with the same
  // autoSending/autoPending sets so a URL is sent at most once per page session
  // and an offline send is re-attempted when the background comes back.
  function maybeAutoCrawl(url) {
    if (!config.autoCrawl) return;
    const v = found.get(url);
    if (!v || v.added || autoSending.has(url)) return;
    autoSending.add(url);
    chrome.runtime.sendMessage({ type: "add-to-list", url, title: v.title, pageUrl: location.href })
      .then(() => {
        v.added = true;
        autoSending.delete(url);
        autoPending.delete(url);
        renderFoundList();
        updateCounts();
      })
      .catch(() => {
        // background unavailable — stash and flush on the next online poll
        autoSending.delete(url);
        autoPending.add(url);
        v.added = false;
      });
  }

  // ---------- sync found list with background (sizes / added state) ----------
  function refreshFromBackground(force) {
    if (!force && Date.now() - lastRefresh < 2000) return;
    lastRefresh = Date.now();
    chrome.runtime.sendMessage({ type: "get-found" }, (resp) => {
      if (!resp) return;
    const grabBtn = document.getElementById("dv-grab");
    if (grabBtn) {
      grabBtn.textContent = grabOn ? "■ Send" : "▶ Send";
      grabBtn.classList.toggle("dv-on", grabOn);
    }
    const runBtn = document.getElementById("dv-run");
      if (runBtn) {
        const running = !!resp.pipelineRunning;
        runBtn.textContent = running ? "■ Stop" : "▶ Start";
        runBtn.title = running && (resp.pipelinePending || 0)
          ? `Processing ${resp.pipelinePending} tab(s) one by one — click to stop`
          : "Process streamtape/fstape tabs one by one: autoplay → send → close → next (off by default)";
        runBtn.classList.toggle("dv-on", running);
      }
      const capturedUrls = new Set((resp.captured || []).map((v) => v.url));
      (resp.found || []).forEach((v) => {
        if (config.bestOnly) {
          if (found.has(v.url)) {
            const row = found.get(v.url);
            if (v.size) row.size = v.size;
            row.added = !!v.added || capturedUrls.has(v.url);
          } else if (v.kind === "m3u8") {
            // HLS playlists can't be quality-ranked and are the only delivery
            // for Cloudflare/anti-bot sites (missav*); surface them in best-only
            // mode too so they're addable without toggling Best only off.
            found.set(v.url, {
              url: v.url,
              title: v.title || "",
              size: v.size || 0,
              added: !!v.added || capturedUrls.has(v.url),
              kind: "m3u8"
            });
          }
          return;
        }
        if (!found.has(v.url)) {
          // merge in videos found by other tabs / earlier sessions in real time
          found.set(v.url, {
            url: v.url,
            title: v.title || "",
            size: v.size || 0,
            added: !!v.added || capturedUrls.has(v.url),
            kind: v.kind === "m3u8" ? "m3u8" : "mp4"
          });
          return;
        }
        const row = found.get(v.url);
        if (v.size) row.size = v.size;
        row.added = !!v.added || capturedUrls.has(v.url);
      });
      // Prune items the app already captured/removed so they leave the panel
      // once downloading starts (keeps the list focused on what's left).
      const respUrls = new Set((resp.found || []).map((v) => v.url));
      for (const [key, v] of Array.from(found.entries())) {
        if (v.added && !respUrls.has(key)) { found.delete(key); selected.delete(key); }
      }
      renderFoundList();
      updateCounts();
    });
  }

  // ---------- Toolbar UI ----------
  // Drag the panel by its header (grab anywhere except the minimize button).
  function makeDraggable() {
    const tb = document.getElementById("dv-toolbar");
    const head = document.querySelector("#dv-toolbar .dv-head");
    if (!tb || !head) return;
    let dragging = false;
    let sx = 0, sy = 0, ox = 0, oy = 0;
    head.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      const r = tb.getBoundingClientRect();
      ox = r.left;
      oy = r.top;
      tb.style.right = "auto";
      tb.style.left = ox + "px";
      tb.style.top = oy + "px";
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const r = tb.getBoundingClientRect();
      const x = Math.max(0, Math.min(ox + (e.clientX - sx), window.innerWidth - r.width));
      const y = Math.max(0, Math.min(oy + (e.clientY - sy), window.innerHeight - r.height));
      tb.style.left = x + "px";
      tb.style.top = y + "px";
    });
    document.addEventListener("mouseup", () => { dragging = false; });
  }

  function buildToolbar() {
    const host = document.createElement("div");
    host.id = "dv-toolbar-host";
    host.innerHTML = `
      <div id="dv-toolbar">
        <div class="dv-head">
          <span class="dv-logo">▶ Deep Grab</span>
          <button id="dv-toggle" class="dv-minbtn" title="Minimize / expand">–</button>
        </div>
        <div class="dv-body">
          <div class="dv-row">
            <input id="dv-search" type="text" placeholder="Filter: key1, key2, ...">
            <button id="dv-clear" title="Clear search">✕</button>
          </div>
          <div class="dv-row dv-toggles">
            <button id="dv-scroll" class="dv-tbtn" title="Auto-scroll to load all content">↓ Auto-scroll</button>
            <button id="dv-tab" class="dv-tbtn" title="Open links in a new tab">↗ New tab</button>
            <button id="dv-best" class="dv-tbtn" title="Only capture the single best source (full-movie HLS master outranks MP4 highlights)">↥ Best only</button>
            <button id="dv-close" class="dv-tbtn" title="After the video is sent to the desktop app, close its streamtape/fstape tab (cascades through pre-opened tabs)">⟳ Auto-close</button>
            <label class="dv-all" title="All keywords must match"><input type="checkbox" id="dv-all"> ALL</label>
          </div>
          <div class="dv-row dv-meta">
            <span id="dv-counts" class="dv-counts">0 found</span>
            <span id="dv-desktop" class="dv-dot" title="Desktop app connection">●</span>
            <button id="dv-grab" class="dv-tbtn" title="Master switch for automatic sending: ON (default) = best videos are sent to the desktop app as found; OFF = nothing is sent automatically">▶ Send</button>
            <button id="dv-run" class="dv-tbtn" title="Process streamtape/fstape tabs one by one: autoplay → send → close → next (off by default)">▶ Start</button>
            <button id="dv-scan" class="dv-btn" title="Re-scan page">Scan</button>
          </div>
          <div class="dv-row dv-rules" title="Show / add only videos matching these rules">
            <select id="dv-type" class="dv-select" title="File type filter">
              <option value="all">All types</option>
              <option value="mp4">MP4 only</option>
              <option value="m3u8">HLS only</option>
            </select>
            <input id="dv-minsize" type="number" min="0" step="0.1" placeholder="Min MB" class="dv-minsize" title="Minimum file size in MB (0 = any)">
            <span class="dv-qty-label" title="How many video tabs to process per Start (0 = all)">Qty</span>
            <input id="dv-quantity" type="number" min="0" step="1" value="0" class="dv-qty" title="How many video tabs to process per Start (0 = all)">
          </div>
          <div class="dv-found-head">
            <span>Found videos</span>
            <button id="dv-addall" class="dv-mini">Add all</button>
          </div>
          <div class="dv-batch" id="dv-batch">
            <label class="dv-all" title="Select all shown videos"><input type="checkbox" id="dv-selall"> All</label>
            <button id="dv-addsel" class="dv-mini" disabled>+ Add sel</button>
            <button id="dv-removesel" class="dv-mini" disabled>✕ Remove sel</button>
            <button id="dv-export" class="dv-mini" title="Export collected URLs (selected, or all shown)">⤓ Export</button>
            <span id="dv-selcount" class="dv-counts"></span>
          </div>
          <ul id="dv-found"></ul>
        </div>
      </div>`;
    document.body.appendChild(host);

    const search = host.querySelector("#dv-search");
    const clearBtn = host.querySelector("#dv-clear");
    const scrollBtn = host.querySelector("#dv-scroll");
    const tabBtn = host.querySelector("#dv-tab");
    const bestBtn = host.querySelector("#dv-best");
    const allChk = host.querySelector("#dv-all");
    const scanBtn = host.querySelector("#dv-scan");
    const addAllBtn = host.querySelector("#dv-addall");
    const minBtn = host.querySelector("#dv-toggle");
    const typeSel = host.querySelector("#dv-type");
    const minSizeInput = host.querySelector("#dv-minsize");
    const body = host.querySelector(".dv-body");

    search.addEventListener("input", () => {
      state.keyword = search.value;
      applyFilter();
      saveConfig();
    });
    clearBtn.addEventListener("click", () => {
      search.value = "";
      state.keyword = "";
      applyFilter();
      saveConfig();
    });
    allChk.addEventListener("change", () => {
      state.matchAll = allChk.checked;
      config.matchAll = allChk.checked;
      applyFilter();
      saveConfig();
    });
    scrollBtn.addEventListener("click", () => {
      if (state.autoScroll) stopAutoScroll();
      else startAutoScroll();
      scrollBtn.classList.toggle("dv-on", state.autoScroll);
      config.autoScroll = state.autoScroll;
      saveConfig();
    });
    tabBtn.addEventListener("click", () => {
      state.newTabMode = !state.newTabMode;
      tabBtn.classList.toggle("dv-on", state.newTabMode);
      config.openInNewTab = state.newTabMode;
      saveConfig();
    });
    bestBtn.addEventListener("click", () => {
      toggleBestOnly(!config.bestOnly);
    });
    const closeBtn = document.getElementById("dv-close");
    if (closeBtn) {
      closeBtn.classList.toggle("dv-on", config.autoCloseTab);
      closeBtn.addEventListener("click", () => {
        config.autoCloseTab = !config.autoCloseTab;
        closeBtn.classList.toggle("dv-on", config.autoCloseTab);
        saveConfig();
      });
    }
    const runBtn = document.getElementById("dv-run");
    if (runBtn) {
      const qtyInput = document.getElementById("dv-quantity");
      if (qtyInput) qtyInput.value = config.pipelineQty || 0;
      const setRunBtn = (running, pending) => {
        runBtn.textContent = running ? "■ Stop" : "▶ Start";
        runBtn.title = running && pending
          ? `Processing ${pending} tab(s) one by one — click to stop`
          : "Process streamtape/fstape tabs one by one: autoplay → send → close → next (off by default)";
        runBtn.classList.toggle("dv-on", running);
      };
      setRunBtn(false, 0);
      runBtn.addEventListener("click", () => {
        const starting = runBtn.textContent.indexOf("Stop") === -1;
        const qtyInput = document.getElementById("dv-quantity");
        const quantity = qtyInput ? Math.max(0, parseInt(qtyInput.value, 10) || 0) : 0;
        if (qtyInput && parseInt(qtyInput.value, 10) >= 0) {
          config.pipelineQty = quantity;
          saveConfig();
        }
        chrome.runtime.sendMessage({ type: starting ? "pipeline-start" : "pipeline-stop", quantity }, (resp) => {
          if (resp) setRunBtn(!!resp.running, resp.pending || 0);
          refreshFromBackground(true);
        });
      });
      // keep the button in sync with the background pipeline state
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === "pipeline-state") setRunBtn(!!msg.running, msg.pending || 0);
      });
    }
    scanBtn.addEventListener("click", () => {
      scanVideoElements();
      scanPageLinks();
      scanSupjavList();
      scanSupjavDl();
      extractCnPorn();
      extractSupjav();
      refreshFromBackground(true);
      toast(`Scan done — ${found.size} videos`);
    });
    const grabBtn = document.getElementById("dv-grab");
    if (grabBtn) {
      grabBtn.addEventListener("click", () => {
        grabOn = !grabOn;
        config.autoGrab = grabOn;
        grabBtn.textContent = grabOn ? "■ Send" : "▶ Send";
        grabBtn.classList.toggle("dv-on", grabOn);
        toast(grabOn ? "Auto-send ON — new videos are sent automatically" : "Auto-send OFF");
        saveConfig();
        if (grabOn) {
          // send the current best immediately, then flush anything stashed offline
          const cur = found.size ? found.values().next().value : null;
          if (cur && !cur.added) maybeAutoDownload(cur.url);
          flushAutoPending();
        }
      });
    }
    addAllBtn.addEventListener("click", () => {
      const urls = Array.from(found.values())
        .filter((v) => matchesRules(v) && !v.added)
        .map((v) => v.url);
      if (!urls.length) {
        toast("No videos match your rules");
        return;
      }
      chrome.runtime.sendMessage({ type: "add-all-found", urls }, () => refreshFromBackground(true));
    });
    minBtn.addEventListener("click", () => body.classList.toggle("dv-hidden"));
    makeDraggable();

    typeSel.addEventListener("change", () => {
      config.typeFilter = typeSel.value;
      renderFoundList();
      saveConfig();
    });
    minSizeInput.addEventListener("input", () => {
      config.minSizeMB = Math.max(0, parseFloat(minSizeInput.value) || 0);
      renderFoundList();
      saveConfig();
    });

    host.querySelector("#dv-found").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-add]");
      if (!btn) return;
      const url = btn.dataset.add;
      chrome.runtime.sendMessage({ type: "add-to-list", url }, () => refreshFromBackground(true));
    });
    host.querySelector("#dv-found").addEventListener("change", (e) => {
      const cb = e.target.closest("input[data-sel]");
      if (!cb) return;
      if (cb.checked) selected.add(cb.dataset.sel);
      else selected.delete(cb.dataset.sel);
      updateBatch();
    });

    const selAll = host.querySelector("#dv-selall");
    const addSelBtn = host.querySelector("#dv-addsel");
    const removeSelBtn = host.querySelector("#dv-removesel");

    selAll.addEventListener("change", () => {
      const shown = Array.from(found.values()).filter((v) => matchesRules(v));
      if (selAll.checked) shown.forEach((v) => selected.add(v.url));
      else shown.forEach((v) => selected.delete(v.url));
      // Reflect selection directly onto the visible row checkboxes (not just via
      // renderFoundList) so the tick state is always in sync with `selected`.
      const listEl = document.getElementById("dv-found");
      if (listEl) listEl.querySelectorAll("input[data-sel]").forEach((cb) => {
        cb.checked = selected.has(cb.dataset.sel);
      });
      updateBatch();
    });

    addSelBtn.addEventListener("click", () => {
      const urls = Array.from(selected).filter((u) => {
        const v = found.get(u);
        return v && !v.added;
      });
      if (!urls.length) {
        toast("No un-added videos selected");
        return;
      }
      chrome.runtime.sendMessage({ type: "add-all-found", urls }, () => {
        urls.forEach((u) => selected.delete(u));
        refreshFromBackground(true);
      });
    });

    removeSelBtn.addEventListener("click", () => {
      const urls = Array.from(selected);
      if (!urls.length) return;
      chrome.runtime.sendMessage({ type: "remove-found", urls }, () => {
        urls.forEach((u) => { found.delete(u); selected.delete(u); });
        renderFoundList();
        updateCounts();
        updateBatch();
        toast(urls.length + " removed");
      });
    });

    const exportBtn = host.querySelector("#dv-export");
    if (exportBtn) {
      exportBtn.addEventListener("click", () => {
        const useSelected = selected.size > 0;
        const urls = useSelected
          ? Array.from(selected)
          : Array.from(found.values()).filter((v) => matchesRules(v)).map((v) => v.url);
        const uniq = Array.from(new Set(urls.filter(Boolean)));
        if (!uniq.length) { toast("No URLs to export"); return; }
        const text = uniq.join("\n");
        copyText(text);
        downloadText("deepgrab-urls.txt", text);
        toast("Exported " + uniq.length + " URL" + (uniq.length === 1 ? "" : "s") + (useSelected ? " (selected)" : " (all)"));
      });
    }

    // initial state from config — auto-scroll never resumes by itself; press
    // ↓ Auto-scroll on each page where you want it
    if (config.openInNewTab) {
      state.newTabMode = true;
      tabBtn.classList.add("dv-on");
    }
    if (config.bestOnly) {
      bestBtn.classList.add("dv-on");
      reevaluateBest();
    }
    if (config.deepSearch) {
      search.value = config.deepSearch;
      state.keyword = config.deepSearch;
      applyFilter();
    }
    if (config.matchAll) allChk.checked = true;

    if (config.typeFilter && config.typeFilter !== "all") typeSel.value = config.typeFilter;
    if (config.minSizeMB > 0) minSizeInput.value = config.minSizeMB;

    updateBatch();
    return host;
  }

  function updateBatch() {
    const addSel = document.getElementById("dv-addsel");
    const remSel = document.getElementById("dv-removesel");
    const count = selected.size;
    if (addSel) addSel.disabled = count === 0;
    if (remSel) remSel.disabled = count === 0;
    const sc = document.getElementById("dv-selcount");
    if (sc) sc.textContent = count ? count + " sel" : "";
    const selAll = document.getElementById("dv-selall");
    if (selAll) {
      const shown = Array.from(found.values()).filter((v) => matchesRules(v));
      const shownUrls = new Set(shown.map((v) => v.url));
      let selShown = 0;
      for (const u of selected) if (shownUrls.has(u)) selShown++;
      selAll.checked = shown.length > 0 && selShown === shown.length;
      selAll.indeterminate = selShown > 0 && selShown < shown.length;
    }
  }

  function renderFoundList() {
    const listEl = document.getElementById("dv-found");
    if (!listEl) return;
    const all = Array.from(found.entries()).map(([url, v]) => ({ url, ...v }));
    const entries = all.filter((v) => matchesRules(v));
    listEl.innerHTML = "";
    if (!entries.length) {
      const li = document.createElement("li");
      li.className = "dv-empty";
      li.textContent = all.length
        ? "No videos match your size/type rules"
        : config.bestOnly
          ? "No MP4 (playlists skipped in Best-only mode)"
          : "No MP4 found yet. Scroll the page.";
      listEl.appendChild(li);
      updateBatch();
      return;
    }
    const shown = entries;
    shown.forEach((v) => {
      const li = document.createElement("li");
      li.className = "dv-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.sel = v.url;
      cb.checked = selected.has(v.url);
      cb.title = "Select";
      const title = document.createElement("div");
      title.className = "dv-item-title";
      title.textContent = v.title || v.url.split("/").pop();
      const meta = document.createElement("div");
      meta.className = "dv-item-meta" + (v.error ? " dv-err" : "");
      meta.textContent = v.error ? "✕ " + v.error : (v.size ? fmtSize(v.size) : "size —");
      const badge = document.createElement("span");
      badge.className = "dv-kind " + (v.kind === "m3u8" ? "hls" : "mp4");
      badge.textContent = v.kind === "m3u8" ? "HLS" : "MP4";
      const btn = document.createElement("button");
      btn.className = "dv-mini" + (v.added ? " dv-added" : "");
      btn.dataset.add = v.url;
      btn.textContent = v.added ? "Added ✓" : "+ Add";
      btn.disabled = !!v.added;
      const cp = document.createElement("button");
      cp.className = "dv-mini";
      cp.title = "Copy URL";
      cp.textContent = "⧉";
      cp.addEventListener("click", () => copyText(v.url));
      li.appendChild(cb);
      li.appendChild(title);
      li.appendChild(badge);
      li.appendChild(meta);
      li.appendChild(cp);
      li.appendChild(btn);
      listEl.appendChild(li);
    });
  }

  function updateCounts() {
    const el = document.getElementById("dv-counts");
    if (!el) return;
    const all = found.size;
    const matched = Array.from(found.values()).filter((v) => matchesRules(v)).length;
    el.textContent = matched === all ? all + " found" : matched + " / " + all + " match";
  }

  function fmtSize(b) {
    if (!b) return "0 B";
    const u = ["B", "KB", "MB", "GB"];
    const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
    return (b / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + " " + u[i];
  }

  function toast(text) {
    const el = document.getElementById("dv-toast");
    if (el) el.remove();
    const t = document.createElement("div");
    t.id = "dv-toast";
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }

  function copyText(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      toast("URL copied");
    } catch (e) { /* clipboard unavailable */ }
  }

  function downloadText(name, text) {
    try {
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { /* download unavailable */ }
  }

  // ---------- desktop status ----------
  function refreshStatus() {
    chrome.runtime.sendMessage({ type: "desktop-status" }, (resp) => {
      const dot = document.getElementById("dv-desktop");
      const on = !!(resp && resp.ok);
      if (dot) {
        dot.className = "dv-dot " + (on ? "dv-ok" : "dv-off");
        dot.title = on ? "Desktop app connected" : "Desktop app offline (run the app)";
      }
      // Flush offline stashes whenever the desktop is reachable again — both
      // maybeAutoDownload and maybeAutoCrawl self-gate on grabOn/autoCrawl, so
      // the always-on crawler's stashed links flush here even with Send toggled
      // off.
      if (on) flushAutoPending();
    });
  }
  if (IS_TOP) setInterval(refreshStatus, 3000);

  // ---------- config ----------
  function saveConfig() {
    chrome.storage.local.set({
      dv: {
        autoScroll: config.autoScroll,
        openInNewTab: config.openInNewTab,
        matchAll: config.matchAll,
        loadMoreSelector: config.loadMoreSelector,
        cardSelector: config.cardSelector,
        deepSearch: state.keyword,
        videoSelectors: config.videoSelectors,
        typeFilter: config.typeFilter,
        minSizeMB: config.minSizeMB,
        bestOnly: config.bestOnly,
        autoGrab: config.autoGrab,
        autoCloseTab: config.autoCloseTab,
        pipelineQty: config.pipelineQty
      }
    }).catch(() => {});
  }

  function loadConfig() {
    chrome.storage.local.get({ dv: {} }, (data) => {
      config = { ...DEFAULT_CONFIG, ...(data.dv || {}) };
      if (config.matchAll) state.matchAll = true;
      if (config.deepSearch) state.keyword = config.deepSearch;
      // Sync the auto-send master switch with the persisted autoGrab setting
      // (default ON = armed). A stored OFF is honored here on load.
      grabOn = config.autoGrab !== false;
      const grabBtn = document.getElementById("dv-grab");
      if (grabBtn) {
        grabBtn.textContent = grabOn ? "■ Send" : "▶ Send";
        grabBtn.classList.toggle("dv-on", grabOn);
      }
      buildToolbar();
      applyFilter();
      scanVideoElements();
      scanPageLinks();
      // Always-on link crawler: run the movie-page / dl scans immediately at
      // load (not just on the periodic interval) so every link match auto-sends
      // as soon as the page renders.
      scanSupjavList();
      scanSupjavDl();
      refreshFromBackground(true);
      refreshStatus();
    });
  }

  // ---------- auto-solve interactive Cloudflare challenges ----------
  // Anti-bot tube sites (missav*) gate the page behind a "Verify you are human"
  // checkbox that must be clicked before the real content renders. Click it
  // automatically so the built-in browser can load without a manual step.
  // Runs in every frame (manifest all_frames:true), so it also executes inside
  // the cross-origin challenge iframe and can reach its checkbox directly.
  function looksLikeCloudflareChallenge() {
    if (/cloudflare/i.test(location.hostname)) return true;
    const t = document.title || "";
    if (/verify you are human|checking your browser|just a moment|attention required|enable javascript and cookies/i.test(t)) return true;
    return !!(document.getElementById("challenge-form") || document.getElementById("cf-challenge-running") || document.querySelector(".cf-turnstile, .cf-challenge, #challenge-stage, #cf-hcaptcha-container"));
  }
  let cfLastClick = 0;
  let cfTries = 0;
  let cfGaveUp = false;
  const CF_COOLDOWN_MS = 6000;   // Turnstile verifies on its own after ONE click;
  const CF_MAX_CLICKS = 5;       // re-clicking sooner re-triggers the challenge loop.
  // After any solver action (a click) or a manual human interaction, hold off
  // for CF_QUIET_MS before clicking AGAIN or reloading. Cloudflare's Turnstile
  // needs that quiet to verify + hand back the cf_clearance cookie + reload on
  // its own; a second click or an early reload during this window invalidates
  // the just-submitted solve and forces another challenge (the "solve, refresh,
  // solve again" loop).
  const CF_QUIET_MS = 20000;
  const CF_RELOADS_KEY = "dvCfReloads";
  // Soft interstitials ("Checking your browser...") have NO clickable widget;
  // Cloudflare runs proof-of-work (can take 20-45s under suspicion) then sets
  // the cf_clearance cookie and reloads with a token. Reloading too early kills
  // the verification mid-flight, so wait long before one gentle retry.
  const CF_SOFT_TIMEOUT_MS = 45000;
  const CF_SOFT_MAX_RELOADS = 1;
  let cfSoftSince = 0;
  let cfSoftReloads = 0;
  // last moment we (or the user) interacted with a challenge; solver goes quiet
  // until this expires so a manual solve lands instead of being re-clicked away
  let cfQuietUntil = 0;
  function cfReloadBudget() {
    try { return Math.max(0, 2 - (parseInt(sessionStorage.getItem(CF_RELOADS_KEY) || "0", 10) || 0)); } catch (e) { return 0; }
  }
  function cfSpendReload() {
    try { sessionStorage.setItem(CF_RELOADS_KEY, String((parseInt(sessionStorage.getItem(CF_RELOADS_KEY) || "0", 10) || 0) + 1)); } catch (e) { /* ignore */ }
  }
  function cfClearReloadBudget() {
    try { sessionStorage.removeItem(CF_RELOADS_KEY); } catch (e) { /* ignore */ }
  }
  // Checkbox clicks are only safe inside real Cloudflare frames — the page's
  // own checkboxes must never be touched (title text alone can misfire).
  function cfFrameKind() {
    if (/challenges\.cloudflare\.com$/i.test(location.hostname)) return "checkbox";
    if (document.getElementById("challenge-form") || document.getElementById("challenge-stage")) return "checkbox";
    return "soft";
  }
  function clickCloudflareWidget() {
    const now = Date.now();
    // Honor the quiet window: right after any solver/human interaction, do NOT
    // click again (Turnstile is verifying; a second click re-triggers the loop).
    if (now < cfQuietUntil) return false;
    if (now - cfLastClick < CF_COOLDOWN_MS) return false;
    if (!looksLikeCloudflareChallenge()) return false;
    const targets = cfFrameKind() === "checkbox"
      ? ['input[type="checkbox"]', '[role="checkbox"]', "#challenge-stage button", "#challenge-form button", "button[type=submit]", ".cf-turnstile"]
      : ["#challenge-stage button", "#challenge-form button", "button[type=submit]", ".cf-turnstile"];
    let acted = false;
    for (const sel of targets) {
      document.querySelectorAll(sel).forEach((el) => {
        const visible = el.offsetWidth > 0 || el.offsetHeight > 0 || el.type === "checkbox";
        if (visible) { try { el.click(); acted = true; } catch (e) { /* ignore */ } }
      });
      if (acted) break;
    }
    if (acted) {
      cfLastClick = now;
      cfQuietUntil = now + CF_QUIET_MS;   // let this solve land before any retry
      cfTries++;
      console.info("DeepVid: clicked Cloudflare challenge in", location.href, "(attempt " + cfTries + ")");
      if (cfTries >= CF_MAX_CLICKS && IS_TOP) {
        if (cfReloadBudget() > 0) {
          cfSpendReload();
          cfTries = 0;
          console.warn("DeepVid: challenge stuck — reloading once for a fresh verification token (" + cfReloadBudget() + " reload(s) left)");
          setTimeout(() => { try { location.reload(); } catch (e) { /* ignore */ } }, 800);
        } else {
          cfGaveUp = true;
          console.warn("DeepVid: Cloudflare challenge not auto-solving - please solve it manually, then the page will continue.");
        }
      }
    }
    return acted;
  }
  let cfSolverTimer = 0;
  function startCloudflareSolver() {
    if (cfSolverTimer) return;
    cfSolverTimer = setInterval(() => {
      if (cfGaveUp) { clearInterval(cfSolverTimer); cfSolverTimer = 0; return; }
      // only act while a challenge is present; stop (and refund the reload
      // budget) once it clears, so a later challenge starts fresh
      if (!looksLikeCloudflareChallenge()) {
        clearInterval(cfSolverTimer);
        cfSolverTimer = 0;
        cfClearReloadBudget();
        cfSoftSince = 0;
        return;
      }
const acted = clickCloudflareWidget();
      // Soft interstitial with nothing to click (and no Turnstile iframe to
      // hand off to): give Cloudflare's proof-of-work a full CF_SOFT_TIMEOUT_MS
      // to issue cf_clearance before one gentle reload. If even that fails,
      // flag for manual solve (visible banner, not a silent forever-spinner).
      if (!acted && cfFrameKind() === "soft" && IS_TOP && !document.querySelector('iframe[src*="challenges.cloudflare.com"]')) {
        const now = Date.now();
        if (!cfSoftSince) cfSoftSince = now;
        // Stay quiet during the post-interaction/solve grace so a manual solve
        // never gets nuked by an auto reload, and never reload while a Turnstile
        // iframe is present (that widget is the thing the human reaches to solve).
        if (!(now < cfQuietUntil) && now - cfSoftSince >= CF_SOFT_TIMEOUT_MS) {
          cfSoftSince = 0;
          cfSoftReloads++;
          if (cfSoftReloads <= CF_SOFT_MAX_RELOADS && cfReloadBudget() > 0) {
            cfSpendReload();
            console.warn("DeepVid: cloudflare soft challenge not verifying - one gentle reload for a fresh token (" + cfReloadBudget() + " reload(s) left)");
            setTimeout(() => { try { location.reload(); } catch (e) { /* ignore */ } }, 800);
          } else {
            cfGaveUp = true;
            console.warn("DeepVid: Cloudflare challenge not auto-solving - please solve it manually, then the page will continue.");
            if (document.getElementById("dv-cf-banner") == null) {
              const b = document.createElement("div");
              b.id = "dv-cf-banner";
              b.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(20,20,30,.92);color:#fff;font:500 13px/1.4 Segoe UI,Arial,sans-serif;padding:10px 14px;text-align:center";
              b.innerHTML = "Cloudflare challenge couldn't be auto-solved. <a href='#' style='color:#4fc3f7' id='dv-cf-retry'>Reload once</a> and wait ~45s, or solve it manually below.";
              b.addEventListener("click", (ev) => {
                const t = ev.target;
                if (t && t.id === "dv-cf-retry") { ev.preventDefault(); location.reload(); }
              });
              document.documentElement.appendChild(b);
            }
          }
        }
      } else if (acted) {
        cfSoftSince = 0;
      }
    }, 2000);
  }
  function maybeStartCloudflareSolver() {
    if (!cfGaveUp && looksLikeCloudflareChallenge()) startCloudflareSolver();
  }
  setInterval(maybeStartCloudflareSolver, 1500);

  // Detect a HUMAN manually solving the Turnstile (they click the checkbox in
  // the challenges.cloudflare.com iframe / widget). Arm the same quiet window so
  // the nested-frame auto-solver never re-clicks their checkbox right after and
  // invalidates the manual solve — the "solve, it refreshes, solve again" loop.
  document.addEventListener("pointerdown", (ev) => {
    if (cfQuietUntil > Date.now()) return;
    const t = ev.target;
    if (t && t.closest && t.closest('[role="checkbox"], input[type="checkbox"], .cf-turnstile, #challenge-stage, #challenge-form')) {
      cfQuietUntil = Date.now() + CF_QUIET_MS;
      console.info("DeepVid: manual Cloudflare solve detected - staying quiet for verification");
    }
  }, true);

  // ---------- init ----------
  domReady(() => {
    // Relay the pipeline's "your turn" signal to the autoplay userscript
    // (crosses isolated worlds via a DOM custom event).
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "dv-autoplay-now") {
        document.dispatchEvent(new CustomEvent("deepgrab:autoplay", { bubbles: true }));
      }
    });
    document.addEventListener("click", handleClick, true);
    document.addEventListener("auxclick", handleAuxClick, true);
    hookNetwork();
    maybeStartCloudflareSolver();
    // UI + heavy scanning only in the top frame; iframes keep network hooks
    // + CF auto-click but skip the toolbar, observers and periodic scans.
    if (IS_TOP) loadConfig();
  });

  // Observer scan budget: DOM churn on chatty pages must not stack full
  // scans. One scan is scheduled per quiet-ish gap; while a scan is pending
  // or the tab is hidden, further mutations are dropped (each scan re-scans
  // the whole document, so nothing is lost) and a skipped catch-up scan runs
  // when the tab becomes visible again. Top frame only.
  if (IS_TOP) {
    const OBSERVER_SCAN_GAP_MS = 1200;
    let mutationTimer = 0;
    let lastObserverScan = 0;
    let observerScanDue = false;
    const runObserverScan = () => {
      mutationTimer = 0;
      if (document.hidden) { observerScanDue = true; return; }
      observerScanDue = false;
      lastObserverScan = Date.now();
      applyFilter();
      scanVideoElements();
      scanPageLinks();
    };
    const scheduleObserverScan = () => {
      if (mutationTimer) return; // a scan is already pending
      if (document.hidden) { observerScanDue = true; return; }
      mutationTimer = setTimeout(runObserverScan, Math.max(150, lastObserverScan + OBSERVER_SCAN_GAP_MS - Date.now()));
    };
    const observer = new MutationObserver(scheduleObserverScan);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "data-src", "data-video", "data-mp4"]
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && observerScanDue) scheduleObserverScan();
    });

    // Periodic re-scan: catches videos whose src is set as a JS property
    // (video.currentSrc) on elements that never start loading.
    setInterval(() => {
      if (document.hidden) return;
      scanVideoElements();
      scanSupjavList();
      scanSupjavDl();
      extractCnPorn();
      extractMissav();
      extractSupjav();
    }, 3000);

    setInterval(() => {
      if (document.hidden) return;
      refreshFromBackground(false);
    }, 3000);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "dv-rescan") {
      scanVideoElements();
      scanPageLinks();
      scanSupjavList();
      scanSupjavDl();
      extractCnPorn();
      extractMissav();
      extractSupjav();
      // Report every video this page knows about; the SW ingests the report
      // into its canonical list and answers with the authoritative count.
      const report = Array.from(found.values()).map((v) => ({
        url: v.url,
        title: v.title || "",
        pageUrl: v.pageUrl || location.href,
        kind: v.kind === "m3u8" ? "m3u8" : "mp4"
      }));
      sendResponse({ ok: true, videos: report });
      // Pull sizes/added state back into the toolbar mirror after the SW has
      // ingested the report (short delay so the SW answers get-found after it).
      if (IS_TOP) setTimeout(() => refreshFromBackground(true), 60);
      return false;
    }
    if (msg && msg.type === "dv-found-updated") {
      // background learned a new video / size from any tab — update now
      if (IS_TOP) refreshFromBackground(true);
    }
    return false;
  });
})();
