// Downloader feature tests (offline, no network): global schedule window,
// item-level transient retry with backoff, auto-retry failed downloads,
// per-site automation rules, queue-wide controls, and fair queue ordering.
// Wire: node test-download-features.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DownloadManager } = require("./downloader");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  PASS " + name); }
  catch (e) { fail++; console.error("  FAIL " + name + ": " + e.message); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(dm, id, statuses, timeout = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const it = dm.items.get(id);
    if (it && statuses.includes(it.status)) return it;
    await sleep(20);
  }
  return dm.items.get(id);
}
const hhmm = (d) => String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");

function makeDm(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepgrab-features-"));
  const dm = new DownloadManager({
    config: Object.assign({ downloadDir: dir, autoProxy: false, saveHistory: false,
      thumbnails: false, skipDuplicates: false, concurrency: 2, maxRetries: 3 }, extra),
    proxyManager: { pickBest: async () => null, agentFor: () => null },
    onUpdate: () => {}
  });
  dm._retryBackoffMs = 5;
  return { dm, dir };
}
const cleanup = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} };
const netErr = () => { const e = new Error("network down"); e.category = "network"; return e; };

(async () => {
  // ---- window gate ---------------------------------------------------------
  await (async () => {
    const now = new Date();
    const { dm, dir } = makeDm({ scheduleWindowStart: hhmm(new Date(now.getTime() - 7200000)),
      scheduleWindowEnd: hhmm(new Date(now.getTime() - 3600000)), concurrency: 1 });
    let ran = false;
    dm.run = async () => { ran = true; throw netErr(); };
    const id = await dm.enqueue({ url: "https://example.com/g.mp4", title: "g" });
    await sleep(60);
    t("window closed: new download stays queued, never starts", () => {
      assert.strictEqual(dm.items.get(id).status, "queued");
      assert.strictEqual(ran, false);
    });
    cleanup(dir);
  })();

  await (async () => {
    const now = new Date();
    const { dm, dir } = makeDm({ scheduleWindowStart: hhmm(new Date(now.getTime() - 3600000)),
      scheduleWindowEnd: hhmm(new Date(now.getTime() + 3600000)), concurrency: 1 });
    dm.run = async (item) => { item.status = "done"; };
    const id = await dm.enqueue({ url: "https://example.com/g2.mp4", title: "g2" });
    const it = await waitFor(dm, id, ["done"]);
    t("window open: download starts and completes", () => assert.strictEqual(it.status, "done"));
    cleanup(dir);
  })();

  await (async () => {
    const { dm, dir } = makeDm({ scheduleWindowStart: "23:00", scheduleWindowEnd: "07:00" });
    const at = (h, m) => new Date(2026, 0, 1, h, m);
    t("cross-midnight window (23:00-07:00)", () => {
      assert.strictEqual(dm._inScheduleWindow(at(22, 59)), false);
      assert.strictEqual(dm._inScheduleWindow(at(23, 0)), true);
      assert.strictEqual(dm._inScheduleWindow(at(6, 59)), true);
      assert.strictEqual(dm._inScheduleWindow(at(7, 0)), false);
    });
    const d2 = makeDm({ scheduleWindowStart: "09:00", scheduleWindowEnd: "17:00" }).dm;
    t("same-day window (09:00-17:00)", () => {
      assert.strictEqual(d2._inScheduleWindow(at(8, 59)), false);
      assert.strictEqual(d2._inScheduleWindow(at(9, 0)), true);
      assert.strictEqual(d2._inScheduleWindow(at(16, 59)), true);
      assert.strictEqual(d2._inScheduleWindow(at(17, 0)), false);
    });
    t("empty window is always open", () => assert.strictEqual(makeDm({}).dm._inScheduleWindow(at(3, 0)), true));
    cleanup(dir);
  })();

  // ---- per-site rules ------------------------------------------------------
  await (async () => {
    const now = new Date();
    const { dm, dir } = makeDm({ concurrency: 1,
      scheduleWindowStart: hhmm(new Date(now.getTime() - 7200000)),
      scheduleWindowEnd: hhmm(new Date(now.getTime() - 3600000)),
      siteRules: [{ host: "rule.example.com", folder: "D:/Jav", start: true },
        { host: "*.cdn.example.com", folder: "D:/Cdn" }] });
    let runs = 0;
    dm.run = async (item) => { runs++; item.status = "done"; };
    const id1 = await dm.enqueue({ url: "https://rule.example.com/v.mp4", title: "s" });
    await waitFor(dm, id1, ["done"]);
    const it1 = dm.items.get(id1);
    const id2 = await dm.enqueue({ url: "https://a.cdn.example.com/f.mp4", title: "c" });
    const it2 = dm.items.get(id2);
    const id3 = await dm.enqueue({ url: "https://other.com/f.mp4", title: "o", dirOverride: "D:/Mine" });
    const it3 = dm.items.get(id3);
    t("site rule folder + start bypass outside window", () => {
      assert.strictEqual(it1.dirOverride, "D:/Jav");
      assert.strictEqual(it1._windowBypass, true);
      assert.strictEqual(it1.status, "done");
      assert.strictEqual(runs, 1);
    });
    t("wildcard rule folder applies; no start -> window still gates", () => {
      assert.strictEqual(it2.dirOverride, "D:/Cdn");
      assert.strictEqual(it2._windowBypass, false);
      assert.strictEqual(it2.status, "queued");
    });
    t("explicit dirOverride beats the rule", () => assert.strictEqual(it3.dirOverride, "D:/Mine"));
    cleanup(dir);
  })();

  // ---- transient retry with backoff ----------------------------------------
  await (async () => {
    const { dm, dir } = makeDm({ concurrency: 1, maxRetries: 2 });
    let calls = 0;
    dm.run = async (item) => {
      calls++;
      if (calls < 3) throw netErr();
      item.status = "done";
    };
    const id = await dm.enqueue({ url: "https://example.com/r.mp4", title: "r" });
    const it = await waitFor(dm, id, ["done"]);
    t("transient failure retries with backoff, then completes", () => {
      assert.strictEqual(calls, 3);
      assert.strictEqual(it.retryCount, 2);
      assert.strictEqual(it.status, "done");
    });
    cleanup(dir);
  })();

  await (async () => {
    const { dm, dir } = makeDm({ concurrency: 1, maxRetries: 1 });
    dm.run = async () => { throw netErr(); };
    const id = await dm.enqueue({ url: "https://example.com/r2.mp4", title: "r2" });
    const it = await waitFor(dm, id, ["error"]);
    t("retries exhausted -> error state with retryCount kept", () => {
      assert.strictEqual(it.status, "error");
      assert.strictEqual(it.errorCategory, "network");
      assert.strictEqual(it.retryCount, 1);
      assert.strictEqual(it.errorStatus, 0, "network errors carry no HTTP status");
    });
    cleanup(dir);
  })();

  // ---- auto-retry failed (automation) --------------------------------------
  await (async () => {
    const { dm, dir } = makeDm({ concurrency: 1, maxRetries: 0, autoRetryMinutes: 1 });
    let calls = 0;
    dm.run = async (item) => { calls++; if (calls < 2) throw netErr(); item.status = "done"; };
    const id = await dm.enqueue({ url: "https://example.com/a.mp4", title: "a" });
    const sched = await waitFor(dm, id, ["scheduled"], 3000);
    t("failed download requeues as scheduled after autoRetryMinutes", () => {
      assert.strictEqual(sched.status, "scheduled");
      assert.ok(sched.scheduledStart > Date.now() - 60000);
    });
    // deterministic trigger: move the retry time into the past, then sweep
    dm.items.get(id).scheduledStart = Date.now() - 1;
    dm.checkScheduled();
    const done = await waitFor(dm, id, ["done"], 3000);
    t("auto-retried download completes on the second attempt", () => {
      assert.strictEqual(done.status, "done");
      assert.strictEqual(done.retryCount, 1);
      assert.strictEqual(calls, 2);
    });
    cleanup(dir);
  })();

  await (async () => {
    const { dm, dir } = makeDm({ concurrency: 1, maxRetries: 0, autoRetryMinutes: 5 });
    dm.run = async () => { const e = new Error("cloudflare wall"); e.category = "requires-browser"; throw e; };
    const id = await dm.enqueue({ url: "https://example.com/cf.mp4", title: "cf" });
    const it = await waitFor(dm, id, ["error"]);
    t("requires-browser errors are never auto-retried", () => {
      assert.strictEqual(it.status, "error");
      assert.strictEqual(it.errorCategory, "requires-browser");
    });
    cleanup(dir);
  })();

  await (async () => {
    // autoRetryMax caps consecutive automatic cycles: after N failed requeues
    // the item lands in terminal error instead of churning the queue forever.
    const { dm, dir } = makeDm({ concurrency: 1, maxRetries: 0, autoRetryMinutes: 1, autoRetryMax: 2 });
    let calls = 0;
    // A 5xx is transient under the shared rule, so with maxRetries 0 it falls
    // into the automation cycle; the exhausted path must keep the HTTP status.
    dm.run = async () => { calls++; const e = new Error("500 boom"); e.status = 500; e.category = "http"; throw e; };
    const id = await dm.enqueue({ url: "https://example.com/dead.mp4", title: "dead" });
    const s1 = await waitFor(dm, id, ["scheduled"], 3000);
    t("auto-retry arms the first cycle", () => {
      assert.strictEqual(s1.status, "scheduled");
      assert.strictEqual(s1._autoRetries, 1);
    });
    dm.items.get(id).scheduledStart = Date.now() - 1;
    dm.checkScheduled();
    const s2 = await waitFor(dm, id, ["scheduled"], 3000);
    t("auto-retry arms the second cycle", () => {
      assert.strictEqual(s2.status, "scheduled");
      assert.strictEqual(s2._autoRetries, 2);
    });
    dm.items.get(id).scheduledStart = Date.now() - 1;
    dm.checkScheduled();
    const err = await waitFor(dm, id, ["error"], 3000);
    t("cap exhausted: item lands in terminal error with a clear message", () => {
      assert.strictEqual(err.status, "error");
      assert.strictEqual(err._autoRetries, 2);
      assert.ok(err.error.includes("Auto-retry exhausted after 2 cycles"));
      assert.strictEqual(err.errorCategory, "http");
      assert.strictEqual(err.errorStatus, 500, "exhausted path keeps the HTTP status");
    });
    cleanup(dir);
  })();

  await (async () => {
    // Manual retry restarts the budget: after exhaustion, retry() resets the
    // counter so the item gets a fresh set of automatic cycles.
    const { dm, dir } = makeDm({ concurrency: 1, maxRetries: 0, autoRetryMinutes: 1, autoRetryMax: 1 });
    let calls = 0;
    dm.run = async () => { calls++; throw netErr(); };
    const id = await dm.enqueue({ url: "https://example.com/dead2.mp4", title: "dead2" });
    const s1 = await waitFor(dm, id, ["scheduled"], 3000);
    dm.items.get(id).scheduledStart = Date.now() - 1;
    dm.checkScheduled();
    const err1 = await waitFor(dm, id, ["error"], 3000);
    t("exhausted item reports the cap", () => {
      assert.strictEqual(err1.status, "error");
      assert.ok(err1.error.includes("Auto-retry exhausted"));
    });
    t("clear-on-retry: retry() drops stale error fields before requeue", () => {
      assert.strictEqual(dm.retry(id), true);
      const p = dm.items.get(id).public();
      assert.strictEqual(p.error, "");
      assert.strictEqual(p.errorCategory, "");
      assert.strictEqual(p.errorStatus, 0);
    });
    const s2 = await waitFor(dm, id, ["scheduled"], 3000);
    t("manual retry resets the auto-retry budget", () => {
      assert.strictEqual(s2.status, "scheduled");
      assert.strictEqual(s2._autoRetries, 1);
    });
    cleanup(dir);
  })();

  // ---- queue-wide controls + retry -----------------------------------------
  await (async () => {
    const { dm, dir } = makeDm({});
    dm.pump = () => {};
    dm.checkScheduled = () => {};
    const mk = (id, status, category) => {
      const it = { id, status, url: "https://example.com/" + id + ".mp4", errorCategory: category || "",
        _activeRes: new Set(), public: function () { return this; } };
      dm.items.set(id, it);
      if (status === "queued") dm._queuedIds.add(id);
      return it;
    };
    mk("a", "running"); mk("b", "queued"); mk("c", "paused"); mk("e", "scheduled");
    mk("f", "error", "requires-browser"); mk("g", "error", "network");
    t("pauseAll freezes running/queued/scheduled", () => {
      const n = dm.pauseAll();
      assert.strictEqual(n, 3);
      assert.strictEqual(dm.items.get("a").status, "paused");
      assert.strictEqual(dm.items.get("e").status, "paused");
      assert.strictEqual(dm.items.get("c").status, "paused");
    });
    t("resumeAll brings every paused item back to queued", () => {
      const n = dm.resumeAll();
      assert.strictEqual(n, 4);
      assert.strictEqual(dm.items.get("a").status, "queued");
      assert.strictEqual(dm.items.get("c").status, "queued");
    });
    t("retryFailed skips requires-browser, retries the rest", () => {
      const n = dm.retryFailed();
      assert.strictEqual(n, 1);
      assert.strictEqual(dm.items.get("f").status, "error");
      assert.strictEqual(dm.items.get("g").status, "queued");
    });
    t("explicit retry flips an error back to queued (fresh backoff)", () => {
      assert.strictEqual(dm.retry("f"), true);
      assert.strictEqual(dm.items.get("f").status, "queued");
      assert.strictEqual(dm.items.get("f").retryCount, 0);
      assert.strictEqual(dm.retry("a"), false); // only error items
    });
    cleanup(dir);
  })();

  // ---- fair ordering -------------------------------------------------------
  await (async () => {
    const { dm, dir } = makeDm({ concurrency: 4 });
    const order = [];
    dm.run = async (item) => { order.push(item.id); await sleep(40); item.status = "done"; };
    const ids = [];
    for (const [host, n] of [["a.example.com", 3], ["b.example.com", 1]]) {
      for (let k = 0; k < n; k++) {
        ids.push(await dm.enqueue({ url: "https://" + host + "/" + k + ".mp4", title: host + k }));
      }
    }
    await sleep(80);
    const started = order.slice(0, 3);
    t("per-host cap (2) prevents one host from filling the queue", () => {
      const hosts = started.map((id) => dm.items.get(id).url.split("/")[2]);
      assert.deepStrictEqual(hosts, ["a.example.com", "a.example.com", "b.example.com"]);
    });
    await waitFor(dm, ids[3], ["done"]);
    t("all downloads eventually complete", () => assert.strictEqual(dm.items.get(ids[3]).status, "done"));
    cleanup(dir);
  })();

  await (async () => {
    const { dm, dir } = makeDm({ concurrency: 3 });
    const realPump = dm.pump.bind(dm);
    dm.pump = () => {};
    const order = [];
    dm.run = async (item) => { order.push(item.id); await sleep(30); item.status = "done"; };
    const p = await dm.enqueue({ url: "https://x.example.com/p.mp4", title: "p" });
    const q = await dm.enqueue({ url: "https://x.example.com/q.mp4", title: "q" });
    const r = await dm.enqueue({ url: "https://x.example.com/r.mp4", title: "r" });
    dm.items.get(p).received = 100; // partial bytes -> resume priority
    dm.pump = realPump;
    await dm.pump();
    await sleep(120);
    t("resume priority: partial download starts before fresh ones", () => {
      assert.strictEqual(order[0], p);
      assert.deepStrictEqual(order.slice(1, 3).sort(), [q, r].sort());
    });
    cleanup(dir);
  })();

  // ---- priority queue-jump -------------------------------------------------
  await (async () => {
    const { dm, dir } = makeDm({ concurrency: 1 });
    const order = [];
    // "first" holds the only slot past the prioritize() calls so the
    // priority pick is exercised when the slot actually frees.
    dm.run = async (item) => { order.push(item.id); await sleep(item.title === "first" ? 150 : 40); item.status = "done"; };
    const first = await dm.enqueue({ url: "https://p.example.com/1.mp4", title: "first" });
    const a = await dm.enqueue({ url: "https://q.example.com/a.mp4", title: "a" });
    const b = await dm.enqueue({ url: "https://r.example.com/b.mp4", title: "b" });
    await sleep(60); // first fills the only slot
    t("prioritize rejects non-queued items", () => {
      assert.strictEqual(dm.prioritize(first), false);
      assert.strictEqual(dm.prioritize("no-such-id"), false);
    });
    t("prioritize jumps the queue", () => {
      assert.strictEqual(dm.prioritize(b), true);
      assert.strictEqual(dm.items.get(b).priority, true);
    });
    await waitFor(dm, b, ["done"]);
    await waitFor(dm, a, ["done"]);
    t("priority item starts before older queued ones", () => {
      assert.ok(order.indexOf(b) < order.indexOf(a), "b should start before a");
    });
    cleanup(dir);
  })();

  // ---- expired relabel is signed-only (plain 404 keeps its category) ----
  await (async () => {
    const { dm, dir } = makeDm({ maxRefresh: 2 });
    // A plain dead URL whose resolved URL differs from the input (e.g. URL
    // normalization or proxy pass-through) still enters the refresh path.
    // Re-resolution keeps 404ing, but the item must land in terminal error
    // with the ORIGINAL http category — only signed refreshable links
    // (streamtape get_video / signed m3u8) relabel to "expired".
    dm._runOnce = async (item) => {
      item._resolvedUrl = "http://127.0.0.1:9999/v/fail2.mp4";
      const e = new Error("404 Not Found");
      e.status = 404;
      e.category = "http";
      throw e;
    };
    dm._resolveFresh = async () => { throw new Error("player page gone"); };
    const id = await dm.enqueue({ url: "http://127.0.0.1:9999/v/fail.mp4", title: "plain-404" });
    await waitFor(dm, id, ["error", "done"], 4000);
    const it = dm.items.get(id);
    t("plain 404 through refresh path keeps http category", () => {
      assert.strictEqual(it.status, "error");
      assert.strictEqual(it.errorCategory, "http");
      assert.strictEqual(it.errorStatus, 404, "pump catch records the HTTP status");
      assert.strictEqual(it.public().errorStatus, 404, "public() surfaces it");
      assert.ok(!/expired/i.test(it.error), "no expired relabel for plain 404: " + it.error);
    });
    cleanup(dir);
  })();

  // ---- errorStatus threading through the engine (the rule the V3 pins share) ----
  await (async () => {
    const { dm, dir } = makeDm({ maxRetries: 1 });
    let attempts = 0;
    dm._runOnce = async (item) => {
      attempts++;
      item._resolvedUrl = "http://127.0.0.1:9999/v/f5xx.mp4";
      const e = new Error("502 Bad Gateway");
      e.status = 502;
      e.category = "http";
      throw e;
    };
    dm._resolveFresh = async () => { throw new Error("player page gone"); };
    const id = await dm.enqueue({ url: "http://127.0.0.1:9999/v/f5.mp4", title: "5xx" });
    const err = await waitFor(dm, id, ["error"], 4000);
    t("5xx is transient at engine level: requeued once, terminal keeps errorStatus", () => {
      assert.strictEqual(attempts, 2, "the shared transient rule must auto-requeue a 5xx");
      assert.strictEqual(err.errorStatus, 502);
      assert.strictEqual(err.errorCategory, "http");
    });
    t("clear-on-retry: retry() drops stale error fields", () => {
      assert.strictEqual(dm.retry(id), true);
      const p = dm.items.get(id).public();
      assert.strictEqual(p.error, "");
      assert.strictEqual(p.errorCategory, "");
      assert.strictEqual(p.errorStatus, 0);
    });
    await waitFor(dm, id, ["error"], 4000); // the failing stub re-runs after retry
    t("clear-on-resume: resume() drops stale error fields", () => {
      dm.resume(id);
      const p = dm.items.get(id).public();
      assert.strictEqual(p.error, "");
      assert.strictEqual(p.errorCategory, "");
      assert.strictEqual(p.errorStatus, 0);
    });
    cleanup(dir);
  })();

    // ---- link-expired handler -------------------------------------------------
  await (async () => {
    const { dm, dir } = makeDm({ maxRefresh: 1, concurrency: 1 });
    const resolvingSeen = [];
    let attempts = 0;
    // Stub at the _runOnce layer so the real _runGuarded refresh logic runs:
    // a streamtape get_video link fails not-video (signed-refreshable), and
    // re-resolution keeps failing, so the item must land in terminal error
    // with the "expired" category after the resolving status was surfaced.
    dm._runOnce = async (item) => {
      attempts++;
      item._resolvedUrl = "https://streamtape.com/get_video?id=xyz&e=" + attempts;
      const e = new Error("HTML page instead of video");
      e.category = "not-video";
      throw e;
    };
    dm._resolveFresh = async () => { throw new Error("player page gone"); };
    const dmEmit = dm.emit.bind(dm);
    dm.emit = (item) => {
      const p = item.public ? item.public() : item;
      if (p.resolving) resolvingSeen.push(p.resolveAttempt);
      dmEmit(item);
    };
    const id = await dm.enqueue({ url: "https://streamtape.com/get_video?id=xyz", referer: "https://streamtape.com/v/abc/", title: "expired-test" });
    await waitFor(dm, id, ["error"], 4000);
    const it = dm.items.get(id);
    t("expired URL lands in terminal error with expired category", () => {
      assert.strictEqual(it.status, "error");
      assert.strictEqual(it.errorCategory, "expired");
      assert.ok(/expired/i.test(it.error), "error text mentions expiry: " + it.error);
    });
    t("resolving status was surfaced during refresh", () => {
      assert.ok(resolvingSeen.length > 0, "no resolving emits seen");
      assert.strictEqual(it.public().resolving, false, "resolving cleared when terminal");
    });
    cleanup(dir);
  })();

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
