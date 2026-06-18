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

const STITCH_URL = "https://stitch.googleapis.com/mcp";
const INSTRUCTIONS_PATH = path.resolve(process.cwd(), "INSTRUCTIONS.md");
let STITCH_API_KEY = process.env.STITCH_API_KEY;
let DEFAULT_STITCH_PROJECT_ID = process.env.STITCH_PROJECT_ID;
const MCP_SERVER_PORT = process.env.MCP_SERVER_PORT || 8787;
const LOG_ENABLED = String(process.env.LOG_ENABLED || "false").toLowerCase() === "true";
const LOG_LEVEL = String(process.env.LOG_LEVEL || "info").toLowerCase();
const LOG_DIR = path.resolve(process.cwd(), process.env.LOG_DIR || "logs");
const LOG_FILE_NAME = process.env.LOG_FILE_NAME || "proxy.log";
const LOG_MAX_BODY_CHARS = Number.parseInt(process.env.LOG_MAX_BODY_CHARS || "20000", 10);
const LOG_MAX_FILE_SIZE_BYTES = Number.parseInt(process.env.LOG_MAX_FILE_SIZE_BYTES || "5242880", 10);
const LOG_MAX_ROTATED_FILES = Number.parseInt(process.env.LOG_MAX_ROTATED_FILES || "5", 10);
const LOG_SKIP_MCP_GET = String(process.env.LOG_SKIP_MCP_GET || "true").toLowerCase() === "true";
const LOG_SLOW_REQUEST_MS = Number.parseInt(process.env.LOG_SLOW_REQUEST_MS || "2000", 10);
const LOG_VERY_SLOW_REQUEST_MS = Number.parseInt(process.env.LOG_VERY_SLOW_REQUEST_MS || "5000", 10);
const LOG_SKIP_MCP_METHODS = new Set(
  String(
    process.env.LOG_SKIP_MCP_METHODS ||
      "initialize,notifications/initialized,notifications/progress,ping",
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);

// Log viewer configuration
const LOG_VIEWER_ENABLED =
  String(process.env.LOG_VIEWER_ENABLED || "true").toLowerCase() === "true";
const LOG_VIEWER_MAX_FILE_BYTES = Number.parseInt(
  process.env.LOG_VIEWER_MAX_FILE_BYTES || "10485760",
  10,
);
const LOG_SUMMARY_MAX_LINES = Number.parseInt(
  process.env.LOG_SUMMARY_MAX_LINES || "200",
  10,
);

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
    return { apiKey: null, projectId: null };
  }

  const match = authHeader.match(/^\s*basic\s+(.+)\s*$/i);
  if (!match) {
    return { apiKey: null, projectId: null };
  }

  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex === -1) {
      return { apiKey: null, projectId: null };
    }

    const projectId = decoded.slice(0, separatorIndex);
    const apiKey = decoded.slice(separatorIndex + 1);

    return {
      apiKey: apiKey || null,
      projectId: projectId || null,
    };
  } catch {
    return { apiKey: null, projectId: null };
  }
}

if (!STITCH_API_KEY && !DEFAULT_STITCH_PROJECT_ID) {
  console.log(
    "ℹ️ No credentials in .env. Will accept them from request headers:",
  );
  console.log("   - STITCH_API_KEY: your API key");
  console.log("   - STITCH_PROJECT_ID: your project id");
  console.log("   - gcloud fallback is OFF by default (set ENABLE_GCLOUD_FALLBACK=1)");
}

function getAccessToken() {
  try {
    return execSync("gcloud auth print-access-token").toString().trim();
  } catch (error) {
    const details = error?.stderr?.toString?.().trim() || error.message;
    throw new Error(`gcloud auth failed. ${details}`);
  }
}

let cachedToken = null;
let lastFetch = 0;

function getCachedToken() {
  const now = Date.now();

  if (!cachedToken || now - lastFetch > 5 * 60 * 1000) {
    cachedToken = getAccessToken();
    lastFetch = now;
    console.log("🔄 Refreshed OAuth token");
  }

  return cachedToken;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  res.end(text);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
  });
  res.end(html);
}

function buildForwardHeaders(req, token, apiKey, projectId) {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(apiKey ? { "X-Goog-Api-Key": apiKey } : {}),
    "Content-Type": "application/json",
    Accept: req.headers.accept || "application/json, text/event-stream",
    ...(projectId ? { "X-Stitch-Project-Id": projectId } : {}),
  };
}

async function readRequestBody(req) {
  if (req.method === "GET" || req.method === "HEAD") {
    return undefined;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

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

  if (req.method === "GET" && url.pathname === "/health") {
    const logFilePath = path.join(LOG_DIR, LOG_FILE_NAME);
    const summaryLogExists = fs.existsSync(logFilePath);
    const summaryLogSizeBytes = summaryLogExists ? fs.statSync(logFilePath).size : 0;

    return sendJson(res, 200, {
      status: "ok",
      proxy: {
        port: Number(MCP_SERVER_PORT),
        stitchUrl: STITCH_URL,
      },
      credentials: {
        envApiKeyConfigured: Boolean(STITCH_API_KEY),
        envProjectConfigured: Boolean(DEFAULT_STITCH_PROJECT_ID),
        gcloudFallbackEnabled: process.env.ENABLE_GCLOUD_FALLBACK === "1",
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
      timestamp: new Date().toISOString(),
    });
  }

  if (req.method === "GET" && url.pathname === "/instructions") {
    try {
      const markdown = readInstructionsMarkdown();
      const data = parseInstructionsMarkdown(markdown);
      const accept = req.headers.accept || "";

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
    try {
      // Accept credentials from request headers or fallback to env
      let apiKey = STITCH_API_KEY;
      let projectId = DEFAULT_STITCH_PROJECT_ID;

      if (req.headers["stitch_api_key"]) {
        apiKey = req.headers["stitch_api_key"];
      }
      if (req.headers["stitch_project_id"]) {
        projectId = req.headers["stitch_project_id"];
      }

      if (req.headers["x-stitch-api-key"]) {
        apiKey = req.headers["x-stitch-api-key"];
      }
      if (req.headers["x-stitch-project-id"]) {
        projectId = req.headers["x-stitch-project-id"];
      }

      if (req.headers.authorization) {
        const { apiKey: headerApiKey, projectId: headerProjectId } =
          parseAuthHeader(req.headers.authorization);
        apiKey = headerApiKey || apiKey;
        projectId = headerProjectId || projectId;
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
        return sendText(
          res,
          401,
          "❌ Missing API key. Configure mcp.json headers.STITCH_API_KEY or set STITCH_API_KEY",
        );
      }

      if (!projectId) {
        return sendText(
          res,
          401,
          "❌ Missing project ID. Configure mcp.json headers.STITCH_PROJECT_ID or set STITCH_PROJECT_ID",
        );
      }

      let token = null;
      if (!apiKey && gcloudFallbackEnabled && req.method !== "GET") {
        token = getCachedToken();
      }
      const timestamp = new Date().toISOString();
      const body = await readRequestBody(req);

      const response = await fetch(STITCH_URL, {
        method: req.method,
        headers: buildForwardHeaders(req, token, apiKey, projectId),
        body,
      });

      const text = await response.text();
      const durationMs = Date.now() - requestStartedAt;
      const durationClass = classifyDuration(durationMs);
      const methodSummary = formatMethodsForSummary(body);
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
      return sendText(res, response.status, text, {
        "Content-Type": response.headers.get("content-type") ||
          "application/json",
      });
    } catch (error) {
      console.error("❌ Proxy error:", error);
      const durationMs = Date.now() - requestStartedAt;
      const durationClass = classifyDuration(durationMs);
      appendSummaryLog(
        `${new Date().toISOString()} - ID: ${requestLogId} - ${req.method} ${req.url} - STATUS: 500 - DURATION_MS: ${durationMs} - LATENCY: ${durationClass} - ERROR: ${error.message || "Unknown proxy error"}\n`,
      );
      writeDetailedDebugLog({
        requestLogId,
        timestamp: new Date().toISOString(),
        req,
        url,
        projectId: req.headers["stitch_project_id"] || req.headers["x-stitch-project-id"] || DEFAULT_STITCH_PROJECT_ID,
        requestBody: undefined,
        requestContentType: req.headers["content-type"],
        durationMs,
        durationClass,
        responseStatus: 500,
        responseHeaders: {},
        responseBody: "",
        error,
      });
      return sendText(res, 500, error.message || "Unknown proxy error");
    }
  }

  return sendText(res, 404, "Not found");
});

server.listen(MCP_SERVER_PORT, () => {
  const hasEnvConfig = STITCH_API_KEY && DEFAULT_STITCH_PROJECT_ID;
  console.log(
    `🚀 Stitch MCP Proxy (${hasEnvConfig ? "env-configured" : "header-based"}) running at:`,
  );
  console.log(`👉 http://localhost:${MCP_SERVER_PORT}/mcp`);
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
  if (hasEnvConfig) {
    console.log(`   Using project: ${DEFAULT_STITCH_PROJECT_ID}`);
  } else {
    console.log(
      "   Waiting for STITCH_API_KEY/STITCH_PROJECT_ID headers",
    );
  }
  console.log(`💓 Health endpoint: http://localhost:${MCP_SERVER_PORT}/health`);
  if (LOG_VIEWER_ENABLED) {
    console.log(`📋 Log viewer enabled: http://localhost:${MCP_SERVER_PORT}/logs`);
  } else {
    console.log("📋 Log viewer disabled");
  }
});
