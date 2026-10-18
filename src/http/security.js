// @ts-check
"use strict";

/**
 * HTTP security helpers: CORS, origin validation, `Host` parsing and credential redaction.
 *
 * Responsibility: all the request-level trust decisions, in one place, so the security model can
 * be reviewed and tested without reading the router.
 *
 * **Phase 2 status: extracted, behaviour unchanged.** These functions deliberately still
 * implement the *baseline* policy, including the parts the audit calls insecure:
 *
 *   - ★C3 `validateOrigin` returns `true` for every origin when `corsOrigin` is `"*"`, and the
 *     env API key is used for a request from any origin;
 *   - ★C4 CORS is applied to every route, not just `/mcp`.
 *
 * Phase 5 owns the fix (origin allow-list, `Host` allow-list to stop DNS rebinding, scoped CORS,
 * proxy auth). The parameters these functions need are passed in explicitly rather than read
 * from module state, so Phase 5 can change the policy without touching the router.
 */

// --- CORS --------------------------------------------------------------------

/** The exact header set the preflight response advertises. */
const CORS_ALLOW_HEADERS =
  "Content-Type, Authorization, STITCH_API_KEY, X-Stitch-Api-Key, Accept";

/**
 * Sets the CORS headers for a response.
 *
 * Baseline behaviour (finding ★C3/★C4): applied to **every** route, and with the default
 * `corsOrigin` of `"*"` it echoes a wildcard, which lets any website call the proxy —
 * including with the server's own env API key.
 *
 * @param {import("http").ServerResponse} res
 * @param {import("http").IncomingMessage} req
 * @param {string} corsOrigin the configured `CORS_ORIGIN`
 */
function setCorsHeaders(res, req, corsOrigin) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", corsOrigin === "*" ? "*" : origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  res.setHeader("Access-Control-Max-Age", "86400");
}

/**
 * Decides whether the request's `Origin` is acceptable.
 *
 * Baseline behaviour. The MCP specification requires servers to validate `Origin` on **all**
 * incoming connections to prevent DNS rebinding, and to answer `403` for an invalid value.
 * Starting in `2026-07-28` revision terms that means an allow-list, which is Phase 5's job.
 *
 * @param {import("http").IncomingMessage} req
 * @param {string} corsOrigin the configured `CORS_ORIGIN`
 * @returns {boolean}
 */
function validateOrigin(req, corsOrigin) {
  // Only validate for /mcp endpoint per MCP spec
  if (!req.url || !req.url.startsWith("/mcp")) {
    return true;
  }

  const origin = req.headers.origin;
  if (!origin) {
    return true; // No origin header is acceptable for non-browser clients
  }

  // For localhost, allow any localhost origin
  if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
    return true;
  }

  // If corsOrigin is set to a specific value, validate against it
  if (corsOrigin !== "*") {
    return origin === corsOrigin;
  }

  return true;
}

// --- Host --------------------------------------------------------------------

/**
 * Parses the `Host` request header without ever throwing.
 *
 * Why this exists (finding ★C2): the baseline built the request URL as
 * `new URL(req.url, \`http://${req.headers.host}\`)`. A malformed `Host` (for example
 * `Host: [bad`) made the `URL` constructor throw `ERR_INVALID_URL` inside an `async` handler,
 * outside any `try`/`catch`. The resulting unhandled rejection terminated the process, so anyone
 * able to reach the port could kill the proxy with a single packet.
 *
 * The routing code only ever reads `url.pathname` and `url.searchParams`, never the host, so the
 * URL is now built from a constant base and the `Host` header is validated here, on its own
 * terms.
 *
 * Scope note: this only rejects values that are **not valid hosts**. Which hosts are
 * **acceptable** — the allow-list that prevents DNS rebinding — is the security model owned by
 * Phase 5 and deliberately not changed here.
 *
 * @param {import("http").IncomingMessage} req
 * @returns {{ host: string|null, reason: string|null }} `reason` is non-null when the header is
 *   malformed; `host` is null when the request legitimately has no `Host` (HTTP/1.0).
 */
function parseHostHeader(req) {
  const rawHost = req.headers.host;

  // HTTP/1.0 clients may omit `Host`. Node accepts such requests, and so do we.
  if (rawHost === undefined || rawHost === null || rawHost === "") {
    return { host: null, reason: null };
  }

  if (Array.isArray(rawHost)) {
    return { host: null, reason: "duplicate Host header" };
  }

  const value = String(rawHost).trim();
  if (!value) {
    return { host: null, reason: null };
  }

  // A host name, optionally followed by a port; bracketed IPv6 literals are allowed. Anything
  // with whitespace, slashes or brackets in the wrong place is rejected.
  if (/[\s/\\@?#]/.test(value)) {
    return { host: null, reason: "Host header contains illegal characters" };
  }

  let parsed;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    return { host: null, reason: "Host header is not a valid authority" };
  }

  if (!parsed.hostname) {
    return { host: null, reason: "Host header has an empty host name" };
  }

  if (parsed.port !== "") {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { host: null, reason: "Host header has an out-of-range port" };
    }
  }

  // `URL` normalises in exactly two harmless ways that must not be treated as "rewritten":
  // it case-folds the host name, and it elides the scheme's default port. Because the base is
  // `http://`, that is `:80` only — `:443` is *not* default for http and must be preserved.
  // Anything else it changes means the value was not a plain authority, so reject it.
  //
  // NOTE: this comparison is deliberately tolerant. An earlier version compared `parsed.host`
  // against the raw value, which rejected legitimate requests for `EXAMPLE.com` and
  // `example.com:80` — a bug caught by the unit tests in `test/unit.test.js`.
  const normalisedValue = value.toLowerCase().replace(/:80$/, "");
  if (parsed.host.toLowerCase() !== normalisedValue) {
    return { host: null, reason: "Host header was rewritten while parsing" };
  }

  return { host: parsed.host, reason: null };
}

// --- Redaction ---------------------------------------------------------------

/**
 * Header names (or name fragments) whose values must never reach a log file.
 *
 * Phase 5 extends this with `x-proxy-token` and `cookie`, and scrubs `key=` query parameters.
 */
const SECRET_HEADER_PATTERNS = ["authorization", "api-key"];

/** Exact header names that hold a credential. */
const SECRET_HEADER_NAMES = ["stitch_api_key", "x-goog-api-key"];

/**
 * Replaces credential-bearing header values with `[redacted]`.
 *
 * The log viewer renders these files, and the summary log can be shipped anywhere, so a
 * credential that reaches a log file is a credential leak.
 *
 * @param {Record<string, any>|undefined|null} headers
 * @returns {Record<string, any>}
 */
function redactHeaders(headers) {
  /** @type {Record<string, any>} */
  const redactedHeaders = {};

  for (const [key, value] of Object.entries(headers || {})) {
    const lowerKey = key.toLowerCase();

    if (
      SECRET_HEADER_PATTERNS.some((pattern) => lowerKey.includes(pattern)) ||
      SECRET_HEADER_NAMES.includes(lowerKey)
    ) {
      redactedHeaders[key] = "[redacted]";
      continue;
    }

    redactedHeaders[key] = value;
  }

  return redactedHeaders;
}

module.exports = {
  CORS_ALLOW_HEADERS,
  SECRET_HEADER_NAMES,
  SECRET_HEADER_PATTERNS,
  setCorsHeaders,
  validateOrigin,
  parseHostHeader,
  redactHeaders,
};
