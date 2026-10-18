// @ts-check
"use strict";

/**
 * Raw TCP helpers for tests that must send bytes which a normal `fetch`/`http.request`
 * would refuse to produce — malformed request lines, malformed `Host` headers, HTTP/1.0
 * requests without a `Host`, and so on.
 *
 * These helpers exist because the crash class we care about (★C2) is only reachable at the
 * socket level.
 */

const net = require("node:net");

/**
 * Writes `payload` to a TCP port and resolves with whatever the peer sends back before it
 * closes, or with a timeout result.
 *
 * @param {number} port
 * @param {string} payload
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ raw: string, status: number|null, closedByPeer: boolean, timedOut: boolean, error: string|null }>}
 */
function rawRequest(port, payload, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2000;

  return new Promise((resolve) => {
    /** @type {string[]} */
    const chunks = [];
    let settled = false;
    let closedByPeer = false;
    let timedOut = false;
    /** @type {string|null} */
    let error = null;

    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setEncoding("utf8");

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const raw = chunks.join("");
      const match = raw.match(/^HTTP\/1\.[01] (\d{3})/);
      resolve({
        raw,
        status: match ? Number(match[1]) : null,
        closedByPeer,
        timedOut,
        error,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      finish();
    }, timeoutMs);

    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => chunks.push(String(chunk)));
    socket.on("end", () => {
      closedByPeer = true;
      finish();
    });
    socket.on("close", finish);
    socket.on("error", (socketError) => {
      const coded = /** @type {{ code?: string, message?: string }} */ (socketError);
      error = coded.code || coded.message || String(socketError);
      finish();
    });
  });
}

/**
 * Returns true when the process behind `port` still accepts a plain HTTP request.
 * Used to prove that a malformed request did not terminate the proxy.
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function isServerAlive(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

module.exports = { rawRequest, isServerAlive };
