# PROGRESS LEDGER — gstitch-mcproxy hardening

> **This file is the memory of a long-horizon task.** Read it first, update it last.
> Released `v1.0.0` on 2026-10-18 (PR #1, `hardening/v1` → `main`, branch deleted). Baseline: `2578c26`.

---

## 1. Current phase / step / status

| Field   | Value                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------- |
| Phase   | **all phases complete (0–10); released as `v1.0.0`**                                                           |
| Step    | P4 probe written; the remaining work is S5 (async I/O) and running the probe with the owner's key              |
| Status  | Gates green: 308 tests → **306 pass / 2 todo / 0 fail**, lint clean, typecheck clean, `npm run verify` exits 0 |
| Started | 2026-10-17                                                                                                     |

## 2. Last green commit

| Field     | Value                                                                  |
| --------- | ---------------------------------------------------------------------- |
| Branch    | `main` @ `v1.0.0` (`dd3448e`) plus the P4 probe commit                 |
| test      | 306 pass / 2 todo / 0 fail (308 tests, ~10 s)                          |
| lint      | clean                                                                  |
| typecheck | clean (`scripts/**/*.js` is in `tsconfig.json` `include`)              |
| verify    | `npm run verify` exits 0                                               |
| coverage  | 94 % statements                                                        |
| run.sh    | starts, `GET /health` ⇒ 200 (`version: 1.0.0`), `SIGTERM` ⇒ clean exit |

## 3. Phase checklist

- [x] **Phase 0** — Baseline, packaging and harness — ✅ `920b4ee`
- [x] **Phase 1** — Crash-proofing and correctness — ✅ `dfd243c` + `78cccf8`
- [x] **Phase 2** — Modularize (pure refactor) — `2603fa0` … `59957ff` (config isolation deferred to Phase 6, guarded)
- [x] **Phase 3** — Idempotency, retry safety and duplicate suppression — `b96e3e7`, `c42a7b9`, `7f0d3e9`, `4a4e810`
- [x] **Phase 4** — Streaming and upstream I/O — `558b892`
- [x] **Phase 5** — Security model — `5bd3e3d` (owner decisions applied)
- [x] **Phase 6** — Configuration, observability and lifecycle — `f8a1460` (config schema + drift tests)
- [x] **Phase 7** — Tooling and CI — `4e4c06a`
- [x] **Phase 8** — Deployment artifacts — `4e4c06a`
- [x] **Phase 9** — Documentation — `4e4c06a`
- [x] **Phase 10** — Final verification and handoff — all 10 reproduced findings re-verified fixed

---

## 4. Environment facts (verified 2026-10-17)

| Fact                              | Value                                             |
| --------------------------------- | ------------------------------------------------- |
| Node (local)                      | `v26.3.0`                                         |
| npm (local)                       | `9.2.0`                                           |
| `AbortSignal.any`                 | ✅ function (Node ≥ 20.3)                         |
| `AbortSignal.timeout`             | ✅ function                                       |
| `Readable.fromWeb`                | ✅ function                                       |
| `stream/promises.pipeline`        | ✅ function                                       |
| `server.closeIdleConnections`     | ✅ function                                       |
| `server.requestTimeout` default   | `300000`                                          |
| `server.headersTimeout` default   | `60000`                                           |
| `server.keepAliveTimeout` default | `5000`                                            |
| `--experimental-test-coverage`    | ✅ works on Node 26                               |
| **`engines.node` decision**       | `>=20.3.0` (first version with `AbortSignal.any`) |
| **CI matrix**                     | 20 / 22 / 24                                      |

> **context7 was unavailable** during this session (API key rejected: `Invalid API key`).
> Per prime directive #3, protocol facts were verified against the **spec source text** in
> `modelcontextprotocol/modelcontextprotocol` and the runtime behaviour was verified locally.

---

## 5. Route inventory (baseline, verified by reading `index.js` @ `2578c26`)

| Route                                   | Methods        | Behaviour                                                      | Auth     |
| --------------------------------------- | -------------- | -------------------------------------------------------------- | -------- |
| `/mcp`                                  | POST           | Forward to Stitch (retries, fallbacks, streaming)              | none     |
| `/mcp`                                  | GET            | 405 `-32005` "no SSE stream offered" + `Allow: POST, OPTIONS`  | none     |
| `/mcp`                                  | DELETE         | 405 `-32005` "stateless" + `Allow`                             | none     |
| `/mcp`                                  | PUT/PATCH/HEAD | 405 `-32005`                                                   | none     |
| `/mcp`                                  | OPTIONS        | 204 (generic preflight, before routing)                        | none     |
| `/health`                               | GET            | Fat JSON: proxy cfg, credentials, logging, resilience, metrics | **none** |
| `/metrics`                              | GET            | Prometheus text (`METRICS_ENABLED`, default true)              | **none** |
| `/instructions`                         | GET            | HTML / JSON / Markdown by `Accept`                             | **none** |
| `/logs`                                 | GET            | Log viewer HTML (`LOG_VIEWER_ENABLED`, default true)           | **none** |
| `/api/logs`                             | GET            | Project tree + summary-log stat                                | **none** |
| `/api/logs/summary`                     | GET            | Paged summary lines (`limit`, `offset`)                        | **none** |
| `/api/logs/{projectId}/{file}`          | GET            | Raw log file text                                              | **none** |
| `/.well-known/oauth-protected-resource` | GET            | Static stub, hardcodes `http://localhost:${port}`              | **none** |
| `/.well-known/openid-configuration`     | GET            | Static stub, hardcodes `http://localhost:${port}`              | **none** |
| `/auth`                                 | GET            | `200 "OK"`                                                     | **none** |
| `/token`                                | POST           | `{"access_token":"local-proxy-token"}` — **static, anyone**    | **none** |
| anything else                           | any            | 404 `-32601`                                                   | none     |

Ordering note: `OPTIONS` is handled **before** routing, so it returns 204 for _every_ path with CORS `*`.
The `/logs*` disabled check happens before the viewer routes but after `/mcp` guard is entered only for `/mcp`.

### JSON-RPC error codes emitted by the proxy

| Code           | Meaning                                 | Where                                                     |
| -------------- | --------------------------------------- | --------------------------------------------------------- |
| `-32001`       | Invalid Origin header (403)             | `validateOrigin` failure                                  |
| `-32002`       | Rate limit exceeded (429)               | token bucket                                              |
| `-32003`       | Request body too large (413)            | body reader                                               |
| `-32004`       | Upstream request timed out (504)        | catch, `AbortError`/`TimeoutError`                        |
| `-32005`       | Method not allowed on `/mcp` (405)      | GET/DELETE/other                                          |
| `-32006`       | Upstream request to Stitch failed (502) | catch, generic                                            |
| `-32007`       | Missing API key (401)                   | credential check                                          |
| `-32601`       | Not found (404)                         | fallthrough (also spec's "Method not found")              |
| _reserved new_ | `-32008` (proposed)                     | unsafe call, outcome unknown — see ADR 0003               |
| _spec_         | `-32020`                                | `HeaderMismatch` (2026-07-28 spec) — not emitted by proxy |

### Prometheus metric names (must never be renamed)

`gstitch_proxy_uptime_seconds`, `gstitch_proxy_requests_total`, `gstitch_proxy_errors_total`,
`gstitch_proxy_active_connections`, `gstitch_proxy_rate_limited_total`,
`gstitch_proxy_requests_by_method{method_path}`, `gstitch_proxy_requests_by_status{status}`,
`gstitch_proxy_latency_seconds` (histogram: buckets `0.100 0.500 1.000 5.000 30.000 120.000 +Inf`, `_count`, `_sum`).

---

## 6. Environment-variable inventory

**Authoritative source: `index.js` (`CONFIG_KEYS` / `resolveConfigFromEnv`).** The drift test
`test/config.test.js` fails if this table, `.env.example` and the code disagree. Defaults below
are the Phase 5 values, which encode the owner decisions in §12.

### Server and upstream

| Var                      | Default                             | Notes                                                            |
| ------------------------ | ----------------------------------- | ---------------------------------------------------------------- |
| `MCP_SERVER_PORT`        | `8787`                              | `.env.example` uses `8787`; the README historically showed 11401 |
| `MCP_SERVER_HOST`        | `0.0.0.0`                           | **owner decision 1** — LAN reachable                             |
| `STITCH_URL`             | `https://stitch.googleapis.com/mcp` |                                                                  |
| `STITCH_API_KEY`         | _(unset)_                           | env fallback credential                                          |
| `STITCH_PROJECT_ID`      | _(unset)_                           | used for log attribution and `X-Stitch-Project-Id`               |
| `ENABLE_GCLOUD_FALLBACK` | `0`                                 | `gcloud auth print-access-token`                                 |

### Request handling and streaming

| Var                            | Default    | Notes                                      |
| ------------------------------ | ---------- | ------------------------------------------ |
| `REQUEST_TIMEOUT_MS`           | `120000`   | upstream **headers** deadline              |
| `MAX_BODY_SIZE_BYTES`          | `10485760` | enforced before the credential check (★N2) |
| `SERVER_HEADERS_TIMEOUT_MS`    | `60000`    | explicit socket timeout (★S6)              |
| `SERVER_KEEP_ALIVE_TIMEOUT_MS` | `5000`     | explicit socket timeout (★S6)              |
| `SHUTDOWN_DRAIN_MS`            | `15000`    | graceful drain budget                      |
| `STREAM_IDLE_TIMEOUT_MS`       | `60000`    | longest silence between chunks (★S1)       |
| `STREAM_MAX_DURATION_MS`       | `1800000`  | absolute stream cap (★S1)                  |

### Resilience

| Var                            | Default        | Notes                                               |
| ------------------------------ | -------------- | --------------------------------------------------- |
| `UPSTREAM_RETRY_ENABLED`       | `true`         |                                                     |
| `UPSTREAM_RETRY_ATTEMPTS`      | `3`            |                                                     |
| `UPSTREAM_RETRY_BASE_DELAY_MS` | `250`          | full-jitter backoff base                            |
| `MAX_CONCURRENT_UPSTREAM`      | `32`           | 0 disables the cap (★S6)                            |
| `CONCURRENCY_QUEUE_WAIT_MS`    | `10000`        | then `503` + `Retry-After`                          |
| `LOCAL_FALLBACK_METHODS`       | `prompts/list` |                                                     |
| `SAFE_TOOLS`                   | _(empty)_      | extra read-only tools; overrides the built-in table |
| `UNSAFE_TOOLS`                 | _(empty)_      | force tools to unsafe so they are never retried     |

### Idempotency (ADR 0003)

| Var                      | Default    | Notes                                                     |
| ------------------------ | ---------- | --------------------------------------------------------- |
| `UNSAFE_MAX_DURATION_MS` | `600000`   | **owner decision 4** — 10 min background limit            |
| `REPLAY_WINDOW_MS`       | `600000`   | **owner decision 4** — 10 min replay window               |
| `REPLAY_MAX_ENTRIES`     | `200`      | LRU cap                                                   |
| `REPLAY_MAX_TOTAL_BYTES` | `33554432` | byte cap                                                  |
| `ANNOTATE_TOOLS`         | `true`     | inject `readOnlyHint`/`destructiveHint` into `tools/list` |

### Security (ADR 0005)

| Var                  | Default   | Notes                                                                              |
| -------------------- | --------- | ---------------------------------------------------------------------------------- |
| `CORS_ORIGIN`        | _(empty)_ | **owner decision 2** — no wildcard; private-network origins only. `*` opts back in |
| `ALLOWED_ORIGINS`    | _(empty)_ | extra origins beyond the private-network default                                   |
| `ALLOWED_HOSTS`      | _(empty)_ | extra Host values; `*` accepts any Host                                            |
| `TRUST_PROXY`        | `false`   | trust `X-Forwarded-For` (★N4)                                                      |
| `PUBLIC_BASE_URL`    | _(empty)_ | base URL advertised by the OAuth stubs; empty derives it from the request (★N10)   |
| `RATE_LIMIT_ENABLED` | `true`    | **owner decision 5**                                                               |
| `RATE_LIMIT_MAX_RPS` | `100`     | **owner decision 5** — generous                                                    |
| `RATE_LIMIT_BURST`   | `200`     | **owner decision 5** — generous                                                    |

### Metrics and logging

| Var                         | Default                                                            | Notes                                             |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| `METRICS_ENABLED`           | `true`                                                             |                                                   |
| `LOG_ENABLED`               | `false`                                                            | `.env.example` ships `true` for a dev box         |
| `LOG_LEVEL`                 | `info`                                                             | `debug` adds per-request files and stream capture |
| `LOG_DIR`                   | `logs`                                                             | resolved against the process CWD (known issue)    |
| `LOG_FILE_NAME`             | `proxy.log`                                                        |                                                   |
| `LOG_MAX_BODY_CHARS`        | `20000`                                                            | also caps stream capture (★S3)                    |
| `LOG_MAX_FILE_SIZE_BYTES`   | `5242880`                                                          |                                                   |
| `LOG_MAX_ROTATED_FILES`     | `5`                                                                |                                                   |
| `LOG_SKIP_MCP_GET`          | `true`                                                             |                                                   |
| `LOG_SKIP_MCP_METHODS`      | `initialize,notifications/initialized,notifications/progress,ping` |                                                   |
| `LOG_SLOW_REQUEST_MS`       | `2000`                                                             |                                                   |
| `LOG_VERY_SLOW_REQUEST_MS`  | `5000`                                                             |                                                   |
| `LOG_VIEWER_ENABLED`        | `true`                                                             | now covers `/api/logs*` too (★N1)                 |
| `LOG_VIEWER_MAX_FILE_BYTES` | `10485760`                                                         |                                                   |
| `LOG_SUMMARY_MAX_LINES`     | `200`                                                              |                                                   |

### Removed

| Var                             | Why                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALLOW_ENV_API_KEY_FOR_BROWSER` | Removed in Phase 5. The origin allow-list refuses the public internet before credentials are considered, so the knob had no remaining meaning. |

---

## 7. Request classification table (source of truth — **finalised in Phase 3**, code: `src/mcp/classify.js`)

Classification decides **retry safety**, **in-flight coalescing**, **orphan capture** and
**annotation injection**. Unknown ⇒ **unsafe**.

| Class  | JSON-RPC method / tool                                                           | Rationale                            |
| ------ | -------------------------------------------------------------------------------- | ------------------------------------ |
| safe   | `initialize`                                                                     | version negotiation, no side effects |
| safe   | `ping`                                                                           | liveness                             |
| safe   | `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`       | discovery                            |
| safe   | `notifications/initialized`, `notifications/progress`, `notifications/cancelled` | no upstream effect                   |
| safe   | `tools/call` → `list_projects`                                                   | read                                 |
| safe   | `tools/call` → `get_project`                                                     | read                                 |
| safe   | `tools/call` → `list_screens`                                                    | read                                 |
| safe   | `tools/call` → `get_screen`                                                      | read                                 |
| safe   | `tools/call` → `list_design_systems`                                             | read                                 |
| unsafe | `tools/call` → `create_project`                                                  | creates a project (quota)            |
| unsafe | `tools/call` → `create_design_system`                                            | creates assets                       |
| unsafe | `tools/call` → `update_design_system`                                            | mutates                              |
| unsafe | `tools/call` → `apply_design_system`                                             | mutates                              |
| unsafe | `tools/call` → `create_screen`                                                   | creates a screen                     |
| unsafe | `tools/call` → `edit_screens`                                                    | mutates screens                      |
| unsafe | `tools/call` → `generate_screen_from_text`                                       | generation quota                     |
| unsafe | `tools/call` → `generate_variants`                                               | generation quota                     |
| unsafe | **any unknown tool**                                                             | conservative default                 |
| unsafe | **any JSON-RPC array (batch)**                                                   | most-unsafe element wins             |

---

## 8. Decisions (ADRs)

| ADR                                                | Title                                         | Status                 |
| -------------------------------------------------- | --------------------------------------------- | ---------------------- |
| [0001](docs/adr/0001-language-and-typechecking.md) | Language & type checking: keep JS + `checkJs` | **Accepted** (Phase 0) |
| [0002](docs/adr/0002-module-layout.md)             | Module layout                                 | **Accepted** (Phase 2) |
| [0003](docs/adr/0003-idempotency.md)               | Idempotency & retry safety                    | **Accepted** (Phase 3) |
| [0004](docs/adr/0004-streaming.md)                 | Streaming and upstream I/O                    | **Accepted** (Phase 4) |
| [0005](docs/adr/0005-security.md)                  | Security model                                | **Accepted** (Phase 5) |
| [0006](docs/adr/0006-tooling.md)                   | Tooling and CI                                | **Accepted** (Phase 7) |
| 0004                                               | Streaming                                     | Phase 4                |
| 0005                                               | Security model                                | Phase 5                |
| 0006                                               | Tooling & CI                                  | Phase 7                |

See **[ADR 0001](docs/adr/0001-language-and-typechecking.md)** — accepted in Phase 0: keep
CommonJS JavaScript with `// @ts-check` + JSDoc and `tsc --noEmit --checkJs`, rather than
migrating to TypeScript. The project's headline property is "copy one file and run"
(`node index.js`, no build step); a TS migration would add a build step and a runtime-artifact
question for the Docker/systemd units. `checkJs` gives most of the safety without breaking it.

---

## 9. Verified facts (spec @ 2026-10-17)

Source: `modelcontextprotocol/modelcontextprotocol`, `docs/specification/**`, `schema/**`.
**context7 was unavailable; these came from the spec source text.**

### Streamable HTTP — protocol `2026-07-28` (latest)

- Every JSON-RPC message from client **MUST** be a new HTTP **POST** to the MCP endpoint.
- Body **MUST** be a **single** JSON-RPC request or notification. **Batching is not part of the spec.**
- Client **MUST** send `Accept: application/json, text/event-stream`.
- Notification body ⇒ server **MUST** return **`202 Accepted` with no body**.
- Request body ⇒ server **MUST** return either `Content-Type: application/json` (single object)
  or `Content-Type: text/event-stream` (SSE stream).
- Servers **MUST** validate the `Origin` header on all incoming connections (DNS rebinding).
  If `Origin` is present and invalid ⇒ **`403 Forbidden`**; body **MAY** be a JSON-RPC error response **with no `id`**.
- Servers **SHOULD** bind only to **localhost (127.0.0.1)** rather than `0.0.0.0`.
- Servers **SHOULD** implement proper authentication for **all** connections.
- Every POST **MUST** include **`MCP-Protocol-Version`**.
- **`Mcp-Method`** header mirrors body `method` — **REQUIRED for all requests**.
- **`Mcp-Name`** header mirrors `params.name`/`params.uri` — **REQUIRED for `tools/call`, `resources/read`, `prompts/get`**.
- Values that aren't safe ASCII are Base64-sentinel encoded (`Mcp-Name`, `Mcp-Param-{Name}`).
- Header/body mismatch ⇒ **`400`** + JSON-RPC code **`-32020` (`HeaderMismatch`)**.
- Unknown method ⇒ **`404`** + JSON-RPC **`-32601`**.
- SSE responses **SHOULD** carry `X-Accel-Buffering: no`.
- **Removed in 2026-07-28:** GET stream endpoint, `Mcp-Session-Id` sessions + DELETE,
  resumable streams via `Last-Event-ID`, `notifications/cancelled` over Streamable HTTP
  (closing the SSE stream _is_ the cancellation signal).

### Backward compatibility (what a proxy must tolerate)

- `2025-03-26` … `2025-11-25` **also** used Streamable HTTP: sessions via `Mcp-Session-Id`
  (+ HTTP DELETE), standalone GET SSE stream, server→client JSON-RPC requests on SSE,
  `Last-Event-ID` resumability.
- A server supporting only 2026-07-28 that receives older traffic **SHOULD**:
  - GET or DELETE on the MCP endpoint ⇒ **`405 Method Not Allowed`**;
  - an `Mcp-Session-Id` header ⇒ **ignore it**, do not mint or echo session IDs;
  - a `Last-Event-ID` header ⇒ **ignore it**, streams are not resumable.
- Protocol `2025-06-18`: client **MUST** include `MCP-Protocol-Version` on all subsequent
  requests; if absent the server **SHOULD** assume `2025-03-26`; if invalid ⇒ **`400`**.
- HTTP+SSE (`2024-11-05`) is **Deprecated** since `2025-03-26`.

### Tool annotations (`ToolAnnotations`)

All properties are **hints**, and the spec explicitly warns: _"Clients should never make tool use
decisions based on `ToolAnnotations` received from untrusted servers."_

| Field             | Default | Meaning                                                                         |
| ----------------- | ------- | ------------------------------------------------------------------------------- |
| `title`           | —       | human-readable title                                                            |
| `readOnlyHint`    | `false` | tool does not modify its environment                                            |
| `destructiveHint` | `true`  | may perform destructive updates (only meaningful when `readOnlyHint === false`) |
| `idempotentHint`  | `false` | repeating with same args has no additional effect                               |
| `openWorldHint`   | `true`  | may interact with an open world of external entities                            |

Display-name precedence: `title`, then `annotations.title`, then `name`.

### Header forwarding policy for this proxy (derived)

**Request → upstream (`MCP-Protocol-Version`, `Mcp-Session-Id`, `Last-Event-ID` were all dropped at baseline):**

`MCP-Protocol-Version`, `Mcp-Session-Id`, `Last-Event-ID`, `Mcp-Method`, `Mcp-Name`,
`Mcp-Param-*`, `Accept`, `Content-Type`, plus credentials (`Authorization`, `X-Goog-Api-Key`,
`X-Stitch-Project-Id`).

**Upstream → client (`Mcp-Session-Id`, `Retry-After`, `WWW-Authenticate` were all dropped at baseline):**

`Content-Type`, `MCP-Protocol-Version`, `Mcp-Session-Id`, `Last-Event-ID`, `Retry-After`,
`WWW-Authenticate`, `X-Accel-Buffering`, `Cache-Control`.

---

## 10. Audit findings — reproduction status

★ = required a scripted fake upstream. All reproductions below were executed on
2026-10-17 against `2578c26` with Node `v26.3.0` and a local fake upstream.

### 10.1 Critical

| ID  | Reproduced                                                            | Evidence (actual observed output)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Regression test                                                                                                                            |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| ★C1 | ✅ **YES** (fixed)                                                    | Fake upstream that resets the socket after receiving a `tools/call create_project`: upstream **received `create_project` 3 times** (`{"count":3,...}`). Client got `502 {"code":-32006,"message":"...fetch failed (ECONNRESET)"}`.                                                                                                                                                                                                                                                                                                                      | **FIXED `b96e3e7`** — 12 end-to-end tests in `test/phase3.test.js`; upstream now receives it **exactly once** and the client gets `-32008` |
| ★C2 | ✅ **YES**                                                            | `printf 'GET /health HTTP/1.1\r\nHost: [bad\r\n\r\n' \| nc 127.0.0.1 8799` ⇒ process **died** (`ERR_INVALID_URL`, `base: 'http://[bad'`, `Node.js v26.3.0` on stdout, port no longer listening).                                                                                                                                                                                                                                                                                                                                                        | **FIXED `dfd243c`** — 6 tests in `test/phase1.test.js`; verified with 50 malformed Hosts in a row                                          |
| ★C3 | ✅ **YES** (read path proven; write path follows from identical code) | Preflight/actual request from `Origin: https://evil.example` ⇒ `Access-Control-Allow-Origin: *`; `POST /token` with **no credentials** ⇒ `{"access_token":"local-proxy-token"}`.                                                                                                                                                                                                                                                                                                                                                                        | → Phase 5                                                                                                                                  |
| ★C4 | ✅ **YES**                                                            | `GET /api/logs` with `Origin: https://evil.example` ⇒ **200** + `access-control-allow-origin: *` (log dir listing, project IDs, sizes). `/health` also 200 with no auth.                                                                                                                                                                                                                                                                                                                                                                                | → Phase 5                                                                                                                                  |
| ★C5 | ✅ **YES**                                                            | **NEW (found in Phase 0).** A normal streamed (SSE) response **crashes the process**. The streaming branch ends without a `return`, so control falls through to the trailing `sendJson(res, 404, …)`, which throws `ERR_HTTP_HEADERS_SENT` as an unhandled rejection. Reproduced against a baseline worktree at `2578c26`: one POST that received `Content-Type: text/event-stream` ⇒ `throw new ERR_HTTP_HEADERS_SENT('write')` at `index.js:1849` ⇒ process gone (port refused afterwards). Every real Stitch call that streams would kill the proxy. | **Fixed in Phase 0** (missing `return`); regression test `★C5` is active and passing.                                                      |

### 10.2 Protocol correctness

| ID  | Reproduced     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                          | Regression test                                                                                                           |
| --- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| ★P1 | ✅ **YES**     | Client sent `MCP-Protocol-Version: 2025-06-18`, `Mcp-Session-Id: client-sess-1`, `Last-Event-ID: 42`. Upstream received **only** `x-goog-api-key`, `content-type`, `accept`, `accept-language`, `accept-encoding` — all three MCP headers **absent**. Upstream replied with `Mcp-Session-Id`, `MCP-Protocol-Version`, `Retry-After: 7`, `WWW-Authenticate`; the client received **only** `Content-Type` (+ CORS). | **FIXED `dfd243c`** — 5 tests; explicit request/response allow-lists                                                      |
| ★P2 | ✅ **YES**     | 413 path: body contained `"id":55`, response was `{"jsonrpc":"2.0","error":{"code":-32007,...},"id":null}` (`id` lost). Same shape on the 401 and 502 paths.                                                                                                                                                                                                                                                      | **FIXED `dfd243c`** — 7 tests incl. `id:0`, string ids and arrays                                                         |
| P3  | read-only      | `buildLocalFallbackResponse` returns `null` for arrays; `parseJsonRpcMetadata` handles them for logging but classification/logging assume a single method. Spec confirms batching is **not** part of MCP ⇒ pass through unchanged, but classify by the most-unsafe element.                                                                                                                                       | **FIXED `b96e3e7`** — `classifyRequest` reduces a batch to its most unsafe element, and `rewriteJsonRpcId` handles arrays |
| P4  | not reproduced | `emptyResults` has entries for `resources/list` and `resources/templates/list`, but `LOCAL_FALLBACK_METHODS` defaults to `prompts/list` only. Whether Stitch implements the others is **unknown** → `scripts/live-probe.js` (written; `npm run probe:live -- --i-understand`), owner key required.                                                                                                                | Phase 7                                                                                                                   |
| P5  | read-only      | `notifications/cancelled` is forwarded upstream but never aborts the in-flight upstream request. Note: on Streamable HTTP ≥ 2026-07-28 cancellation _is_ stream closure, so the proxy's own client-close handling is the primary mechanism.                                                                                                                                                                       | Phase 3                                                                                                                   |

### 10.3 Streaming and resource handling

| ID  | Reproduced | Evidence                                                                                                                                                                                                                                                                                                 | Regression test                                                                               |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| ★S1 | ✅ **YES** | `REQUEST_TIMEOUT_MS=2000`; client POSTed at a never-ending SSE upstream and aborted at **600 ms**. At **+6.6 s** the upstream TCP connection was still `ESTAB` (`127.0.0.1:8812 ↔ 127.0.0.1:35890`), held open by the proxy. Neither the headers timeout nor the client-close listener aborted the body. | Phase 4                                                                                       |
| S2  | read-only  | `res.write(chunk)` return value ignored in the stream loop ⇒ unbounded buffering for a slow client.                                                                                                                                                                                                      | Phase 4                                                                                       |
| S3  | read-only  | `const streamChunks = []` + `streamChunks.push(chunk)` run unconditionally, even when `LOG_ENABLED=false` or `LOG_LEVEL!=debug`.                                                                                                                                                                         | Phase 4                                                                                       |
| ★S4 | ✅ **YES** | 12 sequential keep-alive requests on one socket ⇒ `MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 close listeners added to [Socket].`                                                                                                                                       | **FIXED `dfd243c`** — tracking moved to `server.on("connection")`; 40-request regression test |
| S5  | read-only  | `readSummaryLogLines()` → `fs.readFileSync` of the **whole** file; `appendSummaryLog` → `appendFileSync` + `statSync` + `renameSync`; `scanLogDirectory`/`readLogFile` → sync fs; `getAccessToken()` → `execSync("gcloud auth print-access-token")`.                                                     | Phase 4                                                                                       |
| S6  | read-only  | `requestTimeout`/`headersTimeout`/`keepAliveTimeout` left at Node defaults (300 s/60 s/5 s); no cap on concurrent upstream requests.                                                                                                                                                                     | Phase 4                                                                                       |

### 10.4 Smaller bugs (all confirmed by reading `index.js`)

| Bug                                                                                        | Location                                                                                                                                                                                                                                                  | Status                                                                                                                           |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| ★N3 `HEAD /health` ⇒ **404** (only `GET` matches)                                          | `index.js:1978`                                                                                                                                                                                                                                           | ✅ reproduced (`HEAD /health -> 404`, `GET /health -> 200`); **FIXED `dfd243c`** (also `/metrics`, `/instructions`)              |
| `getClientIp` trusts `X-Forwarded-For` unconditionally                                     | `index.js:601`                                                                                                                                                                                                                                            | confirmed                                                                                                                        |
| Per-project debug logs use `DEFAULT_STITCH_PROJECT_ID`, never `params.arguments.projectId` | `index.js:794` callers                                                                                                                                                                                                                                    | confirmed                                                                                                                        |
| Catch-block debug log passes `requestBody: undefined`                                      | `index.js:~2560`                                                                                                                                                                                                                                          | confirmed                                                                                                                        |
| `console.warn("No project ID configured…")` fires **every** request                        | `index.js:2273`                                                                                                                                                                                                                                           | ✅ observed; **FIXED `dfd243c`** (once per process, ★N7)                                                                         |
| `test.sh` prints the API key                                                               | `test.sh:22`                                                                                                                                                                                                                                              | confirmed                                                                                                                        |
| `INSTRUCTIONS.md` / `LOG_DIR` resolve against `process.cwd()`                              | `index.js:44,53`                                                                                                                                                                                                                                          | confirmed                                                                                                                        |
| `.well-known` hardcodes `http://localhost:${port}`                                         | `index.js:1955-1967`                                                                                                                                                                                                                                      | confirmed                                                                                                                        |
| `/token` hands out a static `local-proxy-token` to anyone                                  | `index.js:1974`                                                                                                                                                                                                                                           | ✅ reproduced                                                                                                                    |
| Port inconsistency: code `8787`, `.env.example` `11401`, README mixes both                 | —                                                                                                                                                                                                                                                         | confirmed                                                                                                                        |
| `STITCH_API_KEY` header underscore is dropped by nginx by default                          | README                                                                                                                                                                                                                                                    | documented in Phase 9                                                                                                            |
| No `package.json`, `engines`, lint, tests or CI                                            | —                                                                                                                                                                                                                                                         | fixed in Phase 0/7                                                                                                               |
| ★N1                                                                                        | The "log viewer disabled" guard is `url.pathname.startsWith("/logs")`, which never matches `/api/logs` or `/api/logs/summary` (or the file route). With `LOG_VIEWER_ENABLED=false` the HTML page 404s but the JSON APIs and raw log files stay reachable. | discovered in Phase 0 while writing characterization tests; pinned by `KNOWN GAP: /api/logs* is still served…`; fixed in Phase 5 |
| ★N2                                                                                        | The credential check ran **before** the body reader, so an unauthenticated over-sized body was answered `401` without ever being bounded/read — the 413 size limit was unreachable for unauthenticated callers.                                           | **FIXED `dfd243c`** — body read first through a bounded reader                                                                   |

### 10.5 Idempotency classes

See §7. At baseline the proxy treats every request identically, causing: duplicate side effects
from proxy retries (C1 ★), duplicate generations when the client retries after a 504/abort
(the proxy aborts the upstream request but Stitch keeps working), no in-flight deduplication, and
no annotations to warn clients before unsafe calls.

---

## 11. Known issues / deferred

| Issue                                                   | Why deferred                                                                                                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **context7 unavailable** (`Invalid API key`)            | Used the spec source text + local runtime probes instead. Re-verify with context7 when the key is restored.                                                            |
| P4 — unknown whether Stitch implements `resources/list` | Probe written (`npm run probe:live -- --i-understand`); needs the owner's key. Opt-in only: it refuses to run when `CI` is set, and `test/probe.test.js` asserts that. |
| Live `tools/list` annotations from Stitch are unknown   | Classification currently relies on the built-in table; upstream annotations take precedence once observed.                                                             |

## 12. Owner decisions (answered 2026-10-18)

All six questions are answered. Every answer is implemented and covered by a test in
`test/config.test.js` ("documented defaults match the resolved defaults").

| #   | Question                    | **Decision**                                            | Implementation                                                                                                                   |
| --- | --------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Default bind address?       | **Keep `0.0.0.0`** — LAN computers must reach the proxy | `MCP_SERVER_HOST` default unchanged; compose publishes `8787:8787`; asserted by `deploy.test.js`                                 |
| 2   | `ALLOWED_ORIGINS` default?  | **Must accept LAN computers**                           | Origin policy allows private-network origins and refuses the public internet (ADR 0005). `CORS_ORIGIN` default is empty, not `*` |
| 3   | Require `PROXY_AUTH_TOKEN`? | **No** — LAN-only reachability is the control           | No auth layer. Documented as a deliberate non-goal in `SECURITY.md`                                                              |
| 4   | Unsafe-call windows?        | **10 minutes / 10 minutes**                             | `UNSAFE_MAX_DURATION_MS=600000`, `REPLAY_WINDOW_MS=600000`                                                                       |
| 5   | Rate limiting by default?   | **Yes, generous**                                       | `RATE_LIMIT_ENABLED=true`, `RATE_LIMIT_MAX_RPS=100`, `RATE_LIMIT_BURST=200`                                                      |
| 6   | Language?                   | **JS + `checkJs`** (preserves zero-build)               | ADR 0001; `tsc --noEmit --allowJs --checkJs` in `npm run verify` and CI                                                          |

### Consequence worth stating plainly

Because of decisions 1–3, **any device on the LAN can use the proxy, including with the server's
own `STITCH_API_KEY`**. That is intended. If the LAN is not fully trusted, bind `127.0.0.1` or put
an authenticating reverse proxy in front. This is written down in `SECURITY.md` rather than being
left implicit.

## 12b. Open questions

None. Two findings remain deliberately deferred (see §11) and need no decision.

## 13. What landed, phase by phase

| Phase | Commit(s)                                  | Summary                                                                                                                                                                               |
| ----- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | `920b4ee`, `c8940a1`                       | `package.json` (zero runtime deps), ESLint/Prettier/`checkJs`, the `createProxyServer()` seam, fake-upstream harness, 43 characterization tests, 27 findings written as `test.todo()` |
| 1     | `dfd243c`, `78cccf8`, `47e3847`            | ★C2, ★S4, ★N3, ★P2, ★N2, ★P1, ★N7, then ★N5, ★N6, ★N8                                                                                                                                 |
| 2     | `2603fa0` … `6c0be4f`, `59957ff`           | `src/{upstream,mcp,observability,http}` extracted; multi-instance config guard; 50 unit tests                                                                                         |
| 3     | `b96e3e7`, `c42a7b9`, `7f0d3e9`, `4a4e810` | **★C1**: classification, phase-aware retry, `-32008`, coalescing, orphan capture, idempotency keys, `tools/list` annotations                                                          |
| 4     | `558b892`                                  | ★S1, ★S2, ★S3, ★S6: pipeline streaming, three deadlines, bounded concurrency, explicit socket timeouts                                                                                |
| 5     | `5bd3e3d`                                  | ★C3, ★C4, ★N1, ★N4: LAN-aware origin/host policy, scoped CORS, protected viewer, split `/health`, redaction, CSP                                                                      |
| 6     | `f8a1460`                                  | Owner defaults applied; 48-variable inventory with drift tests                                                                                                                        |
| 7–9   | `4e4c06a`                                  | CI on Node 20/22/24, hardened Docker/systemd, README/CHANGELOG/SECURITY/INSTRUCTIONS, ADR 0004 + 0006                                                                                 |
| 10    | final                                      | End-to-end re-verification of all ten reproduced findings; ★S4 found to have been fixed only in appearance, now genuinely fixed                                                       |

## 14. Final verification — before → after

Every row was **reproduced against `2578c26`** and then re-verified end to end against the
finished code.

| Finding                    | Before                                                | After                                                           |
| -------------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| ★C1 duplicate side effects | `create_project` delivered **3×**                     | **1×**, answered `-32008` with "check state before retrying"    |
| ★C2 malformed `Host`       | process **exited** (code 1)                           | `400 -32600`; healthy after 50 malformed requests               |
| ★C3 cross-origin env key   | public origin **200** with the server's key           | public **403**; LAN **200**                                     |
| ★C4 world-readable logs    | `/api/logs` **200** + `ACAO: *`; fat `/health`        | no CORS; non-LAN **403**; `/health` = `{status,version,uptime}` |
| ★C5 streamed response      | process **exited** (`ERR_HTTP_HEADERS_SENT`)          | healthy after streaming                                         |
| ★P1 MCP headers            | all dropped both ways                                 | forwarded both ways                                             |
| ★P2 error id               | `id: null`                                            | `id: 55` echoed                                                 |
| ★S1 unbounded stream       | upstream socket stayed open ≥6.6 s after abort        | ended after **157 ms** at the idle deadline                     |
| ★S4 listener leak          | **41** `close` listeners on one socket, warning at 11 | **2** listeners                                                 |
| ★N3 `HEAD /health`         | **404**                                               | **200**                                                         |
| ★N1 viewer disabled        | `/api/logs*` still reachable                          | every viewer route `404`                                        |
| ★N2 size limit             | unreachable when unauthenticated                      | `413` regardless of auth                                        |
| ★N4 rate-limit bypass      | `X-Forwarded-For` trusted always                      | ignored unless `TRUST_PROXY`                                    |
| ★N5 log attribution        | everything in `unknown-project/`                      | `arguments.projectId` used                                      |
| ★N6 error log body         | `requestBody: undefined`                              | body retained                                                   |
| ★N8 `test.sh`              | printed the key                                       | prints `configured`/`missing`                                   |
| ★N9 path resolution        | broke when started elsewhere                          | resolved against `__dirname`                                    |
| ★N10 discovery URL         | hard-coded `localhost:<port>`                         | `PUBLIC_BASE_URL` or the request origin                         |
| ★N11 `/token`              | undocumented static token                             | documented non-auth placeholder, proven inert                   |

## 15. Test suite

| File                            | Tests  | Covers                                                                                  |
| ------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| `test/characterization.test.js` | 39     | every route, credential precedence, fallbacks, CORS, metrics text, logging              |
| `test/phase1.test.js`           | 29     | ★C2, ★S4, ★N3, ★P2, ★N2, ★P1                                                            |
| `test/phase1b.test.js`          | 11     | ★N5, ★N6, ★N8                                                                           |
| `test/phase3.test.js`           | 86     | classification, retry phases, coalescing, orphan capture, idempotency keys, annotations |
| `test/phase4.test.js`           | 14     | three deadlines, backpressure, bounded capture, concurrency limiter                     |
| `test/phase5.test.js`           | 41     | origin/host policy, scoped CORS, viewer protection, redaction, ★N9–★N11                 |
| `test/unit.test.js`             | 52     | pure modules: jsonrpc, errors, metrics, respond, security, ratelimit                    |
| `test/config.test.js`           | 13     | config drift, owner defaults, coherence                                                 |
| `test/deploy.test.js`           | 18     | Dockerfile, compose, systemd, docs consistency                                          |
| `test/bugs.test.js`             | 2 todo | P4, S5 — deliberately deferred                                                          |
| `test/probe.test.js`            | 5      | P4 probe safety rails: opt-in flag, CI refusal, key from env only, not wired into CI    |

No test contacts the real Stitch endpoint.

## 16. Next action (exact, for a fresh session)

> **Released.** PR #1 merged `hardening/v1` → `main` on 2026-10-18 (`dd3448e`), the branch was
> deleted, and `v1.0.0` is tagged with `package.json`, `package-lock.json` and `index.js`
> `VERSION` all at `1.0.0`.
>
> Two follow-ups remain:
>
> 1. **Close P4** — run the probe with the owner's key, then replace the `test.todo()` in
>    `test/bugs.test.js` with the observed answer and update §10.2:
>    `STITCH_API_KEY=... npm run probe:live -- --i-understand`
>    Verdicts are `implemented`, `implemented (empty)`, `not implemented (stream reset)` or
>    `not implemented (method not found)`. Only the last two justify a `LOCAL_FALLBACK_METHODS`
>    entry.
> 2. **Close S5** — move the summary-log store and `getAccessToken()` off `readFileSync`/
>    `appendFileSync`/`statSync`/`execSync`. Behaviour must not change; the tests are the guard.
