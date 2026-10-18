# ADR 0002 — Module layout

- **Status:** Accepted
- **Date:** 2026-10-17
- **Phase:** 2
- **Supersedes:** —

## Context

All logic lives in a single 3,400-line `index.js`. The hardening programme adds several new
concerns (request classification, retry-phase analysis, an idempotency store, streaming
pipeline management, a security model), and none of them can be tested in isolation while the
code is one file with module-level mutable state.

Phase 2 is a **pure refactor**: no behaviour changes, and the only permitted test edit is an
import path.

## Decision

Adopt the layout below. Modules are introduced **only as their code is genuinely extracted**;
Phase 2 does not create empty placeholders.

```
index.js                      # entry point: .env, config, createProxyServer, listen, signals
src/
  config.js                   # env parsing/validation, CONFIG_KEYS, .env loader      (Phase 6)
  state.js                    # createState(): metrics, buckets, connections, caches
  server.js                   # handleRequest, routeRequest, createProxyServer
  http/
    respond.js                # sendJson / sendText / sendHtml / sendJsonRpcError, escaping
    security.js               # parseHostHeader, validateOrigin, CORS, redaction
    ratelimit.js              # token bucket, client-IP resolution
  mcp/
    jsonrpc.js                # JSON-RPC parsing: ids, methods, project ID, local fallbacks
    classify.js               # safe/unsafe classification                                 (Phase 3)
    annotations.js            # tools/list annotation injection                              (Phase 3)
  upstream/
    forward.js                # fetch, header allow-lists, bounded body reader, streaming
    retry.js                  # phase-aware retry policy                                    (Phase 3)
    errors.js                 # describeFetchError, isTransientUpstreamError, error phase
    credentials.js            # header/Basic/env/gcloud resolution
  idempotency/
    store.js                  # in-flight coalescing + result replay                       (Phase 3)
  observability/
    metrics.js                # recordMetrics, renderPrometheusMetrics
    logger.js                 # summary + detail logs, rotation, redaction
  routes/
    health.js, instructions.js, logs.js, wellknown.js
  views/
    instructions.html.js      # the existing template, moved verbatim
    logs.html.js              # the existing template, moved verbatim
docs/adr/
```

### Rules

1. **`index.js` stays the entry point.** Docker, both systemd units, `run.sh`, `test.sh` and
   the documented `docker run` one-liner all invoke `node index.js`. It must remain a thin
   composition root and must keep working with no build step.
2. **Pure functions first.** Modules whose behaviour is a function of their arguments
   (`jsonrpc`, `errors`, `respond`, `security`) are extracted first because they need no
   plumbing and are trivially testable.
3. **No module-level mutable state.** Anything mutable is created by `createState()` and
   reached through the instance. A module that needs configuration receives it as an argument
   or reads the single exported config object — never `process.env` directly.
4. **One area per commit**, with `npm run verify` green after each. Conventional Commits
   (`refactor: extract … (phase 2)`).
5. **Templates move verbatim.** No reformatting, no "while I'm here" edits; a diff of the
   moved HTML must be empty apart from the wrapper.

## Consequences

### Positive

- The Phase 3 concerns (classification, retry phases, idempotency) get real unit tests against
  pure functions instead of integration tests through the HTTP surface.
- `index.js` becomes readable as an entry point rather than as the whole program.
- Coverage can be measured per concern (the Phase 7 target: ≥ 80% on `mcp`, `upstream`,
  `idempotency`, `http`).

### Negative / accepted trade-offs

- More files to navigate in a project whose selling point was "one file". Mitigated by keeping
  `src/` flat-ish and by documenting the map above.
- The extraction is mechanical but large; each commit must be independently green, which costs
  more commits than a single big-bang move.

### Deliberately deferred to Phase 6

`src/config.js` is listed above but **not** created in Phase 2. Unifying the 32 module-level
configuration bindings into one validated object is the explicit deliverable of Phase 6 ("one
schema for every env var, consumed everywhere"), and doing it during a "pure refactor" would
conflict with this ADR's no-behaviour-change rule, because it changes how invalid values are
handled. Phase 2 therefore extracts only the modules that are already pure.

## Alternatives considered

1. **Keep one file and add sections.** Rejected: Phase 3's idempotency store and Phase 4's
   streaming pipeline are not testable as sections of a 4,000-line file.
2. **Big-bang move into `src/` in a single commit.** Rejected: unreviewable, and any mistake
   becomes hard to bisect.
3. **Convert to an ESM/TypeScript layout.** Rejected — see ADR 0001.
