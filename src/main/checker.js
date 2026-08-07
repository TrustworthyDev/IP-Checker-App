'use strict';

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { toProxyUrl } = require('./proxy-parser');

/**
 * iphub.info block codes, per their API documentation. These are the whole
 * point of the app, so keep the meanings next to the code that produces them.
 *
 *   0 - Residential or business IP address (i.e. safe)
 *   1 - Non-residential IP address (hosting provider, proxy, etc.)
 *   2 - Suspicious IP address, lower confidence (may flag innocent users)
 *
 * iphub recommend deciding on block == 1 only, since 2 trades precision for
 * recall -- hence 'warn' rather than 'bad' for code 2.
 */
const BLOCK = {
  0: { verdict: 'good', label: 'Residential or business IP (safe)' },
  1: { verdict: 'bad', label: 'Non-residential (hosting provider, proxy, etc.)' },
  2: { verdict: 'warn', label: 'Suspicious, lower confidence' },
};

const IPHUB_API = 'https://v2.api.iphub.info/ip/';

/**
 * Endpoints used to discover a proxy's exit IP. All HTTPS on purpose: the
 * request is tunnelled with CONNECT, which keeps one agent type working for
 * both HTTP and SOCKS proxies and stops a transparent proxy from rewriting
 * the response body.
 */
const EXIT_IP_ENDPOINTS = [
  { url: 'https://api.ipify.org?format=json', pick: (d) => d && d.ip },
  { url: 'https://ipv4.icanhazip.com', pick: (d) => String(d || '').trim() },
  { url: 'https://ifconfig.me/ip', pick: (d) => String(d || '').trim() },
];

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function buildAgent(proxy) {
  const url = toProxyUrl(proxy);
  if (proxy.scheme === 'socks4' || proxy.scheme === 'socks5') {
    return new SocksProxyAgent(url, { timeout: 30000 });
  }
  return new HttpsProxyAgent(url);
}

/** Turn low-level socket/HTTP failures into something a user can act on. */
function describeError(error, proxy) {
  const code = error && error.code;
  const status = error && error.response && error.response.status;

  if (status === 407) return 'Proxy authentication failed (check user/pass)';
  if (status === 403) return 'Proxy refused the request (403)';
  if (status) return `Proxy returned HTTP ${status}`;

  switch (code) {
    case 'ECONNREFUSED':
      return `Connection refused by ${proxy.host}:${proxy.port}`;
    case 'ECONNRESET':
      return 'Connection reset by proxy';
    case 'ETIMEDOUT':
    case 'ECONNABORTED':
      return 'Timed out';
    case 'ENOTFOUND':
      return `Host not found: ${proxy.host}`;
    case 'EPROTO':
    case 'EPIPE':
      return 'Protocol error (wrong proxy type?)';
    case 'ERR_BAD_REQUEST':
      return 'Proxy rejected the request';
    default:
      break;
  }

  const message = (error && error.message) || 'Unknown error';
  if (/socks/i.test(message) && /auth/i.test(message)) {
    return 'SOCKS authentication failed';
  }
  return message;
}

/**
 * Discover the IP the world sees when traffic goes through this proxy.
 * This doubles as the liveness/latency test, and it matters for backconnect
 * pools where the endpoint you dial is not the address that exits.
 */
async function resolveExitIp(proxy, { timeout, signal }) {
  let lastError = null;

  for (const endpoint of EXIT_IP_ENDPOINTS) {
    if (signal && signal.aborted) throw new Error('Cancelled');
    const agent = buildAgent(proxy);
    const startedAt = Date.now();
    try {
      const response = await axios.get(endpoint.url, {
        httpAgent: agent,
        httpsAgent: agent,
        timeout,
        signal,
        // Never let a system/env proxy silently take over -- that would report
        // a healthy result for a dead proxy.
        proxy: false,
        maxRedirects: 0,
        responseType: endpoint.url.includes('ipify') ? 'json' : 'text',
        validateStatus: (s) => s >= 200 && s < 300,
        headers: { 'User-Agent': 'IPCheck/1.0' },
      });

      const ip = endpoint.pick(response.data);
      if (ip && IPV4.test(ip)) {
        return { ip, latencyMs: Date.now() - startedAt };
      }
      lastError = new Error('Endpoint returned no usable IPv4 address');
    } catch (error) {
      if (error.name === 'CanceledError' || (signal && signal.aborted)) {
        throw new Error('Cancelled');
      }
      lastError = error;
    } finally {
      if (agent && typeof agent.destroy === 'function') agent.destroy();
    }
  }

  throw lastError || new Error('Could not determine exit IP');
}

/**
 * iphub ask for one retry with at least a 200 ms delay on connection failures
 * and 5xx responses. Anything else (including 403/429) is returned as-is --
 * retrying those would only burn quota.
 */
async function withRetry(request, { signal }) {
  try {
    return await request();
  } catch (error) {
    const status = error.response && error.response.status;
    const retryable = !status || status >= 500;
    if (!retryable || (signal && signal.aborted)) throw error;

    await new Promise((resolve) => setTimeout(resolve, 250));
    if (signal && signal.aborted) throw new Error('Cancelled');
    return request();
  }
}

/** Query the official iphub API. Requires a free/paid X-Key. */
async function queryIphubApi(ip, apiKey, { timeout, signal }) {
  const response = await withRetry(
    () =>
      axios.get(IPHUB_API + ip, {
        headers: {
          'X-Key': apiKey,
          // v2.2 adds blockReason and proxyType, which explain *why* an IP was
          // flagged. Unknown fields are simply absent on older plans.
          'Accept-Version': '2.2',
          'User-Agent': 'IPCheck/1.0',
        },
        timeout,
        signal,
        proxy: false,
        validateStatus: (s) => s === 200 || s === 429 || s === 403,
      }),
    { signal }
  );

  if (response.status === 429) {
    const error = new Error('iphub daily quota exceeded (free keys allow 1000/day)');
    error.quota = true;
    throw error;
  }
  if (response.status === 403) {
    throw new Error('iphub rejected the API key (invalid or expired)');
  }

  const data = response.data || {};
  const block = Number(data.block);
  const meta = BLOCK[block] || { verdict: 'unknown', label: `Unknown block code ${data.block}` };

  return {
    source: 'api',
    ip: data.ip || ip,
    block: Number.isFinite(block) ? block : null,
    verdict: meta.verdict,
    blockLabel: meta.label,
    countryCode: data.countryCode || null,
    countryName: data.countryName || null,
    asn: data.asn != null ? String(data.asn) : null,
    isp: data.isp || null,
    hostname: data.hostname || null,
    blockReason: data.blockReason || null,
    // v2.2 only; residentialProxy is gated to the Professional plan.
    proxyType: data.proxyType || null,
  };
}

/**
 * There is deliberately no key-less fallback. iphub.info is a client-rendered
 * SPA and its old `/ip/<addr>` page now answers 410, so there is no block
 * status in the served HTML to scrape -- a "fallback" could only ever return
 * `unknown` and would misrepresent an unchecked proxy as merely inconclusive.
 * The documented API has a free tier (1000 lookups/day), so we require a key
 * and say so plainly.
 */
function missingKeyError() {
  const error = new Error(
    'No iphub.info API key configured — add one in Settings (free tier: 1000 lookups/day)'
  );
  error.missingKey = true;
  return error;
}

/**
 * Look up one IP on iphub, memoised across the run. Backconnect pools hand out
 * the same exit to many endpoints, and free API keys only allow 1000 lookups
 * a day -- caching keeps a 500-proxy list from burning the whole quota.
 */
async function lookupIp(ip, { apiKey, timeout, signal, cache }) {
  if (cache && cache.has(ip)) {
    return { ...cache.get(ip), cached: true };
  }

  if (!apiKey) throw missingKeyError();

  const result = await queryIphubApi(ip, apiKey, { timeout, signal });

  if (cache) cache.set(ip, result);
  return { ...result, cached: false };
}

/**
 * Full check for a single proxy: prove it works, learn its exit IP, then
 * score that IP on iphub.
 */
async function checkProxy(proxy, options) {
  const { apiKey, timeout, signal, cache } = options;
  const startedAt = Date.now();

  let exit;
  try {
    exit = await resolveExitIp(proxy, { timeout, signal });
  } catch (error) {
    if (error.message === 'Cancelled') throw error;
    return {
      id: proxy.id,
      proxy,
      status: 'dead',
      verdict: 'error',
      error: describeError(error, proxy),
      totalMs: Date.now() - startedAt,
    };
  }

  let info;
  try {
    info = await lookupIp(exit.ip, { apiKey, timeout, signal, cache });
  } catch (error) {
    if (error.message === 'Cancelled') throw error;
    // The proxy itself is alive -- report that, and say why scoring failed.
    return {
      id: proxy.id,
      proxy,
      status: 'alive',
      verdict: 'unknown',
      exitIp: exit.ip,
      latencyMs: exit.latencyMs,
      error: describeError(error, proxy),
      quotaExceeded: Boolean(error.quota),
      missingKey: Boolean(error.missingKey),
      totalMs: Date.now() - startedAt,
    };
  }

  return {
    id: proxy.id,
    proxy,
    status: 'alive',
    verdict: info.verdict,
    exitIp: exit.ip,
    latencyMs: exit.latencyMs,
    // A mismatch means backconnect/rotating -- worth surfacing in the UI.
    rotating: proxy.host !== exit.ip && IPV4.test(proxy.host),
    block: info.block,
    blockLabel: info.blockLabel,
    countryCode: info.countryCode,
    countryName: info.countryName,
    asn: info.asn,
    isp: info.isp,
    hostname: info.hostname,
    blockReason: info.blockReason,
    proxyType: info.proxyType,
    source: info.source,
    cached: info.cached,
    totalMs: Date.now() - startedAt,
  };
}

/**
 * Run checks over a list with a bounded worker pool.
 * `onResult` fires as each proxy finishes so the UI can stream rows in.
 */
async function runBatch(proxies, options) {
  const { concurrency = 5, onResult, signal } = options;
  const cache = new Map();
  const queue = proxies.map((proxy, index) => ({ proxy, index }));
  const results = new Array(proxies.length);
  let cursor = 0;
  let cancelled = false;

  async function worker() {
    for (;;) {
      if (cancelled || (signal && signal.aborted)) return;
      const slot = cursor;
      cursor += 1;
      if (slot >= queue.length) return;

      const { proxy, index } = queue[slot];
      let result;
      try {
        result = await checkProxy(proxy, { ...options, cache });
      } catch (error) {
        if (error.message === 'Cancelled' || (signal && signal.aborted)) {
          cancelled = true;
          return;
        }
        result = {
          id: proxy.id,
          proxy,
          status: 'dead',
          verdict: 'error',
          error: error.message || 'Unexpected failure',
        };
      }

      results[index] = result;
      if (onResult) onResult(result, index);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, queue.length || 1)) },
    () => worker()
  );
  await Promise.all(workers);

  return results.filter(Boolean);
}

/** Check the machine's own IP, so users can compare against an unproxied baseline. */
async function checkOwnIp(options) {
  const { apiKey, timeout, signal } = options;
  const response = await axios.get('https://api.ipify.org?format=json', {
    timeout,
    signal,
    proxy: false,
  });
  const ip = response.data && response.data.ip;
  if (!ip) throw new Error('Could not determine your IP');

  const info = await lookupIp(ip, { apiKey, timeout, signal, cache: null });
  return { ...info, exitIp: ip, status: 'alive' };
}

// withRetry is exported for tests; it is not part of the app's normal surface.
module.exports = { checkProxy, runBatch, checkOwnIp, lookupIp, BLOCK, withRetry };
