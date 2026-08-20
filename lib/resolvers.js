// Site-specific resolvers: take a video page / embed URL and return the final
// direct download URL (a signed streamtape get_video link, an m3u8 playlist,
// or a generic mp4). Each resolve*() shares one signature and re-resolves when
// its result is another supported site (see resolveUrl dispatcher below).

const { URL } = require("url");
const { fetchHtml, requestWithRedirects, DEFAULT_MAX_RETRIES } = require("./http");
const { HLS_RE } = require("./hls");

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

module.exports = { STRGV, SJ_PLAYER_RE, resolveStreamtape, resolveSupjav, resolveCnPorn, resolveXVideos, resolveXHamster, resolveUrl };