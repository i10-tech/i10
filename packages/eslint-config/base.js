import js from "@eslint/js"
import eslintConfigPrettier from "eslint-config-prettier"
import turboPlugin from "eslint-plugin-turbo"
import tseslint from "typescript-eslint"
import onlyWarn from "eslint-plugin-only-warn"

/**
 * Shared ESLint config for every workspace.
 *
 * `turbo/no-undeclared-env-vars` is the rule that earns its place here: turbo
 * caches on declared env only, so reading an undeclared variable produces a
 * build that is cached against the wrong key and silently reused with stale
 * values. It is a correctness rule wearing a lint rule's clothes.
 *
 * @type {import("eslint").Linter.Config[]}
 */
export const config = [
  js.configs.recommended,
  eslintConfigPrettier,
  ...tseslint.configs.recommended,
  {
    plugins: { turbo: turboPlugin },
    rules: {
      "turbo/no-undeclared-env-vars": "error",
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    rules: {
      // ⚠ OFF FOR TYPESCRIPT ONLY, AND NOT AS A CONVENIENCE. The compiler
      // already reports every undefined identifier, with the whole type graph
      // to reason from. ESLint's version reasons from a hardcoded globals
      // list, so it flags `process` in a Node package and misses genuinely
      // undefined names behind a type assertion — worse on both sides.
      // typescript-eslint recommends disabling it for this reason.
      "no-undef": "off",
    },
  },
  {
    // Downgrades everything to a warning IN EDITORS, so a red squiggle means
    // "the file is broken" rather than "you have not finished typing". CI runs
    // with --max-warnings 0, so nothing is actually softened.
    plugins: { onlyWarn },
  },
  {
    // ⚠ `.next*` RATHER THAN `.next`, because the console's preview server
    // builds into `.next-preview` so it can run beside a live `next dev` — see
    // apps/console/next.config.ts. Linting a Next build output is thousands of
    // warnings about `require()` in generated chunks, and it takes the gate red
    // for a directory nobody wrote.
    ignores: ["dist/**", ".next*/**", ".astro/**", "node_modules/**"],
  },
]

// ⚠ HELD ON ESLINT 9, ON PURPOSE. ESLint 10 is out and every plugin here
// supports it EXCEPT eslint-plugin-react, whose peer range stops at ^9.7.
// Moving to 10 means either dropping that plugin — losing jsx-key and the
// rest — or installing it against an unsupported ESLint and finding out at
// runtime. Revisit when eslint-plugin-react ships a v10 range; it is a
// one-line change here and in every package's devDependencies.
