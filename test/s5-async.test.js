// @ts-check
"use strict";

/**
 * Finding S5 — no synchronous I/O on the request path.
 *
 * The baseline used `readFileSync` of the whole summary log, `appendFileSync` + `statSync` +
 * `renameSync` per logged request, synchronous directory scans for the log viewer, and
 * `execSync("gcloud auth print-access-token")`. Each one blocked the event loop, so a large log
 * directory or a slow `gcloud` stalled every other connection.
 *
 * The static assertion is the important one: it fails the moment a synchronous call reappears in
 * the request path, which is easy to do absent-mindedly. The behavioural tests prove the async
 * replacements still write, rotate and serve what the viewer expects.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { startProxy } = require("./helpers/startProxy.js");
const { flushSummaryLogs } = require("../index.js");

const ROOT = path.join(__dirname, "..");
const INDEX = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

/** Strips comments so prose about `readFileSync` is not mistaken for a call. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("S5: the request path uses no synchronous fs or exec calls", () => {
  // `loadEnvFile` runs once, before the server listens, so blocking there is harmless.
  const withoutStartup = stripComments(INDEX).replace(
    /function loadEnvFile\([\s\S]*?\n}\n/,
    "function loadEnvFile() {}\n",
  );

  const forbidden = [
    "readFileSync",
    "writeFileSync",
    "appendFileSync",
    "readdirSync",
    "statSync",
    "renameSync",
    "unlinkSync",
    "mkdirSync",
    "existsSync",
    "execSync",
  ];

  const found = forbidden.filter((name) => new RegExp(`\\b${name}\\b`).test(withoutStartup));

  assert.deepEqual(
    found,
    [],
    `synchronous calls are back in the request path: ${found.join(", ")}`,
  );
});

test("S5: a logged request is readable through the log viewer straight away", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstitch-s5-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const proxy = await startProxy({
    LOG_DIR: dir,
    LOG_ENABLED: true,
    LOG_LEVEL: "info",
    LOG_VIEWER_ENABLED: true,
    UPSTREAM_RETRY_ENABLED: false,
    STITCH_API_KEY: "test-key",
  });
  t.after(() => proxy.stop());

  // The default upstream is a closed port: the request fails fast and is still logged.
  const response = await proxy.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    rawBody: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
  });
  assert.equal(response.status, 502);
  await response.text();

  const summary = await proxy.request("/api/logs/summary?limit=10");
  const body = /** @type {{ total: number, lines: Array<{ number: number, text: string }> }} */ (
    await summary.json()
  );

  assert.equal(body.total, 1, "the request wrote exactly one summary line");
  assert.match(body.lines[0].text, /STATUS: 502/);
});

test("S5: rotation still caps the summary log", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstitch-s5-rot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const proxy = await startProxy({
    LOG_DIR: dir,
    LOG_ENABLED: true,
    LOG_LEVEL: "info",
    LOG_MAX_FILE_SIZE_BYTES: 150,
    LOG_MAX_ROTATED_FILES: 2,
    UPSTREAM_RETRY_ENABLED: false,
    STITCH_API_KEY: "test-key",
  });
  t.after(() => proxy.stop());

  for (let index = 0; index < 6; index += 1) {
    const response = await proxy.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      rawBody: JSON.stringify({ jsonrpc: "2.0", id: index, method: "tools/list" }),
    });
    await response.text();
  }

  await flushSummaryLogs();

  const files = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("proxy.log"))
    .sort();
  assert.ok(files.length <= 3, `rotation must cap the files, found ${files.join(", ")}`);

  const lines = files.flatMap((name) =>
    fs
      .readFileSync(path.join(dir, name), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== ""),
  );

  assert.equal(lines.length, 6, "rotation must not lose or duplicate lines");
});

test("S5: the shutdown flush resolves and is exportable", async () => {
  await assert.doesNotReject(() => flushSummaryLogs());
});
