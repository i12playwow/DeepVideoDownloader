"use strict";
// The app-side half of the web crawl (see lib/crawl.js for the traversal rules
// and scripts/web-crawl.js for the CLI): the page fetcher built on the app's
// own HTTP stack, the engine's guard composition, and a run state the window
// (or the CLI) drives.
//
// Split of responsibilities, deliberately:
//   - lib/crawl.js      — pure traversal; fetchPage is injected, no requires.
//   - lib/crawl-runner.js (this file) — the app stack: requestWithRedirects
//                          (redirect-following, 45s socket timeout) + the
//                          Cloudflare browser fallback for a challenged page +
//                          downloader.js's junk/nav/browser-UI guards, exposed
//                          as ONE definition that the CLI and the window both
//                          use (a crawl must never fetch or queue what the
//                          engine's enqueue() would refuse).
//   - scripts/web-crawl.js — argv/output/WS-enqueue only.
//   - main.js/lib/ipc.js — the window's Start/Stop/Queue surface.
//
// The runner emits a plain serializable snapshot after every page (and on
// start/stop), because that is exactly what crosses the IPC boundary.

const path = require("path");
const { createCrawler } = require("./crawl");
const { requestWithRedirects } = require("./http");
const { fetchPageWithFallback } = require("./cf-fallback");
const { isJunkUrl, isJunkHost, isJunkNavUrl, isJavNavPage, isBrowserUiUrl } = require("../downloader");

const MAX_BODY_BYTES = 8 * 1024 * 1024; // a listing page, not a media file

/** The engine's own URL guards, composed once (see the module comment). */
function isRejectedUrl(u) {
  return isJunkUrl(u) || isJunkHost(u) || isJunkNavUrl(u) || isJavNavPage(u) || isBrowserUiUrl(u);
}

/** Retry-After is delta-seconds or an HTTP date → seconds (>= 0), 0 if absent. */
function parseRetryAfter(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.ceil((t - Date.now()) / 1000));
}

/** A page fetcher in the shape lib/crawl.js wants: throws on any non-2xx with
 * `status` attached, and on 429/503 with `retryAfter` (seconds) so the crawl
 * loop can wait the site's own window out. A Cloudflare-challenged body (HTTP
 * 200 HTML) is routed through the real-Chrome bridge exactly like the engine's
 * own resolver fetches. */
function makeFetchPage({ headers = {}, cfFallback = true, maxBytes = MAX_BODY_BYTES } = {}) {
  return async function fetchPage(url) {
    const r = await requestWithRedirects(url, { method: "GET", headers, maxRetries: 1 });
    const status = r.status || 0;
    let body = "";
    if (r.res) {
      body = await new Promise((resolve, reject) => {
        let buf = "";
        let size = 0;
        r.res.setEncoding("utf8");
        r.res.on("data", (c) => {
          size += Buffer.byteLength(c);
          buf += c;
          if (size > maxBytes) r.res.destroy();
        });
        r.res.on("end", () => resolve(buf));
        r.res.on("close", () => resolve(buf));
        r.res.on("error", reject);
      });
    }
    if (status === 429 || status === 503) {
      const err = new Error("HTTP " + status + " (retry after)");
      err.status = status;
      err.retryAfter = parseRetryAfter(r.headers && r.headers["retry-after"]);
      throw err;
    }
    if (status < 200 || status >= 300) {
      const err = new Error("HTTP " + status);
      err.status = status;
      throw err;
    }
    const html = cfFallback ? await fetchPageWithFallback(url, body) : body;
    return { status, headers: r.headers, body: html, finalUrl: r.finalUrl || url };
  };
}

/**
 * A single-run crawl controller for the window.
 *
 * emit(snapshot)  — called on start, after every page, and on stop/end.
 * enqueue(items)  — optional async (items:[{url, referer}]) => {added, skipped}
 *                   used by queue(), so the runner never touches the engine
 *                   directly and stays testable.
 *
 * Snapshots are plain JSON: { running, start, pages, fetched, failed, found[],
 * rejected, retries, waitedMs, currentUrl, lastError, stopped, done, truncated }.
 */
function createCrawlRunner({ emit = () => {}, enqueue = null, fetchPageFor = makeFetchPage } = {}) {
  let run = null; // { opts, stopped, promise }

  function snapshot() {
    if (!run) return { running: false, done: false, stopped: false, start: [], pages: 0, fetched: 0, failed: 0, found: [], rejected: 0, retries: 0, waitedMs: 0, currentUrl: "", lastError: "", truncated: false };
    return Object.assign({ running: !run.finished, done: !!run.finished, stopped: !!run.stopped, currentUrl: run.currentUrl, lastError: run.lastError }, run.state);
  }

  function publish() { try { emit(snapshot()); } catch { /* the window is gone */ } }

  function start(opts = {}) {
    if (run && !run.finished) return { ok: false, error: "a crawl is already running" };
    const urls = (Array.isArray(opts.urls) ? opts.urls : [opts.urls]).map((u) => String(u || "").trim()).filter(Boolean);
    if (!urls.length) return { ok: false, error: "no start URL" };
    const bad = urls.filter((u) => !/^https?:\/\//i.test(u));
    if (bad.length) return { ok: false, error: "not an http(s) URL: " + bad[0] };

    const headers = {};
    if (opts.userAgent) headers["User-Agent"] = String(opts.userAgent);
    if (opts.cookie) headers.Cookie = String(opts.cookie);

    const state = {
      start: urls,
      pages: 0, fetched: 0, failed: 0, found: [], rejected: 0, retries: 0, waitedMs: 0, truncated: false,
    };
    run = { finished: false, stopped: false, currentUrl: urls[0], lastError: "", state };
    run.promise = createCrawler({
      fetchPage: fetchPageFor({ headers, cfFallback: opts.cfFallback !== false }),
      delayMs: opts.delayMs != null ? opts.delayMs : 1200,
      maxPages: opts.maxPages != null ? opts.maxPages : 25,
      maxDepth: opts.maxDepth != null ? opts.maxDepth : 1,
      follow: opts.follow || "next",
      collect: opts.collect || "media",
      sameHostOnly: opts.sameHostOnly !== false,
      isRejected: isRejectedUrl,
      shouldStop: () => run.stopped,
      onProgress: ({ page, stats, found }) => {
        state.pages = stats.fetches;
        state.retries = stats.retries;
        state.rejected = stats.rejected;
        state.waitedMs = stats.waitedMs;
        if (found) state.found = found.map((d) => ({ url: d.url, kind: d.kind, referer: d.referer }));
        run.currentUrl = page.url;
        if (page.ok) {
          state.fetched++;
        } else {
          state.failed++;
          run.lastError = page.error || ("HTTP " + page.status);
        }
        publish();
      },
    }).crawl(urls).then((report) => {
      state.pages = report.totals.pages;
      state.fetched = report.totals.fetched;
      state.failed = report.totals.failed;
      state.found = report.discovered.map((d) => ({ url: d.url, kind: d.kind, referer: d.referer }));
      state.rejected = report.totals.rejected;
      state.retries = report.totals.retries;
      state.waitedMs = report.totals.waitedMs;
      state.truncated = report.totals.truncated;
      run.stopped = !!report.totals.stopped || run.stopped;
      run.finished = true;
      publish();
      return report;
    }).catch((e) => {
      run.lastError = String((e && e.message) || e);
      run.finished = true;
      publish();
      return null;
    });
    publish();
    return { ok: true, urls };
  }

  function stop() {
    if (!run || run.finished) return { ok: false, error: "no crawl is running" };
    run.stopped = true;
    return { ok: true };
  }

  async function queue(items) {
    if (typeof enqueue !== "function") return { ok: false, error: "queueing is not wired" };
    const list = (Array.isArray(items) ? items : [items]).filter((i) => i && i.url);
    if (!list.length) return { ok: false, error: "nothing to queue" };
    const res = await enqueue(list);
    return Object.assign({ ok: true }, res || {});
  }

  return {
    start, stop, status: snapshot, queue,
    // The current run's promise (resolved/null when nothing ran). Tests and
    // shutdown paths await it; it is deliberately NOT part of start()'s reply,
    // which must stay structured-cloneable for IPC.
    settled: () => (run && run.promise) || Promise.resolve(null),
    isFetchPageFactory: fetchPageFor === makeFetchPage,
  };
}

module.exports = { createCrawlRunner, makeFetchPage, isRejectedUrl, parseRetryAfter, MAX_BODY_BYTES };
