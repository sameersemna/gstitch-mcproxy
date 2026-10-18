// @ts-check
"use strict";

/**
 * Streaming an upstream response body to the client.
 *
 * Responsibility: move bytes from a `fetch` `ReadableStream` to an `http.ServerResponse` with
 * **backpressure**, and enforce three independent deadlines.
 *
 * Three findings live here (audit §3.3):
 *
 *   - ★S1: the baseline cleared its only timer as soon as headers arrived and reset
 *     `upstreamInFlight` before streaming, so neither the request timeout nor a client
 *     disconnect could stop the body. A never-ending SSE stream held the upstream socket open
 *     indefinitely after the client had gone (verified: still ESTABLISHED 6.6 s after a
 *     600 ms abort with a 2 s timeout).
 *   - ★S2: `res.write()` returns `false` when the client's socket is full, and the baseline
 *     ignored it, so a slow reader made the proxy buffer without bound. `pipeline()` from
 *     `node:stream/promises` propagates backpressure and errors instead.
 *   - ★S3: every chunk was accumulated into an array even when debug logging was off, so a
 *     long stream cost memory for a log line that would never be written.
 *
 * The three deadlines, which must not be conflated:
 *
 *   1. **headers** — until the upstream sends response headers (`REQUEST_TIMEOUT_MS`);
 *   2. **idle** — the longest silence *between* chunks (`STREAM_IDLE_TIMEOUT_MS`);
 *   3. **total** — the absolute cap for the whole body (`STREAM_MAX_DURATION_MS`).
 *
 * A slow-but-alive stream must not be killed by (1), and a stalled stream must not wait for (3).
 */

const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

/**
 * @typedef {object} StreamOptions
 * @property {number} idleTimeoutMs longest allowed silence between chunks
 * @property {number} totalTimeoutMs absolute cap for the whole body
 * @property {number} maxCaptureBytes how many bytes to retain for the debug log (0 = none)
 * @property {AbortSignal} [signal] aborts when the client leaves or the request is cancelled
 * @property {(chunk: Buffer) => void} [onChunk] called for every chunk (metrics/log throttles)
 */

/**
 * @typedef {object} StreamResult
 * @property {boolean} ok
 * @property {boolean} idleTimedOut
 * @property {boolean} totalTimedOut
 * @property {boolean} aborted
 * @property {boolean} truncatedForLog true when the captured body was capped
 * @property {string} capturedBody the first `maxCaptureBytes` of the body, for logging
 * @property {number} bytes total bytes streamed
 * @property {any} error
 */

/**
 * Streams `source` into `destination` with backpressure and three deadlines.
 *
 * Returns a result rather than throwing, because every failure mode here is expected and must be
 * logged differently: an idle timeout, a total timeout and a client abort are not the same event.
 *
 * @param {ReadableStream<Uint8Array>} source
 * @param {import("http").ServerResponse} destination
 * @param {StreamOptions} options
 * @returns {Promise<StreamResult>}
 */
async function streamWithBackpressure(source, destination, options) {
  const { idleTimeoutMs, totalTimeoutMs, maxCaptureBytes, signal, onChunk } = options;

  /** @type {StreamResult} */
  const result = {
    ok: false,
    idleTimedOut: false,
    totalTimedOut: false,
    aborted: false,
    truncatedForLog: false,
    capturedBody: "",
    bytes: 0,
    error: null,
  };

  // --- Capture buffer, bounded (finding ★S3) ---------------------------------
  /** @type {Buffer[]} */
  const captured = [];
  let capturedBytes = 0;

  // --- Deadlines --------------------------------------------------------------
  const controller = new AbortController();

  /**
   * Stops reading the upstream body because a deadline fired.
   *
   * Deliberately *not* `controller.abort()`: that destroys the client socket, so the client sees
   * `ECONNRESET` instead of a clean end. Cancelling the source and letting `pipeline` finish, then
   * ending the response, gives the client an honest truncated body it can parse and report.
   */
  const stopSource = () => {
    source.cancel().catch(() => undefined);
    // Give `pipeline` a moment to unwind, then close the response if it is still open.
    setImmediate(() => {
      if (!destination.writableEnded && !destination.destroyed) {
        destination.end();
      }
    });
  };

  let idleTimedOut = false;
  let totalTimedOut = false;

  // `unref` so a lingering timer can never keep the process alive.
  const totalTimer = setTimeout(() => {
    totalTimedOut = true;
    stopSource();
  }, totalTimeoutMs);
  totalTimer.unref?.();

  /** @type {NodeJS.Timeout|undefined} */
  let idleTimer;
  const armIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      stopSource();
    }, idleTimeoutMs);
    idleTimer.unref?.();
  };
  armIdle();

  const cleanup = () => {
    clearTimeout(totalTimer);
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
  };

  // A client disconnect must stop the read. The caller passes `res`'s own abort signal in, so
  // this is the second half of the ★S1 fix.
  const onAbort = () => {
    controller.abort(new Error("aborted"));
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  /**
   * A pass-through that observes each chunk: it resets the idle timer, calls `onChunk`, and
   * captures a bounded prefix for logging — all while preserving backpressure.
   */
  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

        armIdle();
        result.bytes += buffer.length;

        if (onChunk) {
          onChunk(buffer);
        }

        if (maxCaptureBytes > 0 && capturedBytes < maxCaptureBytes) {
          const room = maxCaptureBytes - capturedBytes;
          if (buffer.length <= room) {
            captured.push(buffer);
            capturedBytes += buffer.length;
          } else {
            captured.push(buffer.subarray(0, room));
            capturedBytes += room;
            result.truncatedForLog = true;
          }
        }

        callback(null, buffer);
      } catch (error) {
        callback(/** @type {any} */ (error));
      }
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(/** @type {any} */ (source)),
      tap,
      /** @type {any} */ (destination),
      { signal: controller.signal },
    );
    result.ok = true;
  } catch (error) {
    result.error = error;
    const message = String(/** @type {any} */ (error)?.message || error);

    if (idleTimedOut) {
      result.idleTimedOut = true;
    } else if (totalTimedOut) {
      result.totalTimedOut = true;
    } else if (/aborted|premature close|ECONNRESET|EPIPE/i.test(message)) {
      result.aborted = true;
    }
  } finally {
    cleanup();
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
    result.capturedBody = Buffer.concat(captured).toString("utf8");
  }

  return result;
}

module.exports = { streamWithBackpressure };
