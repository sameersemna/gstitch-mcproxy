// @ts-check
"use strict";

/**
 * Phase 4 — streaming and upstream I/O (ADR 0004).
 *
 * The findings under test: ★S1 (a stream outlived both its timeout and its client), ★S2 (no
 * backpressure), ★S3 (bodies buffered for logging even when logging was off) and ★S6 (server
 * timeouts left at Node's defaults, no cap on concurrent upstream requests).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");

const { startProxy, readJson } = require("./helpers/startProxy.js");
const { startFakeStitch } = require("./helpers/fakeStitch.js");

// ---------------------------------------------------------------------------
// ★S1 — three independent deadlines, and a disconnect that actually stops the read
// ---------------------------------------------------------------------------

test("★S1 – a never-ending stream is cut at the stream idle timeout", async (t) => {
  const upstream = await startFakeStitch({
    type: "sse",
    events: ['event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'],
    never: true,
  });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    STREAM_IDLE_TIMEOUT_MS: 150,
    STREAM_MAX_DURATION_MS: 60000,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const started = Date.now();
  const response = await proxy.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    rawBody: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  const text = await response.text();
  const elapsed = Date.now() - started;

  assert.match(text, /"result"/, "the first event should have been delivered");
  assert.ok(elapsed < 3000, `the idle timeout should end the stream promptly, took ${elapsed}ms`);
});

test("★S1 – a stream that keeps producing is NOT killed by the idle timeout", async (t) => {
  // The distinction the fix exists for: slow-but-alive must survive, stalled must not.
  const upstream = await startFakeStitch({
    type: "sse",
    events: Array.from(
      { length: 12 },
      (_, index) => `event: message\ndata: {"jsonrpc":"2.0","id":1,"n":${index}}\n\n`,
    ),
    eventIntervalMs: 60,
  });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    STREAM_IDLE_TIMEOUT_MS: 200,
    STREAM_MAX_DURATION_MS: 60000,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    rawBody: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const text = await response.text();

  assert.match(
    text,
    /"n":11/,
    "every event should arrive even though each gap is under the idle limit",
  );
});

test("★S1 – a stream is cut at the total duration cap even while data flows", async (t) => {
  const upstream = await startFakeStitch({
    type: "sse",
    events: Array.from(
      { length: 500 },
      (_, index) => `event: message\ndata: {"jsonrpc":"2.0","id":1,"n":${index}}\n\n`,
    ),
    eventIntervalMs: 20,
    never: true,
  });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    STREAM_IDLE_TIMEOUT_MS: 5000,
    STREAM_MAX_DURATION_MS: 200,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const started = Date.now();
  const response = await proxy.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    rawBody: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  await response.text();
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2000, `the total cap should end a noisy stream, took ${elapsed}ms`);
});

test("★S1 – a client disconnect aborts the upstream stream for a safe call", async (t) => {
  // The reproduced baseline leak: the upstream socket stayed ESTABLISHED long after the client
  // left. We assert the *upstream* socket closes, not merely that we stopped reading.
  const upstream = await startFakeStitch({
    type: "sse",
    events: ['event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'],
    never: true,
  });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    STREAM_IDLE_TIMEOUT_MS: 30000,
    STREAM_MAX_DURATION_MS: 60000,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  /** @type {import("node:http").ServerResponse|null} */
  let upstreamResponse = null;
  upstream.on("stream-open", (res) => {
    upstreamResponse = res;
  });

  const socket = net.connect({ port: proxy.port, host: "127.0.0.1" });
  await new Promise((resolve) => socket.on("connect", resolve));
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  socket.write(
    `POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nAccept: text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(upstreamResponse, "the upstream should have started streaming");

  socket.destroy();

  // The upstream connection must be torn down, not merely ignored.
  const closed = await Promise.race([
    new Promise((resolve) => {
      const check = () => {
        if (/** @type {any} */ (upstreamResponse).destroyed) {
          resolve(true);
        } else {
          setTimeout(check, 25);
        }
      };
      check();
    }),
    new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
  ]);

  assert.equal(closed, true, "★S1: the upstream stream must be aborted when the client leaves");
});

// ---------------------------------------------------------------------------
// ★S2 — backpressure
// ---------------------------------------------------------------------------

test("★S2 – a slow reader must not make the proxy buffer without bound", async (t) => {
  // The client reads ~64 KB every 5 ms while the upstream produces as fast as it can. Without
  // backpressure the proxy would buffer the whole body in memory; with a pipeline it holds at
  // most a high-water mark. We sample the real `writableLength` of the response.
  const events = Array.from(
    { length: 120 },
    (_, index) =>
      `event: message\ndata: {"jsonrpc":"2.0","id":1,"n":${index},"pad":"${"y".repeat(2000)}"}\n\n`,
  );

  const upstream = await startFakeStitch({ type: "sse", events, eventIntervalMs: 1 });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    STREAM_IDLE_TIMEOUT_MS: 30000,
    STREAM_MAX_DURATION_MS: 60000,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  // Sample the buffered bytes of every live response object on the proxy instance.
  /** @type {number[]} */
  const samples = [];
  const sampler = setInterval(() => {
    for (const response of /** @type {any} */ (proxy.server).liveResponses) {
      samples.push(response.writableLength);
    }
  }, 10);
  t.after(() => clearInterval(sampler));

  const response = await proxy.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    rawBody: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  assert.equal(response.status, 200);
  assert.ok(response.body, "the response should be a stream");

  const reader = response.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += (value || new Uint8Array()).length;
    // Deliberately slow: 5 ms per read gives the proxy plenty of time to over-buffer.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const totalBytes = events.reduce((sum, event) => sum + Buffer.byteLength(event), 0);
  assert.ok(
    received >= totalBytes * 0.9,
    `the client should receive the stream (${received}/${totalBytes})`,
  );

  const peak = samples.length ? Math.max(...samples) : 0;
  assert.ok(
    peak < 512 * 1024,
    `★S2: buffered bytes must stay bounded, peaked at ${peak} (samples: ${samples.length})`,
  );
});

// ---------------------------------------------------------------------------
// ★S3 — capture only when debug logging is on
// ---------------------------------------------------------------------------

test("★S3 – a stream is not captured when logging is disabled", async (t) => {
  const events = Array.from(
    { length: 20 },
    (_, index) =>
      `event: message\ndata: {"jsonrpc":"2.0","id":1,"n":${index},"pad":"${"z".repeat(500)}"}\n\n`,
  );
  const upstream = await startFakeStitch({ type: "sse", events, eventIntervalMs: 2 });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    LOG_ENABLED: false,
    STREAM_IDLE_TIMEOUT_MS: 30000,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    rawBody: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const text = await response.text();
  assert.match(text, /"n":19/, "the stream must still be fully delivered");
});

test("★S3 – the debug capture is capped at LOG_MAX_BODY_CHARS", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstitch-stream-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const events = Array.from(
    { length: 40 },
    (_, index) =>
      `event: message\ndata: {"jsonrpc":"2.0","id":1,"n":${index},"pad":"${"p".repeat(400)}"}\n\n`,
  );
  const upstream = await startFakeStitch({ type: "sse", events, eventIntervalMs: 2 });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    LOG_ENABLED: true,
    LOG_LEVEL: "debug",
    LOG_MAX_BODY_CHARS: 500,
    LOG_DIR: dir,
    STREAM_IDLE_TIMEOUT_MS: 30000,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    rawBody: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  await response.text();

  const projectDir = path.join(dir, "unknown-project");
  assert.ok(fs.existsSync(projectDir), "a detail log should exist");
  const files = fs.readdirSync(projectDir);
  const detail = fs.readFileSync(path.join(projectDir, files[0]), "utf8");

  assert.ok(detail.length < 8000, `the detail log must stay bounded, was ${detail.length} bytes`);
  assert.match(detail, /truncated stream capture|"n":/, "the capture should be present but capped");
});

// ---------------------------------------------------------------------------
// ★S6 — explicit server timeouts
// ---------------------------------------------------------------------------

test("★S6 – the server sets explicit, configurable timeouts", async (t) => {
  const proxy = await startProxy({
    STITCH_API_KEY: "env-key",
    REQUEST_TIMEOUT_MS: 45000,
    SERVER_HEADERS_TIMEOUT_MS: 20000,
    SERVER_KEEP_ALIVE_TIMEOUT_MS: 9000,
  });
  t.after(() => proxy.stop());

  // Node defaults are 300000 / 60000 / 5000. Explicit values must win, and the headers timeout
  // must be below the request timeout so a slow header write cannot outlive the request.
  assert.equal(proxy.server.requestTimeout, 45000 + 5000, "requestTimeout includes a grace margin");
  assert.equal(proxy.server.headersTimeout, 20000);
  assert.equal(proxy.server.keepAliveTimeout, 9000);
});

test("★S6 – a long generation request is not killed by the server request timeout", async (t) => {
  // Stitch generations routinely exceed 60 s. The important property is that the *proxy's* own
  // deadline is the one that fires, with a JSON-RPC error, not Node's bare socket timeout.
  const upstream = await startFakeStitch({
    type: "delay",
    ms: 400,
    then: { type: "json", body: { jsonrpc: "2.0", id: 1, result: { ok: true } } },
  });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    REQUEST_TIMEOUT_MS: 200,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "list_projects" },
  });

  assert.equal(response.status, 504);
  assert.equal((await readJson(response)).error.code, -32004);
});

// ---------------------------------------------------------------------------
// ★S6 — bounded upstream concurrency
// ---------------------------------------------------------------------------

test("★S6 – concurrency saturation answers 503 with Retry-After instead of hanging", async (t) => {
  // One slot, held by a request that never finishes; the second request must be refused promptly.
  const upstream = await startFakeStitch({ type: "hang" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    MAX_CONCURRENT_UPSTREAM: 1,
    CONCURRENCY_QUEUE_WAIT_MS: 150,
    REQUEST_TIMEOUT_MS: 5000,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const payload = (id) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "list_projects" },
  });

  // Hold the only slot.
  const held = proxy.postJson("/mcp", payload(1));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const started = Date.now();
  const second = await proxy.postJson("/mcp", payload(2));
  const elapsed = Date.now() - started;

  assert.equal(second.status, 503, "a saturated proxy must answer 503");
  assert.ok(second.headers.get("retry-after"), "and tell the client when to retry");
  assert.equal((await readJson(second)).error.code, -32009);
  assert.ok(elapsed < 3000, `the refusal must be prompt, took ${elapsed}ms`);

  await held.catch(() => undefined);
});

test("limiter: run() bounds concurrency and is FIFO", async () => {
  const { createSemaphore } = require("../src/upstream/limiter.js");
  const semaphore = createSemaphore(2);

  let active = 0;
  let peak = 0;
  /** @type {number[]} */
  const order = [];

  const task = (id) => async () => {
    active += 1;
    peak = Math.max(peak, active);
    order.push(id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return id;
  };

  const results = await Promise.all([1, 2, 3, 4, 5, 6].map((id) => semaphore.run(task(id))));

  assert.deepEqual(results, [1, 2, 3, 4, 5, 6]);
  assert.equal(peak, 2, "never more than the limit may run at once");
  assert.deepEqual(order.slice(0, 2), [1, 2], "the first two start immediately");
  assert.deepEqual(order, [1, 2, 3, 4, 5, 6], "queued work runs in FIFO order");
  assert.deepEqual(semaphore.stats(), { active: 0, queued: 0, limit: 2 });
});

test("limiter: a saturated queue rejects rather than waiting forever", async () => {
  const { createSemaphore } = require("../src/upstream/limiter.js");
  const semaphore = createSemaphore(1);

  const blocker = semaphore.run(() => new Promise((resolve) => setTimeout(resolve, 200)));

  await assert.rejects(
    semaphore.run(async () => "never", 30),
    (error) => /** @type {any} */ (error).code === "SEMAPHORE_TIMEOUT",
  );

  await blocker;
});

test("limiter: a limit of 0 disables the cap", async () => {
  const { createSemaphore } = require("../src/upstream/limiter.js");
  const semaphore = createSemaphore(0);

  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 10 }, () =>
      semaphore.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      }),
    ),
  );

  assert.equal(peak, 10, "unlimited means all ten run together");
  assert.equal(semaphore.stats().limit, 0);
});

test("limiter: a throwing task still releases its slot", async () => {
  const { createSemaphore } = require("../src/upstream/limiter.js");
  const semaphore = createSemaphore(1);

  await assert.rejects(
    semaphore.run(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );

  assert.equal(semaphore.stats().active, 0, "a failed task must not leak its slot");
  assert.equal(await semaphore.run(async () => "ok"), "ok");
});
