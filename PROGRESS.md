# PROGRESS LEDGER — gstitch-mcproxy hardening

> **This file is the memory of a long-horizon task.** Read it first, update it last.
> Branch: `hardening/v1` · Baseline: `2578c26` · Never commit to `main`.

---

## 1. Current phase / step / status

| Field | Value |
|---|---|
| Phase | **1 — Crash-proofing and correctness** (started) |
| Step | 1.1 — ★C2 crash-proofing |
| Status | All gates green: `npm test` 43 pass / 27 todo / 0 fail, `npm run lint` clean, `npm run typecheck` clean, `./run.sh` starts + `/health` 200 + clean SIGTERM |
| Started | 2026-10-17 |

## 2. Last green commit

| Field | Value |
|---|---|
| SHA | **`920b4ee`** — `chore: add packaging, test harness and the in-process server seam (phase 0)` |
| test | 43 pass / 27 todo / 0 fail (70 tests) |
| lint | clean |
| typecheck | clean |
| verify | `npm run verify` exits 0 |
| run.sh | starts, `GET /health` ⇒ 200, `SIGTERM` ⇒ clean exit |

## 3. Phase checklist

- [x] **Phase 0** — Baseline, packaging and harness — ✅ `920b4ee`
- [ ] **Phase 1** — Crash-proofing and correctness
- [ ] **Phase 2** — Modularize (pure refactor)
- [ ] **Phase 3** — Idempotency, retry safety and duplicate suppression
- [ ] **Phase 4** — Streaming and upstream I/O
- [ ] **Phase 5** — Security model
- [ ] **Phase 6** — Configuration, observability and lifecycle
- [ ] **Phase 7** — Tooling and CI
- [ ] **Phase 8** — Deployment artifacts
- [ ] **Phase 9** — Documentation
- [ ] **Phase 10** — Final verification and handoff

---

## 4. Environment facts (verified 2026-10-17)

| Fact | Value |
|---|---|
| Node (local) | `v26.3.0` |
| npm (local) | `9.2.0` |
| `AbortSignal.any` | ✅ function (Node ≥ 20.3) |
| `AbortSignal.timeout` | ✅ function |
| `Readable.fromWeb` | ✅ function |
| `stream/promises.pipeline` | ✅ function |
| `server.closeIdleConnections` | ✅ function |
| `server.requestTimeout` default | `300000` |
| `server.headersTimeout` default | `60000` |
| `server.keepAliveTimeout` default | `5000` |
| `--experimental-test-coverage` | ✅ works on Node 26 |
| **`engines.node` decision** | `>=20.3.0` (first version with `AbortSignal.any`) |
| **CI matrix** | 20 / 22 / 24 |

> **context7 was unavailable** during this session (API key rejected: `Invalid API key`).
> Per prime directive #3, protocol facts were verified against the **spec source text** in
> `modelcontextprotocol/modelcontextprotocol` and the runtime behaviour was verified locally.

---

## 5. Route inventory (baseline, verified by reading `index.js` @ `2578c26`)

| Route | Methods | Behaviour | Auth |
|---|---|---|---|
| `/mcp` | POST | Forward to Stitch (retries, fallbacks, streaming) | none |
| `/mcp` | GET | 405 `-32005` "no SSE stream offered" + `Allow: POST, OPTIONS` | none |
| `/mcp` | DELETE | 405 `-32005` "stateless" + `Allow` | none |
| `/mcp` | PUT/PATCH/HEAD | 405 `-32005` | none |
| `/mcp` | OPTIONS | 204 (generic preflight, before routing) | none |
| `/health` | GET | Fat JSON: proxy cfg, credentials, logging, resilience, metrics | **none** |
| `/metrics` | GET | Prometheus text (`METRICS_ENABLED`, default true) | **none** |
| `/instructions` | GET | HTML / JSON / Markdown by `Accept` | **none** |
| `/logs` | GET | Log viewer HTML (`LOG_VIEWER_ENABLED`, default true) | **none** |
| `/api/logs` | GET | Project tree + summary-log stat | **none** |
| `/api/logs/summary` | GET | Paged summary lines (`limit`, `offset`) | **none** |
| `/api/logs/{projectId}/{file}` | GET | Raw log file text | **none** |
| `/.well-known/oauth-protected-resource` | GET | Static stub, hardcodes `http://localhost:${port}` | **none** |
| `/.well-known/openid-configuration` | GET | Static stub, hardcodes `http://localhost:${port}` | **none** |
| `/auth` | GET | `200 "OK"` | **none** |
| `/token` | POST | `{"access_token":"local-proxy-token"}` — **static, anyone** | **none** |
| anything else | any | 404 `-32601` | none |

Ordering note: `OPTIONS` is handled **before** routing, so it returns 204 for *every* path with CORS `*`.
The `/logs*` disabled check happens before the viewer routes but after `/mcp` guard is entered only for `/mcp`.

### JSON-RPC error codes emitted by the proxy

| Code | Meaning | Where |
|---|---|---|
| `-32001` | Invalid Origin header (403) | `validateOrigin` failure |
| `-32002` | Rate limit exceeded (429) | token bucket |
| `-32003` | Request body too large (413) | body reader |
| `-32004` | Upstream request timed out (504) | catch, `AbortError`/`TimeoutError` |
| `-32005` | Method not allowed on `/mcp` (405) | GET/DELETE/other |
| `-32006` | Upstream request to Stitch failed (502) | catch, generic |
| `-32007` | Missing API key (401) | credential check |
| `-32601` | Not found (404) | fallthrough (also spec's "Method not found") |
| _reserved new_ | `-32008` (proposed) | unsafe call, outcome unknown — see ADR 0003 |
| _spec_ | `-32020` | `HeaderMismatch` (2026-07-28 spec) — not emitted by proxy |

### Prometheus metric names (must never be renamed)

`gstitch_proxy_uptime_seconds`, `gstitch_proxy_requests_total`, `gstitch_proxy_errors_total`,
`gstitch_proxy_active_connections`, `gstitch_proxy_rate_limited_total`,
`gstitch_proxy_requests_by_method{method_path}`, `gstitch_proxy_requests_by_status{status}`,
`gstitch_proxy_latency_seconds` (histogram: buckets `0.100 0.500 1.000 5.000 30.000 120.000 +Inf`, `_count`, `_sum`).

---

## 6. Environment-variable inventory (baseline)

| Var | Default in code | Type | Notes |
|---|---|---|---|
| `STITCH_URL` | `https://stitch.googleapis.com/mcp` | url | upstream endpoint |
| `STITCH_API_KEY` | _unset_ | secret | env fallback credential |
| `STITCH_PROJECT_ID` | _unset_ | string | default project id |
| `ENABLE_GCLOUD_FALLBACK` | `0` (compared to `"1"`) | bool | gcloud token fallback |
| `MCP_SERVER_PORT` | `8787` | int | **README/.env.example say 11401** |
| `MCP_SERVER_HOST` | `0.0.0.0` | host | **spec says SHOULD bind loopback** |
| `LOG_ENABLED` | `false` | bool | |
| `LOG_LEVEL` | `info` | enum | `info` \| `debug` |
| `LOG_DIR` | `logs` (vs `cwd`) | path | **breaks when run from another dir** |
| `LOG_FILE_NAME` | `proxy.log` | string | |
| `LOG_MAX_BODY_CHARS` | `20000` | int | |
| `LOG_MAX_FILE_SIZE_BYTES` | `5242880` | int | |
| `LOG_MAX_ROTATED_FILES` | `5` | int | |
| `LOG_SKIP_MCP_GET` | `true` | bool | |
| `LOG_SKIP_MCP_METHODS` | `initialize,notifications/initialized,notifications/progress,ping` | csv | |
| `LOG_SLOW_REQUEST_MS` | `2000` | int | |
| `LOG_VERY_SLOW_REQUEST_MS` | `5000` | int | |
| `REQUEST_TIMEOUT_MS` | `120000` | int | headers timeout only (bug S1) |
| `MAX_BODY_SIZE_BYTES` | `10485760` | int | |
| `UPSTREAM_RETRY_ENABLED` | `true` | bool | |
| `UPSTREAM_RETRY_ATTEMPTS` | `3` | int | |
| `UPSTREAM_RETRY_BASE_DELAY_MS` | `250` | int | no jitter |
| `LOCAL_FALLBACK_METHODS` | `prompts/list` | csv | |
| `RATE_LIMIT_ENABLED` | `false` | bool | |
| `RATE_LIMIT_MAX_RPS` | `10` | int | |
| `RATE_LIMIT_BURST` | `20` | int | |
| `CORS_ORIGIN` | `*` | origin | **`*` = allow all** |
| `METRICS_ENABLED` | `true` | bool | |
| `SHUTDOWN_DRAIN_MS` | `15000` | int | |
| `LOG_VIEWER_ENABLED` | `true` | bool | |
| `LOG_VIEWER_MAX_FILE_BYTES` | `10485760` | int | |
| `LOG_SUMMARY_MAX_LINES` | `200` | int | |

`.env.example` additionally documents nothing that the code lacks; it sets `MCP_SERVER_PORT=11401`
and `MCP_SERVER_HOST='localhost'`, which contradicts the code defaults.

---

## 7. Request classification table (source of truth — draft, finalised in Phase 3)

Classification decides **retry safety**, **in-flight coalescing**, **orphan capture** and
**annotation injection**. Unknown ⇒ **unsafe**.

| Class | JSON-RPC method / tool | Rationale |
|---|---|---|
| safe | `initialize` | version negotiation, no side effects |
| safe | `ping` | liveness |
| safe | `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list` | discovery |
| safe | `notifications/initialized`, `notifications/progress`, `notifications/cancelled` | no upstream effect |
| safe | `tools/call` → `list_projects` | read |
| safe | `tools/call` → `get_project` | read |
| safe | `tools/call` → `list_screens` | read |
| safe | `tools/call` → `get_screen` | read |
| safe | `tools/call` → `list_design_systems` | read |
| unsafe | `tools/call` → `create_project` | creates a project (quota) |
| unsafe | `tools/call` → `create_design_system` | creates assets |
| unsafe | `tools/call` → `update_design_system` | mutates |
| unsafe | `tools/call` → `apply_design_system` | mutates |
| unsafe | `tools/call` → `create_screen` | creates a screen |
| unsafe | `tools/call` → `edit_screens` | mutates screens |
| unsafe | `tools/call` → `generate_screen_from_text` | generation quota |
| unsafe | `tools/call` → `generate_variants` | generation quota |
| unsafe | **any unknown tool** | conservative default |
| unsafe | **any JSON-RPC array (batch)** | most-unsafe element wins |

---

## 8. Decisions (ADRs)

| ADR | Title | Status |
|---|---|---|
| [0001](docs/adr/0001-language-and-typechecking.md) | Language & type checking: keep JS + `checkJs` | **Accepted** (Phase 0) |
| 0002 | Module layout | Phase 2 |
| 0003 | Idempotency & retry safety | Phase 3 |
| 0004 | Streaming | Phase 4 |
| 0005 | Security model | Phase 5 |
| 0006 | Tooling & CI | Phase 7 |

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
  (closing the SSE stream *is* the cancellation signal).

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

All properties are **hints**, and the spec explicitly warns: *"Clients should never make tool use
decisions based on `ToolAnnotations` received from untrusted servers."*

| Field | Default | Meaning |
|---|---|---|
| `title` | — | human-readable title |
| `readOnlyHint` | `false` | tool does not modify its environment |
| `destructiveHint` | `true` | may perform destructive updates (only meaningful when `readOnlyHint === false`) |
| `idempotentHint` | `false` | repeating with same args has no additional effect |
| `openWorldHint` | `true` | may interact with an open world of external entities |

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

| ID | Reproduced | Evidence (actual observed output) | Regression test |
|---|---|---|---|
| ★C1 | ✅ **YES** | Fake upstream that resets the socket after receiving a `tools/call create_project`: upstream **received `create_project` 3 times** (`{"count":3,...}`). Client got `502 {"code":-32006,"message":"...fetch failed (ECONNRESET)"}`. | `test/bugs.test.js` → Phase 3 |
| ★C2 | ✅ **YES** | `printf 'GET /health HTTP/1.1\r\nHost: [bad\r\n\r\n' \| nc 127.0.0.1 8799` ⇒ process **died** (`ERR_INVALID_URL`, `base: 'http://[bad'`, `Node.js v26.3.0` on stdout, port no longer listening). | `test/bugs.test.js` → Phase 1 |
| ★C3 | ✅ **YES** (read path proven; write path follows from identical code) | Preflight/actual request from `Origin: https://evil.example` ⇒ `Access-Control-Allow-Origin: *`; `POST /token` with **no credentials** ⇒ `{"access_token":"local-proxy-token"}`. | → Phase 5 |
| ★C4 | ✅ **YES** | `GET /api/logs` with `Origin: https://evil.example` ⇒ **200** + `access-control-allow-origin: *` (log dir listing, project IDs, sizes). `/health` also 200 with no auth. | → Phase 5 |
| ★C5 | ✅ **YES** | **NEW (found in Phase 0).** A normal streamed (SSE) response **crashes the process**. The streaming branch ends without a `return`, so control falls through to the trailing `sendJson(res, 404, …)`, which throws `ERR_HTTP_HEADERS_SENT` as an unhandled rejection. Reproduced against a baseline worktree at `2578c26`: one POST that received `Content-Type: text/event-stream` ⇒ `throw new ERR_HTTP_HEADERS_SENT('write')` at `index.js:1849` ⇒ process gone (port refused afterwards). Every real Stitch call that streams would kill the proxy. | **Fixed in Phase 0** (missing `return`); regression test `★C5` is active and passing. |

### 10.2 Protocol correctness

| ID | Reproduced | Evidence | Regression test |
|---|---|---|---|
| ★P1 | ✅ **YES** | Client sent `MCP-Protocol-Version: 2025-06-18`, `Mcp-Session-Id: client-sess-1`, `Last-Event-ID: 42`. Upstream received **only** `x-goog-api-key`, `content-type`, `accept`, `accept-language`, `accept-encoding` — all three MCP headers **absent**. Upstream replied with `Mcp-Session-Id`, `MCP-Protocol-Version`, `Retry-After: 7`, `WWW-Authenticate`; the client received **only** `Content-Type` (+ CORS). | Phase 1 |
| ★P2 | ✅ **YES** | 413 path: body contained `"id":55`, response was `{"jsonrpc":"2.0","error":{"code":-32007,...},"id":null}` (`id` lost). Same shape on the 401 and 502 paths. | Phase 1 |
| P3 | read-only | `buildLocalFallbackResponse` returns `null` for arrays; `parseJsonRpcMetadata` handles them for logging but classification/logging assume a single method. Spec confirms batching is **not** part of MCP ⇒ pass through unchanged, but classify by the most-unsafe element. | Phase 3 |
| P4 | not reproduced | `emptyResults` has entries for `resources/list` and `resources/templates/list`, but `LOCAL_FALLBACK_METHODS` defaults to `prompts/list` only. Whether Stitch implements the others is **unknown** → `scripts/live-probe.js` (Phase 7), owner key required. | Phase 7 |
| P5 | read-only | `notifications/cancelled` is forwarded upstream but never aborts the in-flight upstream request. Note: on Streamable HTTP ≥ 2026-07-28 cancellation *is* stream closure, so the proxy's own client-close handling is the primary mechanism. | Phase 3 |

### 10.3 Streaming and resource handling

| ID | Reproduced | Evidence | Regression test |
|---|---|---|---|
| ★S1 | ✅ **YES** | `REQUEST_TIMEOUT_MS=2000`; client POSTed at a never-ending SSE upstream and aborted at **600 ms**. At **+6.6 s** the upstream TCP connection was still `ESTAB` (`127.0.0.1:8812 ↔ 127.0.0.1:35890`), held open by the proxy. Neither the headers timeout nor the client-close listener aborted the body. | Phase 4 |
| S2 | read-only | `res.write(chunk)` return value ignored in the stream loop ⇒ unbounded buffering for a slow client. | Phase 4 |
| S3 | read-only | `const streamChunks = []` + `streamChunks.push(chunk)` run unconditionally, even when `LOG_ENABLED=false` or `LOG_LEVEL!=debug`. | Phase 4 |
| ★S4 | ✅ **YES** | 12 sequential keep-alive requests on one socket ⇒ `MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 close listeners added to [Socket].` | Phase 1 |
| S5 | read-only | `readSummaryLogLines()` → `fs.readFileSync` of the **whole** file; `appendSummaryLog` → `appendFileSync` + `statSync` + `renameSync`; `scanLogDirectory`/`readLogFile` → sync fs; `getAccessToken()` → `execSync("gcloud auth print-access-token")`. | Phase 4 |
| S6 | read-only | `requestTimeout`/`headersTimeout`/`keepAliveTimeout` left at Node defaults (300 s/60 s/5 s); no cap on concurrent upstream requests. | Phase 4 |

### 10.4 Smaller bugs (all confirmed by reading `index.js`)

| Bug | Location | Status |
|---|---|---|
| ★ `HEAD /health` ⇒ **404** (only `GET` matches) | `index.js:1978` | ✅ reproduced (`HEAD /health -> 404`, `GET /health -> 200`) |
| `getClientIp` trusts `X-Forwarded-For` unconditionally | `index.js:601` | confirmed |
| Per-project debug logs use `DEFAULT_STITCH_PROJECT_ID`, never `params.arguments.projectId` | `index.js:794` callers | confirmed |
| Catch-block debug log passes `requestBody: undefined` | `index.js:~2560` | confirmed |
| `console.warn("No project ID configured…")` fires **every** request | `index.js:2273` | ✅ observed: `⚠️ No project ID configured…` printed after a single request |
| `test.sh` prints the API key | `test.sh:22` | confirmed |
| `INSTRUCTIONS.md` / `LOG_DIR` resolve against `process.cwd()` | `index.js:44,53` | confirmed |
| `.well-known` hardcodes `http://localhost:${port}` | `index.js:1955-1967` | confirmed |
| `/token` hands out a static `local-proxy-token` to anyone | `index.js:1974` | ✅ reproduced |
| Port inconsistency: code `8787`, `.env.example` `11401`, README mixes both | — | confirmed |
| `STITCH_API_KEY` header underscore is dropped by nginx by default | README | documented in Phase 9 |
| No `package.json`, `engines`, lint, tests or CI | — | fixed in Phase 0/7 |
| ★N1 | The "log viewer disabled" guard is `url.pathname.startsWith("/logs")`, which never matches `/api/logs` or `/api/logs/summary` (or the file route). With `LOG_VIEWER_ENABLED=false` the HTML page 404s but the JSON APIs and raw log files stay reachable. | discovered in Phase 0 while writing characterization tests; pinned by `KNOWN GAP: /api/logs* is still served…`; fixed in Phase 5 |
| ★N2 | The credential check runs **before** the body reader, so an unauthenticated over-sized body is answered `401` without ever being bounded/read — the 413 size limit is unreachable for unauthenticated callers. | discovered in Phase 0; pinned by `KNOWN GAP: an over-sized body from an unauthenticated caller…`; fixed in Phase 1 |

### 10.5 Idempotency classes

See §7. At baseline the proxy treats every request identically, causing: duplicate side effects
from proxy retries (C1 ★), duplicate generations when the client retries after a 504/abort
(the proxy aborts the upstream request but Stitch keeps working), no in-flight deduplication, and
no annotations to warn clients before unsafe calls.

---

## 11. Known issues / deferred

| Issue | Why deferred |
|---|---|
| **context7 unavailable** (`Invalid API key`) | Used the spec source text + local runtime probes instead. Re-verify with context7 when the key is restored. |
| P4 — unknown whether Stitch implements `resources/list` | Needs a live probe with the owner's key, which must be opt-in. |
| Live `tools/list` annotations from Stitch are unknown | Classification currently relies on the built-in table; upstream annotations take precedence once observed. |

## 12. Questions for the owner

These are **irreversible / default-changing decisions** that will not be applied without an answer.
Backward-compatible opt-in implementations proceed meanwhile.

1. **Bind address.** Default `127.0.0.1` instead of `0.0.0.0`? (Spec says servers *SHOULD* bind loopback. LAN setups would need `MCP_SERVER_HOST=0.0.0.0`.)
2. **Origins + env key.** Default `ALLOWED_ORIGINS` no longer `*`, and stop the env-key fallback for browser-origin requests?
3. **Proxy auth.** Require `PROXY_AUTH_TOKEN` (or refuse to start) when bound to a non-loopback address with an env API key configured?
4. **Unsafe-call windows.** Orphaned-result replay window and max background duration (proposed **10 min / 10 min**)?
5. **Defaults now off.** Enable rate limiting by default with a generous limit? Log viewer off by default in Docker?
6. **Language.** JS + `checkJs` (recommended, preserves zero-build) vs migrating to TypeScript?

## 13. Phase 0 — what landed

| Item | Detail |
|---|---|
| Branch | `hardening/v1` (from `main` @ `2578c26`) |
| `package.json` | `private`, `type: commonjs`, `engines.node >=20.3.0`, scripts `start`/`test`/`test:coverage`/`lint`/`format`/`format:check`/`typecheck`/`verify`. **No runtime dependencies.** Dev-only: `eslint`, `@eslint/js`, `globals`, `prettier`, `typescript`, `@types/node`. |
| `eslint.config.js` | Flat config, `js.configs.recommended` + node globals. `no-console` off, `no-unused-vars` strict with `^_` escape, `prefer-const` on. |
| `tsconfig.json` | `allowJs` + `checkJs`, `noEmit`, `strict: false` (the baseline file is annotated only where it matters), `types: ["node"]`. |
| `.prettierrc` | `printWidth: 100`, `proseWrap: preserve`. `index.js` is **not** reformatted (keeps the Phase 0 diff reviewable). |
| **The seam** | `applyConfig(env, overrides)` + `resolveConfigFromEnv` + `CONFIG_KEYS` + `assignConfig` + `getConfig`; `createState()`; module-level `state` pointer holding `metrics`, `activeConnections`, `rateLimitBuckets`, `tokenCache`, `isShuttingDown`, `warnings`; `handleRequest(req, res)`; `createProxyServer(options)`; `logStartupBanner()`; `logCredentialGuidance()`. `listen()` now happens **only** when `require.main === module`. |
| Deliberate Phase 0 behaviour fixes | (a) ★C5 missing `return` in the streaming branch — this was a process-killing crash; (b) the two credential guidance messages moved from module load to the entry point so they no longer print before the config is resolved; (c) `let projectId` → `const projectId` (never reassigned); (d) ESLint-driven cleanups (`for…of Object.keys`, regex disables, exported `readRequestBody`). |
| Harness | `test/helpers/fakeStitch.js` (scripted upstream: `json`, `sse`, `resetAfterReceive`, `hang`, `delay`, `status`, `refuse`; records every request) and `test/helpers/startProxy.js` (in-process, ephemeral port, injected config). |
| `test/characterization.test.js` | 43 active tests pinning every route, credential precedence, the `prompts/list` fallback, 405s, 413, 429, path traversal, metrics text, CORS, origin validation, upstream request/response shapes, streaming and logging. |
| `test/bugs.test.js` | 2 active ★C5 regression tests + **27 `test.todo()`** entries for the still-open findings. |
| Gate evidence | `npm test` → 70 tests: **43 pass, 27 todo, 0 fail**. `npm run lint` → clean. `npm run typecheck` → clean. `npm run verify` → exit 0. `./run.sh` → starts, `GET /health` ⇒ 200, `SIGTERM` ⇒ clean exit. |

### Note on the test-process model

`node:test` runs each **test file** in its own process, which matters because the Phase 0 seam
keeps configuration in module-level bindings: only the most recently created proxy's config is
active per process. Tests needing different configurations therefore live in different files
(or pass `overrides` to `createProxyServer`, which is what `startProxy()` does per test).
Phase 2 removes the restriction by moving the config onto the instance.

### Live instance warning

A **user-owned proxy instance is running** on `192.168.178.94:11401` (from the user's `.env`,
`MCP_SERVER_HOST='latitude'`). Do not bind or disturb port 11401; use a different port when
verifying `./run.sh`.

---

## 14. Next action (exact, for a fresh session)

> **Phase 1 — Crash-proofing and correctness.** All work in `hardening/v1`; each item is
> `promote its ★ todo to a real test` → `fix` → `npm run verify` → `commit`.
>
> 1. **★C2 (crash-proofing).** Build the request URL from a constant base
>    (`new URL(req.url, "http://localhost")`) and validate `Host` separately against an
>    allow-list. Wrap the whole handler so it *always* answers with JSON-RPC `-32603` on an
>    unexpected throw. Add `server.on("clientError")`. Add
>    `process.on("unhandledRejection")` / `("uncaughtException")` that log rather than exit
>    (only genuinely fatal errors may exit). Test: `Host: [bad` ⇒ the process survives and the
>    client gets a JSON-RPC error.
> 2. **★S4 (listener leak).** Move `trackConnection` to `server.on("connection")`. Test: 20
>    keep-alive requests on one socket produce no `MaxListenersExceededWarning`.
> 3. **★N3.** Support `HEAD` on `/health` and `/instructions`; switch the Docker and
>    compose healthchecks to `node -e "fetch(…)"` (BusyBox `wget --spider` sends HEAD).
> 4. **★P2 (id echo).** Parse the body early and bounded; echo the JSON-RPC `id` in *every*
>    error path (401/403/409/413/429/502/504), including one error per request for arrays.
> 5. **★P1 (header allow-lists).** Forward upstream: `MCP-Protocol-Version`, `Mcp-Session-Id`,
>    `Last-Event-ID`, `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`, `Accept`, `Content-Type` + creds.
>    Forward to the client: `Content-Type`, `MCP-Protocol-Version`, `Mcp-Session-Id`,
>    `Last-Event-ID`, `Retry-After`, `WWW-Authenticate`, `X-Accel-Buffering`, `Cache-Control`.
>    One test per header.
> 6. **Logging correctness.** Take the project ID from `params.arguments.projectId` (N5);
>    include the request body in the error-path debug log (N6); move the
>    "No project ID configured" warning to a once-per-process startup warning (N7).
> 7. **★N2.** Reject an over-sized body with `413` regardless of authentication (bound the
>    read before the credential decision, or read-then-authenticate).
> 8. **`test.sh`.** Never print the API key (print `configured` / `missing`) (N8).
>
> Phase 1 gate: every promoted ★ test passes, the characterization tests are unchanged, then
> commit `fix: crash-proof the request path and correct MCP header/id handling (phase 1)`.
