// @ts-check
"use strict";

/**
 * Phase 1 — crash-proofing and correctness.
 *
 * Each test here corresponds to a `test.todo()` in `bugs.test.js` and is promoted as the
 * fix lands. The ★ identifiers match `PROGRESS.md` §10.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { startProxy, readJson } = require("./helpers/startProxy.js");
const { startFakeStitch } = require("./helpers/fakeStitch.js");
const { rawRequest, isServerAlive } = require("./helpers/rawHttp.js");

// ---------------------------------------------------------------------------
// ★C2 — malformed input must never terminate the process
// ---------------------------------------------------------------------------

test("★C2 – a malformed Host header is rejected and the process survives", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: "env-key" });
  t.after(() => proxy.stop());

  const response = await rawRequest(
    proxy.port,
    "GET /health HTTP/1.1\r\nHost: [bad\r\nConnection: close\r\n\r\n",
  );

  assert.ok(!response.timedOut, "the proxy must answer a malformed Host instead of hanging");
  assert.notEqual(
    response.error,
    "ECONNRESET",
    `the proxy must not reset the connection (raw: ${JSON.stringify(response.raw.slice(0, 200))})`,
  );

  assert.equal(
    await isServerAlive(proxy.port),
    true,
    "★C2: the proxy must still be running after a malformed Host header",
  );
});

test("★C2 – a malformed Host header produces a JSON-RPC error, not a crash", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: "env-key" });
  t.after(() => proxy.stop());

  const response = await rawRequest(
    proxy.port,
    "POST /mcp HTTP/1.1\r\nHost: [bad\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: 2\r\n\r\n{}",
  );

  assert.ok(
    response.status === 400 || response.status === 403,
    `expected a 4xx for a malformed Host, got ${response.status} (raw: ${response.raw.slice(0, 200)})`,
  );

  // The body may be chunked-framed, so recover the JSON object rather than splitting on the
  // header separator.
  const match = response.raw.match(/\{[\s\S]*\}\s*$/);
  assert.ok(match, `no JSON body found in: ${JSON.stringify(response.raw.slice(0, 300))}`);

  const body = JSON.parse(match[0]);
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(typeof body.error.code, "number", "the error must carry a JSON-RPC code");
});

test("★C2 – a garbage request line is handled by the clientError path", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: "env-key" });
  t.after(() => proxy.stop());

  for (const payload of [
    "INVALID REQUEST LINE\r\n\r\n",
    "\x00\x01\x02\x03 not http at all\r\n\r\n",
    "GET /health HTTP/9.9\r\nHost: localhost\r\n\r\n",
  ]) {
    const response = await rawRequest(proxy.port, payload, { timeoutMs: 1000 });
    assert.equal(
      response.error,
      null,
      `a garbage request line must not raise a socket error (${JSON.stringify(payload)} → ${response.error})`,
    );
  }

  assert.equal(
    await isServerAlive(proxy.port),
    true,
    "★C2: the proxy must still be running after garbage request lines",
  );
});

test("★C2 – an aborted upload (client vanishes mid-request) is survivable", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: "env-key" });
  t.after(() => proxy.stop());

  const net = require("node:net");
  const socket = net.connect({ port: proxy.port, host: "127.0.0.1" });
  await new Promise((resolve) => socket.on("connect", resolve));
  // Announce a large body, send a fragment, then walk away.
  socket.write(
    'POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{"jsonrpc":',
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  socket.destroy();

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(
    await isServerAlive(proxy.port),
    true,
    "★C2: an aborted upload must not terminate the proxy",
  );
});

test("★C2 – a request without any Host header is still served", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: "env-key" });
  t.after(() => proxy.stop());

  // HTTP/1.0 allows omitting Host. `new URL(req.url, base)` must not depend on it.
  const response = await rawRequest(
    proxy.port,
    "GET /health HTTP/1.0\r\nConnection: close\r\n\r\n",
    { timeoutMs: 1500 },
  );

  assert.equal(
    response.status,
    200,
    `a Host-less HTTP/1.0 request should still work (raw: ${response.raw.slice(0, 160)})`,
  );
});

test("★C2 – a malformed Host on the log-viewer route does not crash", async (t) => {
  const proxy = await startProxy({ LOG_VIEWER_ENABLED: true });
  t.after(() => proxy.stop());

  // `99999` is not a valid port, so the Host is malformed and the proxy must answer 400.
  // The point of the test is that it answers *at all*, and stays up.
  const badPort = await rawRequest(
    proxy.port,
    "GET /api/logs HTTP/1.1\r\nHost: evil.example:99999\r\nConnection: close\r\n\r\n",
  );
  assert.equal(badPort.status, 400, `an out-of-range port must be rejected, got ${badPort.status}`);

  // A well-formed private-network Host must still be served normally. (Phase 5 added the public
  // internet to the refusal list, so this uses a LAN address: `evil.example` is now correctly
  // rejected as a DNS-rebinding attempt.)
  const okHost = await rawRequest(
    proxy.port,
    "GET /api/logs HTTP/1.1\r\nHost: 192.168.1.20\r\nConnection: close\r\n\r\n",
  );
  assert.equal(okHost.status, 200, `a valid Host must still be served, got ${okHost.status}`);

  assert.equal(await isServerAlive(proxy.port), true);
});

test("★C2 – a request with an unparseable absolute URL does not crash", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: "env-key" });
  t.after(() => proxy.stop());

  for (const target of ["http://[bad/health", "//[bad/mcp", "/health?%zz=%qq"]) {
    const response = await rawRequest(
      proxy.port,
      `GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
    );
    assert.equal(response.error, null, `target ${target} raised a socket error: ${response.error}`);
    assert.ok(
      response.status === 200 || response.status === 400,
      `target ${target} should be served or rejected as a client error, got ${response.status}`,
    );
  }

  assert.equal(
    await isServerAlive(proxy.port),
    true,
    "★C2: an unparseable request target must not terminate the proxy",
  );
});

// ---------------------------------------------------------------------------
// ★S4 — no event-listener leak on keep-alive sockets
// ---------------------------------------------------------------------------

test("★S4 – keep-alive requests must not accumulate 'close' listeners on one socket", async (t) => {
  const http = require("node:http");
  const proxy = await startProxy({ STITCH_API_KEY: "env-key" });
  t.after(() => proxy.stop());

  // Capture the actual socket the client uses, so listener counts can be measured directly.
  // Relying on `process.on("warning")` was a trap: the warning fires once, and if it fires before
  // the listener is attached (or is emitted asynchronously) the test passes for the wrong reason.
  /** @type {import("node:net").Socket|null} */
  let socket = null;
  proxy.server.on("connection", (accepted) => {
    socket = accepted;
  });

  const warnings = [];
  const onWarning = (warning) => warnings.push(String(warning.message ?? warning));
  process.on("warning", onWarning);
  t.after(() => process.removeListener("warning", onWarning));

  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());

  const get = (path) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: proxy.port, path, agent }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end();
    });

  for (let i = 0; i < 40; i += 1) {
    assert.equal(await get("/health"), 200, `request ${i} should succeed`);
  }

  assert.ok(socket, "the test should have observed the client socket");
  const closeListeners = /** @type {any} */ (socket).listenerCount("close");

  assert.ok(
    closeListeners <= 3,
    `★S4: one keep-alive socket must not accumulate 'close' listeners (found ${closeListeners} after 40 requests)`,
  );

  const leakWarning = warnings.find((warning) => /MaxListenersExceededWarning/.test(warning));
  assert.equal(leakWarning, undefined, `★S4: unexpected leak warning: ${leakWarning}`);
});

test("★S4 – active-connection metrics still track connections after the refactor", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: "env-key", METRICS_ENABLED: true });
  t.after(() => proxy.stop());

  await proxy.request("/health");

  const metricsText = await (await proxy.request("/metrics")).text();
  const match = metricsText.match(/gstitch_proxy_active_connections (\d+)/);
  assert.ok(match, "active_connections must be present in /metrics");
  assert.ok(Number(match[1]) >= 1, "at least the current connection must be counted");
});

// ---------------------------------------------------------------------------
// ★N3 — HEAD support
// ---------------------------------------------------------------------------

test("★N3 – HEAD /health returns 200 with no body, GET is unchanged", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: "env-key" });
  t.after(() => proxy.stop());

  const head = await proxy.request("/health", { method: "HEAD" });
  assert.equal(head.status, 200, "HEAD /health must be 200");
  assert.equal(await head.text(), "", "HEAD must not return a body");

  const get = await proxy.request("/health");
  assert.equal(get.status, 200);
  const body = await readJson(get);
  assert.equal(body.status, "ok");
});

test("★N3 – HEAD /instructions returns 200 with no body", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.stop());

  const head = await proxy.request("/instructions", { method: "HEAD" });
  assert.equal(head.status, 200, "HEAD /instructions must be 200");
  assert.equal(await head.text(), "", "HEAD must not return a body");

  const get = await proxy.request("/instructions");
  assert.equal(get.status, 200);
});

test("★N3 – HEAD is rejected with 405 on /mcp, exactly like GET", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: "env-key" });
  t.after(() => proxy.stop());

  const head = await proxy.request("/mcp", { method: "HEAD" });
  assert.equal(head.status, 405);
  assert.equal(head.headers.get("allow"), "POST, OPTIONS");
});

// ---------------------------------------------------------------------------
// ★P2 — every error path must echo the JSON-RPC id
// ---------------------------------------------------------------------------

test("★P2 – 413 echoes the id from the body", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: "env-key", MAX_BODY_SIZE_BYTES: 64 });
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: 55,
    method: "tools/list",
    params: { pad: "x".repeat(200) },
  });
  assert.equal(response.status, 413);
  const body = await readJson(response);
  assert.equal(body.error.code, -32003);
  assert.equal(body.id, 55, "★P2: the 413 body must echo the request id");
});

test("★P2 – 401 echoes the id from the body", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: undefined });
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", { jsonrpc: "2.0", id: 77, method: "tools/list" });
  assert.equal(response.status, 401);
  const body = await readJson(response);
  assert.equal(body.error.code, -32007);
  assert.equal(body.id, 77, "★P2: the 401 body must echo the request id");
});

test("★P2 – 502 echoes the id from the body", async (t) => {
  const proxy = await startProxy({
    STITCH_URL: "http://127.0.0.1:1/mcp",
    STITCH_API_KEY: "env-key",
    UPSTREAM_RETRY_ENABLED: false,
  });
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", { jsonrpc: "2.0", id: 99, method: "tools/list" });
  assert.equal(response.status, 502);
  const body = await readJson(response);
  assert.equal(body.error.code, -32006);
  assert.equal(body.id, 99, "★P2: the 502 body must echo the request id");
});

test("★P2 – 504 echoes the id from the body", async (t) => {
  const upstream = await startFakeStitch({ type: "hang" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    REQUEST_TIMEOUT_MS: 150,
    UPSTREAM_RETRY_ENABLED: false,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: "req-abc",
    method: "tools/list",
  });
  assert.equal(response.status, 504);
  const body = await readJson(response);
  assert.equal(body.error.code, -32004);
  assert.equal(body.id, "req-abc", "★P2: the 504 body must echo a string id verbatim");
});

test("★P2 – 429 echoes the id from the body", async (t) => {
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    RATE_LIMIT_ENABLED: true,
    RATE_LIMIT_MAX_RPS: 1,
    RATE_LIMIT_BURST: 1,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });

  const response = await proxy.postJson("/mcp", { jsonrpc: "2.0", id: 4242, method: "tools/list" });
  assert.equal(response.status, 429);
  const body = await readJson(response);
  assert.equal(body.error.code, -32002);
  assert.equal(body.id, 4242, "★P2: the 429 body must echo the request id");
});

test("★P2 – an id of 0 is echoed rather than treated as absent", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: undefined });
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", { jsonrpc: "2.0", id: 0, method: "tools/list" });
  assert.equal(response.status, 401);
  assert.equal((await readJson(response)).id, 0);
});

test("★P2 – an unparseable body falls back to id null without throwing", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: undefined });
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", "not json at all", {
    headers: { "Content-Type": "text/plain" },
  });
  assert.equal(response.status, 401);
  assert.equal((await readJson(response)).id, null);
});

test("★P2 – a JSON-RPC batch gets one error object per request that has an id", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: undefined });
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  assert.equal(response.status, 401);

  const body = await readJson(response);
  assert.ok(Array.isArray(body), "a batch must be answered with an array");
  assert.equal(body.length, 2);
  assert.deepEqual(
    body.map((entry) => entry.id),
    [1, 2],
    "★P2: each batched request must get its own id back",
  );
  for (const entry of body) {
    assert.equal(entry.error.code, -32007);
  }
});

test("★P2 – a successful response still passes the upstream body through verbatim", async (t) => {
  // Deliberately a `tools/call` result, not `tools/list`: `tools/list` bodies are now annotated
  // on the way back (Phase 3, ADR 0003), which is asserted in `test/phase3.test.js`. This test
  // exists to prove the passthrough mechanism itself is transparent.
  const upstream = await startFakeStitch({
    type: "json",
    body: { jsonrpc: "2.0", id: 5, result: { screens: [{ id: "s1", title: "Home" }] } },
  });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const body = await proxy.postJsonForJson("/mcp", {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "list_screens" },
  });
  assert.deepEqual(body, {
    jsonrpc: "2.0",
    id: 5,
    result: { screens: [{ id: "s1", title: "Home" }] },
  });
});

// ---------------------------------------------------------------------------
// ★N2 — the size limit must apply before authentication
// ---------------------------------------------------------------------------

test("★N2 – an over-sized body is rejected with 413 even when unauthenticated", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: undefined, MAX_BODY_SIZE_BYTES: 64 });
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: { pad: "x".repeat(5000) },
  });

  assert.equal(
    response.status,
    413,
    "the size limit must be enforced before the credential decision",
  );
  assert.equal((await readJson(response)).error.code, -32003);
});

// ---------------------------------------------------------------------------
// ★P1 — header forwarding, both directions
// ---------------------------------------------------------------------------

test("★P1 – MCP protocol headers are forwarded to the upstream", async (t) => {
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    {
      headers: {
        "MCP-Protocol-Version": "2025-06-18",
        "Mcp-Session-Id": "client-session-1",
        "Last-Event-ID": "42",
      },
    },
  );

  const [received] = upstream.requests();
  assert.equal(
    received.headers["mcp-protocol-version"],
    "2025-06-18",
    "★P1: MCP-Protocol-Version must reach Stitch",
  );
  assert.equal(
    received.headers["mcp-session-id"],
    "client-session-1",
    "★P1: Mcp-Session-Id must reach Stitch",
  );
  assert.equal(received.headers["last-event-id"], "42", "★P1: Last-Event-ID must reach Stitch");
});

test("★P1 – request metadata headers are forwarded to the upstream", async (t) => {
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_projects" } },
    {
      headers: {
        "Mcp-Method": "tools/call",
        "Mcp-Name": "list_projects",
        "Mcp-Param-ProjectId": "proj-1",
      },
    },
  );

  const [received] = upstream.requests();
  assert.equal(received.headers["mcp-method"], "tools/call");
  assert.equal(received.headers["mcp-name"], "list_projects");
  assert.equal(received.headers["mcp-param-projectid"], "proj-1");
});

test("★P1 – MCP response headers are forwarded to the client", async (t) => {
  const upstream = await startFakeStitch({
    type: "json",
    headers: {
      "Mcp-Session-Id": "sess-abc",
      "MCP-Protocol-Version": "2025-06-18",
      "Retry-After": "7",
      "WWW-Authenticate": 'Bearer realm="stitch"',
    },
    body: { jsonrpc: "2.0", id: 1, result: {} },
  });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });

  assert.equal(response.headers.get("mcp-session-id"), "sess-abc", "★P1: session id lost");
  assert.equal(
    response.headers.get("mcp-protocol-version"),
    "2025-06-18",
    "★P1: protocol version lost",
  );
  assert.equal(response.headers.get("retry-after"), "7", "★P1: Retry-After lost");
  assert.equal(
    response.headers.get("www-authenticate"),
    'Bearer realm="stitch"',
    "★P1: WWW-Authenticate lost",
  );
});

test("★P1 – SSE responses carry X-Accel-Buffering: no and the session id", async (t) => {
  const upstream = await startFakeStitch({
    type: "sse",
    headers: { "Mcp-Session-Id": "sess-sse" },
    events: ['event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'],
    endAfterMs: 20,
  });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    rawBody: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  assert.equal(response.headers.get("mcp-session-id"), "sess-sse");
  assert.equal(
    response.headers.get("x-accel-buffering"),
    "no",
    "SSE responses should tell reverse proxies not to buffer",
  );
  await response.text();
});

test("★P1 – hop-by-hop and unrelated request headers are not forwarded", async (t) => {
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    {
      headers: {
        Cookie: "session=leaky",
        "X-Forwarded-For": "1.2.3.4",
        "X-Custom-Secret": "do-not-forward",
      },
    },
  );

  const [received] = upstream.requests();
  assert.equal(received.headers.cookie, undefined, "cookies must not be forwarded upstream");
  assert.equal(
    received.headers["x-custom-secret"],
    undefined,
    "unrelated headers must not be forwarded upstream",
  );
});

// ---------------------------------------------------------------------------
// ★C2 regression guard: valid-but-unusual Host values must NOT be rejected
// ---------------------------------------------------------------------------

test("★C2 – legitimate Host values are still accepted after Host validation", async (t) => {
  // Caught by the Phase 2 unit tests: comparing `parsed.host` against the raw header rejected
  // `EXAMPLE.com` and `example.com:80`, because `URL` case-folds host names and drops default
  // ports. Host validation must reject malformed values without rejecting valid ones.
  const proxy = await startProxy({ STITCH_API_KEY: "env-key" });
  t.after(() => proxy.stop());

  // Phase 5 changed the *policy* (public hosts are refused, ADR 0005) but not the *parser*.
  // These are the forms a LAN deployment actually sends, including the normalisations that once
  // broke: a case-folded name and an elided default port.
  for (const host of [
    "localhost",
    "localhost:8787",
    "LOCALHOST",
    "127.0.0.1:11401",
    "192.168.178.94:11401",
    "MY-LAPTOP.local",
    "192.168.1.20:80",
    "[::1]:80",
    "[fd00::1]:11401",
    "latitude",
  ]) {
    const response = await rawRequest(
      proxy.port,
      `GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
    );
    assert.equal(response.status, 200, `Host ${host} should be accepted, got ${response.status}`);
  }

  assert.equal(await isServerAlive(proxy.port), true);
});
