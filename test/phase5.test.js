// @ts-check
"use strict";

/**
 * Phase 5 — the security model (ADR 0005).
 *
 * Owner decisions that shape this phase:
 *   1. bind `0.0.0.0` — the proxy must stay reachable from other LAN computers;
 *   2. origins must accept LAN computers, but not the public internet;
 *   3. no `PROXY_AUTH_TOKEN` — LAN-only reachability is the control;
 *   5. rate limiting enabled by default with a generous limit.
 *
 * So the model is **"private network allowed, public internet refused"**, not "loopback only".
 * That is what makes ★C3 and ★C4 fixable without breaking the owner's LAN setup.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { startProxy, readJson } = require("./helpers/startProxy.js");
const { startFakeStitch } = require("./helpers/fakeStitch.js");
const { rawRequest } = require("./helpers/rawHttp.js");

const {
  isPrivateAddress,
  originAllowedByDefault,
  evaluateOrigin,
  evaluateHost,
  isLoopbackAddress,
} = require("../src/http/security.js");

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

test("security: RFC1918 and IPv6 ULA addresses are private", () => {
  for (const address of [
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.10",
    "192.168.178.94",
    "127.0.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
  ]) {
    assert.equal(isPrivateAddress(address), true, `${address} should be private`);
  }
});

test("security: public addresses are not private", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "203.0.113.5", "172.32.0.1", "2001:db8::1"]) {
    assert.equal(isPrivateAddress(address), false, `${address} should be public`);
  }
});

test("security: 172.16/12 boundaries are handled exactly", () => {
  assert.equal(isPrivateAddress("172.15.255.255"), false);
  assert.equal(isPrivateAddress("172.16.0.0"), true);
  assert.equal(isPrivateAddress("172.31.255.255"), true);
  assert.equal(isPrivateAddress("172.32.0.0"), false);
});

test("security: loopback detection", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("127.5.5.5"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("192.168.1.1"), false);
});

// ---------------------------------------------------------------------------
// Origin policy: LAN yes, internet no
// ---------------------------------------------------------------------------

test("security: an absent Origin is allowed (non-browser clients)", () => {
  assert.equal(originAllowedByDefault(null), true);
});

test("security: LAN and loopback origins are allowed by default", () => {
  for (const origin of [
    "http://localhost:3000",
    "http://127.0.0.1:5173",
    "http://192.168.178.94:8080",
    "http://10.0.0.5",
    "http://172.16.4.2:9000",
    "https://192.168.1.1",
    "http://my-laptop.local:3000",
    "http://[::1]:3000",
    "http://[fd00::1]:3000",
  ]) {
    assert.equal(originAllowedByDefault(origin), true, `${origin} should be allowed`);
  }
});

test("security: public-internet origins are refused by default (★C3)", () => {
  for (const origin of [
    "https://evil.example",
    "http://evil.example",
    "https://attacker.co.uk:8443",
    "http://8.8.8.8",
    "https://some-random-site.com",
  ]) {
    assert.equal(originAllowedByDefault(origin), false, `${origin} must be refused`);
  }
});

test("security: a malformed Origin is refused, not crashed on", () => {
  for (const origin of ["not a url", "http://[bad", "://missing-scheme", ""]) {
    const decision = evaluateOrigin(origin, { corsOrigin: undefined });
    assert.equal(
      decision.allowed,
      origin === "",
      `${JSON.stringify(origin)} → ${decision.allowed}`,
    );
  }
});

test("security: https://localhost without a port is allowed", () => {
  assert.equal(originAllowedByDefault("https://localhost"), true);
});

test("security: an absolute CORS_ORIGIN overrides the LAN default", () => {
  const decision = evaluateOrigin("https://custom.example", {
    corsOrigin: "https://custom.example",
  });
  assert.equal(decision.allowed, true);

  const other = evaluateOrigin("https://other.example", { corsOrigin: "https://custom.example" });
  assert.equal(other.allowed, false);
});

test("security: '*' explicitly restores the old permissive behaviour", () => {
  const decision = evaluateOrigin("https://anything.example", { corsOrigin: "*" });
  assert.equal(decision.allowed, true);
  assert.match(decision.reason, /explicitly allowed/i);
});

test("security: ALLOWED_ORIGINS accepts extra origins", () => {
  const decision = evaluateOrigin("https://my-nas.example", {
    corsOrigin: undefined,
    allowedOrigins: new Set(["https://my-nas.example"]),
  });
  assert.equal(decision.allowed, true);
});

// ---------------------------------------------------------------------------
// Host policy: DNS rebinding
// ---------------------------------------------------------------------------

test("security: LAN and loopback Host values are accepted", () => {
  for (const host of [
    "localhost",
    "localhost:8787",
    "127.0.0.1:11401",
    "192.168.178.94:11401",
    "10.0.0.5",
    "172.16.4.2:8080",
    "[::1]:11401",
    "my-laptop.local",
    "latitude:11401",
  ]) {
    const decision = evaluateHost({ headers: { host } }, {});
    assert.equal(decision.allowed, true, `${host} should be accepted → ${decision.reason}`);
  }
});

test("security: a public Host is refused, which is what stops DNS rebinding", () => {
  for (const host of ["evil.example", "attacker.co.uk:8443", "8.8.8.8"]) {
    const decision = evaluateHost({ headers: { host } }, {});
    assert.equal(decision.allowed, false, `${host} must be refused`);
  }
});

test("security: an absent Host is accepted (HTTP/1.0)", () => {
  assert.equal(evaluateHost({ headers: {} }, {}).allowed, true);
});

test("security: ALLOWED_HOSTS adds an explicit host", () => {
  const decision = evaluateHost(
    { headers: { host: "gateway.example" } },
    { allowedHosts: new Set(["gateway.example"]) },
  );
  assert.equal(decision.allowed, true);

  const stillBlocked = evaluateHost(
    { headers: { host: "other.example" } },
    { allowedHosts: new Set(["gateway.example"]) },
  );
  assert.equal(stillBlocked.allowed, false);
});

// ---------------------------------------------------------------------------
// End-to-end ★C3
// ---------------------------------------------------------------------------

test("★C3 – a public-internet origin is refused on /mcp", async (t) => {
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { headers: { Origin: "https://evil.example" } },
  );

  assert.equal(response.status, 403);
  const body = await readJson(response);
  assert.equal(body.error.code, -32001);
  assert.equal(upstream.count(), 0, "★C3: the request must never reach Stitch");
});

test("★C3 – a LAN origin is still accepted on /mcp", async (t) => {
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  for (const origin of ["http://192.168.178.94:3000", "http://localhost:3000", "http://10.0.0.9"]) {
    const response = await proxy.postJson(
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { headers: { Origin: origin } },
    );
    assert.equal(response.status, 200, `${origin} should be accepted`);
  }
});

test("★C3 – a public Host is refused (DNS rebinding)", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: "env-key" });
  t.after(() => proxy.stop());

  const result = await rawRequest(
    proxy.port,
    "GET /health HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
  );

  assert.equal(result.status, 403, `a public Host must be refused, got ${result.status}`);
});

test("★C3 – a request with no Origin is still allowed (CLI clients)", async (t) => {
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(response.status, 200);
});

// ---------------------------------------------------------------------------
// ★C4 — scoped CORS and protected viewer/metrics
// ---------------------------------------------------------------------------

test("★C4 – no CORS headers on /logs, /api/*, /metrics or /health", async (t) => {
  const proxy = await startProxy({ LOG_VIEWER_ENABLED: true, METRICS_ENABLED: true });
  t.after(() => proxy.stop());

  for (const path of ["/logs", "/api/logs", "/api/logs/summary", "/metrics", "/health"]) {
    const response = await proxy.request(path, { headers: { Origin: "https://evil.example" } });
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      null,
      `★C4: ${path} must not advertise CORS to a browser`,
    );
  }
});

test("★C4 – /mcp still advertises CORS for an allowed LAN origin", async (t) => {
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.request("/mcp", {
    method: "OPTIONS",
    headers: { Origin: "http://192.168.1.5:3000", "Access-Control-Request-Method": "POST" },
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://192.168.1.5:3000");
  assert.equal(response.headers.get("vary"), "Origin", "a reflected origin must vary");
});

test("★C4 – a preflight from a public origin is refused", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: "env-key" });
  t.after(() => proxy.stop());

  const response = await proxy.request("/mcp", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
  });

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("★C4 – the log viewer and metrics require loopback unless allowed", async (t) => {
  const proxy = await startProxy({ LOG_VIEWER_ENABLED: true, METRICS_ENABLED: true });
  t.after(() => proxy.stop());

  // The test client connects over loopback, so these must still work.
  assert.equal((await proxy.request("/logs")).status, 200);
  assert.equal((await proxy.request("/metrics")).status, 200);
});

test("★C4 – a non-loopback peer is refused the viewer and metrics", async (t) => {
  // Simulated by presenting a forwarding header the operator opted into trusting.
  const proxy = await startProxy({
    LOG_VIEWER_ENABLED: true,
    METRICS_ENABLED: true,
    TRUST_PROXY: true,
  });
  t.after(() => proxy.stop());

  const viewer = await proxy.request("/logs", { headers: { "X-Forwarded-For": "203.0.113.9" } });
  assert.equal(viewer.status, 403, "a public client must not read the logs");

  const metrics = await proxy.request("/metrics", {
    headers: { "X-Forwarded-For": "203.0.113.9" },
  });
  assert.equal(metrics.status, 403);

  const lan = await proxy.request("/logs", { headers: { "X-Forwarded-For": "192.168.1.20" } });
  assert.equal(lan.status, 200, "a LAN client may read the logs");
});

test("★C4 – /health exposes only the public payload by default", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: "env-key" });
  t.after(() => proxy.stop());

  const body = await readJson(await proxy.request("/health"));

  assert.equal(body.status, "ok");
  assert.ok(body.version, "version should be public");
  assert.ok(body.uptime !== undefined, "uptime should be public");

  // Configuration, absolute paths and credential state must not be public.
  assert.equal(body.credentials, undefined);
  assert.equal(body.logging, undefined);
  assert.equal(body.resilience, undefined);
  assert.ok(!JSON.stringify(body).includes("/home/"), "no absolute paths in the public payload");
  assert.ok(!JSON.stringify(body).includes("envApiKeyConfigured"));
});

test("★C4 – /health?verbose=1 from loopback returns the full payload", async (t) => {
  const proxy = await startProxy({ STITCH_API_KEY: "env-key" });
  t.after(() => proxy.stop());

  const body = await readJson(await proxy.request("/health?verbose=1"));

  assert.ok(body.credentials, "verbose mode should include credential state");
  assert.ok(body.logging, "verbose mode should include logging configuration");
  assert.equal(body.credentials.envApiKeyConfigured, true);
});

// ---------------------------------------------------------------------------
// Rate limiting on by default
// ---------------------------------------------------------------------------

test("rate limiting: enabled by default with a generous limit", async (t) => {
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  // The default must not interfere with normal use: 50 rapid reads all pass.
  for (let i = 0; i < 50; i += 1) {
    const response = await proxy.postJson("/mcp", {
      jsonrpc: "2.0",
      id: i,
      method: "tools/call",
      params: { name: "list_projects" },
    });
    assert.equal(response.status, 200, `request ${i} must not be rate limited by default`);
  }
});

test("rate limiting: X-Forwarded-For is ignored unless TRUST_PROXY is on (★N4)", async (t) => {
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    RATE_LIMIT_ENABLED: true,
    RATE_LIMIT_MAX_RPS: 1,
    RATE_LIMIT_BURST: 2,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  // Each request claims a different client address. With TRUST_PROXY off that must not help.
  const statuses = [];
  for (let i = 0; i < 5; i += 1) {
    const response = await proxy.postJson(
      "/mcp",
      { jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "list_projects" } },
      { headers: { "X-Forwarded-For": `10.0.0.${i + 1}` } },
    );
    statuses.push(response.status);
  }

  assert.ok(
    statuses.filter((status) => status === 429).length >= 1,
    `spoofing X-Forwarded-For must not bypass the limit: ${statuses.join(",")}`,
  );
});

// ---------------------------------------------------------------------------
// Redaction and security headers
// ---------------------------------------------------------------------------

test("security: redaction covers x-proxy-token and cookie", () => {
  const { redactHeaders } = require("../src/http/security.js");
  const redacted = redactHeaders({
    "x-proxy-token": "secret-token",
    cookie: "session=abc",
    authorization: "Bearer x",
  });

  assert.equal(redacted["x-proxy-token"], "[redacted]");
  assert.equal(redacted.cookie, "[redacted]");
  assert.equal(redacted.authorization, "[redacted]");
  assert.ok(!JSON.stringify(redacted).includes("secret"));
});

test("security: credentials in a logged URL are scrubbed", () => {
  const { redactUrl } = require("../src/http/security.js");

  assert.equal(redactUrl("/mcp?key=AIzaSECRET123&other=1"), "/mcp?key=[redacted]&other=1");
  assert.equal(redactUrl("/mcp?api_key=SECRET&x=y"), "/mcp?api_key=[redacted]&x=y");
  assert.equal(redactUrl("/health"), "/health");
});

test("security: HTML pages carry CSP and the other hardening headers", async (t) => {
  const proxy = await startProxy({ LOG_VIEWER_ENABLED: true });
  t.after(() => proxy.stop());

  for (const path of ["/logs", "/instructions"]) {
    const response = await proxy.request(path);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-security-policy"), `${path} needs a CSP`);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
  }
});

test("security: a logged <script> body renders inert in the viewer", async (t) => {
  // Stored-XSS guard: bodies are escaped at render time, and the CSP is the second line of
  // defence. The viewer test fixture contains only plain text; this asserts the escape helper
  // the template uses (also covered directly in `test/unit.test.js`).
  const { escapeHtml } = require("../src/http/respond.js");
  const rendered = escapeHtml("<script>alert('xss')</script>");
  assert.ok(!rendered.includes("<script"));
});

// ---------------------------------------------------------------------------
// Env-key exposure to browsers
// ---------------------------------------------------------------------------

test("security: an allowed LAN browser request may use the env key (owner decision 2)", async (t) => {
  // The owner needs LAN machines to work. Since the origin policy now refuses the public
  // internet, a LAN origin is a trusted caller and the env fallback is correct for it.
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { headers: { Origin: "http://192.168.1.50:3000" } },
  );

  assert.equal(response.status, 200, "a LAN browser must be able to use the proxy");
  assert.equal(upstream.requests()[0].headers["x-goog-api-key"], "env-key");
});

test("security: a public browser request cannot reach the env key at all", async (t) => {
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({ STITCH_URL: upstream.url, STITCH_API_KEY: "env-key" });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { headers: { Origin: "https://evil.example" } },
  );

  assert.equal(response.status, 403);
  assert.equal(upstream.count(), 0, "no upstream request, so no key spent");
});

test("security: a request supplying its own key from a LAN origin still works", async (t) => {
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({ STITCH_URL: upstream.url });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { headers: { Origin: "http://10.0.0.7:3000", "x-stitch-api-key": "own-key" } },
  );

  assert.equal(upstream.requests()[0].headers["x-goog-api-key"], "own-key");
});

// ---------------------------------------------------------------------------
// ★N9 / ★N10 / ★N11 — paths, discovery base URL, and the non-auth token
// ---------------------------------------------------------------------------

test("★N9 – INSTRUCTIONS.md resolves next to index.js, not the working directory", async (t) => {
  const { createProxyServer } = require("../index.js");
  const { once } = require("node:events");
  const os = require("node:os");
  const fs = require("node:fs");

  // Start the proxy from an unrelated directory, which used to break /instructions.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "gstitch-cwd-"));
  const originalCwd = process.cwd();
  process.chdir(elsewhere);

  const server = createProxyServer({ env: { LOG_ENABLED: "false" } });
  t.after(async () => {
    process.chdir(originalCwd);
    fs.rmSync(elsewhere, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = /** @type {any} */ (server.address()).port;

  const response = await fetch(`http://127.0.0.1:${port}/instructions`);
  assert.equal(response.status, 200, "★N9: /instructions must work from any working directory");
  await response.text();
});

test("★N9 – a relative LOG_DIR resolves next to index.js", () => {
  const { applyConfig, getConfig } = require("../index.js");
  const path = require("node:path");

  applyConfig({ LOG_DIR: "logs" });
  const configured = getConfig().LOG_DIR;

  assert.ok(path.isAbsolute(configured));
  assert.equal(
    configured,
    path.join(path.join(__dirname, ".."), "logs"),
    "a relative LOG_DIR must be relative to the project, not the working directory",
  );
});

test("★N10 – the discovery stubs use the request's own origin, not a hard-coded localhost", async (t) => {
  const proxy = await startProxy({ MCP_SERVER_PORT: 9999 });
  t.after(() => proxy.stop());

  const response = await proxy.request("/.well-known/openid-configuration");
  const body = await readJson(response);

  assert.ok(
    !body.issuer.includes(":9999"),
    `★N10: the issuer must not be the configured port when the client used another one (got ${body.issuer})`,
  );
  assert.match(body.issuer, new RegExp(`:${proxy.port}$`), "the issuer should match the request host");
  assert.equal(body.token_endpoint, `${body.issuer}/token`);
});

test("★N10 – PUBLIC_BASE_URL overrides the advertised base", async (t) => {
  const proxy = await startProxy({ PUBLIC_BASE_URL: "https://stitch-proxy.lan" });
  t.after(() => proxy.stop());

  const body = await readJson(await proxy.request("/.well-known/oauth-protected-resource"));
  assert.equal(body.resource, "https://stitch-proxy.lan");
  assert.deepEqual(body.authorization_servers, ["https://stitch-proxy.lan"]);
});

test("★N11 – the issued token is documented and inert, and is not accepted as auth", async (t) => {
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({ STITCH_URL: upstream.url });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const token = await readJson(await proxy.request("/token", { method: "POST" }));
  assert.equal(token.access_token, "local-proxy-token");

  // It grants nothing: without a Stitch credential the request is still rejected, and the
  // placeholder is not turned into a Stitch key.
  const response = await proxy.postJson(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { headers: { Authorization: `Bearer ${token.access_token}` } },
  );
  assert.equal(response.status, 401, "★N11: the placeholder token must not authenticate anything");
  assert.equal(upstream.count(), 0);
});
