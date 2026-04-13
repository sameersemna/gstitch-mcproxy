#!/bin/bash

# get environment variables from .env file
set -a
source .env
set +a

MCP_SERVER_PORT=${MCP_SERVER_PORT:-8787}
MCP_SERVER_HOST=${MCP_SERVER_HOST:-localhost}
MCP_SERVER_URL="http://${MCP_SERVER_HOST}:${MCP_SERVER_PORT}"

curl -sS ${MCP_SERVER_URL}/.well-known/openid-configuration

curl -sS -X POST ${MCP_SERVER_URL}/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"copilot-cli","version":"1.0"}}}' | jq

curl -sS -X POST ${MCP_SERVER_URL}/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | jq

curl -sS -X POST ${MCP_SERVER_URL}/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":3,"method":"resources/list","params":{}}' | jq

curl -sS -X POST ${MCP_SERVER_URL}/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "X-Stitch-Project-Id: ${STITCH_PROJECT_ID}" \
  --data '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"list_design_systems","arguments":{"projectId":"'"${STITCH_PROJECT_ID}"'"}}}' | head -c 1200 | jq

curl -sS -X POST ${MCP_SERVER_URL}/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "X-Stitch-Project-Id: ${STITCH_PROJECT_ID}" \
  --data '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_design_systems","arguments":{"projectId":"'"${STITCH_PROJECT_ID}"'"}}}' | jq