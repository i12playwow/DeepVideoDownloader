#!/usr/bin/env node
// NewTV catalog bridge — Deep Grab → NewTV.
//
// Connects as a native loopback client to the Deep Grab WS bridge
// (docs/ws-protocol.md §1.2: Origin-less connections are the documented
// native-client seam) and relays terminal status pushes to the NewTV desktop
// app's import endpoint, so downloads land in NewTV's pending import queue —
// `done` relays as a normal entry; `error` ALSO relays as a flagged entry
// ("Deep Grab FAILED [code] message" in the Source field the pending panel
// shows; identical error echoes dedupe, a different message re-flags, and a
// later done for the same movie refreshes the row clean via ImportServer's
// FirstMeaningful coalesce). On NewTV's next scan, PendingImporter matches
// them to scanned library entries by token-set title (TitleMatcher.Matches).
//
// Title rule: NewTV's scanner derives a movie's library title from the file
// name, and matching is token-set equality — so the title sent here is
// derived from the finished download's fileName the same way, NOT from the
// page URL or extension label, or the import would never match the scanned
// file. Any year token (19xx/20xx) found in the name is stripped from the
// title and sent as `year`, because TitleMatcher requires years to agree
// when both sides carry one.
//
// Zero new dependencies: `ws` is already a dependency of this project.
//
// Env / args (all optional):
//   DEEPGRAB_WS_URL / --deepgrab-ws   default ws://127.0.0.1:8765
//   NEWTV_IMPORT_URL / --newtv-url    default http://127.0.0.1:5050/api/import
//   NEWTV_BRIDGE_MIN_MB / --min-mb    skip "done" pushes below this size (0 = off)
//
// Port discovery: when the import URL is left at its default, the bridge
// discovers the desktop app's port instead of pinning 5050 — the app binds
// 5050 when free, else the next free neighbor up to 5059, and /ping answers
// { status:"ok", app:"NewTV", port }. Discovery scans the candidate range
// (override with NEWTV_PORTS / --newtv-ports) and trusts only NewTV-signed
// pings, so a foreign app on a candidate port is never mistaken for the app.
// A scan that finds nothing LOGS the candidate ports it actually probed
// (contiguous runs collapsed, so a sparse/comma spec keeps its real ports
// instead of a misleading first-last span) before the relay fails loudly —
// a mis-typed NEWTV_PORTS is then visible in the log, not silent.
// When NEWTV_IMPORT_URL/--newtv-url IS set explicitly the behavior is exactly
// as before: that URL is pinned, no pinging, no scanning (tests rely on it).
//
// Run: node scripts/newtv-catalog-bridge.js
"use strict";

const path = require("path");
const WebSocket = require("ws");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 2) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (a.startsWith("--")) {
      out[a.slice(2)] = argv[++i] ?? "";
    }
  }
  return out;
}

/** Parse a port spec: "5050" → [5050]; "5050-5052" → [5050,5051,5052];
 * "5050, 5060-5061" → [5050,5060,5061]. Invalid tokens are skipped; an
 * empty/invalid spec yields []. Hoisted use above (NEWTV_PORTS) is safe. */
function parsePortSpec(spec) {
  const ports = [];
  for (const part of String(spec || "").split(",")) {
    const m = part.trim().match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
    if (!m) continue;
    const lo = parseInt(m[1], 10);
    const hi = m[2] ? parseInt(m[2], 10) : lo;
    if (hi < lo || hi - lo > 999) continue; // sanity bounds
    for (let p = lo; p <= hi; p++) ports.push(p);
  }
  return ports;
}

/** Render a candidate port set the way it was actually probed: ascending,
 * deduped, with contiguous runs collapsed to `lo-hi`. The default 5050-5059
 * still reads as a range, while a comma/sparse spec keeps its real ports
 * ("5050, 52841-52844, 63417") instead of the first-last span, which would
 * name ports nothing ever scans. Used by the startup banner, the discovery
 * failure log, and the not-found errors. */
function describePorts(ports) {
  const uniq = [...new Set(Array.isArray(ports) ? ports : [])].sort((a, b) => a - b);
  if (uniq.length === 0) return "(none)";
  const out = [];
  let start = uniq[0];
  let prev = uniq[0];
  for (const p of uniq.slice(1)) {
    if (p === prev + 1) { prev = p; continue; }
    out.push(start === prev ? String(start) : `${start}-${prev}`);
    start = p;
    prev = p;
  }
  out.push(start === prev ? String(start) : `${start}-${prev}`);
  return out.join(", ");
}

const args = parseArgs(process.argv.slice(2));
const DEEPGRAB_WS_URL = args["deepgrab-ws"] || process.env.DEEPGRAB_WS_URL || "ws://127.0.0.1:8765";
const NEWTV_IMPORT_URL = args["newtv-url"] || process.env.NEWTV_IMPORT_URL || "http://127.0.0.1:5050/api/import";
// Watched-folder endpoint (POST {path}, origin-less only). When NEWTV_BASE is
// set explicitly it must include the trailing base (e.g. http://127.0.0.1:5050/);
// otherwise it is derived from NEWTV_IMPORT_URL by stripping /api/import.
const NEWTV_BASE = args["newtv-base"] || process.env.NEWTV_BASE || NEWTV_IMPORT_URL.replace(/api\/import\/?$/, "");
// Discovery is ACTIVE only when the import URL was NOT explicitly configured
// (the default value means "no opinion" — pin whatever the user set).
const NEWTV_URL_PINNED = args["newtv-url"] != null || process.env.NEWTV_IMPORT_URL != null;
const NEWTV_PORTS_ARG = args["newtv-ports"] || process.env.NEWTV_PORTS || "";
const NEWTV_PORTS = parsePortSpec(NEWTV_PORTS_ARG || "5050-5059");
const NEWTV_FOLDERS_URL = NEWTV_BASE + (NEWTV_BASE.endsWith("/") ? "" : "/") + "api/watched-folders";
// Auto-watch is on by default; disabled by the --no-auto-watch flag (any
// value/none) or NEWTV_NO_AUTO_WATCH=1|true|yes in the environment.
const AUTO_WATCH = !("no-auto-watch" in args || /^(1|true|yes)$/i.test(process.env.NEWTV_NO_AUTO_WATCH || ""));
const MIN_MB = Number(args["min-mb"] || process.env.NEWTV_BRIDGE_MIN_MB || 0) || 0;

// ---------------------------------------------------------------------------
// Pure core (exported for the contract test)
// ---------------------------------------------------------------------------

/** Deep Grab status strings that mean "no more progress pushes will come". */
const TERMINAL_STATES = new Set(["done", "error", "duplicate", "cancelled"]);

/**
 * Derive the NewTV import payload from a Deep Grab `done` status push.
 * Returns null when the push carries nothing catalog-worthy (no file name).
 *
 * Mirrors NewTV's scanner-side title derivation contract: token-set title,
 * trailing year token pulled out as `year`.
 */
function statusToImportPayload(st) {
  const base = (st.fileName || "").trim() || "";
  if (!base) return null;
  let title = base.replace(/\.[a-z0-9]{1,5}$/i, "");
  let year = null;
  // (?![xX][0-9]) keeps "1920x1080"-style resolutions from masquerading as
  // a year; (?![pP]) keeps "2160p"-style tags out too.
  const ym = title.match(/(?:^|[^0-9])((?:19|20)\d{2})(?![0-9])(?![xX][0-9])(?![pP])/);
  if (ym) {
    year = parseInt(ym[1], 10);
    // ym[0] spans separator+year (^-anchored matches have no separator), so
    // dropping the whole match span leaves the surrounding text intact.
    title = (title.slice(0, ym.index) + title.slice(ym.index + ym[0].length))
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  const payload = {
    title,
    source: "Deep Grab (newtv-catalog-bridge)",
    year: year === null ? undefined : year,
  };
  if (typeof st.finalPath === "string" && st.finalPath) payload.filePath = st.finalPath;
  if (Number.isFinite(st.total) && st.total > 0) payload.sizeBytes = st.total;
  if (typeof st.url === "string" && st.url) payload.sourceUrl = st.url;
  if (typeof st.referer === "string" && st.referer) payload.referer = st.referer;
  return payload;
}

/** Gate: should this terminal status push be relayed to NewTV as a success? */
function shouldRelay(st, minMb) {
  if (!st || typeof st !== "object") return false;
  if (!TERMINAL_STATES.has(st.status)) return false;
  if (st.status !== "done") return false; // only finished downloads are catalog-worthy
  if (!(st.fileName || "").trim()) return false;
  if (minMb > 0) {
    const mb = (Number(st.total) || 0) / (1024 * 1024);
    if (mb > 0 && mb < minMb) return false;
  }
  return true;
}

/**
 * What the runtime should do with a status push:
 *   "done"  → relay as a successful import
 *   "error" → relay as a flagged failure entry (visible in NewTV's pending
 *             panel; a later done for the same movie refreshes the same row
 *             with a clean source via ImportServer's FirstMeaningful coalesce)
 *   null    → ignore (running/queued/scheduled, duplicate/cancelled — user
 *             benign —, no fileName, or a success below the min-mb gate)
 * min-mb gates successes only: failed downloads rarely know their total size.
 */
function classifyRelay(st, minMb) {
  if (!st || typeof st !== "object") return null;
  if (st.status === "done") return shouldRelay(st, minMb) ? "done" : null;
  if (st.status === "error") return (st.fileName || "").trim() ? "error" : null;
  return null;
}

/** Flagged Source string for a failed download — shown in NewTV's pending
 * meta line ("Year · Studio · Source"). Kept one-line and bounded. */
function failureSource(st) {
  const code = typeof st.errorCode === "string" && st.errorCode ? `[${st.errorCode}] ` : "";
  const msg = String(st.error || "unknown error").replace(/\s+/g, " ").trim().slice(0, 100);
  return `Deep Grab FAILED ${code}${msg}`;
}

/** The Source string sent to NewTV: the Deep Grab marker (plain or FAILED)
 * plus the page the download came from (referer, falling back to the media
 * URL), so the URL coalesces onto the library movie's Source — the same field
 * NewTV's detail view renders and RegionDetector reads (a JAV host in the URL
 * correctly lands the movie in Japan). Total capped at 220 chars.
 * ImportServer identifies bridge rows by the "Deep Grab" prefix and flagged
 * rows by the "FAILED" substring, so both markers must stay leading. */
const SOURCE_CAP = 220;
function composeSource(st, action) {
  const base = action === "error" ? failureSource(st) : "Deep Grab (newtv-catalog-bridge)";
  const url = typeof st.referer === "string" && st.referer ? st.referer
    : typeof st.url === "string" ? st.url : "";
  if (!url) return base;
  const suffix = " · " + url.trim();
  return base + (base.length + suffix.length > SOURCE_CAP
    ? suffix.slice(0, SOURCE_CAP - base.length)
    : suffix);
}

/** Split "C:\dir\base name [2020].mp4" into dir + fileName; "" dir when absent. */
function splitPath(p) {
  if (typeof p !== "string" || !p) return { dir: "", fileName: "" };
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? { dir: p.slice(0, i), fileName: p.slice(i + 1) } : { dir: "", fileName: p };
}

/** True when the directory differs from every already-watched folder
 * (Windows-style case-insensitive compare — the AppHost runs on Windows). */
function isNewWatchedFolder(dir, watched) {
  return !watched.some((w) => String(w).toLowerCase() === String(dir).toLowerCase());
}

module.exports = { TERMINAL_STATES, statusToImportPayload, shouldRelay, classifyRelay, failureSource, composeSource, splitPath, isNewWatchedFolder, parseArgs, parsePortSpec, describePorts };

// ---------------------------------------------------------------------------
// Runtime (only when executed directly — the contract test requires the core)
// ---------------------------------------------------------------------------

if (require.main === module) {
  const log = (...m) => console.log(`[newtv-bridge] ${new Date().toISOString()} ${m.join(" ")}`);

  log(
    `deepgrab ${DEEPGRAB_WS_URL} → newtv ${NEWTV_URL_PINNED ? NEWTV_IMPORT_URL : `discover ${describePorts(NEWTV_PORTS)}`}${MIN_MB ? ` (min ${MIN_MB} MB)` : ""}`
  );

  // ---- NewTV endpoint resolution (discovery / pinned) ---------------------
  // Pinned mode (NEWTV_IMPORT_URL set): NEWTV_BASE is used as-is, no pinging.
  // Discovery mode (default): scan candidate ports for a /ping that answers
  // { app: "NewTV" }, cache it, and re-scan once on a connection failure so
  // an app that moved ports (or came back on another one) heals transparently.
  let newtvBase = NEWTV_BASE; // authoritative base URL, set by discovery
  let resolved = NEWTV_URL_PINNED; // pinned mode needs no scan
  let resolving = null; // in-flight scan promise (single-flight)

  async function pingNewtvPort(port) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(2500) });
      const body = await res.json().catch(() => null);
      return body && body.app === "NewTV" ? port : null;
    } catch (e) {
      return null;
    }
  }

  async function scanNewtvPorts() {
    const results = await Promise.all(NEWTV_PORTS.map(pingNewtvPort));
    const found = results.find((p) => p !== null && p !== undefined);
    if (found != null) {
      newtvBase = `http://127.0.0.1:${found}/`;
      log(`NewTV discovered on port ${found}`);
    } else {
      // Name the candidates this scan really probed, so a failure is
      // diagnosable from the log alone — an empty or mis-typed NEWTV_PORTS must
      // not look like "the app is down". (Every retry that re-scans logs its
      // own line, paired 1:1 with the relay's "import failed".)
      log(`NewTV not found — scanned ${describePorts(NEWTV_PORTS)} (no /ping answered app:"NewTV")`);
    }
    resolved = found != null;
    return resolved;
  }

  /** Resolve the base URL before a request: join/launch the single-flight
   * scan in discovery mode; no-op once resolved (or when pinned). */
  async function ensureNewtvBase() {
    if (resolved && !resolving) return;
    if (!resolving) resolving = scanNewtvPorts();
    try {
      await resolving;
    } finally {
      resolving = null;
    }
  }

  /** fetch against the NewTV base with one-shot re-resolution on failure:
   * a connection error means the cached port is stale — rescan once, retry
   * once, so port moves heal without dropping the relay. HTTP-level errors
   * (4xx/5xx) do NOT rescan: the app answered, so the endpoint is right.
   * When discovery finds NOTHING, throw — never fall through to the default
   * 5050 base, which would silently fire relays at whatever lives there (or
   * at nothing, while believing the relay was aimed at a discovered app). */
  async function fetchNewtv(path, options = {}) {
    await ensureNewtvBase();
    if (!resolved) throw new Error(`NewTV not found (scanned ${describePorts(NEWTV_PORTS)})`);
    try {
      return await fetch(newtvBase + path, options);
    } catch (e) {
      // Pinned mode means PINNED: the configured URL is authoritative, so a
      // connection failure must surface ("import failed" log) — never a scan
      // that could silently redirect relays to some other NewTV on loopback.
      if (NEWTV_URL_PINNED || resolving) throw e;
      resolving = scanNewtvPorts();
      try {
        await resolving;
      } finally {
        resolving = null;
      }
      if (!resolved) throw new Error(`NewTV not found after rescan (scanned ${describePorts(NEWTV_PORTS)})`);
      return fetch(newtvBase + path, options);
    }
  }

  // ---- NewTV HTTP (plain POST/GET) ---------------------------------------
  async function importToNewtv(payload) {
    const res = await fetchNewtv("api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`NewTV import failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  async function getWatchedFolders() {
    try {
      const res = await fetchNewtv("api/watched-folders");
      if (!res.ok) return null;
      const list = await res.json();
      return Array.isArray(list) ? list : null;
    } catch (e) {
      return null; // NewTV down/old — auto-watch silently skipped
    }
  }

  async function addWatchedFolder(dir) {
    const res = await fetchNewtv("api/watched-folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dir }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`NewTV watched-folder add failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  // ---- WS client (per docs/ws-protocol.md) --------------------------------
  let reqSeq = 0;
  const seen = new Set(); // `${id}:${status}:${finalPath}` — terminal pushes repeat on every resync

  function connect() {
    const ws = new WebSocket(DEEPGRAB_WS_URL, { handshakeTimeout: 8000 });
    let helloed = false;

    ws.on("open", () => {
      helloed = true;
      ws.send(JSON.stringify({ type: "hello", v: "1.0.0", protocolVersion: 1 }));
      log(`connected to Deep Grab at ${DEEPGRAB_WS_URL}`);
    });

    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type !== "status") return;
      const action = classifyRelay(msg, MIN_MB);
      if (!action) return;
      // Successes dedupe on the item's terminal identity (resync echoes repeat
      // them); failures dedupe per error message — a NEW message for the same
      // item re-flags the row, and NewTV's import dedupe coalesces the rows.
      const dedupeKey = action === "error"
        ? `${msg.id}:error:${msg.error || msg.errorCode || ""}`
        : `${msg.id}:${msg.status}:${msg.finalPath || msg.fileName}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      const payload = statusToImportPayload(msg);
      if (!payload) return;
      payload.source = composeSource(msg, action);
      importToNewtv(payload)
        .then(async (r) => {
          log(`→ NewTV queued "${payload.title}"${action === "error" ? " [FAILED]" : ""}${r && r.duplicate ? " (refreshed existing)" : ""}`);
          // Auto-watch: register the finished download's directory so NewTV's
          // next Scan indexes it without the user clicking Add Folder.
          if (AUTO_WATCH && payload.filePath) {
            const dir = splitPath(payload.filePath).dir;
            if (!dir) return;
            const watched = await getWatchedFolders();
            if (watched === null) return; // old NewTV / transient failure — skip quietly
            if (!isNewWatchedFolder(dir, watched)) return; // already watched
            addWatchedFolder(dir)
              .then((wr) => log(`→ NewTV watched folder ${wr && wr.added ? "added" : "already present"}: ${dir}`))
              .catch((e) => log(`watched-folder add failed: ${e.message}`));
          }
        })
        .catch((e) => {
          seen.delete(dedupeKey); // let a later resync retry it
          log(`import failed: ${e.message}`);
        });
    });

    ws.on("error", (e) => {
      if (helloed || e.code !== "ECONNREFUSED") log(`ws error: ${e.message}`);
    });

    ws.on("close", () => {
      if (helloed) log("disconnected — retrying in 5s");
      setTimeout(connect, 5000);
    });
  }

  connect();
}
