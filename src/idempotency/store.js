// @ts-check
"use strict";

/**
 * In-flight coalescing and orphaned-result replay.
 *
 * Responsibility: stop the proxy from asking Stitch to do the same expensive thing twice.
 *
 * Three problems, three mechanisms (see ADR 0003):
 *
 *   1. **In-flight coalescing.** A second identical request arriving while the first is still
 *      running attaches to the first and receives the same result, with its own JSON-RPC `id`
 *      rewritten in. VS Code and agents re-send `tools/call` routinely.
 *   2. **Orphan capture.** If the client disconnects or the proxy times out, aborting the
 *      upstream request does **not** undo work Stitch already started. For an unsafe call the
 *      request is detached and read to completion, and the result is stored so a retry picks it
 *      up instead of starting a second generation.
 *   3. **Explicit idempotency keys.** `Idempotency-Key` or `_meta.idempotencyKey` replays any
 *      completed result inside the window, even if it was already delivered.
 *
 * Safety properties this module must preserve:
 *   - a result is only replayed for the **same** API key (hashed with a per-process random salt;
 *     the key itself is never stored), the same method and the same canonical parameters;
 *   - a *delivered* result is not replayed unless the client supplied an explicit key, so a
 *     deliberate second generation with an identical prompt still works;
 *   - the store is bounded in entries and bytes, and swept by TTL.
 */

const crypto = require("node:crypto");

/**
 * Canonical JSON: object keys sorted, so two logically identical parameter objects hash the same
 * even if a client serialised them in a different order.
 *
 * @param {any} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (value === null || value === undefined) {
    return "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

/**
 * @typedef {object} StoreConfig
 * @property {number} replayWindowMs how long a stored result may be replayed
 * @property {number} maxEntries entry cap (LRU eviction)
 * @property {number} maxTotalBytes byte cap across all entries (LRU eviction)
 * @property {number} maxEntryBytes a larger result is not storable
 */

/**
 * @typedef {object} StoredResult
 * @property {string} fingerprint
 * @property {number} status
 * @property {string} body
 * @property {string} contentType
 * @property {number} storedAt
 * @property {boolean} delivered true once some client received it
 * @property {boolean} explicitKey stored because the client supplied an idempotency key
 * @property {number} bytes
 */

/**
 * Creates the coalescing/replay store for one proxy instance.
 *
 * The random salt is per process, so a fingerprint cannot be correlated across runs and the API
 * key is never part of the stored data.
 *
 * @param {Partial<StoreConfig>} [config]
 * @returns {any}
 */
function createIdempotencyStore(config = {}) {
  /** @type {StoreConfig} */
  const settings = {
    replayWindowMs: config.replayWindowMs ?? 10 * 60 * 1000,
    maxEntries: config.maxEntries ?? 200,
    maxTotalBytes: config.maxTotalBytes ?? 32 * 1024 * 1024,
    maxEntryBytes: config.maxEntryBytes ?? 2 * 1024 * 1024,
  };

  /** @type {Map<string, StoredResult>} insertion order doubles as LRU order */
  const results = new Map();
  /** @type {Map<string, { fingerprint: string, promise: Promise<any>, startedAt: number, waiters: number }>} */
  const inFlight = new Map();

  const salt = crypto.randomBytes(16);

  const stats = { coalesced: 0, replayed: 0, orphaned: 0, evicted: 0, tooLarge: 0 };

  /**
   * Hashes the API key with the per-process salt. The key is never stored.
   *
   * @param {string|null|undefined} apiKey
   * @returns {string}
   */
  const apiKeyHash = (apiKey) =>
    crypto
      .createHash("sha256")
      .update(salt)
      .update(String(apiKey ?? ""))
      .digest("hex");

  /**
   * Stable identity for "the same operation".
   *
   * @param {{ apiKey?: string|null, method: string, params?: any }} input
   * @returns {string}
   */
  const fingerprintOf = ({ apiKey, method, params }) =>
    crypto
      .createHash("sha256")
      .update(apiKeyHash(apiKey))
      .update("\u0000")
      .update(method)
      .update("\u0000")
      .update(canonicalJson(params))
      .digest("hex");

  /** @param {string} fingerprint */
  const touch = (fingerprint) => {
    const entry = results.get(fingerprint);
    if (entry) {
      results.delete(fingerprint);
      results.set(fingerprint, entry);
    }
  };

  const totalBytes = () => {
    let total = 0;
    for (const entry of results.values()) {
      total += entry.bytes;
    }
    return total;
  };

  /**
   * Stores a completed result, enforcing the caps.
   *
   * @param {string} fingerprint
   * @param {{ status: number, body: string, contentType: string }} response
   * @param {{ explicitKey?: boolean, delivered?: boolean }} [options]
   * @returns {boolean} whether the result was stored
   */
  const put = (fingerprint, response, options = {}) => {
    const bytes = Buffer.byteLength(response.body || "");

    if (bytes > settings.maxEntryBytes) {
      stats.tooLarge += 1;
      return false;
    }

    results.delete(fingerprint);
    results.set(fingerprint, {
      fingerprint,
      status: response.status,
      body: response.body,
      contentType: response.contentType,
      storedAt: Date.now(),
      delivered: options.delivered === true,
      explicitKey: options.explicitKey === true,
      bytes,
    });

    while (results.size > settings.maxEntries || totalBytes() > settings.maxTotalBytes) {
      const oldest = results.keys().next();
      if (oldest.done) {
        break;
      }
      results.delete(oldest.value);
      stats.evicted += 1;
    }

    return true;
  };

  /**
   * Looks up a replayable result.
   *
   * @param {string} fingerprint
   * @param {{ explicitKey?: boolean }} [options]
   * @returns {StoredResult|null}
   */
  const take = (fingerprint, options = {}) => {
    sweep();

    const entry = results.get(fingerprint);
    if (!entry) {
      return null;
    }

    if (Date.now() - entry.storedAt > settings.replayWindowMs) {
      results.delete(fingerprint);
      return null;
    }

    // A result some client already received is only replayed when the client asked for
    // idempotency explicitly. Without a key, a deliberate second generation must run.
    const replayable = entry.explicitKey || options.explicitKey === true || !entry.delivered;
    if (!replayable) {
      return null;
    }

    touch(fingerprint);
    stats.replayed += 1;
    return entry;
  };

  /**
   * Marks a stored result as delivered, so a later retry cannot replay it by accident.
   *
   * @param {string} fingerprint
   */
  const markDelivered = (fingerprint) => {
    const entry = results.get(fingerprint);
    if (entry) {
      entry.delivered = true;
    }
  };

  /**
   * Attaches to an in-flight request, or registers a new one.
   *
   * @param {string} fingerprint
   * @param {() => Promise<{ status: number, body: string, contentType: string }>} start
   * @returns {{ coalesced: boolean, promise: Promise<{ status: number, body: string, contentType: string }> }}
   */
  const join = (fingerprint, start) => {
    const existing = inFlight.get(fingerprint);
    if (existing) {
      existing.waiters += 1;
      stats.coalesced += 1;
      return { coalesced: true, promise: existing.promise };
    }

    const promise = (async () => start())().finally(() => {
      inFlight.delete(fingerprint);
    });

    inFlight.set(fingerprint, { fingerprint, promise, startedAt: Date.now(), waiters: 1 });

    return { coalesced: false, promise };
  };

  /** @param {string} fingerprint */
  const isInFlight = (fingerprint) => inFlight.has(fingerprint);

  /** @param {string} fingerprint */
  const forget = (fingerprint) => {
    results.delete(fingerprint);
    inFlight.delete(fingerprint);
  };

  /**
   * Drops entries past their replay window.
   *
   * @returns {number} how many were removed
   */
  const sweep = () => {
    const now = Date.now();
    let removed = 0;
    for (const [fingerprint, entry] of results) {
      if (now - entry.storedAt > settings.replayWindowMs) {
        results.delete(fingerprint);
        removed += 1;
      }
    }
    return removed;
  };

  const recordOrphan = () => {
    stats.orphaned += 1;
  };

  return {
    settings,
    stats,
    apiKeyHash,
    fingerprintOf,
    put,
    take,
    markDelivered,
    join,
    isInFlight,
    forget,
    sweep,
    recordOrphan,
    /** Visible for tests only. */
    size: () => results.size,
    inFlightCount: () => inFlight.size,
    totalBytes,
  };
}

module.exports = { createIdempotencyStore, canonicalJson };
