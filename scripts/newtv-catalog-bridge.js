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

const args = parseArgs(process.argv.slice(2));
const DEEPGRAB_WS_URL = args["deepgrab-ws"] || process.env.DEEPGRAB_WS_URL || "ws://127.0.0.1:8765";
const NEWTV_IMPORT_URL = args["newtv-url"] || process.env.NEWTV_IMPORT_URL || "http://127.0.0.1:5050/api/import";
// Watched-folder endpoint (POST {path}, origin-less only). When NEWTV_BASE is
// set explicitly it must include the trailing base (e.g. http://127.0.0.1:5050/);
// otherwise it is derived from NEWTV_IMPORT_URL by stripping /api/import.
const NEWTV_BASE = args["newtv-base"] || process.env.NEWTV_BASE || NEWTV_IMPORT_URL.replace(/api\/import\/?$/, "");
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

module.exports = { TERMINAL_STATES, statusToImportPayload, shouldRelay, classifyRelay, failureSource, composeSource, splitPath, isNewWatchedFolder, parseArgs };

// ---------------------------------------------------------------------------
// Runtime (only when executed directly — the contract test requires the core)
// ---------------------------------------------------------------------------

if (require.main === module) {
  const log = (...m) => console.log(`[newtv-bridge] ${new Date().toISOString()} ${m.join(" ")}`);

  log(`deepgrab ${DEEPGRAB_WS_URL} → newtv ${NEWTV_IMPORT_URL}${MIN_MB ? ` (min ${MIN_MB} MB)` : ""}`);

  // ---- NewTV HTTP (plain POST/GET) ---------------------------------------
  async function importToNewtv(payload) {
    const res = await fetch(NEWTV_IMPORT_URL, {
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
      const res = await fetch(NEWTV_FOLDERS_URL);
      if (!res.ok) return null;
      const list = await res.json();
      return Array.isArray(list) ? list : null;
    } catch (e) {
      return null; // NewTV down/old — auto-watch silently skipped
    }
  }

  async function addWatchedFolder(dir) {
    const res = await fetch(NEWTV_FOLDERS_URL, {
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
