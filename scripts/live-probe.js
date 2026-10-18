#!/usr/bin/env node
// @ts-check
"use strict";

/**
 * Opt-in live probe for the two questions about Stitch that no local test can answer.
 *
 * 1. **Does Stitch implement `resources/list` and `resources/templates/list`?** (finding P4)
 *    The proxy knows the shape of the answer for `prompts/list` — Stitch resets the HTTP/2 stream
 *    and returns nothing, which clients surface as `fetch failed` — and answers that method
 *    locally. It carries empty-result entries for the other two but leaves them out of
 *    `LOCAL_FALLBACK_METHODS` until someone verifies Stitch implements them. Verified 2026-10-18:
 *    both are implemented (empty collections), so only `prompts/list` stays local.
 *
 * 2. **Does Stitch annotate its tools, and do the hints agree with the proxy's table?**
 *    The `tools/list` annotation injection only fills in what the upstream left blank, so this
 *    says whether clients see Stitch's hints or ours — and whether any tool is advertised as
 *    read-only while the proxy treats it as unsafe. Verified 2026-10-18: 15/15 annotated, no
 *    disagreements, so the injection injects nothing.
 *
 * That cannot be answered by reading code or by a fake upstream, so this script asks the real
 * endpoint. It is deliberately hard to run by accident:
 *
 *   - `--i-understand` is mandatory;
 *   - it refuses to run when `CI` is set;
 *   - the key comes from `STITCH_API_KEY` only, never from argv (argv lands in shell history);
 *   - the key is reported as `configured`/`missing`, exactly like `test.sh`.
 *
 * It sends only **read-only discovery calls** (`initialize`, `tools/list`, `prompts/list`,
 * `resources/list`, `resources/templates/list`). No project is touched and no generation quota is
 * spent. `tools/list` doubles as the control: if the control fails, the other rows mean nothing.
 *
 * Usage:
 *   STITCH_API_KEY=... node scripts/live-probe.js --i-understand
 *   npm run probe:live -- --i-understand
 *
 * Exit codes: 0 = probe completed, 1 = could not conclude (control call failed), 2 = usage error.
 */

const { annotationsForTool, classifyRequest } = require("../src/mcp/classify.js");

const DEFAULT_STITCH_URL = "https://stitch.googleapis.com/mcp";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 20000;
const CLIENT_NAME = "gstitch-mcproxy-live-probe";

/** Methods this probe sends, in order. `tools/list` is the control. */
const PROBES = [
  { method: "tools/list", control: true, collectionKey: "tools" },
  { method: "prompts/list", collectionKey: "prompts" },
  { method: "resources/list", collectionKey: "resources" },
  { method: "resources/templates/list", collectionKey: "resourceTemplates" },
];

const USAGE = `P4 live probe — asks Stitch whether it implements resources/list.

  STITCH_API_KEY=... npm run probe:live -- --i-understand

Options:
  --i-understand   required; confirms you know this contacts the real Stitch endpoint
  --json           machine-readable output
  --help, -h       this text

Environment:
  STITCH_API_KEY       required (never pass the key as an argument)
  STITCH_URL           default ${DEFAULT_STITCH_URL}
  MCP_PROTOCOL_VERSION default ${DEFAULT_PROTOCOL_VERSION}
  PROBE_TIMEOUT_MS     default ${DEFAULT_TIMEOUT_MS}

Sends read-only discovery calls only. Refuses to run when CI is set.`;

/**
 * @param {string[]} argv
 * @returns {{ understand: boolean, json: boolean, help: boolean } | { error: string }}
 */
function parseArgs(argv) {
  const options = { understand: false, json: false, help: false };

  for (const arg of argv) {
    if (arg === "--i-understand") {
      options.understand = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      return { error: `Unknown argument: ${arg}` };
    }
  }

  return options;
}

/**
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
function snippet(text, max = 200) {
  const collapsed = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/**
 * Parses an SSE body and returns the first JSON-RPC message that carries a result or error.
 *
 * @param {string} text
 * @returns {any|null}
 */
function parseSseBody(text) {
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

    if (!data) {
      continue;
    }

    try {
      const parsed = JSON.parse(data);
      if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) {
        return parsed;
      }
    } catch {
      // A ping or comment event is not JSON; ignore it and keep reading.
    }
  }

  return null;
}

/**
 * @param {string} text
 * @param {string} contentType
 * @returns {any|null}
 */
function parseBody(text, contentType) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return null;
  }

  const looksLikeSse =
    contentType.includes("text/event-stream") ||
    trimmed.startsWith("event:") ||
    trimmed.startsWith("data:");

  if (looksLikeSse) {
    const fromSse = parseSseBody(trimmed);
    if (fromSse) {
      return fromSse;
    }
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return (
        parsed.find(
          (entry) => entry && (entry.result !== undefined || entry.error !== undefined),
        ) || null
      );
    }
    return parsed;
  } catch {
    return parseSseBody(trimmed);
  }
}

/**
 * One JSON-RPC POST. Never throws: transport failures are part of the answer.
 *
 * @param {{ url: string, headers: Record<string, string>, message: any, timeoutMs: number }} options
 */
async function postJsonRpc({ url, headers, message, timeoutMs }) {
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();

    return {
      transportOk: true,
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      sessionId: response.headers.get("mcp-session-id"),
      protocolVersion: response.headers.get("mcp-protocol-version"),
      text,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      transportOk: false,
      error,
      elapsedMs: Date.now() - startedAt,
    };
  }
}

/**
 * Turns a raw POST result into a comparable outcome.
 *
 * @param {Awaited<ReturnType<typeof postJsonRpc>>} call
 */
function describeOutcome(call) {
  if (!call.transportOk) {
    const error = call.error;
    const code = error?.cause?.code || error?.code || error?.name || "unknown";
    return {
      kind: /** @type {const} */ ("transport"),
      code: String(code),
      detail: `${error?.name || "Error"}: ${error?.message || "fetch failed"} (${code})`,
      elapsedMs: call.elapsedMs,
    };
  }

  if (call.status < 200 || call.status >= 300) {
    return {
      kind: /** @type {const} */ ("http"),
      code: String(call.status),
      detail: `HTTP ${call.status}: ${snippet(call.text)}`,
      elapsedMs: call.elapsedMs,
      status: call.status,
    };
  }

  const message = parseBody(call.text, call.contentType);

  if (!message) {
    return {
      kind: /** @type {const} */ ("unparsable"),
      code: "no-jsonrpc",
      detail: `no JSON-RPC message in ${call.contentType || "unknown content type"}: ${snippet(call.text)}`,
      elapsedMs: call.elapsedMs,
      status: call.status,
    };
  }

  if (message.error) {
    return {
      kind: /** @type {const} */ ("rpc-error"),
      code: String(message.error.code),
      detail: `${message.error.code}: ${message.error.message}`,
      elapsedMs: call.elapsedMs,
      status: call.status,
    };
  }

  return {
    kind: /** @type {const} */ ("result"),
    code: "ok",
    detail: "result",
    elapsedMs: call.elapsedMs,
    status: call.status,
    result: message.result,
  };
}

/** Transport errors that mean "the server killed the stream mid-flight", not "network is down". */
const STREAM_RESET_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ERR_HTTP2_STREAM_ERROR",
  "ERR_HTTP2_STREAM_CANCEL",
  "UND_ERR_SOCKET",
  "AbortError",
]);

/**
 * Maps one probe outcome to a P4 verdict and the fallback recommendation that follows from it.
 *
 * @param {{ control?: boolean, method: string, collectionKey: string }} probe
 * @param {ReturnType<typeof describeOutcome>} outcome
 */
function verdictFor(probe, outcome) {
  if (probe.control) {
    if (outcome.kind === "result") {
      const tools = Array.isArray(outcome.result?.tools) ? outcome.result.tools.length : 0;
      return {
        verdict: "control OK",
        implemented: /** @type {boolean|null} */ (true),
        detail: `${tools} tool(s) returned — transport and credential work`,
        recommendation: null,
      };
    }

    return {
      verdict: "control FAILED",
      implemented: /** @type {boolean|null} */ (null),
      detail: `${outcome.detail} — every other row is inconclusive`,
      recommendation: null,
    };
  }

  if (outcome.kind === "result") {
    const items = outcome.result?.[probe.collectionKey];
    const count = Array.isArray(items) ? items.length : null;
    const empty = count === 0;

    return {
      verdict: empty ? "implemented (empty)" : "implemented",
      implemented: /** @type {boolean|null} */ (true),
      detail:
        count === null
          ? `result has no ${probe.collectionKey} array; shape: ${snippet(JSON.stringify(outcome.result), 120)}`
          : `${count} ${probe.collectionKey} entr${count === 1 ? "y" : "ies"}`,
      recommendation: `leave ${probe.method} out of LOCAL_FALLBACK_METHODS — Stitch answers it`,
    };
  }

  if (outcome.kind === "rpc-error") {
    const notFound = outcome.code === "-32601" || /method not found/i.test(outcome.detail);
    return {
      verdict: notFound ? "not implemented (method not found)" : `error ${outcome.code}`,
      implemented: /** @type {boolean|null} */ (notFound ? false : null),
      detail: outcome.detail,
      recommendation: notFound
        ? `safe to keep ${probe.method} in LOCAL_FALLBACK_METHODS (Stitch has no such method)`
        : `inconclusive — fix the error before drawing a conclusion about ${probe.method}`,
    };
  }

  if (outcome.kind === "transport") {
    const reset = STREAM_RESET_CODES.has(outcome.code);
    return {
      verdict: reset ? "not implemented (stream reset)" : "transport failure",
      implemented: /** @type {boolean|null} */ (reset ? false : null),
      detail: outcome.detail,
      recommendation: reset
        ? `keep ${probe.method} in LOCAL_FALLBACK_METHODS — this is the prompts/list failure mode`
        : `inconclusive — ${outcome.code} is not the known stream-reset signature`,
    };
  }

  return {
    verdict: outcome.kind === "http" ? `HTTP ${outcome.code}` : "unparsable response",
    implemented: /** @type {boolean|null} */ (null),
    detail: outcome.detail,
    recommendation: `inconclusive — ${probe.method} needs a manual look`,
  };
}

/** @param {number} ms */
function pad(ms) {
  return String(ms).padStart(6);
}

/** @param {string} value @param {number} width */
function column(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if ("error" in options) {
    console.error(`${options.error}\n\n${USAGE}`);
    return 2;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  if (!options.understand) {
    console.error(
      "This probe contacts the real Stitch endpoint. Re-run with --i-understand to confirm.\n\n" +
        USAGE,
    );
    return 2;
  }

  if (process.env.CI) {
    console.error(
      "Refusing to run: CI is set. This probe spends the owner's credential and must stay opt-in.",
    );
    return 2;
  }

  const apiKey = process.env.STITCH_API_KEY;
  if (!apiKey) {
    console.error("Missing STITCH_API_KEY in the environment. It is never read from argv.");
    return 2;
  }

  const url = process.env.STITCH_URL || DEFAULT_STITCH_URL;
  const protocolVersion = process.env.MCP_PROTOCOL_VERSION || DEFAULT_PROTOCOL_VERSION;
  const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  const baseHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "X-Goog-Api-Key": apiKey,
    "MCP-Protocol-Version": protocolVersion,
  };

  if (!options.json) {
    console.log(`P4 live probe — endpoint ${url}`);
    console.log("  api key:  configured");
    console.log(`  protocol: ${protocolVersion}`);
    console.log(`  timeout:  ${timeoutMs}ms per call`);
    console.log("");
  }

  // --- initialize (establishes a session when Stitch wants one) -------------------------
  const initCall = await postJsonRpc({
    url,
    headers: baseHeaders,
    message: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: "1.0.0" },
      },
    },
    timeoutMs,
  });
  const initOutcome = describeOutcome(initCall);

  const headers = { ...baseHeaders };
  if (initCall.transportOk && initCall.sessionId) {
    headers["Mcp-Session-Id"] = initCall.sessionId;
  }
  if (initCall.transportOk && initCall.protocolVersion) {
    headers["MCP-Protocol-Version"] = initCall.protocolVersion;
  }

  // `notifications/initialized` is a courtesy: some servers ignore unknown notifications, and
  // an empty acknowledgement here is not a failure worth reporting.
  if (initOutcome.kind === "result" && initCall.sessionId) {
    await postJsonRpc({
      url,
      headers,
      message: { jsonrpc: "2.0", method: "notifications/initialized" },
      timeoutMs,
    });
  }

  // --- the actual probes ---------------------------------------------------------------
  const rows = [];
  let id = 2;

  for (const probe of PROBES) {
    const call = await postJsonRpc({
      url,
      headers,
      message: { jsonrpc: "2.0", id, method: probe.method, params: {} },
      timeoutMs,
    });
    const outcome = describeOutcome(call);
    rows.push({ probe, outcome, verdict: verdictFor(probe, outcome) });
    id += 1;
  }

  const control = rows.find((row) => row.probe.control);
  const controlOk = control ? control.verdict.verdict === "control OK" : false;

  // Second question, answered by the same call: does Stitch annotate its tools? The proxy only
  // injects `readOnlyHint`/`destructiveHint` when the upstream did not supply them, so this says
  // whether clients are seeing Stitch's annotations or ours.
  const tools = control?.outcome.kind === "result" ? control.outcome.result?.tools : null;
  const annotationSummary = Array.isArray(tools)
    ? {
        tools: tools.length,
        withAnnotations: tools.filter((tool) => tool?.annotations).length,
        withReadOnlyHint: tools.filter((tool) => tool?.annotations?.readOnlyHint !== undefined)
          .length,
        injectedByProxy: tools.filter(
          (tool) =>
            typeof tool?.name === "string" && annotationsForTool(tool.name, tool.annotations),
        ).length,
        // A tool Stitch calls read-only but the proxy treats as unsafe is the interesting case:
        // clients would see no warning, while the proxy still refuses to retry it.
        readOnlyDisagreements: tools
          .filter(
            (tool) =>
              typeof tool?.name === "string" &&
              tool.annotations?.readOnlyHint === true &&
              !classifyRequest(
                { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool.name } },
                {},
              ).safe,
          )
          .map((tool) => tool.name),
      }
    : null;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          url,
          protocolVersion,
          apiKey: "configured",
          initialize: initOutcome,
          controlOk,
          annotations: annotationSummary,
          results: rows.map((row) => ({
            method: row.probe.method,
            control: Boolean(row.probe.control),
            status: row.outcome.status ?? null,
            elapsedMs: row.outcome.elapsedMs,
            outcome: row.outcome.kind,
            code: row.outcome.code,
            detail: row.outcome.detail,
            verdict: row.verdict.verdict,
            implemented: row.verdict.implemented,
            recommendation: row.verdict.recommendation,
          })),
        },
        null,
        2,
      ),
    );
    return controlOk ? 0 : 1;
  }

  console.log(`initialize: ${initOutcome.kind === "result" ? "OK" : initOutcome.detail}`);
  if (initCall.transportOk && initCall.sessionId) {
    console.log(`session: ${initCall.sessionId}`);
  }
  console.log("");

  const methodWidth = Math.max(...rows.map((row) => row.probe.method.length), 8) + 2;
  const verdictWidth =
    Math.max(...rows.map((row) => row.verdict.verdict.length), "verdict".length) + 2;
  console.log(
    `${column("method", methodWidth)}${column("verdict", verdictWidth)}${column("http", 6)}${column("ms", 8)}detail`,
  );
  console.log("-".repeat(methodWidth + verdictWidth + 6 + 8 + 40));

  for (const row of rows) {
    const status = row.outcome.status === undefined ? "-" : String(row.outcome.status);
    console.log(
      `${column(row.probe.method, methodWidth)}${column(
        row.verdict.verdict,
        verdictWidth,
      )}${column(status, 6)}${pad(row.outcome.elapsedMs)}  ${row.verdict.detail}`,
    );
  }

  console.log("");

  if (!controlOk) {
    console.log(
      "Could not conclude: the tools/list control call failed, so the other rows prove nothing.",
    );
    console.log(
      "Check STITCH_API_KEY, network access, and whether Stitch still accepts this endpoint.",
    );
    return 1;
  }

  if (annotationSummary) {
    console.log("— Tool annotations —");
    console.log(
      `${annotationSummary.withAnnotations} of ${annotationSummary.tools} tools carry annotations; ` +
        `${annotationSummary.withReadOnlyHint} carry readOnlyHint; ` +
        `the proxy would inject annotations for ${annotationSummary.injectedByProxy}.`,
    );
    if (annotationSummary.readOnlyDisagreements.length > 0) {
      console.log(
        `⚠️  readOnlyHint disagrees with the proxy's classification for: ${annotationSummary.readOnlyDisagreements.join(", ")}`,
      );
    }
    console.log("");
  }

  console.log("— Verdict for P4 —");
  for (const row of rows) {
    if (row.probe.control) {
      continue;
    }
    console.log(`${column(row.probe.method, methodWidth)}${row.verdict.verdict}`);
    console.log(`${" ".repeat(methodWidth)}${row.verdict.recommendation}`);
  }

  console.log("");
  console.log("Paste the next line into test/bugs.test.js and PROGRESS.md §10.2 to close P4:");
  console.log("");
  console.log(
    `  ${rows
      .filter((row) => !row.probe.control)
      .map((row) => `${row.probe.method}=${row.verdict.verdict}`)
      .join("; ")}`,
  );

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
