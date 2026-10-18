// @ts-check
"use strict";

/**
 * Phase 6 — configuration drift tests.
 *
 * The proxy has 48 configuration bindings, documented in `PROGRESS.md` and `.env.example`. Drift
 * between the three is the classic failure mode: an operator sets a variable that the code
 * silently ignores, or a new variable ships undocumented.
 *
 * These tests fail when the code, the documentation and the example file disagree.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { applyConfig, getConfig, createProxyServerInternals } = require("../index.js");

const ROOT = path.join(__dirname, "..");

/** Environment variable names the code actually reads. */
const ENV_VARIABLES = [
  "ALLOWED_HOSTS",
  "ALLOWED_ORIGINS",
  "ANNOTATE_TOOLS",
  "CONCURRENCY_QUEUE_WAIT_MS",
  "CORS_ORIGIN",
  "ENABLE_GCLOUD_FALLBACK",
  "LOCAL_FALLBACK_METHODS",
  "LOG_DIR",
  "LOG_ENABLED",
  "LOG_FILE_NAME",
  "LOG_LEVEL",
  "LOG_MAX_BODY_CHARS",
  "LOG_MAX_FILE_SIZE_BYTES",
  "LOG_MAX_ROTATED_FILES",
  "LOG_SKIP_MCP_GET",
  "LOG_SKIP_MCP_METHODS",
  "LOG_SLOW_REQUEST_MS",
  "LOG_SUMMARY_MAX_LINES",
  "LOG_VERY_SLOW_REQUEST_MS",
  "LOG_VIEWER_ENABLED",
  "LOG_VIEWER_MAX_FILE_BYTES",
  "MAX_BODY_SIZE_BYTES",
  "MAX_CONCURRENT_UPSTREAM",
  "MCP_SERVER_HOST",
  "MCP_SERVER_PORT",
  "METRICS_ENABLED",
  "RATE_LIMIT_BURST",
  "RATE_LIMIT_ENABLED",
  "RATE_LIMIT_MAX_RPS",
  "REPLAY_MAX_ENTRIES",
  "REPLAY_MAX_TOTAL_BYTES",
  "REPLAY_WINDOW_MS",
  "REQUEST_TIMEOUT_MS",
  "SAFE_TOOLS",
  "SERVER_HEADERS_TIMEOUT_MS",
  "SERVER_KEEP_ALIVE_TIMEOUT_MS",
  "SHUTDOWN_DRAIN_MS",
  "STITCH_API_KEY",
  "STITCH_PROJECT_ID",
  "STITCH_URL",
  "STREAM_IDLE_TIMEOUT_MS",
  "STREAM_MAX_DURATION_MS",
  "TRUST_PROXY",
  "UNSAFE_MAX_DURATION_MS",
  "UNSAFE_TOOLS",
  "UPSTREAM_RETRY_ATTEMPTS",
  "UPSTREAM_RETRY_BASE_DELAY_MS",
  "UPSTREAM_RETRY_ENABLED",
];

// ---------------------------------------------------------------------------
// Code ↔ documentation
// ---------------------------------------------------------------------------

test("config: every variable the code reads is documented in PROGRESS.md", () => {
  const progress = fs.readFileSync(path.join(ROOT, "PROGRESS.md"), "utf8");
  const missing = ENV_VARIABLES.filter((name) => !progress.includes(name));

  assert.deepEqual(
    missing,
    [],
    `These environment variables are read by the code but not documented in PROGRESS.md: ${missing.join(", ")}`,
  );
});

test("config: every variable the code reads appears in .env.example", () => {
  const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  const missing = ENV_VARIABLES.filter((name) => !new RegExp(`^${name}=`, "m").test(example));

  assert.deepEqual(
    missing,
    [],
    `These environment variables are missing from .env.example: ${missing.join(", ")}`,
  );
});

test("config: .env.example documents no variable the code does not read", () => {
  const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  const documented = [...example.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]);
  const unknown = documented.filter((name) => !ENV_VARIABLES.includes(name));

  assert.deepEqual(
    unknown,
    [],
    `These .env.example entries are not read by the code: ${unknown.join(", ")}`,
  );
});

test("config: the README does not advertise a removed variable", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  // `ALLOW_ENV_API_KEY_FOR_BROWSER` was removed in Phase 5: the origin allow-list makes it
  // meaningless, because a public origin is refused before credentials are considered.
  assert.ok(
    !readme.includes("ALLOW_ENV_API_KEY_FOR_BROWSER"),
    "the README still documents a variable that no longer exists",
  );
});

// ---------------------------------------------------------------------------
// CONFIG_KEYS ↔ resolved configuration
// ---------------------------------------------------------------------------

test("config: CONFIG_KEYS and the resolved configuration describe the same fields", () => {
  const resolved = applyConfig({});
  const keys = new Set(createProxyServerInternals.CONFIG_KEYS);
  const resolvedKeys = new Set(Object.keys(resolved));

  const missingFromResolved = [...keys].filter((key) => !resolvedKeys.has(key));
  const notInConfigKeys = [...resolvedKeys].filter((key) => !keys.has(key));

  assert.deepEqual(missingFromResolved, [], "CONFIG_KEYS entries with no resolved value");
  assert.deepEqual(notInConfigKeys, [], "resolved values missing from CONFIG_KEYS");
});

test("config: an override is rejected unless the key exists", () => {
  assert.throws(
    () => applyConfig({}, { NOT_A_REAL_SETTING: 1 }),
    /Unknown configuration override/,
  );
});

test("config: every CONFIG_KEYS entry can actually be overridden", () => {
  // A key that is declared but not wired into `assignConfig` would silently keep its default.
  for (const key of createProxyServerInternals.CONFIG_KEYS) {
    const before = getConfig()[key];
    const probe = typeof before === "number" ? 7 : typeof before === "boolean" ? !before : "probe";
    applyConfig({}, { [key]: probe });

    if (key === "LOG_DIR") {
      // Path settings are resolved to an absolute path on purpose, so a relative override comes
      // back absolute rather than verbatim.
      assert.ok(path.isAbsolute(getConfig()[key]), `${key} must resolve to an absolute path`);
      assert.ok(getConfig()[key].endsWith("probe"), `${key} must honour the override`);
    } else {
      assert.deepEqual(getConfig()[key], probe, `${key} could not be overridden`);
    }
  }

  applyConfig({});
});

// ---------------------------------------------------------------------------
// Documented defaults match the code
// ---------------------------------------------------------------------------

test("config: documented defaults match the resolved defaults (owner decisions)", () => {
  const config = applyConfig({});

  // Owner decisions from PROGRESS.md §12, recorded in ADRs 0005 and 0003.
  assert.equal(config.MCP_SERVER_HOST, "0.0.0.0", "owner decision 1: stay reachable on the LAN");
  assert.equal(config.CORS_ORIGIN, "", "owner decision 2: no wildcard; private network only");
  assert.equal(config.UNSAFE_MAX_DURATION_MS, 10 * 60 * 1000, "owner decision 4: 10 minutes");
  assert.equal(config.REPLAY_WINDOW_MS, 10 * 60 * 1000, "owner decision 4: 10 minutes");
  assert.equal(config.RATE_LIMIT_ENABLED, true, "owner decision 5: on by default");
  assert.equal(config.RATE_LIMIT_MAX_RPS, 100, "owner decision 5: generous");
  assert.equal(config.RATE_LIMIT_BURST, 200, "owner decision 5: generous");

  // Security posture.
  assert.equal(config.TRUST_PROXY, false, "never trust X-Forwarded-For by default (★N4)");
  assert.equal(config.ANNOTATE_TOOLS, true, "annotations on by default (ADR 0003)");
  assert.equal(config.LOG_VIEWER_ENABLED, true, "preserves the documented default");

  // Timeouts must be coherent: the proxy's own deadline fires before the socket's.
  assert.ok(
    config.REQUEST_TIMEOUT_MS < config.STREAM_MAX_DURATION_MS,
    "a request deadline must precede the absolute stream cap",
  );
  assert.ok(
    config.SERVER_HEADERS_TIMEOUT_MS <= config.REQUEST_TIMEOUT_MS,
    "a slow header write must not outlive the request deadline",
  );
});

test("config: owner decision 5 keeps the default limit generous enough for real use", () => {
  const { checkRateLimit } = require("../src/http/ratelimit.js");
  const config = applyConfig({});

  const buckets = new Map();
  const limit = { enabled: config.RATE_LIMIT_ENABLED, maxRps: config.RATE_LIMIT_MAX_RPS, burst: config.RATE_LIMIT_BURST };

  // A burst of 200 sequential calls must all pass: that is one discovery + tool sequence.
  for (let i = 0; i < 200; i += 1) {
    assert.equal(checkRateLimit(buckets, limit, "192.168.1.5", 1000).allowed, true, `call ${i}`);
  }

  assert.equal(checkRateLimit(buckets, limit, "192.168.1.5", 1000).allowed, false, "then it limits");
});

test("config: invalid numeric values fall back instead of producing NaN", () => {
  const config = applyConfig({ REQUEST_TIMEOUT_MS: "not-a-number", MCP_SERVER_PORT: "" });

  assert.equal(config.REQUEST_TIMEOUT_MS, 120000);
  assert.equal(config.MCP_SERVER_PORT, 8787);
  assert.ok(!Number.isNaN(config.REQUEST_TIMEOUT_MS));
});

test("config: boolean parsing accepts the documented spellings", () => {
  assert.equal(applyConfig({ LOG_ENABLED: "true" }).LOG_ENABLED, true);
  assert.equal(applyConfig({ LOG_ENABLED: "TRUE" }).LOG_ENABLED, true);
  assert.equal(applyConfig({ LOG_ENABLED: "false" }).LOG_ENABLED, false);
  assert.equal(applyConfig({ LOG_ENABLED: "anything-else" }).LOG_ENABLED, false);
});

test("config: CSV settings become trimmed sets and ignore empty entries", () => {
  const config = applyConfig({ LOCAL_FALLBACK_METHODS: " prompts/list , resources/list ,, " });
  assert.deepEqual([...config.LOCAL_FALLBACK_METHODS].sort(), ["prompts/list", "resources/list"]);
});

test("config: a relative LOG_DIR is resolved to an absolute path", () => {
  const config = applyConfig({ LOG_DIR: "logs" });
  assert.ok(path.isAbsolute(config.LOG_DIR), `expected an absolute path, got ${config.LOG_DIR}`);
});
