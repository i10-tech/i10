# `i10-authd`

The bridge that lets Clerk be the only place i10 keeps users, while Apple Mail,
Outlook and every other IMAP client still authenticate with a plain password.

**The rule it exists to serve:** a user has one identity they know of - one
email, one password - and that pair opens both the dashboard and the mailbox.
No app passwords, no second credential, ever.

## Why LDAP

Stalwart offers four directory backends. Only one of them delegates the password
check at request time:

| Backend                              | Why not                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Internal                             | Stalwart owns the rows. Clerk owns users.                                                                                                                                                                                                                                          |
| SQL                                  | `queryLogin` is `SELECT name, secret … WHERE name = $1` - the password is never passed to the query. Stalwart reads a hash and compares it itself, which means holding a credential Clerk should own.                                                                              |
| OIDC                                 | Stalwart never runs the OIDC flow; it expects the _mail client_ to present a token over `OAUTHBEARER` SASL. Stalwart's own docs state twice that Outlook, Thunderbird and Apple Mail don't support that with third-party providers - so this means no working mail clients at all. |
| **LDAP, `bindAuthentication: true`** | Stalwart locates the DN with a search, then **binds as the user**. Whatever answers that bind is the authority. That is the door.                                                                                                                                                  |

## How a login works

```
Apple Mail ──IMAP──▶ Stalwart ──LDAP search──▶ authd ──▶ Postgres projection
                          │                                (0 Clerk calls)
                          └────LDAP bind─────▶ authd ──▶ credential cache (2h)
                                                          └▶ verifier (Clerk verify_password)
                                                             (only on a miss)
```

Searches are answered entirely from a local projection of Clerk, maintained by
webhook. Only the bind reaches Clerk. That split is load-bearing: Clerk allows
1000 requests per 10 seconds across all of i10, and IMAP clients are chatty.

It also buys the thing the OIDC directory could not do - `filterMailbox`
resolves a recipient **on demand**, so an account that has never signed in still
accepts mail. That limitation was what forced pre-creating every mailbox.

## Verifiers

A bind never talks to Clerk directly. `internal/verify` defines the seam: a
`Verifier` checks one password against one identity provider, and a `Resolver`
picks the verifier for an account. Today the resolver always answers Clerk
(`verify.Fixed`); choosing a provider per workspace is a different resolver, not
a change to `handleBind`.

Every verifier answers with the same tri-state outcome, and the third state is
the one that matters:

| Outcome       | Meaning                     | LDAP                      |
| ------------- | --------------------------- | ------------------------- |
| `Verified`    | the provider said yes       | `success` (0)             |
| `Rejected`    | the provider said no        | `invalidCredentials` (49) |
| `Unavailable` | the provider did not answer | **`unavailable` (52)**    |

A verifier also has a stable `Name()` (`clerk`), its own `Timeout()` and an
optional failure `Budget()`. The name is mixed into every cached credential, so a
workspace that later switches provider can never be answered from an entry the
old provider minted. A resolver that cannot decide is `unavailable`, never
`invalidCredentials`.

Clerk has no budget: its `verify_password` was measured not to feed lockout.

## The credential cache

A bind is one HTTPS round trip to the provider, measured at roughly a second for
Clerk. Mail clients do not bind once: Apple Mail opens several connections to set
up an account and reconnects constantly after that, so reading your own mail
meant paying that second over and over. `internal/credcache` remembers a
**verified** password for **two hours** (`AUTHD_CRED_CACHE_TTL`), which collapses
a client's connection burst, and its all-day reconnects, to a handful of calls.

⚠ **It costs a property this service used to have.** `clerkauth` says authd holds
no password material of any kind. It now holds one HMAC per recently
authenticated user, under a key generated at startup, in memory, never
persisted, and dead the moment the process restarts. That is weak material, but
it is material, and it is stated here rather than left to be discovered.

⚠ **Two hours is defensible only because revocation does not wait for it.** The
timer is the backstop for a revocation nobody signalled. Everything below cuts a
cached password off at the very next bind:

- **Deactivation is not cached.** The projection lookup runs BEFORE the cache,
  so a suspended, unpaid or deprovisioned account is refused on the very next
  bind. The cache only ever short-circuits the password check.
- **A change in Clerk invalidates it.** Each entry records the account's
  `clerk_updated_at` and stops matching when it moves. Clerk publishes no
  password-specific timestamp, so this fires on any profile change - more often
  than strictly needed, never less, which is the only direction an
  authentication cache may err in. The same reasoning already governs what authd
  serves Stalwart as `pwdChangeTime`.
- **The credential epoch invalidates it for everything else.**
  `authd.accounts.credential_epoch` is a counter in Postgres, so both Stalwart
  pods see it. Each entry records the epoch it was minted under and a mismatch
  deletes it. The API raises it (`raiseCredentialEpoch` in
  `apps/api/src/projection/credential-epoch.ts`) for a revocation that leaves the
  row active and does not move `clerk_updated_at`. authd reads the column in the
  same query that already loads the account, so checking it costs nothing.
- **The provider is part of the entry.** The verifier name is in the MAC.

Only `Verified` is ever stored. Caching a rejection would leave a corrected
password broken for the rest of the TTL and would let one failed attempt
suppress a real one; caching `unavailable` would be caching the absence of an
answer. (The one remembered refusal is the failure budget's, below, and it lives
minutes, not hours.)

The bind order is a security property, and tests assert it:

```
projection lookup -> resolve verifier -> cache -> flight ->
identical-failure memory -> per-DN throttle -> budget reserve -> verify ->
release or keep -> cache store
```

The cache is consulted **after** the projection lookup and **before** everything
else. Before, because a hit spends no provider call, no throttle token and no
budget slot - a client opening six connections at once is not throttled for calls
it never made, and a person whose budget is spent can still read mail with the
password that already works.

`AUTHD_CRED_CACHE_TTL=0` disables it. The config refuses anything above three
hours: past that the timer is doing real security work again, which does not
belong in an environment variable nobody reviews.

## One verification per burst

Concurrent binds with the same (account, verifier, password) share a single
verification (`internal/inflight`). It applies to every verifier, Clerk included,
because it changes no outcome - it only stops N connections spending N throttle
tokens and N provider calls for one answer.

The key is an HMAC under a per-process key, never the raw password. The work runs
on its own goroutine under its own timeout, so a bind whose deadline passes
returns `unavailable` for itself and changes nothing for the others - and the
verification, and the budget release it owes, still finish. This is why it is not
`x/sync/singleflight`, which would hand the first caller's cancellation to every
follower.

## The failure budget

Some providers lock the REAL account after a few failures (Okta: about ten, and a
locked account answers exactly like a wrong password). i10 must never be what
spends them. A verifier with a `Budget{Max, Window}` (the Okta default will be 3
per 15 minutes) gets this protection; Clerk has none, so none of it runs for
Clerk today.

- **Shared.** Both Stalwart pods run an authd, so the count is the table
  `authd.bind_failure_budget` (`clerk_user_id`, `window_start`, `count`). It holds
  no password material of any kind. It is the one table the `authd` role may
  write, through `INSERT, UPDATE` granted in migration 0138.
- **Reserve, then forward.** Before a password is forwarded, one upsert takes a
  slot: it restarts an expired window, otherwise raises the count only while it is
  below `Max`. Concurrent binds on any number of pods cannot forward more than
  `Max`; see the comment on the statement in `internal/budgetstore` for why.
- **Release or keep.** A `Verified` or `Unavailable` outcome gives its slot back,
  because neither is a failure the provider counted. `Rejected` keeps it. A
  success does not reset the window: whether Okta resets its own counter on
  success is unprobed, so we stay conservative.
- **Spent.** The bind is answered locally with LDAP `busy` (51) and the logged
  reason `failure_budget_spent`, without calling the provider, until the window
  passes. A cache hit still succeeds.
- **Fail closed.** If the budget store cannot be reached, the answer is
  `unavailable` and the password is NOT forwarded.
- **Identical retries.** A phone retries its stale saved password every few
  seconds. authd remembers, in memory, a keyed hash of the last few refused
  passwords per account for the length of the window, and answers an identical
  retry `invalidCredentials` locally with no provider call and no slot. Each
  record is bound to the account's `credential_epoch` and `clerk_updated_at`, so
  a password reset clears it.

## Timeouts

Stalwart's LDAP Directory gives up on authd after **15 s** (`timeout` in
`infra/k8s/i10/stalwart/config/plan.ndjson`; it was 5 s, which an Okta password
grant measured at one to seven seconds could not meet). authd must answer before
that, so:

| What                       | Value | Where                                              |
| -------------------------- | ----- | -------------------------------------------------- |
| Stalwart directory         | 15 s  | `plan.ndjson`                                      |
| authd operation            | 14 s  | `ldapsrv.DefaultOpTimeout` (`MaxTimeout + 2s`)     |
| Longest verifier           | 12 s  | `verify.MaxTimeout`, clamped per bind              |
| One budget reserve/release | 1 s   | `budgetOpTimeout`                                  |
| Clerk                      | 5 s   | `AUTHD_CLERK_TIMEOUT`, refused above 12 s          |
| LDAP read/write deadline   | 30 s  | `main.go`; above both, so an answer can be written |

The two seconds above the verifier cover the projection lookup and the budget
reserve and release. If a verification is slower than that, the bind is answered
`unavailable` at 14 s and the work finishes in the background.

### Not built: stale-while-unavailable

The obvious next step, deliberately deferred. Today a Clerk outage means every
mail client gets `unavailable` and nobody reads their mail - a hard dependency
on a third party for access to your own inbox.

The shape: a second, longer window (perhaps 15 minutes) whose entries are served
**only** when Clerk answers `Unavailable`, never when Clerk is reachable and
says no. That turns an outage into degraded-but-working for recently active
users while leaving the normal-operation revocation window short.

It is a different feature answering a different question, and it wants evidence
about how often Clerk is actually unavailable before the risk is worth taking.

## The one rule you must not break

> A Clerk outage must never be reported as `invalidCredentials`.

| Clerk                                  | LDAP                      |
| -------------------------------------- | ------------------------- |
| `200 {"verified":true}`                | `success` (0)             |
| `422`                                  | `invalidCredentials` (49) |
| `400 no_password_set`                  | `invalidCredentials` (49) |
| `429`, `5xx`, timeout, transport error | **`unavailable` (52)**    |
| local throttle exceeded                | `busy` (51)               |

Return 49 during an outage and every mail client in the fleet concludes the
stored password is wrong. Apple Mail and Outlook respond by prompting the user,
and people start _changing their passwords_ to fix an outage that was never
theirs. `unavailable` makes clients back off and retry.

`TestUserBindOutcomes` and `TestProjectionDownIsUnavailableNotInvalidCredentials`
exist to keep that true.

## What was measured, not assumed

None of this is documented; it came from probing a live Clerk instance.

- **The Backend API `verify_password` endpoint does not feed Clerk's
  account-lockout counter.** Fifteen consecutive wrong passwords left
  `verification_attempts_remaining` at 10 and the account unlocked. So a mail
  client retrying a stale saved password **cannot** lock a user out of their
  dashboard and billing. This was the largest risk in the design.
- A passwordless (OAuth-only) user returns `400` with code `no_password_set`.
- `PATCH /users/{id}` **can** set a password on a user who never had one, so
  onboarding can force one when a user chooses human mail.

⚠ **Re-run that probe against the production Clerk instance before launch.** The
above was measured on a development instance, which may relax attack protection.

## Design notes

**Read-only, on purpose.** Only Bind and Search are implemented. Add, Modify,
Delete, ModifyDN and Compare do not exist - every operation absent from the mux
is one that cannot be abused. `TestWriteOperationsAreRefused` asserts it.

**Loopback only.** `config.Validate` refuses to start on a non-loopback address.
authd speaks plaintext LDAP and will verify any password handed to it; off-pod
reachability would make it an open oracle.

**No password material anywhere.** Not a hash, not a verifier, not a salt -
neither in the schema nor in an LDAP attribute. With `bindAuthentication: true`
Stalwart never reads a password attribute, so there is nothing to serve.

**The throttle protects the Clerk budget, not the user.** Since lockout is not
in play (measured above), its job is to stop one misconfigured client from
spending the shared 1000 req/10s budget and taking authentication down for
everyone else. It answers `busy`, not `unavailable`, so logs stay diagnosable.

**Filters are evaluated, not pattern-matched.** authd extracts the values being
searched for, fetches a candidate superset from Postgres, then evaluates the
real filter against each candidate. Stalwart's filters are configurable, so
matching on their exact shape would break the first time someone edited one.

**⚠ Upstream data race.** `ldapserver` assigns `s.Listener` inside `Serve` while
`Stop` reads it, unsynchronised (`server.go:82` vs `:186`). `main.go` owns the
listener and waits until the server is provably accepting before it can act on a
signal; the tests shut down by closing the listener rather than calling `Stop`.
Worth reporting upstream.

## Configuration

| Variable                    | Default                    |                                                     |
| --------------------------- | -------------------------- | --------------------------------------------------- |
| `AUTHD_LISTEN`              | `127.0.0.1:3893`           | Must be loopback.                                   |
| `AUTHD_BASE_DN`             | `dc=i10,dc=tech`           |                                                     |
| `AUTHD_SERVICE_BIND_DN`     | -                          | Stalwart's own bind, needed even in bind-auth mode. |
| `AUTHD_SERVICE_BIND_SECRET` | -                          |                                                     |
| `AUTHD_DATABASE_URL`        | -                          | The projection. Goes through PgBouncer.             |
| `AUTHD_CLERK_SECRET_KEY`    | -                          |                                                     |
| `AUTHD_CLERK_BASE_URL`      | `https://api.clerk.com/v1` |                                                     |
| `AUTHD_CLERK_TIMEOUT`       | `5s`                       | Must be positive and at most `12s`.                 |
| `AUTHD_BINDS_PER_MINUTE`    | `30`                       | Per DN, burst equal to one minute.                  |
| `AUTHD_CRED_CACHE_TTL`      | `2h`                       | Verified passwords only. `0` disables; max `3h`.    |
| `AUTHD_LOG_LEVEL`           | `info`                     |                                                     |

## Layout

```
cmd/authd            entrypoint, signal handling, readiness
internal/config      env loading, the loopback guard
internal/directory   the LDAP view: entries, DNs, filter evaluation
internal/verify      the Verifier / Resolver / BudgetStore seam, Outcome
internal/clerkauth   the Clerk verifier: verify_password and its status mapping
internal/credcache   verified-password cache and the remembered refusals
internal/inflight    one verification for concurrent identical binds
internal/budgetstore the shared failure budget in Postgres
internal/projection  the Clerk read model (Store interface + Postgres)
internal/ldapsrv     Bind and Search handlers
internal/throttle    per-DN token bucket
```

```bash
go test -race ./...
```

## The schema lives elsewhere

authd is a **reader**. The `authd.*` tables are defined in Drizzle at
`apps/api/src/db/schema.ts` and migrated from `apps/api/drizzle/`, because the
webhook receiver that writes them lives there and two sources of truth for one
schema is how drift starts.

⚠ authd's queries are plain SQL against those tables, so a column renamed in
Drizzle will **not** fail to compile here - it will fail at runtime, on a bind.
Rename in both, in the same change.

## No health listener yet

authd binds `127.0.0.1` only, and the kubelet runs probes against the pod IP, so
**it cannot be probed by Kubernetes at all**. The StatefulSet therefore gives it
no `livenessProbe` or `readinessProbe`; a tcpSocket probe on 3893 can never
connect and simply kills a healthy process on a timer. Setting
`host: 127.0.0.1` on the probe does not help - the kubelet resolves that against
the node's loopback.

That is acceptable today: authd has one consumer in the same network namespace,
no Service selects it, and when it is down Stalwart's binds answer `unavailable`
(52), which is visible in Stalwart's logs and is the designed behaviour.

If real health checking is wanted, the answer is a **second listener** - a
health-only HTTP endpoint bound to the pod IP, exposing liveness and the
projection's reachability and nothing else. That is a deliberate addition with
its own review, not a probe stanza someone can add back to the manifest.

## Still to build

- The Clerk webhook receiver that maintains the projection (`apps/api`).
- Stalwart's `directory.*` block pointing at this service.
- The sidecar container in the Stalwart StatefulSet.
