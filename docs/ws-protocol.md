# WS Protocol — Deep Grab extension ↔ Deep Video Downloader app

Single source of truth for the WebSocket message contract between the **Deep Grab
extension** (`extension/`) and the **desktop app** (`main.js` +
`lib/ws-bridge.js`). If a behavior in the code disagrees with this file, the code
is wrong — fix the code, not this doc.

- **Transport:** WebSocket, JSON text frames. One JSON object per frame.
- **Default endpoint:** `ws://127.0.0.1:8765` (config `port`; the boot-verify
  drill uses an isolated `8766`).
- **Server:** the Electron app (`main.js` `startWsServer`, via `ws` lib).
- **Client:** the Deep Grab extension's MV3 service worker
  (`extension/background.js`). Native loopback tools and tests may also connect
  as clients.

---

## 1. Connection lifecycle

### 1.1 Pairing / origin policy

On every connection the app enforces `isAllowedWsOrigin` (`lib/ws-bridge.js`):

| Origin header | Allowed | Why |
|---|---|---|
| `chrome-extension://<id>` | yes | the Deep Grab extension (packaged or unpacked dev) |
| `moz-extension://<id>` | yes | the Firefox port |
| *(absent)* | yes | native loopback clients / tests |
| anything else (`https://…`, `http://…`, `file://`, `null`) | **no** | a web page can open `ws://127.0.0.1:<port>` with any Origin, so this closes the drive-by enqueue/probe hole |

Rejected origins get `ws.close(1008, "origin not allowed")`.

### 1.2 Handshake (protocol versioning)

1. App sends on connect:

   ```json
   { "type": "hello", "version": "1.0.0", "protocolVersion": 1, "port": 8765 }
   ```

   - `version` = app build version (cosmetic).
   - `protocolVersion` = the wire protocol this app speaks.

2. Client replies:

   ```json
   { "type": "hello", "v": "1.0.2", "protocolVersion": 1 }
   ```

   - `v` = extension version (cosmetic).
   - `protocolVersion` = the wire protocol this extension speaks.

3. App validates the client's `protocolVersion` with
   `isProtocolCompatible(clientVersion, serverVersion)`:
   - **Legacy / older:** `protocolVersion` absent, `""`, equal to the app's, or
     strictly lower → accepted unchanged.
   - **Newer:** `protocolVersion > app` (or malformed: non-integer, `< 1`) →
     refused. The app sends `PROTOCOL_MISMATCH` and closes with
     `1008 protocol version mismatch`:

     ```json
     { "type": "error", "code": "PROTOCOL_MISMATCH", "message": "Extension is newer than the app — update Deep Video Downloader (app protocol v1)", "url": "", "retryable": false }
     ```

4. After a compatible client hello, the app pushes the authoritative
   auto-grab state so the extension's mirror is correct from the start.

**Versioning rule:** `PROTOCOL_VERSION` (in `lib/ws-bridge.js`) is bumped only
on a *breaking* message-shape change (renamed `type`, removed field a client
depends on). Additive fields never bump it. An older client always keeps working;
only a newer-than-app client is refused.

---

## 2. Request correlation (`reqId`)

Every request may carry an optional client-generated `reqId` so a reply can be
matched to the exact request that produced it — even when the same URL is
re-sent (family-dedupe, retry, bulk paste).

- The client generates `reqId` per request (`nextReqId()` in background.js).
- The app echoes it in the reply (`accepted`, `error`, `pong`, `probe-result`)
  and **carries it into every `status` push** for the enqueued item (stored on
  the item at `enqueue({ reqId })`, emitted in `main.js` `flushUpdates`).
- Client matching order: prefer `reqId` equality; fall back to the legacy
  `url`-compare when the reply has no `reqId` (older server).

`reqId` is optional and backward compatible — messages without it work exactly
as before via `url`-based matching.

---

## 3. Client → app messages

### 3.1 `download`
Request to enqueue one or more downloads.

```json
{
  "type": "download",
  "reqId": "r1-…",                // optional correlation id
  "url": "https://…/video.mp4",   // used when sources is absent/empty
  "title": "Optional title",      // optional; falls back to URL-derived title
  "referer": "https://…",         // page that produced the URL
  "cookieHeader": "a=b; c=d",     // optional; gathered server-side if absent
  "sources": [                    // optional batch; if present+non-empty this
    { "kind": "link", "url": "…", "label": "" },   // takes precedence over url
    { "kind": "iframe", "url": "…", "label": "" }  // player page -> resolved
  ],
  "scheduledStart": "ISO…",       // optional schedule window
  "scheduledStop": "ISO…"
}
```

- Every `sources[]` entry with `kind: "link"` or `"iframe"` is enqueued as its
  own download (`label` is appended to the file name). `kind: "server"` is
  ignored. When `sources` is absent/empty, a single `{kind:"link", url}` is
  derived from `url`.
- Sources matching the Cloudflare-challenged supjav movie-page predicate are
  dropped so one doomed source never aborts a good sibling.
- Replies: **`accepted`** on success, **`error`** on failure (see §4).
- The enqueued item stores `reqId` and echoes it in `status` pushes.

### 3.2 `ping`
```json
{ "type": "ping", "reqId": "…" }   // reqId optional
```
→ **`pong`** (echoes `reqId`).

### 3.3 `probe`
Ask the app to HEAD-probe a URL for size/mime (used by the extension panel).

```json
{ "type": "probe", "reqId": "…", "url": "https://…" }
```
→ **`probe-result`**.

### 3.4 `dv-monitor-set`
Toggle the app's `autoGrab` setting from the popup.

```json
{ "type": "dv-monitor-set", "on": true }
```
The app persists the setting and broadcasts the new state (and harvests if just
enabled). No direct reply.

### 3.5 `dv-monitor-result`
Report back after a harvest triggered by the app's `dv-monitor-grab`.

```json
{ "type": "dv-monitor-result", "sent": 3, "remaining": 2 }
```
Currently informational; the app does not act on it.

---

## 4. App → client messages

### 4.1 `hello`
Connection greeting — see §1.2.

### 4.2 `accepted`
A `download` was accepted (replies to §3.1).

```json
{ "type": "accepted", "id": "dl-1-…", "ids": ["dl-1-…", "dl-2-…"], "url": "https://…", "reqId": "…" }
```

- `id` = first enqueued item id; `ids` = all enqueued item ids (usually length 1).
- `reqId` echoed from the request when present.

### 4.3 `error`
Any failure reply. Every error is a **structured envelope** — always carries a
machine-readable `code` from a small closed set plus a `retryable` flag; the
legacy flat `{message}`-only shape is no longer emitted (but older clients that
read only `message` still work). Fields:

| Field | Meaning |
|---|---|
| `type` | always `"error"` |
| `code` | machine-readable code from the closed set (below) |
| `message` | human-readable reason |
| `url` | the URL the request concerned (may be `""`) |
| `reqId` | echoed correlation id (when the request carried one) |
| `retryable` | whether the client may retry (transient failure) |
| `retryAfter` | seconds to wait before retrying; present only when `retryable` is true |

**Closed code set** (`ERROR_CODES` in `lib/ws-bridge.js`):

| Code | Meaning | retryable |
|---|---|---|
| `NO_USABLE_SOURCE` | download with no usable url / sources | no |
| `CLOUDFLARE_CHALLENGED` | doomed supjav movie page dropped | no |
| `ENQUEUE_FAILED` | enqueue threw (unsupported URL, engine error) | no |
| `PACE_LIMITED` | crawl throttle refused a download | **yes**, `retryAfter: 60` |
| `PROTOCOL_MISMATCH` | extension newer than the app | no |
| `INTERNAL` | uncaught handler error | no |

### 4.4 `pong`
Replies to `ping`. `{ "type": "pong", "reqId": "…" }`.

### 4.5 `probe-result`
Replies to `probe`.

```json
{ "type": "probe-result", "url": "https://…", "reqId": "…", "ok": true, "size": 102400, "mime": "video/mp4" }
```
On failure `ok` is `false` and `error` carries the reason.

### 4.6 `status`
Download progress/terminal-state push — one per item per update batch
(coalesced on a ~100 ms flush). Carries both the item `id` **and** the originating
`reqId` for correlation.

```json
{
  "type": "status",
  "id": "dl-1-…",
  "reqId": "…",
  "url": "https://…",
  "label": "",
  "fileName": "…mp4",
  "status": "queued | running | done | error | duplicate | cancelled | scheduled",
  "total": 0,
  "received": 0,
  "progress": 0,
  "speed": 0,
  "proxy": "",
  "error": "",
  "errorCategory": "",
  "errorStatus": 0,
  "errorCode": "",
  "retryable": false,
  "resolving": false,
  "refreshCount": 0,
  "finalPath": "",
  "thumb": ""
}
```

### 4.7 `dv-auto-grab`
Broadcast of the current `autoGrab` setting to every connected extension.

```json
{ "type": "dv-auto-grab", "on": true }
```

### 4.8 `dv-close-tab`
Tells the extension to close the source tab of a finished download (auto-grab
lifecycle). Sent when `autoGrab` is on and a download reached `done`.

```json
{ "type": "dv-close-tab", "pageUrl": "https://…" }
```

### 4.9 `dv-monitor-grab`
Asks the extension to harvest (send every found-not-yet-grabbed video). Sent on
auto-grab enable and after done downloads while auto-grab is on.

```json
{ "type": "dv-monitor-grab" }
```
The extension replies with `dv-monitor-result`.

---

## 5. Lifecycle sequences

**Download (client → app → client):**

```
client                       app
  |  download {reqId, url}     |
  |---------------------------->|
  |  accepted {id, ids, url, reqId} |
  |<----------------------------|
  |  status {id, reqId, ...}    |   (one+ pushes, status queued→running→done/error)
  |<----------------------------|
```

**Probe:**

```
  |  probe {reqId, url}   |
  |---------------------->|
  |  probe-result {reqId, url, ok, size, mime} |
  |<----------------------|
```

**Ping/pong:**

```
  |  ping {reqId} |
  |-------------->|
  |  pong {reqId} |
  |<--------------|
```

**Auto-grab harvest:**

```
app                          client
  | dv-monitor-grab             |
  |---------------------------->|
  |  (harvest: sends downloads) |
  | dv-monitor-result {sent, remaining} |
  |<----------------------------|
```

---

## 6. Out-of-band notes

- The app's crawl **throttle** rejects sustained download floods with
  `PACE_LIMITED` (`retryable: true`, `retryAfter: 60`) — the WS analogue of
  HTTP 429 + Retry-After.
- `status` pushes are broadcast to **all** connected clients; each client filters
  by `id`/`url`/`reqId`.
- The `status` push carries both the human `error` string and a structured
  `errorCode` derived from `errorCategory` (e.g. `EXPIRED`, `NOT_VIDEO`,
  `REQUIRES_BROWSER`, or the category uppercased) plus `errorStatus` (the raw
  HTTP status of the failure, `0` for non-HTTP) and a `retryable` flag. The
  flag is computed by the same function the engine calls (`isTransientError`
  in `lib/status.js`, the single owner of the auto-retry rule), so the wire
  and the engine can never disagree: `network` / `rate-limited` / `blocked`
  are always retryable, and `http` only when `errorStatus >= 500` — a
  404/403/410 is NOT auto-retried by the engine and is flagged
  `retryable: false`.
- `hello` from the app is sent on connect and on every reconnect; the extension
  re-sends its own `hello` on `ws.onopen`.

---

## 7. Capability / trust model (local companion app, not a user-accounted service)

This app has **no user login, no passphrase, no account, and no remote identity**.
"Auth" here means *who can do what on the local machine*, enforced by two
independent seams.

### 7.1 Connection pairing (the only enforced client identity)

`isAllowedWsOrigin` (`lib/ws-bridge.js`) is the gate.

| Origin header | Who it is | Allowed | Why |
|---|---|---|---|
| `chrome-extension://<id>` | the Deep Grab extension (packaged or unpacked dev) | yes | the companion capture client |
| `moz-extension://<id>` | the Firefox port | yes | same contract |
| *(absent)* | native loopback client (another local process, test, or tool) | yes | no browser Origin header on a local ws connection |
| anything else (`https://…`, `http://…`, `file://`, `null`) | a webpage that opened `ws://127.0.0.1:<port>` | **no** | a site you visit can open that ws with any Origin, so this closes the drive-by enqueue/probe hole |

Rejected origins get `ws.close(1008, "origin not allowed")`.

### 7.2 What a paired client can do

Once paired, both extension-origin and native-loopback clients speak the same
message surface (`download`, `probe`, `ping`, `dv-monitor-set`, and the
auto-grab/monitor control flow). The two client classes differ in *how they get
there*, not in the protocol they are then allowed to use:

- **Extension-origin client** — the intended companion. It is the only client
  that can carry a real page `cookieHeader` gathered from the extension's
  partition, and the only client the app treats as the capture source for
  auto-grab (`dv-auto-grab` / `dv-monitor-grab` / `dv-close-tab`).
- **Native loopback client** — a local tool or test process. It is trusted only
  by virtue of being on the same machine and connecting to the loopback port
  without an Origin header. It has the same enqueue/probe/ping/monitor surface,
  but it does **not** bring extension-captured cookies or page context; the
  `cookieHeader` it sends (if any) is whatever the caller supplies, and the
  engine falls back to server-side cookie gathering exactly as it does for any
  other `download`.

There is **no per-client capability restriction inside the message protocol**:
the pairing gate is the only auth seam. If a future feature needs finer-grained
client roles (e.g. a read-only monitor, a delegated remote client, or a
restrictable extension id), add it explicitly there instead of widening the
loopback trust boundary.

### 7.3 Privileged local admin action (not user auth)

`extension-install` (`lib/ipc.js`, wired from `main.js`) launches a real
Chrome/Edge/Brave on a dedicated persistent profile with `--load-extension` so
the Deep Grab extension is loaded without manual `chrome://extensions` work.
This is an **operator action initiated from the local window**, not a login or
an account sync. It does not authenticate the user; it only runs an Electron
`execFile` against browser executables found by `findBrowser` and writes a
profile under `app.getPath("userData")`.

### 7.4 What the app intentionally does NOT provide

- No passphrase / PIN / window lock to keep a passerby from using the open
  window. The app runs as the logged-in Windows user, so whoever can sit at that
  session can already enqueue, probe, change settings, export history, and launch
  browsers on that machine.
- No remote access. The WebSocket listens only on `127.0.0.1`; the app does not
  expose itself on a LAN or public interface.