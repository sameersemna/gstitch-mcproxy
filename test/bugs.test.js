// @ts-check
"use strict";

/**
 * Audit findings from `PROGRESS.md` §10 — every one is now closed.
 *
 * Each was reproduced against commit `2578c26` with a scripted fake upstream. The fixes live in:
 *
 *   - ★C2, ★S4, ★N3, ★P2, ★N2, ★P1  → `test/phase1.test.js`
 *   - ★N5, ★N6, ★N8                  → `test/phase1b.test.js`
 *   - ★C1, P3, ★S1, ★S2, ★S3, ★S6    → `test/phase3.test.js`, `test/phase4.test.js`
 *   - ★C3, ★C4, ★N1, ★N4, ★N9, ★N10, ★N11 → `test/phase5.test.js`
 *   - S5                              → `test/s5-async.test.js`
 *
 * Every finding in the ledger is now closed. P4 needed the real endpoint, so its answer is
 * encoded as an assertion below rather than as a `todo`; `scripts/live-probe.js` is the probe that
 * produced it, guarded by `test/probe.test.js`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { applyConfig } = require("../index.js");
const { EMPTY_FALLBACK_RESULTS } = require("../src/mcp/jsonrpc.js");

// ---------------------------------------------------------------------------
// Findings closed with evidence
// ---------------------------------------------------------------------------

test("P4 – Stitch implements resources/list, so only prompts/list is answered locally", () => {
  // Answer obtained from the real endpoint on 2026-10-18 with `npm run probe:live -- --i-understand`:
  //   prompts/list              -> not implemented (HTTP/2 stream reset)
  //   resources/list            -> implemented (200, empty collection)
  //   resources/templates/list  -> implemented (200, empty collection)
  //
  // A future change that adds the resource methods to the defaults would answer locally what
  // Stitch would have filled in, so the default is asserted rather than left as documentation.
  const config = applyConfig({});

  assert.deepEqual(
    [...config.LOCAL_FALLBACK_METHODS],
    ["prompts/list"],
    "only the method Stitch does not implement may be answered locally",
  );

  // The empty results stay available for operators who know their deployment does not expose
  // resources; they are just not on by default.
  assert.deepEqual(Object.keys(EMPTY_FALLBACK_RESULTS).sort(), [
    "prompts/list",
    "resources/list",
    "resources/templates/list",
  ]);
});
