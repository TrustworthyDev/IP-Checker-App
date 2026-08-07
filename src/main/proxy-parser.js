'use strict';

/**
 * Parser for proxy lists.
 *
 * Proxy-seller (and most vendors) hand out lists in a handful of shapes, and
 * people paste them with whatever separator survived the copy. Accepted:
 *
 *   host:port
 *   host:port:user:pass
 *   user:pass@host:port
 *   scheme://host:port
 *   scheme://user:pass@host:port
 *   host;port;user;pass        (semicolon variant)
 *   host port user pass        (whitespace / tab variant, e.g. pasted from a table)
 *
 * `scheme` is one of http, https, socks4, socks5 (socks5h is folded into socks5).
 */

const SCHEMES = ['http', 'https', 'socks4', 'socks5'];

/** Ports are 1-65535; anything else is a parse failure, not a clamp. */
function isPort(value) {
  if (!/^\d{1,5}$/.test(value)) return false;
  const n = Number(value);
  return n >= 1 && n <= 65535;
}

/**
 * A host is either an IPv4 literal or a DNS name. Deliberately permissive on
 * names — vendors use backconnect hostnames like `res.proxy-seller.com`.
 */
function isHost(value) {
  if (!value) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every((o) => Number(o) <= 255);
  }
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value);
}

function normalizeScheme(raw) {
  const s = String(raw || '').toLowerCase().replace(/:$/, '');
  if (s === 'socks5h' || s === 'socks') return 'socks5';
  if (s === 'socks4a') return 'socks4';
  return SCHEMES.includes(s) ? s : null;
}

/**
 * Split a line into fields. We normalize semicolons and whitespace runs to a
 * colon so every variant collapses onto the same colon-delimited code path.
 * Anything inside a `scheme://` prefix or after an `@` is handled before this.
 */
function splitFields(text) {
  return text
    .replace(/[;\t]+/g, ':')
    .replace(/\s+/g, ':')
    .split(':')
    .filter((p) => p.length > 0);
}

/**
 * Parse one line into a proxy descriptor.
 * @param {string} line
 * @param {string} defaultScheme - protocol to assume when the line omits one
 * @returns {{ok: true, proxy: object} | {ok: false, error: string, raw: string}}
 */
function parseLine(line, defaultScheme = 'http') {
  const raw = String(line || '').trim();
  if (!raw) return { ok: false, error: 'empty line', raw };

  let rest = raw;
  let scheme = null;

  // 1. Strip an optional scheme:// prefix.
  const schemeMatch = rest.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
  if (schemeMatch) {
    scheme = normalizeScheme(schemeMatch[1]);
    if (!scheme) {
      return { ok: false, error: `unsupported protocol "${schemeMatch[1]}"`, raw };
    }
    rest = schemeMatch[2];
  }

  let username = null;
  let password = null;
  let host;
  let port;

  // 2. Try the user:pass@host:port form. An "@" is only the credential
  //    separator if what follows it is genuinely a host:port -- otherwise the
  //    "@" belongs to a password in the positional form (p@ss), and treating
  //    it as a separator would silently mangle the proxy.
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    const tail = splitFields(rest.slice(at + 1));
    if (tail.length === 2 && isHost(tail[0]) && isPort(tail[1])) {
      const credentials = rest.slice(0, at);
      const sep = credentials.indexOf(':');
      if (sep === -1) return { ok: false, error: 'credentials must be user:pass', raw };

      username = credentials.slice(0, sep);
      // Everything after the FIRST colon is the password, so ":" is safe in it.
      password = credentials.slice(sep + 1);
      if (!username) return { ok: false, error: 'empty username', raw };
      [host, port] = tail;

      return buildResult(raw, scheme, defaultScheme, host, port, username, password);
    }
  }

  // 3. Positional form.
  const fields = splitFields(rest);

  if (fields.length === 2) {
    [host, port] = fields;
  } else if (fields.length >= 4 && isHost(fields[0]) && isPort(fields[1])) {
    // host:port:user:pass -- the password keeps any remaining colons.
    host = fields[0];
    port = fields[1];
    username = fields[2];
    password = fields.slice(3).join(':');
  } else if (fields.length === 4 && isHost(fields[2]) && isPort(fields[3])) {
    // user:pass:host:port -- the other ordering seen in the wild.
    [username, password, host, port] = fields;
  } else if (fields.length < 2) {
    return { ok: false, error: `expected at least host:port, got ${fields.length} field(s)`, raw };
  } else {
    return { ok: false, error: 'cannot locate host:port in the line', raw };
  }

  return buildResult(raw, scheme, defaultScheme, host, port, username, password);
}

/** Shared validation + shaping for both the credential and positional forms. */
function buildResult(raw, scheme, defaultScheme, host, port, username, password) {

  if (!isHost(host)) return { ok: false, error: `invalid host "${host}"`, raw };
  if (!isPort(port)) return { ok: false, error: `invalid port "${port}"`, raw };

  const finalScheme = scheme || normalizeScheme(defaultScheme) || 'http';

  return {
    ok: true,
    proxy: {
      raw,
      scheme: finalScheme,
      host,
      port: Number(port),
      username: username || null,
      password: password === null ? null : password,
      // Stable identity for dedupe and for React-style row keys in the renderer.
      id: `${finalScheme}://${username ? `${username}@` : ''}${host}:${port}`,
    },
  };
}

/**
 * Parse a whole pasted blob.
 * @returns {{proxies: object[], errors: {line: number, raw: string, error: string}[], duplicates: number}}
 */
function parseList(text, defaultScheme = 'http') {
  const lines = String(text || '').split(/\r?\n/);
  const proxies = [];
  const errors = [];
  const seen = new Set();
  let duplicates = 0;

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    // Allow blank spacers and "#" comments so users can annotate their lists.
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return;

    const result = parseLine(trimmed, defaultScheme);
    if (!result.ok) {
      errors.push({ line: index + 1, raw: trimmed, error: result.error });
      return;
    }
    if (seen.has(result.proxy.id)) {
      duplicates += 1;
      return;
    }
    seen.add(result.proxy.id);
    proxies.push(result.proxy);
  });

  return { proxies, errors, duplicates };
}

/** Build the URL form the proxy agents expect, with credentials percent-encoded. */
function toProxyUrl(proxy) {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : '';
  return `${proxy.scheme}://${auth}${proxy.host}:${proxy.port}`;
}

module.exports = { parseLine, parseList, toProxyUrl, isHost, isPort, SCHEMES };
