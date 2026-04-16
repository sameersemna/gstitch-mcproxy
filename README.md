# gstitch-mcproxy

HTTP proxy for Google Stitch MCP with:
- header-based credential passthrough
- MCP forwarding to Stitch
- human/AI-readable instructions endpoint
- health endpoint
- structured request logging with debug capture

## Endpoints

`GET /health`
- Returns runtime status, logging config, and credential availability.

`GET /instructions`
- Returns formatted HTML by default.
- Returns structured JSON with `Accept: application/json`.
- Returns raw markdown with `Accept: text/markdown`.

`POST /mcp`
- Proxies MCP requests to Stitch.

## Credential Contract

This proxy accepts Stitch credentials from request headers:

```http
STITCH_API_KEY: <your-api-key>
STITCH_PROJECT_ID: <your-project-id>
```

It also supports environment fallback:

```dotenv
STITCH_API_KEY=your-api-key
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
				"STITCH_API_KEY": "${input:stitch_api_key}",
				"STITCH_PROJECT_ID": "${input:stitch_project_id}"
			}
		}
	}
}
```

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
```

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