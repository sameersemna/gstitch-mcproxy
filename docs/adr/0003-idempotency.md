# ADR 0003 — Request classification, retry safety and duplicate suppression

- **Status:** Accepted
- **Date:** 2026-10-18
- **Phase:** 3
- **Supersedes:** —

## Context

The proxy is transparent: it forwards JSON-RPC messages to Stitch and returns the result. That
makes retries dangerous, because Stitch's tools have **user-visible side effects** — creating a
project, generating a screen, editing a design. Each costs the user generation quota and leaves
artefacts in their account.

Audit finding ★C1 was reproduced: a `tools/call create_project` whose connection was reset after
Stitch received it was **delivered to Stitch three times** (the retry loop), producing three
projects. The same applies to `generate_screen_from_text`, `edit_screens`, `generate_variants`
and `apply_design_system`.

Three further duplicate paths exist:

1. **Proxy timeouts.** When the proxy times out at 120 s and answers `504`, aborting the upstream
   request does **not** undo work Stitch already started. The client retries, and a second
   generation runs while the first result is lost.
2. **Client retries.** VS Code or the agent re-sends the same `tools/call` while the first is
   still running, producing two generations.
3. **Discovery storms.** `tools/list` is re-fetched constantly (~29,000 failed cycles/day per the
   README), all the way to Stitch.

## Decision

### 1. Classify every message

`src/mcp/classify.js` maps a JSON-RPC message to `safe` or `unsafe`:

1. the built-in table (below) — the source of truth when the upstream supplies no annotations;
2. `SAFE_TOOLS` / `UNSAFE_TOOLS` configuration overrides, which always win;
3. **unknown tools are unsafe.**

A batch takes the **most unsafe** element (`unsafe` if any element is unsafe).

| Class | Messages / tools |
|---|---|
| safe | `initialize`, `ping`, `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, all `notifications/*` |
| safe | `tools/call` → `list_projects`, `get_project`, `list_screens`, `get_screen`, `list_design_systems` |
| unsafe | `tools/call` → `create_project`, `create_design_system`, `update_design_system`, `apply_design_system`, `create_screen`, `edit_screens`, `generate_screen_from_text`, `generate_variants` |
| unsafe | any unknown `tools/call` tool, and any unknown method |

Upstream `tools/list` annotations (`readOnlyHint`) are honoured when Stitch supplies them, and
are cached per API-key hash. They never *downgrade* a tool the built-in table calls unsafe unless
`readOnlyHint` is explicitly `true`.

### 2. Retry by error phase, not by message content

`src/upstream/retry.js` derives a phase from the failure:

- **`connect`** — the request provably never reached Stitch (DNS failure, connection refused,
  connect timeout, TLS handshake failure). Retrying is always safe.
- **`sent`** — the request left the proxy but no response was received (connection reset, HTTP/2
  stream reset, socket hang-up, body timeout, abort).
- **`response`** — an HTTP response arrived, possibly with an error status.

| Class | `connect` | `sent` | `response` |
|---|---|---|---|
| **safe** | retry | retry | retry `429`, `502`, `503`, `504` |
| **unsafe** | retry | **never** — answer "outcome unknown" | **never** |

Backoff is exponential with **full jitter**, bounded by the remaining deadline, and honours
`Retry-After`.

The `connect`/`sent` distinction is derived from the undici error code
(`UND_ERR_CONNECT_TIMEOUT`, `ENOTFOUND`, `ECONNREFUSED` → connect; `UND_ERR_SOCKET`,
`ECONNRESET`, `ERR_HTTP2_*` → sent). Because the classification is conservative — an
unrecognised code is treated as `sent` — a missing case can only ever cause *fewer* retries.

### 3. "Outcome unknown" is a first-class answer

An unsafe request that fails in the `sent` phase gets JSON-RPC error **`-32008`** (new,
documented in `PROGRESS.md`), whose message tells the model what to do:

> The request may have been applied by Stitch. Call list_screens/list_projects to check before
> retrying.

This is strictly better than a silent retry and better than `-32006`: it is actionable, and it
prevents the model from issuing an equivalent-but-different call.

### 4. Coalesce in-flight unsafe requests

Fingerprint = `sha256(apiKeyHash + method + canonicalJSON(params))`, where `apiKeyHash` uses a
per-process random salt so the key itself is never stored.

A second identical **unsafe** request arriving while the first is in flight attaches to the first
and receives the same result, with its own JSON-RPC `id` rewritten in. SSE responses are buffered
(bounded) and replayed to late joiners.

### 5. Capture orphaned results

For **unsafe** calls, a client disconnect or proxy-side timeout **must not abort** the upstream
request. The request is detached and read to completion in the background for up to
`UNSAFE_MAX_DURATION_MS` (default 10 min). The result is stored under the fingerprint for
`REPLAY_WINDOW_MS` (default 10 min) **only if no client received it**. A retry of the same call
then returns the stored result instead of starting a second generation.

The original client still gets `504 -32004`, with a message saying the job is still running and
that an identical retry will return its result.

### 6. Explicit idempotency keys are opt-in

An `Idempotency-Key` header or `params._meta.idempotencyKey` replays any completed result inside
the window, **even if it was delivered**. Without a key only *orphaned* results are replayed, so a
deliberate second generation with an identical prompt still works.

### 7. Bounds

The store is an LRU with per-entry and total byte caps, a TTL sweep, and metrics for hits,
coalesced requests and orphans. It is in-memory only; nothing is persisted, so a restart loses
replayability rather than resurrecting stale results.

## Consequences

### Positive

- A non-idempotent Stitch call can no longer be duplicated by the proxy.
- Duplicate client retries collapse into one generation.
- A timed-out generation's result is recoverable instead of lost.
- Models get an actionable error instead of an ambiguous one.
- Discovery storms are absorbed by caching `tools/list`.

### Negative / accepted trade-offs

- A `-32008` means the proxy cannot tell the client whether the call happened; the client must
  actively check. That is honest but it is a new failure mode for clients to handle.
- Replay requires holding response bodies in memory. The caps bound this, and unsafe responses
  are typically a few kilobytes, but very large results will not be replayable.
- Coalescing changes observable behaviour for identical concurrent calls: two clients see one
  upstream request. This is intended, and it is why the fingerprint includes the full canonical
  parameters.
- In-memory only: a restart loses replay. A restart also means the original client is gone, so
  this is acceptable.

## Alternatives considered

1. **Make every request idempotent with an upstream `Idempotency-Key`.** Rejected: Stitch does
   not document such a header, so it cannot be relied on.
2. **Never retry anything.** Rejected: transient connect failures are genuinely retryable and
   retrying them is what makes the proxy usable.
3. **Retry everything and deduplicate afterwards.** Rejected: the side effect already happened;
   the generation quota is already spent.
4. **Persist the replay store to disk.** Rejected for now: adds a state directory, a schema and a
   security question (responses contain user designs), for a benefit only realised across
   restarts.
