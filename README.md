# gstitch-mcproxy

HTTP proxy for Google Stitch MCP with:
- header-based credential passthrough
- MCP forwarding to Stitch with **SSE streaming support**
- human/AI-readable instructions endpoint
- health endpoint with live metrics
- structured request logging with debug capture
- browser-based log viewer dashboard
- **Prometheus metrics endpoint**
- **rate limiting, request timeouts, body size limits**
- **graceful shutdown with connection draining**
- **Docker support**

## Endpoints

`GET /health`
- Returns runtime status, logging config, credential availability, resilience settings, and live metrics.

`GET /metrics`
- Returns Prometheus-format metrics: request counts, latency histogram, error rates, active connections, rate-limited count, uptime.

`GET /instructions`
- Returns formatted HTML by default.
- Returns structured JSON with `Accept: application/json`.
- Returns raw markdown with `Accept: text/markdown`.

`POST /mcp`
- Proxies MCP requests to Stitch with **SSE streaming** for long-running operations.
- Validates `Origin` header per MCP Streamable HTTP spec (2026-07-28).
- Enforces configurable rate limits, request timeouts, and body size limits.
- Retries transient upstream failures (HTTP/2 stream resets, socket hangups).
- Answers `GET`/`DELETE`/`PUT` locally with a JSON-RPC 405 (Stitch only implements `POST`).
- Answers `prompts/list` locally with an empty list (Stitch resets the stream for it).

`GET /logs`
- Opens an interactive log viewer dashboard in the browser.
- Sidebar lists projects and their log files, plus the summary log.
- Main pane displays log content with line numbers and live search filtering.

`GET /api/logs`
- Returns JSON metadata: summary log info and list of all project log directories with file counts.

`GET /api/logs/summary?limit=200&offset=0`
- Returns paginated lines from the summary log (`logs/proxy.log`).

`GET /api/logs/{projectId}/{filename}`
- Returns the raw text content of a specific debug log file.
- Protected against path traversal attacks (returns 403 on escape attempts).

## Credential Contract

This proxy accepts the API key from request headers:

```http
STITCH_API_KEY: <your-api-key>
```

The project ID is **not** read from headers. It can be configured in two ways:

1. **Environment default** (optional) — set `STITCH_PROJECT_ID` in `.env` to be used as a fallback for every request.
2. **Per-tool arguments** — pass it as `arguments: { projectId: "..." }` in the tool call body. Agents should tell the assistant the project ID in chat, and the assistant will thread it into the relevant tool calls.

The Stitch API itself will surface a clear error if a project ID is required and none is supplied. Any `STITCH_PROJECT_ID` (or `X-Stitch-Project-Id`) request headers sent by older clients are silently ignored for backward compatibility.

Environment fallback example:

```dotenv
STITCH_API_KEY=your-api-key
# Optional — provides a default projectId when tools don't supply one
STITCH_PROJECT_ID=your-project-id
```

## VS Code MCP Example

```json
{
	"servers": {
		"local/stitch": {
			"type": "http",
			"url": "http://localhost:11401/mcp",
			"auth": {
				"type": "none"
			},
			"headers": {
				"STITCH_API_KEY": "${input:stitch_api_key}"
			}
		}
	}
}
```

> **Note:** `STITCH_PROJECT_ID` is intentionally **not** in the headers. Either set it in your server `.env`, or have the agent pass it through `arguments.projectId` on each tool call.

> **Note:** Do **not** add a `requestTimeout` field. VS Code's HTTP MCP schema only accepts
> `type`, `url`, `headers`, and `oauth`; unknown fields are silently ignored. Long-running
> Stitch calls (60s+) are handled by the proxy's own `REQUEST_TIMEOUT_MS` setting.

## Logging

Summary log:
- `logs/proxy.log`

Debug mode also writes per-project request/response files:
- `logs/<projectId>/<timestamp>-<requestId>.log`

Relevant env vars:

```dotenv
LOG_ENABLED=true
LOG_LEVEL=debug
LOG_DIR=logs
LOG_FILE_NAME=proxy.log
LOG_MAX_BODY_CHARS=20000
LOG_MAX_FILE_SIZE_BYTES=5242880
LOG_MAX_ROTATED_FILES=5
LOG_SKIP_MCP_GET=true
LOG_SKIP_MCP_METHODS=initialize,notifications/initialized,notifications/progress,ping
LOG_SLOW_REQUEST_MS=2000
LOG_VERY_SLOW_REQUEST_MS=5000
LOG_VIEWER_ENABLED=true
LOG_VIEWER_MAX_FILE_BYTES=10485760
LOG_SUMMARY_MAX_LINES=200
```

## Log Viewer

Open `http://localhost:8787/logs` in a browser to access the log viewer dashboard.

**Features:**
- **Summary tab**: View the proxy summary log (`proxy.log`) with line numbers.
- **Projects tab**: Browse per-project debug logs organized by project ID. Click a project to expand its timestamped log files.
- **Live filter**: Type in the search box to highlight matching lines and hide non-matching ones (e.g., "ERROR", "SLOW", "tools/list").
- **Refresh button**: Reloads the file list from disk.

**Configuration:**

| Variable | Default | Description |
|---|---|---|
| `LOG_VIEWER_ENABLED` | `true` | Enable/disable the `/logs` and `/api/logs/*` endpoints |
| `LOG_VIEWER_MAX_FILE_BYTES` | `10485760` (10 MB) | Max file size served by the viewer |
| `LOG_SUMMARY_MAX_LINES` | `200` | Default page size for summary log API |

**Security:** All file paths are validated against path traversal. Requests that attempt to escape the `logs/` directory receive a 403 response.

## SSE Streaming

The proxy detects `text/event-stream` responses from Stitch and **streams chunks in real-time** instead of buffering. This is critical for long-running operations like `generate_screen_from_text` and `edit_screens` which can take 60+ seconds. Without streaming, clients would see the request hang until completion.

Streaming responses are logged in full after the stream completes, so debug logs remain complete.

## Resilience & Safety

| Variable | Default | Description |
|---|---|---|
| `REQUEST_TIMEOUT_MS` | `120000` (2 min) | Upstream request timeout. Returns 504 on timeout. |
| `MAX_BODY_SIZE_BYTES` | `10485760` (10 MB) | Maximum request body size. Returns 413 on exceed. |
| `RATE_LIMIT_ENABLED` | `false` | Enable token-bucket rate limiting. |
| `RATE_LIMIT_MAX_RPS` | `10` | Requests per second per client IP. |
| `RATE_LIMIT_BURST` | `20` | Maximum burst size for rate limiter. |
| `CORS_ORIGIN` | `*` | CORS allowed origin. Set to specific origin for production. |
| `SHUTDOWN_DRAIN_MS` | `15000` | Max time to drain connections on SIGTERM/SIGINT. |
| `UPSTREAM_RETRY_ENABLED` | `true` | Retry transient upstream failures. |
| `UPSTREAM_RETRY_ATTEMPTS` | `3` | Max attempts per upstream request. |
| `UPSTREAM_RETRY_BASE_DELAY_MS` | `250` | Base delay for exponential backoff. |
| `LOCAL_FALLBACK_METHODS` | `prompts/list` | Methods answered locally instead of forwarded. |

**Origin Validation:** Per the MCP Streamable HTTP spec (2026-07-28), the proxy validates the `Origin` header on `/mcp` requests. Invalid origins receive HTTP 403.

## Upstream Resilience

Stitch occasionally resets the HTTP/2 stream mid-request. Node's `fetch()` reports this as a
bare `TypeError: fetch failed`, hiding the real cause (`ERR_HTTP2_STREAM_ERROR`). The proxy:

1. **Unwraps the cause** — logs and returns `fetch failed (ERR_HTTP2_STREAM_ERROR)` instead of `fetch failed`.
2. **Retries transient failures** — up to `UPSTREAM_RETRY_ATTEMPTS` with exponential backoff. Timeouts and HTTP error responses are never retried.
3. **Returns JSON-RPC errors** — upstream failures return HTTP 502 with a JSON-RPC error object (code `-32006`) rather than a plain-text body, so MCP clients can parse them.
4. **Aborts on client disconnect** — if the client goes away, the upstream request is cancelled and logged as status `499`.

### Methods Stitch does not implement

Stitch resets the HTTP/2 stream for `prompts/list` (it returns no response at all). Clients
see this as `fetch failed` and some retry capability discovery in a tight loop — the logs
showed ~29,000 failed discovery cycles in a single day. The proxy now answers
`prompts/list` locally with `{"prompts": []}`, which is spec-compliant and stops the loop.

`GET`, `DELETE`, and `PUT` on `/mcp` are also answered locally with a JSON-RPC 405. Stitch
returns a Google HTML error page for these, which is not a valid MCP response.

## Metrics (Prometheus)

`GET /metrics` returns Prometheus-format metrics:

| Metric | Type | Description |
|---|---|---|
| `gstitch_proxy_uptime_seconds` | gauge | Proxy uptime |
| `gstitch_proxy_requests_total` | counter | Total requests |
| `gstitch_proxy_errors_total` | counter | Total errors (5xx) |
| `gstitch_proxy_active_connections` | gauge | Current active connections |
| `gstitch_proxy_rate_limited_total` | counter | Rate-limited requests |
| `gstitch_proxy_requests_by_method` | counter | Requests by HTTP method + path |
| `gstitch_proxy_requests_by_status` | counter | Requests by HTTP status code |
| `gstitch_proxy_latency_seconds` | histogram | Request latency buckets (100ms, 500ms, 1s, 5s, 30s, 120s) |

Disable with `METRICS_ENABLED=false`.

## Docker

```bash
# Build and run
docker compose up -d

# Or build manually
docker build -t gstitch-mcproxy .
docker run -d -p 8787:8787 \
  -e STITCH_API_KEY=your-key \
  -e STITCH_PROJECT_ID=your-project \
  -v $(pwd)/logs:/app/logs \
  gstitch-mcproxy
```

The Docker image:
- Runs as non-root user (`mcproxy`)
- Includes healthcheck (`/health` endpoint)
- Exposes port 8787
- Uses `node:22-alpine` for minimal size

## Quick Test

Run the proxy:

```bash
./run.sh
```

Install it as a systemd user service on Ubuntu:

```bash
chmod +x run.sh install-user-service.sh
./install-user-service.sh
```

Useful service commands:

```bash
systemctl --user status gstitch-mcproxy
systemctl --user restart gstitch-mcproxy
journalctl --user -u gstitch-mcproxy -f
```

If you want the user service to keep running after logout, enable lingering once:

```bash
sudo loginctl enable-linger "$USER"
```

Install it as a system service that starts automatically after reboot:

```bash
chmod +x run.sh install-system-service.sh
./install-system-service.sh
```

Useful system service commands:

```bash
sudo systemctl status gstitch-mcproxy
sudo systemctl restart gstitch-mcproxy
sudo journalctl -u gstitch-mcproxy -f
```

If needed, make it executable once:

```bash
chmod +x run.sh
```

Run the test script:

```bash
bash test.sh
```

The test covers:
- well-known discovery
- health endpoint
- instructions endpoint JSON output
- MCP initialize
- tools/list
- list_screens


```bash
sudo systemctl status gstitch-mcproxy --no-pager --lines=20
sudo systemctl cat gstitch-mcproxy
```

Check if the service is enabled and active:
```bash
sudo systemctl is-enabled gstitch-mcproxy
sudo systemctl is-active gstitch-mcproxy
curl -fsS http://localhost:11401/health
```