// @ts-check
"use strict";

/**
 * HTTP response helpers.
 *
 * Responsibility: write a well-formed response exactly once, with the headers the transport
 * needs. Every response the proxy produces — success or error — goes through these helpers so
 * that `Content-Length`, `HEAD` handling and the JSON-RPC error envelope are consistent.
 *
 * These functions are pure apart from writing to `res`, which makes them testable against a
 * stub response object.
 */

/**
 * Escapes text for safe interpolation into HTML.
 *
 * Note this is used for the log viewer and the instructions page, where logged request and
 * response bodies are rendered. It must stay exhaustive: an unescaped body would be a stored
 * XSS vector (Phase 5 adds a regression test for exactly that).
 *
 * @param {any} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Renders inline Markdown: escape first, then re-introduce `<code>` for backticked spans.
 * Escaping before substitution is what keeps this safe.
 *
 * @param {string} text
 * @returns {string}
 */
function formatInlineMarkdown(text) {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

/**
 * Sends a JSON response.
 *
 * @param {import("http").ServerResponse} res
 * @param {number} statusCode
 * @param {any} payload
 * @param {{ headers?: Record<string, string>, head?: boolean }} [options] `head` suppresses the
 *   body while keeping `Content-Length`, as HTTP requires for a `HEAD` response.
 * @returns {void}
 */
function sendJson(res, statusCode, payload, options = {}) {
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
    ...(options.headers || {}),
  };

  res.writeHead(statusCode, headers);
  res.end(options.head ? undefined : body);
}

/**
 * Sends a text response.
 *
 * @param {import("http").ServerResponse} res
 * @param {number} statusCode
 * @param {string} text
 * @param {Record<string, string>} [headers]
 * @param {{ head?: boolean }} [options]
 * @returns {void}
 */
function sendText(res, statusCode, text, headers = {}, options = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  res.end(options.head ? undefined : text);
}

/**
 * Sends an HTML response.
 *
 * @param {import("http").ServerResponse} res
 * @param {number} statusCode
 * @param {string} html
 * @param {{ head?: boolean }} [options]
 * @returns {void}
 */
function sendHtml(res, statusCode, html, options = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
  });
  res.end(options.head ? undefined : html);
}

/**
 * Sends an id-aware JSON-RPC error response.
 *
 * Finding ★P2: every error path used to hard-code `id: null`, so a client waiting on request
 * id N might never resolve its pending call. The `id` here is either a single id, `null`, or —
 * for a batch — an array of ids, in which case one error object is emitted per id.
 *
 * Returns silently when the response has already started, so a late error can never throw
 * `ERR_HTTP_HEADERS_SENT` (finding ★C5 was exactly that class of bug).
 *
 * @param {import("http").ServerResponse} res
 * @param {number} statusCode
 * @param {number} code
 * @param {string} message
 * @param {any} [id]
 * @param {Record<string, string>} [headers]
 * @returns {void}
 */
function sendJsonRpcError(res, statusCode, code, message, id = null, headers = {}) {
  if (res.headersSent || res.writableEnded) {
    return;
  }

  const payload = Array.isArray(id)
    ? id.map((entry) => ({ jsonrpc: "2.0", error: { code, message }, id: entry }))
    : { jsonrpc: "2.0", error: { code, message }, id };
  const body = JSON.stringify(payload);

  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
    ...headers,
  });
  res.end(body);
}

module.exports = {
  escapeHtml,
  formatInlineMarkdown,
  sendJson,
  sendText,
  sendHtml,
  sendJsonRpcError,
};
