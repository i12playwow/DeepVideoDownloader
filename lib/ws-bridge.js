// Extension -> app WebSocket message handling (the Deep Grab extension's
// sendToDesktop contract). Kept separate from main.js so the real logic can
// be unit/integration tested with a real ws client without Electron.
//
// `ctx` = { dm, gatherCookieHeader, probeUrl, send }
//   - send(o): push a JSON message back to the extension socket.
//   - dm: the real DownloadManager (enqueue is called for real).
//   - gatherCookieHeader(urls): builds a Cookie header (no-op in tests).
//   - probeUrl(url): size probe used by the extension's panel.

const { isCfwalledSupjavMovie } = require("./resolvers");

// Wire protocol version for the extension<->app WebSocket contract. The app and
// extension each advertise it in their `hello`; a client claiming a NEWER
// protocol than the app implements is refused (its messages may rely on fields
// the app won't send), while an OLDER client (including a legacy one that sends
// no protocolVersion at all) keeps working unchanged. Bump only on a breaking
// message-shape change.
const PROTOCOL_VERSION = 1;

// A client protocol version is compatible when it is absent (legacy = v1),
// numerically equal, or strictly older than the app's. Any newer version is
// rejected.
function isProtocolCompatible(clientVersion, serverVersion = PROTOCOL_VERSION) {
  if (clientVersion == null || clientVersion === "") return true; // legacy = v1
  const cv = Number(clientVersion);
  const sv = Number(serverVersion);
  // A protocol version must be a finite positive integer; reject malformed
  // (0, negative, "abc") and any version newer than the app implements.
  if (!Number.isInteger(cv) || cv < 1 || !Number.isFinite(sv)) return false;
  return cv <= sv;
}

async function handleWsMessage(msg, ctx) {
  const { dm, gatherCookieHeader, probeUrl, send } = ctx;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "download") {
    try {
      // `sources` (array of {kind,url,label}) may accompany a download:
      // enqueue every `kind:"link"` entry AND every `kind:"iframe"` entry
      // as its own download (label appended to the file name); fall back to
      // plain `url` when no usable source exists. `iframe` carries the
      // player page (e.g. supjav.php?l=<OLID>) which resolvers turn into a
      // direct URL, so it must be enqueued — only `server` (often a
      // `javascript:` pseudo-URL) is ignored.
      const links = Array.isArray(msg.sources)
        ? msg.sources.filter((s) => s && (s.kind === "link" || s.kind === "iframe") && typeof s.url === "string")
        : [];
      const usable = links.length
        ? links
        : (typeof msg.url === "string" ? [{ kind: "link", url: msg.url, label: "" }] : []);
      if (!usable.length) {
        send(errorReply(ERROR_CODES.NO_USABLE_SOURCE, "No usable source", { url: msg.url || "", reqId: msg.reqId }));
        return;
      }
      // Drop sources we know are doomed (supjav.com movie pages behind a
      // Cloudflare managed challenge) so one junk source in a batch never aborts
      // the good player URL sitting next to it.
      const filtered = usable.filter((s) => !isCfwalledSupjavMovie(s.url));
      if (!filtered.length) {
        send(errorReply(ERROR_CODES.CLOUDFLARE_CHALLENGED, "Cloudflare-challenged supjav movie page — open it in real Chrome with the Deep Grab extension to auto-capture the player stream", { url: msg.url || "", reqId: msg.reqId }));
        return;
      }
      const ids = [];
      for (const s of filtered) {
        const cookieHeader = msg.cookieHeader != null ? msg.cookieHeader : await gatherCookieHeader([s.url, msg.referer]);
        const id = await dm.enqueue({
          url: s.url,
          title: msg.title,
          referer: msg.referer,
          label: s.label || "",
          cookieHeader,
          reqId: msg.reqId || "",
          scheduledStart: msg.scheduledStart ? new Date(msg.scheduledStart).getTime() : null,
          scheduledStop: msg.scheduledStop ? new Date(msg.scheduledStop).getTime() : null
        });
        ids.push(id);
      }
      send({ type: "accepted", id: ids[0], ids, url: msg.url, reqId: msg.reqId || undefined });
    } catch (e) {
      send(errorReply(ERROR_CODES.ENQUEUE_FAILED, e.message, { url: msg.url || "", reqId: msg.reqId }));
    }
    return;
  }

  if (msg.type === "ping") {
    send({ type: "pong", reqId: msg.reqId || undefined });
    return;
  }

  if (msg.type === "probe") {
    const r = await probeUrl(msg.url);
    send({ type: "probe-result", url: msg.url, reqId: msg.reqId || undefined, ...r });
    return;
  }
}

// Per-socket crawl throttle. A one-shot bulk paste (burst) passes freely; a
// socket that keeps sending for longer than burstWindowMs is a crawl, and its
// accepted downloads are capped (sustainedPerMin per rolling minute) so a
// runaway browser userscript can no longer flood the engine or the tab opener.
function makeCrawlThrottle(opts = {}) {
  const burstWindowMs = opts.burstWindowMs || 8000;
  const sustainedPerMin = opts.sustainedPerMin || 4;
  const idleResetMs = opts.idleResetMs || 10000;
  const state = { windowStart: 0, bursted: false, timestamps: [], last: 0 };
  return function shouldThrottle(now) {
    now = now || Date.now();
    while (state.timestamps.length && now - state.timestamps[0] > 60000) state.timestamps.shift();
    if (state.last && now - state.last > idleResetMs) {
      state.windowStart = now;
      state.bursted = false;
      state.timestamps = [];
    }
    if (!state.windowStart) state.windowStart = now;
    if (!state.bursted && now - state.windowStart > burstWindowMs) state.bursted = true;
    state.timestamps.push(now);
    state.last = now;
    if (!state.bursted) return false;
    return state.timestamps.length > sustainedPerMin;
  };
}

// Closed set of machine-readable error codes for the `error` reply envelope.
// Keep this list exhaustive and stable — clients branch on these, so a new
// code is an additive change (safe) and renaming one is a breaking change.
const ERROR_CODES = {
  NO_USABLE_SOURCE: "NO_USABLE_SOURCE", // download with no usable url/sources
  CLOUDFLARE_CHALLENGED: "CLOUDFLARE_CHALLENGED", // doomed supjav movie page dropped
  ENQUEUE_FAILED: "ENQUEUE_FAILED", // enqueue threw (unsupported URL, engine error)
  PACE_LIMITED: "PACE_LIMITED", // crawl throttle refused a download
  PROTOCOL_MISMATCH: "PROTOCOL_MISMATCH", // extension newer than the app
  INTERNAL: "INTERNAL" // uncaught handler error
};

// Build a structured `error` reply. `retryAfter` (seconds) is meaningful only
// when `retryable` is true (e.g. PACE_LIMITED). Always includes `code` and
// `retryable`; `reqId`/`retryAfter` are added only when provided, so legacy
// clients that ignore unknown fields keep working.
function errorReply(code, message, { url = "", reqId, retryable = false, retryAfter } = {}) {
  const o = { type: "error", code, message, url, retryable };
  if (reqId != null) o.reqId = reqId;
  if (retryAfter != null) o.retryAfter = retryAfter;
  return o;
}

// WS pairing policy for the local server (127.0.0.1:config.port). Only the
// Deep Grab extension may pair from a browser context; a web page can open a
// WebSocket to a loopback port with whatever Origin it likes, so rejecting
// every non-extension origin closes the drive-by hole where a site you visit
// enqueues downloads or runs probes against the app. The extension id is
// path-derived for unpacked dev loads and store-derived when packaged, so any
// chrome-extension:// id is accepted (same for Firefox moz-extension://).
// Clients with NO Origin header (native loopback tools, tests) are allowed.
function isAllowedWsOrigin(origin) {
  if (!origin) return true;
  return origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://");
}

module.exports = { PROTOCOL_VERSION, ERROR_CODES, errorReply, isProtocolCompatible, handleWsMessage, makeCrawlThrottle, isAllowedWsOrigin };
