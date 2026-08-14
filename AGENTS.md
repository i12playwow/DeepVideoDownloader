# AGENTS.md

Electron desktop downloader ("Deep Video Downloader") + companion Chrome MV3 extension ("Deep Grab") + supjav userscripts. CommonJS, no bundler, no build step for dev.

## Commands
- Run: `npm.cmd start` (never `npm` — PowerShell can't run `npm.ps1`). `run.bat` adds `--no-sandbox --disable-gpu` but hardcodes the repo path; `npm.cmd start` doesn't.
- Package: `npm.cmd run dist` → `dist/DeepVideoDownloader Setup 1.0.0.exe` + `dist/win-unpacked/`.
- No lint/test/typecheck. Syntax check: `node -c <file>.js` (extension JS included).

## Architecture
- `main.js` — Electron main: window, WS server (127.0.0.1:8765), IPC handlers, clipboard monitor, probe handler.
- `downloader.js` — download engine (segmented, queue, pause/resume/cancel, retry, **global** speed limit, scheduling, history) + site resolvers + HLS engine. History → `<downloadDir>\history.json` (moves with the dir), not the repo.
- `proxy.js` — `ProxyManager`; exports `parseProxyUrl`, `agentFor`, `transport`.
- `preload.js` — `contextBridge` → `window.api`; the only renderer→main path (`contextIsolation:true`, `nodeIntegration:false`).
- `renderer.html/js/styles.css` — UI.
- **IPC whitelist**: every channel exists in 3 places that must stay in sync — `preload.js` (`window.api`), `ipcMain.handle` in `main.js`, call sites in `renderer.js` (e.g. `download-resume-last`). Adding/renaming one means touching all three.
- `config.json` at `__dirname` (falls back to `DEFAULT_CONFIG` in main.js). **Excluded from the packaged asar** — never ship a real one. `config - Copy.json` is a stale backup.
- `extension/` — self-contained MV3, not in `package.json`. Edit → **must reload at `chrome://extensions`**. `webRequest` + `*://*/*` perms, `all_frames:true`.
- `extension-firefox/` — same JS as `extension/` (copied verbatim), Firefox manifest (event page + gecko id). **Ported 8/2026**: `webRequest` capture, cnporn extraction, pipeline, dedupe all in sync. Edit → **must reload at `about:debugging#/runtime/this-firefox`**. Load via "Load Temporary Add-on".
- Root `.user.js`/`test-*.js`/`test-page.html`/`test-video.mp4` are leftovers — see Userscripts + Verification.

## Download flow
Each `resolve*()` returns `{resolvedUrl, proxy, agent, origin?}` and re-resolves when the result is another supported site:
- `streamtape.com`/`fstape.com` → `resolveStreamtape` (`STRGV`) → signed `get_video?...&stream=1`. `get_video` returning `{"status":500}` means the video is dead source-side — not a resolver bug.
- `cnporn.org` → `resolveCnPorn` (`CNIFRAME`/`CNIFRAME2`/`CNVIDEO` + `CNEMBED` for the lazy `/embed/<uuid>` iframe) → embed `sources` parsed by `CNSOURCES` (`"file":"...mp4|m3u8"`, JSON `\/` unescaped) → m3u8 (`origin:"cnporn-hls"`) or mp4 → streamtape/pornhub.
- `xvideos.com` → `resolveXVideos` (`XVEMBED`/`XVDIRECT`) → streamtape. `xhamster.com` → `resolveXHamster` (`XHEMBED`/`XHPLAY`/`XHMP4`) → xvideos → streamtape.
- `supjav.php?l=<OLID>` player URLs (supjav.com page 403s Cloudflare to Node, so resolution enters at the player) → `resolveSupjav` (`SJ_OLID`): reverse id → `?c=<reversed>` → 302s straight to the streamtape/fstape embed → `resolveStreamtape`.
- Generic URLs pass through untouched. Resolved URL stored on `item._resolvedUrl` (used via `item._resolvedUrl || item.url`). Resolution is **lazy**: `enqueue()` returns an id immediately (WS `accepted` never blocks on a resolver fetch); pause/cancel during resolution aborts via the same post-async status check as the probe.
- Expired direct URLs (403/404/410 or `expired|token|forbidden`) auto-re-resolve up to `config.maxRefresh` (default 2), bumping `refreshCount`. A signed `get_video?` URL re-resolves from `item.referer` (the embed page — the only place a fresh expiry+token exists): `isSignedRefreshable`/`refreshSourceUrl`.
- **Resume last** (`↻ Resume last` → `download-resume-last` → `dm.resumeLast()`): re-queues the most recent `done`/`error`/`cancelled` item (else newest history entry) from its saved url/title/referer → fresh id; null when nothing to resume.

## HLS downloads
`.m3u8` URLs get `item.kind:"hls"` at enqueue → `runHls()` (not probe/segmented): fetch playlist → pick best variant (`pickHlsVariant`: RESOLUTION then BANDWIDTH) → parse segments (`parseHlsPlaylist`; AES-128 `#EXT-X-KEY` → hard error, `.ts` only) → download **sequentially** via `downloadHlsSegment` (proxy failover, `_trackReq` abort, global speed limit). Resume skips existing `seg<N>.part`. Progress **indeterminate** (`total` stays 0). After the last segment `remuxToMp4` shells out to `ffmpeg` (`config.ffmpegPath`, default on PATH) with `-c copy -bsf:a aac_adtstoasc -movflags +faststart` → real `.mp4`.
- **Anti-bot decoy**: cnporn's segment CDN (tiktokcdn `.image` URLs) prepends a fake 1×1 PNG to each TS segment — `stripPngPrefix` trims up to the PNG `IEND` chunk, or ffmpeg muxes a garbage 1×1 png stream.
- The ffmpeg output is `<final>.part`, so pass `-f mp4` **immediately before** the output arg (ffmpeg can't infer the muxer from `.part`).
- Expired signed segments (403/410) bubble to `_runGuarded`; `isSignedRefreshable` covers `.m3u8` + `cnporn.org` referer → whole run re-resolves the cnporn page for a fresh playlist.

## WebSocket protocol (ws://127.0.0.1:8765)
- Server: `{type:"hello",version,port}` on connect; pushes `{type:"status",id,url,...,status,total,received,progress,speed}` on updates.
- Client→server:
  - `{type:"download",url,title,referer}` → `{type:"accepted",id,ids,url}` replied **immediately**, or `{type:"error",message}`. **The `accepted` reply must echo `url`** — `background.js` matches `m.url === url` (regression fixed 8/2026; don't drop it).
  - `download` may carry `sources` (array of `{kind,url,label}`): enqueue every `kind:"link"` entry (label → `title[label].mp4`), fall back to plain `url` when none usable; `id` = first, `ids` = all. Non-`link` kinds (`iframe`/`server`) are player pages — ignored.
  - `{type:"ping"}`→`{type:"pong"}`; `{type:"probe",url}`→`{type:"probe-result",url,size,mime,ok}`.
- Extension: `background.js` is the WS client; `content.js` never talks WS — it uses `chrome.runtime` messages (`video-found`, `get-found`, `add-to-list`, `add-all-found`, `remove-found`, `desktop-status`, `open-new-tab`); background broadcasts `dv-found-updated`.
- `background.js` webRequest capture (`NET_VIDEO_RE` = `/\.(mp4|m4v|webm|mov|mkv|flv|m3u8)([?#]|$)/i` + `ST_GETVIDEO_RE` for streamtape/fstape `/get_video?`) catches videos in **suspended/background tabs** (no DOM). **Not retroactive** — only requests after the extension reload. `onHeadersReceived` fills `size`/`mime`.
- cnporn: lazy `/embed/<uuid>` iframe holds the mp4/m3u8 — `extractCnPorn()` (3s scan, Scan, `dv-rescan`) fetches each same-origin embed once (`resolvedEmbeds` dedupes), regexes `"file":"...mp4|m3u8"`. No play-click needed.
- Dedupe before send: `isDuplicate(url)` — exact URL in `captured`, or streamtape/fstape video id in persisted `capturedIds`. Duplicates: marked added, tab closed, nothing sent.
- `markCaptured` (on accepted) → `maybeCloseTab` auto-closes the tab — only streamtape/fstape `get_video` embeds, gated by `dv.autoCloseTab`. Failed sends leave the tab open.
- Pipeline (`▶ Start`/`■ Stop`, optional Qty limit): processes ST/FST tabs one-by-one — activate → signal `dv-autoplay-now` → content.js dispatches `deepgrab:autoplay` DOM event to the userscript → wait for accepted (or 25s timeout) → close → next. Autoplay is **gated behind that event**, so nothing plays until Start.
- Titles: ST/FST embed pages have generic `<title>`; `slugTitle()` derives names from the embed URL slug (content.js + background.js); app falls back to `titleFromReferer` at enqueue.

## Userscripts (supjav.com)
- **`C:\Users\SOKCHHORN PC\Desktop\Downloads\supjav-automation.user.js` v1.7.0 (canonical)** — WS-relay only (sends `download`); the app does all resolving. Filtering, queue panel, `supjav.queue.concurrency`. **Do not add resolvers back.** Requires the desktop app.
- `supjav-collect-all.user.js` v2.0.0 (repo root) — older self-contained resolver; superseded.
- `extension/supjav-autoloop.user.js` v1.0.0 — oldest auto-loop.
- `autoplay-fst-st.user.js` (root) — Violentmonkey companion: force-plays ST/FST `<video>` muted (webRequest capture needs a real request). Source: `video.src` → `#botlink`/`#ideoolink`/`#robotlink` → `get_video?`/`.mp4` regex (normalized to `&stream=1`). Gated on `deepgrab:autoplay`.
- Install in Tampermonkey; edits don't hot-reload — re-import (Ctrl+A delete → paste → Ctrl+S).

## Verification (no test suite)
- Resolvers: serve mock HTML on 127.0.0.1, call `resolve*()` with `{proxyManager:{}, config:{autoProxy:false, maxRetries:2}}`.
- Full download: local server must honor `Range` (HEAD → Content-Length + `Accept-Ranges`; GET Range → 206) or segmented fails. Use `test-range-server.js` + `test-video.mp4`.
- Extension↔app: `ws` client to 8765, send `download`/`probe`, assert `accepted`/`probe-result`/`status`→`done`. `test-page.html` + `test-best-only.js` cover Best-only selection + WS contract.
- Network capture: not headless-testable — reload unpacked extension, play a video, check found list. Already-played videos must play again (not retroactive).

## Gotchas
- **Two mirrored repo copies exist**: `C:\Users\SOKCHHORN PC\Desktop\...` (real, canonical, where edits land) vs `...\OneDrive\Desktop\...` (stale git mirror — opencode loads AGENTS.md from here). Verify which copy you're editing.
- `EADDRINUSE` on 8765 (second instance). Kill by PID: `taskkill /F /PID <pid>` — `/IM electron.exe` can miss the port-holder.
- `settings-save` rebuilds the module-level `proxyManager` and MUST reassign `dm.proxyManager = proxyManager`, or stale `bad`/`latency` state survives the save.
- `STRGV` matches the signed `get_video?id=..&expires=..&ip=..&token=..` baked into the embed page; rebuild as `https://streamtape.com/get_video?...&stream=1`. A URL **already containing** `get_video?` is treated as resolved and passed through (fetching it downloads the video binary). Don't reintroduce the old `STRRE`/`STRVID` approach (returned the `/e/` HTML as `.mp4`).
- The size probe (`HEAD Range: bytes=0-0`) trusts `Content-Range: bytes 0-0/TOTAL` over the range-truncated `content-length` (both `downloader.js` and `main.js` `probeUrl`), or a Range-honoring server mis-reports the file as 1 byte.
- Item `_activeRes` is a Set of live responses **plus in-flight requests** (`requestWithRedirects` takes `onReq` → `_trackReq`), so `abort()` interrupts the request phase too. `abort()` errors carry `name:"AbortError"` + `aborted:true` so retry/refresh logic skips cancelled items. `_runOnce` re-checks status right after the probe (probe can take seconds).
- Speed limit is **manager-wide** (`_speedBytes`/`_speedStart`), not per download.
- `new URL(p).origin` returns `"null"` for non-http(s) schemes — `parseProxyUrl` must use `u.href`. `ws://`/`wss://` rejected as proxy schemes.
- Never run `asar extract-file <app.asar> <file>` from the repo root — it writes into CWD (a follow-up `Remove-Item` deletes the real source). Restore `main.js` from `dist/win-unpacked/resources/app.asar`.
- PowerShell: `&&` is invalid (use `;`); inline `node -e` with regex backslashes breaks under PS quoting — put test logic in a file.
- Single-instance lock needs `else { app.quit(); }` for `requestSingleInstanceLock()`, or every extra launch leaves a headless zombie main process.
- NSIS: silent `/S` without `/D` installs nothing (exit 0); silent upgrade over an existing install hangs (UAC) — replace `dist\win-unpacked` contents instead.
- Clipboard monitor only runs while `config.autoProxy` is true; `pornhub.com`/`javhub.net` in `VIDEO_DOMAINS` have **no resolver** (surface-only).
- File associations are registered at runtime (packaged only) via `registerFileAssociations()`; the default is set **once** (HKCU marker `DefaultAssocSet`) so a manual choice is never re-hijacked.
