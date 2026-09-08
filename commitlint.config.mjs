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
        // apps/auth — sign-in, sign-up, password reset and second factors,
        // served at auth.i10.tech on Clerk's custom flows.
        //
        // ⚠ NOT THE SAME SCOPE AS `authd`, AND THE ONE-LETTER GAP IS THE WHOLE
        // TRAP. This is the browser-facing Next app where a person types a
        // password; `authd` is the Go LDAP bridge that answers Stalwart's binds
        // by delegating to Clerk. They share a name and nothing else — not a
        // language, not a release surface, not an audience — and a changelog
        // that files a sign-in button under the mail directory is wrong in a
        // way nobody notices until they go looking for the change.
        "auth",
        "console",
        "web",
        "docs",
        "sdk",
        "ui",
        "contracts",
        // packages/metering — the allowance/reset core that replaces Autumn.
        // Its own scope rather than `api`: it is a workspace package with its
        // own tests and its own release surface, and it is destined to run in a
        // Durable Object rather than in the API server at all.
        "metering",
        // services/authd — the LDAP bridge that delegates password checks to
        // Clerk. Its own scope rather than `stalwart`: it is a separate Go
        // service with a separate release surface, and the release notes read
        // better when a change to the bridge is not filed under the mail server
        // it happens to run beside.
        "authd",
        // apps/api/src/billing — Polar: checkouts, subscriptions, plan changes
        // and the proration decision. Inside the API rather than beside it, so
        // NOT a scope by the release-surface rule the two above follow — it is
        // here because a changelog reads better when "how a customer changes
        // plan" is not filed under the same heading as a route handler, and
        // because `infra`, `ci`, `repo` and `deps` already show this list is
        // about grouping rather than about packages.
        "billing",
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
