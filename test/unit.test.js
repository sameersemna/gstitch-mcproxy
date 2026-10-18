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
