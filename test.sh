#!/bin/bash

set -euo pipefail

# Load environment variables from .env if present
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

MCP_SERVER_PORT=${MCP_SERVER_PORT:-8787}
MCP_SERVER_HOST=${MCP_SERVER_HOST:-localhost}
MCP_SERVER_URL="http://${MCP_SERVER_HOST}:${MCP_SERVER_PORT}"
STITCH_PROJECT_ID=${STITCH_PROJECT_ID:-}
STITCH_API_KEY=${STITCH_API_KEY:-}

echo "Testing MCP server at ${MCP_SERVER_URL} with API key ${STITCH_API_KEY} and project ID ${STITCH_PROJECT_ID}"

if [ -z "${STITCH_API_KEY}" ] || [ -z "${STITCH_PROJECT_ID}" ]; then
  echo "Missing STITCH_API_KEY or STITCH_PROJECT_ID in environment/.env"
  exit 1
fi

echo "1) Well-known check"
curl -sS "${MCP_SERVER_URL}/.well-known/openid-configuration" | jq

echo "2) Health check"
curl -sS "${MCP_SERVER_URL}/health" | jq

echo "3) Instructions JSON check"
curl -sS -H 'Accept: application/json' "${MCP_SERVER_URL}/instructions" | jq '.title, .sections | length? // .'

echo "4) MCP initialize"
curl -sS -X POST "${MCP_SERVER_URL}/mcp" \
  -H "STITCH_API_KEY: ${STITCH_API_KEY}" \
  -H "STITCH_PROJECT_ID: ${STITCH_PROJECT_ID}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}' | jq

echo "5) tools/list"
curl -sS -X POST "${MCP_SERVER_URL}/mcp" \
  -H "STITCH_API_KEY: ${STITCH_API_KEY}" \
  -H "STITCH_PROJECT_ID: ${STITCH_PROJECT_ID}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | jq

echo "6) list_screens"
curl -sS -X POST "${MCP_SERVER_URL}/mcp" \
  -H "STITCH_API_KEY: ${STITCH_API_KEY}" \
  -H "STITCH_PROJECT_ID: ${STITCH_PROJECT_ID}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_screens","arguments":{"projectId":"'"${STITCH_PROJECT_ID}"'"}}}' | jq

echo "7) Log viewer HTML check"
curl -sS "${MCP_SERVER_URL}/logs" | head -5

echo "8) Log viewer API check"
curl -sS "${MCP_SERVER_URL}/api/logs" | jq '.summaryLog, (.projects | length)'

echo "9) Summary log API check"
curl -sS "${MCP_SERVER_URL}/api/logs/summary?limit=5" | jq '.total, (.lines | length)'

echo "10) Path traversal protection check (expect 403)"
HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" "${MCP_SERVER_URL}/api/logs/../../../etc/passwd")
if [ "$HTTP_CODE" = "403" ]; then
  echo "   PASS: Path traversal blocked (HTTP $HTTP_CODE)"
else
  echo "   FAIL: Expected 403, got HTTP $HTTP_CODE"
fi

echo ""
echo "All tests complete."