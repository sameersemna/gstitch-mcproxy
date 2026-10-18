// @ts-check
"use strict";

/**
 * Phase 1b — logging attribution and secret hygiene.
 *
 * Covers ★N5 (per-project debug logs used the env default instead of the project ID the call
 * actually used), ★N6 (the error-path debug log dropped the request body — the requests you
 * most need to debug) and ★N8 (`test.sh` printed the API key).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { startProxy, readJson } = require("./helpers/startProxy.js");
const { startFakeStitch } = require("./helpers/fakeStitch.js");

/**
 * Creates a throwaway log directory and registers its removal.
 *
 * @param {import("node:test").TestContext} t
 * @returns {string}
 */
function tempLogDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstitch-logdir-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Returns the single detail-log file written for a project, or null.
 *
 * @param {string} logDir
 * @param {string} projectId
 * @returns {string|null}
 */
function readDetailLog(logDir, projectId) {
  const projectDir = path.join(logDir, projectId);
  if (!fs.existsSync(projectDir)) {
    return null;
  }
  const files = fs.readdirSync(projectDir).filter((name) => name.endsWith(".log"));
  if (files.length === 0) {
    return null;
  }
  return fs.readFileSync(path.join(projectDir, files[0]), "utf8");
}

// ---------------------------------------------------------------------------
// ★N5 — debug logs must be attributed to the project the call actually used
// ---------------------------------------------------------------------------

test("★N5 – a tools/call with arguments.projectId logs into that project's directory", async (t) => {
  const logDir = tempLogDir(t);
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    LOG_ENABLED: true,
    LOG_LEVEL: "debug",
    LOG_DIR: logDir,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "list_screens", arguments: { projectId: "11131813417124074864" } },
  });

  const detail = readDetailLog(logDir, "11131813417124074864");
  assert.ok(
    detail !== null,
    "★N5: the detail log must live under the project ID from the tool arguments, " +
      `not under "unknown-project". Directories found: ${JSON.stringify(
        fs.existsSync(logDir) ? fs.readdirSync(logDir) : [],
      )}`,
  );
  assert.match(detail, /projectId: 11131813417124074864/);
});

test("★N5 – arguments.projectId wins over the env default for logging", async (t) => {
  const logDir = tempLogDir(t);
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    DEFAULT_STITCH_PROJECT_ID: "env-default-project",
    LOG_ENABLED: true,
    LOG_LEVEL: "debug",
    LOG_DIR: logDir,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "list_screens", arguments: { projectId: "arg-project" } },
  });

  assert.ok(
    readDetailLog(logDir, "arg-project") !== null,
    "★N5: the argument project ID must win for log attribution",
  );
});

test("★N5 – requests without arguments.projectId still fall back to the env default", async (t) => {
  const logDir = tempLogDir(t);
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    DEFAULT_STITCH_PROJECT_ID: "env-default-project",
    LOG_ENABLED: true,
    LOG_LEVEL: "debug",
    LOG_DIR: logDir,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson("/mcp", { jsonrpc: "2.0", id: 3, method: "tools/list" });

  assert.ok(
    readDetailLog(logDir, "env-default-project") !== null,
    "★N5: with no project in the arguments the env default should be used",
  );
});

test("★N5 – the summary log records the project ID the call actually used", async (t) => {
  const logDir = tempLogDir(t);
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    LOG_ENABLED: true,
    LOG_LEVEL: "info",
    LOG_DIR: logDir,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "list_screens", arguments: { projectId: "summary-project" } },
  });

  const summary = fs.readFileSync(path.join(logDir, "proxy.log"), "utf8");
  assert.match(
    summary,
    /PROJECT_ID: summary-project/,
    "★N5: the summary line must name the project the call used",
  );
});

test("★N5 – the upstream X-Stitch-Project-Id header still comes from the env default", async (t) => {
  // Backward compatibility (commit c125891 deprecated supplying the project ID via headers).
  // Phase 1b only changes log attribution; the upstream header source is unchanged.
  const upstream = await startFakeStitch({ type: "json" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    DEFAULT_STITCH_PROJECT_ID: "env-default-project",
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "list_screens", arguments: { projectId: "arg-project" } },
  });

  assert.equal(
    upstream.requests()[0].headers["x-stitch-project-id"],
    "env-default-project",
    "the upstream project header must keep coming from the env default",
  );
});

// ---------------------------------------------------------------------------
// ★N6 — the error-path debug log must keep the request body
// ---------------------------------------------------------------------------

test("★N6 – a 502 with debug logging keeps the request body in the detail log", async (t) => {
  const logDir = tempLogDir(t);
  const proxy = await startProxy({
    // Port 1 on loopback refuses quickly: a connect-phase failure.
    STITCH_URL: "http://127.0.0.1:1/mcp",
    STITCH_API_KEY: "env-key",
    UPSTREAM_RETRY_ENABLED: false,
    LOG_ENABLED: true,
    LOG_LEVEL: "debug",
    LOG_DIR: logDir,
  });
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: "err-1",
    method: "tools/call",
    params: { name: "list_screens", arguments: { projectId: "err-project" } },
  });
  assert.equal(response.status, 502);

  const detail = readDetailLog(logDir, "err-project");
  assert.ok(detail !== null, "★N6: the failed request must still produce a detail log");

  assert.match(detail, /responseStatus: 502/);
  assert.match(detail, /error:/, "the detail log must record the failure");

  // The whole reason for the fix: the request that failed must be reproducible from the log.
  assert.match(
    detail,
    /list_screens/,
    "★N6: the error-path detail log must contain the request body it failed on",
  );
  assert.match(detail, /err-project/);
});

test("★N6 – the error-path detail log records a real timestamp", async (t) => {
  const logDir = tempLogDir(t);

  const proxy = await startProxy({
    STITCH_URL: "http://127.0.0.1:1/mcp",
    STITCH_API_KEY: "env-key",
    UPSTREAM_RETRY_ENABLED: false,
    LOG_ENABLED: true,
    LOG_LEVEL: "debug",
    LOG_DIR: logDir,
  });
  t.after(() => proxy.stop());

  await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/list",
    params: { marker: "time-check" },
  });

  const projectDir = path.join(logDir, "unknown-project");
  assert.ok(fs.existsSync(projectDir), "a detail log should exist");
  const files = fs.readdirSync(projectDir);
  const detail = fs.readFileSync(path.join(projectDir, files[0]), "utf8");

  // The filename carries the timestamp, so if it were empty the file name would start with
  // a dash. Assert both the name and the field are well formed.
  assert.match(
    files[0],
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/,
    `bad file name: ${files[0]}`,
  );
  assert.match(detail, /timestamp: \d{4}-\d{2}-\d{2}T/);
  assert.ok(!/timestamp: \s*\n/.test(detail), "the timestamp must not be empty");
});

test("★N6 – a timeout (504) keeps the request body in the detail log", async (t) => {
  const logDir = tempLogDir(t);
  const upstream = await startFakeStitch({ type: "hang" });
  const proxy = await startProxy({
    STITCH_URL: upstream.url,
    STITCH_API_KEY: "env-key",
    REQUEST_TIMEOUT_MS: 150,
    UPSTREAM_RETRY_ENABLED: false,
    LOG_ENABLED: true,
    LOG_LEVEL: "debug",
    LOG_DIR: logDir,
  });
  t.after(() => upstream.close());
  t.after(() => proxy.stop());

  const response = await proxy.postJson("/mcp", {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "list_screens", arguments: { projectId: "to-project" } },
  });
  assert.equal(response.status, 504);
  assert.equal((await readJson(response)).error.code, -32004);

  const detail = readDetailLog(logDir, "to-project");
  assert.ok(detail !== null, "★N6: a timed-out request must produce a detail log");
  assert.match(detail, /list_screens/);
});

// ---------------------------------------------------------------------------
// ★N8 — test.sh must not print the API key
// ---------------------------------------------------------------------------

test("★N8 – test.sh never echoes the API key", async () => {
  const script = fs.readFileSync(path.join(__dirname, "..", "test.sh"), "utf8");

  // Any echo/printf that interpolates the key variable would leak it into terminals and CI
  // logs — including the `set -x` output of a calling script.
  const leaky = script
    .split("\n")
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => /(echo|printf)/.test(line) && /STITCH_API_KEY\}/.test(line));

  assert.deepEqual(
    leaky,
    [],
    `★N8: test.sh must not print the API key. Offending lines: ${JSON.stringify(leaky)}`,
  );
});

test("★N8 – test.sh reports the key as configured/missing instead", async () => {
  const script = fs.readFileSync(path.join(__dirname, "..", "test.sh"), "utf8");

  assert.ok(
    /api key:.*API_KEY_STATE/.test(script),
    "★N8: test.sh should print an api-key indication derived from a state variable",
  );
  assert.ok(
    /API_KEY_STATE="configured"/.test(script) && /API_KEY_STATE="missing"/.test(script),
    "★N8: the state variable must distinguish configured from missing",
  );
});

test("★N8 – running test.sh with a sentinel key never prints that key", async (t) => {
  // A functional leak test: run the real script in an isolated directory (so the developer's
  // own `.env` and credentials are never involved) with a sentinel key and an unreachable
  // server. The script fails at the first curl, but everything it prints before that is
  // captured and searched for the sentinel.
  const os = require("node:os");
  const { spawnSync } = require("node:child_process");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstitch-testsh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const scriptPath = path.join(dir, "test.sh");
  fs.copyFileSync(path.join(__dirname, "..", "test.sh"), scriptPath);

  const SENTINEL = "SENTINEL-DO-NOT-PRINT-9f3a2b";
  const result = spawnSync("bash", [scriptPath], {
    cwd: dir,
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      STITCH_API_KEY: SENTINEL,
      MCP_SERVER_URL: "http://127.0.0.1:9",
      MCP_SERVER_PORT: "9",
      MCP_SERVER_HOST: "127.0.0.1",
    },
  });

  const output = `${result.stdout || ""}${result.stderr || ""}`;

  assert.ok(
    !output.includes(SENTINEL),
    `★N8: test.sh printed the API key. Output was:\n${output.slice(0, 500)}`,
  );
  assert.ok(
    /api key: configured/i.test(output),
    `★N8: test.sh should report the key as configured. Output was:\n${output.slice(0, 500)}`,
  );
});
