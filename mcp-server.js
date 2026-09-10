#!/usr/bin/env node
// deepgrab-mcp-server — MCP (Model Context Protocol) stdio server for the
// Deep Grab desktop app. Speaks the app's documented WS bridge protocol
// (docs/ws-protocol.md) as a second client adapter alongside the extension:
//
//   MCP client  ←stdio/JSON-RPC→  mcp-server.js  ←ws://127.0.0.1:8765→  app
//
// Tools: deepgrab_ping, deepgrab_download, deepgrab_probe, deepgrab_status.
// Plain Node (CommonJS) on purpose — this repo has no bundler/build step and
// the only dependency (ws) is already in package.json. Logging goes to stderr
// only; stdout carries the JSON-RPC transport.
//
// Protocol notes that shape the toolset:
//  - The app does NOT dump the queue on connect; `status` pushes are only
//    broadcast for items while they update. So deepgrab_status reports exactly
//    the items this server observed on its own connection — that limitation is
//    stated in the tool description rather than hidden.
//  - Every reply carries the request's reqId (accepted/error/pong/probe-result)
//    and is a structured envelope on failure (code/message/retryable/retryAfter).
//    Errors surface to the MCP client as tool results with isError: true plus
//    an actionable next step (start the app, wait retryAfter seconds, ...).
"use strict";

const readline = require("readline");
const WebSocket = require("ws");

const WS_URL = process.env.DEEP_GRAB_WS_URL || "ws://127.0.0.1:8765";
const SERVER_INFO = { name: "deepgrab-mcp-server", version: "1.0.0" };
const MCP_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const REQUEST_TIMEOUT_MS = 30000;
const MAX_WAIT_SEC = 1800;
const TERMINAL_STATES = new Set(["done", "error", "duplicate", "cancelled"]);

// ---------------------------------------------------------------------------
// WS bridge client (docs/ws-protocol.md is the contract)
// ---------------------------------------------------------------------------

class BridgeError extends Error {
  constructor(message, { code = "BRIDGE_UNREACHABLE", retryable = false, retryAfter = undefined, data = undefined } = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
    this.data = data;
  }
}

class Bridge {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.connecting = null;
    this.appHello = null;
    this.reqCounter = 0;
    this.pending = new Map(); // reqId -> { resolve, reject, timer }
    this.items = new Map(); // item id -> last status push (session-observed)
  }

  nextReqId() {
    this.reqCounter += 1;
    return "mcp-" + this.reqCounter + "-" + Date.now().toString(36);
  }

  ensureConnected() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.connecting = null;
        try { ws.close(); } catch (e) { /* ignore */ }
        reject(new BridgeError(
          "Cannot reach Deep Video Downloader at " + this.url + " — start the desktop app (npm start) or set DEEP_GRAB_WS_URL to its bridge URL.",
          { code: "BRIDGE_UNREACHABLE" }
        ));
      };
      ws.on("open", () => {
        if (settled) return;
        settled = true;
        this.ws = ws;
        this.connecting = null;
        ws.on("message", (data) => this.onMessage(data));
        ws.on("close", () => this.onClose());
        ws.on("error", () => { /* close follows; pendings rejected there */ });
        try { ws.send(JSON.stringify({ type: "hello", v: SERVER_INFO.version, protocolVersion: 1 })); } catch (e) { /* ignore */ }
        resolve();
      });
      ws.on("error", fail);
      setTimeout(() => fail(new Error("connect timeout")), 5000).unref();
    });
    return this.connecting;
  }

  onClose() {
    this.ws = null;
    this.appHello = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BridgeError(
        "The bridge connection closed mid-request — the app may have quit. Retry; this server reconnects on demand.",
        { code: "BRIDGE_CLOSED", retryable: true }
      ));
    }
    this.pending.clear();
  }

  onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "hello") {
      this.appHello = { version: msg.version, protocolVersion: msg.protocolVersion, port: msg.port };
      return;
    }
    if (msg.type === "status" && msg.id) {
      this.items.set(msg.id, msg);
      return;
    }
    if (msg.reqId != null && this.pending.has(msg.reqId)) {
      const p = this.pending.get(msg.reqId);
      this.pending.delete(msg.reqId);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }

  async request(type, payload = {}, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    await this.ensureConnected();
    const reqId = this.nextReqId();
    const frame = Object.assign({ type, reqId }, payload);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new BridgeError(
          "Timed out after " + Math.round(timeoutMs / 1000) + "s waiting for a " + type + " reply from the app. Is Deep Video Downloader responsive?",
          { code: "BRIDGE_TIMEOUT", retryable: true }
        ));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(frame));
      } catch (e) {
        this.pending.delete(reqId);
        clearTimeout(timer);
        reject(new BridgeError("Failed to send " + type + " to the app bridge: " + e.message, { code: "BRIDGE_CLOSED", retryable: true }));
      }
    });
  }

  /** Enqueue and, when wait is true, await the item's terminal status push. */
  async download({ url, title, referer, cookieHeader, wait = false, waitTimeoutSec = 120 }) {
    const payload = { url };
    if (title) payload.title = title;
    if (referer) payload.referer = referer;
    if (cookieHeader) payload.cookieHeader = cookieHeader;
    const reply = await this.request("download", payload);
    if (reply.type === "error") throw this.envelopeToError(reply);
    const ids = Array.isArray(reply.ids) && reply.ids.length ? reply.ids : (reply.id ? [reply.id] : []);
    const result = { accepted: true, id: reply.id || ids[0] || null, ids, url: reply.url || url };
    if (!wait) return result;
    const deadline = Date.now() + Math.min(Math.max(waitTimeoutSec, 1), MAX_WAIT_SEC) * 1000;
    while (Date.now() < deadline) {
      const last = ids.length ? ids.map((id) => this.items.get(id)).find(Boolean) : null;
      if (last && TERMINAL_STATES.has(last.status)) return Object.assign(result, { finalStatus: summarizeStatus(last) });
      await delay(200);
    }
    throw new BridgeError(
      "Download " + (result.id || "") + " was accepted but did not reach a terminal state within " + waitTimeoutSec + "s. It is still in the queue — poll with deepgrab_status.",
      { code: "WAIT_TIMEOUT", retryable: true }
    );
  }

  async probe(url) {
    const reply = await this.request("probe", { url });
    if (reply.type === "error") throw this.envelopeToError(reply);
    return { url: reply.url || url, ok: !!reply.ok, size: reply.size, mime: reply.mime, error: reply.error || "" };
  }

  async ping() {
    const reply = await this.request("ping", {});
    if (reply.type !== "pong") throw this.envelopeToError(reply);
    return { app: this.appHello || {}, port: this.appHello ? this.appHello.port : null };
  }

  envelopeToError(reply) {
    const parts = ["Deep Grab bridge error: " + (reply.message || reply.code || "unknown")];
    if (reply.code === "PACE_LIMITED" && reply.retryAfter) parts.push("The app's crawl throttle is pacing requests — wait " + reply.retryAfter + "s and retry.");
    if (reply.code === "NO_USABLE_SOURCE") parts.push("Send a direct video URL or a player-page URL via deepgrab_download.");
    if (reply.code === "PROTOCOL_MISMATCH") parts.push("This MCP server speaks the app's protocol v" + (this.appHello ? this.appHello.protocolVersion : "?") + " — update Deep Video Downloader.");
    return new BridgeError(parts.join(" "), {
      code: reply.code || "INTERNAL",
      retryable: !!reply.retryable,
      retryAfter: reply.retryAfter,
      data: { url: reply.url || "" },
    });
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeStatus(s) {
  return {
    id: s.id, url: s.url, fileName: s.fileName || "", status: s.status,
    progress: s.progress, received: s.received, total: s.total, speed: s.speed,
    error: s.error || "", errorCode: s.errorCode || "", errorStatus: s.errorStatus || 0,
    retryable: !!s.retryable, finalPath: s.finalPath || "",
  };
}

// ---------------------------------------------------------------------------
// Tool definitions (JSON Schema; Zod is not used — see header note)
// ---------------------------------------------------------------------------

const responseFormatSchema = {
  type: "string", enum: ["markdown", "json"], default: "markdown",
  description: "'markdown' for human-readable output, 'json' for machine-readable structured output.",
};

const TOOLS = [
  {
    name: "deepgrab_ping",
    title: "Check the Deep Grab app bridge",
    description: `Check that the Deep Video Downloader desktop app is running and answering on its local WebSocket bridge.

Returns:
  {
    "app":     { "version": "1.0.0", "protocolVersion": 1, "port": 8765 },
    "ok": true
  }

Examples:
  - Use before any other deepgrab tool to confirm the app is up.
  - Use to discover the app's bridge port when DEEP_GRAB_WS_URL is unset.

Error Handling:
  - Returns "Cannot reach Deep Video Downloader at ws://127.0.0.1:8765 — start the desktop app (npm start) or set DEEP_GRAB_WS_URL..." when the app is not running.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(_args, bridge) {
      const out = await bridge.ping();
      return {
        content: [{ type: "text", text: "Deep Grab app is up: version " + (out.app.version || "unknown") + ", bridge port " + (out.port ?? "?") + ", protocol v" + (out.app.protocolVersion ?? "?") + "." }],
        structuredContent: { ok: true, app: out.app, port: out.port },
      };
    },
  },
  {
    name: "deepgrab_download",
    title: "Enqueue a download in the Deep Grab app",
    description: `Enqueue a video URL into the Deep Video Downloader desktop app's download queue.

The URL may be a direct video file (mp4/m3u8/...) or a player page the app knows how to resolve. Optionally wait for the download to reach a terminal state (done/error/duplicate/cancelled) and get its final status in one call.

Args:
  - url (string, required): video file URL or player-page URL.
  - title (string, optional): display/file title; falls back to a URL-derived name.
  - referer (string, optional): page that produced the URL (used for cookies/refresh).
  - cookieHeader (string, optional): "a=b; c=d"; gathered by the app when omitted.
  - wait (boolean, optional, default false): also wait for the terminal status.
  - waitTimeoutSec (number, optional, default 120, max 1800): how long to wait when wait=true.

Returns (wait=false): { "accepted": true, "id": "dl-…", "ids": ["dl-…"], "url": "…" }
Returns (wait=true): the fields above plus "finalStatus": { status, progress, fileName, error, errorCode, retryable, finalPath, ... }

Examples:
  - "Download this video" -> deepgrab_download { url: "https://…/video.mp4", wait: true, waitTimeoutSec: 600 }
  - "Queue these and move on" -> deepgrab_download { url: "…" } (no wait), then deepgrab_status later.

Error Handling:
  - PACE_LIMITED (retryable, retryAfter: 60): the app's crawl throttle refused the request — wait and retry.
  - NO_USABLE_SOURCE / ENQUEUE_FAILED: the URL was not usable; try a direct video URL.
  - WAIT_TIMEOUT: accepted but not finished in time; the item stays queued — poll deepgrab_status.`,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Video file URL or player-page URL to enqueue." },
        title: { type: "string", description: "Optional display/file title." },
        referer: { type: "string", description: "Optional page URL that produced the download." },
        cookieHeader: { type: "string", description: "Optional cookie header; gathered by the app when omitted." },
        wait: { type: "boolean", default: false, description: "Wait for a terminal state before returning." },
        waitTimeoutSec: { type: "number", default: 120, minimum: 1, maximum: 1800, description: "Max seconds to wait when wait=true." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(args, bridge) {
      const out = await bridge.download(args);
      const text = out.finalStatus
        ? "Download " + out.id + " finished: " + out.finalStatus.status + (out.finalStatus.fileName ? " as " + out.finalStatus.fileName : "") + (out.finalStatus.error ? " (" + out.finalStatus.error + ")" : "")
        : "Enqueued " + out.url + " as item " + out.id + ".";
      return { content: [{ type: "text", text }], structuredContent: out };
    },
  },
  {
    name: "deepgrab_probe",
    title: "Probe a URL through the Deep Grab app",
    description: `HEAD-probe a URL through the Deep Video Downloader app to learn its size and MIME type without enqueueing anything.

Returns:
  { "url": "https://…", "ok": true, "size": 102400, "mime": "video/mp4", "error": "" }

Examples:
  - Check whether a link is actually a video and how big it is before queueing it.
  - Compare two candidate mirrors by size before choosing one for deepgrab_download.

Error Handling:
  - ok=false carries the app's probe error string (e.g. 404, timeout, not video).`,
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL to probe." } },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args, bridge) {
      const out = await bridge.probe(args.url);
      const text = out.ok
        ? out.url + " → " + out.mime + ", " + (out.size != null ? Math.round(out.size / 1024) + " KB" : "unknown size")
        : out.url + " → probe failed: " + (out.error || "unknown reason");
      return { content: [{ type: "text", text }], structuredContent: out };
    },
  },
  {
    name: "deepgrab_status",
    title: "List downloads observed on this session",
    description: `List the Deep Grab downloads this server has observed status pushes for since it connected to the app, newest-first by default.

IMPORTANT limitation (from the app's protocol): the app does not provide a full-queue dump over its bridge, so this tool only sees items that were enqueued or updated while THIS server connection was live. To observe a download, enqueue it with deepgrab_download (wait=false) first.

Args:
  - id (string, optional): return just this item's last observed status.
  - limit (number, optional, default 20, max 100): page size.
  - offset (number, optional, default 0): number of items to skip.
  - response_format ('markdown' | 'json', optional, default 'markdown').

Returns (json): { total, count, offset, items: [status…], has_more, next_offset? }
Each item: { id, url, fileName, status, progress, received, total, speed, error, errorCode, errorStatus, retryable }`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Optional item id to fetch." },
        limit: { type: "number", default: 20, minimum: 1, maximum: 100, description: "Page size." },
        offset: { type: "number", default: 0, minimum: 0, description: "Items to skip." },
        response_format: responseFormatSchema,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(args, bridge) {
      const all = Array.from(bridge.items.values()).reverse(); // newest push first
      if (args.id) {
        const it = bridge.items.get(args.id);
        if (!it) {
          return { content: [{ type: "text", text: "No observed status for item " + args.id + ". Only downloads seen on this connection are tracked — enqueue it with deepgrab_download first." }], isError: false };
        }
        return { content: [{ type: "text", text: JSON.stringify(summarizeStatus(it), null, 2) }], structuredContent: summarizeStatus(it) };
      }
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
      const offset = Math.max(args.offset ?? 0, 0);
      const page = all.slice(offset, offset + limit);
      const hasMore = all.length > offset + page.length;
      const payload = { total: all.length, count: page.length, offset, items: page.map(summarizeStatus), has_more: hasMore };
      if (hasMore) payload.next_offset = offset + page.length;
      let text;
      if (args.response_format === "json") {
        text = JSON.stringify(payload, null, 2);
      } else if (!page.length) {
        text = "No downloads observed yet on this connection. Enqueue one with deepgrab_download (wait=false); the app's bridge has no full-queue dump, so only items seen live are tracked.";
      } else {
        text = "Observed downloads (" + page.length + " of " + all.length + "):";
        for (const s of page.map(summarizeStatus)) {
          text += "\n- " + s.id + " · " + s.status + (s.progress != null ? " " + (s.progress * 100).toFixed(1) + "%" : "") + (s.fileName ? " · " + s.fileName : "") + (s.error ? " · " + s.error : "");
        }
      }
      return { content: [{ type: "text", text }], structuredContent: payload };
    },
  },
];

// ---------------------------------------------------------------------------
// MCP JSON-RPC over stdio (line-delimited)
// ---------------------------------------------------------------------------

const bridge = new Bridge(WS_URL);

function toolErrorResult(err) {
  const structured = { code: err.code || "INTERNAL", retryable: !!err.retryable };
  if (err.retryAfter != null) structured.retryAfter = err.retryAfter;
  if (err.data) structured.data = err.data;
  return {
    content: [{ type: "text", text: "Error: " + err.message }],
    structuredContent: structured,
    isError: true,
  };
}

async function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    const err = new BridgeError("Unknown tool '" + name + "'. Available: " + TOOLS.map((t) => t.name).join(", ") + ".", { code: "UNKNOWN_TOOL" });
    return toolErrorResult(err);
  }
  try {
    return await tool.run(args || {}, bridge);
  } catch (err) {
    return toolErrorResult(err);
  }
}

function toolManifest() {
  return TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== "2.0") return null;
  const { id, method, params } = msg;
  if (id == null) return null; // notification — nothing to answer
  if (method === "initialize") {
    const requested = params && params.protocolVersion;
    const version = MCP_PROTOCOLS.includes(requested) ? requested : MCP_PROTOCOLS[0];
    return rpcResult(id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: toolManifest() });
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    return rpcResult(id, await callTool(name, args));
  }
  if (method === "resources/list") return rpcResult(id, { resources: [] });
  if (method === "prompts/list") return rpcResult(id, { prompts: [] });
  return rpcError(id, -32601, "Method not found: " + method);
}

function logErr(...parts) {
  console.error("[deepgrab-mcp]", ...parts);
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const write = (obj) => {
    try { process.stdout.write(JSON.stringify(obj) + "\n"); } catch (e) { /* client gone */ }
  };
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (e) {
      logErr("ignoring non-JSON line:", trimmed.slice(0, 80));
      return;
    }
    handleMessage(msg)
      .then((out) => { if (out) write(out); })
      .catch((err) => {
        logErr("handler error:", err && err.stack || err);
        if (msg && msg.id != null) write(rpcError(msg.id, -32603, "Internal error: " + (err && err.message || String(err))));
      });
  });
  rl.on("close", () => {
    if (bridge.ws) { try { bridge.ws.close(); } catch (e) { /* ignore */ } }
    process.exit(0);
  });
  logErr("deepgrab-mcp-server ready; bridge:", WS_URL);
}

if (require.main === module) main();

module.exports = { Bridge, BridgeError, summarizeStatus, TOOLS, MCP_PROTOCOLS, TERMINAL_STATES, _internal: { handleMessage, toolErrorResult } };
