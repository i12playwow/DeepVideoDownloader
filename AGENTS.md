# AGENTS.md — Deep Video Downloader (Deep Grab)

## Source of truth & the OneDrive wipe
- The OneDrive project (`C:\Users\SOKCHHORN PC\OneDrive\Desktop\Project WorkSpace\deep-video-downloader`) keeps deleting its ROOT files (main.js, package.json, browser.html, …) and `node_modules`. The installed app at `C:\Program Files\DeepVideoDownloader` (outside OneDrive) survives.
- **Canonical source: `C:\dvdbak`** (off-OneDrive, survives). Restore via `C:\dvdbak\sync-to-project.ps1`; build from there to dodge mid-build wipes.

## Commands
- `npm run check` = `node --check` over the JS files (syntax only).
- `npm run dist` = `electron-builder --win` (nsis, oneClick:false, perMachine:false).
- `npm.cmd start` launches dev GUI via `electron .` — only works in an interactive terminal, NOT from the agent shell.
- Build + install: `npm run dist` → `dist\DeepVideoDownloader Setup X.Y.Z.exe`.
- **Deploy to `C:\Program Files` via `C:\dvdbak\build-deploy.ps1`** — it builds then copies `dist\win-unpacked\*` into `C:\Program Files\DeepVideoDownloader` with elevation. A plain `/S` install silently FAILS to overwrite Program Files (no admin), leaving a stale build running.
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
- Shared helpers: `lib/http.js`, `lib/hls.js`, `lib/names.js`, `lib/errors.js`.

## Cookie bridge / proxies
- `main.js` `cookieHeaderFor`/`gatherCookieHeader` build a `Cookie` header from the `persist:deepgrab-browser` session; `downloader.js` attaches it via `item.cookieHeader` + `cookieProvider` on all 5 request sites (`_reqHeaders`).
- Proxies default `http://127.0.0.1:7890` + `socks5://127.0.0.1:1080` (configurable in `config.js`).
- `BROWSER_UA` (main.js) is a real Chrome UA so Cloudflare serves a solvable challenge.

## Recovery if `C:\dvdbak` is lost
1. Parse `C:\Program Files\DeepVideoDownloader\resources\app.asar` (JSON header at byte 16; `headerSize` from `readUInt32LE(4|8|12)`; `dataStart = jsonStart+headerSize` then skip NUL padding; walk `header.files`, write packed files at `dataStart+offset`).
2. Extension (unpacked) at `…\app.asar.unpacked\extension` (ignore " - Copy" junk).
3. Reconstruct `package.json` (scripts + `build.files` incl. `lib`+`extension`, `asarUnpack: ["extension/**/*"]`); `npm install -D electron electron-builder` (electron v43.x).

## Do NOT
- Add code comments unless explicitly asked.
- Revert the built-in browser to `<webview>` (the 1/5 sizing bug).
