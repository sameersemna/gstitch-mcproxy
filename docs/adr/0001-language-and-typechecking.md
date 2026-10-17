# ADR 0001 — Keep CommonJS JavaScript, add `checkJs` instead of migrating to TypeScript

- **Status:** Accepted
- **Date:** 2026-10-17
- **Phase:** 0
- **Supersedes:** —

## Context

`gstitch-mcproxy` is a single 2,675-line `index.js` with **zero runtime dependencies**. Its
defining operational property is that it can be deployed by copying one file next to an
optional `.env` and running `node index.js`. The Docker image, both systemd units, `run.sh`,
`test.sh` and the documented `docker run` one-liner all rely on that property.

The hardening programme needs static checking (unused variables, typos, wrong argument
shapes) and linting. The obvious vehicle is TypeScript; the alternative is JavaScript with
JSDoc annotations and `tsc --checkJs`.

## Decision

Keep **CommonJS JavaScript** as the implementation language and obtain type safety from
`tsc --noEmit` with `allowJs` + `checkJs` over `index.js`, `src/**`, `test/**` and
`scripts/**`, driven by JSDoc annotations on exported functions.

Concretely (Phase 0):

- `tsconfig.json` sets `allowJs`, `checkJs`, `noEmit`, `skipLibCheck`, `types: ["node"]`.
- `strict` is **left off** for now. The baseline file is annotated only where it matters
  (the seam's public functions); turning `strict` on immediately would produce a large,
  purely-mechanical diff across code that Phases 2–3 are about to move anyway.
- Every file gets `// @ts-check` and `"use strict"`.
- Every new exported function carries a JSDoc block with parameter and return types.
- `typescript`, `@types/node`, `eslint`, `@eslint/js`, `globals` and `prettier` are
  **dev-only** dependencies. `dependencies` stays empty — that is a project invariant, not
  a preference.

## Consequences

### Positive

- No build step: `node index.js` keeps working exactly as before, and the Docker/systemd
  units need no change.
- Zero runtime dependencies is preserved and mechanically checkable (`npm ls --omit=dev`
  must stay empty).
- Editors (VS Code, JetBrains) surface the same diagnostics through the JSDoc annotations.
- `Response.json()` being typed `Promise<unknown>` pushes tests towards explicit payload
  assertions instead of blind property access — the test suite keeps a narrowly-scoped
  `readJson()` helper that returns `any` for exactly this reason.

### Negative / accepted trade-offs

- JSDoc is more verbose than TypeScript syntax for generics and unions.
- `strict: false` means Phase 0 type checking catches less than it could. Phase 7 revisits
  this with `strictNullChecks` at minimum, once the modules are separated.
- Type-only errors are invisible at runtime; `npm run typecheck` must therefore stay in the
  `verify` script and in CI rather than being optional.

## Alternatives considered

1. **Migrate to TypeScript with a build step.** Rejected: it breaks the copy-one-file
   deployment story, adds a `dist/` artefact to Docker and systemd, and requires
   deciding how `.env` loading and the `require.main === module` entry point work in
   compiled output — for a codebase whose whole selling point is that it needs none of
   that.
2. **TypeScript executed directly via a loader (`tsx`, `ts-node`).** Rejected: adds a
   runtime dependency, which violates the zero-dependency invariant.
3. **No static checking at all (ESLint only).** Rejected: the audit found real
   argument-shape bugs (for example `writeDetailedDebugLog` being called without `error`),
   which ESLint does not catch.
4. **JSDoc + `jsconfig.json` only (editor hints, no CI gate).** Rejected: without a CI gate
   the annotations rot.

## Revisit

Revisit in **Phase 7** (tooling and CI), when the module split makes it feasible to enable
`strict` incrementally, and again in **Phase 10** if the JSDoc burden proves to slow down
refactoring.
