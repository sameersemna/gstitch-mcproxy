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

  if (url.pathname === "/mcp") {
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
      // add logs to ./logs folder for any requests to /mcp for debugging
      const logEntry = `${
        new Date().toISOString()
      } - ${req.method} ${req.url} - API_KEY: ${
        apiKey ? "configured" : "none"
      } - PROJECT_ID: ${projectId || "none"}\n`;
      fs.appendFile(
        path.resolve(process.cwd(), "logs", "proxy.log"),
        logEntry,
        (err) => {
          if (err) {
            console.error("❌ Failed to write log:", err);
          }
        },
      );

      let token = null;
      if (!apiKey && gcloudFallbackEnabled && req.method !== "GET") {
        token = getCachedToken();
      }
      const body = await readRequestBody(req);

      const response = await fetch(STITCH_URL, {
        method: req.method,
        headers: buildForwardHeaders(req, token, apiKey, projectId),
        body,
      });

      const text = await response.text();
      return sendText(res, response.status, text, {
        "Content-Type": response.headers.get("content-type") ||
          "application/json",
      });
    } catch (error) {
      console.error("❌ Proxy error:", error);
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
  if (hasEnvConfig) {
    console.log(`   Using project: ${DEFAULT_STITCH_PROJECT_ID}`);
  } else {
    console.log(
      "   Waiting for STITCH_API_KEY/STITCH_PROJECT_ID headers",
    );
  }
});
