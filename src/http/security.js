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

/** The exact header set a preflight response advertises. */
const CORS_ALLOW_HEADERS =
  "Content-Type, Authorization, STITCH_API_KEY, X-Stitch-Api-Key, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID, Mcp-Method, Mcp-Name, Idempotency-Key";

// --- Address classification --------------------------------------------------

/**
 * Is this address inside a private network (RFC 1918, loopback, IPv6 ULA/link-local)?
 *
 * The owner's requirement is that other machines on the LAN can use the proxy while the public
 * internet cannot. "Private address" is therefore the primary allow-list, not "loopback".
 *
 * @param {string|null|undefined} address
 * @returns {boolean}
 */
function isPrivateAddress(address) {
  if (!address) {
    return false;
  }

  const value = String(address).trim().toLowerCase();

  // IPv6: loopback, unique-local (fc00::/7) and link-local (fe80::/10).
  if (value === "::1" || value === "::") {
    return true;
  }
  if (/^f[cd][0-9a-f]{2}:/.test(value)) {
    return true;
  }
  if (/^fe[89ab][0-9a-f]:/.test(value)) {
    return true;
  }
  // A bracketed or mapped IPv4 (`::ffff:192.168.1.1`).
  const mapped = value.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (value.startsWith("::ffff:") && mapped) {
    return isPrivateAddress(mapped[1]);
  }

  const parts = value.split(".");
  if (parts.length !== 4) {
    return false;
  }

  const octets = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const [a, b] = octets;

  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10

  return false;
}

/**
 * @param {string|null|undefined} address
 * @returns {boolean}
 */
function isLoopbackAddress(address) {
  if (!address) {
    return false;
  }
  const value = String(address).trim().toLowerCase();
  return value === "::1" || value.startsWith("127.") || value === "localhost";
}

/**
 * Extracts the host name from a `Host` header or an `Origin` URL, lower-cased.
 *
 * @param {string} value
 * @returns {string}
 */
function hostnameOf(value) {
  const trimmed = String(value).trim();
  if (!trimmed) {
    return "";
  }

  // Bracketed IPv6 literal, with or without a port.
  const bracketed = trimmed.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    return bracketed[1].toLowerCase();
  }

  const withoutPort = trimmed.replace(/:\d+$/, "");
  return withoutPort.toLowerCase();
}

/**
 * Should an origin be allowed when the operator has not configured an allow-list?
 *
 * Rule (ADR 0005): non-browser clients (no `Origin`) are always allowed; a browser origin is
 * allowed when it points at a private/LAN host. This keeps the LAN workflow working and closes
 * ★C3, where *any* website could drive the proxy with the server's own API key.
 *
 * @param {string|null|undefined} origin
 * @returns {boolean}
 */
function originAllowedByDefault(origin) {
  if (origin === undefined || origin === null || origin === "") {
    return true;
  }

  let parsed;
  try {
    parsed = new URL(String(origin));
  } catch {
    return false;
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }
  if (hostname.endsWith(".local")) {
    // mDNS names resolve on the LAN and cannot resolve on the public internet.
    return true;
  }

  return isPrivateAddress(hostname);
}

/**
 * @typedef {object} OriginPolicy
 * @property {string|null|undefined} corsOrigin the `CORS_ORIGIN` setting
 * @property {Set<string>|null} [allowedOrigins] extra explicit origins
 */

/**
 * @typedef {{ allowed: boolean, reason: string, reflectOrigin: string|null }} OriginDecision
 */

/**
 * Decides whether a request's `Origin` is acceptable, and which origin to reflect in CORS.
 *
 * @param {string|null|undefined} origin
 * @param {OriginPolicy} policy
 * @returns {OriginDecision}
 */
function evaluateOrigin(origin, policy) {
  const configured = policy.corsOrigin;

  // Explicit wildcard: the pre-Phase-5 behaviour, opt-in only.
  if (configured === "*") {
    return {
      allowed: true,
      reason: "CORS_ORIGIN is * (all origins explicitly allowed)",
      reflectOrigin: origin || "*",
    };
  }

  // A specific configured origin is an exact allow-list of one.
  if (configured) {
    const allowed = origin === configured;
    return {
      allowed,
      reason: allowed ? "matches CORS_ORIGIN" : "does not match CORS_ORIGIN",
      reflectOrigin: allowed ? configured : null,
    };
  }

  if (policy.allowedOrigins && origin && policy.allowedOrigins.has(origin)) {
    return { allowed: true, reason: "listed in ALLOWED_ORIGINS", reflectOrigin: origin };
  }

  const allowed = originAllowedByDefault(origin);
  return {
    allowed,
    reason: allowed
      ? origin
        ? "private-network origin"
        : "no Origin header (non-browser client)"
      : "public-internet origin refused",
    reflectOrigin: allowed && origin ? origin : null,
  };
}

/**
 * Sets the CORS headers for a response.
 *
 * Only `/mcp` gets CORS (finding ★C4). With a reflected origin the response must carry
 * `Vary: Origin` or a cache can serve one origin's allowance to another.
 *
 * @param {import("http").ServerResponse} res
 * @param {import("http").IncomingMessage} req
 * @param {OriginDecision} decision
 * @param {{ wildcard?: boolean }} [options]
 */
function setCorsHeaders(res, req, decision, options = {}) {
  if (!decision.allowed) {
    return;
  }

  if (options.wildcard) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (decision.reflectOrigin) {
    res.setHeader("Access-Control-Allow-Origin", decision.reflectOrigin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  res.setHeader("Access-Control-Max-Age", "86400");
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

/**
 * @typedef {object} HostPolicy
 * @property {Set<string>|null} [allowedHosts] extra explicit host names
 * @property {boolean} [allowAll] accept any host (explicit opt-in)
 */

/**
 * Decides whether the request's `Host` header is acceptable.
 *
 * This is the DNS-rebinding control (MCP spec: servers MUST validate `Origin` on every
 * connection; `Host` is the complementary half). A malicious page can point a **public** DNS name
 * at a LAN address, so the browser sends `Host: evil.example` to a machine on the LAN. Accepting
 * only private/LAN host names closes that: the attacker cannot serve their page from a name that
 * resolves privately.
 *
 * Owner decision 1 keeps `0.0.0.0` binding, so LAN names must pass.
 *
 * @param {{ headers: Record<string, any> }} req anything with a `headers` bag
 * @param {HostPolicy} policy
 * @returns {{ allowed: boolean, reason: string }}
 */
function evaluateHost(req, policy) {
  const raw = req.headers.host;
  if (raw === undefined || raw === null || raw === "") {
    return { allowed: true, reason: "no Host header (HTTP/1.0)" };
  }

  if (policy.allowAll) {
    return { allowed: true, reason: "ALLOWED_HOSTS is *" };
  }

  const hostname = hostnameOf(String(raw));

  if (policy.allowedHosts && policy.allowedHosts.has(hostname)) {
    return { allowed: true, reason: "listed in ALLOWED_HOSTS" };
  }

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { allowed: true, reason: "localhost" };
  }

  if (hostname.endsWith(".local")) {
    return { allowed: true, reason: "mDNS name" };
  }

  if (isPrivateAddress(hostname)) {
    return { allowed: true, reason: "private-network host" };
  }

  // A bare host name with no dots cannot be a public DNS name (browsers do not resolve them
  // from the public internet), so it is a LAN machine name such as `latitude`.
  if (!hostname.includes(".") && !hostname.includes(":")) {
    return { allowed: true, reason: "single-label LAN host name" };
  }

  return { allowed: false, reason: "public-internet host refused" };
}

// --- Security headers ---------------------------------------------------------

/**
 * Headers applied to every HTML page the proxy serves.
 *
 * The log viewer renders user-supplied request and response bodies, so it is the highest-risk
 * surface in the project. The templates escape everything (`escapeHtml`), and the CSP is the
 * second line of defence. `frame-ancestors 'none'` plus `X-Frame-Options` stops clickjacking of
 * the viewer.
 */
const HTML_SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

/**
 * @param {import("http").ServerResponse} res
 */
function setHtmlSecurityHeaders(res) {
  for (const [name, value] of Object.entries(HTML_SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
}

// --- Redaction ---------------------------------------------------------------

/**
 * Header names (or name fragments) whose values must never reach a log file.
 *
 * Phase 5 extends this with `x-proxy-token` and `cookie`, and scrubs `key=` query parameters.
 */
const SECRET_HEADER_PATTERNS = ["authorization", "api-key", "proxy-token", "cookie", "set-cookie"];

/** Exact header names that hold a credential. */
const SECRET_HEADER_NAMES = ["stitch_api_key", "x-goog-api-key"];

/** Query parameters whose value must never reach a log file. */
const SECRET_QUERY_PARAMETERS = ["key", "api_key", "apikey", "access_token", "token", "idempotency-key"];

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

/**
 * Scrubs credential-bearing query parameters from a URL so it is safe to log.
 *
 * `?key=AIza...` in a logged path is a credential leak; Stitch keys and proxy tokens both travel
 * that way in misconfigured clients.
 *
 * @param {string} url
 * @returns {string}
 */
function redactUrl(url) {
  if (typeof url !== "string" || !url.includes("?")) {
    return String(url ?? "");
  }

  const [path, query] = url.split("?", 2);
  const scrubbed = query
    .split("&")
    .map((pair) => {
      const [rawName] = pair.split("=", 1);
      const name = rawName.toLowerCase();
      return SECRET_QUERY_PARAMETERS.includes(name) ? `${rawName}=[redacted]` : pair;
    })
    .join("&");

  return `${path}?${scrubbed}`;
}

module.exports = {
  SECRET_HEADER_NAMES,
  SECRET_HEADER_PATTERNS,
  SECRET_QUERY_PARAMETERS,
  HTML_SECURITY_HEADERS,
  CORS_ALLOW_HEADERS,
  isPrivateAddress,
  isLoopbackAddress,
  hostnameOf,
  originAllowedByDefault,
  evaluateOrigin,
  evaluateHost,
  setCorsHeaders,
  setHtmlSecurityHeaders,
  parseHostHeader,
  redactHeaders,
  redactUrl,
};
