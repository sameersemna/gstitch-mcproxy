// @ts-check
"use strict";

/**
 * JSON-RPC message parsing for the MCP transport.
 *
 * Responsibility: turn a raw request body into the facts the proxy needs — methods, ids, the
 * Stitch project a call names, and whether the message can be answered locally.
 *
 * Every function here is **pure**: it takes a body string and returns data. No configuration is
 * read from the environment; where a policy is needed (the local-fallback method set) it is
 * passed in explicitly, which is what makes these functions unit-testable in isolation.
 *
 * Protocol note (verified against the MCP specification): a Streamable HTTP POST body **MUST**
 * be a single JSON-RPC request or notification — batching is not part of the protocol. The
 * baseline passes arrays through to Stitch unchanged, and so do we; these helpers simply read
 * the first message, or every message, as appropriate, so that a batch cannot bypass
 * classification or id attribution.
 */

/**
 * @typedef {object} JsonRpcMetadata
 * @property {string[]} methods
 * @property {any[]} ids
 */

/**
 * Extracts the methods and ids present in a request body.
 *
 * @param {string|undefined|null} body
 * @returns {JsonRpcMetadata}
 */
function parseJsonRpcMetadata(body) {
  if (!body || typeof body !== "string") {
    return { methods: [], ids: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { methods: [], ids: [] };
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];

  return {
    methods: messages
      .map((message) => message?.method)
      .filter((method) => typeof method === "string" && method.length > 0),
    ids: messages.map((message) => message?.id).filter((id) => id !== undefined && id !== null),
  };
}

/**
 * Extracts the JSON-RPC `id`(s) from a request body so that error responses can echo them.
 *
 * Finding ★P2: every error path used to hard-code `id: null`, so a client waiting on request
 * id N might never resolve its pending call. For a batch the result is an array of the ids that
 * were present, and the caller emits one error object per id.
 *
 * Returns `null` when nothing usable can be recovered, which is the correct JSON-RPC answer for
 * an unparseable request.
 *
 * @param {string|undefined|null} body
 * @returns {any} a single id, `null`, or an array of ids
 */
function extractJsonRpcIds(body) {
  if (!body || typeof body !== "string") {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  if (Array.isArray(parsed)) {
    const ids = parsed
      .map((message) => (message && typeof message === "object" ? message.id : undefined))
      .filter((id) => id !== undefined && id !== null);
    return ids.length ? ids : null;
  }

  if (parsed && typeof parsed === "object" && parsed.id !== undefined && parsed.id !== null) {
    return parsed.id;
  }

  return null;
}

/**
 * Resolves the Stitch project ID a request actually operates on, for **log attribution**.
 *
 * Finding ★N5: the debug and summary logs were keyed on `STITCH_PROJECT_ID` (the env default)
 * and never looked at the ID in the tool arguments, so almost every request landed in
 * `logs/unknown-project/` and the log viewer was useless for per-project debugging.
 *
 * This deliberately does **not** feed the upstream `X-Stitch-Project-Id` header: supplying the
 * project ID via headers was deprecated in commit c125891.
 *
 * @param {string|undefined|null} body
 * @returns {string|null} the project ID from the arguments, or null when absent
 */
function extractProjectIdFromBody(body) {
  if (!body || typeof body !== "string") {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];

  for (const message of messages) {
    const args = message?.params?.arguments;
    if (!args || typeof args !== "object") {
      continue;
    }

    // `projectId` is Stitch's spelling; accept `project_id` defensively for hand-written calls.
    for (const key of ["projectId", "project_id"]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }

  return null;
}

/**
 * The empty results used for methods that can be answered without going upstream.
 *
 * Only `prompts/list` is enabled by default. The other two are carried here so an operator can
 * enable them with `LOCAL_FALLBACK_METHODS`, but they stay off because Stitch *does* implement
 * them — verified against the live endpoint on 2026-10-18 (finding P4): both answer `200` with an
 * empty collection, so answering them locally would hide real data.
 */
const EMPTY_FALLBACK_RESULTS = {
  "prompts/list": { prompts: [] },
  "resources/list": { resources: [] },
  "resources/templates/list": { resourceTemplates: [] },
};

/**
 * Answers a request locally when its method is in the fallback set.
 *
 * Why this exists: Stitch resets the HTTP/2 stream for `prompts/list`, which surfaces to clients
 * as `fetch failed` and made some clients retry discovery in a tight loop. Answering locally
 * breaks the loop.
 *
 * @param {string|undefined|null} requestBody
 * @param {ReadonlySet<string>} fallbackMethods
 * @returns {{ notification: true } | { jsonrpc: string, id: any, result: any } | null}
 *   `null` means "forward it upstream".
 */
function buildLocalFallbackResponse(requestBody, fallbackMethods) {
  if (!requestBody || !fallbackMethods || fallbackMethods.size === 0) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(requestBody);
  } catch {
    return null;
  }

  // Only handle single (non-batched) requests: a batch is not part of the MCP protocol, and
  // answering one element locally while forwarding the rest would be worse than passing it on.
  if (Array.isArray(parsed) || !parsed || typeof parsed !== "object") {
    return null;
  }

  const { method, id } = parsed;
  if (typeof method !== "string" || !fallbackMethods.has(method)) {
    return null;
  }

  // Notifications (no id) are acknowledged with 202 and no body.
  if (id === undefined || id === null) {
    return { notification: true };
  }

  const result = EMPTY_FALLBACK_RESULTS[method];
  if (!result) {
    return null;
  }

  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

/**
 * Rewrites the JSON-RPC `id`(s) of a response body.
 *
 * Needed for coalescing: when two clients send the same unsafe call, only one upstream request
 * runs, so the shared body carries the first caller's id. Every waiter must receive its **own**
 * id back or its pending call never resolves.
 *
 * Only the `id` is touched — never the result — and anything that cannot be parsed is returned
 * unchanged, because corrupting a response is worse than a mismatched id.
 *
 * @param {string} body
 * @param {any} targetIds a single id, `null`, or an array of ids
 * @returns {string}
 */
function rewriteJsonRpcId(body, targetIds) {
  if (typeof body !== "string" || targetIds === null || targetIds === undefined) {
    return body;
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }

  if (Array.isArray(parsed)) {
    // Match by position: the proxy does not reorder batched responses.
    const ids = Array.isArray(targetIds) ? targetIds : [targetIds];
    const rewritten = parsed.map((message, index) => {
      if (index < ids.length && message && typeof message === "object" && "id" in message) {
        return { ...message, id: ids[index] };
      }
      return message;
    });
    return JSON.stringify(rewritten);
  }

  if (parsed && typeof parsed === "object" && "id" in parsed) {
    const id = Array.isArray(targetIds) ? targetIds[0] : targetIds;
    return JSON.stringify({ ...parsed, id });
  }

  return body;
}

module.exports = {
  parseJsonRpcMetadata,
  extractJsonRpcIds,
  extractProjectIdFromBody,
  buildLocalFallbackResponse,
  rewriteJsonRpcId,
  EMPTY_FALLBACK_RESULTS,
};
