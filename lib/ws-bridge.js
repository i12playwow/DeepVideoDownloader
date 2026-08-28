// Extension -> app WebSocket message handling (the Deep Grab extension's
// sendToDesktop contract). Kept separate from main.js so the real logic can
// be unit/integration tested with a real ws client without Electron.
//
// `ctx` = { dm, gatherCookieHeader, probeUrl, send }
//   - send(o): push a JSON message back to the extension socket.
//   - dm: the real DownloadManager (enqueue is called for real).
//   - gatherCookieHeader(urls): builds a Cookie header (no-op in tests).
//   - probeUrl(url): size probe used by the extension's panel.

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
        send({ type: "error", message: "No usable source", url: msg.url || "" });
        return;
      }
      const ids = [];
      for (const s of usable) {
        const cookieHeader = await gatherCookieHeader([s.url, msg.referer]);
        const id = await dm.enqueue({
          url: s.url,
          title: msg.title,
          referer: msg.referer,
          label: s.label || "",
          cookieHeader,
          scheduledStart: msg.scheduledStart ? new Date(msg.scheduledStart).getTime() : null,
          scheduledStop: msg.scheduledStop ? new Date(msg.scheduledStop).getTime() : null
        });
        ids.push(id);
      }
      send({ type: "accepted", id: ids[0], ids, url: msg.url });
    } catch (e) {
      send({ type: "error", message: e.message, url: msg.url });
    }
    return;
  }

  if (msg.type === "ping") {
    send({ type: "pong" });
    return;
  }

  if (msg.type === "probe") {
    const r = await probeUrl(msg.url);
    send({ type: "probe-result", url: msg.url, ...r });
    return;
  }
}

module.exports = { handleWsMessage };
