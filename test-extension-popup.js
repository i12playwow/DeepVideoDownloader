"use strict";

// Browser contract for the shipped extension action popup.  This uses a fresh
// Chrome for Testing profile, the manifest's real action popup (not popup.html
// as a tab), the production runtime-message boundary to seed found rows, and
// the production WebSocket status boundary to drive the presentation.
//
// Run: node test-extension-popup.js

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;

const ROOT = __dirname;
const CHROME_CANDIDATES = [
  process.env.CFT_CHROME,
  path.join(ROOT, ".freebuff", "xt-cft", "chrome-win64", process.platform === "win32" ? "chrome.exe" : "chrome"),
  path.join(ROOT, ".freebuff", "runner", "xt-cft", "chrome-win64", process.platform === "win32" ? "chrome.exe" : "chrome")
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((file) => fs.existsSync(file));

let passed = 0;
let failed = 0;
function assert(label, condition, detail) {
  if (condition) {
    passed++;
    console.log("  PASS  " + label);
  } else {
    failed++;
    console.log("  FAIL  " + label + (detail ? " -> " + detail : ""));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true;
    } catch (error) {}
    await sleep(intervalMs || 100);
  }
  return false;
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error("HTTP " + response.statusCode));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.setTimeout(5000, () => request.destroy(new Error("HTTP timeout")));
  });
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params, sessionId) {
    return this.ready.then(() => new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      const message = { id, method, params: params || {} };
      if (sessionId) message.sessionId = sessionId;
      this.socket.send(JSON.stringify(message));
    }));
  }

  close() { try { this.socket.close(); } catch (error) {} }
}

async function evaluateTarget(browser, targetId, expression, options) {
  const attached = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  try {
    const result = await browser.send("Runtime.evaluate", Object.assign({
      expression,
      awaitPromise: true,
      returnByValue: true
    }, options || {}), attached.sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception && result.exceptionDetails.exception.description || result.exceptionDetails.text || "evaluation failed");
    }
    return result.result && result.result.value;
  } finally {
    try { await browser.send("Target.detachFromTarget", { sessionId: attached.sessionId }); } catch (error) {}
  }
}

function startFixture() {
  const hits = new Set();
  const server = http.createServer((request, response) => {
    const pathname = (request.url || "").split("?")[0];
    if (pathname === "/fixture.html") {
      const body = `<!doctype html><html><head><meta charset="utf-8"><title>popup status fixture</title></head><body>
        <video src="/media/retryable.mp4" autoplay muted preload="auto"></video>
        <video src="/media/terminal.mp4" autoplay muted preload="auto"></video>
        <script>
          Promise.all([
            fetch('/media/retryable.mp4').then((r) => r.arrayBuffer()),
            fetch('/media/terminal.mp4').then((r) => r.arrayBuffer())
          ]).catch(() => {});
        </script>
      </body></html>`;
      response.writeHead(200, { "Content-Type": "text/html", "Content-Length": Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    const media = /^\/media\/(retryable|terminal)\.mp4$/.exec(pathname);
    if (media) {
      hits.add(pathname);
      const body = Buffer.from("popup-status-fixture-" + media[1]);
      response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": body.length, "Accept-Ranges": "bytes" });
      response.end(body);
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, hits })));
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGTERM");
  } catch (error) {}
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

function readDevToolsPort(profile) {
  try {
    const port = parseInt(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/)[0], 10);
    return Number.isInteger(port) && port > 0 ? port : 0;
  } catch (error) {
    return 0;
  }
}

async function main() {
  console.log("\n=== extension action-popup error presentation (Chrome) ===\n");
  if (!CHROME) {
    console.log("  SKIP  Chrome for Testing not found (set CFT_CHROME to run the browser contract)");
    return 0;
  }

  let fixture;
  let wsServer;
  let browser;
  let popupCdp;
  let chrome;
  let tempRoot;
  let output = "";
  const sockets = new Set();
  const helloSockets = new Set();
  try {
    fixture = await startFixture();
    wsServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    wsServer.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("message", (data) => {
        let message;
        try { message = JSON.parse(data.toString()); } catch (error) { return; }
        if (message.type === "hello") helloSockets.add(socket);
        if (message.type === "probe" && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "probe-result", reqId: message.reqId || "", url: message.url, size: 64 }));
        }
      });
    });
    await new Promise((resolve) => wsServer.once("listening", resolve));
    const wsPort = wsServer.address().port;

    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dv-popup-browser-"));
    const extension = path.join(tempRoot, "extension");
    const profile = path.join(tempRoot, "profile");
    fs.cpSync(path.join(ROOT, "extension"), extension, { recursive: true });
    const backgroundPath = path.join(extension, "background.js");
    fs.writeFileSync(backgroundPath, fs.readFileSync(backgroundPath, "utf8").replace(
      '"ws://127.0.0.1:8765"', '"ws://127.0.0.1:' + wsPort + '"'
    ));

    chrome = spawn(CHROME, [
      "--user-data-dir=" + profile,
      "--load-extension=" + extension,
      "--disable-extensions-except=" + extension,
      "--enable-unsafe-extension-debugging",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-component-update",
      "--remote-debugging-port=0",
      "about:blank"
    ], { cwd: ROOT, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    chrome.stdout.on("data", (data) => { output += data.toString(); });
    chrome.stderr.on("data", (data) => { output += data.toString(); });

    const cdpPort = await waitFor(async () => {
      const port = readDevToolsPort(profile);
      if (!port) return false;
      try { await httpJson("http://127.0.0.1:" + port + "/json/version"); return true; } catch (error) { return false; }
    }, 15000, 150).then(() => readDevToolsPort(profile));
    if (!cdpPort) throw new Error("Chrome DevTools did not start: " + output.slice(-800));
    const version = await httpJson("http://127.0.0.1:" + cdpPort + "/json/version");
    browser = new Cdp(version.webSocketDebuggerUrl);

    const fixtureUrl = "http://127.0.0.1:" + fixture.port + "/fixture.html";
    const fixtureTargetId = (await browser.send("Target.createTarget", { url: fixtureUrl })).targetId;
    await browser.send("Target.activateTarget", { targetId: fixtureTargetId });
    await sleep(500);

    const worker = { value: null };
    const workerReady = await waitFor(async () => {
      const targets = (await browser.send("Target.getTargets")).targetInfos;
      for (const target of targets) {
        if (target.type !== "service_worker" || !target.url.includes("/background.js")) continue;
        try {
          const manifest = await evaluateTarget(browser, target.targetId, "chrome.runtime.getManifest()", { userGesture: false });
          if (manifest && manifest.name === "Deep Grab") {
            worker.value = target;
            return true;
          }
        } catch (error) {}
      }
      return false;
    }, 12000, 100);
    if (!workerReady) throw new Error("Deep Grab service worker did not load");
    const extensionMatch = /^chrome-extension:\/\/([^/]+)/.exec(worker.value.url);
    if (!extensionMatch) throw new Error("could not determine Deep Grab extension id");
    const extensionId = extensionMatch[1];
    console.log("  WORKER " + worker.value.url);

    const apiProbe = await evaluateTarget(browser, worker.value.targetId,
      "({ action: typeof chrome.action, openPopup: chrome.action && typeof chrome.action.openPopup, runtime: typeof chrome.runtime, keys: Object.keys(chrome).filter((key) => /action|command|tabs/.test(key)) })");
    console.log("  WORKER_API " + JSON.stringify(apiProbe));

    // Open through chrome.action.openPopup() from the live service worker. This
    // is the user-facing action surface; loading popup.html directly would be a
    // different page and would not test the shipped action wiring.
    const openResult = await evaluateTarget(browser, worker.value.targetId,
      "(async () => { try { await chrome.action.openPopup(); return 'opened'; } catch (error) { return 'ERR:' + error.message; } })()",
      { userGesture: true });
    const popup = { value: null };
    const popupReady = await waitFor(async () => {
      const list = await httpJson("http://127.0.0.1:" + cdpPort + "/json/list");
      popup.value = list.find((target) =>
        (target.type === "popup" || target.type === "page") && target.url.includes("chrome-extension://" + extensionId + "/popup.html"));
      return !!popup.value;
    }, 10000, 100);
    assert("manifest action opens the real popup surface", openResult === "opened" && popupReady,
      "open=" + openResult + " target=" + JSON.stringify(popup.value));
    if (!popupReady) throw new Error("action popup target did not appear");
    popupCdp = new Cdp(popup.value.webSocketDebuggerUrl);

    const popupEval = async (expression) => {
      const result = await popupCdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "popup evaluation failed");
      return result.result && result.result.value;
    };
    let popupWindow = null;
    let popupWindowError = "";
    try { popupWindow = await browser.send("Browser.getWindowForTarget", { targetId: popup.value.targetId }); }
    catch (error) { popupWindowError = error.message; }
    const isActionPopup = popup.value.type === "popup" || !!popupWindowError;
    assert("opened surface is a floating action popup, not a popup.html tab", isActionPopup,
      "target type=" + popup.value.type + " window=" + JSON.stringify(popupWindow) + " error=" + popupWindowError);

    // The real page/media requests exercise extension loading and the live WS;
    // the runtime message makes the two status rows deterministic without a
    // test-only DOM/state hook. `addFound` is the production SW handler used by
    // content.js and webRequest capture.
    const retryableUrl = "http://127.0.0.1:" + fixture.port + "/media/retryable.mp4";
    const terminalUrl = "http://127.0.0.1:" + fixture.port + "/media/terminal.mp4";
    await waitFor(() => sockets.size > 0 && fixture.hits.size === 2, 12000, 100);
    const seedExpression = "(() => { const rows = [" +
      "{ url: " + JSON.stringify(retryableUrl) + ", title: 'retryable.mp4' }," +
      "{ url: " + JSON.stringify(terminalUrl) + ", title: 'terminal.mp4' }" +
      "]; for (const row of rows) chrome.runtime.sendMessage({ type: 'video-found', url: row.url, title: row.title, kind: 'mp4' }, () => void chrome.runtime.lastError); return rows.length; })()";
    const seeded = await popupEval(seedExpression);
    assert("real fixture page loads both media requests", fixture.hits.size === 2,
      "hits=" + JSON.stringify(Array.from(fixture.hits)));
    assert("production runtime boundary accepts both popup seed rows", seeded === 2, "seeded=" + seeded);

    const readRows = () => popupEval(`(function () {
      return Array.from(document.querySelectorAll('#found-list li:not(.dv-empty)')).map((row) => {
        const title = row.querySelector('.dv-title');
        const meta = row.querySelector('.dv-meta');
        return {
          url: title ? title.title : '',
          title: title ? title.textContent : '',
          text: meta ? meta.textContent : '',
          className: meta ? meta.className : '',
          color: meta ? getComputedStyle(meta).color : '',
          ariaLabel: meta ? meta.getAttribute('aria-label') : '',
          tooltip: meta ? meta.title : ''
        };
      });
    })()`);
    const rowsReady = await waitFor(async () => (await readRows()).length === 2, 8000, 100);
    assert("popup renders both seeded rows", rowsReady, JSON.stringify(await readRows()));
    if (!rowsReady) throw new Error("popup rows did not render");

    const socket = Array.from(sockets).find((candidate) => candidate.readyState === WebSocket.OPEN);
    if (!socket) throw new Error("extension WebSocket closed before status injection");
    socket.send(JSON.stringify({
      type: "status", url: retryableUrl, status: "error", error: "upstream temporarily unavailable",
      errorCategory: "http", errorStatus: 502, errorCode: "HTTP", retryable: true
    }));
    socket.send(JSON.stringify({
      type: "status", url: terminalUrl, status: "error", error: "not found",
      errorCategory: "http", errorStatus: 404, errorCode: "HTTP", retryable: false
    }));
    console.log("  INJECT status retryable=502 terminal=404 through the extension WebSocket");

    const hasText = (row, text) => !!row && typeof row.text === "string" && row.text.includes(text);
    const statusReady = await waitFor(async () => {
      const rows = await readRows();
      return rows.some((row) => hasText(row, "Retryable error")) && rows.some((row) => hasText(row, "Terminal error"));
    }, 10000, 100);
    const rows = await readRows();
    const retry = rows.find((row) => row.url === retryableUrl) || {};
    const terminal = rows.find((row) => row.url === terminalUrl) || {};
    assert("retryable status push reaches the visible popup row", statusReady && hasText(retry, "Retryable error"), JSON.stringify(retry));
    assert("terminal status push reaches the visible popup row", statusReady && hasText(terminal, "Terminal error"), JSON.stringify(terminal));
    assert("retryable row shows amber icon, label, and HTTP detail",
      hasText(retry, "⟳") && hasText(retry, "Retryable error") && hasText(retry, "HTTP 502") && String(retry.className || "").includes("dv-retry"), JSON.stringify(retry));
    assert("terminal row shows red icon, label, and HTTP detail",
      hasText(terminal, "✕") && hasText(terminal, "Terminal error") && hasText(terminal, "HTTP 404") && String(terminal.className || "").includes("dv-err"), JSON.stringify(terminal));
    assert("retryable row uses the shipped amber color", retry.color === "rgb(251, 191, 36)", JSON.stringify(retry));
    assert("terminal row uses the shipped red color", terminal.color === "rgb(239, 68, 68)", JSON.stringify(terminal));
    assert("status pushes arrived on the extension's live WS", helloSockets.has(socket), "helloSockets=" + helloSockets.size);
  } catch (error) {
    failed++;
    console.log("  FAIL  browser fixture aborted -> " + ((error && error.stack) || error));
    console.log("    browser output: " + output.slice(-1200));
  } finally {
    if (popupCdp) popupCdp.close();
    if (browser) browser.close();
    for (const socket of sockets) {
      try { socket.terminate(); } catch (error) {}
    }
    killTree(chrome);
    await waitForExit(chrome, 2000);
    if (wsServer) await new Promise((resolve) => wsServer.close(() => resolve()));
    await closeServer(fixture && fixture.server);
    if (tempRoot) {
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (error) {}
    }
  }
  console.log("\n=== " + passed + " passed, " + failed + " failed ===\n");
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
