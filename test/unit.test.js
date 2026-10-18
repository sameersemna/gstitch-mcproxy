// @ts-check
"use strict";

/**
 * Unit tests for the pure modules extracted in Phase 2.
 *
 * These are the payoff of the extraction: behaviour that previously could only be exercised
 * through the whole HTTP stack is now testable directly, including edge cases that are awkward
 * to reach over HTTP.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseJsonRpcMetadata,
  extractJsonRpcIds,
  extractProjectIdFromBody,
  buildLocalFallbackResponse,
} = require("../src/mcp/jsonrpc.js");
const { describeFetchError, isTransientUpstreamError } = require("../src/upstream/errors.js");
const {
  createMetrics,
  recordMetrics,
  renderPrometheusMetrics,
} = require("../src/observability/metrics.js");

// ---------------------------------------------------------------------------
// src/mcp/jsonrpc.js
// ---------------------------------------------------------------------------

test("jsonrpc: parseJsonRpcMetadata reads a single request", () => {
  const meta = parseJsonRpcMetadata(
    JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
  );
  assert.deepEqual(meta.methods, ["tools/list"]);
  assert.deepEqual(meta.ids, [7]);
});

test("jsonrpc: parseJsonRpcMetadata reads a batch", () => {
  const meta = parseJsonRpcMetadata(
    JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]),
  );
  assert.deepEqual(meta.methods, ["tools/list", "ping"]);
  assert.deepEqual(meta.ids, [1, 2]);
});

test("jsonrpc: parseJsonRpcMetadata tolerates bad input without throwing", () => {
  for (const input of [undefined, null, "", "not json", "{}", "[]", 42]) {
    assert.deepEqual(parseJsonRpcMetadata(/** @type {any} */ (input)), {
      methods: [],
      ids: [],
    });
  }
});

test("jsonrpc: extractJsonRpcIds keeps falsy-but-present ids", () => {
  assert.equal(extractJsonRpcIds('{"jsonrpc":"2.0","id":0,"method":"ping"}'), 0);
  assert.equal(extractJsonRpcIds('{"jsonrpc":"2.0","id":"","method":"ping"}'), "");
  assert.equal(extractJsonRpcIds('{"jsonrpc":"2.0","id":false,"method":"ping"}'), false);
});

test("jsonrpc: extractJsonRpcIds ignores null/absent ids and unparseable bodies", () => {
  assert.equal(extractJsonRpcIds('{"jsonrpc":"2.0","id":null,"method":"ping"}'), null);
  assert.equal(extractJsonRpcIds('{"jsonrpc":"2.0","method":"ping"}'), null);
  assert.equal(extractJsonRpcIds("nope"), null);
  assert.equal(extractJsonRpcIds(undefined), null);
});

test("jsonrpc: extractJsonRpcIds returns one id per batched request", () => {
  const ids = extractJsonRpcIds(
    JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "a" },
      { jsonrpc: "2.0", id: 2, method: "b" },
    ]),
  );
  assert.deepEqual(ids, [1, 2]);
});

test("jsonrpc: extractProjectIdFromBody reads arguments.projectId", () => {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "list_screens", arguments: { projectId: " 12345 " } },
  });
  assert.equal(extractProjectIdFromBody(body), "12345", "the ID should be trimmed");
});

test("jsonrpc: extractProjectIdFromBody accepts project_id and searches a batch", () => {
  assert.equal(
    extractProjectIdFromBody(
      JSON.stringify({ params: { arguments: { project_id: "snake-case" } } }),
    ),
    "snake-case",
  );

  assert.equal(
    extractProjectIdFromBody(
      JSON.stringify([
        { method: "tools/list" },
        { params: { arguments: { projectId: "from-batch" } } },
      ]),
    ),
    "from-batch",
  );
});

test("jsonrpc: extractProjectIdFromBody returns null when there is no usable ID", () => {
  for (const body of [
    JSON.stringify({ method: "tools/list" }),
    JSON.stringify({ params: { arguments: { projectId: 42 } } }),
    JSON.stringify({ params: { arguments: { projectId: "   " } } }),
    JSON.stringify({ params: "not an object" }),
    "not json",
    undefined,
  ]) {
    assert.equal(extractProjectIdFromBody(/** @type {any} */ (body)), null);
  }
});

test("jsonrpc: the fallback answers only the configured methods", () => {
  const methods = new Set(["prompts/list"]);

  assert.deepEqual(
    buildLocalFallbackResponse('{"jsonrpc":"2.0","id":1,"method":"prompts/list"}', methods),
    { jsonrpc: "2.0", id: 1, result: { prompts: [] } },
  );

  assert.equal(
    buildLocalFallbackResponse('{"jsonrpc":"2.0","id":1,"method":"tools/list"}', methods),
    null,
    "an unconfigured method must be forwarded upstream",
  );
});

test("jsonrpc: the fallback acknowledges a notification with no body", () => {
  assert.deepEqual(
    buildLocalFallbackResponse('{"jsonrpc":"2.0","method":"prompts/list"}', new Set(["prompts/list"])),
    { notification: true },
  );
});

test("jsonrpc: the fallback refuses batches, unparseable bodies and empty method sets", () => {
  const methods = new Set(["prompts/list"]);

  assert.equal(
    buildLocalFallbackResponse(
      JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "prompts/list" }]),
      methods,
    ),
    null,
  );
  assert.equal(buildLocalFallbackResponse("not json", methods), null);
  assert.equal(buildLocalFallbackResponse(undefined, methods), null);
  assert.equal(
    buildLocalFallbackResponse('{"jsonrpc":"2.0","id":1,"method":"prompts/list"}', new Set()),
    null,
  );
});

test("jsonrpc: the fallback returns null for a configured method with no canned result", () => {
  // The method is in the set but has no entry in EMPTY_FALLBACK_RESULTS, so it must be
  // forwarded rather than answered with a wrong shape.
  assert.equal(
    buildLocalFallbackResponse(
      '{"jsonrpc":"2.0","id":1,"method":"something/else"}',
      new Set(["something/else"]),
    ),
    null,
  );
});

test("jsonrpc: resources/list and resources/templates/list have canned results ready (finding P4)", () => {
  assert.deepEqual(
    buildLocalFallbackResponse(
      '{"jsonrpc":"2.0","id":1,"method":"resources/list"}',
      new Set(["resources/list"]),
    ),
    { jsonrpc: "2.0", id: 1, result: { resources: [] } },
  );
  assert.deepEqual(
    buildLocalFallbackResponse(
      '{"jsonrpc":"2.0","id":1,"method":"resources/templates/list"}',
      new Set(["resources/templates/list"]),
    ),
    { jsonrpc: "2.0", id: 1, result: { resourceTemplates: [] } },
  );
});

// ---------------------------------------------------------------------------
// src/upstream/errors.js
// ---------------------------------------------------------------------------

test("errors: describeFetchError surfaces error.cause", () => {
  const error = new TypeError("fetch failed");
  /** @type {any} */ (error).cause = { code: "ECONNRESET" };
  assert.equal(describeFetchError(error), "fetch failed (ECONNRESET)");
});

test("errors: describeFetchError handles missing input and cause", () => {
  assert.equal(describeFetchError(null), "Unknown error");
  assert.equal(describeFetchError(undefined), "Unknown error");
  assert.equal(describeFetchError(new Error("boom")), "boom");
  assert.equal(describeFetchError({ name: "WeirdError" }), "WeirdError");
});

test("errors: describeFetchError prefers a cause code over a cause message", () => {
  const error = new TypeError("fetch failed");
  /** @type {any} */ (error).cause = { code: "UND_ERR_SOCKET", message: "other side closed" };
  assert.equal(describeFetchError(error), "fetch failed (UND_ERR_SOCKET)");
});

test("errors: isTransientUpstreamError retries transport codes", () => {
  for (const code of ["ECONNRESET", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "EAI_AGAIN"]) {
    const error = new TypeError("fetch failed");
    /** @type {any} */ (error).cause = { code };
    assert.equal(isTransientUpstreamError(error), true, `${code} should be transient`);
  }
});

test("errors: isTransientUpstreamError treats aborts and timeouts as non-retryable", () => {
  for (const name of ["AbortError", "TimeoutError"]) {
    const error = new Error("aborted");
    error.name = name;
    assert.equal(isTransientUpstreamError(error), false, `${name} must not be retried`);
  }
});

test("errors: isTransientUpstreamError matches the legacy message patterns", () => {
  for (const message of ["socket hang up", "other side closed", "fetch failed"]) {
    assert.equal(isTransientUpstreamError(new Error(message)), true, message);
  }
  assert.equal(isTransientUpstreamError(new Error("totally fine")), false);
  assert.equal(isTransientUpstreamError(null), false);
});

// ---------------------------------------------------------------------------
// src/observability/metrics.js
// ---------------------------------------------------------------------------

test("metrics: createMetrics starts zeroed with the documented buckets", () => {
  const metrics = createMetrics();
  assert.equal(metrics.requestsTotal, 0);
  assert.equal(metrics.errorsTotal, 0);
  assert.deepEqual(Object.keys(metrics.latencyBuckets), [
    "100",
    "500",
    "1000",
    "5000",
    "30000",
    "120000",
    "Infinity",
  ]);
});

test("metrics: recordMetrics bins a duration into the first matching bucket", () => {
  const metrics = createMetrics();

  recordMetrics(metrics, { method: "GET", path: "/health", status: 200, durationMs: 50, isError: false });
  recordMetrics(metrics, { method: "GET", path: "/health", status: 200, durationMs: 200, isError: false });
  recordMetrics(metrics, { method: "GET", path: "/health", status: 500, durationMs: 200000, isError: true });

  assert.equal(metrics.requestsTotal, 3);
  assert.equal(metrics.errorsTotal, 1);
  assert.equal(metrics.requestsByMethod["GET /health"], 3);
  assert.equal(metrics.requestsByStatus["200"], 2);
  assert.equal(metrics.requestsByStatus["500"], 1);
  assert.equal(metrics.latencyBuckets[100], 1, "50ms lands in the 100ms bucket");
  assert.equal(metrics.latencyBuckets[500], 1, "200ms lands in the 500ms bucket");
  assert.equal(metrics.latencyBuckets.Infinity, 1, "200000ms lands in +Inf");
});

test("metrics: the rendered buckets are cumulative", () => {
  const metrics = createMetrics();
  recordMetrics(metrics, { method: "GET", path: "/a", status: 200, durationMs: 10, isError: false });
  recordMetrics(metrics, { method: "GET", path: "/a", status: 200, durationMs: 400, isError: false });

  const text = renderPrometheusMetrics(metrics);
  assert.match(text, /latency_seconds_bucket\{le="0\.100"\} 1/);
  assert.match(text, /latency_seconds_bucket\{le="0\.500"\} 2/);
  assert.match(text, /latency_seconds_bucket\{le="\+Inf"\} 2/);
});

test("metrics: rendering an empty snapshot still produces valid exposition text", () => {
  const text = renderPrometheusMetrics(createMetrics());

  assert.ok(text.endsWith("\n"));
  assert.match(text, /# TYPE gstitch_proxy_requests_total counter/);
  assert.match(text, /gstitch_proxy_requests_total 0/);
  assert.match(text, /gstitch_proxy_latency_seconds_count 0/);
  assert.ok(!text.includes("undefined"));
  assert.ok(!text.includes("NaN"));
});

// ---------------------------------------------------------------------------
// src/http/respond.js
// ---------------------------------------------------------------------------

const {
  escapeHtml,
  formatInlineMarkdown,
  sendJson,
  sendJsonRpcError,
} = require("../src/http/respond.js");

/**
 * Minimal `ServerResponse` stub that records what the helpers wrote.
 *
 * @returns {{
 *   rec: { written: any[], body: string, headersSent: boolean, writableEnded: boolean },
 *   stub: any,
 * }}
 */
function stubResponse() {
  const rec = {
    written: /** @type {any[]} */ ([]),
    body: "",
    headersSent: false,
    writableEnded: false,
  };
  const stub = {
    get headersSent() {
      return rec.headersSent;
    },
    get writableEnded() {
      return rec.writableEnded;
    },
    writeHead(status, headers) {
      rec.headersSent = true;
      rec.written.push({ status, headers });
      return this;
    },
    end(chunk) {
      rec.writableEnded = true;
      if (typeof chunk === "string") {
        rec.body += chunk;
      }
      return this;
    },
  };
  return { rec, stub };
}

test("respond: escapeHtml escapes every dangerous character", () => {
  assert.equal(
    escapeHtml(`<script>alert("x")</script> & 'quoted'`),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;",
  );
  assert.equal(escapeHtml(null), "null");
  assert.equal(escapeHtml(42), "42");
});

test("respond: a logged body containing <script> renders inert", () => {
  // This is the XSS regression guard for the log viewer: escaping happens before any markup
  // is reintroduced.
  const rendered = formatInlineMarkdown("body: <script>alert(1)</script> `ok`");
  assert.ok(!rendered.includes("<script>"), rendered);
  assert.ok(rendered.includes("&lt;script&gt;"), rendered);
  assert.ok(rendered.includes("<code>ok</code>"), rendered);
});

test("respond: formatInlineMarkdown cannot be tricked into emitting markup from backticks", () => {
  const rendered = formatInlineMarkdown("`<img src=x onerror=alert(1)>`");
  assert.ok(!rendered.includes("<img"), rendered);
  assert.ok(rendered.includes("&lt;img"), rendered);
});

test("respond: sendJson sets a Content-Length that matches the body", () => {
  const { rec, stub } = stubResponse();
  sendJson(stub, 201, { a: 1 });

  assert.equal(rec.written[0].status, 201);
  assert.equal(rec.written[0].headers["Content-Type"], "application/json");
  assert.equal(rec.written[0].headers["Content-Length"], String(Buffer.byteLength(rec.body)));
  assert.equal(rec.body, '{"a":1}');
});

test("respond: sendJson with head omits the body but keeps Content-Length", () => {
  const { rec, stub } = stubResponse();
  sendJson(stub, 200, { big: "x".repeat(100) }, { head: true });

  assert.equal(rec.body, "", "HEAD must not return a body");
  assert.ok(Number(rec.written[0].headers["Content-Length"]) > 100);
});

test("respond: sendJsonRpcError echoes a single id", () => {
  const { rec, stub } = stubResponse();
  sendJsonRpcError(stub, 502, -32006, "boom", "req-1");

  assert.equal(rec.written[0].status, 502);
  assert.deepEqual(JSON.parse(rec.body), {
    jsonrpc: "2.0",
    error: { code: -32006, message: "boom" },
    id: "req-1",
  });
});

test("respond: sendJsonRpcError emits one error object per batched id", () => {
  const { rec, stub } = stubResponse();
  sendJsonRpcError(stub, 401, -32007, "missing key", [1, 2]);

  const body = JSON.parse(rec.body);
  assert.ok(Array.isArray(body));
  assert.deepEqual(
    body.map((entry) => entry.id),
    [1, 2],
  );
  for (const entry of body) {
    assert.equal(entry.error.code, -32007);
  }
});

test("respond: sendJsonRpcError keeps falsy ids, including 0", () => {
  const { rec, stub } = stubResponse();
  sendJsonRpcError(stub, 400, -32600, "bad", 0);
  assert.equal(JSON.parse(rec.body).id, 0);
});

test("respond: sendJsonRpcError never writes twice once the response started", () => {
  // The ★C5 class of bug: writing headers after a stream has been sent threw
  // ERR_HTTP_HEADERS_SENT and killed the process. The helper must be a no-op instead.
  const { rec, stub } = stubResponse();
  stub.writeHead(200, {});
  stub.end("streamed");

  const before = rec.written.length;
  sendJsonRpcError(stub, 500, -32603, "too late", 1);

  assert.equal(rec.written.length, before, "no second writeHead may happen");
  assert.equal(rec.body, "streamed", "the already-sent body must be untouched");
});

// ---------------------------------------------------------------------------
// src/http/security.js
// ---------------------------------------------------------------------------

const {
  evaluateOrigin,
  originAllowedByDefault,
  parseHostHeader,
  redactHeaders,
} = require("../src/http/security.js");

/**
 * @param {Record<string, any>} headers
 * @param {string} [url]
 */
function fakeRequest(headers, url = "/mcp") {
  return /** @type {any} */ ({ url, headers, socket: { remoteAddress: "127.0.0.1" } });
}

test("security: evaluateOrigin allows non-browser clients and LAN origins", () => {
  assert.equal(evaluateOrigin(undefined, { corsOrigin: undefined }).allowed, true);
  assert.equal(evaluateOrigin("http://localhost:3000", { corsOrigin: undefined }).allowed, true);
  assert.equal(evaluateOrigin("http://192.168.1.4:8080", { corsOrigin: undefined }).allowed, true);
});

test("security: a public origin is refused by default (Phase 5 ★C3)", () => {
  // Pinned deliberately: this is the fix for the finding, not an accident.
  assert.equal(originAllowedByDefault("https://evil.example"), false);
  assert.equal(evaluateOrigin("https://evil.example", { corsOrigin: undefined }).allowed, false);
});

test("security: '*' restores the old permissive behaviour", () => {
  // Pinned on purpose: this is now opt-in.
  assert.equal(evaluateOrigin("https://evil.example", { corsOrigin: "*" }).allowed, true);
});

test("security: a specific origin only accepts itself", () => {
  assert.equal(
    evaluateOrigin("https://good.example", { corsOrigin: "https://good.example" }).allowed,
    true,
  );
  assert.equal(
    evaluateOrigin("https://evil.example", { corsOrigin: "https://good.example" }).allowed,
    false,
  );
});

test("security: parseHostHeader accepts the usual forms", () => {
  for (const host of ["localhost", "localhost:8787", "127.0.0.1:11401", "example.com", "[::1]:80"]) {
    const result = parseHostHeader(fakeRequest({ host }));
    assert.equal(result.reason, null, `${host} should be accepted`);
    assert.equal(typeof result.host, "string");
  }
});

test("security: parseHostHeader accepts a request with no Host (HTTP/1.0)", () => {
  assert.deepEqual(parseHostHeader(fakeRequest({})), { host: null, reason: null });
  assert.deepEqual(parseHostHeader(fakeRequest({ host: "" })), { host: null, reason: null });
});

test("security: parseHostHeader rejects malformed values without throwing", () => {
  const cases = [
    "[bad",
    "has space",
    "host/path",
    "user@host",
    "host?query",
    "host:99999",
    "host:0",
    "[::1",
  ];
  for (const host of cases) {
    const result = parseHostHeader(fakeRequest({ host }));
    assert.notEqual(result.reason, null, `${host} should be rejected`);
  }
});

test("security: parseHostHeader rejects a duplicated Host header", () => {
  const result = parseHostHeader(fakeRequest({ host: ["a.example", "b.example"] }));
  assert.match(String(result.reason), /duplicate/i);
});

test("security: redactHeaders masks every credential header", () => {
  const redacted = redactHeaders({
    authorization: "Bearer secret",
    "x-stitch-api-key": "secret2",
    stitch_api_key: "secret3",
    "x-goog-api-key": "secret4",
    "content-type": "application/json",
  });

  assert.equal(redacted.authorization, "[redacted]");
  assert.equal(redacted["x-stitch-api-key"], "[redacted]");
  assert.equal(redacted.stitch_api_key, "[redacted]");
  assert.equal(redacted["x-goog-api-key"], "[redacted]");
  assert.equal(redacted["content-type"], "application/json", "safe headers must survive");

  assert.ok(!JSON.stringify(redacted).includes("secret"));
});

test("security: redactHeaders tolerates missing headers", () => {
  assert.deepEqual(redactHeaders(undefined), {});
  assert.deepEqual(redactHeaders(null), {});
});

// ---------------------------------------------------------------------------
// src/http/ratelimit.js
// ---------------------------------------------------------------------------

const { getClientIp, checkRateLimit, sweepRateLimitBuckets } = require("../src/http/ratelimit.js");

test("ratelimit: disabled means always allowed and no bucket allocated", () => {
  const buckets = new Map();
  const decision = checkRateLimit(buckets, { enabled: false, maxRps: 1, burst: 1 }, "1.2.3.4");
  assert.equal(decision.allowed, true);
  assert.equal(buckets.size, 0);
});

test("ratelimit: the burst is consumed then refilled over time", () => {
  const buckets = new Map();
  const config = { enabled: true, maxRps: 2, burst: 3 };
  const t0 = 1_000_000;

  for (let i = 0; i < 3; i += 1) {
    assert.equal(checkRateLimit(buckets, config, "ip", t0).allowed, true, `burst ${i + 1}`);
  }

  const blocked = checkRateLimit(buckets, config, "ip", t0);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfter, 1, "retryAfter is ceil(1/maxRps)");

  // 500ms at 2 rps = one token back.
  assert.equal(checkRateLimit(buckets, config, "ip", t0 + 500).allowed, true);
});

test("ratelimit: buckets are per client", () => {
  const buckets = new Map();
  const config = { enabled: true, maxRps: 1, burst: 1 };

  assert.equal(checkRateLimit(buckets, config, "a", 0).allowed, true);
  assert.equal(checkRateLimit(buckets, config, "a", 0).allowed, false);
  assert.equal(checkRateLimit(buckets, config, "b", 0).allowed, true, "b has its own bucket");
});

test("ratelimit: refill is capped at the burst size", () => {
  const buckets = new Map();
  const config = { enabled: true, maxRps: 10, burst: 2 };
  checkRateLimit(buckets, config, "ip", 0);
  checkRateLimit(buckets, config, "ip", 0);
  assert.equal(buckets.get("ip").tokens, 0, "both burst tokens consumed");

  // A long idle period would refill far more than the burst allows, then this call spends one.
  checkRateLimit(buckets, config, "ip", 1_000_000);
  assert.equal(buckets.get("ip").tokens, 1, "refill is capped at burst (2) minus the spent token");
});

test("ratelimit: sweepRateLimitBuckets drops only stale entries", () => {
  const now = 1_000_000;
  const buckets = new Map([
    ["fresh", { tokens: 1, lastRefill: now - 1000 }],
    ["stale", { tokens: 1, lastRefill: now - 400_000 }],
  ]);

  const removed = sweepRateLimitBuckets(buckets, now, 300000);
  assert.equal(removed, 1);
  assert.ok(buckets.has("fresh"));
  assert.ok(!buckets.has("stale"));
});

test("ratelimit: getClientIp reads X-Forwarded-For (baseline ★N4 behaviour)", () => {
  // Pinned on purpose: the first hop is trusted unconditionally, which lets a client spoof its
  // address. Phase 5 gates this behind TRUST_PROXY; this test will then be updated deliberately.
  assert.equal(
    getClientIp(fakeRequest({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" })),
    "9.9.9.9",
  );
  assert.equal(getClientIp(/** @type {any} */ ({ headers: {}, socket: { remoteAddress: "::1" } })), "::1");
  assert.equal(getClientIp(/** @type {any} */ ({ headers: {}, socket: {} })), "unknown");
});

// ---------------------------------------------------------------------------
// Multi-instance guard (the Phase 2 limitation, made explicit)
// ---------------------------------------------------------------------------

test("instances: two proxies with different configuration cannot listen simultaneously", async (t) => {
  const { createProxyServer } = require("../index.js");
  const { once } = require("node:events");

  const first = createProxyServer({
    env: { LOG_ENABLED: "false", CORS_ORIGIN: "https://one.example" },
  });
  first.listen(0, "127.0.0.1");
  await once(first, "listening");
  t.after(async () => {
    first.closeAllConnections();
    await new Promise((resolve) => first.close(() => resolve()));
  });

  assert.throws(
    () =>
      createProxyServer({
        env: { LOG_ENABLED: "false", CORS_ORIGIN: "https://two.example" },
      }),
    /process-global/,
    "a second, differently-configured proxy must be refused rather than silently reconfiguring the first",
  );
});

test("instances: two proxies with identical configuration may coexist", async (t) => {
  const { createProxyServer } = require("../index.js");
  const { once } = require("node:events");

  /** @param {import("node:test").TestContext} ctx */
  const start = async (ctx) => {
    const server = createProxyServer({ env: { LOG_ENABLED: "false", CORS_ORIGIN: "*" } });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    ctx.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    });
    return server;
  };

  const a = await start(t);
  const b = await start(t);

  const portOf = (server) => /** @type {any} */ (server.address()).port;
  assert.notEqual(portOf(a), portOf(b));

  for (const server of [a, b]) {
    const port = portOf(server);
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    await response.text();
  }
});
