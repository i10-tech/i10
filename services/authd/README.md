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

That is the path for an ordinary account. An account an SSO connection manages
takes the same path with a different verifier: its company's directory instead
of Clerk (see "Managed accounts" below).

Searches are answered entirely from a local projection of Clerk, maintained by
webhook. Only the bind reaches Clerk. That split is load-bearing: Clerk allows
1000 requests per 10 seconds across all of i10, and IMAP clients are chatty.

It also buys the thing the OIDC directory could not do - `filterMailbox`
resolves a recipient **on demand**, so an account that has never signed in still
accepts mail. That limitation was what forced pre-creating every mailbox.

## Verifiers

A bind never talks to Clerk directly. `internal/verify` defines the seam: a
`Verifier` checks one password against one identity provider, and a `Resolver`
picks the verifier for an account. Today there are two: Clerk, for every account
no SSO connection manages, and the company's own identity provider
(`passthrough`), for the ones one does: its LDAP directory or its Okta org,
whichever the connection runs. The resolver is `passthrough.ManagedResolver`;
choosing a provider is its job and not `handleBind`'s.

Every verifier answers with the same tri-state outcome, and the third state is
the one that matters:

| Outcome       | Meaning                     | LDAP                      |
| ------------- | --------------------------- | ------------------------- |
| `Verified`    | the provider said yes       | `success` (0)             |
| `Rejected`    | the provider said no        | `invalidCredentials` (49) |
| `Unavailable` | the provider did not answer | **`unavailable` (52)**    |

A verifier also has a stable `Name()` (`clerk`, or `passthrough:<connection id>`),
its own `Timeout()` and an
optional failure `Budget()`. The name is mixed into every cached credential, so a
workspace that later switches provider can never be answered from an entry the
old provider minted. A resolver that cannot decide is `unavailable`, never
`invalidCredentials`.

⚠ The name does not say which lane a managed account's connection runs. That is
the API's answer, fetched inside `Verify`, and the resolver does no I/O. What
keeps the lanes apart in the cache instead is that the LDAP lane never stores a
success and an Okta success is cached for 15 minutes at most (see "The Okta
lane").

Clerk has no budget: its `verify_password` was measured not to feed lockout. A
company's directory and a company's Okta org have one, below.

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
projection lookup (suspension included) -> resolve verifier -> cache -> flight ->
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
spends them. A verifier with a `Budget{Max, Window}` gets this protection; Clerk
has none, so none of it runs for Clerk. The company verifier has one, for either
lane, **3 per 15 minutes** (`passthrough.FailureBudget`), because Active
Directory and Okta lock the real account too.

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
| Company directory / Okta   | 10 s  | `passthrough.VerifyTimeout`: settings fetch + walk |
| Pass-through settings call | 5 s   | `AUTHD_API_TIMEOUT`, refused above 12 s            |
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

## Managed accounts: the company's password, not ours

An account a company's SSO connection manages (sso.md 2.3) has no Clerk
password: its company took it away, and its password belongs to the company's
directory. So authd **never** sends such an account to Clerk's `verify_password`.
Per connection it does one of three things:

- **LDAP pass-through** to the company's own LDAP server (Okta LDAP Interface,
  Google Secure LDAP, Entra Domain Services, AD, JumpCloud). One password, theirs.
- **Okta**, for an Okta connection: the org's OAuth password grant. One password,
  theirs, and no secret held by us at all (see "The Okta lane").
- **Nothing.** The bind is refused with `invalidCredentials` and a reason code in
  the log, and IMAP is off for that connection's managed accounts. This is the
  state of every connection until pass-through is set up, tested and enabled.

A connection runs one lane at a time. The console refuses to turn either on while
the other is, and if a row somehow has both on, the API answers LDAP: it was
there first, so adding Okta can never change whose directory an existing LDAP
connection's passwords go to.

There is no mailbox password stored. Nothing in any lane is a hash, an app
password or a per-device secret.

The company's provider is a `verify.Verifier` (`passthrough.Verifier`, named
`passthrough:<connection id>`), behind the same bind path as Clerk:

```
Stalwart ──LDAP bind──▶ authd ──▶ projection lookup  (active? suspended? managed? by which connection?)
                                    │
                    not managed ────┴──── managed
                         │                   │
                    verifier: clerk     verifier: passthrough:<connection>
                         │                   │
                         └──── credential cache ─▶ flight ─▶ identical-failure memory
                               ─▶ throttle ─▶ failure budget (3 / 15 min, managed only)
                               ─▶ verify:
                                    settings (API, cached ≤60s): which lane?
                                    LDAP: resolve + vet host ─▶ dial the vetted IP
                                          TLS (ldaps | StartTLS, verified) ─▶ service bind
                                          search: exactly one entry ─▶ bind as that entry
                                    Okta: resolve + vet host ─▶ dial the vetted IP
                                          TLS (verified) ─▶ POST {issuer}/v1/token
```

**Choosing the verifier does no I/O.** `ManagedResolver` reads the projection row
only: not managed is Clerk; managed by a connection is the directory verifier for
that connection; managed by a connection that is gone, or on an authd with no
`AUTHD_API_URL`, is a refusal (`managed_no_connection`,
`passthrough_not_configured`). Whether the connection has pass-through switched
on is learned from the settings API inside `Verify`, where the verifier's own
timeout bounds it.

**How authd knows.** The API mirrors `identity.managed_accounts` into
`authd.managed_accounts` in the same transaction as every claim, move, release
and forget, and `AccountByUID` reads it in the same query as the account and its
`credential_epoch`. It is a separate table rather than a column on `accounts`
because an account is managed before it has a mailbox row.

**Where the settings come from.** `POST /internal/authd/passthrough` on the API,
authenticated by `AUTHD_API_SECRET` (constant-time compare, 401 otherwise),
answers `{ "enabled": false }`, or `enabled: true` with a `lane`:

- `"ldap"`: the connection's decrypted settings: host, port (389 or 636), TLS
  mode (`ldaps` or `starttls`; plaintext does not exist), an optional pinned CA,
  the search base, the user filter (`{email}` is replaced by the address, RFC
  4515 escaped) and the service account. The API holds them sealed with the
  connection's other secrets and lets an admin enable them only after a setup
  test passed in the last 24 hours.
- `"okta"`: `issuer` and `clientId`, and nothing else. Neither is a secret.

`enabled` stays on every answer, and a missing `lane` is read as LDAP, so the API
and authd roll out in either order. A lane this authd does not know is an error
(unavailable), never "off". Both lanes check the host with the same guard
(`internal/egress`), which is the API's list.

**The LDAP walk**, in this order and no other:

1. An empty password is refused before any network call.
2. The host is resolved and **every** address must be public: loopback,
   private, link-local (so cloud metadata), CGNAT, multicast, reserved and the
   IPv6 tunnelling ranges are refused, IPv4-mapped IPv6 judged as the IPv4 it
   carries. One bad address refuses the name. The same list as the API's guard
   (`internal/egress`).
3. authd dials the vetted **address**, not the name again, with the name as the
   TLS server name. `ldaps` is TLS from the first byte; `starttls` is the first
   operation and nothing is sent before it. The certificate is verified against
   the system roots, or against the pinned CA when there is one (never both,
   never a fallback if the pin is unusable). TLS 1.2 or later.
4. Bind as the service account, search the base for the filter with a size
   limit of 2. **Exactly one entry** or the bind is refused.
5. Bind as that entry with the password given. Success is that bind and nothing
   else.

Every step is bounded: dial 5s, each operation 5s, and the whole of it, settings
fetch included, by `passthrough.VerifyTimeout` (10s, under `verify.MaxTimeout`).

| Directory / path                                                                                               | Outcome       | LDAP answer            | Budget slot |
| -------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------- | ----------- |
| the person's own bind succeeds                                                                                 | `Verified`    | `success`              | given back  |
| their bind returns 49, no entry for the address, or several                                                    | `Rejected`    | `invalidCredentials`   | **kept**    |
| connection has no pass-through, or it is disabled                                                              | `Rejected`    | `invalidCredentials`   | kept        |
| API unreachable, host blocked or unresolvable, dial or TLS failure, service bind or search fails, bad settings | `Unavailable` | **`unavailable` (52)** | given back  |
| budget spent                                                                                                   | -             | `busy` (51)            | -           |
| local throttle exceeded                                                                                        | -             | `busy` (51)            | -           |

The service bind failing is `unavailable`, not `invalidCredentials`: it says
something about our settings, not about the person, and a mail client told
otherwise prompts for a password that is fine. The unmanaged path is untouched:
it keeps working while the API is down, and a managed account is never answered
by Clerk, outage or not.

A connection with pass-through switched off still spends a slot per refused
attempt, because the verifier only learns it is off after the slot is taken. The
answer is no either way; after three attempts it reads `busy` instead of
`invalidCredentials` until the window passes.

**What is cached, for how long, and why.**

- **The settings answer:** in memory only, per connection, at most **60 seconds**
  (`passthrough.MaxCacheTTL`, not configurable upward), and only answers - a
  failed fetch is never remembered, "pass-through is off" is. So disabling
  pass-through or rotating the service secret takes up to a minute to reach
  authd. It holds a service secret in the clear in this process for that long,
  and nowhere else.
- **An LDAP success:** never cached. The verifier caps the credential cache at
  zero (`verify.CacheLimit`), so every bind asks the directory.

  ⚠ **Nothing tells authd that a company's directory changed a password.** There
  is no event hook into Active Directory, so a cached success would keep the old
  password opening IMAP for the whole `AUTHD_CRED_CACHE_TTL`. The long cache is
  for providers whose password changes reach authd (Clerk's `clerk_updated_at`,
  an IdP's event hooks raising `credential_epoch`). The flight still collapses a
  client's simultaneous connections into one directory bind.

- **An Okta success:** cached, for 15 minutes at most
  (`passthrough.OktaMaxCacheTTL`), because an Okta call takes one to seven
  seconds and a mail client reconnects all day. See "The Okta lane" for what ends
  an entry early and why 15 minutes is a stopgap.
- **A rejection or an outage:** never cached. A rejection is remembered only as
  the failure budget's identical-retry memory (minutes, in memory).

The log carries reason codes (`user_not_found`, `ambiguous_entry`,
`user_bind_rejected`, `host_blocked`, `tls_failed`, `okta_mfa_required`, ...),
never the password, the service secret, a token, a filter or a DN the directory
returned.

## The Okta lane (#383)

An Okta connection's managed accounts are asked of the customer's own Okta org,
with Okta's OAuth password grant. i10 holds **no secret** for it: the
authorization server's URL (`https://<org host>/oauth2/default`, or
`/oauth2/<server id>`) and a **public** client id (an Okta native app with
`token_endpoint_auth_method: none`, the `password` grant allowed). Both are in
the connection's `config.oktaMail`, set by an owner in the console
(`PUT /identity/connections/:id/okta-mail`, step-up) and validated there and again
by `okta.Settings.Validate`.

What the customer's Okta admin has to have set up is Okta's side: the app, an
authorization-server access policy and rule that allow the `password` grant for
it, and **an app sign-in policy whose rule is "Password" only**, assigned to the
app. Without that last one Okta answers the right password with "denied by sign
on policy" (below).

One request, `POST {issuer}/v1/token`, form-encoded: `grant_type=password`,
`username=<the account's address>`, `password`, `scope=openid`, `client_id`. No
client credential of any kind is sent. The mapping was probed against a real org
and is exact:

| Okta answers                                             | Outcome       | LDAP answer            | Reason in the log                             | Budget slot |
| -------------------------------------------------------- | ------------- | ---------------------- | --------------------------------------------- | ----------- |
| `200` with an `access_token`                             | `Verified`    | `success`              | `verified`                                    | given back  |
| `400 invalid_grant`, "credentials provided were invalid" | `Rejected`    | `invalidCredentials`   | `okta_invalid_credentials`                    | **kept**    |
| `400 invalid_grant`, "denied by sign on policy"          | `Rejected`    | `invalidCredentials`   | **`okta_mfa_required`**                       | kept        |
| any other `invalid_grant`                                | `Rejected`    | `invalidCredentials`   | `okta_invalid_credentials`                    | kept        |
| `invalid_client`, `unauthorized_client`, any other `4xx` | `Unavailable` | **`unavailable` (52)** | `okta_config_<error code>`, or `_unknown`     | given back  |
| `429`, `5xx`, a redirect, a `200` that is not a token    | `Unavailable` | **`unavailable` (52)** | `okta_rate_limited`, `okta_server_error`, ... | given back  |
| timeout, DNS, dial, TLS, or a host the guard refuses     | `Unavailable` | **`unavailable` (52)** | `timeout`, `dns_failed`, `host_blocked`, ...  | given back  |

⚠ **A locked Okta account answers exactly like a wrong password.** Ten wrong
passwords lock the REAL account (the default policy), and Okta then says "the
credentials provided were invalid" for the right one too. authd cannot tell the
two apart, so the failure budget above (3 per 15 minutes, shared in Postgres) and
the identical-retry memory are what keep i10 from spending a person's ten. Both
apply to this lane exactly as to LDAP.

⚠ **Any `invalid_grant` is a rejection.** It is a statement about the person's
credentials by definition, and a rejection keeps its budget slot while an
unavailable answer gives it back. Calling an unrecognised one "unavailable" would
let a mail client retry a refusal Okta really counted, without limit.

`okta_mfa_required` is the right password refused because the app's sign-in
policy still wants a second factor. The client sees `invalidCredentials`; the log
says why, so the console can later tell the admin to add the password-only
policy. Nothing Okta says is copied into a log line: an answer is reduced to a
fixed reason code, and an error code that is not lower-case words is dropped.

**Egress.** The issuer is the customer's choice, so `internal/okta` connects only
through `internal/egress`: the name is resolved, every address must be public, and
the connection goes to the vetted address with the issuer's name as the TLS server
name (TLS 1.2 or later, system roots, no pin). No proxy from the environment is
used, and a redirect is never followed: either would carry the password where
nobody configured. The response is read to 64 KiB.

**Cache.** An Okta success is cached for **15 minutes** (`OktaMaxCacheTTL`), not
the full `AUTHD_CRED_CACHE_TTL`. The long cache is safe only where a password
change reaches authd, and for Okta that is an event hook raising
`credential_epoch` on a password change, a suspension, a lock or a deprovision
(B9 step 2b). Until a connection's hook is built and verified nothing tells authd,
so 15 minutes is the longest a changed Okta password keeps opening mail. 2b's
verified hook is what may lift it. Three things end an entry sooner:

- the projection lookup, which runs first: a suspended or deprovisioned account is
  refused at the next bind;
- a change to the connection's Okta settings (a different org or client, or
  Okta mail sign-in switched off), which raises the `credential_epoch` of every
  account the connection manages, now and once more just after authd's own
  60-second copy of the settings has expired
  (`apps/api/src/projection/connection-epoch.ts`);
- `credential_epoch` itself, for any other revocation.

⚠ **The lane is not in the verifier's name.** Which lane a connection runs is the
API's answer, fetched inside `Verify`, and the resolver does no I/O, so the name
is `passthrough:<connection id>` for both. An LDAP success is never cached, so
nothing it minted can answer for an Okta account; an Okta success is cached, and
the settings-change epoch raise above is what stops it answering after the
connection leaves Okta.

## Suspended mailboxes (#344)

A mailbox a company's directory switched off has `authd.accounts.suspended_at`
set and stays `active`. Searches return it, so mail keeps arriving; every bind is
refused with `invalidCredentials` (`mailbox_suspended`) BEFORE the verifier is
chosen, so before the credential cache, Clerk or the pass-through is consulted.

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

| Variable                    | Default                    |                                                      |
| --------------------------- | -------------------------- | ---------------------------------------------------- |
| `AUTHD_LISTEN`              | `127.0.0.1:3893`           | Must be loopback.                                    |
| `AUTHD_BASE_DN`             | `dc=i10,dc=tech`           |                                                      |
| `AUTHD_SERVICE_BIND_DN`     | -                          | Stalwart's own bind, needed even in bind-auth mode.  |
| `AUTHD_SERVICE_BIND_SECRET` | -                          |                                                      |
| `AUTHD_DATABASE_URL`        | -                          | The projection. Goes through PgBouncer.              |
| `AUTHD_CLERK_SECRET_KEY`    | -                          |                                                      |
| `AUTHD_CLERK_BASE_URL`      | `https://api.clerk.com/v1` |                                                      |
| `AUTHD_CLERK_TIMEOUT`       | `5s`                       | Must be positive and at most `12s`.                  |
| `AUTHD_BINDS_PER_MINUTE`    | `30`                       | Per DN, burst equal to one minute.                   |
| `AUTHD_CRED_CACHE_TTL`      | `2h`                       | Verified passwords only. `0` disables; max `3h`.     |
| `AUTHD_API_URL`             | -                          | The API, for pass-through settings. Both or neither. |
| `AUTHD_API_SECRET`          | -                          | Same value as the API's. 32+ characters.             |
| `AUTHD_API_TIMEOUT`         | `5s`                       | Must be positive and at most `12s`.                  |
| `AUTHD_LOG_LEVEL`           | `info`                     |                                                      |

## Layout

```
cmd/authd            entrypoint, signal handling, readiness
internal/config      env loading, the loopback guard
internal/directory   the LDAP view: entries, DNs, filter evaluation
internal/verify      the Verifier / Resolver / BudgetStore seam, Outcome
internal/clerkauth   the Clerk verifier: verify_password and its status mapping
internal/passthrough the company verifier and ManagedResolver: settings client,
                     the lane choice, the LDAP walk
internal/okta        the Okta password grant: validation, the vetted dial, the
                     answer mapping (oktatest is its fake endpoint)
internal/egress      which addresses authd may connect to for a tenant
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
