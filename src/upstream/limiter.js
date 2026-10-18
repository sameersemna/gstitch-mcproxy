// @ts-check
"use strict";

/**
 * A bounded semaphore for upstream requests.
 *
 * Responsibility: stop the proxy from opening an unbounded number of connections to Stitch.
 * Without a cap, a burst of clients (or a retry storm) turns into a burst of generations, which
 * is both the fastest way to exhaust quota and the fastest way to look like an outage to Google.
 *
 * The queue has a **maximum wait**: if the limit has been saturated for longer than
 * `maxWaitMs`, the caller is rejected instead of queued indefinitely, so a client receives a
 * `503` with `Retry-After` rather than a connection that hangs until its own timeout.
 *
 * Fairness is FIFO, which matters because otherwise a retry storm can starve an interactive call.
 */

/**
 * @typedef {object} Semaphore
 * @property {<T>(task: () => Promise<T>, maxWaitMs?: number) => Promise<T>} run
 * @property {() => { active: number, queued: number, limit: number }} stats
 */

/**
 * @param {number} limit maximum concurrent tasks; `0` or negative means unlimited
 * @returns {Semaphore}
 */
function createSemaphore(limit) {
  const effectiveLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;

  let active = 0;

  /** @type {Array<{ resolve: () => void, reject: (error: any) => void, timer: any }>} */
  const queue = [];

  /**
   * Resolves when a slot is free, or rejects with a `SemaphoreTimeoutError`.
   *
   * @param {number} maxWaitMs
   * @returns {Promise<void>}
   */
  const acquire = (maxWaitMs) => {
    if (effectiveLimit === 0) {
      active += 1;
      return Promise.resolve();
    }

    if (active < effectiveLimit) {
      active += 1;
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      /** @type {any} */
      let timer = null;

      if (Number.isFinite(maxWaitMs) && maxWaitMs > 0) {
        timer = setTimeout(() => {
          const index = queue.findIndex((entry) => entry.timer === timer);
          if (index !== -1) {
            queue.splice(index, 1);
          }
          const error = new Error(
            `Upstream concurrency limit (${effectiveLimit}) saturated for ${maxWaitMs}ms`,
          );
          /** @type {any} */ (error).code = "SEMAPHORE_TIMEOUT";
          reject(error);
        }, maxWaitMs);
        timer.unref?.();
      }

      queue.push({
        resolve: () => {
          if (timer) {
            clearTimeout(timer);
          }
          active += 1;
          resolve();
        },
        reject,
        timer,
      });
    });
  };

  const release = () => {
    active -= 1;

    const next = queue.shift();
    if (next) {
      next.resolve();
    }
  };

  /**
   * Runs `task` while holding a slot.
   *
   * @template T
   * @param {() => Promise<T>} task
   * @param {number} [maxWaitMs] how long to wait for a slot (default 10 s)
   * @returns {Promise<T>}
   */
  const run = async (task, maxWaitMs = 10000) => {
    await acquire(maxWaitMs);
    try {
      return await task();
    } finally {
      release();
    }
  };

  return {
    run,
    stats: () => ({ active, queued: queue.length, limit: effectiveLimit }),
  };
}

module.exports = { createSemaphore };
