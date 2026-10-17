// @ts-check
"use strict";

/**
 * Characterization tests: they pin down the behaviour of commit `2578c26` so that the
 * refactors in later phases cannot silently change it.
 *
 * These tests describe what the proxy does *today*, including the parts that are bugs
 * (those are tracked separately in `bugs.test.js`). If one of these tests has to change,
 * the change must be deliberate and recorded in `PROGRESS.md`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { startProxy } = require("./helpers/startProxy.js");
const { startFakeStitch } = require("./helpers/fakeStitch.js");
const { readJson } = require("./helpers/startProxy.js");

test("route: GET /health returns the full status document", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: "env-key", DEFAULT_STITCH_PROJECT_ID: "proj-1" });
  t.after(() => proxy.stop());

  const response = await proxy.request("/health");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /application\/json/);

  const body = await readJson(response);
  assert.equal(body.status, "ok");
  assert.equal(typeof body.timestamp, "string");

  // Shape that other tools and humans already depend on.
  assert.equal(body.proxy.stitchUrl, "http://127.0.0.1:1/mcp");
  assert.equal(body.credentials.envApiKeyConfigured, true);
  assert.equal(body.credentials.envProjectIdConfigured, true);
  assert.equal(body.credentials.gcloudFallbackEnabled, false);
  assert.equal(body.logging.enabled, false);
  assert.equal(body.logging.level, "info");
  assert.equal(body.resilience.requestTimeoutMs, 120000);
  assert.equal(body.resilience.maxBodySizeBytes, 10485760);
  assert.equal(body.resilience.corsOrigin, "*");
  assert.equal(body.resilience.upstreamRetryEnabled, true);
  assert.equal(body.resilience.upstreamRetryAttempts, 3);
  assert.deepEqual(body.resilience.localFallbackMethods, ["prompts/list"]);
  assert.equal(body.metrics.enabled, false);
  assert.equal(typeof body.metrics.requestsTotal, "number");
  assert.equal(typeof body.metrics.uptimeSeconds, "number");
});

test("route: GET /health with only an env API key marks the project ID as unconfigured", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: "env-key" });
  t.after(() => proxy.stop());

  const body = await readJson(await proxy.request("/health"));
  assert.equal(body.credentials.envApiKeyConfigured, true);
  assert.equal(body.credentials.envProjectIdConfigured, false);
  assert.match(body.credentials.projectConfigHint, /STITCH_PROJECT_ID/);
});

test("route: GET /metrics emits the Prometheus text format with stable metric names", async (t) => {
  const proxy = await startProxy({ METRICS_ENABLED: true });
  t.after(() => proxy.stop());

  // Generate one data point so the label series exist.
  await proxy.request("/health");

  const response = await proxy.request("/metrics");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/plain/);

  const text = await response.text();

  // Metric names are part of the public contract: dashboards depend on them.
  for (const name of [
    "gstitch_proxy_uptime_seconds",
    "gstitch_proxy_requests_total",
    "gstitch_proxy_errors_total",
    "gstitch_proxy_active_connections",
    "gstitch_proxy_rate_limited_total",
    "gstitch_proxy_requests_by_method",
    "gstitch_proxy_requests_by_status",
    "gstitch_proxy_latency_seconds_bucket",
    "gstitch_proxy_latency_seconds_count",
    "gstitch_proxy_latency_seconds_sum",
  ]) {
    assert.ok(text.includes(name), `expected metric "${name}" in /metrics output`);
  }

  // Histogram bounds and the `+Inf` bucket.
  for (const le of ["0.100", "0.500", "1.000", "5.000", "30.000", "120.000", "+Inf"]) {
    assert.ok(
      text.includes(`gstitch_proxy_latency_seconds_bucket{le="${le}"}`),
      `expected latency bucket le="${le}"`,
    );
  }

  assert.ok(text.endsWith("\n"), "Prometheus output must end with a newline");
});

test("route: GET /metrics is absent when METRICS_ENABLED=false", async (t) => {
  const proxy = await startProxy({ METRICS_ENABLED: false });
  t.after(() => proxy.stop());

  const response = await proxy.request("/metrics");
  assert.equal(response.status, 404);
  assert.equal((await readJson(response)).error.code, -32601);
});

test("route: GET /instructions negotiates HTML, JSON and Markdown via Accept", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.stop());

  const html = await proxy.request("/instructions");
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type") || "", /text\/html/);
  assert.match(await html.text(), /<!doctype html>/i);

  const json = await proxy.request("/instructions", { headers: { Accept: "application/json" } });
  assert.match(json.headers.get("content-type") || "", /application\/json/);
  const parsed = await readJson(json);
  assert.equal(typeof parsed.title, "string");
  assert.ok(Array.isArray(parsed.sections));
  assert.ok(Array.isArray(parsed.usageMapping));
  assert.ok(Array.isArray(parsed.observations));

  const markdown = await proxy.request("/instructions", {
    headers: { Accept: "text/markdown" },
  });
  assert.match(markdown.headers.get("content-type") || "", /text\/markdown/);
  assert.match(await markdown.text(), /#/);
});

test("route: log viewer endpoints are served while LOG_VIEWER_ENABLED is true", async (t) => {
  const proxy = await startProxy({ LOG_VIEWER_ENABLED: true, LOG_DIR: "test/helpers/fixtures/logs" });
  t.after(() => proxy.stop());

  const viewer = await proxy.request("/logs");
  assert.equal(viewer.status, 200);
  assert.match(viewer.headers.get("content-type") || "", /text\/html/);

  const index = await proxy.request("/api/logs");
  assert.equal(index.status, 200);
  const body = await readJson(index);
  assert.equal(typeof body.logDir, "string");
  assert.equal(typeof body.summaryLog, "object");
  assert.ok(Array.isArray(body.projects));

  const summary = await proxy.request("/api/logs/summary?limit=5");
  assert.equal(summary.status, 200);
  const summaryBody = await readJson(summary);
  assert.ok(Array.isArray(summaryBody.lines));
  assert.equal(typeof summaryBody.total, "number");
  assert.equal(summaryBody.offset, 0);
});

test("route: /logs returns 404 when the log viewer is disabled", async (t) => {
  const proxy = await startProxy({ LOG_VIEWER_ENABLED: false });
  t.after(() => proxy.stop());

  const response = await proxy.request("/logs");
  assert.equal(response.status, 404);
  assert.match((await readJson(response)).error, /disabled/i);
});

test("KNOWN GAP: /api/logs* is still served when LOG_VIEWER_ENABLED=false", async (t) => {
  // Finding N1 (discovered while writing these tests): the "viewer disabled" guard is
  // `url.pathname.startsWith("/logs")`, which never matches `/api/logs` or
  // `/api/logs/summary`. Disabling the log viewer therefore hides the HTML page but leaves
  // the JSON APIs — directory listing and raw log contents — fully reachable.
  // Phase 5 (finding ★C4) closes this. Until then this test pins the current behaviour so the
  // fix shows up as a deliberate change.
  const proxy = await startProxy({
    LOG_VIEWER_ENABLED: false,
    LOG_DIR: "test/helpers/fixtures/logs",
  });
  t.after(() => proxy.stop());

  const index = await proxy.request("/api/logs");
  assert.equal(index.status, 200, "/api/logs leaks the log directory layout");
  const indexBody = await readJson(index);
  assert.ok(indexBody.projects.some((p) => p.projectId === "1234567890"));

  const summary = await proxy.request("/api/logs/summary?limit=1");
  assert.equal(summary.status, 200, "/api/logs/summary leaks log lines");

  const file = await proxy.request("/api/logs/1234567890/2026-01-01T00-00-00-000Z-abc123.log");
  assert.equal(file.status, 200, "raw log files are readable while the viewer is disabled");
  assert.match(await file.text(), /line-one/);
});

test("route: path traversal in the log file API is rejected with 403", async (t) => {
  const proxy = await startProxy({ LOG_VIEWER_ENABLED: true, LOG_DIR: "logs" });
  t.after(() => proxy.stop());

  const response = await proxy.request("/api/logs/..%2f..%2f..%2fetc/passwd");
  assert.equal(response.status, 403);
  assert.match((await readJson(response)).error, /invalid path/i);
});

test("route: /.well-known, /auth and /token stubs respond for OAuth discovery", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.stop());

  const protectedResource = await proxy.request("/.well-known/oauth-protected-resource");
  assert.equal(protectedResource.status, 200);
  const prBody = await readJson(protectedResource);
  assert.ok(Array.isArray(prBody.authorization_servers));

  const openid = await proxy.request("/.well-known/openid-configuration");
  assert.equal(openid.status, 200);
  const oidcBody = await readJson(openid);
  assert.match(oidcBody.authorization_endpoint, /\/auth$/);
  assert.match(oidcBody.token_endpoint, /\/token$/);

  const auth = await proxy.request("/auth");
  assert.equal(auth.status, 200);
  assert.equal(await auth.text(), "OK");

  const token = await proxy.request("/token", { method: "POST" });
  assert.equal(token.status, 200);
  assert.deepEqual(await readJson(token), { access_token: "local-proxy-token" });
});

test("route: unknown paths return JSON-RPC -32601 with HTTP 404", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.stop());

  const response = await proxy.request("/definitely-not-a-route");
  assert.equal(response.status, 404);
  assert.deepEqual(await readJson(response), {
    jsonrpc: "2.0",
    error: { code: -32601, message: "Not found: GET /definitely-not-a-route" },
    id: null,
  });
});

test("route: OPTIONS preflight answers 204 for any path", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.stop());

  for (const path of ["/mcp", "/health", "/anything"]) {
    const response = await proxy.request(path, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(response.status, 204, `OPTIONS ${path}`);
  }
});

test("route: /mcp rejects non-POST methods with 405 and an Allow header", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.stop());

  for (const method of ["GET", "DELETE", "PUT", "PATCH"]) {
    const response = await proxy.request("/mcp", { method });
    assert.equal(response.status, 405, `${method} /mcp should be 405`);
    assert.equal(response.headers.get("allow"), "POST, OPTIONS");
    const body = await readJson(response);
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.error.code, -32005);
    assert.equal(body.id, null);
  }
});

test("route: /mcp with an over-sized body returns 413 and -32003", async (t) => {
  // The credential check runs *before* the body is read, so an API key must be supplied for
  // the 413 path to be reachable at all.
  const proxy = await startProxy({ MAX_BODY_SIZE_BYTES: 64, STITCH_API_KEY: "env-key" });
  t.after(() => proxy.stop());

  const response = await proxy.postJson(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(200) } },
  );
  assert.equal(response.status, 413);
  const body = await readJson(response);
  assert.equal(body.error.code, -32003);
  assert.match(body.error.message, /too large/);
});

test("KNOWN GAP: an over-sized body from an unauthenticated caller returns 401, not 413", async (t) => {
  // Finding N2 (discovered while writing these tests): because the credential check runs
  // before the body reader, the size limit is never enforced for unauthenticated callers.
  // The 401 arrives *before* any body bytes are consumed, so the request is answered without
  // reading (and without bounding) the payload. Phase 1 reorders/clamps this so the proxy
  // never accepts an unbounded body.
  const proxy = await startProxy({ MAX_BODY_SIZE_BYTES: 64, STITCH_API_KEY: undefined });
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(response.status, 401, "the credential check short-circuits before the size limit");
});

test("route: /mcp without any credential returns 401 and -32007", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: undefined });
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(response.status, 401);
  const body = await readJson(response);
  assert.equal(body.error.code, -32007);
  assert.match(body.error.message, /Missing API key/);
});

test("credential precedence: Authorization Basic > x-stitch-api-key > STITCH_API_KEY header > env", async (t) => {
  const upstream = await startFakeStitch();
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    {
      headers: {
        Authorization: `Basic ${Buffer.from("proj:basic-key").toString("base64")}`,
        "x-stitch-api-key": "x-stitch-key",
        STITCH_API_KEY: "underscore-header-key",
      },
    },
  );

  const [received] = upstream.requests();
  assert.equal(received.headers["x-goog-api-key"], "basic-key");
});

test("credential precedence: x-stitch-api-key wins over the STITCH_API_KEY header", async (t) => {
  const upstream = await startFakeStitch();
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { headers: { "x-stitch-api-key": "x-stitch-key", STITCH_API_KEY: "underscore-header-key" } },
  );

  assert.equal(upstream.requests()[0].headers["x-goog-api-key"], "x-stitch-key");
});

test("credential precedence: the STITCH_API_KEY header wins over the env value", async (t) => {
  const upstream = await startFakeStitch();
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { headers: { STITCH_API_KEY: "underscore-header-key" } },
  );

  assert.equal(upstream.requests()[0].headers["x-goog-api-key"], "underscore-header-key");
});

test("credential precedence: the env value is used when no header is present", async (t) => {
  const upstream = await startFakeStitch();
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });

  assert.equal(upstream.requests()[0].headers["x-goog-api-key"], "env-key");
});

test("credential precedence: Basic auth without a colon is treated as the whole key", async (t) => {
  const upstream = await startFakeStitch();
  const proxy = await startProxy({ STITCH_URL: upstream.url });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { headers: { Authorization: `Basic ${Buffer.from("just-a-key").toString("base64")}` } },
  );

  assert.equal(upstream.requests()[0].headers["x-goog-api-key"], "just-a-key");
});

test("local fallback: prompts/list is answered locally and never reaches the upstream", async (t) => {
  const upstream = await startFakeStitch();
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const body = await proxy.postJsonForJson("/mcp", {
    jsonrpc: "2.0",
    id: 11,
    method: "prompts/list",
    params: {},
  });

  assert.deepEqual(body, { jsonrpc: "2.0", id: 11, result: { prompts: [] } });
  assert.equal(upstream.count(), 0, "fallback must not hit the upstream");
});

test("local fallback: a prompts/list notification is acknowledged with 202 and no body", async (t) => {
  const upstream = await startFakeStitch();
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", { jsonrpc: "2.0", method: "prompts/list" });
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "");
  assert.equal(upstream.count(), 0);
});

test("local fallback: disabled by an empty LOCAL_FALLBACK_METHODS, so the call is forwarded", async (t) => {
  const upstream = await startFakeStitch({ type: "json", body: { jsonrpc: "2.0", id: 12, result: {} } });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    LOCAL_FALLBACK_METHODS: new Set(),
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson("/mcp", { jsonrpc: "2.0", id: 12, method: "prompts/list", params: {} });
  assert.equal(upstream.count(), 1);
  assert.equal(upstream.requests()[0].rpcMethod, "prompts/list");
});

test("rate limiting: off by default, so no 429", async (t) => {
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  for (let i = 0; i < 25; i += 1) {
    const response = await proxy.postJson("/mcp", { jsonrpc: "2.0", id: i, method: "tools/list" });
    assert.notEqual(response.status, 429, `request ${i} must not be rate limited by default`);
  }
});

test("rate limiting: when enabled, the burst is consumed and then 429 -32002 with Retry-After", async (t) => {
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    RATE_LIMIT_ENABLED: true,
    RATE_LIMIT_MAX_RPS: 1,
    RATE_LIMIT_BURST: 3,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const statuses = [];
  for (let i = 0; i < 5; i += 1) {
    statuses.push(
      (await proxy.postJson("/mcp", { jsonrpc: "2.0", id: i, method: "tools/list" })).status,
    );
  }

  assert.equal(statuses.filter((s) => s === 200).length, 3, "burst of 3 should succeed");
  const limited = statuses.filter((s) => s === 429);
  assert.equal(limited.length, 2, "the remainder should be 429");

  const response = await proxy.postJson("/mcp", { jsonrpc: "2.0", id: 99, method: "tools/list" });
  assert.equal(response.status, 429);
  assert.ok(response.headers.get("retry-after"));
  const body = await readJson(response);
  assert.equal(body.error.code, -32002);

  // BEHAVIOUR CHANGED IN PHASE 1 (finding ★P2): the 429 body used to carry `id: null` even
  // though the request carried `id: 99`, which left the client waiting on a pending call that
  // would never resolve. The id is now echoed. See `test/phase1.test.js`.
  assert.equal(body.id, 99, "the 429 must echo the request id");
});

test("CORS: default CORS_ORIGIN=* echoes a wildcard on every route", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.stop());

  for (const path of ["/mcp", "/health", "/metrics", "/api/logs"]) {
    const response = await proxy.request(path, { headers: { Origin: "https://evil.example" } });
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      "*",
      `${path} should echo a wildcard origin under the default config`,
    );
  }
});

test("CORS: a specific CORS_ORIGIN reflects the request origin", async (t) => {
  const proxy = await startProxy({ CORS_ORIGIN: "https://good.example" });
  t.after(() => proxy.stop());

  const response = await proxy.request("/health", { headers: { Origin: "https://good.example" } });
  assert.equal(response.headers.get("access-control-allow-origin"), "https://good.example");

  const other = await proxy.request("/health", { headers: { Origin: "https://other.example" } });
  assert.equal(other.headers.get("access-control-allow-origin"), "https://other.example");
});

test("CORS: preflight advertises the documented methods and headers", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.stop());

  const response = await proxy.request("/mcp", { method: "OPTIONS" });
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
  assert.equal(response.headers.get("access-control-max-age"), "86400");
  const allowed = response.headers.get("access-control-allow-headers") || "";
  for (const header of ["Content-Type", "Authorization", "STITCH_API_KEY", "X-Stitch-Api-Key", "Accept"]) {
    assert.ok(allowed.includes(header), `preflight should allow ${header}`);
  }
});

test("origin validation: /mcp allows localhost origins and browsers with no Origin header", async (t) => {
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    LOCAL_FALLBACK_METHODS: new Set(),
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  for (const origin of [undefined, "http://localhost:3000", "http://127.0.0.1:5000"]) {
    const response = await proxy.postJson(
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      origin ? { headers: { Origin: origin } } : {},
    );
    assert.equal(response.status, 200, `origin ${origin} should be accepted`);
  }
});

test("upstream success: a JSON response is forwarded with its content type", async (t) => {
  const upstream = await startFakeStitch({
    type: "json",
    status: 200,
    body: { jsonrpc: "2.0", id: 5, result: { tools: [] } },
  });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", { jsonrpc: "2.0", id: 5, method: "tools/list" });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  assert.deepEqual(await readJson(response), { jsonrpc: "2.0", id: 5, result: { tools: [] } });
});

test("upstream success: an upstream error status is passed through verbatim", async (t) => {
  const upstream = await startFakeStitch({
    type: "status",
    status: 403,
    body: JSON.stringify({ jsonrpc: "2.0", id: 6, error: { code: -32000, message: "nope" } }),
  });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", { jsonrpc: "2.0", id: 6, method: "tools/list" });
  assert.equal(response.status, 403);
  assert.deepEqual(await readJson(response), {
    jsonrpc: "2.0",
    id: 6,
    error: { code: -32000, message: "nope" },
  });
});

test("upstream request shape: credentials, project ID, content type and accept are forwarded", async (t) => {
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    DEFAULT_STITCH_PROJECT_ID: "proj-42",
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson(
    "/mcp",
    { jsonrpc: "2.0", id: 7, method: "tools/list" },
    { headers: { Accept: "application/json, text/event-stream" } },
  );

  const [received] = upstream.requests();
  assert.equal(received.method, "POST");
  assert.equal(received.headers["x-goog-api-key"], "env-key");
  assert.equal(received.headers["x-stitch-project-id"], "proj-42");
  assert.equal(received.headers["content-type"], "application/json");
  assert.equal(received.headers.accept, "application/json, text/event-stream");
  assert.deepEqual(received.json, { jsonrpc: "2.0", id: 7, method: "tools/list" });
});

test("upstream failure: a connect-phase failure returns 502 with -32006", async (t) => {
  // Port 1 on loopback refuses quickly, which is a connect-phase error.
  const proxy = await startProxy({
    STITCH_URL: "http://127.0.0.1:1/mcp",
    STITCH_API_KEY: "env-key",
    UPSTREAM_RETRY_ENABLED: false,
  });
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", { jsonrpc: "2.0", id: 8, method: "tools/list" });
  assert.equal(response.status, 502);
  const body = await readJson(response);
  assert.equal(body.error.code, -32006);
  assert.match(body.error.message, /Upstream request to Stitch failed/);
});

test("upstream failure: a timeout returns 504 with -32004", async (t) => {
  const upstream = await startFakeStitch({ type: "hang" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    REQUEST_TIMEOUT_MS: 150,
    UPSTREAM_RETRY_ENABLED: false,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", { jsonrpc: "2.0", id: 9, method: "tools/list" });
  assert.equal(response.status, 504);
  const body = await readJson(response);
  assert.equal(body.error.code, -32004);
  assert.match(body.error.message, /timed out after 150ms/);
});

test("streaming: an SSE response is forwarded as text/event-stream, chunk by chunk", async (t) => {
  const upstream = await startFakeStitch({
    type: "sse",
    events: ['event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"a":1}}\n\n'],
    endAfterMs: 20,
  });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    rawBody: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.match(await response.text(), /"a":1/);
});

test("method guard: a JSON-RPC notification for an unknown method is forwarded, not answered", async (t) => {
  const upstream = await startFakeStitch({ type: "json", status: 202, body: "" });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assert.equal(response.status, 202);
  assert.equal(upstream.count(), 1);
});

test("logging: LOG_ENABLED writes the summary log lines for a request", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstitch-logs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    LOG_ENABLED: true,
    LOG_LEVEL: "info",
    LOG_DIR: dir,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson("/mcp", { jsonrpc: "2.0", id: 21, method: "tools/list" });

  const logFile = path.join(dir, "proxy.log");
  assert.ok(fs.existsSync(logFile), `expected ${logFile} to exist`);

  const contents = fs.readFileSync(logFile, "utf8");
  assert.match(contents, /RPC: tools\/list/);
  assert.match(contents, /API_KEY: configured/);
  assert.match(contents, /STATUS: 200/);
  assert.match(contents, /LATENCY: NORMAL/);
});

test("logging: debug level writes a per-project detail file with redacted credentials", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstitch-logs-debug-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    LOG_ENABLED: true,
    LOG_LEVEL: "debug",
    LOG_DIR: dir,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson(
    "/mcp",
    { jsonrpc: "2.0", id: 22, method: "tools/list" },
    { headers: { "x-stitch-api-key": "super-secret" } },
  );

  const projectDir = path.join(dir, "unknown-project");
  assert.ok(fs.existsSync(projectDir), "expected a per-project debug directory");

  const files = fs.readdirSync(projectDir);
  assert.ok(files.length > 0, "expected at least one debug log file");

  const contents = fs.readFileSync(path.join(projectDir, files[0]), "utf8");
  assert.match(contents, /requestLogId:/);
  assert.match(contents, /method: POST/);
  assert.match(contents, /path: \/mcp/);
  assert.ok(!contents.includes("super-secret"), "the API key must never be written to disk");
  assert.match(contents, /\[redacted\]/);
});

test("logging: LOG_SKIP_MCP_METHODS suppresses detail logs for noisy methods", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstitch-logs-skip-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    LOG_ENABLED: true,
    LOG_LEVEL: "debug",
    LOG_DIR: dir,
    LOG_SKIP_MCP_METHODS: new Set(["initialize"]),
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson("/mcp", { jsonrpc: "2.0", id: 23, method: "initialize" });

  const projectDir = path.join(dir, "unknown-project");
  const files = fs.existsSync(projectDir) ? fs.readdirSync(projectDir) : [];
  assert.equal(files.length, 0, "skipped methods must not produce a detail log");
});

test("body parsing: an invalid JSON body is still forwarded upstream unchanged", async (t) => {
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson("/mcp", "{not json at all", { headers: { "Content-Type": "text/plain" } });

  assert.equal(upstream.count(), 1);
  assert.equal(upstream.requests()[0].body, "{not json at all");
});
