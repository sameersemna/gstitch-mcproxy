// @ts-check
"use strict";

/**
 * Request classification: does acting on this message change Stitch's state?
 *
 * Responsibility: decide `safe` (read-only, replayable) vs `unsafe` (side effects, may be slow
 * and costs the user generation quota) for every JSON-RPC message the proxy sees.
 *
 * This distinction is what makes retries safe. A transparent proxy that retries an
 * `generate_screen_from_text` after a connection reset creates a second screen and spends the
 * user's quota twice — that is audit finding ★C1, reproduced at three duplicate
 * `create_project` calls.
 *
 * The rule of precedence is deliberate:
 *   1. an explicit `SAFE_TOOLS` / `UNSAFE_TOOLS` override always wins (operator knowledge);
 *   2. an upstream `readOnlyHint: true` annotation can mark a tool safe (only ever *upgrading*
 *      safety, never downgrading a known-unsafe tool);
 *   3. otherwise the built-in table;
 *   4. **anything unknown is unsafe.**
 *
 * See ADR 0003.
 */

/** JSON-RPC methods that never change Stitch's state. */
const SAFE_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
  "completion/complete",
  "logging/setLevel",
]);

/** Methods that look like notifications and never carry side effects. */
const SAFE_METHOD_PREFIXES = ["notifications/"];

/** Stitch tools that only read. Verified against the documented tool list. */
const SAFE_TOOLS = new Set([
  "list_projects",
  "get_project",
  "list_screens",
  "get_screen",
  "list_design_systems",
]);

/**
 * Stitch tools that create or mutate state.
 *
 * Listed explicitly even though unknown tools are unsafe by default: the explicit list is what
 * the `tools/list` annotation injection uses, and it documents the cost model.
 */
const UNSAFE_TOOLS = new Set([
  "create_project",
  "create_design_system",
  "update_design_system",
  "apply_design_system",
  "create_screen",
  "edit_screens",
  "generate_screen_from_text",
  "generate_variants",
]);

/**
 * @typedef {"safe" | "unsafe"} RequestClass
 */

/**
 * @typedef {object} Classification
 * @property {RequestClass} requestClass
 * @property {boolean} safe
 * @property {string} reason  short, human-readable, safe to log
 * @property {string} method
 * @property {string|null} toolName
 */

/**
 * @typedef {object} ClassifyOptions
 * @property {Set<string>|null} [safeTools] extra tools to treat as safe
 * @property {Set<string>|null} [unsafeTools] tools to force to unsafe
 * @property {Map<string, {readOnlyHint?: boolean}>|null} [annotations] upstream tool annotations
 */

/**
 * Classifies a single JSON-RPC message.
 *
 * @param {any} message parsed JSON-RPC message
 * @param {ClassifyOptions} [options]
 * @returns {Classification}
 */
function classifyMessage(message, options = {}) {
  if (!message || typeof message !== "object") {
    return {
      requestClass: "unsafe",
      safe: false,
      reason: "not a JSON-RPC object",
      method: "unknown",
      toolName: null,
    };
  }

  const method = typeof message.method === "string" ? message.method : "unknown";

  if (method === "tools/call") {
    return classifyToolCall(message, options);
  }

  if (SAFE_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return { requestClass: "safe", safe: true, reason: "notification", method, toolName: null };
  }

  if (SAFE_METHODS.has(method)) {
    return { requestClass: "safe", safe: true, reason: "read-only method", method, toolName: null };
  }

  return {
    requestClass: "unsafe",
    safe: false,
    reason: "unknown method",
    method,
    toolName: null,
  };
}

/**
 * @param {any} message
 * @param {ClassifyOptions} options
 * @returns {Classification}
 */
function classifyToolCall(message, options) {
  const toolName =
    typeof message?.params?.name === "string" && message.params.name.trim()
      ? message.params.name.trim()
      : null;

  if (!toolName) {
    return {
      requestClass: "unsafe",
      safe: false,
      reason: "tools/call without a tool name",
      method: "tools/call",
      toolName: null,
    };
  }

  // 1. Operator override always wins.
  if (options.unsafeTools && options.unsafeTools.has(toolName)) {
    return {
      requestClass: "unsafe",
      safe: false,
      reason: "configured UNSAFE_TOOLS",
      method: "tools/call",
      toolName,
    };
  }

  if (options.safeTools && options.safeTools.has(toolName)) {
    return {
      requestClass: "safe",
      safe: true,
      reason: "configured SAFE_TOOLS",
      method: "tools/call",
      toolName,
    };
  }

  // 2. An upstream readOnlyHint can only ever upgrade safety.
  const annotation = options.annotations ? options.annotations.get(toolName) : undefined;
  if (annotation && annotation.readOnlyHint === true && !UNSAFE_TOOLS.has(toolName)) {
    return {
      requestClass: "safe",
      safe: true,
      reason: "upstream readOnlyHint",
      method: "tools/call",
      toolName,
    };
  }

  // 3. Built-in table.
  if (SAFE_TOOLS.has(toolName)) {
    return {
      requestClass: "safe",
      safe: true,
      reason: "known read-only tool",
      method: "tools/call",
      toolName,
    };
  }

  if (UNSAFE_TOOLS.has(toolName)) {
    return {
      requestClass: "unsafe",
      safe: false,
      reason: "known mutating tool",
      method: "tools/call",
      toolName,
    };
  }

  // 4. Conservative default: an unknown tool might create or destroy anything.
  return {
    requestClass: "unsafe",
    safe: false,
    reason: "unknown tool",
    method: "tools/call",
    toolName,
  };
}

/**
 * Classifies a whole request body. A batch takes the most unsafe element.
 *
 * Protocol note: MCP does not support JSON-RPC batching — the body must be a single message.
 * The proxy still forwards arrays unchanged, so the classifier must not let a batch smuggle an
 * unsafe call past the retry policy.
 *
 * @param {any} parsed parsed JSON-RPC body (object or array)
 * @param {ClassifyOptions} [options]
 * @returns {Classification[]} one entry per message; empty when the body is unusable
 */
function classifyPayload(parsed, options = {}) {
  if (!parsed) {
    return [];
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  return messages.map((message) => classifyMessage(message, options));
}

/**
 * Reduces a set of classifications to the request-level verdict.
 *
 * @param {Classification[]} classifications
 * @returns {Classification} the most unsafe entry, or an unsafe verdict when the body could not
 *   be parsed at all (fail closed)
 */
function reduceClassification(classifications) {
  if (!classifications || classifications.length === 0) {
    return {
      requestClass: "unsafe",
      safe: false,
      reason: "unparseable request body",
      method: "unknown",
      toolName: null,
    };
  }

  return classifications.find((entry) => !entry.safe) || classifications[0];
}

/**
 * Classifies an already-parsed body in one call.
 *
 * @param {any} parsed
 * @param {ClassifyOptions} [options]
 * @returns {Classification}
 */
function classifyRequest(parsed, options = {}) {
  return reduceClassification(classifyPayload(parsed, options));
}

/**
 * Builds the `annotations` object the proxy injects into a `tools/list` result, so clients can
 * warn the user before an unsafe call.
 *
 * Upstream annotations are never overwritten.
 *
 * @param {string} toolName
 * @param {{ readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean, title?: string }|undefined} existing
 * @param {ClassifyOptions} [options]
 * @returns {any} annotations to attach, or null when upstream already supplied them
 */
function annotationsForTool(toolName, existing, options = {}) {
  if (existing && typeof existing === "object" && existing.readOnlyHint !== undefined) {
    // Stitch already told the client what it needs to know; do not second-guess it.
    return null;
  }

  const classification = classifyToolCall({ params: { name: toolName } }, options);

  if (classification.safe) {
    return {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
  }

  // `generate_*` and `*_variants` are additive (they create, they do not overwrite), and
  // repeating them with the same arguments *does* produce another artefact — so
  // `destructiveHint` is false and `idempotentHint` is false. Creation is not idempotent.
  const isAdditiveCreation =
    toolName.startsWith("generate_") ||
    toolName === "create_project" ||
    toolName === "create_screen";

  return {
    readOnlyHint: false,
    destructiveHint: !isAdditiveCreation,
    idempotentHint: false,
    openWorldHint: true,
  };
}

module.exports = {
  SAFE_METHODS,
  SAFE_METHOD_PREFIXES,
  SAFE_TOOLS,
  UNSAFE_TOOLS,
  classifyMessage,
  classifyPayload,
  classifyRequest,
  reduceClassification,
  annotationsForTool,
};
