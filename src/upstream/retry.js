// @ts-check
"use strict";

/**
 * Retry policy: decide whether a failed upstream attempt may be repeated.
 *
 * Responsibility: answer one question safely — *did Stitch act on this request?* — and only allow
 * a retry when the answer is definitively "no", or when the request is read-only.
 *
 * The baseline retried any error matching `/fetch failed/`, i.e. every undici transport failure,
 * including connection resets that happen **after** Stitch has already received and executed the
 * request (audit finding ★C1: three duplicate `create_project` calls).
 *
 * The fix is to reason about the **phase** a failure occurred in:
 *
 *   - `connect` — the request provably never left the proxy (DNS failure, connection refused,
 *     connect timeout, TLS failure). Retrying is always safe, for any request class.
 *   - `sent` — the request left the proxy and no usable response came back (connection reset,
 *     HTTP/2 stream reset, socket hang-up, body timeout, abort). For an **unsafe** request the
 *     outcome is unknown: Stitch may have applied it, so the request must not be repeated.
 *   - `response` — an HTTP response arrived. Only safe requests retry, and only for statuses
 *     that mean "try again later".
 *
 * An unrecognised error code is treated as `sent`, so a missing case can only ever cause *fewer*
 * retries, never more.
 *
 * See ADR 0003.
 */

/** Error codes that prove the request never reached Stitch. */
const CONNECT_PHASE_CODES = new Set([
  "ENOTFOUND", // DNS lookup failed
  "EAI_AGAIN", // transient DNS failure
  "ECONNREFUSED", // nothing listening / refused before any bytes were sent
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EADDRNOTAVAIL",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_INVALID_ARG",
  "UND_ERR_INVALID_URL",
]);

/** Error codes that mean the request left the proxy but no response was received. */
const SENT_PHASE_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_HTTP2_STREAM_ERROR",
  "ERR_HTTP2_STREAM_CANCEL",
  "ERR_HTTP2_GOAWAY_SESSION",
  "ERR_HTTP2_SESSION_ERROR",
  "ERR_HTTP2_INVALID_SESSION",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** Upstream HTTP statuses worth retrying, for **safe** requests only. */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/**
 * @typedef {"connect" | "sent" | "response"} ErrorPhase
 */

/**
 * @typedef {object} RetryDecision
 * @property {boolean} retry
 * @property {ErrorPhase} phase
 * @property {string} reason
 * @property {boolean} outcomeUnknown  true when an unsafe request may already have been applied
 * @property {number|null} retryAfterMs value from `Retry-After`, when the server sent one
 */

/**
 * Extracts the most specific error code available, looking through `error.cause` (undici hides
 * the real failure there behind `TypeError: fetch failed`).
 *
 * @param {any} error
 * @returns {string}
 */
function errorCodeOf(error) {
  if (!error) {
    return "";
  }
  const cause = error.cause;
  return String(
    (cause && (cause.code || cause.errno)) || error.code || error.errno || "",
  );
}

/**
 * Derives the phase a failure occurred in.
 *
 * Aborts and timeouts are deliberately `sent`: the request was already written to the socket,
 * which is why aborting an unsafe call cannot be treated as "nothing happened".
 *
 * @param {any} error
 * @returns {ErrorPhase}
 */
function phaseOfError(error) {
  if (!error) {
    return "sent";
  }

  if (error.name === "AbortError" || error.name === "TimeoutError") {
    return "sent";
  }

  const code = errorCodeOf(error);
  if (CONNECT_PHASE_CODES.has(code)) {
    return "connect";
  }
  if (SENT_PHASE_CODES.has(code)) {
    return "sent";
  }

  const message = `${error.message || ""} ${error.cause?.message || ""}`;

  // Conditions that surface only as text, but still prove the request was never sent.
  // `bad port` is undici refusing to connect at all (it blocks a set of well-known ports),
  // which is exactly a connect-phase failure.
  if (/ECONNREFUSED|getaddrinfo|ENOTFOUND|bad port/i.test(message)) {
    return "connect";
  }

  // Everything else is conservatively treated as "the request may have reached Stitch".
  return "sent";
}

/**
 * Parses a `Retry-After` header value into milliseconds.
 *
 * @param {string|null|undefined} value either delta-seconds or an HTTP-date
 * @param {number} [now]
 * @returns {number|null}
 */
function parseRetryAfter(value, now = Date.now()) {
  if (!value) {
    return null;
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) {
    return null;
  }

  return Math.max(0, date - now);
}

/**
 * Decides whether to retry.
 *
 * @param {{
 *   safe: boolean,
 *   attempt: number,
 *   maxAttempts: number,
 *   error?: any,
 *   status?: number|null,
 *   retryAfter?: string|null,
 *   remainingMs?: number,
 *   baseDelayMs?: number,
 *   random?: () => number,
 *   now?: number,
 * }} input
 * @returns {RetryDecision & { delayMs: number }}
 */
function decideRetry(input) {
  const {
    safe,
    attempt,
    maxAttempts,
    error,
    status = null,
    retryAfter = null,
    remainingMs = Infinity,
    baseDelayMs = 250,
    random = Math.random,
    now = Date.now(),
  } = input;

  const phase = error ? phaseOfError(error) : "response";
  const exhausted = attempt >= maxAttempts;

  /**
   * @param {boolean} allowed
   * @param {string} reason
   * @param {number} delayMs
   * @param {boolean} [outcomeUnknown]
   * @returns {RetryDecision & { delayMs: number }}
   */
  const decide = (allowed, reason, delayMs, outcomeUnknown = false) => ({
    retry: allowed && !exhausted && remainingMs > 0,
    phase,
    reason: exhausted ? "attempts exhausted" : reason,
    outcomeUnknown,
    retryAfterMs: parseRetryAfter(retryAfter, now),
    delayMs,
  });

  // --- Phase: connect. Nothing was sent, so any request class may be repeated. ---
  if (phase === "connect") {
    return decide(true, "connect-phase failure", jitteredDelay(attempt, baseDelayMs, random));
  }

  // --- Phase: sent. The request left the proxy. ---
  if (phase === "sent") {
    if (safe) {
      return decide(true, "sent-phase failure on a safe request", jitteredDelay(attempt, baseDelayMs, random));
    }
    // The dangerous case: Stitch may have applied this. Never repeat it.
    return decide(false, "outcome unknown after the request was sent", 0, true);
  }

  // --- Phase: response. ---
  if (status === null) {
    return decide(false, "no response status", 0);
  }

  if (!RETRYABLE_STATUSES.has(status)) {
    return decide(false, `status ${status} is not retryable`, 0);
  }

  if (!safe) {
    // Even a 503 can follow a request that was partially processed. Be conservative.
    return decide(false, `status ${status} on an unsafe request`, 0, true);
  }

  const serverWait = parseRetryAfter(retryAfter, now);
  const delayMs = serverWait !== null ? serverWait : jitteredDelay(attempt, baseDelayMs, random);
  return decide(true, `retryable status ${status}`, delayMs);
}

/**
 * Exponential backoff with **full jitter**: a uniform value in `[0, base * 2^(attempt-1)]`.
 *
 * Full jitter (rather than a fixed multiplier) is what stops a fleet of clients from
 * synchronising their retries into a thundering herd after a Stitch incident.
 *
 * @param {number} attempt 1-based
 * @param {number} baseDelayMs
 * @param {() => number} random
 * @returns {number}
 */
function jitteredDelay(attempt, baseDelayMs, random = Math.random) {
  const ceiling = Math.max(1, baseDelayMs) * 2 ** Math.max(0, attempt - 1);
  return Math.round(random() * ceiling);
}

module.exports = {
  CONNECT_PHASE_CODES,
  SENT_PHASE_CODES,
  RETRYABLE_STATUSES,
  errorCodeOf,
  phaseOfError,
  parseRetryAfter,
  decideRetry,
  jitteredDelay,
};
