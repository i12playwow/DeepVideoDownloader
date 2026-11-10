"use strict";
// Bounded, host-scoped web crawl — the piece the engine was missing.
//
// The download engine already expands ONE listing page into many downloads:
// resolveUrl() returns an array of links and _runOnce enqueues every entry
// (the "list expansion"). What did not exist was the step before it — walking a
// site's pagination and finding those listing pages in the first place, which
// until now was done by hand (pasting pages) or by an unbounded Tampermonkey
// autoloop that the app could only throttle after the fact.
//
// This module does NO fetching of its own: fetchPage is injected, so the whole
// traversal is deterministic and offline-testable, and the CLI can hand it the
// app's own HTTP stack (lib/http.js + the Cloudflare browser fallback) plus the
// engine's shared junk/nav guards. Rules, each with a test:
//
//   - ONE host: an ordinary link on another host is never followed or reported
//     (a CDN <video>/media URL is still collected — see "media" below).
//   - bounded: maxPages caps page fetches, maxDepth caps how far ordinary
//     link-following walks from the start page. Pagination is NOT depth: a
//     next-page link is followed at the depth of the page that carried it, so a
//     long listing chain never trips the depth bound — maxPages stops it.
//   - polite: delayMs of quiet between page fetches, and an HTTP 429/503 with
//     Retry-After is waited out (bounded by maxRetryWaitMs) and retried, never
//     flood-retried.
//   - dedupe: a URL is fetched once and a discovered URL is reported once,
//     normalized (fragment dropped).
//   - deterministic order: pagination first (the chain is walked immediately),
//     then breadth-first over ordinary links.
//
// Two URL classes are collected:
//   - "media"  — a direct media URL (extension / playlist) on ANY host; the app
//                can download it as-is.
//   - "page"   — an in-scope page that is a download candidate (a movie/detail
//                page the engine resolves); collected only with collect:"pages"
//                because on a generic site most page links are not videos.
//
// Where a link can be picked up (each entry carries a `role` that decides what
// the crawl may do with it):
//   nav    <a href>, and a data-href/data-url card with no href — walked and
//          reported exactly like before.
//   embed  <iframe>/<embed>/<object> players — a media URL is a finding; an
//          in-scope player page is a page candidate and may be traversed, which
//          is where a listing page keeps its stream.
//   res    <video>/<source>/<audio>/<track> src, srcset lists, og:video /
//          twitter:player:stream meta, data-src/data-file/data-video payloads
//          and URLs baked into inline <script> configs. Only a MEDIA-shaped one
//          is a finding; anything else is not a link at all (a script is full
//          of arbitrary strings, and reporting those would turn the crawl into
//          a page-link farm).
//
// Attribute values are HTML-entity decoded before they are resolved, because a
// real page writes `?page=2&amp;tag=a` and the raw value is not that URL.

const DEFAULT_MEDIA_RE = /\.(?:mp4|m4v|mkv|webm|mov|avi|flv|f4v|wmv|ts|m4s|ogv|ism|mpd|m3u8)(?:$|[?#])/i;
// No recognizable extension: a format hint in the query, or an HLS path. Both
// are how signing/CDN endpoints spell "this is a stream".
const MEDIA_QUERY_RE = /[?&](?:format|ext|type|output)=(?:mp4|m3u8|hls|mpd|mkv|webm|flv)(?:[&#]|$)/i;
const MEDIA_PATH_RE = /\/(?:hls|hls2)\//i;

const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const LINKTAG_RE = /<link\b([^>]*?)\/?>/gi;
const TAG_RE = /<([a-z][a-z0-9:-]*)\b([^>]*)>/gi;
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const STRING_LIT_RE = /["']([^"'\s<>]{2,400})["']/g;

// Elements whose src/srcset is a resource reference, and elements that embed
// another page (a player). Both are invisible to <a href> scraping.
const RES_TAGS = new Set(["video", "audio", "source", "track"]);
const EMBED_TAGS = new Set(["iframe", "embed", "object"]);
const RES_ATTRS = ["src", "data-src", "data-url", "data-file", "data-video", "data-mp4",
  "data-source", "data-source-url", "data-hls", "data-stream", "data-play"];
const PAGE_ATTRS = ["data-href", "data-url", "data-link", "data-permalink", "data-more", "data-target"];
const EMBED_ATTRS = ["src", "data-src", "data-url", "data", "data-frame", "data-embed"];
// og:video:url / og:video:secure_url / og:video:type / twitter:player:stream
const META_VIDEO_RE = /^(?:og:video(?::(?:url|secure_url|type))?|twitter:player:stream|contenturl)$/i;

const ENTITY_MAP = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", sol: "/" };

/** Decode the HTML entities a real href carries (`&amp;`, `&#38;`, `&#x26;`).
 * Without this a listing link is fetched as `?page=2&amp;tag=a` — a different
 * URL, with the second parameter folded into the first one's value. */
function decodeEntities(s) {
  return String(s == null ? "" : s).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const k = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITY_MAP, k) ? ENTITY_MAP[k] : m;
  });
}

const ATTR_RE_CACHE = new Map();
function attrOf(tag, name) {
  let re = ATTR_RE_CACHE.get(name);
  if (!re) {
    re = new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))", "i");
    ATTR_RE_CACHE.set(name, re);
  }
  const m = re.exec(String(tag || ""));
  if (!m) return "";
  const raw = m[1] != null ? m[1] : (m[2] != null ? m[2] : (m[3] != null ? m[3] : ""));
  return decodeEntities(raw);
}

function textOf(inner) {
  return decodeEntities(String(inner).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

/** Normalize a URL for dedupe: fragments dropped, resolved against a base.
 * Returns null for anything that is not a fetchable http(s) URL (mailto:,
 * javascript:, data:, blob:, chrome-extension:, relative junk). */
function normUrl(u, base) {
  if (!u) return null;
  let x;
  try { x = base ? new URL(String(u), base) : new URL(String(u)); } catch { return null; }
  if (x.protocol !== "http:" && x.protocol !== "https:") return null;
  x.hash = "";
  return x.href;
}

function hostOf(u) {
  try { return new URL(u).host.toLowerCase(); } catch { return ""; }
}

/** First attribute in `names` that resolves to a usable URL. */
function firstUrlFrom(attrs, names, base) {
  for (const n of names) {
    const v = attrOf(attrs, n);
    if (!v) continue;
    const u = normUrl(v, base);
    if (u) return u;
  }
  return null;
}

/** "a.mp4 480w, b.mp4 1080w" -> ["a.mp4", "b.mp4"] (descriptors dropped). */
function srcsetList(v) {
  return String(v || "")
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/** Undo the escaping a URL carries inside a JS string literal: `\/` from JSON,
 * `\u0026`-style entities, `\"`. */
function unescapeJsUrl(s) {
  return String(s || "")
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(.)/g, "$1");
}

/** A direct media URL: media extension, a format hint, or an HLS path. */
function isMediaUrl(u) {
  const s = String(u || "");
  return DEFAULT_MEDIA_RE.test(s) || MEDIA_QUERY_RE.test(s) || MEDIA_PATH_RE.test(s);
}

function defaultIsMediaUrl(u) { return isMediaUrl(u); }

/**
 * Every URL a page carries, absolutized, de-duplicated, in document order.
 *
 * Each entry is { url, text, rel, kind, role } where role is "nav" (a real
 * page link), "embed" (an embedded player page) or "res" (a resource reference
 * — media-shaped URLs only). `kind` is provenance for diagnostics
 * (anchor/link/video/source/embed/meta/data/script). One entry per URL: an
 * anchor wins over the same URL seen again in a resource tag, so the entry
 * keeps the visible text and the navigational role.
 */
function extractLinks(html, base) {
  const out = [];
  const index = new Map(); // url -> position in out
  const push = (rec) => {
    if (!rec || !rec.url) return;
    const i = index.get(rec.url);
    if (i == null) { index.set(rec.url, out.length); out.push(rec); return; }
    // Upgrade a bare resource reference to a navigational one; never the reverse.
    if (out[i].role === "res" && rec.role !== "res") out[i] = rec;
  };
  const src = String(html || "");
  let m;

  // 1. anchors (visible text + rel), in document order
  ANCHOR_RE.lastIndex = 0;
  while ((m = ANCHOR_RE.exec(src))) {
    const text = textOf(m[2]);
    const href = attrOf(m[1], "href");
    const url = normUrl(href, base);
    if (url) { push({ url, text, rel: attrOf(m[1], "rel").toLowerCase(), kind: "anchor", role: "nav" }); continue; }
    // No usable href: some sites put the real target on data-* (JS nav).
    if (!href) {
      const alt = firstUrlFrom(m[1], PAGE_ATTRS, base);
      if (alt) push({ url: alt, text, rel: "", kind: "anchor", role: "nav" });
    }
  }

  // 2. <link href> — rel=next/prev/canonical live here
  LINKTAG_RE.lastIndex = 0;
  while ((m = LINKTAG_RE.exec(src))) {
    const url = normUrl(attrOf(m[1], "href"), base);
    if (!url) continue;
    push({ url, text: "", rel: attrOf(m[1], "rel").toLowerCase(), kind: "link", role: "nav" });
  }

  // 3. element attributes: players, embeds, og:video, JS-built cards, srcsets
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(src))) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    if (tag === "a" || tag === "link" || tag === "script") continue;
    if (tag === "meta") {
      const prop = attrOf(attrs, "property") || attrOf(attrs, "name") || attrOf(attrs, "itemprop");
      if (!META_VIDEO_RE.test(String(prop || "").trim())) continue;
      const url = normUrl(attrOf(attrs, "content"), base);
      if (url) push({ url, text: "", rel: "", kind: "meta", role: "res" });
      continue;
    }
    if (RES_TAGS.has(tag)) {
      const url = firstUrlFrom(attrs, RES_ATTRS, base);
      if (url) push({ url, text: "", rel: "", kind: tag, role: "res" });
      for (const one of srcsetList(attrOf(attrs, "srcset"))) {
        const su = normUrl(one, base);
        if (su) push({ url: su, text: "", rel: "", kind: tag, role: "res" });
      }
      continue;
    }
    if (EMBED_TAGS.has(tag)) {
      const url = firstUrlFrom(attrs, EMBED_ATTRS, base);
      if (url) push({ url, text: "", rel: "", kind: "embed", role: "embed" });
      continue;
    }
    // Any other element: JS-built cards carry their target in data-*.
    const page = firstUrlFrom(attrs, PAGE_ATTRS, base);
    if (page) push({ url: page, text: "", rel: "", kind: "data", role: "nav" });
    const res = firstUrlFrom(attrs, RES_ATTRS, base);
    if (res) push({ url: res, text: "", rel: "", kind: "data", role: "res" });
  }

  // 4. URLs baked into inline scripts — player configs and JSON blobs. Only a
  //    MEDIA-shaped literal counts: a script is full of arbitrary strings, so
  //    picking those up would turn the crawl into a page-link farm.
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(src))) {
    STRING_LIT_RE.lastIndex = 0;
    let lit;
    while ((lit = STRING_LIT_RE.exec(m[2]))) {
      const raw = unescapeJsUrl(lit[1]);
      if (!raw || !isMediaUrl(raw)) continue;
      const url = normUrl(raw, base);
      if (url) push({ url, text: "", rel: "", kind: "script", role: "res" });
    }
  }

  return out;
}

/** The page number a URL encodes, from ?page=N / ?p=N / ?pg=N or /page/N. */
function pageNumber(u) {
  const s = String(u || "");
  const q = /[?&](?:page|p|pg|paged|pagenum)=(\d+)/i.exec(s);
  if (q) return parseInt(q[1], 10);
  const p = /\/page\/(\d+)(?:\/|$)/i.exec(s);
  if (p) return parseInt(p[1], 10);
  return null;
}

/** Two URLs that differ ONLY by their page number (same origin, path, and
 * other query params) — so page N+1 of the same listing is recognized. */
function samePagePattern(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    if (x.origin !== y.origin || x.pathname !== y.pathname) return false;
    const strip = (u) => {
      const parts = [];
      u.searchParams.forEach((v, k) => { if (!/^(?:page|p|pg|paged|pagenum)$/i.test(k)) parts.push(k + "=" + v); });
      return parts.sort().join("&");
    };
    return strip(x) === strip(y);
  } catch { return false; }
}

const NEXT_TEXT_RE = /^(?:next|next page|next\s*[›»→]|older|older posts|more|more posts|[›»→]|>>|下一页|下页|次へ|次のページ)$/i;

/** Next-page candidates, most explicit first: <link rel=next>, an anchor whose
 * rel says next, an anchor whose text says "next", then a same-pattern link to
 * page N+1. Only same-host, NAVIGATIONAL candidates are returned (pagination
 * must not walk off-site, and a <video src="…page=2"> is not a page), capped
 * at 2 so one page can never fan out into a link farm. */
function nextPageCandidates(html, pageUrl, links) {
  const page = normUrl(pageUrl) || String(pageUrl);
  const pageHost = hostOf(page);
  const out = [];
  const push = (u) => {
    const n = normUrl(u, page);
    if (!n || hostOf(n) !== pageHost || n === page || out.includes(n)) return;
    out.push(n);
  };
  const list = (links || extractLinks(html, page)).filter((l) => !l.role || l.role === "nav");
  for (const l of list) if (/(?:^|\s)next(?:\s|$)/i.test(l.rel)) push(l.url);
  for (const l of list) if (l.kind === "anchor" && NEXT_TEXT_RE.test(l.text)) push(l.url);
  const n = pageNumber(page);
  if (n != null) {
    for (const l of list) {
      if (!samePagePattern(l.url, page)) continue;
      if (pageNumber(l.url) === n + 1) push(l.url);
    }
  }
  return out.slice(0, 2);
}

/**
 * Create a crawler. The only required option is fetchPage.
 *
 * fetchPage(url) -> Promise<{ status|statusCode, headers, body|html, finalUrl }>
 *   and must THROW for a failed fetch; attach `status` for an HTTP failure and
 *   `retryAfter` (seconds) for a 429/503 so the crawler can back off properly.
 *
 * Options: delayMs, maxPages, maxDepth, follow ("next"|"links"|"none"),
 * collect ("media"|"pages"), sameHostOnly, maxRetries, maxRetryWaitMs, sleep,
 * isMediaUrl, isRejected (junk/ad/nav guards — rejected links are counted, never
 * followed), isAllowedPage (page-collection gate), shouldStop (checked between
 * pages; a true return ends the crawl, reported as totals.stopped),
 * onProgress(event).
 */
function createCrawler(opts) {
  const o = Object.assign({
    fetchPage: null,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    delayMs: 1200,
    maxPages: 25,
    maxDepth: 1,
    follow: "next",
    collect: "media",
    sameHostOnly: true,
    maxRetries: 1,
    maxRetryWaitMs: 60000,
    isMediaUrl: defaultIsMediaUrl,
    isRejected: () => false,
    isAllowedPage: () => true,
    shouldStop: null,        // () => true ends the crawl (checked between pages)
    onProgress: null,
  }, opts || {});
  if (typeof o.fetchPage !== "function") throw new Error("crawl: fetchPage is required");

  const queue = [];
  const seen = new Set();
  const discovered = [];
  const reported = new Set();
  const pages = [];
  const errors = [];
  const nextChain = [];
  const stats = { fetches: 0, retries: 0, rejected: 0, waitedMs: 0 };
  let stopped = false;

  function report(url, kind, referer) {
    const n = normUrl(url);
    if (!n || reported.has(n)) return false;
    reported.add(n);
    discovered.push({ url: n, kind, referer });
    return true;
  }

  function enqueue(url, depth, front) {
    const n = normUrl(url);
    if (!n || seen.has(n)) return false;
    if (queue.some((q) => q.url === n)) return false;
    if (front) queue.unshift({ url: n, depth });
    else queue.push({ url: n, depth });
    return true;
  }

  async function crawl(startUrls) {
    const starts = (Array.isArray(startUrls) ? startUrls : [startUrls]).map((u) => normUrl(u)).filter(Boolean);
    if (!starts.length) throw new Error("crawl: no usable http(s) start URL");
    const scopes = new Set(starts.map(hostOf));
    for (const s of starts) enqueue(s, 0, false);

    while (queue.length && stats.fetches < o.maxPages) {
      // A cancel is checked between pages: the caller (the window's Stop button)
      // flips a flag, the crawl ends at the next page boundary and reports it.
      if (o.shouldStop && o.shouldStop()) { stopped = true; break; }
      const node = queue.shift();
      if (seen.has(node.url)) continue;
      seen.add(node.url);

      let res = null;
      let error = null;
      for (let attempt = 0; ; attempt++) {
        if (attempt === 0) stats.fetches++;
        try {
          res = await o.fetchPage(node.url);
          error = null;
          break;
        } catch (e) {
          const status = e && (e.status || e.statusCode);
          const waitS = e && e.retryAfter != null ? Number(e.retryAfter) : 0;
          const retryable = status === 429 || status === 503 || waitS > 0;
          if (retryable && attempt < o.maxRetries) {
            stats.retries++;
            const ms = Math.min(waitS > 0 ? waitS * 1000 : o.delayMs, o.maxRetryWaitMs);
            if (ms > 0) { stats.waitedMs += ms; await o.sleep(ms); }
            continue;
          }
          error = e;
          break;
        }
      }

      const finalUrl = (res && (res.finalUrl || res.url)) || node.url;
      // A failed fetch carries its HTTP status on the error (fetchPage throws
      // with a status field); keep it so a caller can tell a 429 from a 404.
      const errStatus = (error && (error.status || error.statusCode)) || 0;
      const page = {
        url: node.url, finalUrl, depth: node.depth,
        status: res ? (res.status || res.statusCode || 0) : errStatus,
        ok: !error, links: 0, media: 0, pages: 0, next: [], rejected: 0,
        error: error ? String((error && error.message) || error) : "",
      };

      if (!error) {
        const body = String((res && (res.body != null ? res.body : res.html)) || "");
        const links = extractLinks(body, finalUrl);
        page.links = links.length;
        // Next-page links are TRAVERSAL, not findings: they are walked below,
        // so they are never reported as page candidates (a listing page is not
        // a download) — and a page linking to itself is skipped for the same
        // reason.
        const nexts = o.follow === "none" ? [] : nextPageCandidates(body, finalUrl, links);
        for (const l of links) {
          if (l.url === finalUrl || nexts.includes(l.url)) continue;
          const role = l.role || "nav";
          if (o.isRejected(l.url)) { stats.rejected++; page.rejected++; continue; }
          if (o.isMediaUrl(l.url)) {
            if (report(l.url, "media", finalUrl)) page.media++;
            continue;
          }
          // A resource reference that is not media is not a link: <script>
          // strings, poster images and API paths are not candidates, so they
          // are neither reported nor counted as rejected.
          if (role === "res") continue;
          const inScope = !o.sameHostOnly || scopes.has(hostOf(l.url));
          if (!inScope || !o.isAllowedPage(l.url)) { stats.rejected++; page.rejected++; continue; }
          if (o.collect === "pages") { if (report(l.url, "page", finalUrl)) page.pages++; }
          if (o.follow === "links" && node.depth + 1 <= o.maxDepth) enqueue(l.url, node.depth + 1, false);
        }
        for (const u of nexts) {
          if (o.sameHostOnly && !scopes.has(hostOf(u))) continue;
          page.next.push(u);
          nextChain.push(u);
          enqueue(u, node.depth, true);
        }
      } else {
        errors.push({ url: node.url, status: page.status, error: page.error });
      }

      pages.push(page);
      // `found` is a snapshot so a consumer (the window, the CLI) can render
      // findings live instead of waiting for the final report.
      if (o.onProgress) o.onProgress({ page, stats: Object.assign({}, stats), discovered: discovered.length, found: discovered.slice() });
      if (queue.length && stats.fetches < o.maxPages && o.delayMs > 0) {
        stats.waitedMs += o.delayMs;
        await o.sleep(o.delayMs);
      }
    }

    return {
      start: starts,
      pages,
      discovered,
      nextChain,
      errors,
      totals: {
        pages: pages.length,
        fetched: pages.filter((p) => p.ok).length,
        failed: pages.filter((p) => !p.ok).length,
        discovered: discovered.length,
        media: discovered.filter((d) => d.kind === "media").length,
        pageCandidates: discovered.filter((d) => d.kind === "page").length,
        rejected: stats.rejected,
        retries: stats.retries,
        waitedMs: stats.waitedMs,
        truncated: queue.length > 0 || stats.fetches >= o.maxPages,
        stopped,
      },
    };
  }

  return { crawl };
}

module.exports = {
  createCrawler,
  extractLinks,
  nextPageCandidates,
  normUrl,
  hostOf,
  pageNumber,
  samePagePattern,
  isMediaUrl,
  decodeEntities,
  unescapeJsUrl,
  srcsetList,
};
