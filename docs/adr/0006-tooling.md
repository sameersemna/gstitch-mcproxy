# ADR 0006 — Tooling and continuous integration

- **Status:** Accepted
- **Date:** 2026-10-18
- **Phase:** 7
- **Supersedes:** —

## Context

The pre-hardening project had no `package.json`, no linter, no test suite and no CI. The audit's
findings were therefore invisible until someone reproduced them by hand against a live endpoint
that spends real generation quota.

[ADR 0001](./0001-language-and-typechecking.md) already fixed the language choice (CommonJS
JavaScript plus `checkJs`). This ADR fixes the rest of the toolchain.

## Decision

### Runner: `node:test`

The built-in runner needs no dependency, supports `test.todo()` (which let every audit finding be
committed as a written reproduction before it was fixed), and runs each **file** in its own
process. Coverage comes from `--experimental-test-coverage`; the suite currently reports 94 %
statement coverage.

### Lint and format

ESLint flat config with `js.configs.recommended` and Node globals, plus Prettier. Rules that would
churn the untouched legacy code are left at their defaults; the ones that catch real defects
(`no-unused-vars`, `prefer-const`, `eqeqeq`, `no-var`) are on.

### Types

`tsc --noEmit` with `allowJs` and `checkJs` over `index.js`, `src/**`, `test/**`, `scripts/**`.
`strict` stays off for now (see ADR 0001) so the check gates _new_ code without a mechanical
rewrite of code the later phases are about to move.

### Test isolation

`node:test` runs each file in a separate process. That matters because the Phase 1 seam keeps
configuration in module-level bindings: two proxies with different configuration cannot listen in
one process. `createProxyServer()` refuses that explicitly rather than silently reconfiguring the
first proxy, which would let a test pass for the wrong reason.

No test ever contacts the real Stitch endpoint. `test/helpers/fakeStitch.js` records every request
it receives and can reset the socket after receiving one, which is how ★C1 (`create_project`
delivered three times) is now a deterministic regression test.

### CI

`.github/workflows/ci.yml` runs on Node 20/22/24:

1. `npm ci`, `lint`, `typecheck`, `format:check`;
2. the test suite with coverage;
3. an assertion that **no runtime dependency** was added (`npm ls --omit=dev` must be empty) —
   the project's headline property should fail the build, not be noticed later;
4. a smoke test that `node index.js` starts and `/health` returns `"status":"ok"`;
5. a Docker build plus a container healthcheck.

`STITCH_LIVE=1 ./test.sh` remains the opt-in live smoke test and is never part of CI.

## Consequences

### Positive

- Every audit finding has a failing-then-passing test.
- Zero dependencies is enforced mechanically.
- The suite runs in about ten seconds, so it is cheap to run on every edit.

### Negative / accepted trade-offs

- `--experimental-test-coverage` is still flagged experimental, so its output format may change
  between Node majors. CI does not gate on a coverage threshold for that reason.
- One test process per file means duplicated module loading. Acceptable at this size.
- `strict: false` catches less than it could; Phase 6/7 revisits it once the modules are separated.

## Alternatives considered

1. **Jest / Mocha / Vitest.** Rejected: a dependency for something Node now provides, contrary to
   the project's defining constraint.
2. **`ava` or `tap`.** Rejected for the same reason.
3. **No CI.** Rejected: the findings existed precisely because nothing ran automatically.
