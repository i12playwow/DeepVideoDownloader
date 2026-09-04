// Best-only selection core SHARED by the MV3 content script and headless Node
// tests, so the test can never drift from the real capture logic. Loaded from
// extension/manifest.json BEFORE content.js: as a classic script it attaches to
// the content-script isolated world's global (content.js calls isHls /
// qualityRank / bestOnlyNext / BEST_ONLY_HLS_RANK as free variables). Under
// Node the same code is module.exports'd instead.
"use strict";
(function () {
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
    if (sourceEl && typeof sourceEl.getAttribute === "function") {
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

  // HLS masters (the full movie behind CF-walled players) outrank every MP4
  // (usually only a highlight clip), so their rank is above any resolution.
  const BEST_ONLY_HLS_RANK = 99;

  // Single-best keep/replace decision. Entries look like content.js found-set
  // items: { url, kind: "mp4"|"m3u8", _rank }. Returns the entry the caller
  // should hold — `cur` unchanged (candidate loses) or `cand` (new best).
  function bestOnlyNext(cur, cand) {
    if (cur && cur.url === cand.url) return cur;            // already held
    if (cand.kind === "m3u8") return cand;                  // HLS beats HLS or MP4
    if (cur && cur.kind === "m3u8") return cur;             // held HLS beats MP4
    if (cur && cand._rank <= (cur._rank || 0)) return cur;  // tie/lower: keep best
    return cand;
  }

  const api = { isHls, qualityRank, bestOnlyNext, BEST_ONLY_HLS_RANK };
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    for (const k in api) self[k] = api[k];
  }
})();
