// HTTP primitives shared by the resolvers and the download engine: plain HTML
// fetches with retry, and requestWithRedirects (redirect-following GET/HEAD
// used for size probes and the actual byte-range downloads).

const { transport } = require("../proxy");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_REDIRECTS = 5;
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
        res.setEncoding("utf8");
        res.on("data", (c) => body += c);
        res.on("end", () => resolve(body));
      });
      req.on("error", reject);
      req.setTimeout(30000, () => req.destroy(new Error("HTML fetch timeout")));
      req.end();
    });
  } catch (err) {
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

module.exports = { UA, MAX_REDIRECTS, RETRY_DELAY, DEFAULT_MAX_RETRIES, delay, contentRangeStart, contentRangeTotal, fetchHtml, requestWithRedirects };