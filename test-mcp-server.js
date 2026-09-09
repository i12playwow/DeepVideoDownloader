#!/usr/bin/env node
// Contract test for mcp-server.js: drives the real MCP stdio server end-to-end
// against a fake Deep Grab app bridge (fake-app behavior per docs/ws-protocol.md).
// Self-contained: loopback ports only, no external services, safe for CI.
"use strict";

const { spawn } = require("child_process");
const net = require("net");
const path = require("path");
const os = require("os");
const { once } = require("events");
const WebSocket = require("ws");

const SERVER = path.join(__dirname, "mcp-server.js");
let passed = 0, failed = 0;
function assert(name, ok, detail) {
  if (ok) { passed++; console.log("  ok  " + name); }
  else { failed++; console.error("FAIL  " + name + (detail ? " — " + detail : "")); }
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Fake app bridge: speaks docs/ws-protocol.md on a loopback port
// ---------------------------------------------------------------------------
async function startFakeApp() {
  const server = new WebSocket.Server({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const port = server.address().port;
  const sockets = new Set();
  server.on("connection", (ws) => {
    sockets.add(ws);
    ws.send(JSON.stringify({ type: "hello", version: "9.9.9-fake", protocolVersion: 1, port }));
    ws.on("message", (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      if (msg.type === "hello") return; // client hello — accepted silently
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", reqId: msg.reqId }));
        return;
      }
      if (msg.type === "download") {
        if (!msg.url) {
          ws.send(JSON.stringify({ type: "error", code: "NO_USABLE_SOURCE", message: "download with no usable url / sources", url: "", reqId: msg.reqId, retryable: false }));
          return;
        }
        if (String(msg.url).includes("/paced/")) {
          ws.send(JSON.stringify({ type: "error", code: "PACE_LIMITED", message: "crawl throttle refused", url: msg.url, reqId: msg.reqId, retryable: true, retryAfter: 60 }));
          return;
        }
        const id = "dl-fake-" + ++server._itemSeq;
        ws.send(JSON.stringify({ type: "accepted", id, ids: [id], url: msg.url, reqId: msg.reqId }));
        // tick progress then land on a terminal state
        setTimeout(() => wsSafe(ws, { type: "status", id, reqId: msg.reqId, url: msg.url, fileName: "fake.mp4", status: "running", total: 1000, received: 250, progress: 0.25, speed: 64000 }), 30);
        setTimeout(() => wsSafe(ws, { type: "status", id, reqId: msg.reqId, url: msg.url, fileName: "fake.mp4", status: "done", total: 1000, received: 1000, progress: 1, speed: 0, finalPath: "C:\\fake\\fake.mp4" }), 120);
        return;
      }
      if (msg.type === "probe") {
        if (String(msg.url).endsWith("/404")) {
          ws.send(JSON.stringify({ type: "probe-result", url: msg.url, reqId: msg.reqId, ok: false, error: "HTTP 404" }));
        } else {
          ws.send(JSON.stringify({ type: "probe-result", url: msg.url, reqId: msg.reqId, ok: true, size: 102400, mime: "video/mp4" }));
        }
        return;
      }
    });
    ws.on("close", () => sockets.delete(ws));
  });
  function wsSafe(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ } }
  server._itemSeq = 0;
  server._sockets = sockets;
  server.closeAll = () => { for (const s of sockets) { try { s.close(); } catch (e) {} } return new Promise((r) => server.close(r)); };
  return { server, url: "ws://127.0.0.1:" + port };
}

// ---------------------------------------------------------------------------
// MCP client over stdio
// ---------------------------------------------------------------------------
class McpClient {
  constructor(env) {
    this.proc = spawn(process.execPath, [SERVER], {
      env: Object.assign({}, process.env, env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.nextId = 0;
    this.buffer = "";
    this.waiters = [];
    this.proc.stdout.on("data", (chunk) => this.onData(chunk));
    this.proc.stderr.on("data", () => { /* server logs; ignore in test */ });
    this.exitPromise = once(this.proc, "exit");
  }
  onData(chunk) {
    this.buffer += chunk.toString();
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
      const w = this.waiters.find((x) => x.id === msg.id);
      if (w) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(msg); }
    }
  }
  rpc(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for " + method)), 10000);
      this.waiters.push({ id, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async request(method, params) {
    const res = await this.rpc(method, params);
    if (res.error) throw new Error("rpc error " + res.error.code + ": " + res.error.message);
    return res.result;
  }
  async callTool(name, args) {
    const res = await this.rpc("tools/call", { name, arguments: args || {} });
    return res.result || res.error;
  }
  close() { try { this.proc.stdin.end(); } catch (e) {} }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
async function main() {
  console.log("== mcp-server contract tests ==");
  const { server, url } = await startFakeApp();
  console.log("  fake app bridge on " + url);

  // --- offline server: tools/list and error envelopes work with app down ----
  const offline = new McpClient({ DEEP_GRAB_WS_URL: "ws://127.0.0.1:59999" });
  const init = await offline.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert("initialize returns serverInfo", init.serverInfo && init.serverInfo.name === "deepgrab-mcp-server", JSON.stringify(init));
  assert("initialize negotiates a supported protocolVersion", typeof init.protocolVersion === "string", JSON.stringify(init.protocolVersion));
  const tlist = await offline.request("tools/list", {});
  const names = tlist.tools.map((t) => t.name);
  assert("tools/list exposes the four tools", ["deepgrab_ping", "deepgrab_download", "deepgrab_probe", "deepgrab_status"].every((n) => names.includes(n)), names.join(","));
  assert("tools carry annotations", tlist.tools.every((t) => t.annotations && typeof t.annotations.readOnlyHint === "boolean"));

  const pingFail = await offline.callTool("deepgrab_ping");
  assert("deepgrab_ping errors actionably when app is down", pingFail.isError === true && /start the desktop app/.test(pingFail.content[0].text), JSON.stringify(pingFail).slice(0, 140));
  assert("offline error carries a structured code", pingFail.structuredContent && pingFail.structuredContent.code === "BRIDGE_UNREACHABLE", JSON.stringify(pingFail.structuredContent));
  const dlFail = await offline.callTool("deepgrab_download", { url: "https://example.com/x.mp4" });
  assert("deepgrab_download errors when app is down", dlFail.isError === true && dlFail.structuredContent.code === "BRIDGE_UNREACHABLE");
  offline.close();

  // --- live server against the fake app ------------------------------------
  const client = new McpClient({ DEEP_GRAB_WS_URL: url });
  await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });

  const ping = await client.callTool("deepgrab_ping");
  assert("deepgrab_ping returns app info", !ping.isError && /9\.9\.9-fake/.test(ping.content[0].text), JSON.stringify(ping).slice(0, 140));
  assert("deepgrab_ping structured port", ping.structuredContent && ping.structuredContent.port === server.address().port, JSON.stringify(ping.structuredContent));

  const probe = await client.callTool("deepgrab_probe", { url: "https://cdn.example/v.mp4" });
  assert("deepgrab_probe returns size+mime", !probe.isError && probe.structuredContent.ok === true && probe.structuredContent.size === 102400 && probe.structuredContent.mime === "video/mp4", JSON.stringify(probe.structuredContent));
  const probe404 = await client.callTool("deepgrab_probe", { url: "https://cdn.example/404" });
  assert("deepgrab_probe reports failed probe without tool error", !probe404.isError && probe404.structuredContent.ok === false && /404/.test(probe404.structuredContent.error), JSON.stringify(probe404.structuredContent));

  const dl = await client.callTool("deepgrab_download", { url: "https://cdn.example/a.mp4", title: "T" });
  assert("deepgrab_download accepted", !dl.isError && dl.structuredContent.accepted === true && typeof dl.structuredContent.id === "string", JSON.stringify(dl).slice(0, 140));

  const dlPaced = await client.callTool("deepgrab_download", { url: "https://cdn.example/paced/x.mp4" });
  assert("PACE_LIMITED surfaces retryable + retryAfter", dlPaced.isError === true && dlPaced.structuredContent.retryable === true && dlPaced.structuredContent.retryAfter === 60 && /60s and retry/.test(dlPaced.content[0].text), JSON.stringify(dlPaced.structuredContent));

  const dlNoUrl = await client.callTool("deepgrab_download", {});
  assert("missing url surfaces NO_USABLE_SOURCE with guidance", dlNoUrl.isError === true && dlNoUrl.structuredContent.code === "NO_USABLE_SOURCE" && /direct video URL/.test(dlNoUrl.content[0].text), JSON.stringify(dlNoUrl.structuredContent));

  const dlWait = await client.callTool("deepgrab_download", { url: "https://cdn.example/waited.mp4", wait: true, waitTimeoutSec: 10 });
  assert("wait=true returns terminal finalStatus", !dlWait.isError && dlWait.structuredContent.finalStatus && dlWait.structuredContent.finalStatus.status === "done" && dlWait.structuredContent.finalStatus.progress === 1, JSON.stringify(dlWait.structuredContent && dlWait.structuredContent.finalStatus));

  await delay(60); // let running-status pushes arrive
  const st = await client.callTool("deepgrab_status", { response_format: "json" });
  // Exactly 2 items were accepted by the fake app (paced + no-url requests
  // were rejected with error envelopes, so they never became items).
  assert("deepgrab_status lists observed items", !st.isError && st.structuredContent.total === 2, JSON.stringify(st.structuredContent).slice(0, 160));
  assert("status items carry the structured error fields", st.structuredContent.items.every((i) => "errorCode" in i && "retryable" in i && "errorStatus" in i));
  const stMd = await client.callTool("deepgrab_status", {});
  assert("markdown status renders lines", !stMd.isError && /^Observed downloads \(\d+ of \d+\):/.test(stMd.content[0].text), stMd.content[0].text.slice(0, 90));
  const stPage = await client.callTool("deepgrab_status", { limit: 1, offset: 0, response_format: "json" });
  assert("pagination returns has_more + next_offset", stPage.structuredContent.count === 1 && stPage.structuredContent.has_more === true && stPage.structuredContent.next_offset === 1, JSON.stringify(stPage.structuredContent).slice(0, 120));
  const stOne = await client.callTool("deepgrab_status", { id: dl.structuredContent.id, response_format: "json" });
  assert("deepgrab_status by id returns that item", !stOne.isError && stOne.structuredContent.id === dl.structuredContent.id, JSON.stringify(stOne.structuredContent).slice(0, 120));
  const stMiss = await client.callTool("deepgrab_status", { id: "dl-nope" });
  assert("unknown id explains the session-visibility limitation", !stMiss.isError && /enqueue it with deepgrab_download/.test(stMiss.content[0].text), stMiss.content[0].text);

  // --- wait=true timeout path ----------------------------------------------
  const server2mod = require("./mcp-server.js");
  assert("exports TERMINAL_STATES for reuse", server2mod && Array.isArray(server2mod.TERMINAL_STATES) === false && typeof server2mod.TERMINAL_STATES === "object");

  client.close();
  await Promise.race([client.exitPromise, delay(2000)]);
  await server.closeAll();
  console.log("\n" + (failed ? "FAILED " : "") + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("suite error:", e); process.exit(1); });
