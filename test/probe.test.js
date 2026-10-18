// @ts-check
"use strict";

/**
 * Safety rails for `scripts/live-probe.js` — the opt-in probe that closes finding P4.
 *
 * The probe talks to the real Stitch endpoint with the owner's credential, so the properties
 * worth protecting are not its output but its *refusals*: it must never run without an explicit
 * confirmation, never run in CI, and never accept a key from the command line where it would land
 * in shell history. These tests spawn the script with a scrubbed environment; none of them
 * contacts the network, because every case exits before the first request.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const PROBE = path.join(ROOT, "scripts", "live-probe.js");

/**
 * Runs the probe with a clean environment so an exported `STITCH_API_KEY` or `CI` in the
 * developer's shell cannot change the result.
 *
 * @param {string[]} args
 * @param {Record<string, string>} [overrides]
 */
function runProbe(args, overrides = {}) {
  return spawnSync(process.execPath, [PROBE, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      CI: "",
      STITCH_API_KEY: "",
      ...overrides,
    },
  });
}

test("probe: refuses to run without --i-understand", () => {
  const result = runProbe([]);

  assert.equal(result.status, 2, "must exit with the usage code");
  assert.match(result.stderr, /--i-understand/, "the refusal must say how to proceed");
  assert.doesNotMatch(result.stdout, /initialize/, "nothing may be sent upstream");
});

test("probe: refuses to run when CI is set", () => {
  const result = runProbe(["--i-understand"], { CI: "1", STITCH_API_KEY: "not-a-real-key" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Refusing to run: CI is set/);
});

test("probe: requires STITCH_API_KEY in the environment", () => {
  const result = runProbe(["--i-understand"]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Missing STITCH_API_KEY/);
});

test("probe: never accepts the key as an argument", () => {
  const result = runProbe(["--i-understand", "--api-key=leaked"], { STITCH_API_KEY: "real" });

  assert.equal(result.status, 2, "unknown arguments are a usage error");
  assert.match(result.stderr, /Unknown argument: --api-key=leaked/);
});

test("probe: is opt-in, so neither npm test nor CI invokes it", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

  assert.match(pkg.scripts["probe:live"], /live-probe\.js/);
  assert.doesNotMatch(pkg.scripts.test, /probe/, "the suite must never spend the owner's key");

  const workflowPath = path.join(ROOT, ".github", "workflows", "ci.yml");
  if (fs.existsSync(workflowPath)) {
    assert.doesNotMatch(
      fs.readFileSync(workflowPath, "utf8"),
      /probe:live|live-probe/,
      "CI must not run the live probe",
    );
  }
});
