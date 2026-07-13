#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

# Include common user-managed Node locations so the script also works under systemd.
export PATH="${HOME}/.n/bin:${HOME}/.local/bin:${PATH}"

if [ -f "${ENV_FILE}" ]; then
  set -a
  source "${ENV_FILE}"
  set +a
fi

MCP_SERVER_PORT="${MCP_SERVER_PORT:-8787}"
MCP_SERVER_HOST="${MCP_SERVER_HOST:-localhost}"
LOG_DIR="${LOG_DIR:-logs}"
LOG_PATH="${ROOT_DIR}/${LOG_DIR}"

mkdir -p "${LOG_PATH}"

if command -v lsof >/dev/null 2>&1; then
  if lsof -ti tcp:"${MCP_SERVER_PORT}" >/dev/null 2>&1; then
    echo "Port ${MCP_SERVER_PORT} is already in use. Stop the existing process first."
    exit 1
  fi
fi

echo "Starting gstitch-mcproxy"
echo "  host: ${MCP_SERVER_HOST}"
echo "  port: ${MCP_SERVER_PORT}"
echo "  logs: ${LOG_PATH}"
echo "  log level: ${LOG_LEVEL:-info}"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [ -z "${NODE_BIN}" ]; then
  echo "Node.js was not found in PATH. Set NODE_BIN or update PATH before starting gstitch-mcproxy."
  exit 1
fi

echo "  node: ${NODE_BIN}"

if [ -n "${STITCH_API_KEY:-}" ]; then
  echo "  api key: env-configured"
else
  echo "  api key: header-based (expect STITCH_API_KEY per request)"
fi
if [ -n "${STITCH_PROJECT_ID:-}" ]; then
  echo "  project id: env-configured (default)"
else
  echo "  project id: optional (provide via tool arguments or agent chat)"
fi

cd "${ROOT_DIR}"
exec "${NODE_BIN}" index.js