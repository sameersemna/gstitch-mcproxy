# ADR 0004 — Streaming, deadlines and upstream concurrency

- **Status:** Accepted
- **Date:** 2026-10-18
- **Phase:** 4
- **Supersedes:** —

## Context

Three findings in the audit were all facets of the same mistake: treating "the response started"
as "the request is done".

- **★S1.** The baseline cleared its only timer as soon as response headers arrived and reset the
  in-flight flag _before_ streaming, so neither the request timeout nor a client disconnect could
  stop the body. Reproduced: with `REQUEST_TIMEOUT_MS=2000`, a never-ending SSE stream kept the
  upstream socket `ESTABLISHED` 6.6 s after the client aborted at 600 ms.
- **★S2.** `res.write()` returns `false` when the socket is full; the return value was ignored, so
  a slow client made the proxy buffer the whole body.
- **★S3.** Every chunk was accumulated for the debug log even when logging was off.
- **★S6.** Node's `requestTimeout`/`headersTimeout`/`keepAliveTimeout` were left at their defaults
  (300 s / 60 s / 5 s), which is invisible to operators and can cut a 60 s+ generation, and there
  was no cap on concurrent upstream requests.

## Decision

### One pipeline, three deadlines

Streaming uses `pipeline(Readable.fromWeb(response.body), tap, res)`. That gives backpressure and
error propagation for free; the `tap` transform observes each chunk to reset the idle timer, feed
metrics and capture a bounded prefix.

The deadlines are separate because they answer different questions:

| Deadline                         | Default | Question                           |
| -------------------------------- | ------- | ---------------------------------- |
| headers (`REQUEST_TIMEOUT_MS`)   | 120 s   | has Stitch started replying?       |
| idle (`STREAM_IDLE_TIMEOUT_MS`)  | 60 s    | is the stream still alive?         |
| total (`STREAM_MAX_DURATION_MS`) | 30 min  | has this gone on too long overall? |

A slow-but-alive stream must survive the idle limit; a stalled one must not have to wait for the
total limit. Collapsing them into one value would either kill legitimate long generations or let a
dead stream hang for half an hour.

### A deadline ends the response, it does not abort the socket

When a deadline fires the source is cancelled and the response is **ended**. Calling
`controller.abort()` instead destroyed the client socket, so a truncated stream surfaced as
`ECONNRESET` rather than an honest end — the client then reports a network error instead of seeing
that the stream ended. Ending cleanly is more diagnosable and lets the client parse what it got.

### Client disconnect: safe aborts, unsafe detaches

A read-only call is aborted when the client leaves: nothing is lost, and the client can ask again.
A mutating call is **detached** instead — see [ADR 0003](./0003-idempotency.md) §5 — because
aborting stops our read but not Stitch's work, and the result would be thrown away while the retry
started a second generation.

### Bounded concurrency

`MAX_CONCURRENT_UPSTREAM` (default 32) is a FIFO semaphore with a maximum wait
(`CONCURRENCY_QUEUE_WAIT_MS`, default 10 s). Saturation answers `503` with `Retry-After` and
JSON-RPC `-32009` rather than hanging until the client's own timeout. FIFO matters: a retry storm
must not starve an interactive call.

### Explicit socket timeouts

`requestTimeout` is set to `REQUEST_TIMEOUT_MS + 5000`, so the proxy's own JSON-RPC deadline always
fires first and the client receives a parseable error rather than a bare socket close.
`headersTimeout` is capped below `requestTimeout`. Both are configurable, so the values are visible
instead of being Node's invisible defaults.

### Capture only in debug mode

The log capture buffer is allocated only when `LOG_ENABLED` and `LOG_LEVEL=debug`, and is capped at
`LOG_MAX_BODY_CHARS` with an explicit truncation marker.

## Consequences

### Positive

- A stalled stream cannot hold a connection forever.
- A slow client cannot exhaust proxy memory.
- A generation longer than 60 s is not silently cut by a socket timeout.
- Saturation is a clear, retryable `503` rather than an apparent outage.

### Negative / accepted trade-offs

- Three timeouts are more configuration than one. The drift tests keep them coherent and the
  defaults are chosen so the common case needs no tuning.
- Ending the response on a deadline means the client can receive a truncated body. That is
  strictly better than a reset, but a client must still handle a partial SSE frame.
- Unsafe calls buffer rather than stream (required for coalescing), so a very large unsafe
  response is held in memory up to `REPLAY_MAX_TOTAL_BYTES`.

## Alternatives considered

1. **One timeout for the whole request.** Rejected: it either kills legitimate long generations or
   allows a dead stream to linger.
2. **`for await … res.write()` with a manual drain.** Rejected: re-implementing backpressure is
   exactly the bug ★S2 was.
3. **Abort the request on a deadline.** Rejected: it destroys the client socket, turning a
   truncation into `ECONNRESET`.
4. **Unbounded concurrency with a global rate limit only.** Rejected: a rate limit is a request
   count, not an in-flight count, and generations are long.
