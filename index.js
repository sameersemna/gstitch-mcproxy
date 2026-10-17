const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

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

function parseBoolean(value, fallback) {
  return String(value === undefined || value === null ? fallback : value).toLowerCase() === "true";
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value === undefined || value === null ? String(fallback) : String(value), 10);
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

  define("STITCH_URL", () => STITCH_URL, (v) => (STITCH_URL = v));
  define("STITCH_API_KEY", () => STITCH_API_KEY, (v) => (STITCH_API_KEY = v));
  define(
    "DEFAULT_STITCH_PROJECT_ID",
    () => DEFAULT_STITCH_PROJECT_ID,
    (v) => (DEFAULT_STITCH_PROJECT_ID = v),
  );
  define("MCP_SERVER_PORT", () => MCP_SERVER_PORT, (v) => (MCP_SERVER_PORT = v));
  define("MCP_SERVER_HOST", () => MCP_SERVER_HOST, (v) => (MCP_SERVER_HOST = v));
  define("LOG_ENABLED", () => LOG_ENABLED, (v) => (LOG_ENABLED = v));
  define("LOG_LEVEL", () => LOG_LEVEL, (v) => (LOG_LEVEL = v));
  define("LOG_DIR", () => LOG_DIR, (v) => (LOG_DIR = v));
  define("LOG_FILE_NAME", () => LOG_FILE_NAME, (v) => (LOG_FILE_NAME = v));
  define("LOG_MAX_BODY_CHARS", () => LOG_MAX_BODY_CHARS, (v) => (LOG_MAX_BODY_CHARS = v));
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
  define("LOG_SKIP_MCP_GET", () => LOG_SKIP_MCP_GET, (v) => (LOG_SKIP_MCP_GET = v));
  define("LOG_SLOW_REQUEST_MS", () => LOG_SLOW_REQUEST_MS, (v) => (LOG_SLOW_REQUEST_MS = v));
  define(
    "LOG_VERY_SLOW_REQUEST_MS",
    () => LOG_VERY_SLOW_REQUEST_MS,
    (v) => (LOG_VERY_SLOW_REQUEST_MS = v),
  );
  define("LOG_SKIP_MCP_METHODS", () => LOG_SKIP_MCP_METHODS, (v) => (LOG_SKIP_MCP_METHODS = v));
  define("REQUEST_TIMEOUT_MS", () => REQUEST_TIMEOUT_MS, (v) => (REQUEST_TIMEOUT_MS = v));
  define("MAX_BODY_SIZE_BYTES", () => MAX_BODY_SIZE_BYTES, (v) => (MAX_BODY_SIZE_BYTES = v));
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
  define("RATE_LIMIT_ENABLED", () => RATE_LIMIT_ENABLED, (v) => (RATE_LIMIT_ENABLED = v));
  define("RATE_LIMIT_MAX_RPS", () => RATE_LIMIT_MAX_RPS, (v) => (RATE_LIMIT_MAX_RPS = v));
  define("RATE_LIMIT_BURST", () => RATE_LIMIT_BURST, (v) => (RATE_LIMIT_BURST = v));
  define("CORS_ORIGIN", () => CORS_ORIGIN, (v) => (CORS_ORIGIN = v));
  define("METRICS_ENABLED", () => METRICS_ENABLED, (v) => (METRICS_ENABLED = v));
  define("SHUTDOWN_DRAIN_MS", () => SHUTDOWN_DRAIN_MS, (v) => (SHUTDOWN_DRAIN_MS = v));
  define("LOG_VIEWER_ENABLED", () => LOG_VIEWER_ENABLED, (v) => (LOG_VIEWER_ENABLED = v));
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
    RATE_LIMIT_ENABLED: parseBoolean(env.RATE_LIMIT_ENABLED, "false"),
    RATE_LIMIT_MAX_RPS: parseInteger(env.RATE_LIMIT_MAX_RPS, 10),
    RATE_LIMIT_BURST: parseInteger(env.RATE_LIMIT_BURST, 20),

    // --- CORS ---
    CORS_ORIGIN: env.CORS_ORIGIN || "*",

    // --- Metrics ---
    METRICS_ENABLED: parseBoolean(env.METRICS_ENABLED, "true"),

    // --- Graceful shutdown ---
    SHUTDOWN_DRAIN_MS: parseInteger(env.SHUTDOWN_DRAIN_MS, 15000),

    // Log viewer configuration
    LOG_VIEWER_ENABLED: parseBoolean(env.LOG_VIEWER_ENABLED, "true"),
    LOG_VIEWER_MAX_FILE_BYTES: parseInteger(env.LOG_VIEWER_MAX_FILE_BYTES, 10485760),
    LOG_SUMMARY_MAX_LINES: parseInteger(env.LOG_SUMMARY_MAX_LINES, 200),
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatInlineMarkdown(text) {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
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

function parseJsonRpcMetadata(body) {
  if (!body || typeof body !== "string") {
    return { methods: [], ids: [] };
  }

  try {
    const parsed = JSON.parse(body);
    const messages = Array.isArray(parsed) ? parsed : [parsed];

    return {
      methods: messages
        .map((message) => message?.method)
        .filter((method) => typeof method === "string" && method.length > 0),
      ids: messages
        .map((message) => message?.id)
        .filter((id) => id !== undefined && id !== null),
    };
  } catch {
    return { methods: [], ids: [] };
  }
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

// Node's fetch() collapses every transport failure into `TypeError: fetch failed`
// and hides the real reason in `error.cause`. Surface it so logs are actionable.
function describeFetchError(error) {
  if (!error) {
    return "Unknown error";
  }

  const cause = error.cause;
  const causeCode = cause && (cause.code || cause.errno);
  const causeMessage = cause && cause.message;

  if (causeCode || causeMessage) {
    return `${error.message || error.name} (${causeCode || causeMessage})`;
  }

  return error.message || error.name || String(error);
}

// Transient failures are worth retrying: HTTP/2 stream resets, socket hangups,
// DNS blips and connection resets. Timeouts and 4xx/5xx responses are not.
function isTransientUpstreamError(error) {
  if (!error) {
    return false;
  }

  if (error.name === "AbortError" || error.name === "TimeoutError") {
    return false;
  }

  const cause = error.cause || {};
  const code = cause.code || cause.errno || "";
  const message = `${error.message || ""} ${cause.message || ""}`;

  const transientCodes = [
    "ERR_HTTP2_STREAM_ERROR",
    "ERR_HTTP2_STREAM_CANCEL",
    "ERR_HTTP2_GOAWAY_SESSION",
    "ERR_HTTP2_SESSION_ERROR",
    "ERR_HTTP2_INVALID_SESSION",
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENETUNREACH",
    "ENETDOWN",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
  ];

  if (transientCodes.includes(code)) {
    return true;
  }

  return /socket hang up|other side closed|stream closed|connection reset|fetch failed/i.test(
    message,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Local fallbacks for methods Stitch does not implement ---

// Returns a JSON-RPC response object when the request can be answered locally,
// or null when it must be forwarded upstream.
function buildLocalFallbackResponse(requestBody) {
  if (!requestBody || !LOCAL_FALLBACK_METHODS.size) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(requestBody);
  } catch {
    return null;
  }

  // Only handle single (non-batched) requests.
  if (Array.isArray(parsed) || !parsed || typeof parsed !== "object") {
    return null;
  }

  const { method, id } = parsed;
  if (typeof method !== "string" || !LOCAL_FALLBACK_METHODS.has(method)) {
    return null;
  }

  // Notifications (no id) are acknowledged with 202 and no body.
  if (id === undefined || id === null) {
    return { notification: true };
  }

  const emptyResults = {
    "prompts/list": { prompts: [] },
    "resources/list": { resources: [] },
    "resources/templates/list": { resourceTemplates: [] },
  };

  const result = emptyResults[method];
  if (!result) {
    return null;
  }

  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

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
    metrics: {
      requestsTotal: 0,
      requestsByMethod: {},
      requestsByStatus: {},
      latencyBuckets: { 100: 0, 500: 0, 1000: 0, 5000: 0, 30000: 0, 120000: 0, Infinity: 0 },
      latencySumSeconds: 0,
      errorsTotal: 0,
      activeConnections: 0,
      rateLimitedTotal: 0,
      startTime: Date.now(),
    },
    activeConnections: new Set(),
    tokenCache: { value: null, fetchedAt: 0 },
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

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function checkRateLimit(clientIp) {
  const rateLimitBuckets = state.rateLimitBuckets;

  if (!RATE_LIMIT_ENABLED) {
    return { allowed: true };
  }

  const now = Date.now();
  let bucket = rateLimitBuckets.get(clientIp);

  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_BURST, lastRefill: now };
    rateLimitBuckets.set(clientIp, bucket);
  }

  // Refill tokens
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(RATE_LIMIT_BURST, bucket.tokens + elapsed * RATE_LIMIT_MAX_RPS);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true };
  }

  return { allowed: false, retryAfter: Math.ceil(1 / RATE_LIMIT_MAX_RPS) };
}

// Clean up stale rate limit entries every 5 minutes.
// NOTE: this interval closes over the *current* `state`, which is the state of the most
// recently created proxy instance. Phase 2 moves the sweep onto the instance so that two
// proxies in one process each sweep their own buckets.
setInterval(() => {
  const now = Date.now();
  const buckets = state.rateLimitBuckets;
  for (const [ip, bucket] of buckets) {
    if (now - bucket.lastRefill > 300000) {
      buckets.delete(ip);
    }
  }
}, 300000).unref();

function recordMetrics({ method, path, status, durationMs, isError }) {
  const metrics = state.metrics;

  metrics.requestsTotal += 1;

  const methodKey = `${method} ${path}`;
  metrics.requestsByMethod[methodKey] = (metrics.requestsByMethod[methodKey] || 0) + 1;

  const statusKey = String(status);
  metrics.requestsByStatus[statusKey] = (metrics.requestsByStatus[statusKey] || 0) + 1;

  for (const boundary of Object.keys(metrics.latencyBuckets)) {
    if (durationMs <= Number(boundary)) {
      metrics.latencyBuckets[boundary] += 1;
      break;
    }
  }

  metrics.latencySumSeconds += durationMs / 1000;

  if (isError) {
    metrics.errorsTotal += 1;
  }
}

function renderPrometheusMetrics() {
  const metrics = state.metrics;
  const uptime = (Date.now() - metrics.startTime) / 1000;
  const lines = [
    "# HELP gstitch_proxy_uptime_seconds Proxy uptime in seconds",
    "# TYPE gstitch_proxy_uptime_seconds gauge",
    `gstitch_proxy_uptime_seconds ${uptime}`,
    "",
    "# HELP gstitch_proxy_requests_total Total number of requests",
    "# TYPE gstitch_proxy_requests_total counter",
    `gstitch_proxy_requests_total ${metrics.requestsTotal}`,
    "",
    "# HELP gstitch_proxy_errors_total Total number of errors",
    "# TYPE gstitch_proxy_errors_total counter",
    `gstitch_proxy_errors_total ${metrics.errorsTotal}`,
    "",
    "# HELP gstitch_proxy_active_connections Current active connections",
    "# TYPE gstitch_proxy_active_connections gauge",
    `gstitch_proxy_active_connections ${metrics.activeConnections}`,
    "",
    "# HELP gstitch_proxy_rate_limited_total Total rate-limited requests",
    "# TYPE gstitch_proxy_rate_limited_total counter",
    `gstitch_proxy_rate_limited_total ${metrics.rateLimitedTotal}`,
    "",
    "# HELP gstitch_proxy_requests_by_method Requests by HTTP method and path",
    "# TYPE gstitch_proxy_requests_by_method counter",
  ];

  for (const [key, value] of Object.entries(metrics.requestsByMethod)) {
    lines.push(`gstitch_proxy_requests_by_method{method_path="${key}"} ${value}`);
  }

  lines.push(
    "",
    "# HELP gstitch_proxy_requests_by_status Requests by HTTP status code",
    "# TYPE gstitch_proxy_requests_by_status counter",
  );

  for (const [key, value] of Object.entries(metrics.requestsByStatus)) {
    lines.push(`gstitch_proxy_requests_by_status{status="${key}"} ${value}`);
  }

  lines.push(
    "",
    "# HELP gstitch_proxy_latency_seconds Request latency histogram",
    "# TYPE gstitch_proxy_latency_seconds histogram",
  );

  let cumulative = 0;
  for (const [boundary, count] of Object.entries(metrics.latencyBuckets)) {
    cumulative += count;
    const le = boundary === "Infinity" ? "+Inf" : (Number(boundary) / 1000).toFixed(3);
    lines.push(`gstitch_proxy_latency_seconds_bucket{le="${le}"} ${cumulative}`);
  }

  lines.push(
    `gstitch_proxy_latency_seconds_count ${metrics.requestsTotal}`,
    `gstitch_proxy_latency_seconds_sum ${metrics.latencySumSeconds.toFixed(3)}`,
    "",
  );

  return lines.join("\n") + "\n";
}

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

function redactHeaders(headers) {
  const redactedHeaders = {};

  for (const [key, value] of Object.entries(headers || {})) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes("authorization") ||
      lowerKey.includes("api-key") ||
      lowerKey === "stitch_api_key" ||
      lowerKey === "x-goog-api-key"
    ) {
      redactedHeaders[key] = "[redacted]";
      continue;
    }

    redactedHeaders[key] = value;
  }

  return redactedHeaders;
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
      `query: ${url.search || ""}`,
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
      ...(error
        ? [
          "",
          "error:",
          error.stack || error.message || String(error),
        ]
        : []),
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
        if (nextTrimmed.startsWith("*") || nextTrimmed.startsWith("### ") || nextTrimmed.startsWith("# ") || nextTrimmed === "---") {
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

  const usageMapping = Array.from(
    markdown.matchAll(/^\|\s*(.*?)\s*\|\s*(.*?)\s*\|$/gm),
  )
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
  const sectionCards = data.sections.map((section) => `
    <section class="card">
      <h2>${escapeHtml(section.title)}</h2>
      <div class="tool-grid">
        ${section.items.map((item) => `
          <article class="tool-item">
            <h3>${escapeHtml(item.name)}</h3>
            <p>${formatInlineMarkdown(item.description)}</p>
          </article>
        `).join("")}
      </div>
    </section>
  `).join("");

  const mappingRows = data.usageMapping.map((row) => `
    <tr>
      <td>${escapeHtml(row.goal)}</td>
      <td><code>${escapeHtml(row.tool)}</code></td>
    </tr>
  `).join("");

  const observationItems = data.observations.map((item) => `
    <li>${formatInlineMarkdown(item)}</li>
  `).join("");

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
function sendJson(res, statusCode, payload, options = {}) {
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
    ...(options.headers || {}),
  };

  res.writeHead(statusCode, headers);
  res.end(options.head ? undefined : body);
}

/**
 * @param {import("http").ServerResponse} res
 * @param {number} statusCode
 * @param {string} text
 * @param {Record<string, string>} [headers]
 * @param {{ head?: boolean }} [options]
 */
function sendText(res, statusCode, text, headers = {}, options = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  res.end(options.head ? undefined : text);
}

/**
 * @param {import("http").ServerResponse} res
 * @param {number} statusCode
 * @param {string} html
 * @param {{ head?: boolean }} [options]
 */
function sendHtml(res, statusCode, html, options = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
  });
  res.end(options.head ? undefined : html);
}

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

/**
 * Resolves the Stitch project ID a request actually operates on, for **log attribution**.
 *
 * Finding ★N5: the debug and summary logs were keyed on `DEFAULT_STITCH_PROJECT_ID` (the env
 * default) and never looked at the ID in the tool arguments, so almost every request landed in
 * `logs/unknown-project/` and the log viewer was useless for per-project debugging.
 *
 * Note this deliberately does **not** feed the upstream `X-Stitch-Project-Id` header: supplying
 * the project ID via headers was deprecated in commit c125891, and the upstream header source
 * stays unchanged.
 *
 * @param {string|undefined|null} body
 * @returns {string|null} the project ID from the arguments, or null when absent
 */
function extractProjectIdFromBody(body) {
  if (!body || typeof body !== "string") {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];

  for (const message of messages) {
    const args = message?.params?.arguments;
    if (!args || typeof args !== "object") {
      continue;
    }

    // `projectId` is Stitch's spelling; accept `project_id` defensively for hand-written calls.
    for (const key of ["projectId", "project_id"]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }

  return null;
}

/**
 * Extracts the JSON-RPC `id`(s) from a request body so that error responses can echo them.
 *
 * Finding P2: every error path used to hard-code `id: null`, so a client waiting on request
 * id N might never resolve its pending call. For a batch, the result is an array of the ids
 * that were present, and the caller emits one error object per id.
 *
 * Returns `null` when nothing usable can be recovered, which is the correct JSON-RPC answer
 * for an unparseable request.
 *
 * @param {string|undefined|null} body
 * @returns {any} a single id, `null`, or an array of ids
 */
function extractJsonRpcIds(body) {
  if (!body || typeof body !== "string") {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  if (Array.isArray(parsed)) {
    const ids = parsed
      .map((message) => (message && typeof message === "object" ? message.id : undefined))
      .filter((id) => id !== undefined && id !== null);
    return ids.length ? ids : null;
  }

  if (parsed && typeof parsed === "object" && parsed.id !== undefined && parsed.id !== null) {
    return parsed.id;
  }

  return null;
}

// --- CORS Helper ---

function setCorsHeaders(res, req) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN === "*" ? "*" : origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, STITCH_API_KEY, X-Stitch-Api-Key, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// --- Origin Validation (MCP Spec 2026-07-28) ---

function validateOrigin(req) {
  // Only validate for /mcp endpoint per MCP spec
  if (!req.url.startsWith("/mcp")) {
    return true;
  }

  const origin = req.headers.origin;
  if (!origin) {
    return true; // No origin header is acceptable for non-browser clients
  }

  // For localhost, allow any localhost origin
  if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
    return true;
  }

  // If CORS_ORIGIN is set to a specific value, validate against it
  if (CORS_ORIGIN !== "*") {
    return origin === CORS_ORIGIN;
  }

  return true;
}

// --- Host safety -------------------------------------------------------------

/**
 * Parses the `Host` request header without ever throwing.
 *
 * Why this exists (finding ★C2): the baseline built the request URL as
 * `new URL(req.url, \`http://${req.headers.host}\`)`. A malformed `Host` (for example
 * `Host: [bad`) made the `URL` constructor throw `ERR_INVALID_URL` inside an `async`
 * handler, outside any `try`/`catch`. The resulting unhandled rejection terminated the
 * process, so anyone able to reach the port could kill the proxy with a single packet.
 *
 * The routing code only ever reads `url.pathname` and `url.searchParams`, never the host,
 * so the URL is now built from a constant base and the `Host` header is validated here,
 * on its own terms.
 *
 * Policy note: this function only rejects values that are *not valid hosts*. Which hosts
 * are *acceptable* (the allow-list that prevents DNS rebinding) is the security model
 * owned by Phase 5 and deliberately not changed here.
 *
 * @param {import("http").IncomingMessage} req
 * @returns {{ host: string|null, reason: string|null }} `reason` is non-null when the header
 *   is malformed; `host` is null when the request legitimately has no `Host` (HTTP/1.0).
 */
function parseHostHeader(req) {
  const rawHost = req.headers.host;

  // HTTP/1.0 clients may omit `Host`. Node accepts such requests, and so do we.
  if (rawHost === undefined || rawHost === null || rawHost === "") {
    return { host: null, reason: null };
  }

  if (Array.isArray(rawHost)) {
    return { host: null, reason: "duplicate Host header" };
  }

  const value = String(rawHost).trim();
  if (!value) {
    return { host: null, reason: null };
  }

  // A host name, optionally followed by a port; bracketed IPv6 literals are allowed.
  // Anything with whitespace, slashes or brackets in the wrong place is rejected.
  if (/[\s/\\@?#]/.test(value)) {
    return { host: null, reason: "Host header contains illegal characters" };
  }

  let parsed;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    return { host: null, reason: "Host header is not a valid authority" };
  }

  if (!parsed.hostname) {
    return { host: null, reason: "Host header has an empty host name" };
  }

  if (parsed.port !== "") {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { host: null, reason: "Host header has an out-of-range port" };
    }
  }

  // `URL` silently rewrites some inputs (for example `[bad` throws, but `a b` would be
  // escaped). Compare the round-trip so a rewritten value is treated as invalid.
  if (parsed.host.toLowerCase() !== value.toLowerCase()) {
    return { host: null, reason: "Host header was rewritten while parsing" };
  }

  return { host: parsed.host, reason: null };
}

/**
 * Builds an id-aware JSON-RPC error response and sends it.
 *
 * The `id` is either a single id, `null`, or — for a batch — an array of per-request error
 * objects. Every error path in the proxy funnels through here so that a client waiting on
 * request id N always has its pending call resolved.
 *
 * @param {import("http").ServerResponse} res
 * @param {number} statusCode
 * @param {number} code
 * @param {string} message
 * @param {any} [id]
 * @param {Record<string, string>} [headers]
 */
function sendJsonRpcError(res, statusCode, code, message, id = null, headers = {}) {
  if (res.headersSent || res.writableEnded) {
    return;
  }

  const payload = Array.isArray(id)
    ? id.map((entry) => ({ jsonrpc: "2.0", error: { code, message }, id: entry }))
    : { jsonrpc: "2.0", error: { code, message }, id };
  const body = JSON.stringify(payload);

  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
    ...headers,
  });
  res.end(body);
}

async function routeRequest(req, res) {
  // Track connection for graceful shutdown
  trackConnection(req.socket);

  // Set CORS headers on all responses
  setCorsHeaders(res, req);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");

  // --- Host validation (finding ★C2) ---
  // Never build the URL from the Host header: a malformed value must not be able to throw.
  const hostCheck = parseHostHeader(req);
  if (hostCheck.reason !== null) {
    recordMetrics({
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

  const isHead = req.method === "HEAD";

  // --- Metrics endpoint ---
  if (METRICS_ENABLED && (req.method === "GET" || isHead) && url.pathname === "/metrics") {
    const body = renderPrometheusMetrics();
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(body)),
    });
    return res.end(isHead ? undefined : body);
  }

  if (
    req.method === "GET" &&
    url.pathname === "/.well-known/oauth-protected-resource"
  ) {
    return sendJson(res, 200, {
      resource: `http://localhost:${MCP_SERVER_PORT}`,
      authorization_servers: [`http://localhost:${MCP_SERVER_PORT}`],
    });
  }

  if (
    req.method === "GET" && url.pathname === "/.well-known/openid-configuration"
  ) {
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

      return sendHtml(res, 200, renderInstructionsHtml(data));
    } catch (error) {
      return sendJson(res, 500, {
        error: "Failed to load instructions",
        details: error.message,
      });
    }
  }

  // --- Log Viewer Endpoints ---

  if (!LOG_VIEWER_ENABLED && url.pathname.startsWith("/logs")) {
    return sendJson(res, 404, { error: "Log viewer is disabled" });
  }

  if (req.method === "GET" && url.pathname === "/logs") {
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
    const limit = Number.parseInt(url.searchParams.get("limit") || String(LOG_SUMMARY_MAX_LINES), 10);
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

    // --- Method guard (MCP Streamable HTTP spec) ---
    // Stitch only implements POST. Forwarding GET/DELETE/PUT upstream returns a
    // Google HTML 405 error page, which is not a valid MCP response and makes
    // clients log confusing parse errors. Answer these locally instead.
    if (req.method !== "POST") {
      const durationMs = Date.now() - requestStartedAt;

      if (req.method === "GET") {
        // Spec: a server that offers no SSE stream MUST return 405 Method Not Allowed.
        recordMetrics({ method: req.method, path: url.pathname, status: 405, durationMs, isError: false });
        appendSummaryLog(
          `${new Date().toISOString()} - ID: ${requestLogId} - GET /mcp - STATUS: 405 - DURATION_MS: ${durationMs} - LATENCY: ${classifyDuration(durationMs)} - NOTE: no SSE stream offered\n`,
        );
        res.setHeader("Allow", "POST, OPTIONS");
        return sendJson(res, 405, {
          jsonrpc: "2.0",
          error: { code: -32005, message: "Method Not Allowed: this endpoint does not offer an SSE stream" },
          id: null,
        });
      }

      if (req.method === "DELETE") {
        // Spec: a server MAY return 405 to indicate it does not allow session termination.
        recordMetrics({ method: req.method, path: url.pathname, status: 405, durationMs, isError: false });
        appendSummaryLog(
          `${new Date().toISOString()} - ID: ${requestLogId} - DELETE /mcp - STATUS: 405 - DURATION_MS: ${durationMs} - LATENCY: ${classifyDuration(durationMs)} - NOTE: stateless, no session to terminate\n`,
        );
        res.setHeader("Allow", "POST, OPTIONS");
        return sendJson(res, 405, {
          jsonrpc: "2.0",
          error: { code: -32005, message: "Method Not Allowed: this server is stateless and has no session to terminate" },
          id: null,
        });
      }

      recordMetrics({ method: req.method, path: url.pathname, status: 405, durationMs, isError: false });
      appendSummaryLog(
        `${new Date().toISOString()} - ID: ${requestLogId} - ${req.method} /mcp - STATUS: 405 - DURATION_MS: ${durationMs} - LATENCY: ${classifyDuration(durationMs)}\n`,
      );
      res.setHeader("Allow", "POST, OPTIONS");
      return sendJson(res, 405, {
        jsonrpc: "2.0",
        error: { code: -32005, message: `Method Not Allowed: ${req.method} is not supported on /mcp` },
        id: null,
      });
    }

    // --- Origin validation (MCP spec requirement) ---
    if (!validateOrigin(req)) {
      state.metrics.rateLimitedTotal += 1;
      // The spec explicitly permits a JSON-RPC error *without* an id for a rejected Origin.
      return sendJsonRpcError(res, 403, -32001, "Invalid Origin header", null);
    }

    // --- Rate limiting ---
    const clientIp = getClientIp(req);
    const rateLimitResult = checkRateLimit(clientIp);
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
        recordMetrics({
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

      // For security, do not allow API key in query params or body, only header or env var
      if (
        req.url.includes("stitch.googleapis.com") &&
        (req.url.includes("key=") || req.url.includes("api_key="))
      ) {
        console.warn("⚠️ API key should not be sent in query parameters");
      }

      const gcloudFallbackEnabled = process.env.ENABLE_GCLOUD_FALLBACK === "1";

      if (!apiKey && !gcloudFallbackEnabled) {
        recordMetrics({
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

      // --- Local fallback for methods Stitch does not implement ---
      // Avoids the upstream HTTP/2 stream reset that clients see as "fetch failed".
      const localFallback = buildLocalFallbackResponse(body);
      if (localFallback) {
        const durationMs = Date.now() - requestStartedAt;
        const durationClass = classifyDuration(durationMs);
        const methodSummary = formatMethodsForSummary(body);

        if (localFallback.notification) {
          recordMetrics({ method: req.method, path: url.pathname, status: 202, durationMs, isError: false });
          appendSummaryLog(
            `${timestamp} - ID: ${requestLogId} - ${req.method} ${req.url} - RPC: ${methodSummary} - API_KEY: ${
              apiKey ? "configured" : "none"
            } - PROJECT_ID: ${projectId || "none"} - STATUS: 202 - DURATION_MS: ${durationMs} - LATENCY: ${durationClass} - LOCAL_FALLBACK: true\n`,
          );
          res.writeHead(202);
          return res.end();
        }

        const fallbackBody = JSON.stringify(localFallback);
        recordMetrics({ method: req.method, path: url.pathname, status: 200, durationMs, isError: false });
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
      const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      // Abort the upstream request if the client goes away, so we stop paying for
      // work nobody is waiting for. The listener stays attached for the whole
      // request so a late disconnect is still detected.
      let upstreamInFlight = false;
      const onClientClose = () => {
        if (!res.writableEnded) {
          clientDisconnected = true;
          if (upstreamInFlight) {
            controller.abort();
          }
        }
      };
      res.on("close", onClientClose);

      let response;
      let lastError;
      const maxAttempts = UPSTREAM_RETRY_ENABLED ? Math.max(1, UPSTREAM_RETRY_ATTEMPTS) : 1;

      try {
        upstreamInFlight = true;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            response = await fetch(STITCH_URL, {
              method: req.method,
              headers: buildForwardHeaders(req, token, apiKey, upstreamProjectId),
              body,
              signal: controller.signal,
            });
            lastError = undefined;
            break;
          } catch (fetchError) {
            lastError = fetchError;

            const canRetry =
              attempt < maxAttempts &&
              !timedOut &&
              !clientDisconnected &&
              isTransientUpstreamError(fetchError);

            if (!canRetry) {
              throw fetchError;
            }

            const delayMs = UPSTREAM_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
            console.warn(
              `⚠️ Upstream attempt ${attempt}/${maxAttempts} failed (${describeFetchError(fetchError)}). Retrying in ${delayMs}ms...`,
            );
            await sleep(delayMs);
          }
        }
      } finally {
        upstreamInFlight = false;
        clearTimeout(timeoutId);
      }

      if (!response) {
        throw lastError || new Error("Upstream request failed");
      }

      const contentType = response.headers.get("content-type") || "";
      const isStreamingResponse =
        contentType.includes("text/event-stream") ||
        contentType.includes("application/x-ndjson");

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

        const streamChunks = [];
        try {
          for await (const chunk of response.body) {
            if (clientDisconnected || res.writableEnded) {
              break;
            }
            res.write(chunk);
            streamChunks.push(chunk);
          }
          if (!res.writableEnded) {
            res.end();
          }
        } catch (streamError) {
          if (!res.writableEnded) {
            res.end();
          }
          throw streamError;
        }

        const durationMs = Date.now() - requestStartedAt;
        const durationClass = classifyDuration(durationMs);
        const methodSummary = formatMethodsForSummary(body);
        const fullResponseBody = Buffer.concat(streamChunks).toString("utf8");

        recordMetrics({
          method: req.method,
          path: url.pathname,
          status: response.status,
          durationMs,
          isError: response.status >= 500,
        });

        if (!(req.method === "GET" && LOG_SKIP_MCP_GET)) {
          appendSummaryLog(
            `${timestamp} - ID: ${requestLogId} - ${req.method} ${req.url} - RPC: ${methodSummary} - API_KEY: ${
              apiKey ? "configured" : "none"
            } - PROJECT_ID: ${projectId || "none"} - STATUS: ${response.status} - DURATION_MS: ${durationMs} - LATENCY: ${durationClass} - STREAM: true\n`,
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
          responseBody: fullResponseBody,
        });

        // Finding ★C5: without this `return` control fell through to the trailing
        // `sendJson(res, 404, ...)`, which threw `ERR_HTTP_HEADERS_SENT`. That unhandled
        // rejection terminated the process, so the *first* streamed Stitch response killed
        // the proxy. The response has already been fully written above.
        return;
      } else {
        // Non-streaming: buffer and send
        const text = await response.text();
        const durationMs = Date.now() - requestStartedAt;
        const durationClass = classifyDuration(durationMs);
        const methodSummary = formatMethodsForSummary(body);

        recordMetrics({
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

      // Client went away mid-flight: nothing to respond to, just record it.
      if (clientDisconnected && !res.writableEnded) {
        console.warn(`⚠️ Client disconnected before upstream responded (${errorDetail})`);
        recordMetrics({
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

      recordMetrics({
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

  return sendJsonRpcError(
    res,
    404,
    -32601,
    `Not found: ${req.method} ${url.pathname}`,
    null,
  );
}

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
      console.error("❌ Failed to send the internal-error response:", describeFetchError(sendError));
      res.destroy();
    }
  }
}

// --- Server factory ----------------------------------------------------------

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

  const server = http.createServer((req, res) => {
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

  // NOTE: explicit `requestTimeout` / `headersTimeout` / `keepAliveTimeout` values and a
  // concurrency cap belong to finding ★S6 (Phase 4). Only `clientError` handling, which is
  // part of crash-proofing, is done here.

  // Expose the instance state for tests and graceful shutdown without widening the
  // `http.Server` type for every consumer.
  /** @type {any} */ (server).state = state;
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
    console.log(
      `🪵 Logging enabled (${LOG_LEVEL}) -> ${path.join(LOG_DIR, LOG_FILE_NAME)}`,
    );
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
    console.log(
      "   STITCH_API_KEY: expect from request headers or .env",
    );
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
  buildLocalFallbackResponse,
  validateOrigin,
  setCorsHeaders,
  parseAuthHeader,
  parseJsonRpcMetadata,
  isTransientUpstreamError,
  describeFetchError,
  redactHeaders,
  renderPrometheusMetrics,
  readRequestBody,
  checkRateLimit,
  getClientIp,
  resolveLogFilePath,
  createProxyServerInternals: {
    CONFIG_KEYS,
  },
};
