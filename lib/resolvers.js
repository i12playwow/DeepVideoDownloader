// Site-specific resolvers: take a video page / embed URL and return the final
// direct download URL (a signed streamtape get_video link, an m3u8 playlist,
// or a generic mp4). Each resolve*() shares one signature and re-resolves when
// its result is another supported site (see resolveUrl dispatcher below).

const { URL } = require("url");
const { fetchHtml, requestWithRedirects, followRedirectChain, DEFAULT_MAX_RETRIES } = require("./http");
const { HLS_RE } = require("./hls");
const { isCfChallengeHtml } = require("./errors");

const STRGV = /get_video\?id=([A-Za-z0-9]+)&expires=(\d+)&ip=([^&\s"'<>]+)&token=([^&\s"'<>]+)/i;

const CNIFRAME = /(?:<iframe[^>]*src=["']|data-src=["'])([^"']*pornhub\.com\/embed\/[^"']+)["']/i;
const CNVIDEO = /<video[^>]*>\s*<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/i;
const CNIFRAME2 = /src=["'](https?:\/\/[^"']*streamtape\.com\/[^"']+)["']/i;
// cnporn's own embed iframe (lazy data-src, plain src, or data-server="/embed/<uuid>")
// and the mp4/m3u8 "file" entries baked into the embed page's player setup.
const CNEMBED = /(?:data-src|src|data-server)=["']([^"']*\/embed\/[^"']+)["']/i;
const CNSOURCES = /"file"\s*:\s*"([^"]+\.(?:mp4|m3u8)[^"]*)"/i;

// supjav's player iframe (supjav.php?l=<OLID>) reverses the id and reloads
// ?c=<reversed>, which emits a streamtape/fstape embed page OR (8/2026) a
// turbovidhls.com/t/<id> JWPlayer page hosting HLS via turboviplay.com.
const SJ_PLAYER_RE = /(?:supjav|supremejav)\.(?:com|ph|net)[^"'\s]*\bsupjav\.php/i;
const SJ_OLID = /[?&]l=([0-9a-f]+)/i;

// turbovidhls player page: the m3u8 playlist lives in the #video_player div's
// data-hash attribute (a cdn2.turboviplay.com/data1/<hex>/<hex>.m3u8 URL).
const TVH_EMBED_RE = /turbovidhls\.com\/t\//i;
const TVH_HASH_RE = /<div[^>]*id=["']video_player["'][^>]*data-hash=["']([^"']+\.m3u8[^"']*)["']/i;

// supjav ?dl= download links redirect through intermediate JS-redirect pages
// (go.mayzaent.com / go.mnaspm.com) to a file host (RapidGator / keep2share).
const SJ_DL_RE = /\?dl=[^&"'\s]+/i;
const SJ_HOST_RE = /(?:supjav|supremejav)\.(?:com|ph|net)/i;

// File-host detection: RapidGator (rg.to, rg.com) and keep2share (k2s.is, k2s.cc)
const RG_RE = /(?:www\.)?(?:rapidgator|rg)\.(?:to|com|net)/i;
const K2S_RE = /(?:www\.)?(?:keep2share|k2s)\.(?:is|cc|com|net)/i;
const FILEHOST_RE = new RegExp(RG_RE.source + "|" + K2S_RE.source, "i");

const XVEMBED = /(?:<iframe[^>]*src=["']|data-src=["'])([^"']*xvideos\.com\/embedframe[^"']+)["']/i;
const XVDIRECT = /<video[^>]*>\s*<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/i;

const XHEMBED = /src=["'](https?:\/\/[^"']*xhamster\.com\/xembed[^"']+)["']/i;
const XHPLAY = /<a\b(?=[^>]*class=["'][^"']*ht-prev[^"']*["'])[^>]*href=["']([^"']*xhamster\.com\/videos\/[^"']+)["']/i;
const XHMP4 = /<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/i;

async function resolveStreamtape(videoPageUrl, { proxyManager, config, paceHost }, baseHeaders = {}) {
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
  if (paceHost) await paceHost(videoPageUrl);
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
  if (!gv) {
    // Since 8/2026 modern streamtape embeds no longer inline get_video — the
    // signed URL comes from a /stat/<token>?a=0&rc=<recaptcha> POST that only a
    // real browser (recaptcha + click) can drive. Surface this distinctly so it
    // isn't mistaken for a dead video and the user is pointed at the built-in
    // browser / extension.
    if (/\/stat\//i.test(html)) {
      const err = new Error("Streamtape requires browser capture (recaptcha/stat gate) — open it in the built-in browser.");
      err.category = "requires-browser";
      throw err;
    }
    throw new Error("Could not find video source on Streamtape page.");
  }
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

// supjav's player iframe: the app receives supjav.php?l=<OLID> from the
// userscript (its frame.src/defaultSrc), never the Cloudflare-403'd page.
// The player reverses the id and loads ?c=<reversed>, which 302s straight to a
// streamtape/fstape embed, or (since 8/2026) a turbovidhls.com/t/<id> player
// page hosting HLS. Resolve streamtape/fstape to the signed direct URL; fetch
// the turbovidhls page and pull the m3u8 from #video_player[data-hash] so the
// HLS engine can download it.
async function resolveSupjav(videoPageUrl, { proxyManager, config, paceHost }, baseHeaders = {}) {
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const proxy = config.autoProxy ? await proxyManager.pickBest(videoPageUrl, 6000) : null;
  const agent = proxy ? proxyManager.agentFor(proxy, videoPageUrl) : null;
  const olid = SJ_OLID.exec(videoPageUrl);
  if (!olid) throw new Error("Supjav: no player id (supjav.php?l=...) in URL");
  const rev = olid[1].split("").reverse().join("");
  const cUrl = new URL("?c=" + rev, videoPageUrl).href;
  if (paceHost) await paceHost(cUrl);
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
      if (paceHost) await paceHost(embed);
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

// ---- Generic JAV aggregator (sextb, javmost, etc.) ----
// These sites embed a supjav.com player iframe (supjav.php?l=<OLID>) and/or
// expose the stream as a JW-Player / custom-HTML5 m3u8|mp4 inside a page
// script. They do NOT use streamtape-style /get_video embeds, so: try the
// supjav iframe first (delegating to resolveSupjav, which also covers the
// turbovidhls HLS path), then fall back to scanning page scripts for a direct
// m3u8/mp4 source.
const JAV_SUPJAV_IFRAME_RE = /(?:src|data-src)=["']([^"']*supjav\.(?:com|ph|net)[^"'\s]*supjav\.php[^"']*)["']/i;
const JAV_SCRIPT_M3U8_RE = /https?:\/\/[^\s'"]+\.m3u8/i;
const JAV_SRC_RE = /(?:src|data-src|file)=["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i;

// ---- supjav list-page collection (category / popular / search / pagination) ----
function isSupjavHost(u) {
  try { return /(?:supjav|supremejav)\.(?:com|ph|net)$/i.test(new URL(u).hostname); } catch (e) { return false; }
}
function isSupjavListUrl(url) {
  try {
    const p = new URL(url);
    if (!isSupjavHost(url)) return false;
    if (/^\/(popular|search|category|tag|actor|genre|studio|series|playlist|page|top|latest|random|ranking|most|watch|trending|uncensored|subbed|leak|best|hd|cn|us|censored|english|dubbed|4k|vr)\b/i.test(p.pathname)) return true;
    return /[?&]page=\d+/i.test(p.search) || /\/page\/\d+/i.test(p.pathname);
  } catch (e) { return false; }
}
function isSupjavMovieUrl(u) {
  try {
    const p = new URL(u);
    if (!isSupjavHost(u)) return false;
    if (!/\.html?$/i.test(p.pathname)) return false;
    if (/^\/(popular|search|category|tag|actor|genre|studio|series|playlist|page|top|latest|random|ranking|update|hd|cn|us|forum|faq|contact|uncensored|subbed|leak|best|most|watch|trending|censored|english|dubbed|4k|vr)\b/i.test(p.pathname)) return false;
    return true;
  } catch (e) { return false; }
}
function extractSupjavMovieLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /href=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    let u = m[1];
    if (!u || u.startsWith("#") || /^javascript:/i.test(u)) continue;
    if (/^\//.test(u)) { try { const p = new URL(baseUrl); u = p.origin + u; } catch (e) { continue; } }
    else if (!/^https?:/i.test(u)) continue;
    if (!isSupjavMovieUrl(u) || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}
function findSupjavNextPage(html, baseUrl) {
  const re = /href=["']([^"']+)["']/gi;
  let m;
  const cands = [];
  while ((m = re.exec(html))) {
    const u = m[1];
    if (/[?&]page=\d+/i.test(u) || /\/page\/\d+/i.test(u)) cands.push(u);
  }
  for (let u of cands) {
    if (/^\//.test(u)) { try { const p = new URL(baseUrl); u = p.origin + u; } catch (e) { continue; } }
    if (!/^https?:/i.test(u) || isSupjavMovieUrl(u)) continue;
    return u;
  }
  return null;
}
async function collectSupjavList(firstUrl, firstHtml, ctx, baseHeaders, doFetch, agent) {
  const { config, paceHost } = ctx;
  const maxPages = (config && config.listMaxPages) ? Math.max(1, config.listMaxPages) : Infinity;
  const seen = new Set();       // movie urls
  const seenPages = new Set();  // visited page urls (repeat guard)
  const out = [];
  let html = firstHtml;
  let url = firstUrl;
  for (let page = 0; page < maxPages && url; page++) {
    if (seenPages.has(url)) break; // stop on a repeated page (infinite-pagination guard)
    seenPages.add(url);
    for (const u of extractSupjavMovieLinks(html, url)) {
      if (!seen.has(u)) { seen.add(u); out.push(u); }
    }
    let next = findSupjavNextPage(html, url);
    if (next && (seenPages.has(next) || seen.has(next))) next = null;
    if (!next) break;
    if (paceHost) await paceHost(next);
    html = await doFetch(next, agent, baseHeaders, 0, (config && config.maxRetries) || DEFAULT_MAX_RETRIES);
    url = next;
  }
  return out;
}

// ---- sextb list-page collection (homepage / genre / actress / pagination) ----
// sextb movie pages are single-segment slugs (e.g. /oba-031-rm, /33lbuabc),
// while list pages use prefixes (/genre, /actress, /list-*, /jav-*) or the
// homepage root. The backup domain is sextb.cc.
function isSextbHost(u) {
  try { return /(?:sextb)\.(?:net|cc)$/i.test(new URL(u).hostname); } catch (e) { return false; }
}
function isSextbListUrl(url) {
  try {
    const p = new URL(url);
    if (!isSextbHost(url)) return false;
    if (/^\/$/.test(p.pathname)) return true; // homepage
    if (/^\/(genre|actor|actress|list|jav|category|categories|tag|tags|search|page|top|latest|popular|model|free-cams|user|terms|privacy|contact|faq|about|login|register|stream|watch|home|actresses|studio|studios|series|playlist)\b/i.test(p.pathname)) return true;
    return /[?&](s|q|search|query)=/i.test(p.search) || /[?&]page=\d+/i.test(p.search) || /\/page\/\d+/i.test(p.pathname);
  } catch (e) { return false; }
}
function isSextbMovieUrl(u) {
  try {
    const p = new URL(u);
    if (!isSextbHost(u)) return false;
    if (/^\/(genre|actor|actress|list|jav|category|categories|tag|tags|search|page|top|latest|popular|model|free-cams|user|terms|privacy|contact|faq|about|login|register|stream|watch|studio|studios|series|playlist)\b/i.test(p.pathname)) return false;
    return /^\/[^/]+\/?$/i.test(p.pathname); // exactly one path segment
  } catch (e) { return false; }
}
function extractSextbMovieLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /href=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    let u = m[1];
    if (!u || u.startsWith("#") || /^javascript:/i.test(u)) continue;
    if (/^\//.test(u)) { try { const p = new URL(baseUrl); u = p.origin + u; } catch (e) { continue; } }
    else if (!/^https?:/i.test(u)) continue;
    if (!isSextbMovieUrl(u) || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}
function findSextbNextPage(html, baseUrl) {
  const re = /href=["']([^"']+)["']/gi;
  let m;
  const cands = [];
  while ((m = re.exec(html))) {
    const u = m[1];
    if (/[?&]page=\d+/i.test(u) || /\/page\/\d+/i.test(u)) cands.push(u);
  }
  for (let u of cands) {
    if (/^\//.test(u)) { try { const p = new URL(baseUrl); u = p.origin + u; } catch (e) { continue; } }
    if (!/^https?:/i.test(u) || isSextbMovieUrl(u)) continue;
    return u;
  }
  return null;
}
async function collectSextbList(firstUrl, firstHtml, ctx, baseHeaders, doFetch, agent) {
  const { config, paceHost } = ctx;
  const maxPages = (config && config.listMaxPages) ? Math.max(1, config.listMaxPages) : Infinity;
  const seen = new Set();
  const seenPages = new Set();
  const out = [];
  let html = firstHtml;
  let url = firstUrl;
  for (let page = 0; page < maxPages && url; page++) {
    if (seenPages.has(url)) break;
    seenPages.add(url);
    for (const u of extractSextbMovieLinks(html, url)) {
      if (!seen.has(u)) { seen.add(u); out.push(u); }
    }
    let next = findSextbNextPage(html, url);
    if (next && (seenPages.has(next) || seen.has(next))) next = null;
    if (!next) break;
    if (paceHost) await paceHost(next);
    html = await doFetch(next, agent, baseHeaders, 0, (config && config.maxRetries) || DEFAULT_MAX_RETRIES);
    url = next;
  }
  return out;
}

async function resolveJavAggregator(videoPageUrl, { proxyManager, config, paceHost, fetchHtml: injectedFetch }, baseHeaders = {}) {
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const proxy = config.autoProxy ? await proxyManager.pickBest(videoPageUrl, 6000) : null;
  const agent = proxy ? proxyManager.agentFor(proxy, videoPageUrl) : null;
  const doFetch = injectedFetch || fetchHtml;
  if (paceHost) await paceHost(videoPageUrl);
  let html;
  try {
    html = await doFetch(videoPageUrl, agent, baseHeaders, 0, maxRetries);
  } catch (err) {
    throw new Error("JAV site: failed to fetch page - " + err.message);
  }
  if (isCfChallengeHtml(html)) {
    // Anti-bot/Cloudflare: Node usually can't get past without cookies. Point the
    // user at the built-in Browser so the Deep Grab extension can capture the
    // stream (supjav.php iframe / m3u8) via webRequest.
    const err = new Error("JAV site: Cloudflare challenge page — open it in the built-in Browser to capture the stream.");
    err.category = "requires-browser";
    throw err;
  }
  // 1) supjav player iframe → delegate (covers streamtape + turbovidhls HLS)
  const sj = html.match(JAV_SUPJAV_IFRAME_RE);
  if (sj) {
    const r = await resolveSupjav(sj[1], { proxyManager, config, paceHost }, baseHeaders);
    if (/streamtape|fstape\.com/i.test(r.resolvedUrl)) {
      const r2 = await resolveStreamtape(r.resolvedUrl, { proxyManager, config, paceHost }, { ...baseHeaders, Referer: r.resolvedUrl });
      return r2.resolvedUrl;
    }
    return r.resolvedUrl;
  }
  // 2) m3u8 inside a <script> (JW Player / custom HTML5 player)
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let sm;
  while ((sm = scriptRe.exec(html)) !== null) {
    const sc = sm[1];
    if (JAV_SCRIPT_M3U8_RE.test(sc)) {
      const m = sc.match(JAV_SCRIPT_M3U8_RE);
      if (m) return m[0];
    }
  }
  // 3) direct <video>/<source> or "file":"..." style URL
  const src = html.match(JAV_SRC_RE);
  if (src) return src[1].trim();
  // 4) LIST page (category / popular / search / pagination): collect movie links
  const isSextb = isSextbHost(videoPageUrl);
  const page1Links = isSextb ? extractSextbMovieLinks(html, videoPageUrl) : extractSupjavMovieLinks(html, videoPageUrl);
  const listUrlCheck = isSextb ? isSextbListUrl(videoPageUrl) : isSupjavListUrl(videoPageUrl);
  if (page1Links.length && (listUrlCheck || page1Links.length >= 3)) {
    const list = isSextb
      ? await collectSextbList(videoPageUrl, html, { proxyManager, config, paceHost }, baseHeaders, doFetch, agent)
      : await collectSupjavList(videoPageUrl, html, { proxyManager, config, paceHost }, baseHeaders, doFetch, agent);
    if (list.length) return list;
  }
  throw new Error("JAV site: no supjav iframe or direct m3u8/mp4 source found");
}

async function resolveCnPorn(videoPageUrl, { proxyManager, config, paceHost }, baseHeaders = {}) {
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const proxy = config.autoProxy ? await proxyManager.pickBest(videoPageUrl, 6000) : null;
  const agent = proxy ? proxyManager.agentFor(proxy, videoPageUrl) : null;
  if (paceHost) await paceHost(videoPageUrl);
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
      if (paceHost) await paceHost(embedUrl);
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

async function resolveXVideos(videoPageUrl, { proxyManager, config, paceHost }, baseHeaders = {}) {
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const proxy = config.autoProxy ? await proxyManager.pickBest(videoPageUrl, 6000) : null;
  const agent = proxy ? proxyManager.agentFor(proxy, videoPageUrl) : null;
  if (paceHost) await paceHost(videoPageUrl);
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

async function resolveXHamster(videoPageUrl, { proxyManager, config, paceHost }, baseHeaders = {}) {
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const proxy = config.autoProxy ? await proxyManager.pickBest(videoPageUrl, 6000) : null;
  const agent = proxy ? proxyManager.agentFor(proxy, videoPageUrl) : null;
  if (paceHost) await paceHost(videoPageUrl);
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

// Extract a direct download URL from a file-host page (RapidGator / keep2share).
// These pages show a countdown + download button whose onclick/data-url/href
// contains the real download token. We extract it so the downloader can fetch
// the file directly.
function extractFileHostUrl(pageUrl, html) {
  if (!html) return null;
  const patterns = [
    // RapidGator: button/link with /freedl/ or /download/ path + token params
    /(?:href|data-url|onclick)\s*[:=]\s*["']?(https?:\/\/[^\s"'<>]*(?:\/freedl\/|\/download\/)[^\s"'<>]+)/gi,
    // keep2share: onclick with /token/ path
    /(?:href|data-url|onclick)\s*[:=]\s*["']?(https?:\/\/[^\s"'<>]*\/token\/[^\s"'<>]+)/gi,
    // Generic: any link with /download/ + token-like params
    /(?:href|data-url)\s*[:=]\s*["']?(https?:\/\/[^\s"'<>]*\/download\/[^"'\s<>]+)/gi,
    // Generic: form action pointing to a download endpoint
    /<form[^>]*action=["'](https?:\/\/[^\s"'<>]*(?:download|dl)[^"'\s<>]*)["']/gi,
    // Generic: data-url or data-href on a button/div
    /data-(?:url|href)=["'](https?:\/\/[^"'\s<>]+)["']/gi
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) {
      try { return new URL(m[1], pageUrl).href; } catch (e) { continue; }
    }
  }
  return null;
}

// Resolve a file-host page (RG / K2S) to a direct download URL.
// Fetches the page, waits briefly for any countdown, then extracts the link.
async function resolveFileHost(pageUrl, { proxyManager, config, paceHost }, baseHeaders = {}) {
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const proxy = config.autoProxy ? await proxyManager.pickBest(pageUrl, 6000) : null;
  const agent = proxy ? proxyManager.agentFor(proxy, pageUrl) : null;
  if (paceHost) await paceHost(pageUrl);
  const html = await fetchHtml(pageUrl, agent, baseHeaders, 0, maxRetries);
  const url = extractFileHostUrl(pageUrl, html);
  if (url) return { resolvedUrl: url, proxy, agent, origin: "file-host" };
  // Fallback: look for any direct-link-ish URL in the page
  const generic = html.match(/https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8|mpd)[^\s"'<>]*/i);
  if (generic) return { resolvedUrl: generic[0], proxy, agent, origin: "file-host-fallback" };
  const err = new Error("File host: no download link found on page — open in built-in Browser.");
  err.category = "requires-browser";
  throw err;
}

// Resolve a supjav ?dl= link by tracing the redirect chain (HTTP 3xx + JS
// redirects through intermediate pages like go.mayzaent.com) to the final
// file-host page, then extract the direct download URL.
async function resolveSupjavDl(dlUrl, { proxyManager, config, paceHost }, baseHeaders = {}) {
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const proxy = config.autoProxy ? await proxyManager.pickBest(dlUrl, 6000) : null;
  const agent = proxy ? proxyManager.agentFor(proxy, dlUrl) : null;
  // Trace through intermediate JS-redirect pages (mayzaent, mnaspm, etc.)
  const { finalUrl, html } = await followRedirectChain(dlUrl, { agent, headers: { ...baseHeaders, Referer: baseHeaders.Referer || dlUrl } });
  // If the chain ended on a file-host page, extract the download link
  if (FILEHOST_RE.test(finalUrl)) {
    if (html) {
      const url = extractFileHostUrl(finalUrl, html);
      if (url) return { resolvedUrl: url, proxy, agent, origin: "supjav-dl-rg" };
    }
    return await resolveFileHost(finalUrl, { proxyManager, config, paceHost }, { ...baseHeaders, Referer: dlUrl });
  }
  // If the chain ended on a direct file URL (mp4/m3u8), return it
  if (/\.(mp4|m3u8|mpd)(?:\?|$)/i.test(finalUrl)) {
    return { resolvedUrl: finalUrl, proxy, agent, origin: "supjav-dl-direct" };
  }
  // If we got HTML from the final page, try generic extraction
  if (html) {
    const url = extractFileHostUrl(finalUrl, html);
    if (url) return { resolvedUrl: url, proxy, agent, origin: "supjav-dl-extracted" };
    const generic = html.match(/https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8|mpd)[^\s"'<>]*/i);
    if (generic) return { resolvedUrl: generic[0], proxy, agent, origin: "supjav-dl-fallback" };
  }
  const err = new Error("Supjav download: redirect chain ended at non-file URL (" + finalUrl.slice(0, 80) + ") — open in built-in Browser.");
  err.category = "requires-browser";
  throw err;
}

// Detect the site and follow the re-resolution chain to a final direct URL.
// Returns null for URLs with no resolver (generic mp4 pass through untouched).
async function resolveUrl(url, { proxyManager, config, paceHost }, baseHeaders = {}) {
  const ctx = { proxyManager, config, paceHost };
  if (/(?:streamtape|fstape)\.com/i.test(url)) {
    const r = await resolveStreamtape(url, ctx, baseHeaders);
    return r.resolvedUrl;
  }
  if (SJ_PLAYER_RE.test(url)) {
    const r = await resolveSupjav(url, ctx, baseHeaders);
    if (/streamtape|fstape\.com/i.test(r.resolvedUrl)) {
      const r2 = await resolveStreamtape(r.resolvedUrl, ctx, { ...baseHeaders, Referer: r.resolvedUrl });
      return r2.resolvedUrl;
    }
    if (HLS_RE.test(r.resolvedUrl)) return r.resolvedUrl;
    return r.resolvedUrl;
  }
  // supjav ?dl= download links (redirect chain → RG/K2S → direct file URL)
  if (SJ_DL_RE.test(url) && SJ_HOST_RE.test(url)) {
    const r = await resolveSupjavDl(url, ctx, baseHeaders);
    return r.resolvedUrl;
  }
  // Standalone RG/K2S pages (e.g. pasted directly)
  if (FILEHOST_RE.test(url)) {
    const r = await resolveFileHost(url, ctx, baseHeaders);
    return r.resolvedUrl;
  }
  if (/jable\.tv/i.test(url)) {
    const r = await resolveJable(url, ctx, baseHeaders);
    return r.resolvedUrl;
  }
  if (/sextb|javmost|supjav\.(?:com|ph|net)/i.test(url)) {
    const r = await resolveJavAggregator(url, ctx, baseHeaders);
    return r;
  }
  if (/missav\d*\.(ws|ai|com|live|xyz)/i.test(url)) {
    const r = await resolveMissav(url, ctx, baseHeaders);
    return r.resolvedUrl;
  }
  if (/cnporn\.org/i.test(url)) {
    const r = await resolveCnPorn(url, ctx, baseHeaders);
    if (/streamtape\.com/i.test(r.resolvedUrl) || r.origin === "streamtape-embed") {
      const r2 = await resolveStreamtape(r.resolvedUrl, ctx, baseHeaders);
      return r2.resolvedUrl;
    }
    return r.resolvedUrl;
  }
  if (/xvideos\.com/i.test(url)) {
    const r = await resolveXVideos(url, ctx, baseHeaders);
    if (/streamtape\.com/i.test(r.resolvedUrl)) {
      const r2 = await resolveStreamtape(r.resolvedUrl, ctx, baseHeaders);
      return r2.resolvedUrl;
    }
    return r.resolvedUrl;
  }
  if (/xhamster\.com/i.test(url)) {
    const r = await resolveXHamster(url, ctx, baseHeaders);
    if (/xvideos\.com/i.test(r.resolvedUrl)) {
      const r2 = await resolveXVideos(r.resolvedUrl, ctx, baseHeaders);
      if (/streamtape\.com/i.test(r2.resolvedUrl)) {
        const r3 = await resolveStreamtape(r2.resolvedUrl, ctx, baseHeaders);
        return r3.resolvedUrl;
      }
      return r2.resolvedUrl;
    }
    return r.resolvedUrl;
  }
  return null;
}

// ---- JableTV (jable.tv) ----
// Matches rust fetch_jable_page (src-tauri/src/downloader/page.rs):
//   - title = first <h1> text (strip nested tags), else <title>
//   - m3u8: scan <script> nodes whose text contains "hls" or "m3u8",
//     then regex `https?://[^\s'\"\\]+\.m3u8` inside that script only.
const JABLE_M3U8_RE = /https?:\/\/[^\s'\"\\]+\.m3u8/;

async function resolveJable(videoPageUrl, { proxyManager, config, paceHost }, baseHeaders = {}) {
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const proxy = config.autoProxy ? await proxyManager.pickBest(videoPageUrl, 6000) : null;
  const agent = proxy ? proxyManager.agentFor(proxy, videoPageUrl) : null;
  if (paceHost) await paceHost(videoPageUrl);
  let html;
  try {
    html = await fetchHtml(videoPageUrl, agent, baseHeaders, 0, maxRetries);
  } catch (err) {
    throw new Error("JableTV: failed to fetch page - " + err.message);
  }
  if (isCfChallengeHtml(html)) {
    const err = new Error("JableTV: Cloudflare challenge page — run CF verification first");
    err.category = "cf-blocked";
    throw err;
  }
  // Title: first <h1> text with nested tags stripped, else <title>
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const TAG_RE = /<[^>]+>/g;
  const title = h1Match
    ? h1Match[1].replace(TAG_RE, "").trim() || "jable_video"
    : (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]
      ?.replace(TAG_RE, "").trim() || "jable_video";
  // m3u8: only inside script blocks that mention hls/m3u8 (matches rust select+filter)
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m3u8 = null;
  let sm;
  while ((sm = scriptRe.exec(html)) !== null) {
    const sc = sm[1];
    if ((sc.includes("hls") || sc.includes("m3u8")) && JABLE_M3U8_RE.test(sc)) {
      m3u8 = sc.match(JABLE_M3U8_RE)[0];
      break;
    }
  }
  if (!m3u8) throw new Error("JableTV: no m3u8 URL found on page");
  return { resolvedUrl: m3u8, proxy, agent, title, origin: "jable" };
}

// ---- MissAV (missav.ws / missav.ai / etc.) ----
// Matches rust parse_missav_page (src-tauri/src/downloader/parsers.rs):
//   1. title from `"og:title"\s+content="([^"]+)"`
//   2. scan every <script>; if text contains "eval(function" AND "m3u8",
//      unpack_js_eval it, then two regexes on the unpacked text:
//        a) `source\s*=\s*[\\']*(https?://[^'\\;\s]+\.m3u8)`  (preferred)
//        b) fallback: `(https?://[^\\'\\;\s]+\.m3u8)`
//   3. CF challenge page → cf-blocked; unpack failure / no m3u8 → requires-browser
function toBase(n, base) {
  if (n === 0) return "0";
  const digits = "0123456789abcdefghijklmnopqrstuvwxyz";
  let s = "";
  while (n > 0) { s = digits.charAt(n % base) + s; n = Math.floor(n / base); }
  return s;
}

const MISSAV_PACKED_RE = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d\s*\)\s*\{[\s\S]*?\}\s*\(\s*'([\s\S]*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([\s\S]*?)'\s*\.split\s*\(\s*'|'\s*\)/;

function unpackJsEval(scriptText) {
  const m = scriptText.match(MISSAV_PACKED_RE);
  if (!m) return null;
  const packed = m[1], a = parseInt(m[2], 10), c = parseInt(m[3], 10);
  const keys = m[4].split("|");
  if (a <= 1 || c > 200000) return null;
  const lookup = new Map();
  for (let i = 0; i < c; i++) {
    const key = toBase(i, a);
    lookup.set(key, i < keys.length && keys[i] !== "" ? keys[i] : key);
  }
  return packed.replace(/\b\w+\b/g, (word) => lookup.has(word) ? lookup.get(word) : word);
}

async function resolveMissav(videoPageUrl, { proxyManager, config, paceHost }, baseHeaders = {}) {
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const proxy = config.autoProxy ? await proxyManager.pickBest(videoPageUrl, 6000) : null;
  const agent = proxy ? proxyManager.agentFor(proxy, videoPageUrl) : null;
  if (paceHost) await paceHost(videoPageUrl);
  let html;
  try {
    html = await fetchHtml(videoPageUrl, agent, baseHeaders, 0, maxRetries);
  } catch (err) {
    throw new Error("MissAV: failed to fetch page - " + err.message);
  }
  if (isCfChallengeHtml(html)) {
    // MissAV is heavily anti-bot; Node usually can't get past CF without cookies.
    // The user needs to open the page in the built-in Browser so the Deep Grab
    // extension can capture the m3u8 via webRequest.
    const err = new Error("MissAV: Cloudflare challenge page — open it in the built-in Browser to capture the m3u8.");
    err.category = "requires-browser";
    throw err;
  }
  const og = html.match(/"og:title"\s+content="([^"]+)"/);
  const title = og ? og[1] : "missav_video";
  let m3u8Url = null;
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let sm;
  while ((sm = scriptRe.exec(html)) !== null) {
    const sc = sm[1];
    if (sc.includes("eval(function") && sc.includes("m3u8")) {
      const unpacked = unpackJsEval(sc);
      if (unpacked) {
        // preferred: `source = '...'` / `source="..."`  (rust: source\s*=\s*[\\']*)
        const src = unpacked.match(/source\s*=\s*[\\']*(https?:\/\/[^\s'";\\]+\.m3u8)/i);
        if (src) { m3u8Url = src[1]; break; }
        // fallback: any m3u8 URL in the unpacked text (rust: second regex)
        const any = unpacked.match(/https?:\/\/[^\s'";\\]+\.m3u8/);
        if (any) { m3u8Url = any[0]; break; }
      }
    }
  }
  if (!m3u8Url) {
    const err = new Error("MissAV: could not extract m3u8 from page (obfuscation may have changed) — open it in the built-in Browser to capture the m3u8.");
    err.category = "requires-browser";
    throw err;
  }
  return { resolvedUrl: m3u8Url, proxy, agent, title, origin: "missav" };
}

module.exports = { STRGV, SJ_PLAYER_RE, SJ_DL_RE, resolveStreamtape, resolveSupjav, resolveCnPorn, resolveXVideos, resolveXHamster, resolveJable, resolveMissav, resolveJavAggregator, resolveFileHost, resolveSupjavDl, resolveUrl, isSextbHost, isSextbListUrl, isSextbMovieUrl, extractSextbMovieLinks, findSextbNextPage, collectSextbList };