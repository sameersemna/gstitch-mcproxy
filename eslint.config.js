// @ts-check
"use strict";

const js = require("@eslint/js");
const globals = require("globals");

/**
 * Flat ESLint configuration.
 *
 * Scope note (Phase 0): `index.js` is the untouched 2,675-line baseline file, so it is
 * linted with the recommended rule set only. Tighten per-directory rules as `src/` lands
 * in Phase 2.
 */
module.exports = [
  {
    ignores: ["node_modules/**", "logs/**", "coverage/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // The proxy legitimately logs to stdout/stderr and may leave unused
      // caught-error bindings for readability in error paths.
      "no-console": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  {
    files: ["test/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2023,
      },
    },
    rules: {
      // Tests intentionally use top-level await-free async patterns and
      // construct deliberately malformed input for the negative cases.
      "no-unused-vars": "off",
    },
  },
];
