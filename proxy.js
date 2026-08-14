// Proxy manager: proxy list, latency testing, per-segment proxy selection.

const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const PROXY_SCHEMES = ["http", "https", "socks", "socks4", "socks5", "socks5h"];

function parseProxyUrl(p) {
  try {
    const u = new URL(p);
    const protocol = u.protocol.replace(":", "");
    if (!PROXY_SCHEMES.includes(protocol)) return null;
    return {
      protocol,
      host: u.hostname,
      port: u.port,
      url: u.href
    };
  } catch (e) {
    return null;
  }
}

function agentFor(proxy, targetUrl) {
  if (!proxy) return null;
  const isHttps = /^https:/i.test(targetUrl);
  if (proxy.protocol === "socks" || proxy.protocol === "socks4" || proxy.protocol === "socks5" || proxy.protocol === "socks5h") {
    return new SocksProxyAgent(proxy.url);
  }
  if (proxy.protocol === "http" || proxy.protocol === "https") {
    return isHttps ? new HttpsProxyAgent(proxy.url) : new HttpProxyAgent(proxy.url);
  }
  return null;
}

function transport(targetUrl) {
  return /^https:/i.test(targetUrl) ? https : http;
}

class ProxyManager {
  constructor(config) {
    this.config = config;
    this.bad = new Map();   // proxy url -> timestamp of last failure
    this.latency = new Map(); // proxy url -> last measured ms
  }

  list() {
    return (this.config.proxies || [])
      .map((p) => p.trim())
      .filter(Boolean)
      .map(parseProxyUrl)
      .filter(Boolean);
  }

  isBad(p) {
    const t = this.bad.get(p.url);
    return t && Date.now() - t < 15000;
  }

  markBad(p) {
    this.bad.set(p.url, Date.now());
  }

  agentFor(p, targetUrl) {
    return agentFor(p, targetUrl);
  }

  // Test a proxy by requesting the first bytes of the target URL.
  testLatency(p, targetUrl, timeout = 6000) {
    return new Promise((resolve) => {
      const mod = transport(targetUrl);
      const agent = this.agentFor(p, targetUrl);
      if (!agent) return resolve(null);

      let urlObj;
      try {
        urlObj = new URL(targetUrl);
      } catch (e) {
        return resolve(null);
      }

      const probe = (method) => new Promise((res) => {
        const started = Date.now();
        const req = mod.request(urlObj, {
          method,
          agent,
          headers: {
            "User-Agent": this.config.ua || "Mozilla/5.0",
            ...(method === "GET" ? { Range: "bytes=0-0" } : {})
          },
          timeout
        }, (r) => {
          r.resume();
          res({ ms: Date.now() - started, status: r.statusCode });
        });
        req.on("error", () => res(null));
        req.on("timeout", () => { req.destroy(); res(null); });
        req.end();
      });

      // HEAD first; servers that reject HEAD would otherwise report the proxy
      // as dead, so fall back to a ranged GET.
      probe("HEAD").then((head) => {
        if (head) {
          this.latency.set(p.url, head.ms);
          return resolve({ ms: head.ms, status: head.status });
        }
        return probe("GET").then((get) => {
          if (!get) {
            this.markBad(p);
            this.latency.delete(p.url);
            return resolve(null);
          }
          this.latency.set(p.url, get.ms);
          return resolve({ ms: get.ms, status: get.status });
        });
      });
    });
  }

  // Return the best proxy for a target (auto mode). Falls back to next best.
  async pickBest(targetUrl, timeout = 6000) {
    const proxies = this.list().filter((p) => !this.isBad(p));
    if (!proxies.length) return null;

    const results = await Promise.all(proxies.map(async (p) => {
      const lat = await this.testLatency(p, targetUrl, timeout);
      return { p, ms: lat ? lat.ms : null };
    }));

    results.sort((a, b) => {
      if (a.ms == null && b.ms == null) return 0;
      if (a.ms == null) return 1;
      if (b.ms == null) return -1;
      return a.ms - b.ms;
    });

    return results[0].ms == null ? null : results[0].p;
  }
}

module.exports = { ProxyManager, parseProxyUrl, agentFor, transport };
