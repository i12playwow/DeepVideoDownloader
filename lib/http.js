// HTTP primitives shared by the resolvers and the download engine: plain HTML
// fetches with retry, and requestWithRedirects (redirect-following GET/HEAD
// used for size probes and the actual byte-range downloads).

const { transport } = require("../proxy");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_REDIRECTS = 5;
// Upper bound for any buffered HTML/playlist fetch. Pages this size are either
// a mislabeled binary served as text/html or a garbage response; unbounded
// `body += chunk` can exceed V8's max string length and crash the main process.
const MAX_HTML_BYTES = 32 * 1024 * 1024;
const RETRY_DELAY = 1000;
const DEFAULT_MAX_RETRIES = 3;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Parse the start offset from a `Content-Range: bytes START-END/TOTAL` header.
function contentRangeStart(header) {
  if (!header) return null;
  const m = /^bytes\s+(\d+)-/i.exec(String(header).trim());
  return m ? parseInt(m[1], 10) : null;
}

// Parse the TOTAL size from a `Content-Range: bytes START-END/TOTAL` header.
// Range-answering servers report a partial content-length, so the total from
// Content-Range is the only trustworthy size when a probe sends Range.
function contentRangeTotal(header) {
  if (!header) return null;
  const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(String(header).trim());
  return m ? parseInt(m[1], 10) : null;
}

async function fetchHtml(url, agent, headers = {}, retries = 0, maxRetries = DEFAULT_MAX_RETRIES) {
  const mod = transport(url);
  try {
    return await new Promise((resolve, reject) => {
      const req = mod.request(url, {
        method: "GET",
        agent,
        headers: { "User-Agent": UA, ...headers }
      }, (res) => {
        let body = "";
        let size = 0;
        let tooLarge = false;
        let settled = false;
        const rejectOnce = (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        };
        const rejectTooLarge = () =>
          rejectOnce(Object.assign(new Error("Response too large (" + Math.floor(size / (1024 * 1024)) + "MB)"), { status: 413 }));
        res.setEncoding("utf8");
        res.on("data", (c) => {
          if (settled) return;
          size += Buffer.byteLength(c);
          if (size > MAX_HTML_BYTES) {
            tooLarge = true;
            res.destroy();
            return;
          }
          body += c;
        });
        res.on("end", () => {
          if (tooLarge) return rejectTooLarge();
          if (!settled) { settled = true; resolve(body); }
        });
        res.on("error", (e) => tooLarge ? rejectTooLarge() : rejectOnce(e));
        // destroy() mid-body emits 'aborted' then 'close' (not 'error'); without
        // these the promise would hang forever instead of surfacing the 413.
        res.on("aborted", rejectTooLarge);
        res.on("close", () => {
          if (settled) return;
          if (tooLarge) return rejectTooLarge();
          rejectOnce(new Error("Response ended prematurely"));
        });
      });
      req.on("error", reject);
      req.setTimeout(30000, () => req.destroy(new Error("HTML fetch timeout")));
      req.end();
    });
  } catch (err) {
    // 4xx protocol errors (e.g. the oversized-response 413) are definitive —
    // retrying can't change them, and re-wrapping would lose the status.
    if (err && err.status && err.status >= 400 && err.status < 500) throw err;
    if (retries < maxRetries) {
      await delay(RETRY_DELAY * (retries + 1));
      return fetchHtml(url, agent, headers, retries + 1, maxRetries);
    }
    throw new Error("Failed to fetch page after " + maxRetries + " retries: " + err.message);
  }
}

async function requestWithRedirects(targetUrl, { method = "GET", headers = {}, agent = null, retries = 0, maxRetries = DEFAULT_MAX_RETRIES, onReq = null } = {}) {
  let current = targetUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let urlObj;
    try {
      urlObj = new URL(current);
    } catch (e) {
      throw new Error("Invalid URL: " + current);
    }
    try {
      const mod = transport(current);
      const result = await new Promise((resolve, reject) => {
        const req = mod.request(urlObj, {
          method,
          agent,
          headers: { "User-Agent": UA, ...headers }
        }, (res) => {
          if (onReq) onReq(req, false);
          resolve({ status: res.statusCode, headers: res.headers, res, finalUrl: current });
        });
        if (onReq) onReq(req, true);
        req.on("error", (err) => {
          if (onReq) onReq(req, false);
          reject(err);
        });
        req.setTimeout(45000, () => {
          const err = new Error("Request timeout");
          err.code = "ETIMEDOUT";
          req.destroy(err);
        });
        req.end();
      });

      const code = result.status;
      if (code >= 300 && code < 400 && result.headers.location) {
        result.res.resume();
        const loc = new URL(result.headers.location, current).href;
        const nextOrigin = new URL(loc).origin;
        if (headers.Range && nextOrigin !== new URL(current).origin) {
          delete headers.Range;
        }
        current = loc;
        continue;
      }
      return result;
    } catch (err) {
      if (retries < maxRetries && (err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.code === "ECONNREFUSED")) {
        await delay(RETRY_DELAY * (retries + 1));
        return requestWithRedirects(targetUrl, { method, headers, agent, retries: retries + 1, maxRetries, onReq });
      }
      throw err;
    }
  }
  throw new Error("Too many redirects");
}

// Follow a URL through BOTH HTTP 3xx redirects AND client-side JavaScript
// redirects (window.location, meta refresh). Returns the final URL and,
// when the final hop is an HTML page, its body text so callers can extract
// download links without a second fetch.
async function followRedirectChain(targetUrl, { agent = null, headers = {}, maxHops = 8 } = {}) {
  let current = targetUrl;
  let html = null;
  for (let hop = 0; hop < maxHops; hop++) {
    const result = await requestWithRedirects(current, { method: "GET", headers, agent, maxRetries: 2 });
    const code = result.status;
    if (code >= 300 && code < 400 && result.headers.location) {
      result.res.resume();
      current = new URL(result.headers.location, current).href;
      html = null;
      continue;
    }
    const ct = String(result.headers["content-type"] || "").toLowerCase();
    const body = await new Promise((resolve) => {
      let buf = "";
      result.res.setEncoding("utf8");
      result.res.on("data", (c) => { buf += c; });
      result.res.on("end", () => resolve(buf));
    });
    if (!/html/i.test(ct) && !/^\s*<!DOCTYPE|<html/i.test(body.slice(0, 256))) {
      return { finalUrl: current, html: null };
    }
    html = body;
    const jsRedirects = [
      /(?:window\.location(?:\.href)?|location)(?:\.replace|\.assign)?\s*\(\s*["']([^"']+)["']/gi,
      /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"'\s;>]+)/gi
    ];
    let found = null;
    for (const re of jsRedirects) {
      const m = re.exec(html);
      if (m) { found = m[1]; break; }
    }
    if (!found) return { finalUrl: current, html };
    try { current = new URL(found, current).href; } catch (e) { return { finalUrl: current, html }; }
    html = null;
  }
  return { finalUrl: current, html: null };
}

module.exports = { UA, MAX_REDIRECTS, MAX_HTML_BYTES, RETRY_DELAY, DEFAULT_MAX_RETRIES, delay, contentRangeStart, contentRangeTotal, fetchHtml, requestWithRedirects, followRedirectChain };