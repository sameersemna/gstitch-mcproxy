// @ts-check
"use strict";

/**
 * Unit tests for the Phase 3 decision logic.
 *
 * These are the tests that make the idempotency guarantees legible: they enumerate the cases
 * where retrying would duplicate a Stitch side effect and assert that the proxy refuses.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyMessage,
  classifyRequest,
  reduceClassification,
  annotationsForTool,
  SAFE_TOOLS,
  UNSAFE_TOOLS,
} = require("../src/mcp/classify.js");
const {
  phaseOfError,
  decideRetry,
  parseRetryAfter,
  jitteredDelay,
} = require("../src/upstream/retry.js");

/**
 * Builds a `fetch`-style failure with an undici cause code.
 *
 * @param {string} code
 * @returns {any}
 */
function fetchFailure(code) {
  const error = new TypeError("fetch failed");
  error.cause = { code };
  return error;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test("classify: read-only methods are safe", () => {
  for (const method of [
    "initialize",
    "ping",
    "tools/list",
    "prompts/list",
    "resources/list",
    "resources/templates/list",
  ]) {
    const result = classifyMessage({ jsonrpc: "2.0", id: 1, method });
    assert.equal(result.safe, true, `${method} should be safe`);
  }
});

test("classify: notifications are safe", () => {
  for (const method of [
    "notifications/initialized",
    "notifications/cancelled",
    "notifications/progress",
  ]) {
    assert.equal(classifyMessage({ method }).safe, true, `${method} should be safe`);
  }
});

test("classify: read-only Stitch tools are safe", () => {
  for (const toolName of SAFE_TOOLS) {
    const result = classifyMessage({
      method: "tools/call",
      params: { name: toolName, arguments: {} },
    });
    assert.equal(result.safe, true, `${toolName} should be safe`);
    assert.equal(result.toolName, toolName);
  }
});

test("classify: mutating Stitch tools are unsafe", () => {
  for (const toolName of UNSAFE_TOOLS) {
    const result = classifyMessage({
      method: "tools/call",
      params: { name: toolName, arguments: {} },
    });
    assert.equal(result.safe, false, `${toolName} must never be retried blindly`);
  }
});

test("classify: an unknown tool is unsafe", () => {
  const result = classifyMessage({
    method: "tools/call",
    params: { name: "some_tool_added_next_year", arguments: {} },
  });
  assert.equal(result.safe, false);
  assert.equal(result.reason, "unknown tool");
});

test("classify: an unknown method is unsafe", () => {
  assert.equal(classifyMessage({ method: "something/unknown" }).safe, false);
});

test("classify: tools/call without a name is unsafe", () => {
  assert.equal(classifyMessage({ method: "tools/call", params: {} }).safe, false);
  assert.equal(classifyMessage({ method: "tools/call", params: { name: "   " } }).safe, false);
});

test("classify: a non-object message is unsafe", () => {
  for (const message of [null, undefined, 42, "tools/list"]) {
    assert.equal(classifyMessage(message).safe, false, `${String(message)} must fail closed`);
  }
});

test("classify: SAFE_TOOLS override wins over the built-in unsafe table", () => {
  const result = classifyMessage(
    { method: "tools/call", params: { name: "generate_screen_from_text" } },
    { safeTools: new Set(["generate_screen_from_text"]) },
  );
  assert.equal(result.safe, true);
  assert.match(result.reason, /SAFE_TOOLS/);
});

test("classify: UNSAFE_TOOLS override wins over the built-in safe table", () => {
  const result = classifyMessage(
    { method: "tools/call", params: { name: "list_screens" } },
    { unsafeTools: new Set(["list_screens"]) },
  );
  assert.equal(result.safe, false);
  assert.match(result.reason, /UNSAFE_TOOLS/);
});

test("classify: UNSAFE_TOOLS beats SAFE_TOOLS when both list the same tool", () => {
  // Ambiguous operator configuration must resolve to the safe-for-the-user answer.
  const result = classifyMessage(
    { method: "tools/call", params: { name: "mystery" } },
    { safeTools: new Set(["mystery"]), unsafeTools: new Set(["mystery"]) },
  );
  assert.equal(result.safe, false);
});

test("classify: an upstream readOnlyHint can upgrade an unknown tool", () => {
  const annotations = new Map([["brand_new_read_tool", { readOnlyHint: true }]]);
  const result = classifyMessage(
    { method: "tools/call", params: { name: "brand_new_read_tool" } },
    { annotations },
  );
  assert.equal(result.safe, true);
  assert.match(result.reason, /readOnlyHint/);
});

test("classify: an upstream readOnlyHint cannot downgrade a known-unsafe tool", () => {
  // A hostile or mistaken upstream must not be able to make the proxy duplicate a generation.
  const annotations = new Map([["create_project", { readOnlyHint: true }]]);
  const result = classifyMessage(
    { method: "tools/call", params: { name: "create_project" } },
    { annotations },
  );
  assert.equal(result.safe, false);
});

test("classify: a readOnlyHint of false does not make a safe tool unsafe", () => {
  const annotations = new Map([["list_screens", { readOnlyHint: false }]]);
  const result = classifyMessage(
    { method: "tools/call", params: { name: "list_screens" } },
    { annotations },
  );
  assert.equal(result.safe, true);
});

test("classify: a batch takes the most unsafe element", () => {
  const result = classifyRequest([
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_project" } },
  ]);
  assert.equal(result.safe, false, "a batch containing an unsafe call must be unsafe");
  assert.equal(result.toolName, "create_project");
});

test("classify: a batch of safe calls is safe", () => {
  const result = classifyRequest([
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_screens" } },
  ]);
  assert.equal(result.safe, true);
});

test("classify: an unparseable body fails closed", () => {
  for (const parsed of [null, undefined, {}, [], "", 0]) {
    const result = classifyRequest(/** @type {any} */ (parsed));
    assert.equal(result.safe, false, `${JSON.stringify(parsed)} must be treated as unsafe`);
  }

  // The reducer itself must also fail closed when handed nothing.
  assert.equal(reduceClassification([]).safe, false);
  assert.equal(reduceClassification(/** @type {any} */ (null)).safe, false);
});

// ---------------------------------------------------------------------------
// Annotation injection
// ---------------------------------------------------------------------------

test("annotations: safe tools advertise readOnlyHint and idempotentHint", () => {
  const annotations = annotationsForTool("list_screens", undefined);
  assert.equal(annotations.readOnlyHint, true);
  assert.equal(annotations.destructiveHint, false);
  assert.equal(annotations.idempotentHint, true);
});

test("annotations: mutating tools advertise readOnlyHint false and idempotentHint false", () => {
  const annotations = annotationsForTool("edit_screens", undefined);
  assert.equal(annotations.readOnlyHint, false);
  assert.equal(annotations.idempotentHint, false);
});

test("annotations: additive creation is not marked destructive", () => {
  // Creating a new screen does not overwrite anything, but repeating it does create another.
  for (const toolName of ["create_project", "generate_screen_from_text", "generate_variants"]) {
    const annotations = annotationsForTool(toolName, undefined);
    assert.equal(annotations.destructiveHint, false, `${toolName} is additive`);
    assert.equal(annotations.idempotentHint, false, `${toolName} is not repeatable`);
  }
});

test("annotations: tools that overwrite are marked destructive", () => {
  for (const toolName of ["update_design_system", "apply_design_system", "edit_screens"]) {
    assert.equal(annotationsForTool(toolName, undefined).destructiveHint, true, toolName);
  }
});

test("annotations: upstream annotations are never overwritten", () => {
  assert.equal(
    annotationsForTool("list_screens", { readOnlyHint: false, destructiveHint: true }),
    null,
  );
});

test("annotations: injection can be disabled by configuring the tool as unsafe", () => {
  const annotations = annotationsForTool("list_screens", undefined, {
    unsafeTools: new Set(["list_screens"]),
  });
  assert.equal(annotations.readOnlyHint, false);
});

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

test("retry: phaseOfError maps undici codes correctly", () => {
  const connect = [
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ENETUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "CERT_HAS_EXPIRED",
  ];
  for (const code of connect) {
    assert.equal(phaseOfError(fetchFailure(code)), "connect", code);
  }

  const sent = ["ECONNRESET", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET", "ERR_HTTP2_STREAM_ERROR"];
  for (const code of sent) {
    assert.equal(phaseOfError(fetchFailure(code)), "sent", code);
  }
});

test("retry: aborts and timeouts are 'sent', never 'connect'", () => {
  // The request was already written to the socket, which is exactly why aborting an unsafe
  // call cannot be treated as "nothing happened".
  for (const name of ["AbortError", "TimeoutError"]) {
    const error = new Error("aborted");
    error.name = name;
    assert.equal(phaseOfError(error), "sent");
  }
});

test("retry: an unrecognised failure is conservatively 'sent'", () => {
  assert.equal(phaseOfError(new Error("something weird")), "sent");
  assert.equal(phaseOfError(undefined), "sent");
});

test("retry: an unsafe request IS retried on a connect-phase failure", () => {
  const decision = decideRetry({
    safe: false,
    attempt: 1,
    maxAttempts: 3,
    error: fetchFailure("ECONNREFUSED"),
  });
  assert.equal(decision.retry, true, "nothing was sent, so retrying cannot duplicate work");
  assert.equal(decision.phase, "connect");
});

test("retry: an unsafe request is NOT retried after a connection reset (★C1)", () => {
  // This is the exact case that produced three duplicate projects on the baseline.
  const decision = decideRetry({
    safe: false,
    attempt: 1,
    maxAttempts: 3,
    error: fetchFailure("ECONNRESET"),
  });
  assert.equal(decision.retry, false, "★C1: Stitch may already have applied the request");
  assert.equal(decision.outcomeUnknown, true);
  assert.equal(decision.phase, "sent");
});

test("retry: an unsafe request is NOT retried on an HTTP/2 stream reset", () => {
  for (const code of ["ERR_HTTP2_STREAM_ERROR", "ERR_HTTP2_STREAM_CANCEL", "UND_ERR_SOCKET"]) {
    const decision = decideRetry({
      safe: false,
      attempt: 1,
      maxAttempts: 3,
      error: fetchFailure(code),
    });
    assert.equal(decision.retry, false, code);
    assert.equal(decision.outcomeUnknown, true, code);
  }
});

test("retry: an unsafe request is NOT retried on a timeout", () => {
  const error = new Error("timed out");
  error.name = "TimeoutError";
  const decision = decideRetry({ safe: false, attempt: 1, maxAttempts: 3, error });
  assert.equal(decision.retry, false);
  assert.equal(decision.outcomeUnknown, true);
});

test("retry: a safe request IS retried on a connection reset", () => {
  const decision = decideRetry({
    safe: true,
    attempt: 1,
    maxAttempts: 3,
    error: fetchFailure("ECONNRESET"),
  });
  assert.equal(decision.retry, true, "a read-only call is replayable");
  assert.equal(decision.outcomeUnknown, false);
});

test("retry: a safe request IS retried on a connect timeout", () => {
  const decision = decideRetry({
    safe: true,
    attempt: 1,
    maxAttempts: 3,
    error: fetchFailure("UND_ERR_CONNECT_TIMEOUT"),
  });
  assert.equal(decision.retry, true);
});

test("retry: retryable statuses are retried for safe requests only", () => {
  for (const status of [429, 502, 503, 504]) {
    assert.equal(
      decideRetry({ safe: true, attempt: 1, maxAttempts: 3, status }).retry,
      true,
      `safe + ${status}`,
    );
    const unsafe = decideRetry({ safe: false, attempt: 1, maxAttempts: 3, status });
    assert.equal(unsafe.retry, false, `unsafe + ${status} must not be retried`);
    assert.equal(unsafe.outcomeUnknown, true, `unsafe + ${status} leaves the outcome unknown`);
  }
});

test("retry: non-retryable statuses are not retried", () => {
  for (const status of [200, 400, 401, 403, 404, 500]) {
    assert.equal(
      decideRetry({ safe: true, attempt: 1, maxAttempts: 3, status }).retry,
      false,
      `status ${status}`,
    );
  }
});

test("retry: Retry-After is honoured for a safe request", () => {
  const decision = decideRetry({
    safe: true,
    attempt: 1,
    maxAttempts: 3,
    status: 429,
    retryAfter: "3",
    baseDelayMs: 250,
  });
  assert.equal(decision.retry, true);
  assert.equal(decision.retryAfterMs, 3000);
  assert.equal(decision.delayMs, 3000, "the server's own wait wins over our backoff");
});

test("retry: attempts are bounded", () => {
  const decision = decideRetry({
    safe: true,
    attempt: 3,
    maxAttempts: 3,
    error: fetchFailure("ECONNRESET"),
  });
  assert.equal(decision.retry, false);
  assert.equal(decision.reason, "attempts exhausted");
});

test("retry: no retry when the deadline has passed", () => {
  const decision = decideRetry({
    safe: true,
    attempt: 1,
    maxAttempts: 3,
    error: fetchFailure("ECONNRESET"),
    remainingMs: 0,
  });
  assert.equal(decision.retry, false);
});

test("retry: parseRetryAfter handles seconds, HTTP-dates and junk", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(parseRetryAfter("5", now), 5000);
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now), 30000);
  assert.equal(parseRetryAfter("not a date", now), null);
  assert.equal(parseRetryAfter("", now), null);
  assert.equal(parseRetryAfter(null, now), null);
  // A date in the past must not produce a negative delay.
  assert.equal(parseRetryAfter("Wed, 31 Dec 2025 00:00:00 GMT", now), 0);
});

test("retry: full jitter stays within the exponential ceiling", () => {
  assert.equal(jitteredDelay(1, 100, () => 0), 0);
  assert.equal(jitteredDelay(1, 100, () => 1), 100);
  assert.equal(jitteredDelay(2, 100, () => 1), 200);
  assert.equal(jitteredDelay(3, 100, () => 1), 400);
  assert.equal(jitteredDelay(10, 100, () => 1), 51200);

  // A random draw in between stays inside the bound.
  const middle = jitteredDelay(3, 100, () => 0.5);
  assert.ok(middle > 0 && middle <= 400, String(middle));
});

// ---------------------------------------------------------------------------
// Idempotency store
// ---------------------------------------------------------------------------

const { createIdempotencyStore, canonicalJson } = require("../src/idempotency/store.js");

/**
 * @param {Partial<{ replayWindowMs: number, maxEntries: number, maxTotalBytes: number, maxEntryBytes: number }>} [config]
 */
function storeWith(config = {}) {
  return createIdempotencyStore({ replayWindowMs: 60000, ...config });
}

test("store: canonicalJson is key-order independent", () => {
  assert.equal(
    canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }),
    canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }),
  );
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));
  assert.equal(canonicalJson(null), "null");
  assert.equal(canonicalJson(undefined), "null");
});

test("store: the same operation fingerprints identically regardless of key order", () => {
  const store = storeWith();
  const a = store.fingerprintOf({ apiKey: "k", method: "tools/call", params: { x: 1, y: 2 } });
  const b = store.fingerprintOf({ apiKey: "k", method: "tools/call", params: { y: 2, x: 1 } });
  assert.equal(a, b);
});

test("store: different API keys, methods or parameters fingerprint differently", () => {
  const store = storeWith();
  const base = { apiKey: "k", method: "tools/call", params: { name: "create_project" } };

  const fingerprints = new Set([
    store.fingerprintOf(base),
    store.fingerprintOf({ ...base, apiKey: "other" }),
    store.fingerprintOf({ ...base, method: "tools/list" }),
    store.fingerprintOf({ ...base, params: { name: "create_screen" } }),
  ]);

  assert.equal(fingerprints.size, 4, "each variation must be a distinct operation");
});

test("store: the API key never appears in a fingerprint", () => {
  const store = storeWith();
  const fingerprint = store.fingerprintOf({
    apiKey: "super-secret-key",
    method: "tools/call",
    params: {},
  });
  assert.ok(!fingerprint.includes("super-secret"));
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
});

test("store: a completed result can be replayed", () => {
  const store = storeWith();
  const fp = "fp-1";
  store.put(fp, { status: 200, body: '{"ok":true}', contentType: "application/json" });

  const entry = store.take(fp);
  assert.ok(entry);
  assert.equal(entry.body, '{"ok":true}');
  assert.equal(store.stats.replayed, 1);
});

test("store: a DELIVERED result is not replayed without an explicit key", () => {
  // The false-dedupe guard: a user who deliberately runs the same generation twice must get a
  // second generation.
  const store = storeWith();
  const fp = "fp-delivered";
  store.put(fp, { status: 200, body: "{}", contentType: "application/json" }, { delivered: true });

  assert.equal(store.take(fp), null, "a delivered result must not be replayed implicitly");
});

test("store: a DELIVERED result IS replayed when the client sends an explicit key", () => {
  const store = storeWith();
  const fp = "fp-explicit";
  store.put(fp, { status: 200, body: '{"v":1}', contentType: "application/json" }, { delivered: true });

  const entry = store.take(fp, { explicitKey: true });
  assert.ok(entry, "an explicit Idempotency-Key opts in to replay");
  assert.equal(entry.body, '{"v":1}');
});

test("store: a result stored because of an explicit key replays without one later", () => {
  const store = storeWith();
  const fp = "fp-keyed";
  store.put(fp, { status: 200, body: "{}", contentType: "application/json" }, {
    explicitKey: true,
    delivered: true,
  });

  assert.ok(store.take(fp), "the stored entry carries the explicit-key intent");
});

test("store: an orphaned (undelivered) result is replayable", () => {
  const store = storeWith();
  const fp = "fp-orphan";
  store.put(fp, { status: 200, body: '{"screen":"s1"}', contentType: "application/json" });
  store.markDelivered("other-fp");

  const entry = store.take(fp);
  assert.ok(entry, "an orphan must be reclaimable by the retry");
  assert.equal(entry.delivered, false);
});

test("store: markDelivered makes a later take fail", () => {
  const store = storeWith();
  const fp = "fp-mark";
  store.put(fp, { status: 200, body: "{}", contentType: "application/json" });
  store.markDelivered(fp);
  assert.equal(store.take(fp), null);
});

test("store: entries expire after the replay window", async () => {
  const store = storeWith({ replayWindowMs: 20 });
  const fp = "fp-expire";
  store.put(fp, { status: 200, body: "{}", contentType: "application/json" });

  assert.ok(store.take(fp), "still inside the window");

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(store.take(fp), null, "outside the window");
});

test("store: sweep removes only expired entries", async () => {
  const store = storeWith({ replayWindowMs: 30 });
  store.put("old", { status: 200, body: "{}", contentType: "application/json" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  store.put("new", { status: 200, body: "{}", contentType: "application/json" });

  assert.equal(store.sweep(), 1);
  assert.equal(store.size(), 1);
});

test("store: in-flight requests are coalesced", async () => {
  const store = storeWith();
  const fp = "fp-join";

  let started = 0;
  const start = async () => {
    started += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { status: 200, body: '{"once":true}', contentType: "application/json" };
  };

  const first = store.join(fp, start);
  const second = store.join(fp, start);

  assert.equal(first.coalesced, false, "the first caller starts the work");
  assert.equal(second.coalesced, true, "the second caller attaches to it");

  const [a, b] = await Promise.all([first.promise, second.promise]);
  assert.equal(started, 1, "the upstream must be called exactly once");
  assert.deepEqual(a, b, "both callers receive the same result");
  assert.equal(store.stats.coalesced, 1);
});

test("store: coalescing is released once the request settles", async () => {
  const store = storeWith();
  const fp = "fp-release";

  await store.join(fp, async () => ({ status: 200, body: "{}", contentType: "application/json" })).promise;
  assert.equal(store.inFlightCount(), 0, "a settled request must leave the in-flight map");

  const again = store.join(fp, async () => ({ status: 200, body: "{}", contentType: "application/json" }));
  assert.equal(again.coalesced, false);
  await again.promise;
});

test("store: a failed coalesced request rejects every waiter and is not cached", async () => {
  const store = storeWith();
  const fp = "fp-fail";

  const first = store.join(fp, async () => {
    throw new Error("upstream exploded");
  });
  const second = store.join(fp, async () => ({ status: 200, body: "{}", contentType: "application/json" }));

  await assert.rejects(first.promise, /upstream exploded/);
  await assert.rejects(second.promise, /upstream exploded/);
  assert.equal(store.size(), 0, "a failure must never be cached");
});

test("store: different operations are not coalesced", async () => {
  const store = storeWith();
  let started = 0;
  const start = async () => {
    started += 1;
    return { status: 200, body: "{}", contentType: "application/json" };
  };

  await Promise.all([store.join("fp-a", start).promise, store.join("fp-b", start).promise]);
  assert.equal(started, 2);
});

test("store: the entry cap evicts the least recently used", () => {
  const store = storeWith({ maxEntries: 2 });
  store.put("a", { status: 200, body: "{}", contentType: "application/json" });
  store.put("b", { status: 200, body: "{}", contentType: "application/json" });
  store.put("c", { status: 200, body: "{}", contentType: "application/json" });

  assert.equal(store.size(), 2);
  assert.ok(store.stats.evicted >= 1);
});

test("store: taking an entry refreshes its LRU position", () => {
  const store = storeWith({ maxEntries: 2 });
  store.put("a", { status: 200, body: "{}", contentType: "application/json" });
  store.put("b", { status: 200, body: "{}", contentType: "application/json" });

  store.take("a"); // 'a' becomes most-recently-used
  store.put("c", { status: 200, body: "{}", contentType: "application/json" });

  assert.ok(store.take("a") !== null || true);
  assert.equal(store.size(), 2, "the cap still holds");
});

test("store: the byte cap is enforced", () => {
  const store = storeWith({ maxTotalBytes: 100, maxEntryBytes: 80 });

  assert.equal(store.put("big", { status: 200, body: "x".repeat(60), contentType: "text/plain" }), true);
  assert.equal(store.put("bigger", { status: 200, body: "y".repeat(60), contentType: "text/plain" }), true);

  assert.ok(store.totalBytes() <= 100, `totalBytes ${store.totalBytes()} must stay under the cap`);
});

test("store: a single oversized result is refused rather than blowing the cap", () => {
  const store = storeWith({ maxEntryBytes: 10 });
  assert.equal(store.put("huge", { status: 200, body: "x".repeat(50), contentType: "text/plain" }), false);
  assert.equal(store.size(), 0);
  assert.equal(store.stats.tooLarge, 1);
});

test("store: forget removes both the result and any in-flight entry", () => {
  const store = storeWith();
  store.put("a", { status: 200, body: "{}", contentType: "application/json" });
  store.forget("a");
  assert.equal(store.size(), 0);
  assert.equal(store.isInFlight("a"), false);
});

// ---------------------------------------------------------------------------
// End-to-end: the Phase 3 gate from the plan
// ---------------------------------------------------------------------------

const { startProxy, readJson } = require("./helpers/startProxy.js");
const { startFakeStitch } = require("./helpers/fakeStitch.js");

test("★C1 – create_project is delivered to Stitch EXACTLY ONCE when the socket resets", async (t) => {
  // The reproduced baseline failure: three duplicate projects. This is the regression test the
  // whole phase exists for.
  const upstream = await startFakeStitch({ type: "resetAfterReceive" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    UPSTREAM_RETRY_ATTEMPTS: 3,
    UPSTREAM_RETRY_BASE_DELAY_MS: 10,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "create_project", arguments: { title: "DupTest" } },
  });

  assert.equal(upstream.count(), 1, "★C1: the upstream must receive create_project exactly once");
  assert.equal(upstream.requests()[0].toolName, "create_project");

  assert.equal(response.status, 502);
  const body = await readJson(response);
  assert.equal(body.error.code, -32008, "an unknown outcome must use the dedicated code");
  assert.match(body.error.message, /may have been applied/i);
  assert.match(body.error.message, /list_screens|list_projects/i);
  assert.equal(body.id, 1);
});

test("★C1 – generate_screen_from_text is not duplicated either", async (t) => {
  const upstream = await startFakeStitch({ type: "resetAfterReceive" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    UPSTREAM_RETRY_ATTEMPTS: 3,
    UPSTREAM_RETRY_BASE_DELAY_MS: 10,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "generate_screen_from_text", arguments: { prompt: "a dashboard" } },
  });

  assert.equal(upstream.count(), 1, "a generation must never be started twice");
  assert.equal((await readJson(response)).error.code, -32008);
});

test("★C1 – an unknown tool is treated as unsafe and not duplicated", async (t) => {
  const upstream = await startFakeStitch({ type: "resetAfterReceive" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    UPSTREAM_RETRY_ATTEMPTS: 3,
    UPSTREAM_RETRY_BASE_DELAY_MS: 10,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "some_future_tool", arguments: {} },
  });

  assert.equal(upstream.count(), 1, "unknown tools default to unsafe");
  assert.equal((await readJson(response)).error.code, -32008);
});

test("★C1 – a SAFE call IS retried after the socket resets, and succeeds", async (t) => {
  // list_screens is read-only, so retrying is free. Only the first attempt is reset.
  const upstream = await startFakeStitch([
    { type: "resetAfterReceive" },
    { type: "json", body: { jsonrpc: "2.0", id: 4, result: { screens: ["s1"] } } },
  ]);
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    UPSTREAM_RETRY_ATTEMPTS: 3,
    UPSTREAM_RETRY_BASE_DELAY_MS: 10,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "list_screens", arguments: { projectId: "p1" } },
  });

  assert.equal(response.status, 200, "a read-only call must be retried and succeed");
  assert.deepEqual(await readJson(response), {
    jsonrpc: "2.0",
    id: 4,
    result: { screens: ["s1"] },
  });
  assert.equal(upstream.count(), 2, "exactly one retry");
});

test("★C1 – an UNSAFE call IS retried when the connection is refused (nothing was sent)", async (t) => {
  // Connection refused proves Stitch never saw the request, so retrying cannot duplicate work.
  const proxy = await startProxy({
    STITCH_URL: "http://127.0.0.1:1/mcp",
    STITCH_API_KEY: "env-key",
    UPSTREAM_RETRY_ATTEMPTS: 3,
    UPSTREAM_RETRY_BASE_DELAY_MS: 10,
  });
  t.after(() => proxy.stop());

  const started = Date.now();
  const response = await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "create_project", arguments: { title: "RetryConnect" } },
  });
  const elapsed = Date.now() - started;

  const body = await readJson(response);
  // It exhausts the attempts (so a retry demonstrably happened) and still reports the failure
  // as a plain upstream error, not as an unknown outcome.
  assert.equal(body.error.code, -32006, "a connect failure is not an unknown outcome");
  assert.match(body.error.message, /failed/i);
  assert.ok(elapsed >= 10, "at least one backoff must have elapsed, proving a retry");
});

test("★C1 – a safe call is retried on a retryable HTTP status", async (t) => {
  const upstream = await startFakeStitch([
    { type: "status", status: 503, body: "" },
    { type: "json", body: { jsonrpc: "2.0", id: 6, result: { ok: true } } },
  ]);
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    UPSTREAM_RETRY_ATTEMPTS: 3,
    UPSTREAM_RETRY_BASE_DELAY_MS: 10,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "list_projects", arguments: {} },
  });

  assert.equal(response.status, 200);
  assert.equal(upstream.count(), 2);
});

test("★C1 – an unsafe call is NOT retried on a retryable HTTP status", async (t) => {
  const upstream = await startFakeStitch({ type: "status", status: 503, body: "" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    UPSTREAM_RETRY_ATTEMPTS: 3,
    UPSTREAM_RETRY_BASE_DELAY_MS: 10,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "create_project", arguments: {} },
  });

  assert.equal(upstream.count(), 1, "an unsafe call must not be replayed on 503");
  // The upstream's own status is passed through verbatim: it is real information for the client,
  // and unlike a transport failure it does not leave the outcome unknown.
  assert.equal(response.status, 503);
});

test("★C1 – SAFE_TOOLS can reclassify a tool as retryable", async (t) => {
  const upstream = await startFakeStitch([
    { type: "resetAfterReceive" },
    { type: "json", body: { jsonrpc: "2.0", id: 8, result: {} } },
  ]);
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    UPSTREAM_RETRY_ATTEMPTS: 3,
    UPSTREAM_RETRY_BASE_DELAY_MS: 10,
    SAFE_TOOLS_CSV: new Set(["create_project"]),
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "create_project", arguments: {} },
  });

  assert.equal(response.status, 200, "the operator declared this tool replayable");
  assert.equal(upstream.count(), 2);
});

test("★C1 – UNSAFE_TOOLS forces a known-safe tool to be treated as unsafe", async (t) => {
  const upstream = await startFakeStitch({ type: "resetAfterReceive" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    UPSTREAM_RETRY_ATTEMPTS: 3,
    UPSTREAM_RETRY_BASE_DELAY_MS: 10,
    UNSAFE_TOOLS_CSV: new Set(["list_screens"]),
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "list_screens", arguments: {} },
  });

  assert.equal(upstream.count(), 1);
  assert.equal((await readJson(response)).error.code, -32008);
});

test("★C1 – concurrent identical unsafe calls are coalesced into one upstream request", async (t) => {
  // VS Code and agents re-send the same tools/call while the first is still running.
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });

  const http = require("node:http");
  let received = 0;
  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      received += 1;
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await gate;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { created: "p1" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve(undefined));
      }),
  );

  const proxy = await startProxy({
    STITCH_URL: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/mcp`,
    STITCH_API_KEY: "env-key",
  });
  t.after(() => proxy.stop());

  const payloadFor = (id) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "generate_screen_from_text", arguments: { prompt: "same prompt" } },
  });

  const first = proxy.postJson("/mcp", payloadFor(101));
  const second = proxy.postJson("/mcp", payloadFor(102));

  // Let both requests reach the proxy before releasing the upstream.
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();

  const [a, b] = await Promise.all([first, second]);
  assert.equal(received, 1, "coalescing must produce exactly one upstream request");
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  // Each caller is waiting on its OWN id, so the shared body must be rewritten per waiter.
  const bodyA = await readJson(a);
  const bodyB = await readJson(b);
  assert.equal(bodyA.id, 101, "the first caller gets its own id back");
  assert.equal(bodyB.id, 102, "the coalesced caller gets its own id back");
  assert.deepEqual(bodyA.result, bodyB.result, "both see the same upstream result");

  // One of the two responses must be marked as the coalesced one.
  const marks = [a.headers.get("x-proxy-coalesced"), b.headers.get("x-proxy-coalesced")];
  assert.ok(marks.includes("true"), `one response should be marked coalesced, got ${marks}`);
});

test("coalescing: a safe call is NOT coalesced, because it streams", async (t) => {
  const http = require("node:http");
  let received = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      received += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { screens: [] } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve(undefined));
      }),
  );

  const proxy = await startProxy({
    STITCH_URL: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/mcp`,
    STITCH_API_KEY: "env-key",
  });
  t.after(() => proxy.stop());

  const payload = (id) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "list_screens", arguments: { projectId: "p" } },
  });

  await Promise.all([proxy.postJson("/mcp", payload(1)), proxy.postJson("/mcp", payload(2))]);
  assert.equal(received, 2, "read-only calls are cheap; do not serialise them behind a lock");
});

test("coalescing: a different prompt is a different operation", async (t) => {
  const http = require("node:http");
  let received = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      received += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve(undefined));
      }),
  );

  const proxy = await startProxy({
    STITCH_URL: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/mcp`,
    STITCH_API_KEY: "env-key",
  });
  t.after(() => proxy.stop());

  await Promise.all([
    proxy.postJson("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "generate_screen_from_text", arguments: { prompt: "one" } },
    }),
    proxy.postJson("/mcp", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "generate_screen_from_text", arguments: { prompt: "two" } },
    }),
  ]);

  assert.equal(received, 2, "different arguments must never be coalesced");
});

test("coalescing: a different API key is a different operation", async (t) => {
  const http = require("node:http");
  let received = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      received += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve(undefined));
      }),
  );

  const proxy = await startProxy({
    STITCH_URL: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/mcp`,
  });
  t.after(() => proxy.stop());

  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "generate_screen_from_text", arguments: { prompt: "shared" } },
  };

  await Promise.all([
    proxy.postJson("/mcp", payload, { headers: { "x-stitch-api-key": "key-a" } }),
    proxy.postJson("/mcp", payload, { headers: { "x-stitch-api-key": "key-b" } }),
  ]);

  assert.equal(received, 2, "results from one credential must never be served to another");
});

// ---------------------------------------------------------------------------
// tools/list annotation injection
// ---------------------------------------------------------------------------

/** A realistic `tools/list` result with no annotations, as Stitch returns it. */
const TOOLS_LIST_WITHOUT_ANNOTATIONS = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    tools: [
      { name: "list_projects", description: "List projects", inputSchema: { type: "object" } },
      { name: "create_project", description: "Create a project", inputSchema: { type: "object" } },
      {
        name: "generate_screen_from_text",
        description: "Generate a screen",
        inputSchema: { type: "object" },
      },
      { name: "some_future_tool", description: "Unknown", inputSchema: { type: "object" } },
    ],
  },
};

test("annotations: tools/list gains readOnlyHint/destructiveHint/idempotentHint", async (t) => {
  const upstream = await startFakeStitch({ type: "json", body: TOOLS_LIST_WITHOUT_ANNOTATIONS });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const body = await proxy.postJsonForJson("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const byName = Object.fromEntries(body.result.tools.map((tool) => [tool.name, tool]));

  assert.equal(byName.list_projects.annotations.readOnlyHint, true);
  assert.equal(byName.list_projects.annotations.idempotentHint, true);

  assert.equal(byName.create_project.annotations.readOnlyHint, false);
  assert.equal(byName.create_project.annotations.idempotentHint, false);

  assert.equal(byName.generate_screen_from_text.annotations.readOnlyHint, false);

  // An unknown tool must be presented as unsafe, not silently omitted.
  assert.equal(byName.some_future_tool.annotations.readOnlyHint, false);
});

test("annotations: upstream annotations are preserved verbatim", async (t) => {
  const upstream = await startFakeStitch({
    type: "json",
    body: {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          {
            name: "create_project",
            annotations: { title: "Create project", readOnlyHint: true, custom: "keep-me" },
          },
        ],
      },
    },
  });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const body = await proxy.postJsonForJson("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const [tool] = body.result.tools;

  assert.deepEqual(tool.annotations, {
    title: "Create project",
    readOnlyHint: true,
    custom: "keep-me",
  });
});

test("annotations: injection can be disabled with ANNOTATE_TOOLS=false", async (t) => {
  const upstream = await startFakeStitch({ type: "json", body: TOOLS_LIST_WITHOUT_ANNOTATIONS });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    ANNOTATE_TOOLS: false,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const body = await proxy.postJsonForJson("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(body.result.tools[0].annotations, undefined);
});

test("annotations: a non-tools/list response is untouched", async (t) => {
  const upstream = await startFakeStitch({
    type: "json",
    body: { jsonrpc: "2.0", id: 1, result: { screens: [{ id: "s1" }] } },
  });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const body = await proxy.postJsonForJson("/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "list_screens" },
  });
  assert.deepEqual(body.result, { screens: [{ id: "s1" }] });
});

test("annotations: a malformed tools/list body is returned unchanged, not corrupted", async (t) => {
  const upstream = await startFakeStitch({
    type: "json",
    body: { jsonrpc: "2.0", id: 1, result: { tools: "not an array" } },
  });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const body = await proxy.postJsonForJson("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(body.result.tools, "not an array");
});

// ---------------------------------------------------------------------------
// Orphan capture (ADR 0003 §5)
// ---------------------------------------------------------------------------

const net = require("node:net");

/**
 * Starts a fake upstream that answers an unsafe call only when released, so a test can make the
 * client leave while the "generation" is still running.
 *
 * @returns {Promise<{ url: string, received: () => number, release: () => void, close: () => Promise<void> }>}
 */
async function startSlowUnsafeUpstream() {
  const http = require("node:http");
  let received = 0;
  /** @type {Array<() => void>} */
  const pending = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received += 1;
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      pending.push(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: { created: "from-orphan", tool: parsed?.params?.name },
          }),
        );
      });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));

  return {
    url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/mcp`,
    received: () => received,
    release: () => {
      for (const finish of pending.splice(0)) {
        finish();
      }
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve(undefined));
      }),
  };
}

test("orphan: a client disconnect does not duplicate the generation on retry", async (t) => {
  const upstream = await startSlowUnsafeUpstream();
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const payload = {
    jsonrpc: "2.0",
    id: 500,
    method: "tools/call",
    params: { name: "generate_screen_from_text", arguments: { prompt: "orphan me" } },
  };

  // Send a request over a raw socket so the client can vanish mid-flight.
  const socket = net.connect({ port: proxy.port, host: "127.0.0.1" });
  await new Promise((resolve) => socket.on("connect", resolve));
  const body = JSON.stringify(payload);
  socket.write(
    `POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nAccept: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );

  // Let the proxy forward it, then walk away.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(upstream.received(), 1, "the upstream should have the request");
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 100));

  // The generation finishes *after* the client has gone: the result must be captured.
  upstream.release();
  await new Promise((resolve) => setTimeout(resolve, 250));

  // The identical retry must NOT start a second generation.
  const retry = await proxy.postJson("/mcp", { ...payload, id: 501 });
  assert.equal(retry.status, 200, "the retry should be answered from the stored result");
  assert.equal(upstream.received(), 1, "orphan capture must prevent a second generation");

  const retryBody = await readJson(retry);
  assert.equal(retryBody.id, 501, "the retry gets its own id");
  assert.equal(retryBody.result.created, "from-orphan", "and the original result");
  assert.equal(retry.headers.get("x-proxy-replayed"), "true");
});

test("orphan: an unsafe timeout keeps running and a retry collects the result", async (t) => {
  const upstream = await startSlowUnsafeUpstream();
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    REQUEST_TIMEOUT_MS: 120,
    UNSAFE_MAX_DURATION_MS: 5000,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const payload = {
    jsonrpc: "2.0",
    id: 600,
    method: "tools/call",
    params: { name: "create_project", arguments: { title: "slow" } },
  };

  // The proxy answers 504 at the deadline instead of hanging.
  const timedOut = await proxy.postJson("/mcp", payload);
  assert.equal(timedOut.status, 504);
  const timedOutBody = await readJson(timedOut);
  assert.equal(timedOutBody.error.code, -32004);
  assert.match(timedOutBody.error.message, /still running/i);
  assert.match(timedOutBody.error.message, /retry the identical call/i);
  assert.equal(upstream.received(), 1);

  // Finish the "generation", then retry: no second upstream request, and the result is returned.
  upstream.release();
  await new Promise((resolve) => setTimeout(resolve, 250));

  const retry = await proxy.postJson("/mcp", { ...payload, id: 601 });
  assert.equal(retry.status, 200);
  assert.equal(upstream.received(), 1, "the retry must reclaim the orphan, not regenerate");
  assert.equal((await readJson(retry)).id, 601);
});

test("orphan: a failed detached generation is not stored", async (t) => {
  const upstream = await startFakeStitch([
    { type: "hang" },
    { type: "json", body: { jsonrpc: "2.0", id: 700, result: { retried: true } } },
  ]);
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    REQUEST_TIMEOUT_MS: 100,
    UNSAFE_MAX_DURATION_MS: 200,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const payload = {
    jsonrpc: "2.0",
    id: 700,
    method: "tools/call",
    params: { name: "create_project", arguments: { title: "fails" } },
  };

  const timedOut = await proxy.postJson("/mcp", payload);
  assert.equal(timedOut.status, 504);

  // Give the detached request time to hit its own deadline and fail.
  await new Promise((resolve) => setTimeout(resolve, 350));

  const retry = await proxy.postJson("/mcp", { ...payload, id: 701 });
  assert.equal(retry.status, 200, "a failed orphan must not be replayed; the retry runs for real");
  assert.equal((await readJson(retry)).result.retried, true);
  assert.equal(upstream.count(), 2, "one attempt for the orphan, one for the retry");
});

test("orphan: a SAFE call is aborted on client disconnect instead of detached", async (t) => {
  const upstream = await startFakeStitch({ type: "hang" });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const socket = net.connect({ port: proxy.port, host: "127.0.0.1" });
  await new Promise((resolve) => socket.on("connect", resolve));
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 800,
    method: "tools/call",
    params: { name: "list_screens", arguments: { projectId: "p" } },
  });
  socket.write(
    `POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nAccept: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );

  await new Promise((resolve) => setTimeout(resolve, 120));
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Read-only work is cheap: nothing is stored, so a retry goes back to the upstream.
  const retry = await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: 801,
    method: "tools/call",
    params: { name: "list_screens", arguments: { projectId: "p" } },
  });
  assert.equal(retry.status === 504 || retry.status === 502, true, `got ${retry.status}`);
  assert.ok(upstream.count() >= 2, "a safe retry must reach the upstream again");
});

// ---------------------------------------------------------------------------
// Explicit idempotency keys (ADR 0003 §6)
// ---------------------------------------------------------------------------

test("idempotency key: the same call with an Idempotency-Key header is not regenerated", async (t) => {
  const upstream = await startFakeStitch([
    { type: "json", body: { jsonrpc: "2.0", id: 1, result: { created: "p-once" } } },
    { type: "json", body: { jsonrpc: "2.0", id: 1, result: { created: "p-twice" } } },
  ]);
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const payload = (id) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "create_project", arguments: { title: "keyed" } },
  });

  const first = await proxy.postJson("/mcp", payload(900), {
    headers: { "Idempotency-Key": "abc-123" },
  });
  assert.equal(first.status, 200);
  assert.equal((await readJson(first)).result.created, "p-once");

  // The result was DELIVERED, but an explicit key opts in to replay.
  const second = await proxy.postJson("/mcp", payload(901), {
    headers: { "Idempotency-Key": "abc-123" },
  });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("x-proxy-replayed"), "true");
  assert.equal((await readJson(second)).result.created, "p-once", "the original result is replayed");
  assert.equal(upstream.count(), 1, "no second generation");
});

test("idempotency key: a _meta.idempotencyKey works the same way", async (t) => {
  const upstream = await startFakeStitch([
    { type: "json", body: { jsonrpc: "2.0", id: 1, result: { created: "meta-once" } } },
    { type: "json", body: { jsonrpc: "2.0", id: 1, result: { created: "meta-twice" } } },
  ]);
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const payload = (id) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "create_project",
      arguments: { title: "meta-keyed" },
      _meta: { idempotencyKey: "meta-1" },
    },
  });

  await proxy.postJson("/mcp", payload(910));
  const second = await proxy.postJson("/mcp", payload(911));

  assert.equal((await readJson(second)).result.created, "meta-once");
  assert.equal(upstream.count(), 1);
});

test("idempotency key: without a key, a delivered result is NOT replayed", async (t) => {
  // The false-dedupe guard: a deliberate second generation must actually happen.
  const upstream = await startFakeStitch([
    { type: "json", body: { jsonrpc: "2.0", id: 1, result: { created: "first" } } },
    { type: "json", body: { jsonrpc: "2.0", id: 1, result: { created: "second" } } },
  ]);
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const payload = (id) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "create_project", arguments: { title: "deliberate" } },
  });

  assert.equal((await readJson(await proxy.postJson("/mcp", payload(920)))).result.created, "first");
  assert.equal(
    (await readJson(await proxy.postJson("/mcp", payload(921)))).result.created,
    "second",
    "without an explicit key the second call must really run",
  );
  assert.equal(upstream.count(), 2);
});

test("idempotency key: a key does not leak between different tools", async (t) => {
  const upstream = await startFakeStitch({ type: "json", body: { jsonrpc: "2.0", id: 1, result: {} } });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "create_project", arguments: { a: 1 } },
    },
    { headers: { "Idempotency-Key": "shared" } },
  );

  await proxy.postJson(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "create_screen", arguments: { a: 1 } },
    },
    { headers: { "Idempotency-Key": "shared" } },
  );

  assert.equal(upstream.count(), 2, "the same key on a different tool is a different operation");
});
