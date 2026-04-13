const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function loadEnvFile(envPath = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
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

const STITCH_URL = 'https://stitch.googleapis.com/mcp';
const STITCH_API_KEY = process.env.STITCH_API_KEY;
const DEFAULT_STITCH_PROJECT_ID = process.env.STITCH_PROJECT_ID;
const MCP_SERVER_PORT = process.env.MCP_SERVER_PORT || 8787;

if (!STITCH_API_KEY) {
  console.log('⚠️ No API key configured, will use OAuth tokens from gcloud');
  process.exit(1);
} else if (!DEFAULT_STITCH_PROJECT_ID) {
  console.log('⚠️ No default project ID configured, will rely on X-Stitch-Project-Id header or gcloud defaults');
  process.exit(1);
}

function getAccessToken() {
  try {
    return execSync('gcloud auth print-access-token').toString().trim();
  } catch (error) {
    console.error('❌ gcloud auth failed. Run: gcloud auth login');
    process.exit(1);
  }
}

let cachedToken = null;
let lastFetch = 0;

function getCachedToken() {
  const now = Date.now();

  if (!cachedToken || now - lastFetch > 5 * 60 * 1000) {
    cachedToken = getAccessToken();
    lastFetch = now;
    console.log('🔄 Refreshed OAuth token');
  }

  return cachedToken;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    ...headers,
  });
  res.end(text);
}

function buildForwardHeaders(req, token) {
  const projectId = req.headers['x-stitch-project-id'] || DEFAULT_STITCH_PROJECT_ID;

  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(STITCH_API_KEY ? { 'X-Goog-Api-Key': STITCH_API_KEY } : {}),
    'Content-Type': 'application/json',
    Accept: req.headers.accept || 'application/json, text/event-stream',
    ...(projectId ? { 'X-Stitch-Project-Id': projectId } : {}),
  };
}

async function readRequestBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return undefined;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
    return sendJson(res, 200, {
      resource: `http://localhost:${MCP_SERVER_PORT}`,
      authorization_servers: [`http://localhost:${MCP_SERVER_PORT}`],
    });
  }

  if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
    return sendJson(res, 200, {
      issuer: `http://localhost:${MCP_SERVER_PORT}`,
      authorization_endpoint: `http://localhost:${MCP_SERVER_PORT}/auth`,
      token_endpoint: `http://localhost:${MCP_SERVER_PORT}/token`,
    });
  }

  if (req.method === 'GET' && url.pathname === '/auth') {
    return sendText(res, 200, 'OK');
  }

  if (req.method === 'POST' && url.pathname === '/token') {
    return sendJson(res, 200, { access_token: 'local-proxy-token' });
  }

  if (url.pathname === '/mcp') {
    try {
      const token = STITCH_API_KEY ? null : getCachedToken();
      const body = await readRequestBody(req);

      const response = await fetch(STITCH_URL, {
        method: req.method,
        headers: buildForwardHeaders(req, token),
        body,
      });

      const text = await response.text();
      return sendText(res, response.status, text, {
        'Content-Type': response.headers.get('content-type') || 'application/json',
      });
    } catch (error) {
      console.error('❌ Proxy error:', error);
      return sendText(res, 500, error.message || 'Unknown proxy error');
    }
  }

  return sendText(res, 404, 'Not found');
});

server.listen(MCP_SERVER_PORT, () => {
  console.log(
    `🚀 Stitch MCP Proxy, ${STITCH_API_KEY ? 'configured' : 'none'} using PROJECT_ID: ${DEFAULT_STITCH_PROJECT_ID}, is running at:`
  );
  console.log(`👉 http://localhost:${MCP_SERVER_PORT}/mcp`);
});