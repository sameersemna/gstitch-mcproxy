// @ts-check
"use strict";

/**
 * Audit findings that are still open, written down before they are fixed.
 *
 * Every finding in `PROGRESS.md` §10 was reproduced against commit `2578c26` with a scripted
 * fake upstream. The fixed ones now have real tests:
 *
 *   - ★C2, ★S4, ★N3, ★P2, ★N2, ★P1  → `test/phase1.test.js`
 *   - ★N5, ★N6, ★N8                  → `test/phase1b.test.js`
 *   - ★C1, P3, ★S1, ★S2, ★S3, ★S6    → `test/phase3.test.js`, `test/phase4.test.js`
 *   - ★C3, ★C4, ★N1, ★N4, ★N9, ★N10, ★N11 → `test/phase5.test.js`
 *
 * What remains below is deliberately deferred: P4 needs a live probe with the owner's key —
 * `scripts/live-probe.js` now exists for exactly that, guarded by `test/probe.test.js` — and S5 is
 * a performance refactor of the logging path that has no correctness impact.
 *
 * `test.todo()` bodies are *documentation*: `node:test` does not execute them.
 */

const test = require("node:test");

// ---------------------------------------------------------------------------
// Open findings
// ---------------------------------------------------------------------------

test.todo(
  "P4 – record whether Stitch implements resources/list and resources/templates/list " +
    "(needs an opt-in live probe with the owner's key; " +
    "`npm run probe:live -- --i-understand` prints the answer to record here)",
);

test.todo(
  "S5 – remove synchronous I/O from the request path " +
    "(readFileSync of the whole summary log, appendFileSync, statSync, execSync gcloud). " +
    "Correctness is unaffected; this is a latency and event-loop-responsiveness refactor",
);
