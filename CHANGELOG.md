# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`scripts/live-probe.js`** — the opt-in probe for finding P4. It asks the real Stitch endpoint
  whether it implements `resources/list` and `resources/templates/list`, sending read-only
  discovery calls only (`initialize`, `tools/list`, then the three list methods). `tools/list` is
  the control: if it fails, every other row is reported as inconclusive and the script exits `1`.
  Run it with `npm run probe:live -- --i-understand`. It refuses to run when `CI` is set, reads
  the key from `STITCH_API_KEY` only (never argv), and `test/probe.test.js` asserts all three
  guards. `--json` gives machine-readable output.

## [1.0.0] — 2026-10-18

First release after the hardening programme. The headline property is unchanged: **zero runtime
dependencies**, one `node index.js`. Behaviour that existing clients rely on is preserved except
where a security default had to change; every such change is listed under **Changed** with a
migration note.

### Fixed — critical

- **Duplicate Stitch side effects on retry (★C1).** Any transient failure was retried, including
  connection resets that happened _after_ Stitch had received the request. A single
  `create_project` was delivered **three times** (reproduced), creating three projects and
  spending generation quota. Requests are now classified `safe`/`unsafe` and retried by **error
  phase**: a `connect`-phase failure is always retryable, but an `unsafe` request that failed
  after being sent is never repeated. It returns JSON-RPC `-32008` with instructions to check
  `list_screens`/`list_projects` before retrying.
- **Malformed input killed the process (★C2).** `new URL(req.url, \`http://${req.headers.host}\`)`threw on`Host: [bad`outside any`try`/`catch`, so one unauthenticated packet terminated the
proxy. The URL is built from a constant base, `Host`is validated separately, the handler is
wrapped so it always answers, and`clientError` is handled.
- **Any website could drive the proxy with the server's API key (★C3).** CORS defaulted to `*`
  and the env key was used for requests with no credential. The origin policy now allows
  private-network origins and refuses the public internet.
- **The log viewer, logs API and metrics were world-readable (★C4).** They now reject
  cross-origin browsers, refuse non-local-network clients, and `/health` publishes only
  `{status, version, uptime}`.
- **Streamed responses crashed the process (★C5).** The streaming branch was missing a `return`,
  so control fell through to the 404 handler and threw `ERR_HTTP_HEADERS_SENT` as an unhandled
  rejection. The _first_ streamed Stitch response killed the proxy.

### Fixed — protocol correctness

- **MCP headers were dropped in both directions (★P1).** `MCP-Protocol-Version`,
  `Mcp-Session-Id`, `Last-Event-ID`, `Mcp-Method`, `Mcp-Name` and `Mcp-Param-*` now reach the
  upstream; `Mcp-Session-Id`, `Retry-After`, `WWW-Authenticate`, `Cache-Control` and
  `X-Accel-Buffering` now reach the client.
- **Error responses always used `id: null` (★P2).** `401`, `403`, `413`, `429`, `502`, `503`,
  `504` and `500` now echo the request id, including `id: 0`, string ids, and one error object per
  request for a JSON-RPC array.
- **Batches bypassed classification (P3).** A batch is classified by its most unsafe element.

### Fixed — streaming and resources

- **A stream outlived its timeout and its client (★S1).** Three independent deadlines now apply:
  headers, stream idle, and total duration. A client disconnect aborts the upstream read for
  safe calls.
- **No backpressure (★S2).** Streaming uses `pipeline()`, so a slow client cannot make the proxy
  buffer without bound.
- **Bodies were captured for logging even when logging was off (★S3).** Capture is bounded and
  only happens in debug mode.
- **Event-listener leak on keep-alive sockets (★S4).** Connection tracking happens once per
  socket instead of once per request. Previously `MaxListenersExceededWarning` appeared after
  12 requests.
- **Server timeouts were invisible (★S6).** `requestTimeout`, `headersTimeout` and
  `keepAliveTimeout` are explicit and configurable, and concurrent upstream requests are capped
  with a bounded queue (`503` + `Retry-After` on saturation).

### Fixed — smaller

- `HEAD /health` returned 404 (★N3); it now works on `/health`, `/metrics` and `/instructions`.
- `LOG_VIEWER_ENABLED=false` only disabled the HTML page, leaving `/api/logs*` and raw log files
  reachable (★N1).
- The request size limit was unreachable for unauthenticated callers (★N2).
- `X-Forwarded-For` was trusted unconditionally, so the per-IP rate limit could be bypassed
  (★N4).
- Per-project debug logs were attributed to the env default instead of
  `params.arguments.projectId` (★N5).
- The error-path debug log dropped the request body (★N6).
- `test.sh` printed the API key (★N8).

### Added

- **Request classification** (`src/mcp/classify.js`) with `SAFE_TOOLS`/`UNSAFE_TOOLS` overrides and
  a conservative "unknown is unsafe" default.
- **Phase-aware retry** (`src/upstream/retry.js`) with exponential backoff and full jitter,
  honouring `Retry-After`.
- **In-flight coalescing**: identical concurrent unsafe calls produce **one** upstream request;
  each caller receives its own JSON-RPC id.
- **Orphaned-result capture**: a disconnect or timeout no longer loses a generation. The unsafe
  request keeps running for up to 10 minutes and its result is stored (undelivered) so a retry
  collects it instead of starting a second generation.
- **Explicit idempotency keys**: an `Idempotency-Key` header or `params._meta.idempotencyKey`
  replays a completed result, even if it was already delivered.
- **`tools/list` annotation injection**, so clients can warn before an unsafe call.
- **JSON-RPC `-32008` (outcome unknown)**, `-32009` (proxy saturated), `-32600` (invalid
  request) and `-32603` (internal error).
- **`X-Proxy-Coalesced` and `X-Proxy-Replayed`** response headers for observability.
- **Modular source tree** under `src/`, with `index.js` kept as a thin entry point so
  `node index.js` still works.
- **ESLint, Prettier, `tsc --checkJs`, a 307-test suite** (94 % statement coverage) and GitHub
  Actions CI over Node 20/22/24.
- **Hardened deployment artifacts**: non-root container with a read-only root filesystem,
  `node`-based healthchecks, `STOPSIGNAL SIGTERM`, and systemd units with `ProtectSystem=strict`,
  `PrivateTmp`, `RestrictAddressFamilies`, `MemoryMax` and a stop timeout that exceeds the drain
  budget.
- **ADRs 0001–0005**, `SECURITY.md`, and configuration drift tests that fail if the code,
  `.env.example` and `PROGRESS.md` disagree.

### Changed — **migration notes**

- **A public `Origin` is refused where it previously worked.** The proxy now allows
  private-network origins only (`localhost`, `*.local`, RFC 1918, loopback, link-local, CGNAT,
  IPv6 ULA). To allow a specific public origin, add it to `ALLOWED_ORIGINS`, or set
  `CORS_ORIGIN=*` to restore the old permissive behaviour (not recommended).
- **`/health` no longer returns the full status document.** Public payload is
  `{status, version, uptime}`. Use `/health?verbose=1` from the local network, or scrape
  `/metrics`.
- **CORS is no longer emitted for `/logs`, `/api/logs*`, `/metrics` or `/health`.** Only `/mcp`
  advertises CORS.
- **Rate limiting is enabled by default** (`RATE_LIMIT_MAX_RPS=100`, `RATE_LIMIT_BURST=200`).
  Set `RATE_LIMIT_ENABLED=false` to restore the old behaviour.
- **A non-idempotent call that fails after being sent returns `-32008` instead of being
  retried.** Clients should check state and retry the identical call, which is safe because the
  result is replayed.
- **A public `Host` header is refused** (DNS-rebinding control). A reverse proxy that presents a
  public `Host` needs `ALLOWED_HOSTS=*`.
- **Unsafe calls are buffered rather than streamed**, which is required to share one result
  between coalesced callers. Safe calls still stream.
- **`ALLOW_ENV_API_KEY_FOR_BROWSER` was removed**; the origin allow-list makes it meaningless.
- **The default port is documented as `8787` everywhere.** Earlier docs mixed `8787` and `11401`.

### Security

See [SECURITY.md](./SECURITY.md). Reported issues: the five critical findings above were all
reproduced against the pre-hardening code before being fixed.
