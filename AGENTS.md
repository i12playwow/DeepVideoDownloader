# AGENTS.md

Electron desktop app ("Deep Video Downloader"): receives MP4 URLs from a browser extension over a local WebSocket, downloads them (segmented, proxy-aware), and shows progress in a window.

## Commands

- Run the app: `npm start` (Electron, plain CommonJS). No build, test, lint, or typecheck step exists — verify changes by launching.
- Dev dependency `electron` only; runtime deps: `ws`, proxy-agent packages (`http-proxy-agent`, `https-proxy-agent`, `socks-proxy-agent`).

## Architecture

- `main.js` — Electron main: window, WebSocket server, IPC handlers, config load/save. The extension-facing integration lives here.
- `downloader.js` — download engine (queue, segmented multi-connection, pause/resume/cancel, global speed limit). Exports `DownloadManager`, `sanitizeName`, `requestWithRedirects`.
- `proxy.js` — proxy parsing, latency testing, per-request proxy selection. Exports `ProxyManager`, plus `transport()` which `downloader.js` re-imports.
- `preload.js` — `contextBridge` exposes `window.api` (IPC wrappers). This is the renderer's only way to reach the main process.
- `renderer.js` / `renderer.html` / `styles.css` — vanilla-JS UI, no framework. Renderer both polls `downloads-list` every 2s and consumes push updates from `window.api.onUpdate`.

## Integration contract (no extension code in this repo)

- WebSocket server binds `127.0.0.1` only, port from config (default `8765`).
- On connect, server sends `{"type":"hello","version":...}`. Inbound `{"type":"download",url,title,referer}` → replies `{"type":"accepted",id,ids}` or `{"type":"error",message}`; `{"type":"ping"}` → `{"type":"pong"}`. `download` may also carry `sources` (array of `{kind,url,label}`): the app enqueues every `kind:"link"` entry as its own download (label appended to the file name) and falls back to plain `url` when no usable source exists. Non-`link` kinds (`iframe`, `server`) are ignored — they are player pages, not direct files.
- Status is relayed back over WS as `{"type":"status",id,...}` on every update.
- A WS bind failure (`EADDRINUSE`) shows an error box and quits — the app does not run silently without extension integration.

## IPC surface (three files must stay in sync)

- Handlers registered in `main.js` (`settings-get`, `settings-save`, `downloads-list`, `download-pause/resume/cancel/remove`, `test-proxies`, `open-dir`) are exposed to the renderer only via the whitelist in `preload.js` and invoked by name from `renderer.js`. Adding/renaming a channel means touching all three.
- `contextIsolation: true` and `nodeIntegration: false` in `main.js`; renderer has no Node access.
- There is no UI to add a URL manually — downloads arrive only from the browser extension over WebSocket.

## Config

- `config.json` is **generated at runtime** from `DEFAULT_CONFIG` in `main.js` (deep-merged with saved values). It is intentionally absent from the repo — don't create/commit it. Editing the file while the app runs has no effect until restart (config is read once at startup; `settings-save` rewrites it live).
- Defaults: `downloadDir` = `~/Downloads/DeepGrab`, `concurrency` 3, `segments` 4, `speedLimitKB` 0, `autoProxy` true, `proxies` = `http://127.0.0.1:7890`, `socks5://127.0.0.1:1080`.

## Download engine quirks

- Segmented mode only runs when size > 2 MB, the server advertises `Accept-Ranges: bytes`, and `segments > 1`; otherwise a single stream is used.
- Segments stream into `<downloadDir>/<id>/part<N>.part` then concatenated to the final file. A single-stream resume appends at the final-file size; segmented resume skips already-complete `.part` files (guards against HTTP 416 on resume). A `200` (server ignored Range) discards/rewrites partial data in both modes.
- Pause/cancel aborts **all** in-flight connections for an item (tracked in a per-item Set), not just one.
- `speedLimitKB` is enforced globally across all concurrent downloads (a manager-wide window, not per download).
- The HEAD probe sends no `Range` header; Content-Length from HEAD is trusted (missing/zero → single-stream fallback). The probe's chosen proxy is reused for the single-stream path; segmented mode re-picks the fastest proxy per segment.
- Output filename = sanitized `title` (+ `[label]` when the download came from a `sources` entry) + `.mp4`; on a name collision a timestamp is appended (`name_<ms>.mp4`), preserving the label.
- `autoProxy` picks the lowest-latency proxy per connection via HEAD probe; a failing proxy is marked bad for 15 s (`proxy.js` `markBad`).
- Code style is plain CommonJS with terse file-top comments; match that.
