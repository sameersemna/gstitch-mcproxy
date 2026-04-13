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

echo "2) MCP initialize"
curl -sS -X POST "${MCP_SERVER_URL}/mcp" \
  -H "STITCH_API_KEY: ${STITCH_API_KEY}" \
  -H "STITCH_PROJECT_ID: ${STITCH_PROJECT_ID}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}' | jq

echo "3) tools/list"
curl -sS -X POST "${MCP_SERVER_URL}/mcp" \
  -H "STITCH_API_KEY: ${STITCH_API_KEY}" \
  -H "STITCH_PROJECT_ID: ${STITCH_PROJECT_ID}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | jq

echo "4) list_screens"
curl -sS -X POST "${MCP_SERVER_URL}/mcp" \
  -H "STITCH_API_KEY: ${STITCH_API_KEY}" \
  -H "STITCH_PROJECT_ID: ${STITCH_PROJECT_ID}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_screens","arguments":{"projectId":"'"${STITCH_PROJECT_ID}"'"}}}' | jq