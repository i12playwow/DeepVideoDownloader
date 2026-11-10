"use strict";
// Offline tests for the web crawl: lib/crawl.js (traversal rules) and
// scripts/web-crawl.js (the CLI: page fetching through the app's HTTP stack,
// output modes, and the WS enqueue path).
//
// Everything runs against a local paginated fixture site, so this suite needs
// no network and no Electron. The rules pinned here are the ones that make a
// crawl safe to point at a real site: one host, a page budget, a delay between
// fetches, Retry-After honoring, dedupe, and the engine's own junk/nav guards.
//
// Run: node test-web-crawl.js
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const { createCrawler, extractLinks, nextPageCandidates, normUrl, pageNumber, samePagePattern, isMediaUrl, decodeEntities, unescapeJsUrl, srcsetList } = require("./lib/crawl");
const cli = require("./scripts/web-crawl");

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log("  PASS  " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? " -> " + detail : "")); }
}

const CLI = path.join(__dirname, "scripts", "web-crawl.js");

function runCli(args, { timeout = 60000, env = {} } = {}) {
  return new Promise((resolve) => {
    const childEnv = Object.assign({}, process.env, env);
    // Never inherit the developer's bridge endpoint: a leftover DEEPGRAB_WS_URL
    // would silently point the enqueue tests at a real app.
    if (!("DEEPGRAB_WS_URL" in env)) delete childEnv.DEEPGRAB_WS_URL;
    const t0 = Date.now();
    const p = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"], env: childEnv });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => p.kill(), timeout);
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err, ms: Date.now() - t0 }); });
  });
}

// ------------------------------------------------------------------- fixture

function html(body) {
  return "<html><head><title>fixture</title></head><body>" + body + "</body></html>";
}

async function startExtServer() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    res.setHeader("content-type", "text/html");
    res.end(html('<a href="/v/ext.mp4">ext</a>'));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { base: "http://127.0.0.1:" + srv.address().port, hits, close: () => new Promise((r) => srv.close(r)) };
}

// A page shaped like a real listing/player page: the stream is NOT in an
// anchor, it is in a <video>/<source>, a player iframe, an og:video meta tag, a
// data-* payload and an inline player config. `&amp;` is a real entity, and
// /api/status is the kind of JS string that must never be picked up.
const RICH = [
  '<div class="card" data-href="/movie/777"><span>card</span></div>',
  '<video controls src="/v/video-only.mp4"><source src="/v/rich.m3u8" type="application/x-mpegURL"></video>',
  '<div data-video="/v/rich.mp4"></div>',
  '<img data-src="/assets/poster.jpg" alt="">',
  '<source srcset="/v/rich-720.mp4 720w, /v/rich-1080.mp4 1080w">',
  '<iframe src="/embed/9"></iframe>',
  '<meta property="og:video:secure_url" content="https://cdn.test/og/master.m3u8">',
  '<div data-file="https://cdn.test/hls/index.m3u8"></div>',
  '<script>var player={file:"https:\\/\\/cdn.test\\/js\\/master.m3u8?token=1"};loadSource("/api/status");</script>',
  '<a href="/v/rich.mp4">same file as the video tag</a>',
  '<a href="/l?page=2&amp;tag=a">entity-coded page link</a>',
].join("\n");

async function startSite(extBase) {
  const hits = { paths: [], ua: [], cookie: [] };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    hits.paths.push(req.url);
    hits.ua.push(req.headers["user-agent"] || "");
    hits.cookie.push(req.headers.cookie || "");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (u.pathname === "/slow") {
      setTimeout(() => res.end(html('<a href="/v/slow.mp4">slow</a>')), 300);
      return;
    }
    if (u.pathname === "/flaky") {
      if (hits.paths.filter((p) => p === "/flaky").length === 1) {
        res.statusCode = 429;
        res.setHeader("retry-after", "1");
        res.end(html("slow down"));
        return;
      }
      res.end(html('<a href="/v/flaky.mp4">flaky</a>'));
      return;
    }
    if (u.pathname === "/flaky5") {
      res.statusCode = 429;
      res.setHeader("retry-after", "1");
      res.end(html("always busy"));
      return;
    }
    if (u.pathname === "/movie/12345") {
      res.end(html('<a href="/v/f.mp4">f</a>'));
      return;
    }
    if (u.pathname === "/rich") {
      res.end(html(RICH));
      return;
    }
    // The player page an <iframe> points at: its stream is only reachable by
    // traversing the embed, which is the whole point of picking embeds up.
    if (u.pathname === "/embed/9" || u.pathname === "/movie/777") {
      res.end(html('<video><source src="/v/behind.mp4"></video>'));
      return;
    }
    if (u.pathname === "/list" || u.pathname === "/") {
      const n = u.searchParams.get("page");
      if (!n) {
        res.end(html([
          '<a href="/v/a.mp4">A</a>',
          '<a href="/v/b.mp4">B</a>',
          '<a href="/v/c.mp4">C</a>',
          '<a href="/v/a.mp4">A again</a>',
          '<a href="https://github.com/other/repo">junk</a>',
          '<a href="' + extBase + '/ext">external</a>',
          '<a href="/genre/action/">nav</a>',
          '<a href="/movie/12345">detail</a>',
          '<link rel="next" href="/list?page=2">',
        ].join("\n")));
        return;
      }
      if (n === "2") {
        res.end(html([
          '<a href="/v/d.mp4">D</a>',
          '<a href="/v/a.mp4">A again</a>',
          '<a href="/list?page=3">Next ›</a>',
        ].join("\n")));
        return;
      }
      if (n === "3") {
        res.end(html('<a href="/v/e.mp4">E</a>'));
        return;
      }
    }
    res.statusCode = 404;
    res.end(html("missing"));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { base: "http://127.0.0.1:" + srv.address().port, hits, close: () => new Promise((r) => srv.close(r)) };
}

/** In-process fetchPage over the fixture (same shape the CLI hands the engine:
 * throws with `status`; a resolved body). */
function fixtureFetch(hits) {
  return async function fetchPage(url) {
    const r = await new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on("error", reject);
    });
    if (r.status === 429 || r.status === 503) {
      const e = new Error("HTTP " + r.status);
      e.status = r.status;
      e.retryAfter = Number(r.headers["retry-after"] || 0);
      throw e;
    }
    if (r.status >= 400) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
    if (hits) hits.fetched = (hits.fetched || 0) + 1;
    return { status: r.status, headers: r.headers, body: r.body, finalUrl: url };
  };
}

function sleepRecorder() {
  const calls = [];
  return { calls, sleep: (ms) => { calls.push(ms); return Promise.resolve(); } };
}

const rejects = cli.isRejectedUrl;

// -------------------------------------------------------------------- runner

async function run() {
  const ext = await startExtServer();
  const site = await startSite(ext.base);
  const L = site.base + "/list";
  try {
    console.log("\n=== 1: pure core (link extraction, pagination, media) ===\n");
    {
      assert("normUrl drops the fragment", normUrl("http://h.test/a#x") === "http://h.test/a");
      assert("normUrl resolves relative", normUrl("/a", "http://h.test/dir/") === "http://h.test/a");
      assert("normUrl rejects javascript:/mailto:", normUrl("javascript:void(0)") === null && normUrl("mailto:a@b.c") === null);
      assert("pageNumber reads ?page=", pageNumber("http://h.test/l?page=7") === 7);
      assert("pageNumber reads /page/N/", pageNumber("http://h.test/page/3/") === 3);
      assert("pageNumber is null without one", pageNumber("http://h.test/l") === null);
      assert("samePagePattern true for page N vs N+1", samePagePattern("http://h.test/l?page=2", "http://h.test/l?page=3"));
      assert("samePagePattern false across paths", !samePagePattern("http://h.test/l?page=2", "http://h.test/o?page=3"));
      assert("samePagePattern false when another param differs", !samePagePattern("http://h.test/l?page=2&tag=a", "http://h.test/l?page=3&tag=b"));
      assert("isMediaUrl matches file extensions and playlists",
        isMediaUrl("http://h.test/a.mp4") && isMediaUrl("http://h.test/a.m3u8?t=1") && !isMediaUrl("http://h.test/a.html"));
      const links = extractLinks('<a href="/a/1">one</a><a href="b.html" rel="next">two</a><link rel="next" href="/next">', "http://h.test/dir/");
      assert("extractLinks absolutizes anchors and text", links.length === 3 && links[0].url === "http://h.test/a/1" && links[0].text === "one", JSON.stringify(links));
      assert("extractLinks carries rel=next from <link>", links[2].rel === "next" && links[2].kind === "link");
      const nexts = nextPageCandidates('<a href="/l?page=2">Next</a><a href="/l?page=4">4</a>', "http://h.test/l?page=1", extractLinks('<a href="/l?page=2">Next</a><a href="/l?page=4">4</a>', "http://h.test/l?page=1"));
      assert("nextPageCandidates prefers the neighbour page, not page 4", nexts.length === 1 && nexts[0] === "http://h.test/l?page=2", JSON.stringify(nexts));
      const off = nextPageCandidates('<a rel="next" href="http://other.test/l?page=2">Next</a>', "http://h.test/l");
      assert("nextPageCandidates never leaves the host", off.length === 0, JSON.stringify(off));

      // ---- link pick-up: the sources <a href> scraping never saw ----
      assert("HTML entities are decoded before a URL is resolved",
        decodeEntities("a&amp;b&#38;c&#x26;d&#39;e") === "a&b&c&d'e", decodeEntities("a&amp;b&#38;c&#x26;d&#39;e"));
      const ent = extractLinks('<a href="/l?page=2&amp;tag=a">x</a>', "http://h.test/");
      assert("an &amp; in href does not corrupt the query",
        ent[0].url === "http://h.test/l?page=2&tag=a" && pageNumber(ent[0].url) === 2, ent[0].url);
      assert("a srcset list is split into URLs",
        JSON.stringify(srcsetList("/v/a.mp4 720w, /v/b.mp4 1080w")) === JSON.stringify(["/v/a.mp4", "/v/b.mp4"]));
      assert("a JS-escaped URL is unescaped",
        unescapeJsUrl("https:\\/\\/c.test\\/a.m3u8?x=1") === "https://c.test/a.m3u8?x=1", unescapeJsUrl("https:\\/\\/c.test\\/a.m3u8?x=1"));
      const rich = extractLinks(RICH, "http://h.test/rich");
      const find = (s) => rich.find((l) => l.url.endsWith(s)) || {};
      assert("a <video src> is picked up as a resource", find("/v/video-only.mp4").role === "res");
      assert("a <source src> inside the video is picked up", find("/v/rich.m3u8").role === "res");
      assert("a <source srcset> is expanded to every rendition",
        !!find("/v/rich-720.mp4").url && !!find("/v/rich-1080.mp4").url);
      assert("an <iframe> player is picked up as an embed", find("/embed/9").role === "embed");
      assert("og:video meta content is picked up", find("/og/master.m3u8").role === "res");
      assert("a data-* payload is picked up", find("/hls/index.m3u8").role === "res");
      assert("a non-media resource stays a resource, not a page link",
        find("/assets/poster.jpg").role === "res");
      assert("a JS-escaped player-config URL is picked up, query kept",
        find("/js/master.m3u8?token=1").role === "res", JSON.stringify(rich.map((l) => l.url)));
      assert("a non-media script string is NOT picked up", !rich.some((l) => l.url.includes("/api/status")));
      assert("a data-href card is a navigation link", find("/movie/777").role === "nav");
      assert("one entry per URL and the anchor wins over the resource tag",
        rich.filter((l) => l.url === "http://h.test/v/rich.mp4").length === 1 && find("/v/rich.mp4").kind === "anchor");
      assert("isMediaUrl knows format hints and HLS paths but not API paths",
        isMediaUrl("http://h.test/s?id=1&format=m3u8") && isMediaUrl("http://h.test/hls/master") && !isMediaUrl("http://h.test/api/status"));
      assert("crawler requires a fetchPage",
        (() => { try { createCrawler({}); return false; } catch { return true; } })());
    }

    console.log("\n=== 2: guard composition (engine parity) ===\n");
    {
      assert("junk/portal host rejected", rejects("https://github.com/x"));
      assert("feed/robots endpoint rejected", rejects("http://h.test/feed") && rejects("http://h.test/sitemap.xml"));
      assert("dotless junk host rejected", rejects("http://Mouth/v/1"));
      assert("JAV nav slug rejected", rejects("https://supjav.com/genre/action/"));
      assert("browser-UI scheme rejected", rejects("chrome-extension://abc/x"));
      assert("a supjav movie page is NOT rejected (the engine owns that drop)", !rejects("https://supjav.com/12345.html"));
      assert("an ordinary media/detail URL passes", !rejects("http://site.test/v/1234"));
    }

    console.log("\n=== 3: traversal (the crawl loop) ===\n");
    {
      const rec = sleepRecorder();
      const report = await createCrawler({
        fetchPage: fixtureFetch(), sleep: rec.sleep, delayMs: 50, maxPages: 10,
        isRejected: rejects, follow: "next", collect: "media",
      }).crawl(L);

      const fetched = site.hits.paths.slice();
      assert("start page fetched first", fetched[0] === "/list", fetched.join(" "));
      assert("pagination followed: page 2 then page 3", fetched[1] === "/list?page=2" && fetched[2] === "/list?page=3", fetched.join(" "));
      assert("the chain stopped at the end of pagination", fetched.length === 3, fetched.join(" "));
      assert("page?1 (page 4) never requested", !fetched.includes("/list?page=4"));
      const media = report.discovered.filter((d) => d.kind === "media").map((d) => d.url);
      assert("media from all three pages discovered", media.length === 5, media.join(" "));
      assert("a media URL repeated on two pages is reported once", media.filter((u) => u.endsWith("/v/a.mp4")).length === 1);
      assert("media keep the page they were found on as referer",
        report.discovered.find((d) => d.url.endsWith("/v/d.mp4")).referer === site.base + "/list?page=2");
      assert("nextChain records the walk", report.nextChain.length === 2);
      assert("junk/external/nav links were never fetched",
        !fetched.some((p) => p.includes("github")) && !fetched.includes("/genre/action/"));
      assert("an out-of-scope host was never contacted", ext.hits.length === 0, ext.hits.join(" "));
      assert("the junk link was counted as rejected", report.totals.rejected >= 1);
      assert("detail pages are not followed with follow=next", !fetched.includes("/movie/12345"));
      assert("politeness: one delay per hop (2 hops)", rec.calls.filter((ms) => ms === 50).length === 2, JSON.stringify(rec.calls));
      assert("budget not reported as truncated when the chain ended", report.totals.truncated === false);

      // page budget
      const r2 = await createCrawler({
        fetchPage: fixtureFetch(), sleep: sleepRecorder().sleep, delayMs: 0, maxPages: 2,
        isRejected: rejects, follow: "next",
      }).crawl(L);
      assert("maxPages bounds the fetches", r2.totals.pages === 2, "pages=" + r2.totals.pages);
      assert("a bounded crawl says it was truncated", r2.totals.truncated === true);

      // follow=none
      const r3 = await createCrawler({
        fetchPage: fixtureFetch(), sleep: sleepRecorder().sleep, delayMs: 0, follow: "none", isRejected: rejects,
      }).crawl(L);
      assert("follow=none fetches only the start page", r3.totals.pages === 1 && r3.nextChain.length === 0);

      // follow=links + depth
      const r4 = await createCrawler({
        fetchPage: fixtureFetch(), sleep: sleepRecorder().sleep, delayMs: 0, follow: "links", maxDepth: 1, isRejected: rejects,
      }).crawl(L);
      const f4 = site.hits.paths.slice();
      assert("follow=links walks an in-scope detail page", f4.includes("/movie/12345"), f4.join(" "));
      assert("its media is discovered too", r4.discovered.some((d) => d.url.endsWith("/v/f.mp4")));
      assert("depth 1 still refuses the external host", ext.hits.length === 0);

      // collect=pages (snapshot the hit log: earlier crawls already fetched
      // /movie/12345, so the assertion must look at THIS crawl's requests)
      const hitsBefore = site.hits.paths.length;
      const r5 = await createCrawler({
        fetchPage: fixtureFetch(), sleep: sleepRecorder().sleep, delayMs: 0, collect: "pages", isRejected: rejects,
      }).crawl(L);
      const pages = r5.discovered.filter((d) => d.kind === "page").map((d) => d.url);
      assert("collect=pages reports detail pages as page candidates",
        pages.includes(site.base + "/movie/12345"), pages.join(" "));
      assert("collect=pages does not follow them (follow=next still means next only)",
        !site.hits.paths.slice(hitsBefore).includes("/movie/12345"), site.hits.paths.slice(hitsBefore).join(" "));
      assert("a next-page link is traversed, never reported as a finding",
        !r5.discovered.some((d) => /[?&]page=2/.test(d.url)), JSON.stringify(pages));

      // sameHostOnly off
      const r6 = await createCrawler({
        fetchPage: fixtureFetch(), sleep: sleepRecorder().sleep, delayMs: 0, sameHostOnly: false, follow: "links", maxDepth: 1,
        isRejected: rejects,
      }).crawl(L);
      assert("--any-host equivalent does follow the external page", ext.hits.length > 0, "hits=" + ext.hits.length);
      assert("and discovers its media", r6.discovered.some((d) => d.url.endsWith("/v/ext.mp4")));

      // ---- the rich page: pick-up feeds the same classifier ----
      const rich1 = await createCrawler({
        fetchPage: fixtureFetch(), sleep: sleepRecorder().sleep, delayMs: 0,
        follow: "next", collect: "pages", isRejected: rejects,
      }).crawl(site.base + "/rich");
      const rmedia = rich1.discovered.filter((d) => d.kind === "media").map((d) => d.url);
      assert("every media source on the page becomes one finding", rmedia.length === 8, rmedia.join(" "));
      assert("the stream from the inline player config is found, query intact",
        rmedia.includes("https://cdn.test/js/master.m3u8?token=1"), rmedia.join(" "));
      const rpages = rich1.discovered.filter((d) => d.kind === "page").map((d) => d.url);
      assert("the data-href card and the embed are page candidates",
        rpages.includes(site.base + "/movie/777") && rpages.includes(site.base + "/embed/9"), rpages.join(" "));
      assert("a JS API path is never a candidate",
        !rich1.discovered.some((d) => d.url.includes("/api/status")));
      assert("a non-media resource (a poster) is not reported as a page candidate",
        !rich1.discovered.some((d) => d.url.endsWith("/assets/poster.jpg")));
      assert("findings keep the rich page as referer",
        rich1.discovered.every((d) => d.referer === site.base + "/rich"));

      const before = site.hits.paths.length;
      const rich2 = await createCrawler({
        fetchPage: fixtureFetch(), sleep: sleepRecorder().sleep, delayMs: 0,
        follow: "links", maxDepth: 1, collect: "pages", isRejected: rejects,
      }).crawl(site.base + "/rich");
      const rhits = site.hits.paths.slice(before);
      assert("an in-scope <iframe> player page is traversed", rhits.includes("/embed/9"), rhits.join(" "));
      assert("so the stream only reachable behind the player is found",
        rich2.discovered.some((d) => d.url.endsWith("/v/behind.mp4")));
    }

    console.log("\n=== 4: HTTP failures (Retry-After, exhaustion, errors) ===\n");
    {
      const rec = sleepRecorder();
      const r = await createCrawler({
        fetchPage: fixtureFetch(), sleep: rec.sleep, delayMs: 0, maxRetries: 1, isRejected: rejects,
      }).crawl(site.base + "/flaky");
      assert("429 is retried, not failed", r.totals.fetched === 1 && r.totals.failed === 0, JSON.stringify(r.totals));
      assert("the retry is counted", r.totals.retries === 1);
      assert("Retry-After: 1 was waited out", rec.calls.includes(1000), JSON.stringify(rec.calls));
      assert("the retried page's media is discovered", r.discovered.some((d) => d.url.endsWith("/v/flaky.mp4")));

      const r2 = await createCrawler({
        fetchPage: fixtureFetch(), sleep: sleepRecorder().sleep, delayMs: 0, maxRetries: 1, isRejected: rejects,
      }).crawl(site.base + "/flaky5");
      assert("a permanently throttled page ends as a failure", r2.totals.failed === 1 && r2.errors.length === 1, JSON.stringify(r2.totals));
      assert("the failure keeps the HTTP status", r2.errors[0].status === 429, JSON.stringify(r2.errors[0]));

      const r3 = await createCrawler({
        fetchPage: fixtureFetch(), sleep: sleepRecorder().sleep, delayMs: 0, isRejected: rejects,
      }).crawl(site.base + "/never");
      assert("a 404 is recorded as a failed page, not thrown", r3.totals.failed === 1 && r3.pages[0].status === 404);

      let threw = null;
      try { await createCrawler({ fetchPage: fixtureFetch(), sleep: sleepRecorder().sleep, isRejected: rejects }).crawl("ftp://x/y"); }
      catch (e) { threw = e; }
      assert("a non-http start URL is refused up front", !!threw && /start URL/.test(threw.message));
    }

    console.log("\n=== 5: CLI (child process, the real fetch stack) ===\n");
    {
      assert("requiring the CLI does not run it", typeof cli.main === "function" && typeof cli.connect === "function");

      const json = await runCli([L, "--delay", "0", "--json", "--quiet"]);
      assert("--json exits 0", json.code === 0, json.err.slice(0, 200));
      let rep = null;
      try { rep = JSON.parse(json.out); } catch { /* reported below */ }
      assert("--json prints a parseable report", !!rep && Array.isArray(rep.discovered), json.out.slice(0, 120));
      assert("the report carries the crawl totals", !!rep && rep.totals.media === 5 && rep.totals.pages === 3, rep && JSON.stringify(rep.totals));

      const richJson = await runCli([site.base + "/rich", "--delay", "0", "--json", "--quiet", "--collect", "pages"]);
      let rrep = null;
      try { rrep = JSON.parse(richJson.out); } catch { /* reported below */ }
      assert("the CLI sees the non-anchor sources too",
        !!rrep && rrep.totals.media === 8 && rrep.totals.pageCandidates === 3,
        rrep && JSON.stringify(rrep.totals));

      const text = await runCli([L, "--delay", "0"]);
      const lines = text.out.trim().split("\n").filter(Boolean);
      assert("text mode prints one URL per line on stdout", text.code === 0 && lines.length === 5 && lines.every((u) => /^https?:/.test(u)), text.out.slice(0, 200));
      assert("logs go to stderr, not stdout", /done —/.test(text.err) && !/done/.test(text.out));

      const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crawl-out-")), "urls.txt");
      const withOut = await runCli([L, "--delay", "0", "--quiet", "--out", outFile]);
      assert("--out writes the URL list", withOut.code === 0 && fs.readFileSync(outFile, "utf8").trim().split("\n").length === 5);
      assert("--quiet silences stderr", withOut.err === "", JSON.stringify(withOut.err.slice(0, 120)));

      const ua = await runCli([L, "--delay", "0", "--quiet", "--ua", "web-crawl-test", "--cookie", "sid=1"]);
      assert("--ua reaches the site", ua.code === 0 && site.hits.ua.includes("web-crawl-test"));
      assert("--cookie reaches the site", site.hits.cookie.includes("sid=1"));

      const bounded = await runCli([L, "--delay", "0", "--quiet", "--max-pages", "1"]);
      assert("--max-pages is honored end to end", bounded.code === 0 && bounded.out.trim().split("\n").length === 3, bounded.out);

      const usage = await runCli([]);
      assert("no start URL -> usage error (2)", usage.code === 2);
      const badUrl = await runCli(["not-a-url"]);
      assert("non-http start -> usage error (2)", badUrl.code === 2);
      const badFollow = await runCli([L, "--follow", "sideways"]);
      assert("bad --follow -> usage error (2)", badFollow.code === 2);
      const help = await runCli(["--help"]);
      assert("--help exits 0 and prints usage", help.code === 0 && /web-crawl —/.test(help.out));
    }

    console.log("\n=== 6: enqueue over the WS bridge ===\n");
    {
      const app = await startFakeApp({ refuseFirst: 1, retryAfter: 1 });
      const wsUrl = "ws://127.0.0.1:" + app.port();
      const r = await runCli([L, "--delay", "0", "--enqueue", "--deepgrab-ws", wsUrl, "--cookie", "sid=9"]);
      await app.close();
      const frames = app.frames;
      const downloads = frames.filter((f) => f.type === "download");
      assert("enqueue exits 0", r.code === 0, r.err.slice(0, 300));
      assert("one download frame per discovered URL plus the retry", downloads.length === 6, "frames=" + downloads.length);
      assert("the refusal is retried with a fresh reqId",
        downloads[0].url === downloads[1].url && downloads[0].reqId !== downloads[1].reqId,
        JSON.stringify(downloads.slice(0, 2).map((d) => d.reqId)));
      assert("the refusal is reported on stderr", /refused \(PACE_LIMITED\) — waiting 1s/.test(r.err), r.err.slice(0, 200));
      assert("the app's retryAfter window is really waited out", r.ms >= 900, "elapsed=" + r.ms + "ms");
      assert("frames carry the page a URL was found on as referer",
        downloads[1].referer === site.base + "/list", downloads[1].referer);
      assert("frames carry the cookie header", downloads[0].cookieHeader === "sid=9");
      assert("the summary reports what was accepted", /enqueued 5\/5/.test(r.err), r.err);

      const app2 = await startFakeApp({ refererOverride: true });
      const wsUrl2 = "ws://127.0.0.1:" + app2.port();
      const r2 = await runCli([L, "--delay", "0", "--enqueue", "--deepgrab-ws", wsUrl2, "--referer", "https://ref.test/x", "--quiet"]);
      await app2.close();
      assert("--referer overrides the per-page referer",
        r2.code === 0 && app2.frames.filter((f) => f.type === "download").every((f) => f.referer === "https://ref.test/x"));

      const dead = await runCli([L, "--delay", "0", "--enqueue", "--deepgrab-ws", "ws://127.0.0.1:1"]);
      assert("an unreachable app fails the run (1)", dead.code === 1, "code=" + dead.code);
      assert("and says so", /enqueue failed/.test(dead.err), dead.err.slice(0, 200));
    }
    console.log("\n=== 7: the app-side runner (lib/crawl-runner.js) ===\n");
    {
      const runnerLib = require("./lib/crawl-runner");
      assert("the CLI and the window share ONE guard definition",
        cli.isRejectedUrl === runnerLib.isRejectedUrl && cli.parseRetryAfter === runnerLib.parseRetryAfter);
      assert("one page fetcher definition too", cli.makeFetchPage === runnerLib.makeFetchPage);

      // shouldStop: a cancel is honored between pages, not mid-fetch
      let checks = 0;
      const stoppedReport = await createCrawler({
        fetchPage: fixtureFetch(), sleep: sleepRecorder().sleep, delayMs: 0, isRejected: rejects,
        shouldStop: () => ++checks > 1,
      }).crawl(L);
      assert("shouldStop ends the crawl at a page boundary",
        stoppedReport.totals.stopped === true && stoppedReport.totals.pages === 1,
        JSON.stringify(stoppedReport.totals));

      // runner: snapshots on start and after every page, then a finished state
      const snaps = [];
      let runner = null;
      const r = runnerLib.createCrawlRunner({
        emit: (s) => snaps.push(s),
        fetchPageFor: () => fixtureFetch(),
        enqueue: async (items) => ({ added: items.length, skipped: 0 }),
      });
      runner = r;
      assert("start refuses an empty/invalid request", r.start({ urls: [] }).ok === false && r.start({ urls: ["nope"] }).ok === false);
      assert("an idle runner reports a serializable snapshot",
        JSON.stringify(r.status()).includes("\"running\":false"));
      const started = r.start({ urls: [L], delayMs: 0, maxPages: 10 });
      assert("start accepts an http start URL", started.ok === true && started.urls.length === 1);
      assert("a second start while running is refused", r.start({ urls: [L] }).ok === false);
      await r.settled();
      const fin = r.status();
      assert("the finished snapshot carries the findings",
        fin.running === false && fin.done === true && fin.found.length === 5 && fin.pages === 3,
        JSON.stringify({ running: fin.running, done: fin.done, found: fin.found.length, pages: fin.pages }));
      assert("findings keep the page they were found on", fin.found.every((f) => f.referer && f.url.startsWith("http")));
      assert("progress was emitted per page plus start and end", snaps.length >= 5, "snaps=" + snaps.length);
      assert("the first snapshot is a running state", snaps[0].running === true && snaps[0].done === false);

      // queue(): the runner hands items to the enqueue seam untouched
      const seen = [];
      const r2 = runnerLib.createCrawlRunner({ emit: () => {}, enqueue: async (items) => { seen.push(...items); return { added: items.length, skipped: 0 }; } });
      const q = await r2.queue(r2.status().found.length ? r2.status().found : [{ url: "https://x.test/a.mp4", referer: "https://x.test/l" }]);
      assert("queue hands the items to the enqueue seam", q.ok === true && q.added === 1 && seen[0].url === "https://x.test/a.mp4" && seen[0].referer === "https://x.test/l");
      assert("queue refuses an empty list", (await r2.queue([])).ok === false);

      // stop(): a Stop click ends the run and says so
      const stopSnaps = [];
      const r3 = runnerLib.createCrawlRunner({ emit: (s) => stopSnaps.push(s), fetchPageFor: () => fixtureFetch() });
      r3.start({ urls: [L], delayMs: 0 });
      r3.stop();
      await r3.settled();
      assert("stop() marks the run stopped and finishes it",
        r3.status().stopped === true && r3.status().running === false);
      assert("a stopped crawl fetched fewer pages than the chain", r3.status().pages < 3, "pages=" + r3.status().pages);
    }

  } finally {
    await site.close();
    await ext.close();
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

/** Fake Deep Grab app: greets with a hello, then accepts downloads — refusing
 * the first `refuseFirst` of them with the real PACE_LIMITED envelope. */
function startFakeApp({ refuseFirst = 0, retryAfter = 1 } = {}) {
  const wss = new WebSocket.Server({ host: "127.0.0.1", port: 0 });
  const frames = [];
  let refused = 0;
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "hello", version: "9.9.9-test", protocolVersion: 1, port: wss.address().port }));
    ws.on("message", (raw) => {
      let msg = null;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg || msg.type !== "download") return;
      frames.push(msg);
      if (refused < refuseFirst) {
        refused++;
        ws.send(JSON.stringify({ type: "error", code: "PACE_LIMITED", message: "crawl throttle refused", url: msg.url, reqId: msg.reqId, retryable: true, retryAfter }));
        return;
      }
      ws.send(JSON.stringify({ type: "accepted", id: "dl-" + frames.length, ids: ["dl-" + frames.length], url: msg.url, reqId: msg.reqId }));
    });
  });
  return new Promise((resolve) => wss.on("listening", () => resolve({
    frames,
    port: () => wss.address().port,
    close: () => new Promise((r) => wss.close(r)),
  })));
}

run().catch((e) => { console.error("FATAL", e); process.exit(1); });
