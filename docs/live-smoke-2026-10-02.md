# Live smoke test — jav-dl chain (Node resolve → TLS relay → engines)

**Date:** 2026-10-02 · **Branch:** `cf-fallback-per-site` at `5fa8b65` plus the uncommitted `isAdSegmentUrl` surrit fix (see Finding 1) · **Sites:** missav.ws + surrit.com · **Code:** `stars-847` (real film, previously downloaded via the python engine — a known-good control).

Every run was bounded (`timeout --signal=KILL 60–90s`) so nothing could burn bandwidth unattended; all artifacts (`/tmp/livesmoke/*`, the relay process, the python workdir) were cleaned afterwards. Automated gates re-run after the fix: `check.js` 46/46, full `npm test` exit 0 (test-hls 69 → 71, harness 570/570), Phase L 6/6.

## Results at a glance

| # | Test | Result |
|---|------|--------|
| T1 | `--list-only` with `JAVDL_RELAY=0` (Node direct control) | ✗ challenged — the gate was hot for Node (expected control) |
| T2 | `--list-only`, default env (relay auto-engage) | ✓ listed all 3 variants (360/480/720), exit 0, relay released on exit |
| T4 | real download, default env | ✓ gate probe fired → relay routing line → engine started |
| T5 | python engine (`K:\jav-dl.py stars-847 -o … --force`) | ✓ 10.8 MB of real `.ts` segments in 90 s before the bounded kill |
| T6/T7 | Node DownloadManager through the relay (in-process) | ✗ → ✓ after Finding 1's fix: 55.6 MB of segments in 90 s, zero errors |

Live proves: MissAV resolution works (through the cf-browser bridge), the relay auto-engages on a real challenge and passes the gate Node fails, the CLI's own `stopRelay()` releases the port, and BOTH engines move real bytes through it. Full-download-to-`done` was not run (deliberately bounded); the download-to-`done` path is the drill's (Phase L) and the python engine's (1.42 GiB stars-847) prior live proof.

## Finding 1 (critical, engine bug): surrit's real segments are `.jpeg`-named TS — the ad filter rejected the entire stream

The engine misclassified **every genuine surrit segment as an ad image**:

- surrit's variant playlists (`…/<uuid>/1280x720/video.m3u8`) name segments `video0.jpeg` … `video1542.jpeg` — **they are MPEG-TS** (documented in `K:\jav-dl.py` line 23: "MissAV names them \*.jpeg — they are MPEG-TS").
- `lib/hls.js isAdSegmentUrl` (built for tiktokcdn ad-images behind sextb) matches any `.jpeg/.jpg/.png` URL → **1543/1543 segments classified as ads** → `HLS: playlist segments are all ad-images (ad-polluted stream)`.
- Consequence: the Node engine has **never been able to download a surrit stream**; any CLI run would auto-retry 15 cycles and then hand off to the python engine (which has no such filter). Invisible until now because nothing ever fed a surrit URL to `runHls` before the jav-dl CLI.
- Diagnostic trap (now documented): at a hot-gate moment the engine fetches a 4546-byte CF challenge HTML, `parseHlsPlaylist` parses 74 junk "segments" out of it, and the error comes out as the same misleading "ad-polluted" message.
- **Fix** (lib/hls.js, uncommitted): `isAdSegmentUrl` exempts surrit hosts entirely — judged on the TRUE authority, including the relay's path-embedded form (`/https/surrit.com/…` behind `127.0.0.1`, which a plain hostname check would miss). Non-surrit `.jpeg` URLs stay ads. Pinned by two new test-hls asserts (surrit jpegs — direct and relayed — are not ads; non-surrit jpegs and a `surrit.com.evil.example` lookalike still are). After the fix the engine streamed 55.6 MB of segments live through the relay.
- Why not exempt image extensions generally: the ad filter still must catch genuine tiktokcdn ad-image pollution on sextb-family streams (harness section S stays green).

## Finding 2: surrit's rolling window flips against python-shaped requests too

Minutes after T2 passed through the relay, the same relayed fetch 403'd for ~10 straight minutes (both direct and through the relay), then flapped cold again. Both gates are real: the TLS-fingerprint gate (relay beats it) and the per-IP reputation window (only time or the auto-retry mechanism rides it out) — exactly as documented in AGENTS.md.

## Finding 3 (ops note)

`python scripts/surrit-relay.py` logs only its startup banner — requests are not logged, so "did bytes flow?" cannot be answered from its log. Fine for ops (no sensitive URLs on disk), but worth knowing when debugging: prove flow via the client's progress counters instead.

## Session ops notes

One T5 attempt failed with `Cannot find module …\MonKey Script\scripts\jav-dl.js` — a shell backgrounding quirk broke `cd` grouping, not the code; rerun with an explicit cwd passed cleanly. The relay adopted by the CLI must be killed by PID when started manually (`taskkill //PID <pid> //F`); the CLI's own `stopRelay()` only kills relays it spawned — the documented adopt contract, observed working.
