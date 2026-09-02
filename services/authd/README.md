# `i10-authd`

The bridge that lets Clerk be the only place i10 keeps users, while Apple Mail,
Outlook and every other IMAP client still authenticate with a plain password.

**The rule it exists to serve:** a user has one identity they know of — one
email, one password — and that pair opens both the dashboard and the mailbox.
No app passwords, no second credential, ever.

## Why LDAP

Stalwart offers four directory backends. Only one of them delegates the password
check at request time:

| Backend                              | Why not                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Internal                             | Stalwart owns the rows. Clerk owns users.                                                                                                                                                                                                                                          |
| SQL                                  | `queryLogin` is `SELECT name, secret … WHERE name = $1` — the password is never passed to the query. Stalwart reads a hash and compares it itself, which means holding a credential Clerk should own.                                                                              |
| OIDC                                 | Stalwart never runs the OIDC flow; it expects the _mail client_ to present a token over `OAUTHBEARER` SASL. Stalwart's own docs state twice that Outlook, Thunderbird and Apple Mail don't support that with third-party providers — so this means no working mail clients at all. |
| **LDAP, `bindAuthentication: true`** | Stalwart locates the DN with a search, then **binds as the user**. Whatever answers that bind is the authority. That is the door.                                                                                                                                                  |

## How a login works

```
Apple Mail ──IMAP──▶ Stalwart ──LDAP search──▶ authd ──▶ Postgres projection
                          │                                (0 Clerk calls)
                          └────LDAP bind─────▶ authd ──▶ credential cache (60s)
                                                          └▶ Clerk verify_password
                                                             (only on a miss)
```

Searches are answered entirely from a local projection of Clerk, maintained by
webhook. Only the bind reaches Clerk. That split is load-bearing: Clerk allows
1000 requests per 10 seconds across all of i10, and IMAP clients are chatty.

It also buys the thing the OIDC directory could not do — `filterMailbox`
resolves a recipient **on demand**, so an account that has never signed in still
accepts mail. That limitation was what forced pre-creating every mailbox.

## The credential cache

A bind is one HTTPS round trip to Clerk, measured at roughly a second against
production. Mail clients do not bind once: Apple Mail opens several connections
to set up an account and reconnects constantly after that, so reading your own
mail meant paying that second over and over. `internal/credcache` remembers a
**verified** password for 60 seconds, which collapses a client's connection
burst to a single Clerk call.

⚠ **It costs a property this service used to have.** `clerkauth` says authd holds
no password material of any kind. It now holds one HMAC per recently
authenticated user, under a key generated at startup, in memory, never
persisted, and dead the moment the process restarts. That is weak material, but
it is material, and it is stated here rather than left to be discovered.

What makes 60 seconds defensible is that two other things are unaffected:

- **Deactivation is not cached.** The projection lookup runs BEFORE the cache,
  so a suspended, unpaid or deprovisioned account is refused on the very next
  bind. The cache only ever short-circuits the password check.
- **A password change invalidates it.** Each entry records the account's
  `clerk_updated_at` and stops matching when it moves. Clerk publishes no
  password-specific timestamp, so this fires on any profile change — more often
  than strictly needed, never less, which is the only direction an
  authentication cache may err in. The same reasoning already governs what authd
  serves Stalwart as `pwdChangeTime`.

Only `Verified` is ever stored. Caching a rejection would leave a corrected
password broken for the rest of the TTL and would let one failed attempt
suppress a real one; caching `unavailable` would be caching the absence of an
answer.

The cache is consulted **after** the projection lookup and **before** the
throttle. Both halves are asserted by tests. Before, because the limiter exists
to protect the Clerk request budget and a hit spends none of it — otherwise a
client opening six connections at once would be throttled for calls it never
made.

`AUTHD_CRED_CACHE_TTL=0` disables it. The config refuses anything above five
minutes: past that this stops being a latency optimisation and becomes a policy
statement about how long a revoked credential stays live, which does not belong
in an environment variable nobody reviews.

### Not built: stale-while-unavailable

The obvious next step, deliberately deferred. Today a Clerk outage means every
mail client gets `unavailable` and nobody reads their mail — a hard dependency
on a third party for access to your own inbox.

The shape: a second, longer window (perhaps 15 minutes) whose entries are served
**only** when Clerk answers `Unavailable`, never when Clerk is reachable and
says no. That turns an outage into degraded-but-working for recently active
users while leaving the normal-operation revocation window at 60 seconds.

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
Delete, ModifyDN and Compare do not exist — every operation absent from the mux
is one that cannot be abused. `TestWriteOperationsAreRefused` asserts it.

**Loopback only.** `config.Validate` refuses to start on a non-loopback address.
authd speaks plaintext LDAP and will verify any password handed to it; off-pod
reachability would make it an open oracle.

**No password material anywhere.** Not a hash, not a verifier, not a salt —
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
| `AUTHD_SERVICE_BIND_DN`     | —                          | Stalwart's own bind, needed even in bind-auth mode. |
| `AUTHD_SERVICE_BIND_SECRET` | —                          |                                                     |
| `AUTHD_DATABASE_URL`        | —                          | The projection. Goes through PgBouncer.             |
| `AUTHD_CLERK_SECRET_KEY`    | —                          |                                                     |
| `AUTHD_CLERK_BASE_URL`      | `https://api.clerk.com/v1` |                                                     |
| `AUTHD_CLERK_TIMEOUT`       | `5s`                       |                                                     |
| `AUTHD_BINDS_PER_MINUTE`    | `30`                       | Per DN, burst equal to one minute.                  |
| `AUTHD_CRED_CACHE_TTL`      | `60s`                      | Verified passwords only. `0` disables; max `5m`.    |
| `AUTHD_LOG_LEVEL`           | `info`                     |                                                     |

## Layout

```
cmd/authd            entrypoint, signal handling, readiness
internal/config      env loading, the loopback guard
internal/directory   the LDAP view: entries, DNs, filter evaluation
internal/clerkauth   verify_password and the status mapping
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
Drizzle will **not** fail to compile here — it will fail at runtime, on a bind.
Rename in both, in the same change.

## No health listener yet

authd binds `127.0.0.1` only, and the kubelet runs probes against the pod IP, so
**it cannot be probed by Kubernetes at all**. The StatefulSet therefore gives it
no `livenessProbe` or `readinessProbe`; a tcpSocket probe on 3893 can never
connect and simply kills a healthy process on a timer. Setting
`host: 127.0.0.1` on the probe does not help — the kubelet resolves that against
the node's loopback.

That is acceptable today: authd has one consumer in the same network namespace,
no Service selects it, and when it is down Stalwart's binds answer `unavailable`
(52), which is visible in Stalwart's logs and is the designed behaviour.

If real health checking is wanted, the answer is a **second listener** — a
health-only HTTP endpoint bound to the pod IP, exposing liveness and the
projection's reachability and nothing else. That is a deliberate addition with
its own review, not a probe stanza someone can add back to the manifest.

## Still to build

- The Clerk webhook receiver that maintains the projection (`apps/api`).
- Stalwart's `directory.*` block pointing at this service.
- The sidecar container in the Stalwart StatefulSet.
