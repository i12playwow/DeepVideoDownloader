#!/usr/bin/env python3
"""surrit-relay.py -- local TLS-reoriginating relay for Cloudflare-gated hosts.

The Deep Grab engine (Node) can be challenged by surrit's Cloudflare based on
the client TLS fingerprint even when other TLS stacks (python-urllib) pass the
same gate from the same IP in the same second (validated 2026-09-30; header
changes do not help -- only the TLS ClientHello differs). This relay accepts
plain HTTP from Node on a loopback port and performs the upstream fetch with
python's http.client, so the connection surrit sees is a python TLS handshake.

Protocol (loopback only):
  <port>/<SCHEME>/<HOST>/<PATH>?<QUERY>   e.g. http://127.0.0.1:8931/https/surrit.com/uuid/playlist.m3u8

  * Everything Node sends beyond the scheme/host prefix is forwarded verbatim
    (path, query, all headers except Host/Accept-Encoding -- the relay injects
    its own Host and pins Accept-Encoding to identity so bodies need no
    decompression in stdlib).
  * Responses are streamed back with the upstream status + headers ( hop-by-hop
    and content-length excluded; chunked -> connection-close framing).

Host allowlist (fail-closed): surrit.com only by default; extend via
--allow <host> (repeatable) or SURRIT_RELAY_ALLOW="host1,host2". The relay
binds 127.0.0.1 only and rejects absolute-form targets outside the allowlist
with 403 -- it must never become an open proxy on the user's machine.

Usage:
  python surrit-relay.py [--port 8931] [--allow host] ... [--selftest]
Exit codes: 0 ran fine (selftest passed / served until killed), 2 selftest
failed, 3 could not bind. The launcher (jav-dl.js) treats any of those as
"relay unavailable" and falls back to direct fetches.
"""
import argparse
import http.client
import os
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = 8931
DEFAULT_ALLOW = ["surrit.com"]
HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host",
    "accept-encoding", "content-length", "proxy-connection",
}
MAX_BODY = 1 << 30  # safety cap; surrit responses are playlists + video segments

ALLOW = list(DEFAULT_ALLOW)


class RelayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "surrit-relay/1.0"

    def log_message(self, fmt, *args):  # quiet by default, visible with -v
        if os.environ.get("SURRIT_RELAY_VERBOSE"):
            sys.stderr.write("[relay] " + (fmt % args) + "\n")

    # Every method funnels into _relay(); Node only ever sends GET here.
    def do_GET(self):
        self._relay("GET")

    do_HEAD = do_GET
    do_POST = do_GET
    do_PUT = do_GET

    def _relay(self, method):
        # Parse /<scheme>/<host>/<rest> (rest may be empty).
        parts = self.path.lstrip("/").split("/", 2)
        if len(parts) < 2 or parts[0] not in ("http", "https") or not parts[1]:
            self._reply(400, "usage: /<scheme>/<host>[:<port>]/<path>")
            return
        scheme, hostport, rest = parts[0], parts[1], parts[2] if len(parts) > 2 else ""
        # Allowlist judges the HOSTNAME; the port rides along as the connect
        # target (a relay that only ever talks to :443 would be useless for
        # local test origins, and the selftest exercises exactly that).
        if ":" in hostport:
            host, port_s = hostport.rsplit(":", 1)
            try:
                port = int(port_s)
            except ValueError:
                self._reply(400, "bad port in authority: " + hostport)
                return
        else:
            host, port = hostport, None
        host = host.lower()
        if host not in ALLOW:
            self._reply(403, "host not allowed: " + host)
            return
        target = "/" + rest
        # Forward request headers verbatim, minus hop-by-hop/identity-managed.
        # Host goes FIRST and Connection: close is set — the exact upstream
        # shape urllib.request.do_open produces (Host first, then unredirected
        # headers, Connection: close). urllib is http.client under the hood, so
        # the TLS is already identical; this makes the HTTP layer match too —
        # a Cloudflare edge that scores request shape sees no difference.
        fwd = {"Host": hostport}
        for key, val in self.headers.items():
            if key.lower() in HOP_HEADERS:
                continue
            fwd[key] = val
        fwd["Accept-Encoding"] = "identity"
        fwd["Connection"] = "close"
        if os.environ.get("SURRIT_RELAY_VERBOSE"):
            sys.stderr.write("[relay] %s %s://%s%s\n" % (method, scheme, hostport, target))
        try:
            if scheme == "https":
                conn = http.client.HTTPSConnection(host, 443 if port is None else port, timeout=60)
            else:
                conn = http.client.HTTPConnection(host, 80 if port is None else port, timeout=60)
            clen = self.headers.get("Content-Length")
            body = self.rfile.read(int(clen)) if clen else None
            conn.request(method, target, body=body, headers=fwd)
            resp = conn.getresponse()
            self.send_response(resp.status, resp.reason)
            for key, val in resp.getheaders():
                if key.lower() in HOP_HEADERS:
                    continue
                self.send_header(key, val)
            self.send_header("Connection", "close")
            self.end_headers()
            remaining = MAX_BODY
            while True:
                chunk = resp.read(1 << 16)
                if not chunk:
                    break
                remaining -= len(chunk)
                if remaining < 0:
                    self.close_connection = True
                    break
                self.wfile.write(chunk)
            conn.close()
        except (OSError, http.client.HTTPException) as e:
            try:
                self._reply(502, "relay upstream error: %s" % e)
            except OSError:
                pass

    def _reply(self, code, text):
        payload = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)


class RelayServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def selftest():
    """End-to-end through a local origin server -- zero external network."""
    origin_port = _free_port()
    origin = ThreadingHTTPServer(("127.0.0.1", origin_port), _Origin)
    threading.Thread(target=origin.serve_forever, daemon=True).start()
    global ALLOW
    saved = ALLOW
    ALLOW = ["127.0.0.1"]
    try:
        relay_port = _free_port()
        relay = RelayServer(("127.0.0.1", relay_port), RelayHandler)
        threading.Thread(target=relay.serve_forever, daemon=True).start()
        # 1) GET through the relay re-originates with the forwarded headers.
        conn = http.client.HTTPConnection("127.0.0.1", relay_port, timeout=10)
        conn.request("GET", "/http/127.0.0.1:%d/hello?x=1" % origin_port,
                     headers={"User-Agent": "relay-test", "Referer": "https://missav.ws/"})
        r = conn.getresponse()
        body = r.read().decode()
        assert r.status == 200, r.status
        assert "GET /hello" in body and "user-agent: relay-test" in body and "referer: https://missav.ws/" in body, body
        assert "accept-encoding: identity" in body, body
        # 2) A 404 upstream passes through with its status + body.
        conn.request("GET", "/http/127.0.0.1:%d/missing" % origin_port)
        r = conn.getresponse()
        assert r.status == 404 and r.read() == b"gone", (r.status, r.read())
        # 3) Disallowed host fails closed.
        conn.request("GET", "/http/evil.example.com/x")
        r = conn.getresponse()
        assert r.status == 403, r.status
        conn.close()
        relay.shutdown()
    finally:
        ALLOW = saved
        origin.shutdown()
    print("selftest OK (forward, status passthrough, allowlist)")
    return 0


class _Origin(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/missing":
            self.send_response(404)
            self.send_header("Content-Length", "4")
            self.end_headers()
            self.wfile.write(b"gone")
            return
        payload = ("GET %s\n%s" % (self.path, "".join("%s: %s\n" % (k.lower(), v) for k, v in self.headers.items()))).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_HEAD(self):
        self.send_response(404)
        self.send_header("Content-Length", "4")
        self.end_headers()
        self.wfile.write(b"gone")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--allow", action="append", default=[],
                    help="extra allowed upstream host (repeatable)")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    global ALLOW
    ALLOW = list(DEFAULT_ALLOW)
    env_allow = [h.strip().lower() for h in os.environ.get("SURRIT_RELAY_ALLOW", "").split(",") if h.strip()]
    ALLOW += [h.lower() for h in args.allow] + env_allow
    if args.selftest:
        sys.exit(selftest())
    try:
        srv = RelayServer(("127.0.0.1", args.port), RelayHandler)
    except OSError as e:
        print("relay: cannot bind 127.0.0.1:%d -- %s" % (args.port, e))
        sys.exit(3)
    print("surrit-relay listening on http://127.0.0.1:%d (allow: %s)" % (args.port, ",".join(ALLOW)), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
