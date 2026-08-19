// Content script: deep multi-keyword filter, infinite scroll, MP4 sniffing,
// one-click new-tab toggle, found-video panel with per-video "Add to list".

(() => {
  if (window.__DEEPVID_INJECTED__) return;
  window.__DEEPVID_INJECTED__ = true;

  // Ad-network hosts whose streams/players must never be captured as videos.
  const AD_DOMAINS = /(?:^|\.)(?:doubleclick\.net|googlesyndication\.com|adservice\.google\.com|ads\.youtube\.com|adroll\.com|criteo\.com|taboola\.com|outbrain\.com|adnxs\.com|amazon-adsystem\.com|adform\.net|adcolony\.com|smartadserver\.com|rubiconproject\.com|pubmatic\.com|openx\.net|appnexus\.com|casalemedia\.com|adsrvr\.org|exoclick\.com|popads\.net|propellerads\.com|mgid\.com|revcontent\.com|adsterra\.com|juicyads\.com)$/i;
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
    autoCloseTab: true,
    pipelineQty: 0,
    autoPlayCapture: false
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
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
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
    renderFoundList();
    updateCounts();
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

  function isHls(u) {
    if (!u) return false;
    return /\.m3u8([?#]|$)/i.test(u) || /(^|[/?&])m3u8[^/]*/i.test(u) || /(^|[/?&=])(hls|manifest|playlist)([/?&=]|$)/i.test(u);
  }

  // Resolution rank: 5 = 4k+, 4 = 1440/2k, 3 = 1080, 2 = 720, 1 = 480/540, 0 = none.
  // Reads <source> element attrs (res/label/data-quality/data-res/data-height) plus URL markers.
  function qualityRank(u, sourceEl) {
    let h = 0;
    const push = (n) => { if (n && n > h) h = n; };
    const s = String(u || "");
    if (sourceEl) {
      ["res", "data-quality", "data-res", "label", "data-height"].forEach((attr) => {
        const m = String(sourceEl.getAttribute(attr) || "").match(/\d{3,4}/);
        if (m) push(parseInt(m[0], 10));
      });
    }
    const xy = s.match(/(\d{3,4})x(\d{3,4})/);
    if (xy) push(parseInt(xy[2], 10));
    const p = s.match(/(\d{3,4})p/i);
    if (p) push(parseInt(p[1], 10));
    if (/8k|4320/i.test(s)) push(4320);
    if (/4k|2160/i.test(s)) push(2160);
    if (/2k|1440/i.test(s)) push(1440);
    if (h >= 2160) return 5;
    if (h >= 1440) return 4;
    if (h >= 1080) return 3;
    if (h >= 720) return 2;
    if (h >= 480) return 1;
    return 0;
  }

  function tryCapture(url, title, sourceEl) {
    if (isAdUrl(url)) return; // bypass ads — never capture ad-network streams
    // a real <video> element's src is video even when the URL has no video markers
    const isVideoEl = !!(sourceEl && sourceEl.tagName === "VIDEO");
    if (!isVideoEl && !looksLikeVideoUrl(url)) return;
    if (url.startsWith("blob:")) return;
    const clean = url.startsWith("//") ? location.protocol + url : url;
    // streamtape/fstape embed <title> is generic/empty, but the URL slug has
    // the video name — prefer it as the fallback title.
    const pageTitle = slugTitle(location.href) || document.title;

    if (config.bestOnly) {
      if (isHls(clean)) return; // playlists skipped entirely in best-only mode
      if (found.has(clean)) return;
      const rank = qualityRank(clean, sourceEl);
      const cur = found.size ? found.values().next().value : null;
      if (cur && rank <= (cur._rank || 0)) return; // keep the current best on ties
      if (cur) {
        found.delete(cur.url);
        chrome.runtime.sendMessage({ type: "remove-found", urls: [cur.url] }).catch(() => {});
      }
      const titleText = (title || pageTitle || clean.split("/").pop()).trim();
      found.set(clean, { title: titleText, size: 0, added: false, kind: "mp4", _rank: rank });
      chrome.runtime.sendMessage({ type: "video-found", url: clean, title: titleText, pageUrl: location.href, kind: "mp4" }).catch(() => {});
      maybeAutoDownload(clean);
      renderFoundList();
      updateCounts();
      return;
    }

    if (found.has(clean)) return;
    const titleText = (title || pageTitle || clean.split("/").pop()).trim();
    found.set(clean, { title: titleText, size: 0, added: false, kind: kindOf(clean) });
    chrome.runtime.sendMessage({ type: "video-found", url: clean, title: titleText, pageUrl: location.href, kind: kindOf(clean) }).catch(() => {});
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
        found.set(url, { title, size: 0, added: false, kind, _rank: 0 });
        chrome.runtime.sendMessage({ type: "video-found", url, title, pageUrl: location.href, kind }).catch(() => {});
        renderFoundList();
        updateCounts();
      } catch (e) { /* embed fetch failed — webRequest capture remains the fallback */ }
    }
  }

  // missav.* watch pages bake the full-video HLS id into an inline <script>:
  // thumbnail URLs look like surrit.com/<uuid>/seek/_N.jpg and the master
  // playlist is https://surrit.com/<uuid>/playlist.m3u8 (variants under
  // /720p/video.m3u8 etc.; the ".jpeg" segments are real MPEG-TS). The playlist
  // is only requested when the player actually plays, so webRequest capture
  // alone misses it — it only catches the auto-playing preview/highlight.
  // Sniff the uuid out of the markup and report the master playlist up front.
  const missavPending = new Set(); // playlist fetch in flight (skip concurrent calls)
  const missavFailed = new Set(); // playlist fetch attempted and failed (don't retry)
  const missavValid = new Set(); // uuid playlist validated as live #EXTM3U
  async function extractMissav() {
    if (!/missav\./i.test(location.hostname)) return;
    const uuids = new Set();
    for (const s of document.scripts) {
      const t = String(s.textContent || "").replace(/\\\//g, "/");
      const re = /surrit\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
      let m;
      while ((m = re.exec(t))) uuids.add(m[1].toLowerCase());
    }
    for (const uuid of uuids) {
      const url = "https://surrit.com/" + uuid + "/playlist.m3u8";
      if (!found.has(url)) {
        // previously attempted and failed — don't re-claim a dead id every tick
        if (missavFailed.has(url)) continue;
        // claim the slot synchronously (before the preview auto-plays and is
        // captured as a low-res mp4) so best-only sends the full-video master
        const h1 = document.querySelector("h1");
        const title = (h1 ? h1.textContent.trim() : "") || document.title.replace(/\s*-\s*[^-]*$/, "");
        if (config.bestOnly) {
          const cur = found.size ? found.values().next().value : null;
          if (cur && (cur._rank || 0) >= 3) continue;
          if (cur) {
            found.delete(cur.url);
            chrome.runtime.sendMessage({ type: "remove-found", urls: [cur.url] }).catch(() => {});
          }
        }
        found.set(url, { title, size: 0, added: false, kind: "m3u8", _rank: 3, _validating: true });
        renderFoundList();
        updateCounts();
      }
      const entry = found.get(url);
      if (!missavValid.has(url)) {
        if (missavPending.has(url)) continue; // another call is validating — keep the placeholder
        if (missavFailed.has(url)) {
          // fetch already failed — drop the stale placeholder
          if (entry._validating) {
            found.delete(url);
            renderFoundList();
            updateCounts();
          }
          continue;
        }
        missavPending.add(url);
        let ok = false;
        try {
          const text = await (await fetch(url)).text();
          ok = /^#EXTM3U/.test(text.trim());
        } catch (e) { /* playlist fetch failed — not a live id */ }
        missavPending.delete(url);
        if (!ok) {
          missavFailed.add(url);
          if (entry._validating) {
            found.delete(url);
            renderFoundList();
            updateCounts();
          }
          continue;
        }
        missavValid.add(url);
      }
      // validated — promote the entry (webRequest may have captured it as "mp4")
      const h1 = document.querySelector("h1");
      const wasValidating = !!entry._validating;
      entry.kind = "m3u8";
      entry._rank = 3;
      if (!entry.title || entry.title === url.split("/").pop()) {
        entry.title = (h1 ? h1.textContent.trim() : "") || document.title.replace(/\s*-\s*[^-]*$/, "");
      }
      delete entry._validating;
      renderFoundList();
      if (wasValidating) {
        chrome.runtime.sendMessage({ type: "video-found", url, title: entry.title, pageUrl: location.href, kind: "m3u8" }).catch(() => {});
        updateCounts();
        if (config.bestOnly) maybeAutoDownload(url);
      } else if (config.bestOnly) {
        reevaluateBest();
      }
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

  // ---------- auto-play to capture ----------
  // Many sites only load the real video URL when the user clicks play (the
  // page initially serves a small preview.mp4).  Sends a message to the
  // background service worker which activates each tab one by one, signals
  // the content script to play its videos, waits for sources to load, then
  // moves to the next tab.
  function autoPlayToCapture() {
    chrome.runtime.sendMessage({ type: "autoplay-scan-start" }, (resp) => {
      if (resp && resp.ok) toast("Auto-play scan started (" + resp.total + " tabs)");
      else if (resp && resp.error) toast(resp.error);
      else toast("Auto-play: desktop app offline or no tabs found");
    });
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
    let bestEntry = null;
    entries.forEach((v) => {
      if (isHls(v.url)) {
        // keep the missav full-video master (extractMissav ranks it 3) as a
        // best candidate; purge any other HLS from best-only view
        if ((v._rank || 0) >= 3) {
          if (!bestEntry || v._rank > bestEntry._rank) bestEntry = v;
          return;
        }
        found.delete(v.url);
        chrome.runtime.sendMessage({ type: "remove-found", urls: [v.url] }).catch(() => {});
        return;
      }
      v._rank = qualityRank(v.url);
      if (!bestEntry || v._rank > bestEntry._rank) bestEntry = v;
    });
    entries.forEach((v) => {
      if (v === bestEntry || !found.has(v.url)) return;
      found.delete(v.url);
      chrome.runtime.sendMessage({ type: "remove-found", urls: [v.url] }).catch(() => {});
    });
    if (bestEntry && !bestEntry.added) maybeAutoDownload(bestEntry.url);
  }

  // Auto-download is debounced so a rapid best-entry replacement (several
  // <source>s in one scan, or a low-res preview captured before the full-video
  // master) sends only the FINAL best, not every intermediate winner.
  let bestAutoTimer = null;
  function maybeAutoDownload() {
    if (!config.bestOnly) return;
    if (bestAutoTimer) clearTimeout(bestAutoTimer);
    bestAutoTimer = setTimeout(() => {
      bestAutoTimer = null;
      if (!config.bestOnly) return;
      const cur = found.size ? found.values().next().value : null;
      if (!cur || cur.added || autoSending.has(cur.url)) return;
      autoSending.add(cur.url);
      chrome.runtime.sendMessage({ type: "add-to-list", url: cur.url, title: cur.title, pageUrl: location.href })
        .then(() => {
          cur.added = true;
          autoSending.delete(cur.url);
          autoPending.delete(cur.url);
          renderFoundList();
          updateCounts();
        })
        .catch(() => {
          autoSending.delete(cur.url);
          autoPending.add(cur.url);
          cur.added = false;
        });
    }, 200);
  }

  function flushAutoPending() {
    if (!autoPending.size) return;
    const urls = Array.from(autoPending);
    autoPending.clear();
    urls.forEach((u) => maybeAutoDownload(u));
  }

  // ---------- sync found list with background (sizes / added state) ----------
  function refreshFromBackground(force) {
    if (!force && Date.now() - lastRefresh < 2000) return;
    lastRefresh = Date.now();
    chrome.runtime.sendMessage({ type: "get-found" }, (resp) => {
      if (!resp) return;
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
          // keep only our single best entry; never merge others in best mode
          if (found.has(v.url)) {
            const row = found.get(v.url);
            if (v.size) row.size = v.size;
            row.added = !!v.added || capturedUrls.has(v.url);
          }
          maybeAutoDownload();
          return;
        }
  if (!found.has(v.url)) {
    // merge in videos found by other tabs / earlier sessions in real time
    found.set(v.url, {
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
            <button id="dv-best" class="dv-tbtn" title="Show only the single best-quality MP4 and auto-download it (skips HLS playlists)">↥ Best only</button>
            <button id="dv-close" class="dv-tbtn" title="After the video is sent to the desktop app, close its streamtape/fstape tab (cascades through pre-opened tabs)">⟳ Auto-close</button>
            <button id="dv-autoplay" class="dv-tbtn" title="Play all video elements muted to trigger real video loading (captures sources from sites that hide them behind play-click)">▶ Auto-play</button>
            <label class="dv-all" title="All keywords must match"><input type="checkbox" id="dv-all"> ALL</label>
          </div>
          <div class="dv-row dv-meta">
            <span id="dv-counts" class="dv-counts">0 found</span>
            <span id="dv-desktop" class="dv-dot" title="Desktop app connection">●</span>
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
    const autoplayBtn = document.getElementById("dv-autoplay");
    if (autoplayBtn) {
      autoplayBtn.classList.toggle("dv-on", config.autoPlayCapture);
      autoplayBtn.addEventListener("click", () => {
        config.autoPlayCapture = !config.autoPlayCapture;
        autoplayBtn.classList.toggle("dv-on", config.autoPlayCapture);
        saveConfig();
        if (config.autoPlayCapture) autoPlayToCapture();
        else chrome.runtime.sendMessage({ type: "autoplay-scan-stop" });
      });
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === "autoplay-scan-state") {
          const running = !!msg.running;
          if (running) {
            autoplayBtn.textContent = "⏹ Scan " + (msg.total - msg.pending) + "/" + msg.total;
            autoplayBtn.classList.add("dv-on");
          } else {
            autoplayBtn.textContent = "▶ Auto-play";
            autoplayBtn.classList.toggle("dv-on", config.autoPlayCapture);
          }
        }
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
      extractCnPorn();
      extractMissav();
      refreshFromBackground(true);
      toast(`Scan done — ${found.size} videos`);
    });
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
      renderFoundList();
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

    // initial state from config
    if (config.autoScroll) {
      state.autoScroll = true;
      scrollBtn.classList.add("dv-on");
      window.clearInterval(window.__DV_SCROLL_ID__);
      window.__DV_SCROLL_ID__ = window.setInterval(autoScrollTick, 350);
    }
    if (config.openInNewTab) {
      state.newTabMode = true;
      tabBtn.classList.add("dv-on");
    }
    if (config.bestOnly) {
      bestBtn.classList.add("dv-on");
      reevaluateBest();
    }
    if (config.autoPlayCapture) {
      if (autoplayBtn) autoplayBtn.classList.add("dv-on");
      setTimeout(autoPlayToCapture, 1500);
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
    const keywords = parseKeywords(state.keyword);
    const entries = all.filter((v) => {
      if (!matchesRules(v)) return false;
      if (keywords.length) {
        const text = ((v.title || "") + " " + v.url).toLowerCase();
        if (!matchesKeywords(text, keywords, state.matchAll)) return false;
      }
      return true;
    });
    listEl.innerHTML = "";
      if (!entries.length) {
      const li = document.createElement("li");
      li.className = "dv-empty";
      li.textContent = all.length
        ? (keywords.length ? "No videos match your search" : "No videos match your size/type rules")
        : config.bestOnly
          ? "No MP4 (playlists skipped in Best-only mode)"
          : "No MP4 found yet. Scroll the page.";
      listEl.appendChild(li);
      updateBatch();
      return;
    }
    entries.forEach((v) => {
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
    const keywords = parseKeywords(state.keyword);
    const matched = Array.from(found.values()).filter((v) => {
      if (!matchesRules(v)) return false;
      if (keywords.length) {
        const text = ((v.title || "") + " " + v.url).toLowerCase();
        if (!matchesKeywords(text, keywords, state.matchAll)) return false;
      }
      return true;
    }).length;
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

  // ---------- desktop status ----------
  function refreshStatus() {
    chrome.runtime.sendMessage({ type: "desktop-status" }, (resp) => {
      const dot = document.getElementById("dv-desktop");
      const on = !!(resp && resp.ok);
      if (dot) {
        dot.className = "dv-dot " + (on ? "dv-ok" : "dv-off");
        dot.title = on ? "Desktop app connected" : "Desktop app offline (run the app)";
      }
      if (on) flushAutoPending();
    });
  }
  setInterval(refreshStatus, 3000);

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
        autoCloseTab: config.autoCloseTab,
        pipelineQty: config.pipelineQty,
        autoPlayCapture: config.autoPlayCapture
      }
    }).catch(() => {});
  }

  function loadConfig() {
    chrome.storage.local.get({ dv: {} }, (data) => {
      config = { ...DEFAULT_CONFIG, ...(data.dv || {}) };
      if (config.matchAll) state.matchAll = true;
      if (config.deepSearch) state.keyword = config.deepSearch;
      buildToolbar();
      applyFilter();
      extractMissav(); // claim the full-video master before the preview is captured
      scanVideoElements();
      scanPageLinks();
      refreshFromBackground(true);
      refreshStatus();
    });
  }

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
    loadConfig();
  });

  // Debounced: on heavy pages a single burst of DOM changes would otherwise
  // re-run the filter + video scan once per mutation.
  let mutationTimer = 0;
  const observer = new MutationObserver(() => {
    if (mutationTimer) clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      applyFilter();
      scanVideoElements();
    }, 150);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "data-src", "data-video", "data-mp4"]
  });

  // Periodic re-scan: catches videos whose src is set as a JS property
  // (video.currentSrc) on elements that never start loading.
  setInterval(() => { scanVideoElements(); extractCnPorn(); extractMissav(); }, 3000);

  setInterval(() => refreshFromBackground(false), 3000);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "dv-rescan") {
      scanVideoElements();
      scanPageLinks();
      extractCnPorn();
      extractMissav();
      refreshFromBackground(true);
      sendResponse({ ok: true, count: found.size });
      return false;
    }
    if (msg && msg.type === "dv-autoplay-capture") {
      // background tells us to play all <video> elements on this page
      const videos = document.querySelectorAll("video");
      let triggered = 0;
      videos.forEach((v) => {
        const src = v.currentSrc || v.getAttribute("src") || "";
        if (!src || src.startsWith("blob:")) return;
        if (v.paused && !v.ended) { v.muted = true; v.play().catch(() => {}); triggered++; }
      });
      scanVideoElements();
      sendResponse({ ok: true, triggered });
      return false;
    }
    if (msg && msg.type === "dv-toast") {
      if (msg.text) toast(msg.text);
      return false;
    }
    if (msg && msg.type === "dv-found-updated") {
      refreshFromBackground(true);
    }
    return false;
  });
})();