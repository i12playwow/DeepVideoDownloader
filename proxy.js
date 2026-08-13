// Proxy manager: proxy list, latency testing, per-segment proxy selection.

const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const http = require("http");
const https = require("https");
const { URL } = require("url");

function parseProxyUrl(p) {
  try {
    const u = new URL(p);
    // u.origin strips userinfo and is "null" for non-special schemes (socks://),
    // which would break agent construction; rebuild the URL from parts.
    let url = u.protocol + "//" + u.host;
    if (u.username) {
      const creds = encodeURIComponent(u.username) + (u.password ? ":" + encodeURIComponent(u.password) : "");
      url = u.protocol + "//" + creds + "@" + u.host;
    }
    return {
      protocol: u.protocol.replace(":", ""),
      host: u.hostname,
      port: u.port,
      url
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

      const started = Date.now();
      const req = mod.request(urlObj, {
        method: "HEAD",
        agent,
        headers: { "User-Agent": this.config.ua || "Mozilla/5.0" },
        timeout
      }, (res) => {
        res.resume();
        this.latency.set(p.url, Date.now() - started);
        resolve({ ms: Date.now() - started, status: res.statusCode });
      });

      req.on("error", () => {
        this.markBad(p);
        this.latency.delete(p.url);
        resolve(null);
      });
      req.on("timeout", () => {
        req.destroy();
        this.markBad(p);
        this.latency.delete(p.url);
        resolve(null);
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
