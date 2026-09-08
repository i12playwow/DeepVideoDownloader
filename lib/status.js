// Status-push payload builder, extracted from main.js's flushUpdates so the
// flush path is unit-testable offline without Electron. Pure: these helpers
// must never touch the item object, or an errored download would throw here
// and drop the whole status flush (the flush-crash class of bug this module
// exists to keep out).
//
// isTransientError is the SINGLE owner of the auto-retry transient rule: the
// download engine (downloader.js pump catch) calls it to decide whether to
// auto-requeue, and statusPayload calls it for the push's retryable flag, so
// the wire can never drift from what the engine actually requeues. network /
// rate-limited / blocked are always transient, and http is transient only
// when the response status is >= 500 (a 404/403/410 is NOT auto-retried by
// the engine, so it must not be flagged retryable here).

// Categories the engine auto-retries with exponential backoff regardless of
// HTTP status (the same closed set used in downloader.js).
const TRANSIENT_CATS = ["network", "rate-limited", "blocked"];

// An error is transient (auto-retried before landing in terminal error) when
// its category is in the transient set, or it is an http failure with a 5xx
// status. Mirrors: `cat === "network" || cat === "rate-limited" ||
// cat === "blocked" || (cat === "http" && err.status >= 500)`.
function isTransientError(cat, httpStatus) {
  if (!cat) return false;
  return TRANSIENT_CATS.includes(cat) || (cat === "http" && Number(httpStatus) >= 500);
}

// Machine-readable error code derived from the engine's errorCategory
// (closed-ish set; unknown categories fall back to the uppercased name).
function errorCodeFor(cat) {
  if (!cat) return "";
  return cat === "expired" ? "EXPIRED" :
    cat === "not-video" ? "NOT_VIDEO" :
    cat === "requires-browser" ? "REQUIRES_BROWSER" :
    cat === "rate-limited" ? "RATE_LIMITED" :
    cat.toUpperCase();
}

// Build the status push payload for one download item (the WS + renderer
// relay shape). `errorStatus` is the raw HTTP status of the failure (0 when
// not an http error), so clients can apply the same 5xx rule the engine uses.
function statusPayload(item) {
  return {
    type: "status",
    id: item.id,
    reqId: item.reqId || "",
    url: item.url,
    label: item.label,
    fileName: item.fileName,
    status: item.status,
    total: item.total,
    received: item.received,
    progress: item.total ? item.received / item.total : 0,
    speed: item.speed,
    proxy: item.proxy,
    error: item.error,
    errorCategory: item.errorCategory,
    errorStatus: item.errorStatus || 0,
    errorCode: errorCodeFor(item.errorCategory),
    retryable: isTransientError(item.errorCategory, item.errorStatus),
    resolving: !!item.resolving,
    refreshCount: item.refreshCount,
    finalPath: item.finalPath,
    thumb: item.thumb || ""
  };
}

module.exports = { isTransientError, errorCodeFor, statusPayload };