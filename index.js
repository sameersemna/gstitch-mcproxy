const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/** Reported by `/health` and used in the startup banner. Keep in step with package.json. */
const VERSION = "0.9.0";

const { describeFetchError, isTransientUpstreamError, sleep } = require("./src/upstream/errors.js");
const {
  parseJsonRpcMetadata,
  extractJsonRpcIds,
  extractProjectIdFromBody,
  rewriteJsonRpcId,
  buildLocalFallbackResponse: buildLocalFallbackResponseFor,
} = require("./src/mcp/jsonrpc.js");
const {
  createMetrics,
  recordMetrics,
  renderPrometheusMetrics,
} = require("./src/observability/metrics.js");
const {
  escapeHtml,
  formatInlineMarkdown,
  sendJson,
  sendText,
  sendHtml,
  sendJsonRpcError,
} = require("./src/http/respond.js");
const {
  setCorsHeaders: setCorsHeadersWith,
  parseHostHeader: parseHostHeaderFrom,
  evaluateOrigin,
  evaluateHost,
  setHtmlSecurityHeaders,
  isLoopbackAddress,
  isPrivateAddress,
  redactHeaders,
  redactUrl,
} = require("./src/http/security.js");
const {
  getClientIp,
  checkRateLimit: checkRateLimitFor,
  sweepRateLimitBuckets,
} = require("./src/http/ratelimit.js");
const { classifyRequest, annotationsForTool } = require("./src/mcp/classify.js");
const { decideRetry } = require("./src/upstream/retry.js");
const { createIdempotencyStore } = require("./src/idempotency/store.js");
const { streamWithBackpressure } = require("./src/upstream/stream.js");
const { createSemaphore } = require("./src/upstream/limiter.js");

function loadEnvFile(envPath = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const closingIndex = value.indexOf(quote, 1);
      value = closingIndex > 0 ? value.slice(1, closingIndex) : value.slice(1);
    } else {
      value = value.split(/\s+#/, 1)[0].trim();
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

// --- Configuration -----------------------------------------------------------
// Every value below is a `let` binding so that `applyConfig(overrides)` can replace it
// per proxy instance. That is the Phase 0 seam which lets the test harness start a proxy
// in-process on an ephemeral port with injected configuration instead of mutating
// `process.env`. Phase 2 moves these onto a frozen, validated config object.
//
// NOTE (Phase 0 limitation): the bindings are module-level, so only the *last* created
// proxy's configuration is active in a given process. Tests that need different configs
// therefore live in separate files, which `node:test` runs in separate processes.
let STITCH_URL;
let INSTRUCTIONS_PATH;
let STITCH_API_KEY;
let DEFAULT_STITCH_PROJECT_ID;
let MCP_SERVER_PORT;
let MCP_SERVER_HOST;
let LOG_ENABLED;
let LOG_LEVEL;
let LOG_DIR;
let LOG_FILE_NAME;
let LOG_MAX_BODY_CHARS;
let LOG_MAX_FILE_SIZE_BYTES;
let LOG_MAX_ROTATED_FILES;
let LOG_SKIP_MCP_GET;
let LOG_SLOW_REQUEST_MS;
let LOG_VERY_SLOW_REQUEST_MS;
let LOG_SKIP_MCP_METHODS;
let REQUEST_TIMEOUT_MS;
let MAX_BODY_SIZE_BYTES;
let UPSTREAM_RETRY_ENABLED;
let UPSTREAM_RETRY_ATTEMPTS;
let UPSTREAM_RETRY_BASE_DELAY_MS;
let LOCAL_FALLBACK_METHODS;
let RATE_LIMIT_ENABLED;
let RATE_LIMIT_MAX_RPS;
let RATE_LIMIT_BURST;
let CORS_ORIGIN;
let METRICS_ENABLED;
let SHUTDOWN_DRAIN_MS;
let LOG_VIEWER_ENABLED;
let LOG_VIEWER_MAX_FILE_BYTES;
let LOG_SUMMARY_MAX_LINES;
let UNSAFE_MAX_DURATION_MS;
let REPLAY_WINDOW_MS;
let REPLAY_MAX_ENTRIES;
let REPLAY_MAX_TOTAL_BYTES;
let ANNOTATE_TOOLS;
let SAFE_TOOLS_CSV;
let UNSAFE_TOOLS_CSV;
let STREAM_IDLE_TIMEOUT_MS;
let STREAM_MAX_DURATION_MS;
let SERVER_HEADERS_TIMEOUT_MS;
let SERVER_KEEP_ALIVE_TIMEOUT_MS;
let MAX_CONCURRENT_UPSTREAM;
let CONCURRENCY_QUEUE_WAIT_MS;
let ALLOWED_ORIGINS_CSV;
let ALLOWED_HOSTS_CSV;
let ALLOW_ALL_HOSTS;
let TRUST_PROXY;

function parseBoolean(value, fallback) {
  return String(value === undefined || value === null ? fallback : value).toLowerCase() === "true";
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(
    value === undefined || value === null ? String(fallback) : String(value),
    10,
  );
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseCsvSet(value, fallback) {
  return new Set(
    String(value === undefined || value === null ? fallback : value)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

/**
 * The set of configuration keys that may be injected via `createProxyServer(overrides)`
 * (and the keys `resolveConfigFromEnv` produces). Keeping the list explicit means a typo
 * in a test fails loudly instead of being silently ignored.
 */
const CONFIG_KEYS = [
  "STITCH_URL",
  "STITCH_API_KEY",
  "DEFAULT_STITCH_PROJECT_ID",
  "MCP_SERVER_PORT",
  "MCP_SERVER_HOST",
  "LOG_ENABLED",
  "LOG_LEVEL",
  "LOG_DIR",
  "LOG_FILE_NAME",
  "LOG_MAX_BODY_CHARS",
  "LOG_MAX_FILE_SIZE_BYTES",
  "LOG_MAX_ROTATED_FILES",
  "LOG_SKIP_MCP_GET",
  "LOG_SLOW_REQUEST_MS",
  "LOG_VERY_SLOW_REQUEST_MS",
  "LOG_SKIP_MCP_METHODS",
  "REQUEST_TIMEOUT_MS",
  "MAX_BODY_SIZE_BYTES",
  "UPSTREAM_RETRY_ENABLED",
  "UPSTREAM_RETRY_ATTEMPTS",
  "UPSTREAM_RETRY_BASE_DELAY_MS",
  "LOCAL_FALLBACK_METHODS",
  "RATE_LIMIT_ENABLED",
  "RATE_LIMIT_MAX_RPS",
  "RATE_LIMIT_BURST",
  "CORS_ORIGIN",
  "METRICS_ENABLED",
  "SHUTDOWN_DRAIN_MS",
  "LOG_VIEWER_ENABLED",
  "LOG_VIEWER_MAX_FILE_BYTES",
  "LOG_SUMMARY_MAX_LINES",
  "UNSAFE_MAX_DURATION_MS",
  "REPLAY_WINDOW_MS",
  "REPLAY_MAX_ENTRIES",
  "REPLAY_MAX_TOTAL_BYTES",
  "ANNOTATE_TOOLS",
  "SAFE_TOOLS_CSV",
  "UNSAFE_TOOLS_CSV",
  "STREAM_IDLE_TIMEOUT_MS",
  "STREAM_MAX_DURATION_MS",
  "SERVER_HEADERS_TIMEOUT_MS",
  "SERVER_KEEP_ALIVE_TIMEOUT_MS",
  "MAX_CONCURRENT_UPSTREAM",
  "CONCURRENCY_QUEUE_WAIT_MS",
  "ALLOWED_ORIGINS_CSV",
  "ALLOWED_HOSTS_CSV",
  "ALLOW_ALL_HOSTS",
  "TRUST_PROXY",
];

/**
 * Installs a resolved config object into the module-level bindings.
 * @param {Record<string, any>} resolved
 */
function assignConfig(resolved) {
  // `INSTRUCTIONS_PATH` is not overridable: it is derived from the process CWD, exactly as
  // before this seam existed (documented as a known issue and fixed in Phase 6).
  INSTRUCTIONS_PATH = path.resolve(process.cwd(), "INSTRUCTIONS.md");

  for (const key of CONFIG_KEYS) {
    configTargets[key].set(resolved[key]);
  }
}

/**
 * Writable handles for each configuration binding.
 *
 * `applyConfig` cannot assign to the `let` bindings directly because it must do so
 * dynamically from `CONFIG_KEYS`. A closure per key keeps the assignment typed and
 * exhaustively covered at module load (`assertConfigTargetsComplete`).
 */
const configTargets = (() => {
  /** @type {Record<string, { get: () => any, set: (value: any) => void }>} */
  const targets = {};
  const define = (key, get, set) => {
    Object.defineProperty(targets, key, {
      value: { get, set },
      enumerable: true,
    });
  };

  define(
    "STITCH_URL",
    () => STITCH_URL,
    (v) => (STITCH_URL = v),
  );
  define(
    "STITCH_API_KEY",
    () => STITCH_API_KEY,
    (v) => (STITCH_API_KEY = v),
  );
  define(
    "DEFAULT_STITCH_PROJECT_ID",
    () => DEFAULT_STITCH_PROJECT_ID,
    (v) => (DEFAULT_STITCH_PROJECT_ID = v),
  );
  define(
    "MCP_SERVER_PORT",
    () => MCP_SERVER_PORT,
    (v) => (MCP_SERVER_PORT = v),
  );
  define(
    "MCP_SERVER_HOST",
    () => MCP_SERVER_HOST,
    (v) => (MCP_SERVER_HOST = v),
  );
  define(
    "LOG_ENABLED",
    () => LOG_ENABLED,
    (v) => (LOG_ENABLED = v),
  );
  define(
    "LOG_LEVEL",
    () => LOG_LEVEL,
    (v) => (LOG_LEVEL = v),
  );
  define(
    "LOG_DIR",
    () => LOG_DIR,
    (v) => (LOG_DIR = v),
  );
  define(
    "LOG_FILE_NAME",
    () => LOG_FILE_NAME,
    (v) => (LOG_FILE_NAME = v),
  );
  define(
    "LOG_MAX_BODY_CHARS",
    () => LOG_MAX_BODY_CHARS,
    (v) => (LOG_MAX_BODY_CHARS = v),
  );
  define(
    "LOG_MAX_FILE_SIZE_BYTES",
    () => LOG_MAX_FILE_SIZE_BYTES,
    (v) => (LOG_MAX_FILE_SIZE_BYTES = v),
  );
  define(
    "LOG_MAX_ROTATED_FILES",
    () => LOG_MAX_ROTATED_FILES,
    (v) => (LOG_MAX_ROTATED_FILES = v),
  );
  define(
    "LOG_SKIP_MCP_GET",
    () => LOG_SKIP_MCP_GET,
    (v) => (LOG_SKIP_MCP_GET = v),
  );
  define(
    "LOG_SLOW_REQUEST_MS",
    () => LOG_SLOW_REQUEST_MS,
    (v) => (LOG_SLOW_REQUEST_MS = v),
  );
  define(
    "LOG_VERY_SLOW_REQUEST_MS",
    () => LOG_VERY_SLOW_REQUEST_MS,
    (v) => (LOG_VERY_SLOW_REQUEST_MS = v),
  );
  define(
    "LOG_SKIP_MCP_METHODS",
    () => LOG_SKIP_MCP_METHODS,
    (v) => (LOG_SKIP_MCP_METHODS = v),
  );
  define(
    "REQUEST_TIMEOUT_MS",
    () => REQUEST_TIMEOUT_MS,
    (v) => (REQUEST_TIMEOUT_MS = v),
  );
  define(
    "MAX_BODY_SIZE_BYTES",
    () => MAX_BODY_SIZE_BYTES,
    (v) => (MAX_BODY_SIZE_BYTES = v),
  );
  define(
    "UPSTREAM_RETRY_ENABLED",
    () => UPSTREAM_RETRY_ENABLED,
    (v) => (UPSTREAM_RETRY_ENABLED = v),
  );
  define(
    "UPSTREAM_RETRY_ATTEMPTS",
    () => UPSTREAM_RETRY_ATTEMPTS,
    (v) => (UPSTREAM_RETRY_ATTEMPTS = v),
  );
  define(
    "UPSTREAM_RETRY_BASE_DELAY_MS",
    () => UPSTREAM_RETRY_BASE_DELAY_MS,
    (v) => (UPSTREAM_RETRY_BASE_DELAY_MS = v),
  );
  define(
    "LOCAL_FALLBACK_METHODS",
    () => LOCAL_FALLBACK_METHODS,
    (v) => (LOCAL_FALLBACK_METHODS = v),
  );
  define(
    "RATE_LIMIT_ENABLED",
    () => RATE_LIMIT_ENABLED,
    (v) => (RATE_LIMIT_ENABLED = v),
  );
  define(
    "RATE_LIMIT_MAX_RPS",
    () => RATE_LIMIT_MAX_RPS,
    (v) => (RATE_LIMIT_MAX_RPS = v),
  );
  define(
    "RATE_LIMIT_BURST",
    () => RATE_LIMIT_BURST,
    (v) => (RATE_LIMIT_BURST = v),
  );
  define(
    "CORS_ORIGIN",
    () => CORS_ORIGIN,
    (v) => (CORS_ORIGIN = v),
  );
  define(
    "METRICS_ENABLED",
    () => METRICS_ENABLED,
    (v) => (METRICS_ENABLED = v),
  );
  define(
    "SHUTDOWN_DRAIN_MS",
    () => SHUTDOWN_DRAIN_MS,
    (v) => (SHUTDOWN_DRAIN_MS = v),
  );
  define(
    "LOG_VIEWER_ENABLED",
    () => LOG_VIEWER_ENABLED,
    (v) => (LOG_VIEWER_ENABLED = v),
  );
  define(
    "LOG_VIEWER_MAX_FILE_BYTES",
    () => LOG_VIEWER_MAX_FILE_BYTES,
    (v) => (LOG_VIEWER_MAX_FILE_BYTES = v),
  );
  define(
    "LOG_SUMMARY_MAX_LINES",
    () => LOG_SUMMARY_MAX_LINES,
    (v) => (LOG_SUMMARY_MAX_LINES = v),
  );
  define(
    "UNSAFE_MAX_DURATION_MS",
    () => UNSAFE_MAX_DURATION_MS,
    (v) => (UNSAFE_MAX_DURATION_MS = v),
  );
  define(
    "REPLAY_WINDOW_MS",
    () => REPLAY_WINDOW_MS,
    (v) => (REPLAY_WINDOW_MS = v),
  );
  define(
    "REPLAY_MAX_ENTRIES",
    () => REPLAY_MAX_ENTRIES,
    (v) => (REPLAY_MAX_ENTRIES = v),
  );
  define(
    "REPLAY_MAX_TOTAL_BYTES",
    () => REPLAY_MAX_TOTAL_BYTES,
    (v) => (REPLAY_MAX_TOTAL_BYTES = v),
  );
  define(
    "ANNOTATE_TOOLS",
    () => ANNOTATE_TOOLS,
    (v) => (ANNOTATE_TOOLS = v),
  );
  define(
    "SAFE_TOOLS_CSV",
    () => SAFE_TOOLS_CSV,
    (v) => (SAFE_TOOLS_CSV = v),
  );
  define(
    "UNSAFE_TOOLS_CSV",
    () => UNSAFE_TOOLS_CSV,
    (v) => (UNSAFE_TOOLS_CSV = v),
  );
  define(
    "STREAM_IDLE_TIMEOUT_MS",
    () => STREAM_IDLE_TIMEOUT_MS,
    (v) => (STREAM_IDLE_TIMEOUT_MS = v),
  );
  define(
    "STREAM_MAX_DURATION_MS",
    () => STREAM_MAX_DURATION_MS,
    (v) => (STREAM_MAX_DURATION_MS = v),
  );
  define(
    "SERVER_HEADERS_TIMEOUT_MS",
    () => SERVER_HEADERS_TIMEOUT_MS,
    (v) => (SERVER_HEADERS_TIMEOUT_MS = v),
  );
  define(
    "SERVER_KEEP_ALIVE_TIMEOUT_MS",
    () => SERVER_KEEP_ALIVE_TIMEOUT_MS,
    (v) => (SERVER_KEEP_ALIVE_TIMEOUT_MS = v),
  );
  define(
    "MAX_CONCURRENT_UPSTREAM",
    () => MAX_CONCURRENT_UPSTREAM,
    (v) => (MAX_CONCURRENT_UPSTREAM = v),
  );
  define(
    "CONCURRENCY_QUEUE_WAIT_MS",
    () => CONCURRENCY_QUEUE_WAIT_MS,
    (v) => (CONCURRENCY_QUEUE_WAIT_MS = v),
  );
  define(
    "ALLOWED_ORIGINS_CSV",
    () => ALLOWED_ORIGINS_CSV,
    (v) => (ALLOWED_ORIGINS_CSV = v),
  );
  define(
    "ALLOWED_HOSTS_CSV",
    () => ALLOWED_HOSTS_CSV,
    (v) => (ALLOWED_HOSTS_CSV = v),
  );
  define(
    "ALLOW_ALL_HOSTS",
    () => ALLOW_ALL_HOSTS,
    (v) => (ALLOW_ALL_HOSTS = v),
  );
  define(
    "TRUST_PROXY",
    () => TRUST_PROXY,
    (v) => (TRUST_PROXY = v),
  );

  return targets;
})();

/**
 * Builds the resolved configuration object from environment variables.
 * The precedence is unchanged from the pre-seam code: env var, else hard-coded default.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {Record<string, any>}
 */
function resolveConfigFromEnv(env) {
  return {
    STITCH_URL: env.STITCH_URL || "https://stitch.googleapis.com/mcp",
    STITCH_API_KEY: env.STITCH_API_KEY,
    DEFAULT_STITCH_PROJECT_ID: env.STITCH_PROJECT_ID,
    MCP_SERVER_PORT: parseInteger(env.MCP_SERVER_PORT, 8787),
    // Bind address. Defaults to all interfaces so existing LAN setups keep working.
    // Set MCP_SERVER_HOST=127.0.0.1 to bind loopback only (recommended by the MCP spec).
    MCP_SERVER_HOST: env.MCP_SERVER_HOST || "0.0.0.0",
    LOG_ENABLED: parseBoolean(env.LOG_ENABLED, "false"),
    LOG_LEVEL: String(env.LOG_LEVEL || "info").toLowerCase(),
    LOG_DIR: path.resolve(process.cwd(), env.LOG_DIR || "logs"),
    LOG_FILE_NAME: env.LOG_FILE_NAME || "proxy.log",
    LOG_MAX_BODY_CHARS: parseInteger(env.LOG_MAX_BODY_CHARS, 20000),
    LOG_MAX_FILE_SIZE_BYTES: parseInteger(env.LOG_MAX_FILE_SIZE_BYTES, 5242880),
    LOG_MAX_ROTATED_FILES: parseInteger(env.LOG_MAX_ROTATED_FILES, 5),
    LOG_SKIP_MCP_GET: parseBoolean(env.LOG_SKIP_MCP_GET, "true"),
    LOG_SLOW_REQUEST_MS: parseInteger(env.LOG_SLOW_REQUEST_MS, 2000),
    LOG_VERY_SLOW_REQUEST_MS: parseInteger(env.LOG_VERY_SLOW_REQUEST_MS, 5000),
    LOG_SKIP_MCP_METHODS: parseCsvSet(
      env.LOG_SKIP_MCP_METHODS,
      "initialize,notifications/initialized,notifications/progress,ping",
    ),

    // --- Request safety & resilience ---
    REQUEST_TIMEOUT_MS: parseInteger(env.REQUEST_TIMEOUT_MS, 120000),
    MAX_BODY_SIZE_BYTES: parseInteger(env.MAX_BODY_SIZE_BYTES, 10485760),

    // --- Upstream retry (transient network / HTTP2 stream resets) ---
    UPSTREAM_RETRY_ENABLED: parseBoolean(env.UPSTREAM_RETRY_ENABLED, "true"),
    UPSTREAM_RETRY_ATTEMPTS: parseInteger(env.UPSTREAM_RETRY_ATTEMPTS, 3),
    UPSTREAM_RETRY_BASE_DELAY_MS: parseInteger(env.UPSTREAM_RETRY_BASE_DELAY_MS, 250),

    // --- Local fallbacks for methods Stitch does not implement ---
    // Stitch resets the HTTP/2 stream for `prompts/list`, which surfaces to clients as
    // "fetch failed" and makes some clients retry discovery in a tight loop.
    LOCAL_FALLBACK_METHODS: parseCsvSet(env.LOCAL_FALLBACK_METHODS, "prompts/list"),

    // --- Rate limiting ---
    // Owner decision 5: enabled by default with a budget that normal use never reaches.
    RATE_LIMIT_ENABLED: parseBoolean(env.RATE_LIMIT_ENABLED, "true"),
    RATE_LIMIT_MAX_RPS: parseInteger(env.RATE_LIMIT_MAX_RPS, 100),
    RATE_LIMIT_BURST: parseInteger(env.RATE_LIMIT_BURST, 200),

    // --- CORS ---
    // Owner decision: LAN computers must work, the public internet must not. The default is
    // therefore "no wildcard, private-network origins only"; CORS_ORIGIN=* opts back in.
    CORS_ORIGIN: env.CORS_ORIGIN || "",

    // --- Metrics ---
    METRICS_ENABLED: parseBoolean(env.METRICS_ENABLED, "true"),

    // --- Graceful shutdown ---
    SHUTDOWN_DRAIN_MS: parseInteger(env.SHUTDOWN_DRAIN_MS, 15000),

    // Log viewer configuration
    LOG_VIEWER_ENABLED: parseBoolean(env.LOG_VIEWER_ENABLED, "true"),
    LOG_VIEWER_MAX_FILE_BYTES: parseInteger(env.LOG_VIEWER_MAX_FILE_BYTES, 10485760),
    LOG_SUMMARY_MAX_LINES: parseInteger(env.LOG_SUMMARY_MAX_LINES, 200),

    // --- Idempotency (ADR 0003) ---
    // How long a detached unsafe request may keep running in the background after the client
    // that started it has gone away.
    UNSAFE_MAX_DURATION_MS: parseInteger(env.UNSAFE_MAX_DURATION_MS, 10 * 60 * 1000),
    // How long a stored result may be replayed to a retry.
    REPLAY_WINDOW_MS: parseInteger(env.REPLAY_WINDOW_MS, 10 * 60 * 1000),
    REPLAY_MAX_ENTRIES: parseInteger(env.REPLAY_MAX_ENTRIES, 200),
    REPLAY_MAX_TOTAL_BYTES: parseInteger(env.REPLAY_MAX_TOTAL_BYTES, 32 * 1024 * 1024),

    // --- Tool annotations ---
    ANNOTATE_TOOLS: parseBoolean(env.ANNOTATE_TOOLS, "true"),
    SAFE_TOOLS_CSV: parseCsvSet(env.SAFE_TOOLS, ""),
    UNSAFE_TOOLS_CSV: parseCsvSet(env.UNSAFE_TOOLS, ""),

    // --- Streaming deadlines (ADR 0004) ---
    // Three separate limits, because a slow-but-alive stream must not be killed by the same
    // rule as a stalled one.
    STREAM_IDLE_TIMEOUT_MS: parseInteger(env.STREAM_IDLE_TIMEOUT_MS, 60000),
    STREAM_MAX_DURATION_MS: parseInteger(env.STREAM_MAX_DURATION_MS, 30 * 60 * 1000),

    // --- Server socket timeouts (★S6) ---
    // Explicit rather than Node's defaults (300000/60000/5000), because a 60 s+ Stitch generation
    // must not be cut by an invisible socket timeout.
    SERVER_HEADERS_TIMEOUT_MS: parseInteger(env.SERVER_HEADERS_TIMEOUT_MS, 60000),
    SERVER_KEEP_ALIVE_TIMEOUT_MS: parseInteger(env.SERVER_KEEP_ALIVE_TIMEOUT_MS, 5000),
    // Cap on concurrently forwarded upstream requests. 0 disables the cap.
    MAX_CONCURRENT_UPSTREAM: parseInteger(env.MAX_CONCURRENT_UPSTREAM, 32),
    // How long a request may wait for an upstream slot before answering 503 + Retry-After.
    CONCURRENCY_QUEUE_WAIT_MS: parseInteger(env.CONCURRENCY_QUEUE_WAIT_MS, 10000),

    // --- Security (ADR 0005). Owner decisions: LAN access stays open, the public internet does
    // not get in, and no proxy auth token is required. ---
    // Extra origins beyond the private-network default; '*' restores the old permissive mode.
    ALLOWED_ORIGINS_CSV: parseCsvSet(env.ALLOWED_ORIGINS, ""),
    ALLOWED_HOSTS_CSV: parseCsvSet(env.ALLOWED_HOSTS, ""),
    // Escape hatch for a reverse proxy that presents a public Host header.
    ALLOW_ALL_HOSTS: String(env.ALLOWED_HOSTS || "").trim() === "*",
    // Only trust X-Forwarded-For from a reverse proxy you control (finding ★N4).
    TRUST_PROXY: parseBoolean(env.TRUST_PROXY, "false"),
  };
}

/**
 * Resolves configuration from `env`, layers `overrides` on top, and installs the result
 * into the module-level bindings. Called once at module load and once per
 * `createProxyServer()`.
 *
 * @param {Record<string, string|undefined>} [env] defaults to `process.env`
 * @param {Record<string, unknown>} [overrides] explicit values (already parsed) for tests
 * @returns {Record<string, any>} the resolved configuration
 */
function applyConfig(env = process.env, overrides = {}) {
  const resolved = resolveConfigFromEnv(env);

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      continue;
    }
    if (!CONFIG_KEYS.includes(key)) {
      throw new Error(
        `Unknown configuration override: ${key}. Known keys: ${CONFIG_KEYS.join(", ")}`,
      );
    }
    resolved[key] = value;
  }

  // Re-resolve derived paths so an override of a relative path still becomes absolute.
  if (overrides.LOG_DIR) {
    resolved.LOG_DIR = path.resolve(process.cwd(), String(overrides.LOG_DIR));
  }

  assignConfig(resolved);
  return resolved;
}

/**
 * Reads the current configuration out of the module-level bindings.
 * Used for startup logging, `/health` and tests.
 *
 * @returns {Record<string, any>}
 */
function getConfig() {
  /** @type {Record<string, any>} */
  const snapshot = { INSTRUCTIONS_PATH };
  for (const key of CONFIG_KEYS) {
    snapshot[key] = configTargets[key].get();
  }
  return snapshot;
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizePathSegment(value) {
  return String(value || "unknown-project").replace(/[^a-zA-Z0-9._-]/g, "_");
}

// --- Log Viewer Helpers ---

/**
 * Safely resolves a log file path relative to LOG_DIR.
 * Returns null if the path attempts to escape the logs directory.
 */
function resolveLogFilePath(projectId, filename) {
  if (!projectId || !filename) {
    return null;
  }

  // Reject obvious path traversal attempts in the raw segments
  if (projectId.includes("..") || filename.includes("..")) {
    return null;
  }

  const resolved = path.resolve(LOG_DIR, projectId, filename);
  if (!resolved.startsWith(LOG_DIR + path.sep)) {
    return null;
  }

  return resolved;
}

/**
 * Scans the LOG_DIR for project subdirectories and their .log files.
 * Returns a structured array sorted by project ID, with files sorted newest-first.
 */
function scanLogDirectory() {
  if (!fs.existsSync(LOG_DIR)) {
    return [];
  }

  try {
    const entries = fs.readdirSync(LOG_DIR, { withFileTypes: true });
    const projects = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const projectPath = path.join(LOG_DIR, entry.name);
      const files = [];

      try {
        const fileEntries = fs.readdirSync(projectPath, { withFileTypes: true });

        for (const fileEntry of fileEntries) {
          if (!fileEntry.isFile() || !fileEntry.name.endsWith(".log")) {
            continue;
          }

          const filePath = path.join(projectPath, fileEntry.name);
          const stat = fs.statSync(filePath);

          files.push({
            name: fileEntry.name,
            size: stat.size,
            modified: stat.mtime.toISOString(),
          });
        }
      } catch {
        // Skip directories that can't be read
        continue;
      }

      // Sort files newest first by name (timestamp-based naming)
      files.sort((a, b) => b.name.localeCompare(a.name));

      if (files.length > 0) {
        projects.push({
          projectId: entry.name,
          fileCount: files.length,
          files,
        });
      }
    }

    // Sort projects alphabetically
    projects.sort((a, b) => a.projectId.localeCompare(b.projectId));
    return projects;
  } catch {
    return [];
  }
}

/**
 * Reads the summary log file and returns paginated lines.
 */
function readSummaryLogLines(limit, offset) {
  const safeLimit = isPositiveInteger(limit, LOG_SUMMARY_MAX_LINES);
  const safeOffset = Math.max(0, Number.isInteger(offset) ? offset : 0);

  const logFilePath = path.join(LOG_DIR, LOG_FILE_NAME);
  if (!fs.existsSync(logFilePath)) {
    return { lines: [], total: 0, offset: safeOffset };
  }

  try {
    const content = fs.readFileSync(logFilePath, "utf8");
    const allLines = content.split("\n");
    // Remove trailing empty line from split if file ends with newline
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
      allLines.pop();
    }

    const total = allLines.length;
    const slice = allLines.slice(safeOffset, safeOffset + safeLimit);

    return {
      lines: slice.map((text, index) => ({
        number: safeOffset + index + 1,
        text,
      })),
      total,
      offset: safeOffset,
    };
  } catch {
    return { lines: [], total: 0, offset: safeOffset };
  }
}

/**
 * Reads a single log file by project ID and filename.
 * Returns null if the file doesn't exist or exceeds size limits.
 */
function readLogFile(projectId, filename) {
  const filePath = resolveLogFilePath(projectId, filename);
  if (!filePath) {
    return { error: "Invalid path", status: 403 };
  }

  if (!fs.existsSync(filePath)) {
    return { error: "File not found", status: 404 };
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.size > LOG_VIEWER_MAX_FILE_BYTES) {
      return {
        error: `File too large (${stat.size} bytes, max ${LOG_VIEWER_MAX_FILE_BYTES})`,
        status: 413,
      };
    }

    return { content: fs.readFileSync(filePath, "utf8"), size: stat.size };
  } catch (error) {
    return { error: error.message || "Failed to read file", status: 500 };
  }
}

function isPositiveInteger(value, fallbackValue) {
  return Number.isInteger(value) && value > 0 ? value : fallbackValue;
}

function rotateLogFileIfNeeded(filePath) {
  const maxFileSizeBytes = isPositiveInteger(LOG_MAX_FILE_SIZE_BYTES, 5242880);
  const maxRotatedFiles = isPositiveInteger(LOG_MAX_ROTATED_FILES, 5);

  if (!fs.existsSync(filePath)) {
    return;
  }

  const { size } = fs.statSync(filePath);
  if (size < maxFileSizeBytes) {
    return;
  }

  for (let index = maxRotatedFiles; index >= 1; index -= 1) {
    const sourcePath = `${filePath}.${index}`;
    const targetPath = `${filePath}.${index + 1}`;

    if (!fs.existsSync(sourcePath)) {
      continue;
    }

    if (index === maxRotatedFiles) {
      fs.unlinkSync(sourcePath);
      continue;
    }

    fs.renameSync(sourcePath, targetPath);
  }

  fs.renameSync(filePath, `${filePath}.1`);
}

function stripAnsiSequences(value) {
  // eslint-disable-next-line no-control-regex -- ANSI escape sequences are the point.
  return String(value).replace(/\u001b\[[0-9;]*m/g, "");
}

function truncateText(value, maxChars) {
  const safeMaxChars = isPositiveInteger(maxChars, 20000);
  if (value.length <= safeMaxChars) {
    return value;
  }

  return `${value.slice(0, safeMaxChars)}\n\n[truncated ${value.length - safeMaxChars} chars]`;
}

function printableRatio(value) {
  if (!value) {
    return 1;
  }

  let printableCount = 0;
  for (const char of value) {
    const code = char.charCodeAt(0);
    const isPrintable = code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126);
    if (isPrintable) {
      printableCount += 1;
    }
  }

  return printableCount / value.length;
}

function looksLikeOpaqueBlob(value) {
  const compact = value.replace(/\s+/g, "");
  return compact.length > 256 && /^[A-Za-z0-9+/=_-]+$/.test(compact);
}

function normalizeBodyForLogging(value, contentType) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  const rawValue = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const sanitizedValue = stripAnsiSequences(rawValue)
    .replace(/\r\n/g, "\n")
    // eslint-disable-next-line no-control-regex -- strip NUL bytes from binary payloads.
    .replace(/\u0000/g, "")
    .trim();

  if (!sanitizedValue) {
    return "";
  }

  const normalizedContentType = String(contentType || "").toLowerCase();
  const isStructuredText =
    normalizedContentType.includes("json") ||
    normalizedContentType.includes("text/") ||
    normalizedContentType.includes("xml") ||
    normalizedContentType.includes("javascript") ||
    normalizedContentType.includes("graphql") ||
    normalizedContentType.includes("event-stream") ||
    normalizedContentType.includes("x-www-form-urlencoded");

  if (normalizedContentType && !isStructuredText && printableRatio(sanitizedValue) < 0.9) {
    return `[omitted non-text body: ${normalizedContentType}]`;
  }

  if (printableRatio(sanitizedValue) < 0.85) {
    return "[omitted unreadable body]";
  }

  if (looksLikeOpaqueBlob(sanitizedValue)) {
    return "[omitted opaque token/blob body]";
  }

  if (
    normalizedContentType.includes("json") ||
    sanitizedValue.startsWith("{") ||
    sanitizedValue.startsWith("[")
  ) {
    try {
      return truncateText(JSON.stringify(JSON.parse(sanitizedValue), null, 2), LOG_MAX_BODY_CHARS);
    } catch {
      return truncateText(sanitizedValue, LOG_MAX_BODY_CHARS);
    }
  }

  return truncateText(sanitizedValue, LOG_MAX_BODY_CHARS);
}

function shouldSkipDetailedLog({ req, url, requestBody, responseStatus }) {
  if (responseStatus >= 400) {
    return false;
  }

  if (url.pathname === "/mcp" && req.method === "GET" && LOG_SKIP_MCP_GET) {
    return true;
  }

  const { methods } = parseJsonRpcMetadata(requestBody);
  if (!methods.length) {
    return false;
  }

  return methods.every((method) => LOG_SKIP_MCP_METHODS.has(method));
}

function formatMethodsForSummary(requestBody) {
  const { methods } = parseJsonRpcMetadata(requestBody);
  return methods.length ? methods.join(",") : "unknown";
}

function classifyDuration(durationMs) {
  const slowThreshold = isPositiveInteger(LOG_SLOW_REQUEST_MS, 2000);
  const verySlowThreshold = isPositiveInteger(LOG_VERY_SLOW_REQUEST_MS, 5000);

  if (durationMs >= verySlowThreshold) {
    return "VERY_SLOW";
  }

  if (durationMs >= slowThreshold) {
    return "SLOW";
  }

  return "NORMAL";
}

function generateRequestLogId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Upstream error classification & retry helpers ---

// --- Local fallbacks for methods Stitch does not implement ---

// --- Rate Limiter (Token Bucket) ---

/**
 * Creates the mutable per-proxy-instance state.
 *
 * Phase 0 seam: everything that used to be a module-level singleton lives here so that a
 * test can start a proxy on an ephemeral port without touching another instance's state.
 * Phase 2 spreads these over purpose-built modules.
 *
 * @param {Record<string, any>} [config] resolved configuration for this instance
 */
function createState(config) {
  const cfg = config || getConfig();
  return {
    config: cfg,
    rateLimitBuckets: new Map(),
    metrics: createMetrics(),
    activeConnections: new Set(),
    tokenCache: { value: null, fetchedAt: 0 },
    // In-flight coalescing and orphaned-result replay (ADR 0003).
    // Bounds concurrent upstream requests (finding ★S6). The queue has a maximum wait, so a
    // saturated proxy answers 503 + Retry-After instead of hanging.
    upstreamLimiter: createSemaphore(cfg.MAX_CONCURRENT_UPSTREAM),
    idempotency: createIdempotencyStore({
      replayWindowMs: cfg.REPLAY_WINDOW_MS,
      maxEntries: cfg.REPLAY_MAX_ENTRIES,
      maxTotalBytes: cfg.REPLAY_MAX_TOTAL_BYTES,
    }),
    isShuttingDown: false,
    /** One-shot guards so startup/first-use warnings are not repeated per request. */
    warnings: { noProjectId: false },
  };
}

/**
 * Mutable state of the proxy instance that is currently handling requests.
 *
 * The pre-seam code used module-level singletons; the seam keeps that shape via a single
 * pointer rather than rewiring every call site. It is swapped by `createProxyServer()`.
 * Phase 2 replaces this with explicit dependency injection.
 */
let state = createState();

function getState() {
  return state;
}

// Clean up stale rate limit entries every 5 minutes.
// NOTE: this interval closes over the *current* `state`, which is the state of the most
// recently created proxy instance. Phase 2 moves the sweep onto the instance so that two
// proxies in one process each sweep their own buckets.
setInterval(() => {
  sweepRateLimitBuckets(state.rateLimitBuckets);
}, 300000).unref();

// --- Connection Tracker (for graceful shutdown) ---

function trackConnection(socket) {
  const activeConnections = state.activeConnections;
  const metrics = state.metrics;

  activeConnections.add(socket);
  metrics.activeConnections = activeConnections.size;
  socket.on("close", () => {
    activeConnections.delete(socket);
    metrics.activeConnections = activeConnections.size;
  });
}

function appendSummaryLog(line) {
  if (!LOG_ENABLED || (LOG_LEVEL !== "info" && LOG_LEVEL !== "debug")) {
    return;
  }

  try {
    ensureDirectory(LOG_DIR);
    const logFilePath = path.join(LOG_DIR, LOG_FILE_NAME);
    rotateLogFileIfNeeded(logFilePath);
    fs.appendFileSync(logFilePath, line);
  } catch (error) {
    console.error("❌ Failed to write summary log:", error);
  }
}

/**
 * Writes one per-request detail file when debug logging is on.
 *
 * @param {{
 *   requestLogId: string,
 *   timestamp: string,
 *   req: import("http").IncomingMessage,
 *   url: URL,
 *   projectId?: string|null,
 *   requestBody?: any,
 *   requestContentType?: string,
 *   durationMs?: number,
 *   durationClass?: string,
 *   responseStatus?: number,
 *   responseHeaders?: Record<string, any>,
 *   responseBody?: any,
 *   error?: any,
 * }} entry
 */
function writeDetailedDebugLog({
  requestLogId,
  timestamp,
  req,
  url,
  projectId,
  requestBody,
  requestContentType,
  durationMs,
  durationClass,
  responseStatus,
  responseHeaders,
  responseBody,
  error,
}) {
  if (!LOG_ENABLED || LOG_LEVEL !== "debug") {
    return;
  }

  if (shouldSkipDetailedLog({ req, url, requestBody, responseStatus })) {
    return;
  }

  try {
    const projectLogDir = path.join(LOG_DIR, sanitizePathSegment(projectId));
    ensureDirectory(projectLogDir);

    const fileTimestamp = timestamp.replace(/[:.]/g, "-");
    const filePath = path.join(projectLogDir, `${fileTimestamp}-${requestLogId}.log`);
    const content = [
      `requestLogId: ${requestLogId}`,
      `timestamp: ${timestamp}`,
      `durationMs: ${durationMs ?? ""}`,
      `durationClass: ${durationClass ?? ""}`,
      `method: ${req.method}`,
      `path: ${url.pathname}`,
      // Credentials can arrive as query parameters on a misconfigured client (★P1/redaction).
      `query: ${redactUrl(url.search || "")}`,
      `projectId: ${projectId || "unknown"}`,
      "",
      "requestHeaders:",
      JSON.stringify(redactHeaders(req.headers), null, 2),
      "",
      "requestBody:",
      normalizeBodyForLogging(requestBody, requestContentType),
      "",
      `responseStatus: ${responseStatus || ""}`,
      "responseHeaders:",
      JSON.stringify(redactHeaders(responseHeaders), null, 2),
      "",
      "responseBody:",
      normalizeBodyForLogging(responseBody, responseHeaders?.["content-type"]),
      ...(error ? ["", "error:", error.stack || error.message || String(error)] : []),
      "",
    ].join("\n");

    fs.writeFileSync(filePath, content, "utf8");
  } catch (writeError) {
    console.error("❌ Failed to write debug log:", writeError);
  }
}

function readInstructionsMarkdown() {
  return fs.readFileSync(INSTRUCTIONS_PATH, "utf8");
}

function parseInstructionsMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "Google Stitch MCP Tools";
  const sections = [];
  let currentSection = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith("### ")) {
      currentSection = {
        title: trimmed.slice(4).trim(),
        items: [],
      };
      sections.push(currentSection);
      continue;
    }

    if (trimmed.startsWith("* **") && currentSection) {
      const nameMatch = trimmed.match(/^\*\s+\*\*(.+?)\*\*/);
      const descriptionLines = [];
      let pointer = index + 1;

      while (pointer < lines.length) {
        const nextLine = lines[pointer];
        const nextTrimmed = nextLine.trim();
        if (!nextTrimmed) {
          pointer += 1;
          continue;
        }
        if (
          nextTrimmed.startsWith("*") ||
          nextTrimmed.startsWith("### ") ||
          nextTrimmed.startsWith("# ") ||
          nextTrimmed === "---"
        ) {
          break;
        }
        descriptionLines.push(nextTrimmed);
        pointer += 1;
      }

      currentSection.items.push({
        name: nameMatch ? nameMatch[1].trim() : trimmed,
        description: descriptionLines.join(" "),
      });
      index = pointer - 1;
    }
  }

  const mentalModelMatch = markdown.match(/```([\s\S]*?)```/m);
  const mentalModel = mentalModelMatch ? mentalModelMatch[1].trim() : "";

  const usageMapping = Array.from(markdown.matchAll(/^\|\s*(.*?)\s*\|\s*(.*?)\s*\|$/gm))
    .slice(2)
    .map(([, goal, tool]) => ({
      goal: goal.trim(),
      tool: tool.trim(),
    }));

  const observations = [];
  const observationsMatch = markdown.match(/#\s+⚠️ Important Observations([\s\S]*?)$/m);
  if (observationsMatch) {
    for (const line of observationsMatch[1].split(/\r?\n/)) {
      const itemMatch = line.trim().match(/^\*\s+(.*)$/);
      if (itemMatch) {
        observations.push(itemMatch[1].trim());
      }
    }
  }

  return {
    title,
    sections,
    mentalModel,
    usageMapping,
    observations,
    rawMarkdown: markdown,
  };
}

function renderInstructionsHtml(data) {
  const sectionCards = data.sections
    .map(
      (section) => `
    <section class="card">
      <h2>${escapeHtml(section.title)}</h2>
      <div class="tool-grid">
        ${section.items
          .map(
            (item) => `
          <article class="tool-item">
            <h3>${escapeHtml(item.name)}</h3>
            <p>${formatInlineMarkdown(item.description)}</p>
          </article>
        `,
          )
          .join("")}
      </div>
    </section>
  `,
    )
    .join("");

  const mappingRows = data.usageMapping
    .map(
      (row) => `
    <tr>
      <td>${escapeHtml(row.goal)}</td>
      <td><code>${escapeHtml(row.tool)}</code></td>
    </tr>
  `,
    )
    .join("");

  const observationItems = data.observations
    .map(
      (item) => `
    <li>${formatInlineMarkdown(item)}</li>
  `,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(data.title)}</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #0b1020;
        --panel: rgba(13, 19, 38, 0.82);
        --panel-strong: rgba(19, 28, 55, 0.96);
        --text: #e8eefc;
        --muted: #a7b4d6;
        --accent: #6ee7ff;
        --accent-2: #8bffb0;
        --border: rgba(148, 163, 184, 0.22);
        --shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Inter, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(110, 231, 255, 0.18), transparent 30%),
          radial-gradient(circle at top right, rgba(139, 255, 176, 0.16), transparent 28%),
          linear-gradient(180deg, #08111f 0%, #09111b 55%, #050913 100%);
        color: var(--text);
      }

      main {
        width: min(1120px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 40px 0 64px;
      }

      .hero, .card {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 24px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }

      .hero {
        padding: 32px;
        margin-bottom: 24px;
      }

      .eyebrow {
        display: inline-block;
        padding: 6px 12px;
        border-radius: 999px;
        background: rgba(110, 231, 255, 0.12);
        color: var(--accent);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      h1, h2, h3 { margin: 0; }
      h1 { font-size: clamp(32px, 5vw, 52px); margin-top: 14px; }
      h2 { font-size: 24px; margin-bottom: 18px; }
      h3 { font-size: 17px; margin-bottom: 8px; }
      p { margin: 0; color: var(--muted); line-height: 1.65; }
      code, pre {
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      }
      code {
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.08);
        color: var(--accent);
      }
      pre {
        margin: 0;
        padding: 20px;
        overflow: auto;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: rgba(6, 10, 20, 0.86);
        color: #dfe7fb;
      }

      .card {
        padding: 28px;
        margin-bottom: 20px;
      }

      .tool-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 16px;
      }

      .tool-item {
        padding: 18px;
        border-radius: 18px;
        background: var(--panel-strong);
        border: 1px solid rgba(148, 163, 184, 0.14);
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th, td {
        text-align: left;
        padding: 14px 12px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.14);
      }

      th { color: var(--accent-2); font-weight: 700; }

      ul {
        margin: 0;
        padding-left: 20px;
      }

      li {
        margin: 10px 0;
        color: var(--muted);
        line-height: 1.6;
      }

      .footer-note {
        margin-top: 16px;
        font-size: 14px;
        color: var(--muted);
      }

      @media (max-width: 720px) {
        main { width: min(100vw - 20px, 1120px); padding-top: 20px; }
        .hero, .card { border-radius: 20px; }
        .hero, .card { padding: 22px; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <span class="eyebrow">Proxy Instructions</span>
        <h1>${escapeHtml(data.title)}</h1>
        <p>Human-friendly in HTML, AI-friendly through the same endpoint via <code>Accept: application/json</code> or <code>Accept: text/markdown</code>.</p>
      </section>

      ${sectionCards}

      <section class="card">
        <h2>Mental Model</h2>
        <pre>${escapeHtml(data.mentalModel)}</pre>
      </section>

      <section class="card">
        <h2>Practical Usage Mapping</h2>
        <table>
          <thead>
            <tr>
              <th>Goal</th>
              <th>Tool</th>
            </tr>
          </thead>
          <tbody>
            ${mappingRows}
          </tbody>
        </table>
      </section>

      <section class="card">
        <h2>Important Observations</h2>
        <ul>${observationItems}</ul>
        <p class="footer-note">For raw source, request this endpoint with <code>Accept: text/markdown</code>.</p>
      </section>
    </main>
  </body>
</html>`;
}

function renderLogsHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Log Viewer — gstitch-mcproxy</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b1020;
        --panel: rgba(13, 19, 38, 0.88);
        --panel-strong: rgba(19, 28, 55, 0.96);
        --text: #e8eefc;
        --muted: #a7b4d6;
        --accent: #6ee7ff;
        --accent-2: #8bffb0;
        --border: rgba(148, 163, 184, 0.22);
        --shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
        --highlight-bg: rgba(254, 230, 136, 0.18);
        --highlight-text: #fde68a;
        --error-color: #fca5a5;
        --success-color: #8bffb0;
      }

      * { box-sizing: border-box; margin: 0; padding: 0; }

      body {
        font-family: Inter, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(110, 231, 255, 0.12), transparent 30%),
          linear-gradient(180deg, #08111f 0%, #050913 100%);
        color: var(--text);
        height: 100vh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      /* Header */
      .header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 20px;
        background: var(--panel-strong);
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
      }

      .header h1 {
        font-size: 16px;
        font-weight: 600;
        letter-spacing: 0.02em;
      }

      .header .badge {
        font-size: 11px;
        padding: 3px 8px;
        border-radius: 999px;
        background: rgba(110, 231, 255, 0.12);
        color: var(--accent);
      }

      .header .spacer { flex: 1; }

      .header input[type="text"] {
        width: 280px;
        padding: 7px 12px;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: rgba(6, 10, 20, 0.6);
        color: var(--text);
        font-size: 13px;
        outline: none;
        transition: border-color 0.15s;
      }

      .header input[type="text"]:focus {
        border-color: var(--accent);
      }

      .header button {
        padding: 6px 14px;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: rgba(110, 231, 255, 0.08);
        color: var(--accent);
        font-size: 13px;
        cursor: pointer;
        transition: background 0.15s;
      }

      .header button:hover {
        background: rgba(110, 231, 255, 0.16);
      }

      /* Layout */
      .layout {
        display: flex;
        flex: 1;
        overflow: hidden;
      }

      /* Sidebar */
      .sidebar {
        width: 300px;
        min-width: 240px;
        background: var(--panel);
        border-right: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .sidebar-tabs {
        display: flex;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
      }

      .sidebar-tab {
        flex: 1;
        padding: 10px;
        text-align: center;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted);
        cursor: pointer;
        border-bottom: 2px solid transparent;
        transition: color 0.15s, border-color 0.15s;
      }

      .sidebar-tab.active {
        color: var(--accent);
        border-bottom-color: var(--accent);
      }

      .sidebar-content {
        flex: 1;
        overflow-y: auto;
        padding: 8px 0;
      }

      .sidebar-content::-webkit-scrollbar { width: 6px; }
      .sidebar-content::-webkit-scrollbar-track { background: transparent; }
      .sidebar-content::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

      /* Project tree */
      .project-item { user-select: none; }

      .project-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 14px;
        cursor: pointer;
        font-size: 13px;
        color: var(--muted);
        transition: background 0.1s, color 0.1s;
      }

      .project-header:hover {
        background: rgba(110, 231, 255, 0.06);
        color: var(--text);
      }

      .project-header .chevron {
        font-size: 10px;
        transition: transform 0.15s;
        width: 14px;
        text-align: center;
      }

      .project-header.expanded .chevron {
        transform: rotate(90deg);
      }

      .project-header .count {
        margin-left: auto;
        font-size: 11px;
        opacity: 0.5;
      }

      .project-files {
        display: none;
        padding-left: 10px;
      }

      .project-files.open { display: block; }

      .file-item {
        padding: 6px 14px 6px 30px;
        font-size: 12px;
        color: var(--muted);
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        transition: background 0.1s, color 0.1s;
      }

      .file-item:hover {
        background: rgba(110, 231, 255, 0.06);
        color: var(--text);
      }

      .file-item.active {
        color: var(--accent);
        background: rgba(110, 231, 255, 0.08);
      }

      .file-item .meta {
        float: right;
        font-size: 10px;
        opacity: 0.45;
      }

      /* Summary log entry */
      .summary-entry {
        padding: 10px 14px;
        font-size: 13px;
        color: var(--muted);
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        transition: background 0.1s, color 0.1s;
      }

      .summary-entry:hover {
        background: rgba(110, 231, 255, 0.06);
        color: var(--text);
      }

      .summary-entry.active {
        color: var(--accent);
        background: rgba(110, 231, 255, 0.08);
      }

      .summary-entry .icon { font-size: 15px; }

      /* Main content */
      .main {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .main-toolbar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 16px;
        border-bottom: 1px solid var(--border);
        background: rgba(13, 19, 38, 0.5);
        flex-shrink: 0;
      }

      .main-toolbar .file-name {
        font-size: 12px;
        color: var(--muted);
        font-family: "SFMono-Regular", Consolas, monospace;
      }

      .main-toolbar .file-size {
        font-size: 11px;
        color: var(--muted);
        opacity: 0.5;
      }

      .main-toolbar .spacer { flex: 1; }

      .main-toolbar .status-dot {
        width: 8px; height: 8px;
        border-radius: 50%;
        display: inline-block;
      }

      .main-toolbar .status-dot.loading { background: var(--accent); animation: pulse 1s infinite; }
      .main-toolbar .status-dot.ready { background: var(--success-color); }
      .main-toolbar .status-dot.error { background: var(--error-color); }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }

      /* Terminal view */
      .terminal {
        flex: 1;
        overflow-y: auto;
        padding: 12px 0;
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        font-size: 12.5px;
        line-height: 1.65;
        background: rgba(4, 7, 14, 0.5);
      }

      .terminal::-webkit-scrollbar { width: 8px; }
      .terminal::-webkit-scrollbar-track { background: transparent; }
      .terminal::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

      .log-line {
        display: flex;
        padding: 0 16px;
        min-height: 21px;
      }

      .log-line:hover { background: rgba(110, 231, 255, 0.04); }

      .log-line.highlight {
        background: var(--highlight-bg);
      }

      .log-line.hidden { display: none; }

      .line-number {
        color: var(--muted);
        opacity: 0.3;
        user-select: none;
        min-width: 48px;
        text-align: right;
        padding-right: 16px;
        flex-shrink: 0;
      }

      .line-text { white-space: pre-wrap; word-break: break-all; }

      /* Empty state */
      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--muted);
        gap: 8px;
      }

      .empty-state .icon { font-size: 40px; opacity: 0.3; }
      .empty-state p { font-size: 14px; }

      /* Loading spinner */
      .spinner {
        display: inline-block;
        width: 16px; height: 16px;
        border: 2px solid var(--border);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }

      @keyframes spin { to { transform: rotate(360deg); } }

      /* Responsive */
      @media (max-width: 720px) {
        .sidebar { width: 220px; min-width: 180px; }
        .header input[type="text"] { width: 160px; }
      }

      @media (max-width: 540px) {
        .layout { flex-direction: column; }
        .sidebar { width: 100%; height: 200px; min-width: unset; border-right: none; border-bottom: 1px solid var(--border); }
      }
    </style>
  </head>
  <body>
    <div class="header">
      <h1>📋 Log Viewer</h1>
      <span class="badge">gstitch-mcproxy</span>
      <span class="spacer"></span>
      <input type="text" id="searchBox" placeholder="Filter lines…" autocomplete="off" spellcheck="false">
      <button id="refreshBtn" title="Refresh log list">↻ Refresh</button>
    </div>

    <div class="layout">
      <div class="sidebar">
        <div class="sidebar-tabs">
          <div class="sidebar-tab active" data-tab="summary">Summary</div>
          <div class="sidebar-tab" data-tab="projects">Projects</div>
        </div>
        <div class="sidebar-content" id="sidebarContent">
          <div class="empty-state"><span class="spinner"></span><p>Loading…</p></div>
        </div>
      </div>

      <div class="main">
        <div class="main-toolbar">
          <span class="status-dot" id="statusDot"></span>
          <span class="file-name" id="fileName">No file selected</span>
          <span class="file-size" id="fileSize"></span>
          <span class="spacer"></span>
          <span id="lineCount" style="font-size:11px;color:var(--muted);opacity:0.5;"></span>
        </div>
        <div class="terminal" id="terminal">
          <div class="empty-state">
            <span class="icon">📂</span>
            <p>Select a log file from the sidebar</p>
          </div>
        </div>
      </div>
    </div>

    <script>
      // State
      let logData = null;
      let currentContent = [];
      let currentFilter = "";

      // DOM refs
      const searchBox = document.getElementById("searchBox");
      const refreshBtn = document.getElementById("refreshBtn");
      const sidebarContent = document.getElementById("sidebarContent");
      const terminal = document.getElementById("terminal");
      const fileNameEl = document.getElementById("fileName");
      const fileSizeEl = document.getElementById("fileSize");
      const lineCountEl = document.getElementById("lineCount");
      const statusDot = document.getElementById("statusDot");

      // Tabs
      document.querySelectorAll(".sidebar-tab").forEach((tab) => {
        tab.addEventListener("click", () => {
          document.querySelectorAll(".sidebar-tab").forEach((t) => t.classList.remove("active"));
          tab.classList.add("active");
          if (tab.dataset.tab === "summary") renderSummaryTab();
          else renderProjectsTab();
        });
      });

      // Search
      searchBox.addEventListener("input", () => {
        currentFilter = searchBox.value.trim().toLowerCase();
        applyFilter();
      });

      // Refresh
      refreshBtn.addEventListener("click", loadLogData);

      function setStatus(state) {
        statusDot.className = "status-dot " + state;
      }

      function formatBytes(bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / 1048576).toFixed(1) + " MB";
      }

      function escapeHtml(text) {
        return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      }

      async function loadLogData() {
        setStatus("loading");
        try {
          const resp = await fetch("/api/logs");
          logData = await resp.json();
          const activeTab = document.querySelector(".sidebar-tab.active").dataset.tab;
          if (activeTab === "summary") renderSummaryTab();
          else renderProjectsTab();
          setStatus("ready");
        } catch (err) {
          sidebarContent.innerHTML = '<div class="empty-state"><p style="color:var(--error-color)">Failed to load logs</p></div>';
          setStatus("error");
        }
      }

      function renderSummaryTab() {
        if (!logData) return;
        const summary = logData.summaryLog;
        sidebarContent.innerHTML = "";

        const entry = document.createElement("div");
        entry.className = "summary-entry";
        entry.innerHTML = '<span class="icon">📄</span> <span>' + escapeHtml(summary.name) + '</span>';
        if (summary.exists) {
          entry.innerHTML += '<span style="margin-left:auto;font-size:11px;opacity:0.45">' + formatBytes(summary.size) + '</span>';
          entry.addEventListener("click", () => loadSummaryLog(entry));
        } else {
          entry.style.opacity = "0.3";
          entry.style.cursor = "default";
        }
        sidebarContent.appendChild(entry);
      }

      function renderProjectsTab() {
        if (!logData) return;
        sidebarContent.innerHTML = "";

        if (!logData.projects || logData.projects.length === 0) {
          sidebarContent.innerHTML = '<div class="empty-state"><span class="icon">📁</span><p>No project logs found</p></div>';
          return;
        }

        logData.projects.forEach((project) => {
          const item = document.createElement("div");
          item.className = "project-item";

          const header = document.createElement("div");
          header.className = "project-header";
          header.innerHTML = '<span class="chevron">▶</span> <span>' + escapeHtml(project.projectId) + '</span> <span class="count">' + project.fileCount + '</span>';

          const filesDiv = document.createElement("div");
          filesDiv.className = "project-files";

          header.addEventListener("click", () => {
            header.classList.toggle("expanded");
            filesDiv.classList.toggle("open");
          });

          project.files.forEach((file) => {
            const fileEl = document.createElement("div");
            fileEl.className = "file-item";
            fileEl.innerHTML = escapeHtml(file.name) + '<span class="meta">' + formatBytes(file.size) + '</span>';
            fileEl.addEventListener("click", () => loadLogFile(project.projectId, file.name, file.size, fileEl));
            filesDiv.appendChild(fileEl);
          });

          item.appendChild(header);
          item.appendChild(filesDiv);
          sidebarContent.appendChild(item);
        });
      }

      async function loadSummaryLog(entryEl) {
        document.querySelectorAll(".summary-entry, .file-item").forEach((e) => e.classList.remove("active"));
        if (entryEl) entryEl.classList.add("active");

        fileNameEl.textContent = logData.summaryLog.name;
        fileSizeEl.textContent = "";
        setStatus("loading");

        try {
          const resp = await fetch("/api/logs/summary?limit=5000");
          const data = await resp.json();
          currentContent = data.lines;
          renderTerminal(data.lines, logData.summaryLog.name);
          setStatus("ready");
        } catch (err) {
          terminal.innerHTML = '<div class="empty-state"><p style="color:var(--error-color)">Failed to load summary log</p></div>';
          setStatus("error");
        }
      }

      async function loadLogFile(projectId, filename, fileSize, fileEl) {
        document.querySelectorAll(".summary-entry, .file-item").forEach((e) => e.classList.remove("active"));
        if (fileEl) fileEl.classList.add("active");

        fileNameEl.textContent = projectId + "/" + filename;
        fileSizeEl.textContent = formatBytes(fileSize);
        setStatus("loading");

        try {
          const resp = await fetch("/api/logs/" + encodeURIComponent(projectId) + "/" + encodeURIComponent(filename));
          if (!resp.ok) throw new Error(resp.status + " " + resp.statusText);
          const text = await resp.text();
          const lines = text.split("\\n");
          currentContent = lines.map((text, i) => ({ number: i + 1, text }));
          renderTerminal(currentContent, filename);
          setStatus("ready");
        } catch (err) {
          terminal.innerHTML = '<div class="empty-state"><p style="color:var(--error-color)">Failed to load file: ' + escapeHtml(err.message) + '</p></div>';
          setStatus("error");
        }
      }

      function renderTerminal(lines, title) {
        if (!lines || lines.length === 0) {
          terminal.innerHTML = '<div class="empty-state"><span class="icon">📄</span><p>Empty log file</p></div>';
          lineCountEl.textContent = "";
          return;
        }

        const fragment = document.createDocumentFragment();
        lines.forEach((line) => {
          const div = document.createElement("div");
          div.className = "log-line";
          div.dataset.text = (line.text || "").toLowerCase();

          const numSpan = document.createElement("span");
          numSpan.className = "line-number";
          numSpan.textContent = line.number;

          const textSpan = document.createElement("span");
          textSpan.className = "line-text";
          textSpan.textContent = line.text || "";

          div.appendChild(numSpan);
          div.appendChild(textSpan);
          fragment.appendChild(div);
        });

        terminal.innerHTML = "";
        terminal.appendChild(fragment);
        lineCountEl.textContent = lines.length + " lines";
        applyFilter();
      }

      function applyFilter() {
        const lines = terminal.querySelectorAll(".log-line");
        if (!currentFilter) {
          lines.forEach((line) => {
            line.classList.remove("hidden", "highlight");
          });
          return;
        }

        lines.forEach((line) => {
          const text = line.dataset.text || "";
          if (text.includes(currentFilter)) {
            line.classList.remove("hidden");
            line.classList.add("highlight");
          } else {
            line.classList.add("hidden");
            line.classList.remove("highlight");
          }
        });
      }

      // Init
      loadLogData();
    </script>
  </body>
</html>`;
}

function parseAuthHeader(authHeader) {
  if (!authHeader || typeof authHeader !== "string") {
    return { apiKey: null };
  }

  const match = authHeader.match(/^\s*basic\s+(.+)\s*$/i);
  if (!match) {
    return { apiKey: null };
  }

  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    // Accept formats: "apiKey" or "projectId:apiKey" (backward compat - projectId silently ignored)
    const separatorIndex = decoded.lastIndexOf(":");
    if (separatorIndex === -1) {
      // No colon - treat entire string as apiKey
      return { apiKey: decoded || null };
    }

    const apiKey = decoded.slice(separatorIndex + 1);

    return {
      apiKey: apiKey || null,
    };
  } catch {
    return { apiKey: null };
  }
}

/**
 * Prints the credential guidance exactly once per process, and only when the process
 * actually starts listening (see the entry point at the bottom of this file). Before the
 * Phase 0 seam these messages were emitted at module load, which made them fire before the
 * configuration was known.
 */
function logCredentialGuidance() {
  if (!STITCH_API_KEY) {
    console.log("ℹ️ No STITCH_API_KEY in .env. Will accept it from request headers:");
    console.log("   - Set STITCH_API_KEY in mcp.json headers or .env");
    console.log("   - gcloud fallback is OFF by default (set ENABLE_GCLOUD_FALLBACK=1)");
  }

  if (!DEFAULT_STITCH_PROJECT_ID) {
    console.log(
      "ℹ️ No STITCH_PROJECT_ID in .env (optional — agents can provide project ID via chat)",
    );
  }
}

function getAccessToken() {
  try {
    return execSync("gcloud auth print-access-token").toString().trim();
  } catch (error) {
    const details = error?.stderr?.toString?.().trim() || error.message;
    throw new Error(`gcloud auth failed. ${details}`);
  }
}

function getCachedToken() {
  const now = Date.now();
  const cache = state.tokenCache;

  if (!cache.value || now - cache.fetchedAt > 5 * 60 * 1000) {
    cache.value = getAccessToken();
    cache.fetchedAt = now;
    console.log("🔄 Refreshed OAuth token");
  }

  return cache.value;
}

/**
 * Sends a JSON response.
 *
 * @param {import("http").ServerResponse} res
 * @param {number} statusCode
 * @param {any} payload
 * @param {{ headers?: Record<string, string>, head?: boolean }} [options] `head` suppresses
 *   the body while keeping `Content-Length`, as HTTP requires for a `HEAD` response.
 */
// --- Upstream header allow-lists (MCP Streamable HTTP) -----------------------

/**
 * Request headers the proxy forwards to Stitch.
 *
 * Verified against the MCP specification (`2025-03-26` ... `2026-07-28` revisions of
 * Streamable HTTP). The baseline rebuilt the header set from scratch, which silently
 * dropped every protocol header (finding P1): `MCP-Protocol-Version` never reached the
 * server at all, and a stateful upstream would have broken.
 *
 * `Mcp-Method`, `Mcp-Name` and `Mcp-Param-*` are the request-metadata headers introduced in
 * `2026-07-28`; forwarding them keeps header/body consistency for a strict upstream.
 *
 * `Mcp-Session-Id` and `Last-Event-ID` belong to the `2025-03-26` ... `2025-11-25` revisions.
 * A server supporting only `2026-07-28` is required to *ignore* them rather than reject
 * them, so forwarding them is safe against both.
 *
 * Everything else -- cookies, unrelated custom headers, hop-by-hop headers -- stays local.
 */
const FORWARDED_REQUEST_HEADERS = [
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
  "mcp-method",
  "mcp-name",
];

/** Prefixes of forwarded request headers (the `Mcp-Param-{Name}` family). */
const FORWARDED_REQUEST_HEADER_PREFIXES = ["mcp-param-"];

/**
 * Response headers the proxy forwards back to the client.
 *
 * All of these except `Content-Type` were dropped at baseline (finding P1): `Mcp-Session-Id`
 * breaks a stateful session, `Retry-After` breaks back-off, and `WWW-Authenticate` breaks
 * the OAuth flow. `X-Accel-Buffering` is added by the proxy itself for SSE responses, as
 * the spec recommends.
 */
const FORWARDED_RESPONSE_HEADERS = [
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
  "retry-after",
  "www-authenticate",
  "x-accel-buffering",
  "cache-control",
  "content-type",
  "content-length",
];

/**
 * Builds the upstream request headers: the allow-listed client headers plus the resolved
 * credentials.
 *
 * @param {import("http").IncomingMessage} req
 * @param {string|null} token
 * @param {string|null|undefined} apiKey
 * @param {string|null|undefined} projectId
 * @returns {Record<string, string>}
 */
function buildForwardHeaders(req, token, apiKey, projectId) {
  /** @type {Record<string, string>} */
  const headers = {};

  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    const lowerKey = key.toLowerCase();
    const allowed =
      FORWARDED_REQUEST_HEADERS.includes(lowerKey) ||
      FORWARDED_REQUEST_HEADER_PREFIXES.some((prefix) => lowerKey.startsWith(prefix));

    if (!allowed) {
      continue;
    }

    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  if (apiKey) {
    headers["X-Goog-Api-Key"] = apiKey;
  }
  headers["Content-Type"] = req.headers["content-type"] || "application/json";
  headers.Accept = req.headers.accept || "application/json, text/event-stream";
  if (projectId) {
    headers["X-Stitch-Project-Id"] = projectId;
  }

  return headers;
}

/**
 * Picks the allow-listed headers out of an upstream response.
 *
 * @param {Headers} upstreamHeaders
 * @returns {Record<string, string>}
 */
function buildForwardResponseHeaders(upstreamHeaders) {
  /** @type {Record<string, string>} */
  const headers = {};

  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstreamHeaders.get(name);
    if (value !== null && value !== undefined && value !== "") {
      headers[name] = value;
    }
  }

  return headers;
}

/**
 * Reads a request body with a hard size limit.
 *
 * Returns `{ tooLarge: true }` as soon as the limit is exceeded, so the caller can answer
 * `413` **without buffering the rest of the payload** — the whole point of the limit. The
 * bytes read so far are still returned so the caller can recover the JSON-RPC `id`.
 *
 * @param {import("http").IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<{ body: string|undefined, tooLarge: boolean, readBytes: number }>}
 */
async function readRequestBody(req, maxBytes) {
  if (req.method === "GET" || req.method === "HEAD") {
    return { body: undefined, tooLarge: false, readBytes: 0 };
  }

  const chunks = [];
  let readBytes = 0;

  for await (const chunk of req) {
    // Accumulate the chunk *before* testing the limit: the bytes already read are what let
    // the caller recover the JSON-RPC id for the 413 response. Memory stays bounded because
    // this returns as soon as the limit is crossed, so at most one extra chunk is buffered.
    chunks.push(chunk);
    readBytes += chunk.length;
    if (readBytes > maxBytes) {
      return {
        body: Buffer.concat(chunks).toString("utf8"),
        tooLarge: true,
        readBytes,
      };
    }
  }

  return {
    body: chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined,
    tooLarge: false,
    readBytes,
  };
}

/** @param {string|undefined} rawUrl @returns {boolean} */
function isMcpPath(rawUrl) {
  return typeof rawUrl === "string" && (rawUrl === "/mcp" || rawUrl.startsWith("/mcp?"));
}

/**
 * Routes whose payloads contain user content and configuration. Reachable from the LAN (the
 * owner's deployment) but not from the public internet, and never cross-origin.
 *
 * @param {string} pathname
 * @returns {boolean}
 */
function isSensitivePath(pathname) {
  return (
    pathname === "/logs" ||
    pathname === "/api/logs" ||
    pathname.startsWith("/api/logs/") ||
    pathname === "/metrics" ||
    pathname === "/health"
  );
}

/**
 * Every log-viewer route, including the raw file reader (finding ★N1).
 *
 * @param {string} pathname
 * @returns {boolean}
 */
function isLogViewerPath(pathname) {
  return pathname === "/logs" || pathname === "/api/logs" || pathname.startsWith("/api/logs/");
}

/**
 * Is the caller on the local network?
 *
 * `X-Forwarded-For` is only consulted when `TRUST_PROXY` is on (finding ★N4): otherwise any
 * client could claim to be `127.0.0.1` and read the log viewer. When it *is* trusted, the
 * left-most entry is used, as a reverse proxy writes its own address last.
 *
 * @param {import("http").IncomingMessage} req
 * @returns {boolean}
 */
function isLocalClient(req) {
  // Behind a reverse proxy the peer is always the proxy, so the forwarded client address must be
  // the one that decides. Trusting the socket address first would mark every proxied request as
  // local and hand the log viewer to the internet.
  if (TRUST_PROXY) {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
      const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const client = value.split(",")[0].trim();
      return isLoopbackAddress(client) || isPrivateAddress(client);
    }
  }

  const remote = req.socket.remoteAddress || "";
  return isLoopbackAddress(remote) || isPrivateAddress(remote);
}

async function routeRequest(req, res) {
  // Track connection for graceful shutdown
  trackConnection(req.socket);

  // --- Origin and Host policy (ADR 0005) ---------------------------------------------
  // Owner decisions: the proxy stays on 0.0.0.0 so other LAN machines can use it, and origins
  // must accept LAN computers. The model is therefore "private network allowed, public internet
  // refused" — *not* "loopback only", which would break the owner's setup.
  const originDecision = evaluateOrigin(req.headers.origin, {
    corsOrigin: CORS_ORIGIN,
    allowedOrigins: ALLOWED_ORIGINS_CSV,
  });

  // CORS is scoped to /mcp only. The log viewer, the logs API, metrics and health must never
  // advertise CORS to a browser (finding ★C4).
  res.setHeader("Vary", "Origin");
  if (isMcpPath(req.url)) {
    setCorsHeadersWith(res, req, originDecision, { wildcard: CORS_ORIGIN === "*" });
  }

  // Handle CORS preflight on /mcp.
  if (req.method === "OPTIONS" && isMcpPath(req.url)) {
    if (!originDecision.allowed) {
      return sendJsonRpcError(res, 403, -32001, "Invalid Origin header", null);
    }
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "OPTIONS") {
    // No CORS for non-MCP routes; answer plainly so a client is not left hanging.
    res.writeHead(204);
    res.end();
    return;
  }

  // The URL is built from a constant base so a malformed `Host` can never break parsing
  // (finding ★C2). A malformed request *target*, however, still has to be handled: an absolute
  // form such as `http://[bad/health` makes the `URL` constructor throw. That is a client
  // error, so answer `400` rather than letting it become a generic `500`.
  let url;
  try {
    url = new URL(req.url || "/", "http://localhost");
  } catch {
    return sendJsonRpcError(res, 400, -32600, "Invalid Request: malformed request target", null, {
      Connection: "close",
    });
  }

  // --- Host validation (finding ★C2) ---
  // Never build the URL from the Host header: a malformed value must not be able to throw.
  const hostCheck = parseHostHeaderFrom(req);
  if (hostCheck.reason !== null) {
    recordMetrics(state.metrics, {
      method: req.method || "UNKNOWN",
      path: url.pathname,
      status: 400,
      durationMs: 0,
      isError: true,
    });
    return sendJsonRpcError(res, 400, -32600, `Invalid Request: ${hostCheck.reason}`, null, {
      Connection: "close",
    });
  }

  // DNS-rebinding control: only private/LAN host names are accepted (ADR 0005). A malicious
  // public page can point its domain at a LAN address, and the browser then sends
  // `Host: evil.example` to this machine; refusing public hosts closes that path.
  const hostDecision = evaluateHost(req, {
    allowedHosts: ALLOWED_HOSTS_CSV,
    allowAll: ALLOW_ALL_HOSTS,
  });
  if (!hostDecision.allowed) {
    recordMetrics(state.metrics, {
      method: req.method || "UNKNOWN",
      path: "/",
      status: 403,
      durationMs: 0,
      isError: true,
    });
    return sendJsonRpcError(res, 403, -32001, `Invalid Host header: ${hostDecision.reason}`, null, {
      Connection: "close",
    });
  }

  const isHead = req.method === "HEAD";

  // Findings ★C4/★N1: the viewer, the logs API, metrics and verbose health expose full
  // request/response bodies (prompts, designs, project IDs) and configuration. They are
  // readable from the LAN — that is the owner's deployment — but never from the public
  // internet, and never cross-origin (no CORS is emitted for them above).
  //
  // Placed before routing on purpose: `/metrics` is served near the top of the router, so a
  // guard next to the log-viewer routes would leave it exposed.
  if (isSensitivePath(url.pathname) && !isLocalClient(req)) {
    return sendJsonRpcError(
      res,
      403,
      -32001,
      "This endpoint is only available from the local network",
      null,
    );
  }

  // --- Metrics endpoint ---
  if (METRICS_ENABLED && (req.method === "GET" || isHead) && url.pathname === "/metrics") {
    const body = renderPrometheusMetrics(state.metrics);
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(body)),
    });
    return res.end(isHead ? undefined : body);
  }

  if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
    return sendJson(res, 200, {
      resource: `http://localhost:${MCP_SERVER_PORT}`,
      authorization_servers: [`http://localhost:${MCP_SERVER_PORT}`],
    });
  }

  if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
    return sendJson(res, 200, {
      issuer: `http://localhost:${MCP_SERVER_PORT}`,
      authorization_endpoint: `http://localhost:${MCP_SERVER_PORT}/auth`,
      token_endpoint: `http://localhost:${MCP_SERVER_PORT}/token`,
    });
  }

  if (req.method === "GET" && url.pathname === "/auth") {
    return sendText(res, 200, "OK");
  }

  if (req.method === "POST" && url.pathname === "/token") {
    return sendJson(res, 200, { access_token: "local-proxy-token" });
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/health") {
    // ★C4: the public payload is deliberately tiny. It used to reveal absolute paths, the full
    // configuration and whether an API key was configured — useful reconnaissance, and a health
    // check needs none of it.
    const verbose = url.searchParams.get("verbose") === "1" && isLocalClient(req);

    if (!verbose) {
      return sendJson(
        res,
        200,
        {
          status: "ok",
          version: VERSION,
          uptime: Math.floor((Date.now() - state.metrics.startTime) / 1000),
        },
        { head: isHead },
      );
    }

    const logFilePath = path.join(LOG_DIR, LOG_FILE_NAME);
    const summaryLogExists = fs.existsSync(logFilePath);
    const summaryLogSizeBytes = summaryLogExists ? fs.statSync(logFilePath).size : 0;

    return sendJson(
      res,
      200,
      {
        status: "ok",
        proxy: {
          port: Number(MCP_SERVER_PORT),
          stitchUrl: STITCH_URL,
        },
        credentials: {
          envApiKeyConfigured: Boolean(STITCH_API_KEY),
          envProjectIdOptional: true,
          envProjectIdConfigured: Boolean(DEFAULT_STITCH_PROJECT_ID),
          gcloudFallbackEnabled: process.env.ENABLE_GCLOUD_FALLBACK === "1",
          projectConfigHint: DEFAULT_STITCH_PROJECT_ID
            ? undefined
            : "Can be provided via .env (STITCH_PROJECT_ID) or agent chat communication",
        },
        logging: {
          enabled: LOG_ENABLED,
          level: LOG_LEVEL,
          dir: LOG_DIR,
          fileName: LOG_FILE_NAME,
          summaryLogExists,
          summaryLogSizeBytes,
          maxBodyChars: LOG_MAX_BODY_CHARS,
          maxFileSizeBytes: LOG_MAX_FILE_SIZE_BYTES,
          maxRotatedFiles: LOG_MAX_ROTATED_FILES,
          skipMcpGet: LOG_SKIP_MCP_GET,
          skipMcpMethods: Array.from(LOG_SKIP_MCP_METHODS),
          slowRequestMs: LOG_SLOW_REQUEST_MS,
          verySlowRequestMs: LOG_VERY_SLOW_REQUEST_MS,
        },
        logViewer: {
          enabled: LOG_VIEWER_ENABLED,
          maxFileBytes: LOG_VIEWER_MAX_FILE_BYTES,
          summaryMaxLines: LOG_SUMMARY_MAX_LINES,
        },
        resilience: {
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
          maxBodySizeBytes: MAX_BODY_SIZE_BYTES,
          rateLimitEnabled: RATE_LIMIT_ENABLED,
          rateLimitMaxRps: RATE_LIMIT_MAX_RPS,
          rateLimitBurst: RATE_LIMIT_BURST,
          corsOrigin: CORS_ORIGIN,
          upstreamRetryEnabled: UPSTREAM_RETRY_ENABLED,
          upstreamRetryAttempts: UPSTREAM_RETRY_ATTEMPTS,
          upstreamRetryBaseDelayMs: UPSTREAM_RETRY_BASE_DELAY_MS,
          localFallbackMethods: Array.from(LOCAL_FALLBACK_METHODS),
        },
        metrics: {
          enabled: METRICS_ENABLED,
          requestsTotal: state.metrics.requestsTotal,
          errorsTotal: state.metrics.errorsTotal,
          activeConnections: state.metrics.activeConnections,
          rateLimitedTotal: state.metrics.rateLimitedTotal,
          uptimeSeconds: Math.floor((Date.now() - state.metrics.startTime) / 1000),
        },
        timestamp: new Date().toISOString(),
      },
      { head: isHead },
    );
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/instructions") {
    try {
      const markdown = readInstructionsMarkdown();
      const data = parseInstructionsMarkdown(markdown);
      const accept = req.headers.accept || "";

      if (isHead) {
        // `HEAD` exists so that container/runtime healthchecks (BusyBox `wget --spider`,
        // Docker `HEALTHCHECK`) work. Body must be empty; the status is what matters.
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end();
      }

      if (accept.includes("application/json")) {
        return sendJson(res, 200, data);
      }

      if (accept.includes("text/markdown") || accept.includes("text/plain")) {
        return sendText(res, 200, markdown, {
          "Content-Type": "text/markdown; charset=utf-8",
        });
      }

      setHtmlSecurityHeaders(res);
      return sendHtml(res, 200, renderInstructionsHtml(data));
    } catch (error) {
      return sendJson(res, 500, {
        error: "Failed to load instructions",
        details: error.message,
      });
    }
  }

  // --- Log Viewer Endpoints ---

  // ★N1: the guard used to be `startsWith("/logs")`, which never matched `/api/logs`. Every
  // viewer route must honour LOG_VIEWER_ENABLED, including the raw file reader.
  if (!LOG_VIEWER_ENABLED && isLogViewerPath(url.pathname)) {
    return sendJson(res, 404, { error: "Log viewer is disabled" });
  }

  if (req.method === "GET" && url.pathname === "/logs") {
    setHtmlSecurityHeaders(res);
    return sendHtml(res, 200, renderLogsHtml());
  }

  if (req.method === "GET" && url.pathname === "/api/logs") {
    const summaryLogPath = path.join(LOG_DIR, LOG_FILE_NAME);
    const summaryExists = fs.existsSync(summaryLogPath);
    const summarySize = summaryExists ? fs.statSync(summaryLogPath).size : 0;

    return sendJson(res, 200, {
      logDir: LOG_DIR,
      summaryLog: {
        name: LOG_FILE_NAME,
        exists: summaryExists,
        size: summarySize,
      },
      projects: scanLogDirectory(),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/logs/summary") {
    const limit = Number.parseInt(
      url.searchParams.get("limit") || String(LOG_SUMMARY_MAX_LINES),
      10,
    );
    const offset = Number.parseInt(url.searchParams.get("offset") || "0", 10);

    return sendJson(res, 200, readSummaryLogLines(limit, offset));
  }

  // Match /api/logs/<projectId>/<filename>
  const logFileMatch = url.pathname.match(/^\/api\/logs\/([^/]+)\/(.+)$/);
  if (req.method === "GET" && logFileMatch) {
    const [, projectId, filename] = logFileMatch;
    // Decode URI components (filenames have encoded dots from timestamps)
    const decodedFilename = decodeURIComponent(filename);
    const result = readLogFile(projectId, decodedFilename);

    if (result.error) {
      return sendJson(res, result.status, { error: result.error });
    }

    return sendText(res, 200, result.content, {
      "Content-Type": "text/plain; charset=utf-8",
      "X-File-Size": String(result.size),
    });
  }

  if (url.pathname === "/mcp") {
    const requestStartedAt = Date.now();
    const requestLogId = generateRequestLogId();
    // Declared here so the catch block can tell a client disconnect from a real failure.
    let clientDisconnected = false;
    // Declared here so every error path, including the catch block, can echo the JSON-RPC id
    // that the client is waiting on (finding P2).
    /** @type {any} */
    let requestIds = null;
    // Same reason: the catch block logs the failing request (finding ★N6).
    /** @type {string|undefined} */
    let requestBody;
    /** @type {string|null|undefined} */
    let logProjectId;
    // True when an unsafe request failed after being sent, so Stitch may have applied it.
    let outcomeUnknown = false;
    /** @type {any} */
    let classification = {
      safe: false,
      requestClass: "unsafe",
      reason: "unclassified",
      method: "unknown",
      toolName: null,
    };

    // --- Method guard (MCP Streamable HTTP spec) ---
    // Stitch only implements POST. Forwarding GET/DELETE/PUT upstream returns a
    // Google HTML 405 error page, which is not a valid MCP response and makes
    // clients log confusing parse errors. Answer these locally instead.
    if (req.method !== "POST") {
      const durationMs = Date.now() - requestStartedAt;

      if (req.method === "GET") {
        // Spec: a server that offers no SSE stream MUST return 405 Method Not Allowed.
        recordMetrics(state.metrics, {
          method: req.method,
          path: url.pathname,
          status: 405,
          durationMs,
          isError: false,
        });
        appendSummaryLog(
          `${new Date().toISOString()} - ID: ${requestLogId} - GET /mcp - STATUS: 405 - DURATION_MS: ${durationMs} - LATENCY: ${classifyDuration(durationMs)} - NOTE: no SSE stream offered\n`,
        );
        res.setHeader("Allow", "POST, OPTIONS");
        return sendJson(res, 405, {
          jsonrpc: "2.0",
          error: {
            code: -32005,
            message: "Method Not Allowed: this endpoint does not offer an SSE stream",
          },
          id: null,
        });
      }

      if (req.method === "DELETE") {
        // Spec: a server MAY return 405 to indicate it does not allow session termination.
        recordMetrics(state.metrics, {
          method: req.method,
          path: url.pathname,
          status: 405,
          durationMs,
          isError: false,
        });
        appendSummaryLog(
          `${new Date().toISOString()} - ID: ${requestLogId} - DELETE /mcp - STATUS: 405 - DURATION_MS: ${durationMs} - LATENCY: ${classifyDuration(durationMs)} - NOTE: stateless, no session to terminate\n`,
        );
        res.setHeader("Allow", "POST, OPTIONS");
        return sendJson(res, 405, {
          jsonrpc: "2.0",
          error: {
            code: -32005,
            message: "Method Not Allowed: this server is stateless and has no session to terminate",
          },
          id: null,
        });
      }

      recordMetrics(state.metrics, {
        method: req.method,
        path: url.pathname,
        status: 405,
        durationMs,
        isError: false,
      });
      appendSummaryLog(
        `${new Date().toISOString()} - ID: ${requestLogId} - ${req.method} /mcp - STATUS: 405 - DURATION_MS: ${durationMs} - LATENCY: ${classifyDuration(durationMs)}\n`,
      );
      res.setHeader("Allow", "POST, OPTIONS");
      return sendJson(res, 405, {
        jsonrpc: "2.0",
        error: {
          code: -32005,
          message: `Method Not Allowed: ${req.method} is not supported on /mcp`,
        },
        id: null,
      });
    }

    // --- Origin validation (MCP spec requirement) ---
    if (!originDecision.allowed) {
      state.metrics.rateLimitedTotal += 1;
      // The spec explicitly permits a JSON-RPC error *without* an id for a rejected Origin.
      return sendJsonRpcError(
        res,
        403,
        -32001,
        `Invalid Origin header: ${originDecision.reason}`,
        null,
      );
    }

    // --- Rate limiting ---
    // ★N4: `X-Forwarded-For` is only meaningful when a reverse proxy you control sets it.
    // Trusting it unconditionally let any client present a fresh address per request and bypass
    // the limit entirely.
    const clientIp = TRUST_PROXY ? getClientIp(req) : req.socket.remoteAddress || "unknown";
    const rateLimitResult = checkRateLimitFor(
      state.rateLimitBuckets,
      { enabled: RATE_LIMIT_ENABLED, maxRps: RATE_LIMIT_MAX_RPS, burst: RATE_LIMIT_BURST },
      clientIp,
    );
    if (!rateLimitResult.allowed) {
      state.metrics.rateLimitedTotal += 1;
      // Read a bounded prefix of the body purely so the 429 can echo the request id.
      const limited = await readRequestBody(req, MAX_BODY_SIZE_BYTES);
      return sendJsonRpcError(
        res,
        429,
        -32002,
        "Rate limit exceeded. Please retry.",
        extractJsonRpcIds(limited.body),
        { "Retry-After": String(rateLimitResult.retryAfter) },
      );
    }

    try {
      const timestamp = new Date().toISOString();

      // --- Read the request body FIRST, with a hard size limit (findings P2 and N2) ---
      // The baseline checked credentials before reading the body, which meant the size limit
      // was unreachable for unauthenticated callers, and every error path hard-coded
      // `id: null` so clients could not resolve their pending call. Reading first is bounded
      // (`readRequestBody` stops at the limit) and lets every response echo the request id.
      const {
        body,
        tooLarge: bodyTooLarge,
        readBytes,
      } = await readRequestBody(req, MAX_BODY_SIZE_BYTES);

      requestBody = body;
      requestIds = extractJsonRpcIds(body);

      if (bodyTooLarge) {
        recordMetrics(state.metrics, {
          method: req.method || "UNKNOWN",
          path: url.pathname,
          status: 413,
          durationMs: Date.now() - requestStartedAt,
          isError: true,
        });
        appendSummaryLog(
          `${timestamp} - ID: ${requestLogId} - ${req.method} ${req.url} - STATUS: 413 - DURATION_MS: ${
            Date.now() - requestStartedAt
          } - ERROR: body too large (read ${readBytes}, max ${MAX_BODY_SIZE_BYTES})\n`,
        );
        return sendJsonRpcError(
          res,
          413,
          -32003,
          `Request body too large (max ${MAX_BODY_SIZE_BYTES} bytes)`,
          requestIds,
        );
      }

      // --- Credentials: request headers or env fallback ---
      let apiKey = STITCH_API_KEY;
      // Headers never override the project ID by design (see commit c125891); the
      // per-request project ID lives in `params.arguments.projectId` instead.
      const upstreamProjectId = DEFAULT_STITCH_PROJECT_ID;
      // Log attribution uses the ID the call actually names, falling back to the env default
      // (finding ★N5). This is separate from `upstreamProjectId` on purpose.
      const projectId = extractProjectIdFromBody(body) || DEFAULT_STITCH_PROJECT_ID;
      logProjectId = projectId;

      if (req.headers["stitch_api_key"]) {
        apiKey = req.headers["stitch_api_key"];
      }

      if (req.headers["x-stitch-api-key"]) {
        apiKey = req.headers["x-stitch-api-key"];
      }

      if (req.headers.authorization) {
        const { apiKey: headerApiKey } = parseAuthHeader(req.headers.authorization);
        apiKey = headerApiKey || apiKey;
      }

      // Defence in depth for the env key: a request that *supplies* its own credential is always
      // fine, and an origin the policy already allows (private network, per the owner's decision)
      // may use the env fallback. This guard exists so a future relaxation of the origin policy
      // cannot silently let a public website spend the server's own Stitch key.
      const credentialCameFromEnv = apiKey === STITCH_API_KEY && Boolean(STITCH_API_KEY);
      if (credentialCameFromEnv && req.headers.origin && !originDecision.allowed) {
        return sendJsonRpcError(
          res,
          403,
          -32001,
          "Invalid Origin header: a public origin may not use the proxy's configured API key",
          requestIds,
        );
      }

      // For security, do not allow API key in query params or body, only header or env var
      if (
        req.url.includes("stitch.googleapis.com") &&
        (req.url.includes("key=") || req.url.includes("api_key="))
      ) {
        console.warn("⚠️ API key should not be sent in query parameters");
      }

      const gcloudFallbackEnabled = process.env.ENABLE_GCLOUD_FALLBACK === "1";

      if (!apiKey && !gcloudFallbackEnabled) {
        recordMetrics(state.metrics, {
          method: req.method || "UNKNOWN",
          path: url.pathname,
          status: 401,
          durationMs: Date.now() - requestStartedAt,
          isError: true,
        });
        return sendJsonRpcError(
          res,
          401,
          -32007,
          "Missing API key. Configure mcp.json headers.STITCH_API_KEY or set STITCH_API_KEY",
          requestIds,
        );
      }

      // Warn once per process instead of on every request (finding N7).
      if (!projectId && !state.warnings.noProjectId) {
        state.warnings.noProjectId = true;
        console.warn(
          "⚠️ No project ID configured. Tools that require a project may fail. " +
            "Set STITCH_PROJECT_ID or pass projectId in the tool arguments.",
        );
      }

      let token = null;
      if (!apiKey && gcloudFallbackEnabled && req.method !== "GET") {
        token = getCachedToken();
      }

      // --- Classify (ADR 0003) -----------------------------------------------------------
      // `safe` vs `unsafe` decides whether a failure may be retried, whether identical
      // concurrent calls may be coalesced, and whether a detached result may be replayed.
      let parsedBody;
      try {
        parsedBody = body ? JSON.parse(body) : undefined;
      } catch {
        parsedBody = undefined;
      }

      classification = classifyRequest(parsedBody, {
        safeTools: SAFE_TOOLS_CSV.size ? SAFE_TOOLS_CSV : null,
        unsafeTools: UNSAFE_TOOLS_CSV.size ? UNSAFE_TOOLS_CSV : null,
      });

      // --- Replay of a stored result (ADR 0003) ------------------------------------------
      // Only unsafe calls are worth replaying: a safe call is cheaper to just re-run, and
      // replaying it would serve stale data.
      const explicitIdempotencyKey =
        req.headers["idempotency-key"] ||
        parsedBody?.params?._meta?.idempotencyKey ||
        (Array.isArray(parsedBody)
          ? parsedBody.find((message) => message?.params?._meta?.idempotencyKey)?.params?._meta
              ?.idempotencyKey
          : undefined);

      let fingerprint = null;
      if (!classification.safe) {
        fingerprint = state.idempotency.fingerprintOf({
          apiKey,
          method: classification.method,
          params: parsedBody?.params,
        });

        const stored = state.idempotency.take(fingerprint, {
          explicitKey: Boolean(explicitIdempotencyKey),
        });

        if (stored) {
          const durationMs = Date.now() - requestStartedAt;
          recordMetrics(state.metrics, {
            method: req.method || "UNKNOWN",
            path: url.pathname,
            status: stored.status,
            durationMs,
            isError: stored.status >= 500,
          });
          appendSummaryLog(
            `${timestamp} - ID: ${requestLogId} - ${req.method} ${req.url} - RPC: ${
              classification.method
            } - STATUS: ${stored.status} - DURATION_MS: ${durationMs} - REPLAYED: true\n`,
          );
          res.setHeader("X-Proxy-Replayed", "true");
          // The stored body carries the *original* caller's id; the retrying client is waiting on
          // its own id and would never resolve without this rewrite.
          return sendText(
            res,
            stored.status,
            rewriteJsonRpcId(stored.body, requestIds),
            { "Content-Type": stored.contentType || "application/json" },
            { head: isHead },
          );
        }
      }

      // --- Local fallback for methods Stitch does not implement ---
      // Avoids the upstream HTTP/2 stream reset that clients see as "fetch failed".
      const localFallback = buildLocalFallbackResponseFor(body, LOCAL_FALLBACK_METHODS);
      if (localFallback) {
        const durationMs = Date.now() - requestStartedAt;
        const durationClass = classifyDuration(durationMs);
        const methodSummary = formatMethodsForSummary(body);

        if ("notification" in localFallback) {
          recordMetrics(state.metrics, {
            method: req.method,
            path: url.pathname,
            status: 202,
            durationMs,
            isError: false,
          });
          appendSummaryLog(
            `${timestamp} - ID: ${requestLogId} - ${req.method} ${req.url} - RPC: ${methodSummary} - API_KEY: ${
              apiKey ? "configured" : "none"
            } - PROJECT_ID: ${projectId || "none"} - STATUS: 202 - DURATION_MS: ${durationMs} - LATENCY: ${durationClass} - LOCAL_FALLBACK: true\n`,
          );
          res.writeHead(202);
          return res.end();
        }

        const fallbackBody = JSON.stringify(localFallback);
        recordMetrics(state.metrics, {
          method: req.method,
          path: url.pathname,
          status: 200,
          durationMs,
          isError: false,
        });
        appendSummaryLog(
          `${timestamp} - ID: ${requestLogId} - ${req.method} ${req.url} - RPC: ${methodSummary} - API_KEY: ${
            apiKey ? "configured" : "none"
          } - PROJECT_ID: ${projectId || "none"} - STATUS: 200 - DURATION_MS: ${durationMs} - LATENCY: ${durationClass} - LOCAL_FALLBACK: true\n`,
        );
        writeDetailedDebugLog({
          requestLogId,
          timestamp,
          req,
          url,
          projectId,
          requestBody: body,
          requestContentType: req.headers["content-type"],
          durationMs,
          durationClass,
          responseStatus: 200,
          responseHeaders: { "content-type": "application/json" },
          responseBody: fallbackBody,
        });
        return sendText(res, 200, fallbackBody, {
          "Content-Type": "application/json; charset=utf-8",
        });
      }

      // --- Forward request to Stitch with timeout + retry ---
      const controller = new AbortController();
      let timedOut = false;

      // ADR 0003: an unsafe request must survive its client. Aborting it would stop *our* read
      // but not Stitch's work, so the generation would complete server-side with its result
      // thrown away — and the client's retry would start a second one. An unsafe request is
      // therefore allowed to run for `UNSAFE_MAX_DURATION_MS` in the background; the *client*
      // still gets its answer at `REQUEST_TIMEOUT_MS`, and the eventual result is stored so the
      // retry can reclaim it.
      let orphaned = false;
      const upstreamDeadlineMs = classification.safe ? REQUEST_TIMEOUT_MS : UNSAFE_MAX_DURATION_MS;

      // Both timers are unref'd: a lingering one must never keep the process (or a test run)
      // alive after the request it belongs to has finished.
      const timeoutId = setTimeout(() => {
        timedOut = true;
        if (classification.safe) {
          controller.abort();
        } else {
          orphaned = true;
          state.idempotency.recordOrphan();
        }
      }, REQUEST_TIMEOUT_MS);
      timeoutId.unref?.();

      const abortId = setTimeout(() => {
        controller.abort();
      }, upstreamDeadlineMs);
      abortId.unref?.();

      /** Clears both of this request's timers. Safe to call more than once. */
      const clearRequestTimers = () => {
        clearTimeout(timeoutId);
        clearTimeout(abortId);
      };

      /**
       * Clears only the *response* deadline. When a request is detached, the upstream keeps
       * running and `abortId` is the detached request's own safety limit, so it must survive.
       */
      const clearResponseTimer = () => {
        clearTimeout(timeoutId);
      };

      let upstreamInFlight = false;
      const onClientClose = () => {
        if (res.writableEnded) {
          return;
        }
        clientDisconnected = true;

        if (classification.safe) {
          // Nothing is lost by aborting a read-only call; the client can simply ask again.
          if (upstreamInFlight) {
            controller.abort();
          }
          return;
        }

        // Unsafe: detach instead of abort. The upstream keeps running and its result is stored
        // for the retry (orphan capture).
        orphaned = true;
        state.idempotency.recordOrphan();
        appendSummaryLog(
          `${new Date().toISOString()} - ID: ${requestLogId} - ${req.method} ${req.url} - STATUS: 499 - DETACHED: true - TOOL: ${
            classification.toolName || classification.method
          }\n`,
        );
      };
      res.on("close", onClientClose);

      const maxAttempts = UPSTREAM_RETRY_ENABLED ? Math.max(1, UPSTREAM_RETRY_ATTEMPTS) : 1;
      const deadlineAt = requestStartedAt + REQUEST_TIMEOUT_MS;

      /** @returns {Promise<Response>} */
      const performFetch = () =>
        state.upstreamLimiter
          .run(
            () =>
              fetchUpstreamWithRetry({
                url: STITCH_URL,
                method: req.method || "POST",
                headers: buildForwardHeaders(req, token, apiKey, upstreamProjectId),
                body,
                signal: controller.signal,
                safe: classification.safe,
                maxAttempts,
                baseDelayMs: UPSTREAM_RETRY_BASE_DELAY_MS,
                deadlineAt,
                isTimedOut: () => timedOut,
                isClientGone: () => clientDisconnected,
                onOutcomeUnknown: () => {
                  outcomeUnknown = true;
                },
              }),
            CONCURRENCY_QUEUE_WAIT_MS,
          )
          .catch((limitError) => {
            // Saturation is a *server-side* condition, so it must be a retryable, explicit
            // answer rather than a hung request or a generic 502.
            if (/** @type {any} */ (limitError)?.code === "SEMAPHORE_TIMEOUT") {
              /** @type {any} */ (limitError).proxyStatus = 503;
              /** @type {any} */ (limitError).retryAfterSeconds = 2;
            }
            throw limitError;
          });

      // --- In-flight coalescing for unsafe requests (ADR 0003) ---------------------------
      // A second identical unsafe request arriving while the first is still running must not
      // start a second generation. It attaches to the first and receives the same result.
      //
      // Coalescing requires a buffered response to share, so unsafe calls are read fully before
      // replying. Safe calls keep the streaming path untouched: they are cheap and replayable,
      // and streaming them is what makes long reads feel responsive.
      let coalescedResult = null;

      if (fingerprint && !classification.safe) {
        const joined = state.idempotency.join(fingerprint, async () => {
          upstreamInFlight = true;
          try {
            const shared = await performFetch();
            const sharedBody = await shared.text();
            return {
              status: shared.status,
              body: sharedBody,
              contentType: shared.headers.get("content-type") || "application/json",
              headers: Object.fromEntries(shared.headers.entries()),
            };
          } finally {
            upstreamInFlight = false;
            clearTimeout(timeoutId);
            clearTimeout(abortId);
          }
        });

        // The client must get an answer at REQUEST_TIMEOUT_MS even though the upstream is allowed
        // to keep running (orphan capture). So race the shared work against a response deadline:
        // whoever wins decides what this handler does. The upstream promise keeps running either
        // way and stores its own result.
        const deadline = new Promise((resolve) => {
          setTimeout(() => resolve(ORPHAN_SENTINEL), REQUEST_TIMEOUT_MS).unref?.();
        });

        const raced = await Promise.race([joined.promise, deadline]);

        if (raced === ORPHAN_SENTINEL) {
          clearResponseTimer();
          orphaned = true;
          state.idempotency.recordOrphan();

          // Attach the storage work to the still-running upstream request. This must never
          // reject: it runs after the client is gone.
          joined.promise
            .then((late) => {
              if (late.status < 400) {
                state.idempotency.put(fingerprint, late, {
                  explicitKey: Boolean(explicitIdempotencyKey),
                  delivered: false,
                });
              }
              appendSummaryLog(
                `${new Date().toISOString()} - ID: ${requestLogId} - ${classification.method} - ORPHAN_FINISHED: true - STATUS: ${late.status}\n`,
              );
            })
            .catch((lateError) => {
              appendSummaryLog(
                `${new Date().toISOString()} - ID: ${requestLogId} - ${classification.method} - ORPHAN_FAILED: ${describeFetchError(lateError)}\n`,
              );
            });

          recordMetrics(state.metrics, {
            method: req.method || "UNKNOWN",
            path: url.pathname,
            status: 504,
            durationMs: Date.now() - requestStartedAt,
            isError: true,
          });

          return sendJsonRpcError(
            res,
            504,
            -32004,
            `Upstream request is still running after ${REQUEST_TIMEOUT_MS}ms (${
              classification.toolName || classification.method
            }). It was not cancelled: retry the identical call to collect its result.`,
            requestIds,
          );
        }

        coalescedResult = raced;

        if (orphaned) {
          clearRequestTimers();
          if (coalescedResult.status < 400) {
            state.idempotency.put(fingerprint, coalescedResult, {
              explicitKey: Boolean(explicitIdempotencyKey),
              delivered: false,
            });
          }
          recordMetrics(state.metrics, {
            method: req.method || "UNKNOWN",
            path: url.pathname,
            status: 499,
            durationMs: Date.now() - requestStartedAt,
            isError: false,
          });
          appendSummaryLog(
            `${timestamp} - ID: ${requestLogId} - ${req.method} ${req.url} - STATUS: 499 - ORPHAN_STORED: ${
              coalescedResult.status < 400
            } - TOOL: ${classification.toolName || classification.method}\n`,
          );
          console.warn(
            `⚠️ Detached unsafe request ${classification.toolName || classification.method} finished after the client left (status ${coalescedResult.status}); result stored for replay.`,
          );
          return;
        }

        if (joined.coalesced) {
          clearRequestTimers();
          appendSummaryLog(
            `${timestamp} - ID: ${requestLogId} - ${req.method} ${req.url} - RPC: ${
              classification.method
            } - STATUS: ${coalescedResult.status} - COALESCED: true\n`,
          );
          res.setHeader("X-Proxy-Coalesced", "true");

          if (coalescedResult.status < 400) {
            state.idempotency.put(fingerprint, coalescedResult, {
              explicitKey: Boolean(explicitIdempotencyKey),
              delivered: true,
            });
          }

          // The shared body carries the *first* caller's JSON-RPC id; rewrite it to this
          // caller's id so both clients can resolve their own pending call.
          return sendText(
            res,
            coalescedResult.status,
            rewriteJsonRpcId(coalescedResult.body, requestIds),
            { "Content-Type": coalescedResult.contentType },
            { head: isHead },
          );
        }
      }

      let response;
      if (coalescedResult) {
        // This caller started the shared work: replay the buffered result rather than re-reading
        // the (already consumed) upstream stream.
        response = new Response(coalescedResult.body, {
          status: coalescedResult.status,
          headers: { "Content-Type": coalescedResult.contentType },
        });
        if (coalescedResult.status < 400) {
          state.idempotency.put(fingerprint, coalescedResult, {
            explicitKey: Boolean(explicitIdempotencyKey),
            delivered: true,
          });
        }
      } else {
        try {
          upstreamInFlight = true;
          response = await performFetch();
        } finally {
          upstreamInFlight = false;
          clearTimeout(timeoutId);
        }
      }

      const contentType = response.headers.get("content-type") || "";
      const isStreamingResponse =
        contentType.includes("text/event-stream") || contentType.includes("application/x-ndjson");

      // --- Stream or buffer response ---
      if (isStreamingResponse && response.body) {
        // SSE/Streaming: pipe chunks as they arrive.
        // The spec recommends `X-Accel-Buffering: no` so reverse proxies do not hold SSE
        // events back, and the upstream's MCP headers (session, retry) must survive.
        res.writeHead(response.status, {
          ...buildForwardResponseHeaders(response.headers),
          "Content-Type": contentType,
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });

        // Findings ★S1/S2/S3 (ADR 0004): a real pipeline with backpressure, three independent
        // deadlines, and a bounded capture buffer that only exists when debug logging is on.
        const captureEnabled = LOG_ENABLED && LOG_LEVEL === "debug";
        const streamAbort = new AbortController();
        const onStreamClientClose = () => {
          if (!res.writableEnded) {
            clientDisconnected = true;
            streamAbort.abort();
          }
        };
        res.on("close", onStreamClientClose);

        const streamResult = await streamWithBackpressure(response.body, res, {
          idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
          totalTimeoutMs: STREAM_MAX_DURATION_MS,
          maxCaptureBytes: captureEnabled ? LOG_MAX_BODY_CHARS : 0,
          signal: streamAbort.signal,
        });

        res.off("close", onStreamClientClose);

        const durationMs = Date.now() - requestStartedAt;
        const durationClass = classifyDuration(durationMs);
        const methodSummary = formatMethodsForSummary(body);

        // A truncated stream is an error for the client: it must not look like a clean end.
        if (!streamResult.ok && !streamResult.aborted) {
          const reason = streamResult.idleTimedOut
            ? `no data for ${STREAM_IDLE_TIMEOUT_MS}ms`
            : streamResult.totalTimedOut
              ? `stream exceeded ${STREAM_MAX_DURATION_MS}ms`
              : describeFetchError(streamResult.error);
          console.warn(`⚠️ Upstream stream ended abnormally: ${reason}`);
        }

        recordMetrics(state.metrics, {
          method: req.method,
          path: url.pathname,
          status: response.status,
          durationMs,
          isError: response.status >= 500 || !streamResult.ok,
        });

        if (!(req.method === "GET" && LOG_SKIP_MCP_GET)) {
          appendSummaryLog(
            `${timestamp} - ID: ${requestLogId} - ${req.method} ${req.url} - RPC: ${methodSummary} - API_KEY: ${
              apiKey ? "configured" : "none"
            } - PROJECT_ID: ${projectId || "none"} - STATUS: ${response.status} - DURATION_MS: ${durationMs} - LATENCY: ${durationClass} - STREAM: true - BYTES: ${streamResult.bytes}${
              streamResult.idleTimedOut
                ? " - IDLE_TIMEOUT: true"
                : streamResult.totalTimedOut
                  ? " - TOTAL_TIMEOUT: true"
                  : streamResult.aborted
                    ? " - CLIENT_ABORTED: true"
                    : ""
            }\n`,
          );
        }

        if (captureEnabled) {
          writeDetailedDebugLog({
            requestLogId,
            timestamp,
            req,
            url,
            projectId,
            requestBody: body,
            requestContentType: req.headers["content-type"],
            durationMs,
            durationClass,
            responseStatus: response.status,
            responseHeaders: Object.fromEntries(response.headers.entries()),
            responseBody: streamResult.truncatedForLog
              ? `${streamResult.capturedBody}\n\n[truncated stream capture at ${LOG_MAX_BODY_CHARS} chars]`
              : streamResult.capturedBody,
          });
        }

        // Finding ★C5: without this `return` control fell through to the trailing
        // `sendJson(res, 404, ...)`, which threw `ERR_HTTP_HEADERS_SENT`. That unhandled
        // rejection terminated the process, so the *first* streamed Stitch response killed
        // the proxy. The response has already been fully written above.
        return;
      } else {
        // Non-streaming: buffer and send
        const rawText = await response.text();

        // --- tools/list annotation injection (ADR 0003) --------------------------------
        // Clients use `readOnlyHint`/`destructiveHint` to warn a human before an unsafe call.
        // Stitch does not always supply them, so the proxy fills them in from its own
        // classification — without ever overwriting an annotation the upstream provided.
        let text = rawText;
        if (ANNOTATE_TOOLS && classification.method === "tools/list" && response.status === 200) {
          text = annotateToolsList(rawText, {
            safeTools: SAFE_TOOLS_CSV.size ? SAFE_TOOLS_CSV : null,
            unsafeTools: UNSAFE_TOOLS_CSV.size ? UNSAFE_TOOLS_CSV : null,
          });
        }
        const durationMs = Date.now() - requestStartedAt;
        const durationClass = classifyDuration(durationMs);
        const methodSummary = formatMethodsForSummary(body);

        recordMetrics(state.metrics, {
          method: req.method,
          path: url.pathname,
          status: response.status,
          durationMs,
          isError: response.status >= 500,
        });

        if (!(req.method === "GET" && url.pathname === "/mcp" && LOG_SKIP_MCP_GET)) {
          appendSummaryLog(
            `${timestamp} - ID: ${requestLogId} - ${req.method} ${req.url} - RPC: ${methodSummary} - API_KEY: ${
              apiKey ? "configured" : "none"
            } - PROJECT_ID: ${projectId || "none"} - STATUS: ${response.status} - DURATION_MS: ${durationMs} - LATENCY: ${durationClass}\n`,
          );
        }

        writeDetailedDebugLog({
          requestLogId,
          timestamp,
          req,
          url,
          projectId,
          requestBody: body,
          requestContentType: req.headers["content-type"],
          durationMs,
          durationClass,
          responseStatus: response.status,
          responseHeaders: Object.fromEntries(response.headers.entries()),
          responseBody: text,
        });

        // Store a completed unsafe result so that a retry of the identical call can replay it
        // instead of asking Stitch to do the work again (ADR 0003). Only successful replies are
        // stored: caching an error would make a transient failure permanent.
        if (fingerprint && !classification.safe && response.status < 400) {
          state.idempotency.put(
            fingerprint,
            { status: response.status, body: text, contentType: contentType || "application/json" },
            { explicitKey: Boolean(explicitIdempotencyKey), delivered: true },
          );
        }

        return sendText(
          res,
          response.status,
          text,
          {
            ...buildForwardResponseHeaders(response.headers),
            "Content-Type": contentType || "application/json",
          },
          { head: isHead },
        );
      }
    } catch (error) {
      const durationMs = Date.now() - requestStartedAt;
      const durationClass = classifyDuration(durationMs);
      const isTimeout = error.name === "AbortError" || error.name === "TimeoutError";
      const errorDetail = describeFetchError(error);

      // Upstream concurrency saturation is a server-side, retryable condition.
      if (/** @type {any} */ (error)?.code === "SEMAPHORE_TIMEOUT") {
        res.setHeader("Retry-After", "2");
        return sendJsonRpcError(
          res,
          503,
          -32009,
          "Proxy is at its upstream concurrency limit. Retry shortly.",
          requestIds,
          { "Retry-After": "2" },
        );
      }

      // Client went away mid-flight: nothing to respond to, just record it.
      if (clientDisconnected && !res.writableEnded) {
        console.warn(`⚠️ Client disconnected before upstream responded (${errorDetail})`);
        recordMetrics(state.metrics, {
          method: req.method,
          path: url.pathname,
          status: 499,
          durationMs,
          isError: false,
        });
        appendSummaryLog(
          `${new Date().toISOString()} - ID: ${requestLogId} - ${req.method} ${req.url} - STATUS: 499 - DURATION_MS: ${durationMs} - LATENCY: ${durationClass} - ERROR: client disconnected\n`,
        );
        return;
      }

      console.error("❌ Proxy error:", errorDetail);

      recordMetrics(state.metrics, {
        method: req.method,
        path: url.pathname,
        status: isTimeout ? 504 : 502,
        durationMs,
        isError: true,
      });

      appendSummaryLog(
        `${new Date().toISOString()} - ID: ${requestLogId} - ${req.method} ${req.url} - STATUS: ${isTimeout ? 504 : 502} - DURATION_MS: ${durationMs} - LATENCY: ${durationClass} - ERROR: ${errorDetail}\n`,
      );

      // Finding ★N6: this used `requestBody: undefined` and the env project ID, so the
      // requests most worth debugging — the ones that failed — came out with no body and the
      // wrong project. The body is already in scope and bounded by the size limit.
      writeDetailedDebugLog({
        requestLogId,
        timestamp: new Date().toISOString(),
        req,
        url,
        projectId: logProjectId || DEFAULT_STITCH_PROJECT_ID,
        requestBody,
        requestContentType: req.headers["content-type"],
        durationMs,
        durationClass,
        responseStatus: isTimeout ? 504 : 502,
        responseHeaders: {},
        responseBody: "",
        error,
      });

      if (res.writableEnded) {
        return;
      }

      if (isTimeout) {
        return sendJsonRpcError(
          res,
          504,
          -32004,
          `Upstream request timed out after ${REQUEST_TIMEOUT_MS}ms`,
          requestIds,
        );
      }

      // ADR 0003: an unsafe request that failed *after* it was sent may already have been
      // applied by Stitch. Retrying it silently would duplicate the side effect, and a plain
      // `-32006` would invite the model to try again. Answer with a dedicated code whose
      // message tells the client exactly how to establish the truth.
      if (outcomeUnknown && !classification.safe) {
        appendSummaryLog(
          `${new Date().toISOString()} - ID: ${requestLogId} - ${req.method} ${req.url} - STATUS: 502 - OUTCOME_UNKNOWN: true - TOOL: ${
            classification.toolName || classification.method
          }\n`,
        );
        return sendJsonRpcError(
          res,
          502,
          -32008,
          `Outcome unknown: the request may have been applied by Stitch before the connection failed (${
            classification.toolName || classification.method
          }). Call list_screens or list_projects to check before retrying.`,
          requestIds,
        );
      }

      // Always answer with a JSON-RPC error object so MCP clients can parse it.
      return sendJsonRpcError(
        res,
        502,
        -32006,
        `Upstream request to Stitch failed: ${errorDetail}`,
        requestIds,
      );
    }
  }

  return sendJsonRpcError(res, 404, -32601, `Not found: ${req.method} ${url.pathname}`, null);
}

/**
 * Performs one upstream request with the phase-aware retry policy (ADR 0003).
 *
 * Extracted from the router so that the streaming path and the coalesced (buffered) path cannot
 * drift apart: if a retry rule changes, it changes for both.
 *
 * @param {{
 *   url: string,
 *   method: string,
 *   headers: Record<string, string>,
 *   body: string|undefined,
 *   signal: AbortSignal,
 *   safe: boolean,
 *   maxAttempts: number,
 *   baseDelayMs: number,
 *   deadlineAt: number,
 *   isTimedOut: () => boolean,
 *   isClientGone: () => boolean,
 *   onOutcomeUnknown: () => void,
 * }} options
 * @returns {Promise<Response>}
 */
async function fetchUpstreamWithRetry(options) {
  const {
    url,
    method,
    headers,
    body,
    signal,
    safe,
    maxAttempts,
    baseDelayMs,
    deadlineAt,
    isTimedOut,
    isClientGone,
    onOutcomeUnknown,
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remainingMs = deadlineAt - Date.now();

    try {
      const response = await fetch(url, { method, headers, body, signal });

      // --- HTTP status retry (safe requests only) ---
      const decision = decideRetry({
        safe,
        attempt,
        maxAttempts,
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        remainingMs,
        baseDelayMs,
      });

      if (decision.retry && !isTimedOut() && !isClientGone()) {
        console.warn(
          `\u26a0\ufe0f Upstream attempt ${attempt}/${maxAttempts} returned ${response.status} (${decision.reason}). Retrying in ${decision.delayMs}ms...`,
        );
        await response.arrayBuffer().catch(() => undefined);
        await sleep(decision.delayMs);
        continue;
      }

      return response;
    } catch (fetchError) {
      lastError = fetchError;

      const decision = decideRetry({
        safe,
        attempt,
        maxAttempts,
        error: fetchError,
        remainingMs,
        baseDelayMs,
      });

      if (decision.outcomeUnknown) {
        onOutcomeUnknown();
      }

      if (!decision.retry || isTimedOut() || isClientGone()) {
        throw fetchError;
      }

      console.warn(
        `\u26a0\ufe0f Upstream attempt ${attempt}/${maxAttempts} failed (${describeFetchError(fetchError)}, phase=${decision.phase}). Retrying in ${decision.delayMs}ms...`,
      );
      await sleep(decision.delayMs);
    }
  }

  throw lastError || new Error("Upstream request failed");
}

/**
 * Adds tool annotations to a `tools/list` result body.
 *
 * Why: a client shows a confirmation prompt for a `destructiveHint` tool and may skip it for a
 * `readOnlyHint` one. Stitch does not reliably annotate its tools, so without this the model gets
 * no warning before a call that spends generation quota.
 *
 * Returns the body unchanged when it is not a recognisable `tools/list` result, or when nothing
 * needed annotating.
 *
 * @param {string} body
 * @param {{ safeTools?: Set<string>|null, unsafeTools?: Set<string>|null }} [options]
 * @returns {string}
 */
function annotateToolsList(body, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }

  const tools = parsed?.result?.tools;
  if (!Array.isArray(tools)) {
    return body;
  }

  let changed = false;
  const annotated = tools.map((tool) => {
    if (!tool || typeof tool.name !== "string") {
      return tool;
    }

    const annotations = annotationsForTool(tool.name, tool.annotations, options);
    if (!annotations) {
      return tool;
    }

    changed = true;
    return { ...tool, annotations: { ...(tool.annotations || {}), ...annotations } };
  });

  if (!changed) {
    return body;
  }

  return JSON.stringify({ ...parsed, result: { ...parsed.result, tools: annotated } });
}

/** Distinguishes "the response deadline won" from a real upstream result. */
const ORPHAN_SENTINEL = Symbol("orphan-deadline");

// --- Request safety wrapper ---------------------------------------------------

/**
 * Crash-proof entry point for every request (finding ★C2).
 *
 * The router (`routeRequest`) is a large `async` function with many awaits. A single
 * unexpected throw anywhere in it would otherwise become an unhandled rejection, which
 * terminates the Node process — the baseline was killable with one packet carrying a
 * malformed `Host` header.
 *
 * This wrapper guarantees three things:
 *   1. no throw can escape into the event loop,
 *   2. the client always receives a well-formed JSON-RPC error (`-32603`, Internal error),
 *   3. the proxy keeps serving subsequent requests.
 *
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @returns {Promise<void>}
 */
async function handleRequest(req, res) {
  try {
    await routeRequest(req, res);
  } catch (error) {
    const detail = describeFetchError(error);
    console.error("❌ Unhandled error while handling a request:", detail);

    if (res.headersSent || res.writableEnded) {
      // The response was already partly written; the only safe move is to end it so the
      // client sees a truncated response rather than hanging until its own timeout.
      res.end();
      return;
    }

    try {
      sendJsonRpcError(res, 500, -32603, `Internal error: ${detail}`);
    } catch (sendError) {
      console.error(
        "❌ Failed to send the internal-error response:",
        describeFetchError(sendError),
      );
      res.destroy();
    }
  }
}

// --- Server factory ----------------------------------------------------------

/**
 * Proxies currently listening in this process, mapped to their configuration fingerprint.
 * Used only to refuse two *concurrently listening* proxies with different configuration while
 * configuration is still process-global (see the guard inside `createProxyServer`).
 *
 * @type {Map<import("http").Server, string>}
 */
const liveProxies = new Map();

/**
 * Creates a proxy `http.Server` **without** starting to listen.
 *
 * This is the Phase 0 test seam: tests call it with injected configuration and bind to an
 * ephemeral port. Behaviour is identical to the pre-seam module-level server, apart from
 * the injected configuration and the per-instance state.
 *
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   overrides?: Record<string, unknown>,
 *   onLog?: (line: string) => void,
 * }} [options]
 * @returns {import("http").Server} the server, not yet listening
 */
function createProxyServer(options = {}) {
  const resolved = applyConfig(options.env || process.env, options.overrides || {});
  state = createState(resolved);

  // PHASE 2 LIMITATION, made explicit instead of silent.
  //
  // Configuration still lives in module-level bindings, so only the most recently created
  // proxy's configuration is active in a given process. Before this guard existed, starting a
  // second proxy silently reconfigured the first one, so a test that used two proxies with
  // different settings could pass for entirely the wrong reason.
  //
  // The guard only inspects proxies that are **currently listening**: the ordinary
  // create → use → close → create sequence is unaffected. Phase 6 moves configuration onto the
  // instance and this restriction disappears.
  const fingerprint = JSON.stringify(
    Object.keys(resolved)
      .sort()
      .map((key) => {
        const value = resolved[key];
        return [key, value instanceof Set ? [...value].sort() : value];
      }),
  );

  for (const otherFingerprint of liveProxies.values()) {
    if (otherFingerprint !== fingerprint) {
      throw new Error(
        "Two proxies with different configuration are listening in the same process. " +
          "Configuration is still process-global (fixed in Phase 6), so put tests that need " +
          "different configuration in separate test files.",
      );
    }
  }

  /** @type {Set<import("http").ServerResponse>} */
  const liveResponses = new Set();

  const server = http.createServer((req, res) => {
    // Tracked so tests can assert on real backpressure (`writableLength`) without reaching into
    // Node internals. Removed on close, so the set cannot grow.
    liveResponses.add(res);
    res.on("close", () => liveResponses.delete(res));

    // `handleRequest` never rejects; the extra guard is defensive only.
    handleRequest(req, res).catch((error) => {
      console.error("❌ Unhandled rejection from handleRequest:", error);
      try {
        res.destroy();
      } catch {
        /* the socket is already gone */
      }
    });
  });

  // Node emits `clientError` when a peer sends something that is not a valid HTTP request
  // (bad request line, bad headers, malformed chunked encoding). The default behaviour is to
  // write a bare `400 Bad Request`; we answer consistently instead. `ECONNRESET` means the
  // peer already left, so there is nothing to send.
  server.on("clientError", (error, socket) => {
    if (/** @type {any} */ (error).code === "ECONNRESET" || !socket.writable) {
      socket.destroy();
      return;
    }

    const body = JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Invalid Request: malformed HTTP request" },
      id: null,
    });

    try {
      socket.end(
        `HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(
          body,
        )}\r\nConnection: close\r\n\r\n${body}`,
      );
    } catch {
      socket.destroy();
    }
  });

  // --- Explicit socket timeouts (finding ★S6, ADR 0004) ------------------------------
  // Node's defaults are requestTimeout=300000, headersTimeout=60000, keepAliveTimeout=5000.
  // They are invisible to operators and, worse, a 60 s+ Stitch generation could be cut by a
  // timeout nobody configured. `requestTimeout` gets a grace margin so the proxy's own
  // JSON-RPC deadline always fires first and the client gets a parseable error.
  server.requestTimeout = state.config.REQUEST_TIMEOUT_MS + 5000;
  server.headersTimeout = Math.min(
    state.config.SERVER_HEADERS_TIMEOUT_MS,
    server.requestTimeout - 1000,
  );
  server.keepAliveTimeout = state.config.SERVER_KEEP_ALIVE_TIMEOUT_MS;

  // Expose the instance state for tests and graceful shutdown without widening the
  // `http.Server` type for every consumer.
  /** @type {any} */ (server).state = state;
  /** @type {any} */ (server).liveResponses = liveResponses;

  liveProxies.set(server, fingerprint);
  server.on("close", () => {
    liveProxies.delete(server);
  });

  return server;
}

function logStartupBanner() {
  const hasApiKey = Boolean(STITCH_API_KEY);
  const hasProjectId = Boolean(DEFAULT_STITCH_PROJECT_ID);
  console.log(
    `🚀 Stitch MCP Proxy (apiKey=${hasApiKey ? "env" : "header"}, projectId=${hasProjectId ? "env" : "optional"}) running at:`,
  );
  console.log(`👉 http://${MCP_SERVER_HOST}:${MCP_SERVER_PORT}/mcp`);
  if (LOG_ENABLED) {
    console.log(`🪵 Logging enabled (${LOG_LEVEL}) -> ${path.join(LOG_DIR, LOG_FILE_NAME)}`);
    if (LOG_LEVEL === "debug") {
      console.log(
        `   Debug caps: body=${LOG_MAX_BODY_CHARS} chars, file=${LOG_MAX_FILE_SIZE_BYTES} bytes, rotations=${LOG_MAX_ROTATED_FILES}`,
      );
      console.log(
        `   Skip noise: GET /mcp=${LOG_SKIP_MCP_GET}, methods=${Array.from(LOG_SKIP_MCP_METHODS).join(",")}`,
      );
      console.log(
        `   Slow thresholds: slow=${LOG_SLOW_REQUEST_MS}ms, very_slow=${LOG_VERY_SLOW_REQUEST_MS}ms`,
      );
    }
  } else {
    console.log("🪵 Logging disabled");
  }
  if (hasApiKey && hasProjectId) {
    console.log(`   Using apiKey: configured, project: ${DEFAULT_STITCH_PROJECT_ID}`);
  } else {
    console.log("   STITCH_API_KEY: expect from request headers or .env");
    if (!hasProjectId) {
      console.log(
        "   STITCH_PROJECT_ID: optional — can be set in .env or provided by agents via chat",
      );
    }
  }
  console.log(`💓 Health endpoint: http://localhost:${MCP_SERVER_PORT}/health`);
  if (LOG_VIEWER_ENABLED) {
    console.log(`📋 Log viewer enabled: http://localhost:${MCP_SERVER_PORT}/logs`);
  } else {
    console.log("📋 Log viewer disabled");
  }
  if (METRICS_ENABLED) {
    console.log(`📊 Metrics enabled: http://localhost:${MCP_SERVER_PORT}/metrics`);
  }
  if (RATE_LIMIT_ENABLED) {
    console.log(`🛡️  Rate limiting: ${RATE_LIMIT_MAX_RPS} req/s, burst ${RATE_LIMIT_BURST}`);
  }
  console.log(`⏱️  Request timeout: ${REQUEST_TIMEOUT_MS}ms`);
  console.log(`📦 Max body size: ${MAX_BODY_SIZE_BYTES} bytes`);
  console.log(
    `🔁 Upstream retry: ${UPSTREAM_RETRY_ENABLED ? `enabled (${UPSTREAM_RETRY_ATTEMPTS} attempts, ${UPSTREAM_RETRY_BASE_DELAY_MS}ms base delay)` : "disabled"}`,
  );
  if (LOCAL_FALLBACK_METHODS.size) {
    console.log(`🧩 Local fallbacks: ${Array.from(LOCAL_FALLBACK_METHODS).join(",")}`);
  }
}

// --- Graceful Shutdown ---

function gracefulShutdown(server, signal) {
  if (state.isShuttingDown) {
    return;
  }
  state.isShuttingDown = true;

  console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);

  // Stop accepting new connections
  server.close(() => {
    console.log("✅ Server closed. No longer accepting connections.");
  });

  // Give existing connections time to drain
  const drainStart = Date.now();
  const checkDrain = setInterval(() => {
    const remaining = state.activeConnections.size;
    const elapsed = Date.now() - drainStart;

    if (remaining === 0) {
      clearInterval(checkDrain);
      console.log("✅ All connections drained. Exiting.");
      process.exit(0);
    }

    if (elapsed >= SHUTDOWN_DRAIN_MS) {
      clearInterval(checkDrain);
      console.log(`⚠️  Drain timeout. ${remaining} connections still active. Forcing exit.`);
      process.exit(1);
    }
  }, 500);
}

// --- Entry point -------------------------------------------------------------
// `index.js` must remain runnable as `node index.js` (Docker, systemd, run.sh) while also
// being requireable from tests. `listen()` therefore only happens when this file is the
// process entry point.

const isMainModule = require.main === module;

if (isMainModule) {
  applyConfig();
  logCredentialGuidance();
  const server = createProxyServer();
  server.listen(MCP_SERVER_PORT, MCP_SERVER_HOST, logStartupBanner);

  process.on("SIGTERM", () => gracefulShutdown(server, "SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown(server, "SIGINT"));
}

module.exports = {
  createProxyServer,
  applyConfig,
  getConfig,
  createState,
  getState,
  handleRequest,
  // Exported for tests and for Phase 1+ work; not part of the public HTTP contract.
  buildLocalFallbackResponse: buildLocalFallbackResponseFor,
  validateOrigin: (req, corsOrigin) => evaluateOrigin(req.headers.origin, { corsOrigin }).allowed,
  setCorsHeaders: setCorsHeadersWith,
  parseHostHeader: parseHostHeaderFrom,
  parseAuthHeader,
  parseJsonRpcMetadata,
  extractJsonRpcIds,
  extractProjectIdFromBody,
  isTransientUpstreamError,
  describeFetchError,
  redactHeaders,
  renderPrometheusMetrics,
  readRequestBody,
  checkRateLimit: checkRateLimitFor,
  getClientIp,
  resolveLogFilePath,
  sweepRateLimitBuckets,
  createProxyServerInternals: {
    CONFIG_KEYS,
  },
};
