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

# Never print the key itself: this script is routinely run in terminals that are recorded,
# shared or piped into CI logs, and the value is a live Stitch credential. Report only whether
# it is present.
if [ -n "${STITCH_API_KEY}" ]; then
  API_KEY_STATE="configured"
else
  API_KEY_STATE="missing"
fi

if [ -n "${STITCH_PROJECT_ID}" ]; then
  PROJECT_ID_STATE="configured"
else
  PROJECT_ID_STATE="missing (optional — tools requiring a project need it via arguments)"
fi

echo "Testing MCP server at ${MCP_SERVER_URL}"
echo "  api key: ${API_KEY_STATE}"
echo "  project id: ${PROJECT_ID_STATE}"

if [ -z "${STITCH_API_KEY}" ]; then
  echo "Missing STITCH_API_KEY in environment/.env"
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
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}' | jq

echo "5) tools/list"
curl -sS -X POST "${MCP_SERVER_URL}/mcp" \
  -H "STITCH_API_KEY: ${STITCH_API_KEY}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | jq

echo "6) list_screens"
# Note: projectId is passed via tool arguments, not headers
if [ -n "${STITCH_PROJECT_ID}" ]; then
  PROJECT_ARG='"projectId":"'"${STITCH_PROJECT_ID}"'"'
  curl -sS -X POST "${MCP_SERVER_URL}/mcp" \
    -H "STITCH_API_KEY: ${STITCH_API_KEY}" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_screens","arguments":{"projectId":"'"${STITCH_PROJECT_ID}"'"}}}' | jq
else
  echo "   (skipping list_screens — STITCH_PROJECT_ID is required as a tool argument)"
fi

echo "7) Log viewer HTML check"
curl -sS "${MCP_SERVER_URL}/logs" | head -5

echo "8) Log viewer API check"
curl -sS "${MCP_SERVER_URL}/api/logs" | jq '.summaryLog, (.projects | length)'

echo "9) Summary log API check"
curl -sS "${MCP_SERVER_URL}/api/logs/summary?limit=5" | jq '.total, (.lines | length)'

echo "10) Path traversal protection check (expect 403)"
# --path-as-is is required: without it curl normalises the ".." segments client-side
# and the request never reaches the proxy as a traversal attempt.
HTTP_CODE=$(curl -sS --path-as-is -o /dev/null -w "%{http_code}" "${MCP_SERVER_URL}/api/logs/..%2f..%2f..%2fetc/passwd")
if [ "$HTTP_CODE" = "403" ]; then
  echo "   PASS: Path traversal blocked (HTTP $HTTP_CODE)"
else
  echo "   FAIL: Expected 403, got HTTP $HTTP_CODE"
fi

echo "11) prompts/list local fallback (expect 200 + empty prompts)"
curl -sS -X POST "${MCP_SERVER_URL}/mcp" \
  -H "STITCH_API_KEY: ${STITCH_API_KEY}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":11,"method":"prompts/list","params":{}}' | jq -e '.result.prompts == []' >/dev/null \
  && echo "   PASS: prompts/list answered locally" \
  || echo "   FAIL: prompts/list did not return an empty prompts list"

echo "12) GET /mcp returns JSON-RPC 405 (expect 405 + JSON body)"
GET_BODY=$(curl -sS -X GET "${MCP_SERVER_URL}/mcp" \
  -H "STITCH_API_KEY: ${STITCH_API_KEY}" \
  -H 'Accept: text/event-stream')
GET_CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X GET "${MCP_SERVER_URL}/mcp" \
  -H "STITCH_API_KEY: ${STITCH_API_KEY}" \
  -H 'Accept: text/event-stream')
if [ "$GET_CODE" = "405" ] && echo "$GET_BODY" | jq -e '.error.code == -32005' >/dev/null 2>&1; then
  echo "   PASS: GET /mcp returns JSON-RPC 405"
else
  echo "   FAIL: Expected JSON-RPC 405, got HTTP $GET_CODE with body: $GET_BODY"
fi

echo "13) DELETE /mcp returns JSON-RPC 405 (expect 405 + JSON body)"
DEL_CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X DELETE "${MCP_SERVER_URL}/mcp" \
  -H "STITCH_API_KEY: ${STITCH_API_KEY}")
if [ "$DEL_CODE" = "405" ]; then
  echo "   PASS: DELETE /mcp returns 405"
else
  echo "   FAIL: Expected 405, got HTTP $DEL_CODE"
fi

echo "14) Missing API key returns JSON-RPC 401 (expect 401 + JSON body)"
NOAUTH_BODY=$(curl -sS -X POST "${MCP_SERVER_URL}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":14,"method":"tools/list","params":{}}')
if echo "$NOAUTH_BODY" | jq -e '.error.code == -32007' >/dev/null 2>&1; then
  echo "   PASS: Missing API key returns JSON-RPC error"
else
  echo "   FAIL: Expected JSON-RPC -32007, got: $NOAUTH_BODY"
fi

echo "15) Unknown route returns JSON-RPC 404 (expect 404 + JSON body)"
NF_BODY=$(curl -sS "${MCP_SERVER_URL}/does-not-exist")
if echo "$NF_BODY" | jq -e '.error.code == -32601' >/dev/null 2>&1; then
  echo "   PASS: Unknown route returns JSON-RPC error"
else
  echo "   FAIL: Expected JSON-RPC -32601, got: $NF_BODY"
fi

echo "16) Metrics latency sum is non-zero after traffic"
curl -sS "${MCP_SERVER_URL}/metrics" | grep -E '^gstitch_proxy_latency_seconds_sum' | head -1

echo ""
echo "All tests complete."