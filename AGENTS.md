# AGENTS.md

Electron desktop downloader ("Deep Video Downloader") + companion Chrome MV3 extension ("Deep Grab") + supjav userscripts. CommonJS, no bundler, no build step for dev.

## Commands
- Run: `npm.cmd start` (never `npm` — PowerShell can't run `npm.ps1`). Do **not** use `run.bat` — it hardcodes the OneDrive copy path (launches stale code even from Desktop); `npm.cmd start` uses the current dir.
- Package: `npm.cmd run dist` → `dist/DeepVideoDownloader Setup 1.1.0.exe` + `dist/win-unpacked/`.
- No lint/test/typecheck. Syntax check all JS: `npm.cmd run check` (runs `node --check` on root + extension + test files). Individual file: `node -c <file>.js`.

## Architecture
- `main.js` — Electron main: window, WS server (127.0.0.1:8765), IPC handlers, clipboard monitor, probe handler. Loads config via `config.js` (`loadConfig(CONFIG_PATH)`; BOM-strip + validation + stale `ws://` drop). Config path: `__dirname` (dev) or `%APPDATA%\deep-video-downloader\config.json` (packaged, `app.isPackaged`).
- `config.js` — Exports `DEFAULT_CONFIG`, `parseConfig`, `validateConfig`, `loadConfig(CONFIG_PATH)`, `saveConfig(CONFIG_PATH, config)`. `validateConfig` drops stale `ws://` proxies and normalizes types; called on `settings-save` before persisting. `loadConfig` strips leading UTF-8 BOM (Notepad/PowerShell save artifact that silently breaks JSON.parse).
- `downloader.js` — download engine (segmented, queue, pause/resume/cancel, retry, **global** speed limit, scheduling, history, thumbnails, bandwidth stats) + site resolvers + HLS engine. History → `<downloadDir>\history.json` (moves with the dir). For a normal single download `done` items stay in the active map until dismissed; bulk `addPending` auto-moves completed to history. Persistence debounced ~500ms via `_persistSoon()`; `flush()` writes synchronously on quit. **Bulk-scale**: `downloads-add-many` → `addPending()` keeps bounded live window (`config.liveWindow || concurrency*4`); completed items auto-move to history (`_toHistory`, cap `config.maxHistory` default 2000). `downloaded.json` set in download dir records done URLs; `skipDuplicates` creates `status:"duplicate"` rows (re-download via `forceDownload(id)`). Cloudflare/anti-bot: 429/`cf-chl`/`turnstile` → rate-limited/blocked → proxy rotation + backoff; expired errors (403/404/410, `expired|token|forbidden`) also rotate proxy (`markBad` + clear `item._proxy`) before refresh re-resolve.
- `proxy.js` — `ProxyManager`; `pickBest()` runs a live latency test per call against the target for every configured proxy. Supports http, https, socks, socks4, socks5, socks5h.
- `preload.js` — `contextBridge` → `window.api`; the only renderer→main path (`contextIsolation:true`, `nodeIntegration:false`).
- `renderer.html/js/styles.css` — UI. Virtualized list rendering (ROW_H=40px), polls `loadAll` every 2s, bandwidth chart updated every 5s.
- **IPC whitelist**: every channel exists in 3 places that must stay in sync — `preload.js` (method name → channel string), `ipcMain.handle("<channel>")` in `main.js`, and call sites in `renderer.js`. **Renderer only calls `window.api.<method>` — grepping renderer.js for channel strings finds nothing.**
- `config - Copy*.json` / `downloader - Copy*.js` / `main - Copy*.js` / etc. are stale backups — ignore.

## Default config (key values)
- `concurrency: 8` (hard fallback in `pump()` is 3 if config key is missing)
- `segments: 4`, `speedLimitKB: 0`, `maxRetries: 3`, `maxRefresh: 2`, `hostDelayMs: 120`
- `maxHistory: 2000` (hard fallback in `_toHistory()` is 500)
- `liveWindow: 0` (0 = `concurrency * 4`), `autoTrimAt: 500`
- `proxies: ["http://127.0.0.1:7890", "socks5://127.0.0.1:1080"]`
- `autoProxy: true`, `saveHistory: true`, `skipDuplicates: true`, `autoCloseTab: true`, `thumbnails: true`

## Built-in browser
- Tabbed browser (`browser.html` + `browser-preload.js`) with extension loaded via `persist:deepgrab-browser` session. `createBrowserWindow(urls)` in main.js; IPC: `browser-open`/`browser-nav`/`browser-external`; main→browser: `browser-open-tabs`/`browser-add-tabs`/`browser-close-tab-for-url`.
- **Deferred loading**: tabs created with `{ defer: true }` — webview attached but no `src` set until user clicks the tab or hits "Load all"/"Load sel". Each pending tab has a checkbox for batch selection.
- **Extract overlay** (nav bar Extract button): paste any text → regex-extracts all http/https URLs → checkbox list → "Open as tabs" as deferred tabs.
- Renderer also has an **Extract** button next to the URL textarea that opens the browser and injects extracted URLs.
- OOPIF webview sizing: `ResizeObserver` + explicit pixel `width`/`height` on each webview; `sizeWebviews()` called on resize and when switching tabs.
- Extension must use `chrome.storage.local`, not `sync` (Electron has no `storage.sync`). Only one extension per partition; reload the app after editing.
- `autoCloseTab` on: `pushUpdate` sends `browser-close-tab-for-url` (matched by `item.referer`) on completion so browser closes that tab + activates next.
- Tabs are pulled from main via `browser-get-tabs` IPC (preload exposes `getInitialTabs`).

## Download flow
Each `resolve*()` returns `{resolvedUrl, proxy, agent, origin?}` and re-resolves when result is another supported site:
- `streamtape.com`/`fstape.com` → `resolveStreamtape` (`STRGV`) → signed `get_video?...&stream=1`. **Modern streamtape** (8/2026+) must be captured via built-in browser/extension — the signed URL comes from `/stat/<token>?a=0&rc=<recaptcha>` POST (gated by ad-click + recaptcha + ~40s delay); `rc` token is browser-generated, pure Node resolver can't get it. Extension's `ST_GETVIDEO_RE` webRequest intercepts the resulting `get_video` request.
- `cnporn.org` → `resolveCnPorn` → embed `sources` (JSON `\/` unescaped) → m3u8 or mp4. Lazy `/embed/<uuid>` iframe (`CNEMBED`).
- `xvideos.com` → `resolveXVideos` → streamtape. `xhamster.com` → `resolveXHamster` → xvideos → streamtape.
- `supjav.php?l=<OLID>` → `resolveSupjav`: reverse id → 302 to streamtape/fstape embed. **8/2026**: supjav switched to `turbovidhls.com/t/<id>` (JWPlayer/HLS) — `resolveSupjav` pulls m3u8 from `#video_player[data-hash]` → HLS engine (same tiktokcdn segments + PNG-decoy as cnporn).
- Generic URLs pass through. Resolution is lazy: `enqueue()` returns id immediately; resolved URL stored on `item._resolvedUrl`. Expired direct URLs (403/404/410 or `expired|token|forbidden`) auto-re-resolve up to `config.maxRefresh` (default 2).
- **Per-host pacing** (`_paceHost`): minimum interval between requests to same host (`config.hostDelayMs`, default 120), serialized per host via `_paceChains`.

## HLS downloads
`.m3u8` → `runHls()`: fetch playlist → best variant (`pickHlsVariant`) → parallel segment download (default `hlsConcurrency=4`) → `remuxToMp4` via ffmpeg (`-f concat -safe 0 -i concat.txt -c copy -bsf:a aac_adtstoasc -movflags +faststart -f mp4`). Anti-bot decoy: tiktokcdn `.image` URLs prepend fake 1×1 PNG to each TS segment → `stripPngPrefix` trims. ffmpeg output is `<final>.part` — pass `-f mp4` immediately before output arg. Thumbnails via `makeThumb()`: ffmpeg `-ss 3` with first-frame fallback, scale=96:-1.

## WebSocket protocol (ws://127.0.0.1:8765)
- Server: `{type:"hello",version,port}` on connect; pushes `{type:"status",...}` on updates.
- Client→server: `{type:"download",url,title,referer}` → `{type:"accepted",id,ids,url}` or `{type:"error",message,url}`. **Both replies must echo `url`** — background.js matches `m.url === url` per reply.
- `download` may carry `sources` (array of `{kind,url,label}`): enqueue every `kind:"link"` entry.
- `ping` → `{type:"pong"}`. `probe` → `{type:"probe-result",url,ok,size,mime}`.
- Extension: `background.js` is the WS client; `content.js` uses `chrome.runtime` messages only.
- `background.js` webRequest capture: `NET_VIDEO_RE` + `ST_GETVIDEO_RE` catches videos in suspended/background tabs. Not retroactive. `AD_DOMAINS` regex filters ad-network streams.
- Pipeline (`▶ Start`/`■ Stop`): processes ST/FST tabs one-by-one — activate → `dv-autoplay-now` → wait accepted (25s timeout) → close → next. State persisted to `chrome.storage.local` (`dv_pipeline`), restored on SW wake.
- **Auto-play scan**: activates each eligible tab, sends `dv-autoplay-capture`, waits 4s, rescans, advances. Broadcasts `autoplay-scan-state`. Button shows progress (`⏹ Scan 3/10`).
- Titles: `slugTitle()` derives names from embed URL slug; app falls back to `titleFromReferer`.

## Userscripts
- `autoplay-fst-st.user.js` (root) — Violentmonkey companion: force-plays ST/FST `<video>` muted (webRequest capture needs a real request). Gated on `deepgrab:autoplay`.
- `extension/supjav-autoloop.user.js` — oldest auto-loop.
- `supjav-collect-all.user.js` (root) — older self-contained resolver; superseded.
- Canonical `supjav-automation.user.js` v1.7.0 lives at `C:\Users\SOKCHHORN PC\Desktop\Downloads\` (not in repo). Do not add resolvers back.
- Install in Tampermonkey; edits don't hot-reload — re-import.

## Extension files
- `extension/` — self-contained MV3. Edit → **must reload at `chrome://extensions`**. `webRequest` + `*://*/*` perms, `all_frames:true`. Also loaded into built-in browser session.
- `extension-firefox/` — same JS copied verbatim, Firefox manifest (event page + gecko id). Edit → **must reload at `about:debugging#/runtime/this-firefox`**. **Missing vs Chrome**: no popup UI (popup.html/popup.js/icons/).
- `content.js` and `background.js` must stay identical between `extension/` and `extension-firefox/` for `AD_DOMAINS` and capture logic.

## Verification (no test suite)
- Headless engine tests: small `http` server honoring `Range`, `new DownloadManager({ config, proxyManager, onUpdate })` with `downloadDir` → `mkdtemp` folder, `saveHistory:false, thumbnails:false, autoProxy:false`. **`enqueue()` is `async`** — `await` it. Poll `dm.items.get(id)` until `done`/`error`.
- Resolvers: serve mock HTML on 127.0.0.1, call `resolve*()`.
- Full download: local server must honor `Range`. Use `test-range-server.js` + `test-video.mp4`.
- Extension↔app: `ws` client to 8765, send `download`/`probe`, assert `accepted`/`probe-result`/`status`→`done`. `test-page.html` + `test-best-only.js`.
- Network capture: not headless-testable — reload unpacked extension, play video, check found list.

## Gotchas
- **Repo layout**: `C:\Users\SOKCHHORN PC\OneDrive\Desktop\Project WorkSpace\deep-video-downloader` is the single canonical repo and git root. `C:\deep-video-downloader` is a copy. Do not point `config.extensionPath` at a copy missing `extension/`.
- `EADDRINUSE` on 8765 (second instance). Kill by PID: `taskkill /F /PID <pid>` — `/IM electron.exe` can miss the port-holder.
- `settings-save` rebuilds `proxyManager` and MUST reassign `dm.proxyManager = proxyManager`, or stale bad/latency state survives.
- `STRGV` matches signed `get_video?id=..&expires=..&ip=..&token=..` baked into embed page. A URL already containing `get_video?` is treated as resolved — don't reintroduce old `STRRE`/`STRVID`.
- Size probe (`HEAD Range: bytes=0-0`) trusts `Content-Range: bytes 0-0/TOTAL` over range-truncated `content-length`.
- Item `_activeRes` is a Set of live responses + in-flight requests; `abort()` interrupts request phase too. `abort()` errors carry `name:"AbortError"` + `aborted:true`.
- `pump()`'s `.catch` **must keep ignoring `err.aborted`** — a `pause()` immediately followed by `resume()` re-queues before the stale AbortError lands; without the guard the resumed item wrongly flips to error.
- `cancel()` **must remove the empty `finalPath`** it created mid-flight, not just `tempDir`.
- **Orphaned `dl-*` temp dirs**: `_sweepOrphanTempDirs()` runs at `DownloadManager` construction, removes every `dl-<n>-<ts>` dir not in active map.
- Speed limit is manager-wide, not per download.
- `new URL(p).origin` returns `"null"` for non-http(s) schemes — `parseProxyUrl` must use `u.href`.
- Never run `asar extract-file` from repo root — writes into CWD; a follow-up `Remove-Item` deletes real source.
- PowerShell: `&&` invalid (use `;`); inline `node -e` with regex backslashes breaks under PS quoting — put test logic in a file.
- Single-instance lock needs `else { app.quit(); }` for `requestSingleInstanceLock()`.
- NSIS silent `/S` without `/D` installs nothing; silent upgrade hangs (UAC) — replace `dist\win-unpacked` instead.
- Clipboard monitor only runs while `config.autoProxy` is true; `pornhub.com`/`javhub.net` in `VIDEO_DOMAINS` have no resolver.
- File associations registered at runtime (packaged only) via `registerFileAssociations()`; default set once (HKCU marker `DefaultAssocSet`).
