# API keys: i10 issues them, and Clerk does not

Decided and built **2026-09-08**, after measuring the cost of the version that
came before.

## Why

Verification used to be `clerkClient.apiKeys.verify(secret)` — a network call to
Clerk, cached in Redis for 60 seconds. Measured on the live API on 2026-09-08,
against `api.i10.tech` from a laptop:

| request                              | TTFB   | server time |
| ------------------------------------ | ------ | ----------- |
| `GET /domains`, cold cache           | 1.384s | **1.09s**   |
| `GET /domains`, warm cache           | 0.299s | 0.16s       |
| `GET /domains`, no auth header (401) | 0.300s | 0.18s       |

The unauthenticated 401 costs the same as a warm authenticated call, so **0.18s
is network round trip** and the handler itself is nearly free. The cold call's
extra **~900ms is Clerk**.

A send measured end to end: **1119ms cold, 353ms warm**, and SES accepted the
message 47ms after the 200 came back. The credential check was the single
largest cost in sending an email — larger than the provider call it was
authenticating.

⚠ **And the TTL makes the cold path the common one.** 60 seconds (capped at 300
by `API_KEY_CACHE_TTL_SECONDS`) means any customer sending less often than once a
minute pays it on essentially every request. That is the shape of most
transactional mail: password resets, receipts, invitations — bursty, then quiet.

## What Clerk was actually providing

Almost nothing that we needed.

⚠ **It was never what tied a key to a tenant.** Clerk's `subject` is a `user_…`
or `org_…`, and an i10 tenant is neither. `auth/api-key.ts` read
`claims.tenantId` — a claim **we** stamped at creation — and ignored `subject`
entirely. The link was always `core.api_keys.tenant_id`, a column we own, with a
foreign key to `core.tenants`. Removing Clerk moved nothing; it stopped a network
round trip from being needed to read it.

What remained was: secret generation, a stored hash, a `verify()` endpoint,
revocation and expiry flags, and a dashboard view. Replacing that is
`randomBytes(32)`, a `secret_hash` column, and an indexed lookup.

## What it deleted

⚠ **The prefix rewriting, and the hazard that came with it.** Clerk publishes no
way to change its `ak_` prefix, so every key was rewritten to `i10_live_…` on the
way out and stripped on the way back. Both our prefixes are nine characters, so
`i10_live_X` and `i10_test_X` stripped to **one identical Clerk secret** — which
is why the old code carried this warning:

> Reading the mode off the string a caller sent would let anyone promote a test
> key to a live key by editing one character.

Self-issued, the **whole key including its prefix** is hashed. Those two are
different credentials that match different rows, and the mode is simply a
property of the row. `wrapSecret`, `unwrapKey`, the `CLERK_PREFIX` assertion and
the tests guarding all of it are gone — not documented more carefully, gone.

It also removed a dependency on `apiKeys.getSecret`, which exists in the SDK
types but not in Clerk's documentation.

⚠ **And one statement left the send path.** `send/accept-db.ts` used to translate
Clerk's `ak_…` into our own row id with a best-effort `SELECT` — best-effort
because a key minted seconds earlier might not have reached the table yet. Keys
are ours now, so `apiKeyId` **is** the foreign key, and it cannot be missing: the
request could not have authenticated without the row it names.

## What Clerk keeps

This is a narrowing, not a migration away.

Clerk remains the identity provider for **sessions, MFA, organizations, the
tenant provisioning chain** (`user.created` → org → `organization.created` →
tenant → free plan) **and the LDAP bind delegation `services/authd` depends on** —
one email, one password. None of those are on a per-request path, and none of
them are cheaper to do ourselves.

API keys were a machine credential living in a human-identity product, paying
human-identity latency on every send.

## Shape

### The key

`i10_live_<43 chars>` or `i10_test_<43 chars>`, from
`randomBytes(32).toString("base64url")`.

⚠ **`base64url`, not `base64` or `hex`.** Base64url's alphabet is exactly what
`KEY_PATTERN` accepts and is safe in a header, a URL and a shell; plain base64
emits `+` and `/`, which are none of those. Hex would need 64 characters for the
same entropy.

### The hash: SHA-256, deliberately not bcrypt or argon2

A reviewer should expect to flinch at this, so the reasoning lives in the code as
well as here.

Slow hashes exist because **passwords are low-entropy and worth guessing**. An
API key here is 256 bits from a CSPRNG: there is nothing to guess. A deliberately
slow hash would take the very latency this change removes from the network and
put it on the CPU of every request instead. Fast hashing of high-entropy secrets
is the correct and conventional choice — it is what Stripe and GitHub do with
theirs.

⚠ **The hash covers the prefix**, which is what makes live and test genuinely
different credentials.

### The displayed prefix

`core.api_keys.prefix` holds `i10_live_` plus **eight characters** of the secret.
Shown in the dashboard so a customer can tell two keys apart.

⚠ **Eight characters of a 256-bit secret leaves ~208 bits**, which is nowhere
near a concern — and it stops being irrelevant the moment anybody shortens the
secret. Shorten one and not the other and this becomes a real disclosure.

⚠ **The literal `i10_live_` is the half that earns its keep.** It is what makes a
leaked key findable by grepping repositories, logs and paste sites. Showing only
secret characters would identify a key to its owner and to nobody scanning for
one.

### Verification, and the one thing that is not obvious

⚠ **The lookup cannot run inside `withTenant`.** `core.api_keys` carries
`tenant_isolation`, which reads `current_setting('app.tenant_id')` strictly — but
verification runs to **discover** the tenant, so at that moment there is none to
set. Issued through an ordinary connection it does not return the wrong row; it
raises `unrecognized configuration parameter` on the first request after every
deploy.

`core.resolve_api_key(text)` is the `SECURITY DEFINER` function that answers it,
the same pattern the reconcilers already use for their cross-tenant questions.
Everything else — listing, revoking, rotating — names a tenant that is already
known and goes through `withTenant`, so row level security is what stops one
customer touching another's credentials rather than a `WHERE` clause somebody can
forget.

⚠ **The function is `VOLATILE` because it writes `last_used_at`.** Clerk
maintained that field as a side effect of the call we removed; without a column
here every key would read as never used. It is stamped **on a cache miss**, so
the write rate is bounded by the TTL per key rather than by request volume — a
per-request write on the send path would be a worse trade than the network call
this whole change removes.

⚠ **It stamps a revoked key too.** The caller refuses the request either way;
what this preserves is the evidence that somebody is still presenting a
credential that was withdrawn, which is exactly what you want after a leak.

⚠ **And it returns state, not a verdict.** `revoked_at` and `expires_at` come
back as they are, and the decision is made in TypeScript beside the reason. A
function returning only live keys would make "revoked" and "never existed"
indistinguishable, and those are different things to log.

### The `unavailable` outcome survived

The three-way split — verified / rejected / unavailable — is unchanged. Only the
thing that can fail is different: it used to mean "Clerk did not answer", it now
means "Postgres did not answer".

⚠ **It must never collapse into a 401.** A 401 tells a customer their key is
wrong, and their next move is to rotate a key that was fine, during an outage
that was never theirs. Same rule as `services/authd` answering LDAP `unavailable`
rather than `invalidCredentials`.

What _did_ improve: a **Clerk outage no longer affects sending at all**. It
affects key creation, which is not latency-sensitive and is on nobody's critical
path.

## Revocation is immediate, and the cache key is why

⚠ **The row is only half of a revocation.** A verified key lives in Redis for the
TTL, so without evicting that entry the key keeps working for up to a minute
after the customer was told it was dead — which is the exact floor this change
existed to remove.

⚠ **So the cache key is derived from `secret_hash`, not from the plaintext.**
Revocation happens in a route that holds the key's **row** — its id and its hash —
and never the secret, which nothing stores. Keyed on the plaintext there would be
no way to evict at that moment, and "instant revocation" would quietly mean
"within the TTL".

⚠ **A failed eviction is a 500, not a quiet success.** Reporting success while a
leaked credential is still live is the worst answer available: the customer stops
looking. The row stays revoked, so a retry converges.

## Rotation: no overlap, on purpose

Mint the new key, revoke the old one, one transaction, no grace period.

A grace window is the polite design for **planned** rotation and the wrong one
for the case the button is actually pressed in: **the secret has already leaked**,
and leaving it alive is precisely what the customer is trying to stop. A few
refused sends are cheaper than a live credential in someone else's hands.

⚠ **The value is not the rotation.** It is not having to compose a correct
replacement by hand — same scopes, same mode, same tenant — while under pressure.
Nobody reads a scopes checklist during an incident.

⚠ **Unlike revoke, a failed cache eviction here still returns 200**, and the
asymmetry is deliberate: the replacement exists and the caller must receive it. A
500 would leave them holding a revoked key with no successor, because the secret
is not recoverable afterwards. The stale entry expires on its own.

## What is NOT solved

⚠ **These routes cannot mint a tenant's first key.** `/api-keys` authenticates
with `requireApiKey`, so reaching it requires a key already. Closing that needs
the console to authenticate with a **Clerk session**, and no session middleware
exists in this API — `authenticateRequest` appears nowhere. Today the first key
of a new tenant is an operator action.

This is the single largest gap and should not be read as bootstrapping being
handled.

⚠ **Scopes are carried, not enforced.** `ResolvedKey` exposes them and no route
checks them. Empty means unrestricted, which is what every key has.

⚠ **Out-of-band revocation via a Clerk dashboard no longer exists** — which is
the point — but note the reason it needed no reconciler leg: customers never had
access to Clerk's dashboard. It is i10's operator console. The only path that
bypassed our API was an i10 operator using the wrong tool, and after this change
there is nothing there to bypass.

## Migration

None needed. `core.api_keys` was **empty** — no customer had ever been issued a
key through it — which is why `0031` can add `secret_hash` as `NOT NULL` with no
backfill, and why `clerk_key_id` could be dropped rather than left nullable.

Had there been rows, the path was `apiKeys.getSecret` for each key to populate
the hashes, then a bounded fallback window. Recorded because that is the
migration a deployment with live keys would need.

## Verified

- **Migration applies cleanly** — run inside `BEGIN … ROLLBACK` against the
  production database on 2026-09-08.
- **`core.resolve_api_key` behaves as designed**, exercised the same way: the
  first call returns the row and stamps `last_used_at`; the second and third
  inside the same minute still return it via the `NOT EXISTS` branch (the subtle
  part — without it a repeat call would read as a bad key); an unknown hash
  returns nothing.
- **Drizzle binds `scopes` as one parameter**, a Postgres array literal
  `{"emails:send"}` — checked by rendering the insert, because the meter's
  mark-shipped statement shipped a row constructor (`($1, $2)::text[]`) that
  Postgres refuses to cast, and that was found only in production. Different
  path: that was raw `sql` interpolation, this is a typed column's own mapper.

**Related:** [[metering]] for the plan gate this credential feeds, and
`services/authd` for the other half of Clerk's remaining role.
