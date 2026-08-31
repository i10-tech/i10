// Conventional commits are LOAD-BEARING here, not a style preference.
//
// .github/scripts/next-version.mjs derives every release version by reading
// `feat:` / `fix:` / `!` out of the commit log. A non-conventional subject is
// silently skipped by that script — it does not fail, it just does not count —
// so a whole release can bump patch when it should have bumped minor. This
// config is what makes that impossible rather than merely discouraged.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // The scopes that exist. An unlisted scope is a typo more often than a new
    // component, and a typo'd scope reads fine in a changelog while grouping
    // wrong. Add deliberately.
    "scope-enum": [
      2,
      "always",
      [
        "api",
        "console",
        "web",
        "docs",
        "sdk",
        "ui",
        "contracts",
        "stalwart",
        "bulwark",
        "infra",
        "ci",
        "deps",
        "repo",
      ],
    ],
    "body-max-line-length": [0],
  },
}
