// @ts-check
"use strict";

/**
 * Upstream error classification.
 *
 * Responsibility: translate the opaque failures that `fetch`/undici surface into something
 * actionable, and decide which of them are *transport* problems rather than application
 * errors.
 *
 * Phase 3 replaces `isTransientUpstreamError` with a phase-aware policy
 * (`connect` | `sent` | `response`) so a non-idempotent call is never replayed after the
 * request left the proxy. This module keeps the baseline behaviour for now.
 */

/**
 * Renders a `fetch()` failure readably.
 *
 * Node's `fetch` collapses every transport failure into `TypeError: fetch failed` and hides
 * the real reason in `error.cause`, which made the baseline logs useless for diagnosis.
 *
 * @param {any} error
 * @returns {string}
 */
function describeFetchError(error) {
  if (!error) {
    return "Unknown error";
  }

  const cause = error.cause;
  const causeCode = cause && (cause.code || cause.errno);
  const causeMessage = cause && cause.message;

  if (causeCode || causeMessage) {
    return `${error.message || error.name} (${causeCode || causeMessage})`;
  }

  return error.message || error.name || String(error);
}

/** Transport error codes worth retrying, regardless of request idempotency. */
const TRANSIENT_ERROR_CODES = [
  "ERR_HTTP2_STREAM_ERROR",
  "ERR_HTTP2_STREAM_CANCEL",
  "ERR_HTTP2_GOAWAY_SESSION",
  "ERR_HTTP2_SESSION_ERROR",
  "ERR_HTTP2_INVALID_SESSION",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
];

/**
 * Baseline (pre-Phase-3) transient-error test.
 *
 * This is the function behind finding ★C1: it matches `fetch failed` — i.e. *every* undici
 * failure — including connection resets that happen **after** Stitch has already received and
 * acted on the request. Phase 3 replaces it with a phase-aware policy that only retries
 * non-idempotent calls when the request provably never left the proxy.
 *
 * @param {any} error
 * @returns {boolean}
 */
function isTransientUpstreamError(error) {
  if (!error) {
    return false;
  }

  if (error.name === "AbortError" || error.name === "TimeoutError") {
    return false;
  }

  const cause = error.cause || {};
  const code = cause.code || cause.errno || "";
  const message = `${error.message || ""} ${cause.message || ""}`;

  if (TRANSIENT_ERROR_CODES.includes(code)) {
    return true;
  }

  return /socket hang up|other side closed|stream closed|connection reset|fetch failed/i.test(
    message,
  );
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  describeFetchError,
  isTransientUpstreamError,
  sleep,
  TRANSIENT_ERROR_CODES,
};
