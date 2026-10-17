// @ts-check
"use strict";

/**
 * A scripted fake Stitch upstream for tests.
 *
 * Responsibilities:
 *   - listen on an ephemeral localhost port,
 *   - **record every received request** (method, url, headers, raw body, parsed JSON-RPC),
 *   - replay a per-test scripted behaviour.
 *
 * No test in this repository may ever talk to the real Stitch endpoint: its tools have
 * user-visible side effects (project creation, screen generation, spent quota).
 *
 * Behaviour script (`fake.script`), applied per request — when the script is an array and
 * has more than one entry, entries are consumed one per request:
 *   - `{ type: "json", status?, body?, headers? }`      respond immediately with JSON
 *   - `{ type: "sse", events?, never?, endAfterMs? }`   respond `text/event-stream`
 *   - `{ type: "resetAfterReceive" }`                   read, then destroy the socket
 *   - `{ type: "hang" }`                                accept and never respond
 *   - `{ type: "delay", ms, then? }`                    wait, then apply `then`
 *   - `{ type: "status", status, headers?, body? }`    respond with an arbitrary status
 *   - `{ type: "refuse" }`                             destroy the socket on connect
 */

const http = require("node:http");

/**
 * @typedef {object} RecordedRequest
 * @property {string} method
 * @property {string} url
 * @property {Record<string, string|string[]|undefined>} headers
 * @property {string} body
 * @property {any} json
 * @property {string|null} rpcMethod
 * @property {any} id
 * @property {string|null} toolName
 * @property {number} receivedAt
 */

/**
 * @typedef {object} FakeStitch
 * @property {number} port
 * @property {string} url
 * @property {() => RecordedRequest[]} requests
 * @property {() => number} count
 * @property {() => void} reset
 * @property {(script: object|object[]) => void} script
 * @property {() => Promise<void>} close
 * @property {(event: string, fn: (...args: any[]) => void) => void} on
 * @property {() => Promise<void>} waitForReset
 */

/**
 * @param {object|object[]} [initialScript]
 * @returns {Promise<FakeStitch>}
 */
async function startFakeStitch(initialScript) {
  /** @type {RecordedRequest[]} */
  const received = [];
  /** @type {object[]} */
  let script = Array.isArray(initialScript)
    ? initialScript.slice()
    : initialScript
      ? [initialScript]
      : [];
  /** @type {Map<string, Array<(...args: any[]) => void>>} */
  const listeners = new Map();

  /** @type {Array<() => void>} */
  const resetWaiters = [];

  const emit = (event, ...args) => {
    for (const fn of listeners.get(event) || []) {
      fn(...args);
    }
    if (event === "reset") {
      for (const resolve of resetWaiters.splice(0)) {
        resolve();
      }
    }
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", () => {});
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      /** @type {RecordedRequest} */
      const entry = {
        method: req.method || "",
        url: req.url || "",
        headers: req.headers,
        body,
        json: safeParse(body),
        rpcMethod: rpcMethodOf(body),
        id: rpcIdOf(body),
        toolName: toolNameOf(body),
        receivedAt: Date.now(),
      };
      received.push(entry);
      emit("request", entry);

      const behaviour = script.length > 1 ? script.shift() : script[0];
      applyBehaviour(behaviour, res, emit);
    });
  });

  // `refuse` must drop the connection before the request can be read, which only the
  // `connection` event can do.
  server.on("connection", (socket) => {
    const behaviour = script.length > 0 ? script[0] : undefined;
    if (behaviour && behaviour.type === "refuse") {
      socket.destroy();
    }
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    requests: () => received,
    count: () => received.length,
    reset: () => {
      received.length = 0;
    },
    script: (next) => {
      script = Array.isArray(next) ? next.slice() : [next];
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    on: (event, fn) => {
      const existing = listeners.get(event) || [];
      existing.push(fn);
      listeners.set(event, existing);
    },
    waitForReset: () =>
      new Promise((resolve) => {
        resetWaiters.push(resolve);
      }),
  };
}

/**
 * @param {object|undefined} behaviour
 * @param {import("node:http").ServerResponse} res
 * @param {(event: string, ...args: any[]) => void} emit
 */
function applyBehaviour(behaviour, res, emit) {
  const b = behaviour || { type: "json" };

  switch (b.type) {
    case "json":
      res.writeHead(b.status || 200, {
        "Content-Type": "application/json",
        ...(b.headers || {}),
      });
      res.end(
        typeof b.body === "string"
          ? b.body
          : JSON.stringify(b.body || { jsonrpc: "2.0", id: 1, result: {} }),
      );
      return;

    case "sse": {
      res.writeHead(b.status || 200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        ...(b.headers || {}),
      });
      const events = b.events || ['event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'];
      let index = 0;
      if (events.length > 0) {
        res.write(events[0]);
        index = 1;
      }
      if (b.never) {
        emit("stream-open", res);
        return; // never ends: the peer must decide when to stop
      }
      const interval = setInterval(() => {
        if (index < events.length) {
          res.write(events[index]);
          index += 1;
        } else {
          clearInterval(interval);
          if (!res.writableEnded) {
            res.end();
            emit("stream-end", res);
          }
        }
      }, b.eventIntervalMs || 5);
      if (b.endAfterMs) {
        setTimeout(() => {
          clearInterval(interval);
          if (!res.writableEnded) {
            res.end();
            emit("stream-end", res);
          }
        }, b.endAfterMs);
      }
      return;
    }

    case "resetAfterReceive":
      // The request is fully received: destroy the socket so the client observes
      // ECONNRESET *after* the upstream has already seen the request.
      emit("reset", res);
      res.destroy();
      return;

    case "hang":
      emit("stream-open", res);
      return; // never respond at all

    case "delay":
      setTimeout(() => {
        applyBehaviour(b.then || { type: "json" }, res, emit);
      }, b.ms || 50);
      return;

    case "status":
      res.writeHead(b.status || 500, {
        "Content-Type": b.contentType || "application/json",
        ...(b.headers || {}),
      });
      res.end(b.body === undefined ? "" : b.body);
      return;

    case "refuse":
      res.destroy();
      return;

    default:
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `unknown fake behaviour: ${b.type}` }));
  }
}

function safeParse(text) {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function firstMessage(body) {
  const parsed = safeParse(body);
  if (!parsed) {
    return null;
  }
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function rpcMethodOf(body) {
  const message = firstMessage(body);
  return message && typeof message.method === "string" ? message.method : null;
}

function rpcIdOf(body) {
  const message = firstMessage(body);
  return message ? message.id : undefined;
}

function toolNameOf(body) {
  const message = firstMessage(body);
  const name = message?.params?.name;
  return typeof name === "string" ? name : null;
}

module.exports = { startFakeStitch, safeParse };
