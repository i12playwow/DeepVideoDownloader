// Error classification for the download engine: decide whether a failure is
// transient (retry), proxy-caused (rotate), a dead/expired URL (re-resolve),
// or user-aborted (silently ignore).

// True when a failure means the direct URL likely expired (signed token) and
// re-resolving the original page may yield a fresh one.
function isExpiredError(err) {
  const status = err && err.status;
  if (status === 403 || status === 404 || status === 410) return true;
  return /expired|token|forbidden|access denied/i.test(String(err && err.message));
}

// True when a failure is likely the proxy's fault (rotating to another proxy
// may fix it). 403/404/410 are excluded — those mean the URL itself is stale.
function isProxyFailure(err) {
  if (!err) return false;
  if (err.status && err.status >= 500) return true;
  return /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EPROTO|socket hang up|proxy/i.test(
    String(err.code || "") + " " + String(err.message)
  );
}

// HTTP 429 or a Cloudflare challenge body means we're being rate-limited /
// bot-blocked, NOT that the video is dead. Retry with backoff + a different
// proxy rather than re-resolving (the source page is likely blocked too).
function isRateLimited(err) {
  return !!(err && err.status === 429);
}
function isCloudflareBlocked(err) {
  if (!err) return false;
  return /cf-chl|challenge-platform|turnstile|just a moment|attention required|cf-ray|cloudflare/i.test(String(err.message));
}

function categorizeError(err) {
  if (!err) return "unknown";
  if (err.category) return err.category;
  if (err.aborted) return "aborted";
  if (isRateLimited(err)) return "rate-limited";
  if (isCloudflareBlocked(err)) return "blocked";
  if (err.status) return "http";
  if (/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket/i.test(String(err.code || "") + " " + String(err.message))) return "network";
  if (isExpiredError(err)) return "expired";
  if (/size mismatch/i.test(String(err.message))) return "size";
  return "unknown";
}

module.exports = { isExpiredError, isProxyFailure, isRateLimited, isCloudflareBlocked, categorizeError };