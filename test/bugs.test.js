// @ts-check
"use strict";

/**
 * Regression tests for the audit findings in `PROGRESS.md` §10.
 *
 * Every `★` finding was reproduced against commit `2578c26` with a scripted fake upstream.
 * Findings fixed in Phase 1 have their promotions in `test/phase1.test.js`; the entries still
 * below are the ones that remain open, captured as `test.todo(...)` so the suite stays green
 * while the reproduction is already written.
 *
 * `test.todo()` bodies are *documentation*: `node:test` does not execute them.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { startFakeStitch } = require("./helpers/fakeStitch.js");
const { startProxy } = require("./helpers/startProxy.js");

test("★C5 – a normal SSE response must not crash the proxy", async (t) => {
  // Reproduced on baseline `2578c26`: after the first streamed response the process exited
  // with `ERR_HTTP_HEADERS_SENT`. Root cause was a missing `return` at the end of the
  // streaming branch, so control fell through to the trailing `sendJson(res, 404, ...)`.
  const upstream = await startFakeStitch({
    type: "sse",
    events: ['event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"a":1}}\n\n'],
    endAfterMs: 20,
  });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  // Collect anything the handler writes to stderr; a stream must not produce an error.
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => {
    errors.push(args.join(" "));
  };
  t.after(() => {
    console.error = originalError;
  });

  const first = await proxy.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    rawBody: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
  });
  assert.equal(first.status, 200);
  assert.match(await first.text(), /"a":1/);

  // Give the handler a tick to run its post-stream code (metrics + logging).
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.deepEqual(errors, [], `streaming must not log errors, got: ${errors.join(" | ")}`);

  // The proxy must still be usable afterwards — the whole point of ★C5.
  const health = await proxy.request("/health");
  assert.equal(health.status, 200, "the proxy must still answer after a streamed response");

  // A second stream must work too (no corrupted response state).
  const second = await proxy.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    rawBody: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
  });
  assert.equal(second.status, 200);
});

test("★C5 – the streamed response must not be followed by a spurious 404 body", async (t) => {
  const upstream = await startFakeStitch({
    type: "sse",
    events: ['event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{}}\n\n'],
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
  const text = await response.text();

  assert.ok(!text.includes("-32601"), `stream body must not contain a 404 error: ${text}`);
  assert.ok(!text.includes("Not found"), `stream body must not contain a 404 message: ${text}`);
});

// ---------------------------------------------------------------------------
// Still open — see `test/bugs.test.js` for the full list
// ---------------------------------------------------------------------------

test.todo(
  "★C1 – a retry must never duplicate a non-idempotent Stitch call " +
    "[reproduced: upstream received tools/call create_project 3 times after a " +
    "reset-after-receive failure]",
);

test.todo(
  "★C3 – a cross-origin browser must not be able to use the proxy with the server's env API key " +
    "[reproduced: preflight + POST from Origin: https://evil.example succeeded]",
);

test.todo(
  "★C4 – /logs, /api/logs* and /metrics must not be world-readable and cross-origin " +
    "[reproduced: GET /api/logs with Origin: https://evil.example → 200 + ACAO: *]",
);

// ---------------------------------------------------------------------------
// Protocol correctness
// ---------------------------------------------------------------------------

test.todo(
  "P3 – batch (array) requests must be classified by their most-unsafe element " +
    "(spec: batching is not part of MCP and the body MUST be a single message)",
);

test.todo(
  "P4 – record whether Stitch implements resources/list and resources/templates/list " +
    "(needs an opt-in live probe with the owner's key)",
);

test.todo(
  "P5 – notifications/cancelled must abort the matching in-flight safe upstream request",
);

// ---------------------------------------------------------------------------
// Streaming and resource handling
// ---------------------------------------------------------------------------

test.todo(
  "★S1 – a never-ending stream must be cut at the stream-idle and total timeouts, and a client " +
    "disconnect must abort the upstream stream for safe calls " +
    "[reproduced: with REQUEST_TIMEOUT_MS=2000 the upstream socket stayed ESTABLISHED 6.6s " +
    "after the client aborted at 600ms]",
);

test.todo(
  "S2 – a slow-reading client must not make the proxy buffer without bound " +
    "(res.write() return value is ignored)",
);

test.todo(
  "S3 – stream chunks must only be accumulated when debug logging is on " +
    "(they are buffered even when LOG_ENABLED=false)",
);

test.todo(
  "S5 – no synchronous I/O on the request path " +
    "(readFileSync of the whole summary log, appendFileSync, statSync, execSync gcloud)",
);

test.todo(
  "S6 – explicit server timeouts and a cap on concurrent upstream requests",
);

// ---------------------------------------------------------------------------
// Smaller bugs
// ---------------------------------------------------------------------------

test.todo(
  "N1 – /api/logs* must honour LOG_VIEWER_ENABLED=false " +
    "(the guard only matches paths starting with '/logs')",
);

test.todo(
  "N4 – getClientIp must not trust X-Forwarded-For unless TRUST_PROXY is enabled",
);

test.todo(
  "N5 – per-project debug logs must use params.arguments.projectId, not the env default",
);

test.todo(
  "N6 – the error-path debug log must include the request body " +
    "(it currently passes requestBody: undefined)",
);

test.todo("N8 – test.sh must never print the API key (print configured/missing instead)");

test.todo(
  "N9 – INSTRUCTIONS.md and LOG_DIR must resolve relative to __dirname, not process.cwd()",
);

test.todo(
  "N10 – the .well-known stubs must use a configurable public base URL, not http://localhost:{port}",
);

test.todo(
  "N11 – /token must not hand out a static local-proxy-token (or must be documented as non-auth)",
);
