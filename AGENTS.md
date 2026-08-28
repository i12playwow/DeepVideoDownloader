# AGENTS.md — Deep Video Downloader (Deep Grab)

## Source of truth & locations (updated 2026-08-25)
- **Canonical project: `C:\dev\deep-video-downloader`** — moved OUT of OneDrive; the old OneDrive folder is deleted. OneDrive kept corrupting files there (placeholder ghosts, conflict renames, wipes).
- **Git layout**: `.git` in the project is a POINTER FILE to `C:\deep-video-git`, whose config `core.worktree` binds to `C:\dev\deep-video-downloader`. If the project moves again, update that `worktree =` line or every file shows as ` D ` in git status.
- **Backup: `C:\dvdbak`** — mirror of the project (plus node_modules + dist). Refresh it after significant changes: `robocopy C:\dev\deep-video-downloader C:\dvdbak /E /XD node_modules dist`. Files copied around this machine may carry a `RECALL_ON_OPEN` attribute (524320) — git treats such files as deleted until replaced with real copies.
- `C:\dvdbak\sync-to-project.ps1` is obsolete (OneDrive path gone); builds now run directly in `C:\dev\deep-video-downloader`.

## Commands
- `npm run check` = syntax check over root JS, lib/, extension/, test files (`node check.js`).
- `npm run dist` = `electron-builder --win` (nsis, oneClick:false, perMachine:false).
- `npm.cmd start` launches dev GUI via `electron .` — only works in an interactive terminal, NOT from the agent shell.
- Build + install: `npm run dist` → `dist\DeepVideoDownloader Setup X.Y.Z.exe`.
- **Deploy to `C:\Program Files` via `C:\dev\deep-video-downloader\build-deploy.ps1`** — it installs deps, checks, builds, then copies `dist\win-unpacked\*` into `C:\Program Files\DeepVideoDownloader` with elevation (UAC must be approved) and relauches the app. After the copy it VERIFIES the asar hash matches and the unpacked extension exists (throws otherwise), so a silent no-op copy is caught. A plain `/S` install silently FAILS to overwrite Program Files (no admin), leaving a stale build running. Gotcha: `Copy-Item -LiteralPath "...\*"` does NOT glob — always copy with `-Path "$src\*"`.
- User launches the installed **DeepVideoDownloader** from the Start menu.

## Packaging gotchas
- electron-builder STRIPS `scripts` and `build` from the `package.json` baked into `app.asar`. They exist only on disk — never trust the asar copy.
- `build.asarUnpack: ["extension/**/*"]` is REQUIRED: `session.loadExtension` cannot load from inside asar, so the extension must be on a real path (`app.asar.unpacked/extension`).
- After bumping `package.json` `version`, rebuild + reinstall.

## Built-in browser = BrowserView (NOT <webview>)
`<webview>` (OOPIF) ignores its CSS box and renders at the 300×150 default (only ~top 1/5 of the page shows). `BrowserView.setBounds()` is deterministic — never revert to `<webview>`.
- Tab state lives in main.js: `bvAddTab`, `bvActivate`, `bvCloseTab`, `bvCloseTabForUrl`, `bvPositionActive`, `bvPushTabs`, `bvPushNav`.
- Renderer `browser.html` is pure UI: sends `bv-new-tab`/`bv-close`/`bv-activate`/`bv-navigate`/`bv-back`/`bv-forward`/`bv-reload`/`bv-content-rect` via `browser-preload.js` (`window.api`); listens for `browser-tabs-update`/`browser-nav-state`.
- BrowserViews share `session: browserSession()` = `persist:deepgrab-browser` (the session the extension loads into), so HLS detection works inside them.
- Finished-tab auto-close: `pushUpdate` → `bvCloseTabForUrl(item.referer || item.url)`.

## Extension (Deep Grab) & Cloudflare
- `extension/content.js` surfaces HLS (`kind:"m3u8"`) even in best-only mode; relays downloads over WS to 127.0.0.1:8765; auto-solves CF challenges.
- **CF auto-click MUST click once then wait ~6s (cooldown via `cfLastClick`) — do NOT click every tick.** Hammering re-triggers Cloudflare Turnstile in an infinite loop. After ~6 attempts it logs "please solve manually" and stops.
- For HLS to appear, the user MUST set **Best only = OFF, Min MB = 0** in the extension popup.
- `manifest.json` `all_frames:true` so the CF auto-click fires inside the challenge iframe.

## Domain logic (missav / supjav) — all in `lib/resolvers.js`
- MissAV regex `/missav\d*\.(ws|ai|com|live|xyz)/i`; `resolveMissav` fails fast `requires-browser` (message avoids "cloudflare"/"cf-" so `downloader.js` retry loop is NOT triggered) → opens URL in built-in browser.
- Supjav `SJ_PLAYER_RE = /(?:supjav|supremejav)\.(?:com|ph|net)[^"'\s]*\bsupjav\.php/i` routes the player iframe to `resolveSupjav` (→ direct HLS).
- WS `download` enqueues every `kind:"link"` AND `kind:"iframe"` source (never `server`).
- **sextb (validated 2026-08-27)**: `sextb.net` is directly reachable (no proxy) but serves a Cloudflare **managed challenge** interstitial (`_cf_chl_opt`, `cType:'managed'`, title "Checking your browser...", `lang="vi"`) — the classic "Just a moment"/`cf-challenge` detector MISSED it, so JAV pages failed with a confusing "no supjav iframe or direct m3u8/mp4 source found" instead of routing to the built-in browser. Detect via `lib/errors.js` `isCfChallengeHtml()` (title + container + `cf-chl` markers); used by `resolveJavAggregator`, `resolveJable`, `resolveMissav` and the autoloop userscript. Once in the built-in browser the user solves CF and the extension captures the m3u8.
- Shared helpers: `lib/http.js`, `lib/hls.js`, `lib/names.js`, `lib/errors.js`.
- **sextb `/feed` blacklist (validated 2026-08-27)**: sextb pages carry WordPress nav links (`<a href="/feed">`, `/rss`, `/wp-json`, …) that the old `isSextbMoviePath` didn't reject → ~1500 `/feed` URLs got enqueued and errored with "no supjav iframe..." noise. Fixed in `extension/content.js` (`isSextbMoviePath`/`isSupjavMoviePath` blacklist adds `feed|rss|atom|api|ajax|wp-json|wp-content|wp-admin|wp-includes|trackback|xmlrpc|author|date|embed|oembed`) and `downloader.js` module-scope `isJunkNavUrl()` (last path seg in feed/rss/atom/sitemap.xml/sitemap/robots.txt/favicon.ico) used by `addPending` (skip) + `enqueue` (throw `Unsupported URL`).
- **HLS variant→master resolution (validated 2026-08-28)**: MissAV players (surrit.com) pull `…/<hash>/360p/video.m3u8` DIRECTLY, so captures pinned the 360p stream (406MB) plus downloaded the master `…/<hash>/playlist.m3u8` (997MB) separately. Two fixes in the download engine:
  1. `downloader.js` `_probeMasterPlaylist` (used by `runHls`): when the enqueued playlist is a media variant (no `#EXT-X-STREAM-INF`), probe sibling `playlist/master/index.m3u8` one dir up and switch to the master so the engine picks the HIGHEST variant. Best-effort, silent fallback.
  2. `lib/hls.js` `matchHlsMaster(url)` (pure): maps a variant URL to its family master URL(s); `downloader.js` `isDownloaded` + `_hlsMasterInFlight` treat a variant as duplicate when its master is already downloaded or queued/running → no more 997MB+406MB double download. Only `video.m3u8` filenames or quality-dir (`<N>p`/hls/sd/hd…) shapes qualify; masters (`playlist|master|index|manifest`) never dedupe against anything.

## Cookie bridge / proxies
- `main.js` `cookieHeaderFor`/`gatherCookieHeader` build a `Cookie` header from the `persist:deepgrab-browser` session; `downloader.js` attaches it via `item.cookieHeader` + `cookieProvider` on all 5 request sites (`_reqHeaders`).
- Proxies default `http://127.0.0.1:7890` + `socks5://127.0.0.1:1080` (configurable in `config.js`).
- `BROWSER_UA` (main.js) is a real Chrome UA so Cloudflare serves a solvable challenge.

## RG/K2S + chrome-extension URL handling (validated 2026-08-27)
- **k2s.cc is directly reachable** from this machine (no proxy; `pickBest` returns direct). Its `/file/<hash>/name` page is a React SPA shell (entry-index-*.js + api.k2s.cc); file info + download tokens are loaded client-side and free downloads are gated by Cloudflare Turnstile + reCAPTCHA. **Static HTML can NEVER yield a k2s download link** → `resolveFileHost`/`resolveSupjavDl` correctly throw `requires-browser`; do NOT try to add a k2s API client (no captcha-free endpoint).
- Real captured items are plain `k2s.cc/file/...` links (extension relays supjav download buttons) — before the FILEHOST_RE branch (shipped 8/27) they were saved as 3.8KB "done" HTML junk. `?dl=` token links do NOT appear in real history.
- **Tab-suspender/lazy-load extensions rewrite real URLs** into `chrome-extension://…/suspended.html#ttl=…&uri=<realURL>` or `…/lazyloading.html#<realURL>`; those must never reach the engine. `lib/urls.js` `unwrapExtensionUrl()` unwraps them to the inner http(s) target; `downloader.enqueue`/`addPending` unwrap + reject unfetchable schemes ("Unsupported URL"), and `extension/content.js` + `background.js sendToDesktop` drop non-http(s) sources at capture.

## Recovery if `C:\dvdbak` is lost
1. Parse `C:\Program Files\DeepVideoDownloader\resources\app.asar` (JSON header at byte 16; `headerSize` from `readUInt32LE(4|8|12)`; `dataStart = jsonStart+headerSize` then skip NUL padding; walk `header.files`, write packed files at `dataStart+offset`).
2. Extension (unpacked) at `…\app.asar.unpacked\extension` (ignore " - Copy" junk).
3. Reconstruct `package.json` (scripts + `build.files` incl. `lib`+`extension`, `asarUnpack: ["extension/**/*"]`); `npm install -D electron electron-builder` (electron v43.x).

## Do NOT
- Add code comments unless explicitly asked.
- Revert the built-in browser to `<webview>` (the 1/5 sizing bug).
