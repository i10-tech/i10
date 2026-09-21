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
        // packages/emails — the react.email templates for the messages Clerk
        // used to send and we now render ourselves.
        //
        // ⚠ NOT `api`, EVEN THOUGH THE API IS ITS ONLY CONSUMER. It is a
        // workspace package with its own preview server and its own build, and
        // a changelog reads better when "the reset-password wording changed" is
        // not filed under the same heading as a route handler — the same
        // reasoning `metering` and `authd` are listed for.
        "emails",
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
        // apps/api/src/send — the transactional mail path: admission, the
        // queue claim, the MIME builder, DKIM signing, both transports and the
        // reconcilers. Inside the API rather than beside it, so listed for the
        // same reason `billing` is: a changelog reads better when "how a message
        // gets to a recipient" is not filed under the same heading as a route
        // handler, and this list is about grouping rather than about packages.
        //
        // ⚠ NOT `stalwart`, WHICH IS THE MAIL SERVER ITSELF. A change to how we
        // choose a route or build a message is ours; a change to the server's
        // deployment, config plan or bootstrap is `stalwart`. The two travel
        // together often enough that filing them under one name would make the
        // release notes useless for exactly the question people ask of them.
        "send",
        // apps/api/src/dns + packages/dns-providers — the customer's own DNS:
        // the provider registry, the OAuth connect, the zone adapters and the
        // publish path that writes records into somebody else's zone. Inside
        // the API rather than beside it, so listed for the same reason
        // `billing` and `send` are: a changelog reads better when "we can now
        // write your records for you at Hetzner" is not filed under the same
        // heading as a route handler.
        //
        // ⚠ NOT THE ZONES WE SERVE OURSELVES, WHICH ARE `infra`. PowerDNS, its
        // hostPort and the firewall in front of it are deployment; this is the
        // code that talks to a provider on a customer's behalf. The two get
        // confused precisely because both are "DNS", and a reader looking for
        // why their delegation broke needs to be able to tell them apart.
        "dns",
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
