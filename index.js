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
let STITCH_API_KEY = process.env.STITCH_API_KEY;
let DEFAULT_STITCH_PROJECT_ID = process.env.STITCH_PROJECT_ID;
const MCP_SERVER_PORT = process.env.MCP_SERVER_PORT || 8787;

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
