// @ts-check
"use strict";

/**
 * In-process proxy launcher for tests.
 *
 * Starts `createProxyServer()` on an **ephemeral** port (port 0) with injected
 * configuration, so tests never read `.env`, never bind a fixed port and never need a
 * child process. Always paired with `stopProxy()` in `t.after(...)`.
 */

const { once } = require("node:events");
const { createProxyServer } = require("../../index.js");

/**
 * @typedef {object} RunningProxy
 * @property {number} port
 * @property {string} url          `http://127.0.0.1:<port>`
 * @property {string} mcpUrl       `http://127.0.0.1:<port>/mcp`
 * @property {import("node:http").Server} server
 * @property {(path: string, init?: RequestInit & { rawBody?: string }) => Promise<Response>} request
 * @property {(path: string, body: any, init?: RequestInit) => Promise<Response>} postJson
 * @property {(path: string, body: any, init?: RequestInit) => Promise<any>} postJsonForJson
 * @property {() => Promise<void>} stop
 */

/**
 * Starts the proxy in-process.
 *
 * @param {Record<string, any>} [overrides] explicit config values (already parsed)
 * @returns {Promise<RunningProxy>}
 */
async function startProxy(overrides = {}) {
  const server = createProxyServer({
    // An empty env object keeps the host machine's environment out of the test.
    env: {
      STITCH_URL: "http://127.0.0.1:1/mcp",
      LOG_ENABLED: "false",
      LOG_VIEWER_ENABLED: "false",
      METRICS_ENABLED: "false",
      ...(overrides.env || {}),
    },
    overrides: { ...overrides, env: undefined },
  });

  // Port 0 = ephemeral. `MCP_SERVER_PORT` is only consulted by `listen()` in the entry
  // point, not by `createProxyServer()`.
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  /** @param {string} path @param {RequestInit & { rawBody?: string }} [init] */
  const request = (path, init) => {
    const { rawBody, ...rest } = init || {};
    return fetch(
      `${url}${path}`,
      /** @type {RequestInit} */ ({ ...rest, body: rawBody ?? rest.body }),
    );
  };

  /** @param {string} path @param {any} body @param {RequestInit} [init] */
  const postJson = (path, body, init) =>
    request(path, {
      method: "POST",
      ...init,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...((init && init.headers) || {}),
      },
      rawBody: typeof body === "string" ? body : JSON.stringify(body),
    });

  /** @param {string} path @param {any} body @param {RequestInit} [init] */
  const postJsonForJson = async (path, body, init) => {
    const response = await postJson(path, body, init);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Expected JSON from ${path}, got: ${text.slice(0, 200)}`);
    }
  };

  return {
    port,
    url,
    mcpUrl: `${url}/mcp`,
    server,
    request,
    postJson,
    postJsonForJson,
    stop: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Standard teardown for a `node:test` context.
 *
 * @param {import("node:test").TestContext} t
 * @param {...({ stop: () => Promise<void> }|undefined)} resources
 */
function cleanup(t, ...resources) {
  t.after(async () => {
    for (const resource of resources) {
      if (resource && typeof resource.stop === "function") {
        await resource.stop();
      }
    }
  });
}

/**
 * Reads and parses a JSON response body, with a helpful failure message.
 *
 * Returns `any` on purpose: the proxy's payload shapes are asserted field by field in the
 * tests, and `Response.json()` is typed `Promise<unknown>`, which would force a cast at
 * every single call site.
 *
 * @param {Response} response
 * @returns {Promise<any>}
 */
async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON, got (status ${response.status}): ${text.slice(0, 300)}`);
  }
}

module.exports = { startProxy, cleanup, readJson };
