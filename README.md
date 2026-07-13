# gstitch-mcproxy

HTTP proxy for Google Stitch MCP with:
- header-based credential passthrough
- MCP forwarding to Stitch
- human/AI-readable instructions endpoint
- health endpoint
- structured request logging with debug capture
- browser-based log viewer dashboard

## Endpoints

`GET /health`
- Returns runtime status, logging config, and credential availability.

`GET /instructions`
- Returns formatted HTML by default.
- Returns structured JSON with `Accept: application/json`.
- Returns raw markdown with `Accept: text/markdown`.

`POST /mcp`
- Proxies MCP requests to Stitch.

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