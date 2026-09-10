#!/usr/bin/env node
// Contract test for scripts/newtv-catalog-bridge.js: drives the real bridge
// end-to-end against a fake Deep Grab app bridge (docs/ws-protocol.md) and a
// fake NewTV import server (ImportServer.cs /api/import contract).
// Self-contained: loopback ports only, no external services, safe for CI.
"use strict";

const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const { once } = require("events");
const WebSocket = require("ws");

const BRIDGE = path.join(__dirname, "scripts", "newtv-catalog-bridge.js");
let passed = 0, failed = 0;
function assert(name, ok, detail) {
  if (ok) { passed++; console.log("  ok  " + name); }
  else { failed++; console.error("FAIL  " + name + (detail ? " — " + detail : "")); }
}
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Pure-core unit checks (require the module without executing the runtime)
// ---------------------------------------------------------------------------
const core = require(BRIDGE);

assert("parseArgs: --k=v form", core.parseArgs(["--a=1", "--b=x"]).a === "1" && core.parseArgs(["--a=1"]).b === undefined);
assert("parseArgs: --k v form", core.parseArgs(["--min-mb", "50"])["min-mb"] === "50");
assert("splitPath: windows path", core.splitPath("C:\\a\\b\\c.mp4").dir === "C:\\a\\b" && core.splitPath("C:\\a\\b\\c.mp4").fileName === "c.mp4");
assert("splitPath: bare name", core.splitPath("c.mp4").dir === "" && core.splitPath("c.mp4").fileName === "c.mp4");

const pl = core.statusToImportPayload({
  fileName: "Movie Name.2020.1080p.mp4", finalPath: "C:\\dls\\Movie Name.2020.1080p.mp4",
  total: 2048 * 1024, url: "https://cdn/x.mp4", referer: "https://page/",
});
assert("payload: title derived from fileName", pl.title === "Movie Name.1080p" && pl.year === 2020, JSON.stringify(pl));
assert("payload: source + path + size + urls", pl.source.includes("Deep Grab") && pl.filePath === "C:\\dls\\Movie Name.2020.1080p.mp4" && pl.sizeBytes === 2048 * 1024 && pl.sourceUrl === "https://cdn/x.mp4" && pl.referer === "https://page/");
assert("payload: no year when absent", core.statusToImportPayload({ fileName: "Just A Movie.mp4" }).year === undefined);
assert("payload: 1920x1080 is not a year", core.statusToImportPayload({ fileName: "clip 1920x1080.mp4" }).year === undefined);
assert("payload: no fileName → null", core.statusToImportPayload({ fileName: "" }) === null);

assert("shouldRelay: done passes", core.shouldRelay({ status: "done", fileName: "a.mp4", total: 5 }, 0) === true);
assert("shouldRelay: running/queued/error rejected", ["running", "queued", "error", "duplicate", "cancelled"].every((s) => core.shouldRelay({ status: s, fileName: "a.mp4" }, 0) === false));
assert("shouldRelay: empty fileName rejected", core.shouldRelay({ status: "done", fileName: "  " }, 0) === false);
assert("shouldRelay: min-mb gates small totals", core.shouldRelay({ status: "done", fileName: "a.mp4", total: 1024 * 1024 }, 5) === false && core.shouldRelay({ status: "done", fileName: "a.mp4", total: 10 * 1024 * 1024 }, 5) === true);
assert("shouldRelay: unknown total passes min-mb gate", core.shouldRelay({ status: "done", fileName: "a.mp4" }, 5) === true);

assert("classifyRelay: done → done", core.classifyRelay({ status: "done", fileName: "a.mp4" }, 0) === "done");
assert("classifyRelay: error → error", core.classifyRelay({ status: "error", fileName: "a.mp4", error: "boom" }, 0) === "error");
assert("classifyRelay: duplicate/cancelled ignored", core.classifyRelay({ status: "duplicate", fileName: "a.mp4" }, 0) === null && core.classifyRelay({ status: "cancelled", fileName: "a.mp4" }, 0) === null);
assert("classifyRelay: running/queued/scheduled ignored", ["running", "queued", "scheduled"].every((s) => core.classifyRelay({ status: s, fileName: "a.mp4" }, 0) === null));
assert("classifyRelay: error without fileName ignored", core.classifyRelay({ status: "error", fileName: "", error: "x" }, 0) === null);
assert("classifyRelay: min-mb still gates done", core.classifyRelay({ status: "done", fileName: "a.mp4", total: 1024 }, 5) === null);
assert("classifyRelay: min-mb does not gate error", core.classifyRelay({ status: "error", fileName: "a.mp4", total: 0, error: "x" }, 5) === "error");

assert("failureSource: code + bounded message", core.failureSource({ errorCode: "EXPIRED", error: "HTTP 404\nlink expired" }) === "Deep Grab FAILED [EXPIRED] HTTP 404 link expired", core.failureSource({ errorCode: "EXPIRED", error: "HTTP 404\nlink expired" }));
assert("failureSource: no code falls back to message", core.failureSource({ error: "plain failure" }) === "Deep Grab FAILED plain failure");
assert("failureSource: long message truncated to 100 chars", core.failureSource({ error: "x".repeat(300) }).length <= "Deep Grab FAILED ".length + 100);

assert("composeSource: done + referer", core.composeSource({ referer: "https://supjav.com/452555.html" }, "done") === "Deep Grab (newtv-catalog-bridge) · https://supjav.com/452555.html", core.composeSource({ referer: "https://x/" }, "done"));
assert("composeSource: falls back to media url", core.composeSource({ url: "https://cdn/a.mp4" }, "done") === "Deep Grab (newtv-catalog-bridge) · https://cdn/a.mp4");
assert("composeSource: no url → bare marker", core.composeSource({}, "done") === "Deep Grab (newtv-catalog-bridge)");
assert("composeSource: error keeps FAILED leading + url", core.composeSource({ errorCode: "EXPIRED", error: "HTTP 404", referer: "https://p/" }, "error") === "Deep Grab FAILED [EXPIRED] HTTP 404 · https://p/");
assert("composeSource: capped at 220", core.composeSource({ referer: "https://x/" + "a".repeat(400) }, "done").length <= 220);
assert("composeSource: marker survives the cap", core.composeSource({ referer: "https://x/" + "a".repeat(400) }, "done").startsWith("Deep Grab (newtv-catalog-bridge)"));

assert("isNewWatchedFolder: case-insensitive Windows compare", core.isNewWatchedFolder("C:\\DLS", ["c:\\dls"]) === false);
assert("isNewWatchedFolder: new dir among watched", core.isNewWatchedFolder("C:\\new", ["c:\\a", "C:\\B"]) === true);
assert("isNewWatchedFolder: empty watched list", core.isNewWatchedFolder("C:\\x", []) === true);

// ---------------------------------------------------------------------------
// Fake Deep Grab app bridge (docs/ws-protocol.md subset)
// ---------------------------------------------------------------------------
async function startFakeApp() {
  const server = new WebSocket.Server({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const port = server.address().port;
  let seq = 0;
  const sockets = new Set();
  server.on("connection", (ws) => {
    sockets.add(ws);
    ws.send(JSON.stringify({ type: "hello", version: "9.9.9-fake", protocolVersion: 1, port }));
    ws.on("message", (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      if (msg.type === "hello") return;
      if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong", reqId: msg.reqId })); return; }
    });
  });
  server.pushStatus = (obj) => { for (const s of sockets) { try { s.send(JSON.stringify(obj)); } catch (e) { /* gone */ } } };
  server.closeAll = async () => { for (const s of sockets) { try { s.close(); } catch (e) {} } return new Promise((r) => server.close(r)); };
  return { server, url: "ws://127.0.0.1:" + port, nextId: () => "dl-" + ++seq };
}

// ---------------------------------------------------------------------------
// Fake NewTV import server (ImportServer.cs /api/import contract subset)
// ---------------------------------------------------------------------------
function startFakeNewtv() {
  const imports = [];
  const watchedFolders = [];
  let folderAdds = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/ping") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", app: "NewTV" }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/watched-folders") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(watchedFolders));
      return;
    }
    if (req.method === "POST" && req.url === "/api/watched-folders") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const doc = JSON.parse(body);
          if (!watchedFolders.some((w) => String(w).toLowerCase() === String(doc.path).toLowerCase())) {
            watchedFolders.push(doc.path);
            folderAdds++;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, added: true, path: doc.path }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON" }));
        }
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/import") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const doc = JSON.parse(body);
          imports.push(doc);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, id: imports.length, title: doc.title }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON" }));
        }
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, imports, watchedFolders, getFolderAdds: () => folderAdds, url: "http://127.0.0.1:" + server.address().port + "/api/import" })));
}

// ---------------------------------------------------------------------------
// E2E: real bridge process against both fakes
// ---------------------------------------------------------------------------
async function main() {
  console.log("== newtv-catalog-bridge contract tests ==");
  const app = await startFakeApp();
  const newtv = await startFakeNewtv();
  console.log("  fake deep grab on " + app.url);
  console.log("  fake newtv on " + newtv.url);

  const child = spawn(process.execPath, [BRIDGE], {
    env: Object.assign({}, process.env, { DEEPGRAB_WS_URL: app.url, NEWTV_IMPORT_URL: newtv.url }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bootLog = "";
  child.stdout.on("data", (c) => (bootLog += c.toString()));
  child.stderr.on("data", (c) => (bootLog += c.toString()));
  await delay(700); // let the bridge connect + handshake

  // 1. done push with a year + resolution in the name → relayed with year split out
  const id1 = app.nextId();
  app.server.pushStatus({ type: "status", id: id1, url: "https://cdn/a.mp4", fileName: "Best Movie Ever 2019 1080p.mp4", status: "running", total: 100, received: 50 });
  app.server.pushStatus({ type: "status", id: id1, url: "https://cdn/a.mp4", fileName: "Best Movie Ever 2019 1080p.mp4", status: "done", total: 100 * 1024 * 1024, received: 100 * 1024 * 1024, finalPath: "C:\\DeepGrab\\Best Movie Ever 2019 1080p.mp4" });
  await delay(400);
  assert("done push relayed to NewTV", newtv.imports.length === 1, JSON.stringify(newtv.imports));
  if (newtv.imports.length === 1) {
    const p = newtv.imports[0];
    assert("payload title+year derived correctly", p.title === "Best Movie Ever 1080p" && p.year === 2019, JSON.stringify(p));
    assert("payload carries filePath + sizeBytes", p.filePath === "C:\\DeepGrab\\Best Movie Ever 2019 1080p.mp4" && p.sizeBytes === 100 * 1024 * 1024, JSON.stringify(p));
    assert("payload source tags the page url (end-to-end tracking)", p.source === "Deep Grab (newtv-catalog-bridge) · https://cdn/a.mp4", p.source);
  }

  // 2. repeat of the SAME done push (a resync echo) → NOT relayed again
  app.server.pushStatus({ type: "status", id: id1, url: "https://cdn/a.mp4", fileName: "Best Movie Ever 2019 1080p.mp4", status: "done", total: 100 * 1024 * 1024, received: 100 * 1024 * 1024, finalPath: "C:\\DeepGrab\\Best Movie Ever 2019 1080p.mp4" });
  await delay(300);
  assert("duplicate done push deduped", newtv.imports.length === 1, String(newtv.imports.length));

  // 3. a NEW download also finishing → relayed (dedupe is per-item)
  const id2 = app.nextId();
  app.server.pushStatus({ type: "status", id: id2, url: "https://cdn/b.mp4", fileName: "Second Movie 2021.mp4", status: "done", total: 50 * 1024 * 1024, finalPath: "C:\\DeepGrab\\Second Movie 2021.mp4" });
  await delay(400);
  assert("second done push relayed", newtv.imports.length === 2, String(newtv.imports.length));

  // 4. error relays as a flag (see 5b-style contract), duplicate/cancelled never do
  const idErr = app.nextId();
  app.server.pushStatus({ type: "status", id: idErr, url: "https://cdn/c.mp4", fileName: "Errored Movie.mp4", status: "error", total: 0, error: "boom" });
  app.server.pushStatus({ type: "status", id: app.nextId(), url: "https://cdn/d.mp4", fileName: "Dup Movie.mp4", status: "duplicate", total: 0 });
  app.server.pushStatus({ type: "status", id: app.nextId(), url: "https://cdn/e.mp4", fileName: "Cancelled Movie.mp4", status: "cancelled", total: 0 });
  await delay(400);
  assert("duplicate/cancelled never relayed, error does", newtv.imports.length === 3, String(newtv.imports.length));

  // 5. done push with no fileName → nothing relayed
  app.server.pushStatus({ type: "status", id: app.nextId(), url: "https://cdn/f.mp4", fileName: "", status: "done", total: 10 });
  await delay(300);
  assert("done without fileName never relayed", newtv.imports.length === 3, String(newtv.imports.length));

  // 5b. a structured ERROR push relays as a flagged entry
  const idE = app.nextId();
  app.server.pushStatus({ type: "status", id: idE, url: "https://cdn/e1.mp4", fileName: "Broken Movie 2022.mp4", status: "error", total: 0, error: "HTTP 404 link expired", errorCode: "EXPIRED", errorCategory: "expired" });
  await delay(400);
  assert("error push relayed as flagged entry", newtv.imports.length === 4, JSON.stringify(newtv.imports.map((i) => i.title)));
  if (newtv.imports.length === 4) {
    const p = newtv.imports[3];
    assert("flagged payload title+year still derived", p.title === "Broken Movie" && p.year === 2022, JSON.stringify(p));
    assert("flagged payload source carries FAILED marker + code + message + url", p.source === "Deep Grab FAILED [EXPIRED] HTTP 404 link expired · https://cdn/e1.mp4", p.source);
  }

  // 5c. same error message again (resync echo) → deduped; DIFFERENT message →
  // re-flags (ImportServer's dedupe refreshes the same pending row).
  app.server.pushStatus({ type: "status", id: idE, url: "https://cdn/e1.mp4", fileName: "Broken Movie 2022.mp4", status: "error", total: 0, error: "HTTP 404 link expired", errorCode: "EXPIRED" });
  await delay(300);
  assert("identical error echo deduped", newtv.imports.length === 4, String(newtv.imports.length));
  app.server.pushStatus({ type: "status", id: idE, url: "https://cdn/e1.mp4", fileName: "Broken Movie 2022.mp4", status: "error", total: 0, error: "HTTP 503 upstream", errorCode: "HTTP" });
  await delay(300);
  assert("different error message re-flags the row", newtv.imports.length === 5, String(newtv.imports.length));

  // 5d. later done for the same movie refreshes the flagged row clean (the
  // bridge sends source="Deep Grab (newtv-catalog-bridge)"; FirstMeaningful
  // keeps the old flagged source only if the new one were blank — it is not).
  app.server.pushStatus({ type: "status", id: idE, url: "https://cdn/e1.mp4", fileName: "Broken Movie 2022.mp4", status: "done", total: 42 * 1024 * 1024, finalPath: "C:\\DeepGrab\\Broken Movie 2022.mp4" });
  await delay(400);
  assert("late done after error relays too", newtv.imports.length === 6, String(newtv.imports.length));
  if (newtv.imports.length === 6) {
    assert("late done payload has clean source + filePath", newtv.imports[5].source === "Deep Grab (newtv-catalog-bridge) · https://cdn/e1.mp4" && newtv.imports[5].filePath === "C:\\DeepGrab\\Broken Movie 2022.mp4", JSON.stringify(newtv.imports[5]));
  }

  // 5e. auto-watch: every done payload's directory gets POSTed to
  // /api/watched-folders exactly once (echoes dedupe upstream; already-watched
  // dirs are skipped via the GET; error relays carry no filePath → never watch).
  // Poll rather than sleep — the GET→POST waterfall runs async after the relay.
  let watchedOk = false;
  for (let i = 0; i < 20 && !watchedOk; i++) {
    await delay(250);
    watchedOk = newtv.watchedFolders.some((w) => String(w).toLowerCase() === "c:\\deepgrab");
  }
  assert("auto-watch registered the download dir", watchedOk, JSON.stringify(newtv.watchedFolders));
  assert("auto-watch POSTed once despite echoes + re-flags", newtv.getFolderAdds() === 1, String(newtv.getFolderAdds()));

  // 6. offline NewTV: import failure is logged, not fatal; bridge still alive
  child.kill();
  await once(child, "exit");
  const child2 = spawn(process.execPath, [BRIDGE], {
    env: Object.assign({}, process.env, { DEEPGRAB_WS_URL: app.url, NEWTV_IMPORT_URL: "http://127.0.0.1:59998/api/import" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log2 = "";
  child2.stdout.on("data", (c) => (log2 += c.toString()));
  child2.stderr.on("data", (c) => (log2 += c.toString()));
  await delay(700);
  app.server.pushStatus({ type: "status", id: app.nextId(), url: "https://cdn/g.mp4", fileName: "Offline NewTV Movie.mp4", status: "done", total: 10 });
  await delay(500);
  assert("offline NewTV logged, bridge survives", /import failed/.test(log2), log2.slice(-300));
  child2.kill();
  await once(child2, "exit");

  await app.server.closeAll();
  newtv.server.close();
  console.log("\n" + (failed ? "FAILED " : "") + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("suite error:", e); process.exit(1); });
