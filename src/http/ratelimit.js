// @ts-check
"use strict";

/**
 * Per-client rate limiting (token bucket).
 *
 * Responsibility: decide whether a request from a given client is allowed, and how long to ask
 * it to wait.
 *
 * The bucket state is owned by the proxy instance and passed in, so two proxies in one process
 * cannot share limits, and a test can drive the clock.
 *
 * **Phase 2 status: extracted, behaviour unchanged.** Two baseline properties are deliberate and
 * are fixed in Phase 5:
 *   - `getClientIp` trusts `X-Forwarded-For` unconditionally (finding ★N4), so a client can
 *     spoof its address and bypass the limit. Phase 5 adds `TRUST_PROXY`, off by default.
 *   - the bucket map is unbounded between sweeps. Phase 5 caps it.
 */

/**
 * @typedef {object} RateLimitBucket
 * @property {number} tokens
 * @property {number} lastRefill
 */

/**
 * @typedef {object} RateLimitDecision
 * @property {boolean} allowed
 * @property {number} [retryAfter] seconds to wait, present when `allowed` is false
 */

/**
 * Resolves the client address used as the rate-limit key.
 *
 * Baseline behaviour (finding ★N4): `X-Forwarded-For` is trusted from any peer, so anyone can
 * present a fresh address per request and never be limited.
 *
 * @param {import("http").IncomingMessage} req
 * @returns {string}
 */
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return value.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

/**
 * Consumes one token from the client's bucket.
 *
 * @param {Map<string, RateLimitBucket>} buckets per-instance bucket map
 * @param {{ enabled: boolean, maxRps: number, burst: number }} config
 * @param {string} clientIp
 * @param {number} [now] injectable clock, for tests
 * @returns {RateLimitDecision}
 */
function checkRateLimit(buckets, config, clientIp, now = Date.now()) {
  if (!config.enabled) {
    return { allowed: true };
  }

  let bucket = buckets.get(clientIp);

  if (!bucket) {
    bucket = { tokens: config.burst, lastRefill: now };
    buckets.set(clientIp, bucket);
  }

  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(config.burst, bucket.tokens + elapsed * config.maxRps);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true };
  }

  return { allowed: false, retryAfter: Math.ceil(1 / Math.max(config.maxRps, 1)) };
}

/**
 * Drops buckets that have not been touched for `maxAgeMs`.
 *
 * @param {Map<string, RateLimitBucket>} buckets
 * @param {number} [now]
 * @param {number} [maxAgeMs]
 * @returns {number} how many buckets were removed
 */
function sweepRateLimitBuckets(buckets, now = Date.now(), maxAgeMs = 300000) {
  let removed = 0;
  for (const [ip, bucket] of buckets) {
    if (now - bucket.lastRefill > maxAgeMs) {
      buckets.delete(ip);
      removed += 1;
    }
  }
  return removed;
}

module.exports = { getClientIp, checkRateLimit, sweepRateLimitBuckets };
