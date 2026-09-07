/**
 * Automated test for Best-only + auto-download feature.
 *
 * Tests three layers independently:
 *   1. Helper functions (isHls, qualityRank, best-only selection) — the
 *      selection logic is required from extension/best-only.js, the same file
 *      content.js loads, so the test mirrors the real capture logic
 *   2. WebSocket protocol contract (extension → desktop app)
 *   3. End-to-end: capture logic → WS download (simulated)
 *
 * Run: node test-best-only.js
 * Requires: desktop app running (npm.cmd start) and ws module.
 */

"use strict";

const { WebSocket } = require("ws");

let passed = 0;
let failed = 0;

function assert(label, ok, detail) {
  if (ok) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}  ${detail || ""}`); }
}

// =========================================================================
// Layer 1: Helper function tests (portable, no external dependencies)
// =========================================================================

console.log("\n=== Layer 1: Helpers ===\n");

// Layer 1 helpers + selection run against extension/best-only.js — the SAME
// single source of truth content.js consumes (manifest loads best-only.js
// before content.js), so this test cannot drift from the real capture logic.

const { isHls, qualityRank, bestOnlyNext, BEST_ONLY_HLS_RANK } = require("./extension/best-only");

// --- isHls ---
assert("isHls rejects .mp4",          !isHls("https://x.com/video_1080p.mp4"));
assert("isHls rejects plain video",   !isHls("https://x.com/video.mp4?quality=720"));
assert("isHls detects .m3u8",          isHls("https://x.com/master.m3u8"));
assert("isHls detects /hls/ path",     isHls("https://x.com/hls/index.m3u8"));
assert("isHls detects manifest",       isHls("https://x.com/manifest.m3u8"));
assert("isHls handles null",          !isHls(null));
assert("isHls handles empty",         !isHls(""));

// --- qualityRank (URL only, no sourceEl) ---
assert("rank 0 for no marker",        qualityRank("https://x.com/v.mp4") === 0);
assert("rank 1 for 480p",             qualityRank("https://x.com/video_480p.mp4") === 1);
assert("rank 2 for 720p",             qualityRank("https://x.com/video_720p.mp4") === 2);
assert("rank 3 for 1080p",            qualityRank("https://x.com/video_1080p.mp4") === 3);
assert("rank 3 from 1920x1080",       qualityRank("https://x.com/1920x1080/file.mp4") === 3);
assert("rank 4 for 2k",               qualityRank("https://x.com/2k/file.mp4") === 4);
assert("rank 4 for 1440p",            qualityRank("https://x.com/video_1440p.mp4") === 4);
assert("rank 5 for 4k",               qualityRank("https://x.com/4k/file.mp4") === 5);
assert("rank 5 for 2160p",            qualityRank("https://x.com/video_2160p.mp4") === 5);
assert("rank 0 no p-suffix in query param (no .p pattern)", qualityRank("https://x.com/v.mp4?quality=720") === 0);

// --- Best-only selection (fold over the shared bestOnlyNext reducer) ---
// Mirrors content.js tryCapture's best-only branch: exactly ONE entry is held.
// An HLS master (the full movie) always outranks an MP4 highlight and is never
// dropped; a later HLS replaces an earlier HLS; MP4s compare by resolution and
// ties keep the current entry.
function simulateBestOnly(urls) {
  const found = [];
  for (const u of urls) {
    const isHlsUrl = isHls(u);
    const cand = { url: u, kind: isHlsUrl ? "m3u8" : "mp4", _rank: isHlsUrl ? BEST_ONLY_HLS_RANK : qualityRank(u) };
    const cur = found.length ? found[0] : null;
    if (cur && bestOnlyNext(cur, cand) === cur) continue;
    found.length = 0;
    found.push(cand);
  }
  return found;
}

function testSelection(label, input, expectedUrl) {
  const result = simulateBestOnly(input);
  let ok;
  if (expectedUrl === undefined) {
    ok = result.length === 0;
  } else {
    ok = result.length === 1 && result[0].url === expectedUrl;
  }
  const detail = ok ? "" : `got ${result.length} entries, expected ${expectedUrl === undefined ? "none" : expectedUrl}`;
  assert(label, ok, detail);
}

testSelection("picks highest rank (MP4s only)", [
  "https://x.com/video_480p.mp4",
  "https://x.com/video_720p.mp4",
  "https://x.com/video_1080p.mp4"
], "https://x.com/video_1080p.mp4");

testSelection("HLS master (full movie) outranks MP4 highlights", [
  "https://x.com/video_720p.mp4",
  "https://x.com/master.m3u8",
  "https://x.com/video_1080p.mp4"
], "https://x.com/master.m3u8");

testSelection("held HLS master is never replaced by a later MP4", [
  "https://x.com/master.m3u8",
  "https://x.com/video_1080p.mp4",
  "https://x.com/video_2160p.mp4"
], "https://x.com/master.m3u8");

testSelection("single entry passes through", [
  "https://x.com/video_720p.mp4"
], "https://x.com/video_720p.mp4");

testSelection("only HLS: latest master wins (single best kept)", [
  "https://x.com/master.m3u8",
  "https://x.com/manifest.m3u8"
], "https://x.com/manifest.m3u8");

testSelection("MP4 tie keeps the first (current) entry", [
  "https://x.com/video_1080p_a.mp4",
  "https://x.com/video_1080p_b.mp4"
], "https://x.com/video_1080p_a.mp4");

// Layer 2: WebSocket protocol contract
// =========================================================================

console.log("\n=== Layer 2: WebSocket protocol ===\n");

function wsTest(label, fn, done) {
  const ws = new WebSocket("ws://127.0.0.1:8765");
  const messages = [];
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    assert(label, false, "timeout waiting for server");
    ws.close();
    if (done) done();
  }, 15000);

  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    messages.push(m);
  });

  ws.on("error", (err) => {
    if (!timedOut) {
      clearTimeout(timeout);
      assert(label, false, "WS error: " + err.message);
      ws.close();
      if (done) done();
    }
  });

  ws.on("open", () => fn(ws, messages, () => {
    clearTimeout(timeout);
    ws.close();
    if (done) done();
  }));
}

// Test 1: hello + ping/pong
wsTest("hello on connect + ping/pong", (ws, msgs, done) => {
  setTimeout(() => {
    const hello = msgs.find((m) => m.type === "hello");
    if (hello) {
      assert("hello received", hello.type === "hello" && hello.version, "version: " + hello.version);
    } else {
      assert("hello received", false, "no hello message");
    }
    ws.send(JSON.stringify({ type: "ping" }));
    setTimeout(() => {
      const pong = msgs.find((m) => m.type === "pong");
      assert("pong received", !!pong);
      done();
    }, 1000);
  }, 500);
});

// Test 2: probe
wsTest("probe URL returns probe-result", (ws, msgs, done) => {
  setTimeout(() => {
    ws.send(JSON.stringify({ type: "probe", url: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4" }));
    setTimeout(() => {
      const pr = msgs.find((m) => m.type === "probe-result");
      assert("probe-result received", !!pr);
      if (pr) assert("probe-result has ok field", "ok" in pr, "ok=" + pr.ok);
      done();
    }, 4000);
  }, 500);
});

// Test 3: download
wsTest("download URL returns accepted + status", (ws, msgs, done) => {
  setTimeout(() => {
    ws.send(JSON.stringify({ type: "download", url: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4", title: "test", referer: "" }));
    setTimeout(() => {
      const accepted = msgs.find((m) => m.type === "accepted");
      assert("accepted received", !!accepted);
      if (accepted) assert("accepted has id", !!accepted.id, "id: " + accepted.id);

      const statuses = msgs.filter((m) => m.type === "status");
      assert("status updates received", statuses.length > 0, "count: " + statuses.length);
      if (statuses.length) {
        const doneStatus = statuses.find((s) => s.status === "done" || s.status === "error");
        assert("final status reached (done/error)", !!doneStatus, "final: " + (doneStatus ? doneStatus.status : "none"));
      }
      done();
    }, 12000);
  }, 500);
});

// =========================================================================
// Layer 3: End-to-end best-only simulation
// =========================================================================

console.log("\n=== Layer 3: End-to-end capture → WS ===\n");

// Simulates what the extension does:
// 1. Capture video URLs from "page" (our test set)
// 2. Apply best-only filter (skip HLS, keep highest rank)
// 3. Send video-found + auto-download via add-to-list → WS

function simulateExtensionFlow(videoUrls, sendToWs) {
  const best = simulateBestOnly(videoUrls);
  if (!best.length) {
    console.log("  INFO  No best video found (all HLS) — auto-download skipped");
    return { best: null, skipped: true };
  }
  const url = best[0].url;
  console.log(`  INFO  Best: ${url} (rank ${best[0]._rank})`);

  // Simulate video-found (adds to background's found list)
  // Simulate add-to-list (background sends download WS message)
  if (sendToWs) {
    console.log("  INFO  Sending download to WS...");
    sendToWs(url);
  }
  return { best: best[0], skipped: false };
}

// Use WS to send a download message end-to-end
wsTest("end-to-end: capture → best-only → WS download", (ws, msgs, done) => {
  setTimeout(() => {
    const videoUrls = [
      "https://x.com/video_480p.mp4",
      "https://x.com/video_720p.mp4",
      "https://x.com/master.m3u8",
      "https://x.com/video_1080p.mp4"
    ];

    const result = simulateExtensionFlow(videoUrls, (url) => {
      ws.send(JSON.stringify({ type: "download", url, title: "test-best-auto", referer: "http://localhost:8000/test-page.html" }));
    });

    if (result.skipped) { done(); return; }

    setTimeout(() => {
      const accepted = msgs.find((m) => m.type === "accepted");
      assert("accepted received for auto-download", !!accepted);
      if (accepted) assert("accepted URL matches best", accepted.url === result.best.url, "got: " + accepted.url);

      const statuses = msgs.filter((m) => m.type === "status" && m.status !== "queued");
      assert("status updates received for auto-download", statuses.length > 0, "count: " + statuses.length);
      done();
    }, 10000);
  }, 500);
});

// =========================================================================
// Summary
// =========================================================================

setTimeout(() => {
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed ? 1 : 0);
}, 35000);
