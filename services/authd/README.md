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
of Clerk (see "Managed accounts" below). A mail device code takes neither: it is
i10's own secret, checked against `authd.mail_devices` (see "Mail device codes"
below).

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
(`passthrough`), for the ones one does: its LDAP directory or its OIDC provider
(Okta, Keycloak, Auth0, ...), whichever the connection runs. The resolver is `passthrough.ManagedResolver`;
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
success and an OIDC success is cached for 15 minutes at most (see "The OIDC
lane").

Clerk has no budget: its `verify_password` was measured not to feed lockout. A
company's directory and a company's OIDC provider have one, below.

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
- **So is every other reason the account row gives for turning a login off.**
  All are columns of `authd.accounts`, read in the same query as the account, and
  refused before the cache (in `handleBind`, `ldapsrv/bind.go`):

  | column                                | set by                                                                                                                 | why the login is off                                                                                                                                                                                                                    |
  | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `suspended_at`                        | a company's directory, an owner, a member leaving or being removed, a workspace deleted, a domain removed              | the person's access to this mailbox ended; mail keeps arriving                                                                                                                                                                          |
  | `deleting_at`                         | an owner or admin deleting the mailbox (`apps/api/src/mailboxes/lifecycle.ts`); cleared only by a restore              | the mailbox is in its 30 day deletion grace and is purged at the end of it; mail keeps arriving until then                                                                                                                              |
  | `payment_hold_at`                     | billing, when the subscription stops entitling anything (`past_due` is still entitled); cleared when it entitles again | the workspace has no paid plan; mail keeps arriving                                                                                                                                                                                     |
  | `banned`, `locked` (+ `locked_until`) | the Clerk webhook                                                                                                      | Clerk's `verify_password` answers yes for both (probed 2026-11-07), so authd refuses them itself; a lockout lifts at `locked_until`                                                                                                     |
  | `authd.required_domains`              | an active connection that requires SSO                                                                                 | an account that is not managed, on one of those domains, has no Clerk password to use: `ManagedResolver` refuses it (`sso_required`) until it signs in through SSO                                                                      |
  | `authd.required_exempt`               | the same transaction as any change to a role, the bypass list, the owner exemption or what requires SSO                | NOT a reason to turn a login off but the one way out of the row above: an owner or admin (while the owner exemption is on) or a connection's bypass-listed member keeps their Clerk password, and losing it is refused at the next bind |
  | `authd.passthrough_versions.active`   | `mirrorPassthrough`, in the statement that moves the connection's version                                              | a managed account whose connection's status is not `active` is refused (`connection_inactive`). Only `false` refuses: null is a row an older API pod wrote, "not known", and refuses nothing                                            |

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
  row active and does not move `clerk_updated_at`: today an Okta Universal Logout
  (`identity/universal-logout.ts`, after the sessions are revoked). authd reads the
  column in the same query that already loads the account, so checking it costs
  nothing. A new row's epoch starts from the clock in microseconds, never from
  zero, so a mailbox deleted and made again can not land on a number a password was
  cached under before the revocation that raised it.
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
Directory and the OIDC providers lock the real account too.

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
| Company directory / OIDC   | 10 s  | `passthrough.VerifyTimeout`: settings fetch + walk |
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
- **OIDC**, for a connection whose provider has a password grant (Okta, Keycloak,
  Auth0, PingFederate, FusionAuth, or any other that takes a public client's):
  the provider's OAuth password grant. One password, theirs, and no secret held
  by us at all (see "The OIDC lane").
- **Nothing.** The bind is refused with `invalidCredentials` and a reason code in
  the log, and IMAP is off for that connection's managed accounts. This is the
  state of every connection until pass-through is set up, tested and enabled.

A connection runs one lane at a time. The console refuses to turn either on while
the other is, and if a row somehow has both on, the API answers LDAP: it was
there first, so adding an OIDC lane can never change whose directory an existing
LDAP connection's passwords go to.

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
                                    OIDC: resolve + vet host ─▶ dial the vetted IP
                                          TLS (verified) ─▶ POST the token endpoint
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
- `"oidc"`: `preset`, `issuer`, `tokenEndpoint`, `clientId` and `extra` (the
  preset's optional form fields), and nothing else. None of it is a secret. An API
  from before the lane was generic answers an Okta connection as `"okta"` with just
  `issuer` and `clientId`; that is still read, as the okta preset with the issuer's
  `/v1/token`.

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

- **An OIDC success:** cached, for 15 minutes at most
  (`passthrough.OIDCMaxCacheTTL`, one constant for every preset), because a
  provider's call takes one to seven seconds and a mail client reconnects all day.
  See "The OIDC lane" for what ends an entry early and why 15 minutes is a
  stopgap.
- **A rejection or an outage:** never cached. A rejection is remembered only as
  the failure budget's identical-retry memory (minutes, in memory).

The log carries reason codes (`user_not_found`, `ambiguous_entry`,
`user_bind_rejected`, `host_blocked`, `tls_failed`, `oidc_mfa_required`, ...),
never the password, the service secret, a token, a filter or a DN the directory
returned.

## The OIDC lane (#383)

A connection whose provider has an OAuth password grant has its managed accounts
asked of the customer's own provider: Okta, Keycloak, Auth0, PingFederate,
FusionAuth, or any other OpenID Connect provider whose token endpoint takes a
**public** client's `password` grant (the `generic` preset). i10 holds **no
secret** for it: the issuer, the token endpoint, a public client id and a few
optional plain form fields. They are in the connection's `config.oidcMail`, set by
an owner in the console (`PUT /identity/connections/:id/oidc-mail`, step-up) and
validated there and again by `oidc.Settings.Validate`. An Okta-only
`config.oktaMail` from before the lane was generic is still read, as the okta
preset, and replaced by the next write; nothing is migrated in bulk.

OneLogin is not a preset: its password grant is documented only with
`Authorization: Basic <client id>:<client secret>`, and this lane holds no client
secret. Entra and Google get no password lane; see "Lanes we are not building"
below.

**The token endpoint is discovered, once, when an owner saves.** The owner gives
the issuer. The API reads `{issuer}/.well-known/openid-configuration` through its
egress guard, takes `token_endpoint`, and refuses the save when the document lists
`grant_types_supported` without `password` (Auth0 with a realm may list its
`password-realm` grant instead). The endpoint must be `https` on **the issuer's own
host, exactly**: same name, port 443, a plain path, no query. Not "the same
registrable domain": `acme.okta.com` and `evil.okta.com` share `okta.com`, and no
preset splits its issuer and token endpoint across hosts. A provider that does is
refused on save, loudly. PingFederate on its default port 9031 is refused for the
same reason (no port).

authd does **not** fetch discovery at bind time. The endpoint is the one the owner
approved, and authd re-validates it at every bind with the same rules, including
the host rule. A provider that later moves its token endpoint breaks sign-in until
an owner saves again, which is an outage an admin can see and fix; an endpoint
that quietly followed the provider's document would let whoever can change that
document choose where every member's password goes.

What the customer's admin has to have set up is the provider's side: a **public**
client (no secret) with the password grant allowed, and no second factor demanded
of it.

| Preset       | Client id                | Optional fields (none secret)   | The provider's side                                                                                                                                                                                                                                             |
| ------------ | ------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `okta`       | `0oa` + 17 characters    | `scope`                         | A native app (`token_endpoint_auth_method: none`), an access-policy rule allowing `password`, and an app sign-in policy whose rule is "Password" only. The issuer must be a custom authorization server (`/oauth2/<id>`); the org server has no password grant. |
| `keycloak`   | any printable, up to 256 | `scope`                         | A public client with Direct Access Grants on.                                                                                                                                                                                                                   |
| `auth0`      | any printable, up to 256 | `audience`, `realm`, `scope`    | A Native application with the Password grant; a Default Directory in tenant settings, or a `realm` (the `password-realm` grant).                                                                                                                                |
| `ping`       | any printable, up to 256 | `validator_id`, `scope`         | A client with authentication None and Resource Owner Password Credentials allowed.                                                                                                                                                                              |
| `fusionauth` | any printable, up to 256 | `scope`                         | An application with the Password grant enabled and client authentication not required.                                                                                                                                                                          |
| `generic`    | any printable, up to 256 | `audience`, `resource`, `scope` | Whatever the provider calls the above.                                                                                                                                                                                                                          |

One request to the token endpoint, form-encoded: `grant_type=password` (Auth0 with
a realm: `http://auth0.com/oauth/grant-type/password-realm`), `username=<the
account's address>`, `password`, `scope=openid` unless the owner set one,
`client_id`, and the preset's optional fields. No client credential of any kind is
sent, and no field the request owns (`grant_type`, `username`, `password`,
`client_id`, `client_secret`) can be set as an optional one.

The mapping, for every preset; a preset adds the refusals it can tell apart (next
table):

| The provider answers                                     | Outcome       | LDAP answer            | Reason in the log                                                                           | Budget slot |
| -------------------------------------------------------- | ------------- | ---------------------- | ------------------------------------------------------------------------------------------- | ----------- |
| `200` with an `access_token`                             | `Verified`    | `success`              | `verified`                                                                                  | given back  |
| a refusal the preset tells apart (next table)            | `Rejected`    | `invalidCredentials`   | `oidc_mfa_required`, `oidc_account_locked`, `oidc_account_disabled`, `oidc_action_required` | **kept**    |
| any other `invalid_grant`, at any status                 | `Rejected`    | `invalidCredentials`   | `oidc_invalid_credentials`                                                                  | kept        |
| `invalid_client`, `unauthorized_client`, any other `4xx` | `Unavailable` | **`unavailable` (52)** | `oidc_config_<error code>`, or `_unknown`                                                   | given back  |
| `429`, `5xx`, a redirect, a `200` that is not a token    | `Unavailable` | **`unavailable` (52)** | `oidc_rate_limited`, `oidc_server_error`, ...                                               | given back  |
| timeout, DNS, dial, TLS, or a host the guard refuses     | `Unavailable` | **`unavailable` (52)** | `timeout`, `dns_failed`, `host_blocked`, ...                                                | given back  |

What each preset tells apart (`internal/oidc/presets.go`, with the source beside
each row there). Everything not listed is a plain `invalid_grant`, and a plain
`invalid_grant` is a rejection whatever its text says:

| Preset       | The provider says                                                                                              | Reason                                                             | Source                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `okta`       | `400 invalid_grant`, "denied by sign on policy"                                                                | `oidc_mfa_required`                                                | probed on a real org (#383)                                 |
| `okta`       | a locked account                                                                                               | (none: it says "credentials ... invalid", as for a wrong password) | probed on a real org (#383)                                 |
| `keycloak`   | `invalid_grant`, "Account disabled"                                                                            | `oidc_account_disabled`                                            | phasetwo.io/blog/keycloak-invalid-grant (probed on 26.7.3)  |
| `keycloak`   | `invalid_grant`, "Account is not fully set up" (a required action)                                             | `oidc_action_required`                                             | same                                                        |
| `keycloak`   | wrong password, unknown user **and brute-force lockout**: "Invalid user credentials"                           | (none: the same text by design)                                    | same; Keycloak's admin guide                                |
| `auth0`      | `403 mfa_required`                                                                                             | `oidc_mfa_required`                                                | auth0.com/docs, "Authenticate Using the ROPG Flow with MFA" |
| `auth0`      | `429 too_many_attempts`, "Your account has been blocked ..."                                                   | `oidc_account_locked`                                              | auth0/docs-v2 (error codes)                                 |
| `auth0`      | `429 too_many_attempts`, "suspicious login behavior" (our address, not the person)                             | `Unavailable`, `oidc_rate_limited`                                 | same                                                        |
| `auth0`      | `blocked_user`; legacy `401 unauthorized`, "user is blocked"                                                   | `oidc_account_disabled`                                            | same; not confirmed for `/oauth/token`                      |
| `auth0`      | `403 access_denied`, `invalid_user_password`                                                                   | `oidc_invalid_credentials`                                         | same                                                        |
| `ping`       | `invalid_grant` whose text is the password credential validator's own                                          | (none: it is the customer's directory's wording)                   | docs.pingidentity.com, "OAuth grant type parameters"        |
| `fusionauth` | `two_factor_required`, or `error_reason` `multi_factor_challenge_required`                                     | `oidc_mfa_required`                                                | fusionauth.io/docs/apis/oauth/oauth-error; FusionAuth forum |
| `fusionauth` | `error_reason` `user_locked`                                                                                   | `oidc_account_locked`                                              | same                                                        |
| `fusionauth` | `error_reason` `user_expired`, `login_prevented`                                                               | `oidc_account_disabled`                                            | same                                                        |
| `fusionauth` | `change_password_required` or a `change_password_*`, `*_verification_required`, `registration_required` reason | `oidc_action_required`                                             | same                                                        |
| `generic`    | `mfa_required`, `two_factor_required`                                                                          | `oidc_mfa_required`                                                | the codes Auth0 and FusionAuth use                          |
| `generic`    | `interaction_required`, `consent_required`, `login_required`                                                   | `oidc_action_required`                                             | OpenID Connect Core 3.1.2.6                                 |

⚠ **What is and is not verified.** Okta's answers were probed against a real org.
Keycloak's were probed on 26.7.3 by a third party (the post above). Auth0's,
PingFederate's and FusionAuth's are quoted from vendor documentation and not
probed against a live tenant, and the exact HTTP status of a Keycloak or FusionAuth
refusal varies by release, which is why the mapping never keys on it.
Descriptions are human text and change, so a phrase only ever refines a rejection
into a more specific one: a provider that rewords it is still a rejection.

⚠ **A locked account usually answers exactly like a wrong password.** Okta,
Keycloak and PingFederate all do (Keycloak on purpose). Ten wrong passwords lock
the REAL Okta account (the default policy). authd cannot tell the two apart where
the provider does not, so the failure budget above (3 per 15 minutes, shared in
Postgres) and the identical-retry memory are what keep i10 from spending a
person's attempts. Both apply to this lane exactly as to LDAP.

⚠ **Any `invalid_grant` is a rejection.** It is a statement about the person's
credentials by definition (RFC 6749 5.2), and a rejection keeps its budget slot
while an unavailable answer gives it back. Calling an unrecognised one
"unavailable" would let a mail client retry a refusal the provider really counted,
without limit. Keycloak says 401, Auth0 403 and Okta 400 for the same thing.

`oidc_mfa_required` is the right password refused because the provider still wants
a second factor. The client sees `invalidCredentials`; the log says why (and which
preset), so the console can later tell the admin to allow a password-only sign-in
for mail. Nothing a provider says is copied into a log line: an answer is reduced
to a fixed reason code, and an error code that is not lower-case words is dropped.

**Egress.** The token endpoint is the customer's choice, so `internal/oidc`
connects only through `internal/egress`: the name is resolved, every address must
be public, and the connection goes to the vetted address with the endpoint's name
as the TLS server name (TLS 1.2 or later, system roots, no pin). No proxy from the
environment is used, and a redirect is never followed: either would carry the
password where nobody configured. The response is read to 64 KiB. The API's
discovery request goes through the same guard (`guardedFetch`).

**Cache.** An OIDC success is cached for **15 minutes** (`OIDCMaxCacheTTL`), not
the full `AUTHD_CRED_CACHE_TTL`. The long cache is safe only where a password
change reaches authd, and no OIDC provider here sends one; for Okta that would be
an event hook raising `credential_epoch` on a password change, a suspension, a
lock or a deprovision (B9 step 2b). Until a connection's hook is built and
verified nothing tells authd, so 15 minutes is the longest a changed password
keeps opening mail. 2b's verified hook is what may lift it, for an Okta connection
and only for one. Three things end an entry sooner:

- the projection lookup, which runs first: a suspended or deprovisioned account is
  refused at the next bind;
- a change to the connection's OIDC settings (a different provider, client, preset
  or field, or OIDC mail sign-in switched off), which raises the `credential_epoch`
  of every account the connection manages in the save's own transaction, together
  with the connection's pass-through version, so authd's copy of the settings is
  fetched again at the next bind (see "A change to pass-through" below);
- `credential_epoch` itself, for any other revocation.

⚠ **The lane is not in the verifier's name.** Which lane a connection runs is the
API's answer, fetched inside `Verify`, and the resolver does no I/O, so the name
is `passthrough:<connection id>` for both. An LDAP success is never cached, so
nothing it minted can answer for an OIDC account; an OIDC success is cached, and
the settings-change epoch raise above is what stops it answering after the
connection leaves OIDC.

⚠ **This lane needs MFA off for mail.** The provider must let the public client
sign in with a password alone, so an admin who turns it on makes mail sign-in skip
the second factor. That is why it stays an admin's opt-in. The default for SSO
users is the device code (#383), which needs no setup at the provider.

## Lanes we are not building

These were probed and work, but device codes (#383) cover each one, so they are
not built. The measurements are kept so nobody probes them again; the full record
is in `docs/research/mail-device-binding.md`, section 7.

- **Entra password grant (ROPC).** Works under Security Defaults for a user with
  no MFA registered (`200`, about 6.7 s cold). A wrong password answers
  `AADSTS50126`; a lock answers a distinct `AADSTS50053` and then refuses the right
  password too, clearing in about 60 s. From a familiar address the lock came at
  the 15th distinct failure after a success. It stops working the moment MFA
  applies to the user, which is Entra's default.
- **Thunderbird OAuth on Stalwart's own issuer.** A mail-scoped token (scope
  `urn:ietf:params:oauth:scope:mail`) signed in to IMAP with XOAUTH2 and to SMTP.
  It reached Thunderbird only; no other mail app was shown to use it.
- **Google Secure LDAP (#400).** The only supported way to check a Google
  Workspace password server-side, on paid Google plans only and with a per-tenant
  client certificate. Never probed: i10.tech's Cloud Identity Free has no Secure
  LDAP.

## Mail device codes (#383)

An enrolled iPhone or iPad signs in to IMAP and SMTP with a **device code**
instead of the person's password: `i10dc1.<device id>.<secret>`, the
`authd.mail_devices` row's UUID as 32 lowercase hex digits and 32 random bytes
as 43 characters of unpadded, strict base64url, exactly 83 characters
(`internal/devicecode`). The API mints it and stores only
`HMAC-SHA256(key, "i10/mail-device-code/v1" 0x00 | id | secret)` and the key's
id (`code_hash`, `code_kid`), under `MAIL_DEVICE_CODE_KEYS`, which the API and
authd hold and the mail front does not. `internal/devicecode/testdata/vectors.json`
pins the format and the hash for the API's TypeScript minter too.

⚠ **The prefix is reserved.** After the bind token, every password that starts
`i10dc` goes to the device lane, and one that does not parse exactly is refused
there (`device_code_malformed`). A truncated or mistyped code never reaches Clerk
or a company's directory, and never spends a failure-budget slot.

⚠ **The whole gate applies first, `RouteOf` included.** A device code is held by
everything that holds the password: every row reason in the credential cache's
table, and `RouteOf`'s refusals (`sso_required`, `managed_no_connection`,
`connection_inactive`), which the password lane meets inside the resolver and
the device lane, which never calls the resolver, meets in `handleBind`. When the
hold lifts the device signs in again; nothing is deleted. An account a company's
SSO manages, with an active connection and no password lane at all (Entra,
Google Workspace), signs in with a device code.

**The lane, in order** (`ldapsrv/bind_device.go`). ⚠ The order is a security
property, and tests assert it:

```
bind token (its MAC covers the device id) -> account row -> gate.Refusal ->
per-DN throttle -> parse -> key ring -> row by id -> gate.DeviceRefusal ->
key id -> constant-time hash compare -> first-use claim -> idle limit -> touch
```

- **`gate.DeviceRefusal`**, one function for the bind and the front: the row
  must exist (`device_revoked` in the front; the bind finds no row first and
  logs `device_unknown`), belong to the person the DN names, carry the
  account's address now and its workspace (null-safely: i10's own mailboxes
  have none) (`device_mismatch`), and be an iPhone or iPad
  (`device_platform_refused`: a Mac's code alone is refused until PR 3 checks
  its Secure Enclave certificate with it).
- **Nothing is written before the hash matched.** Then, for a code never used,
  one UPDATE claims the first use, setting `first_used_at` with a `coalesce`
  where it is already set or `created_at` is under ten minutes old. No row
  means the code died unused. ⚠ The `coalesce` is what lets Apple Mail's
  simultaneous first connections all pass: each waits for the row lock and
  re-reads a row whose first use is set.
- **A used code idle past 90 days is refused**, and `last_used_at` moves at most
  once a day. Both clock rules are judged by the database's `now()`, in the same
  statements (`projection/devices.go`), never by authd's clock.
- ⚠ **Our faults are `unavailable`, never `invalidCredentials`:** no key ring
  (authd starts without `MAIL_DEVICE_CODE_KEYS`, and every device bind is then
  unavailable, logged at ERROR), a `code_kid` the ring does not hold, a database
  error. An iPhone told "wrong password" asks its owner for a code they have
  never seen.
- **It touches nothing else.** No verifier, no credential cache, no flight, no
  identical-failure memory, no failure budget: no identity provider knows the
  code, so none is asked, and nothing here can lock the person's real account.
  `TestDeviceCodeRefusals` and `TestDeviceLaneFaultsAreUnavailable` assert zero
  provider calls and zero budget writes for every refusal.

**What authd may write.** `authd.mail_devices` is read through the schema's
default privileges, and the `authd` role may UPDATE `first_used_at` and
`last_used_at` and no other column (`*_mail_devices_grants_and_triggers`).
Since #383 PR 3 it also keeps the Mac liveness rows,
`authd.mail_device_cert_binds` (SELECT, INSERT, UPDATE, DELETE), and may not
read the certificate permits, `authd.mail_device_cert_permits`, at all
(`*_mail_device_cert_grants_and_triggers`).
`TestTheDeviceTableGrants` proves both roles' halves.

**Revoking** is a DELETE (the API's store, `apps/api/src/mail-devices/store.ts`), and the
foreign key to `authd.accounts` cascades, so every permanent end of a mailbox
takes its devices. The next bind finds no row; the front closes the open
sessions at its next poll (below).

**The API side** (`apps/api/src/mail-devices/`). Every API read or write of
`authd.mail_devices` goes through one module (`mint`, `list`, `revoke`, `endFor`,
and `pruneMailDevices`), which carries the tenant filter outside RLS (checked in
CI against a fixed non-RLS allowlist in `apps/api/src/db/rls-allowlist.ts`).
`mint` locks the `authd.accounts` row (`FOR NO KEY UPDATE`), checks every gate
hold and the caller's `expectedEpoch`, and inserts with a database-generated
UUIDv7; every revocation writes `authd.accounts` first and calls `endFor` in the
same transaction so a mint cannot race a revocation. `apps/api/src/retention.ts`
prunes expired unused (> 10 minutes) and idle (> 90 days) rows hourly in batches
of 1,000, and `apps/api/scripts/mail-device.ts` provides a CLI (`mint`, `list`,
`revoke`) for throwaway-account probes until the user-facing enrollment routes
land.

## Suspended mailboxes (#344)

A mailbox a company's directory switched off has `authd.accounts.suspended_at`
set and stays `active`. Searches return it, so mail keeps arriving; every bind is
refused with `invalidCredentials` (`mailbox_suspended`) BEFORE the verifier is
chosen, so before the credential cache, Clerk or the pass-through is consulted.

## Mail front (#383)

`cmd/mailfront` is the TLS front for IMAP on 993 and SMTP submission on 465. It
is a second binary in this image, run as its own container in the Stalwart pod.

**Why it exists.** Stalwart never ends a session that has already signed in.
Probed on v1.1.0 (`docs/research/mail-device-binding.md`, section 6): a password
change, removed permissions and even a deleted account left open IMAP sessions
reading and open SMTP sessions sending. Everything above in this README stops
the next sign-in. Nothing stopped the session that was already open. The front
closes it: it knows which account each connection signed in as, and within
about a second of a change that could revoke it, it asks the projection whether
that account would still be let in (see "The sweep").

**Why it is not part of authd.** The front parses bytes from anyone on the
internet before they have signed in. A parser bug that crashes it must not take
LDAP down with it. A bug that leaks memory must find no secret to leak. The front
has a TLS certificate, a read-only database connection as its own role
(`mailfront`, below), the key it signs bind tokens with (below) and its
settings. It has no Clerk key, no `AUTHD_API_SECRET` and no LDAP service
secret. It has its own memory limit and
its own user id. It shares code with authd (`internal/gate`,
`internal/projection`, `internal/config`), not a process.

### The bind token: the attribution boundary

The front can only close a connection it can attribute, and Stalwart is what
decides who a connection is signed in as. Every review round found a way to make
the two disagree: a literal Stalwart read as a word (round 1), a second sign-in
under the tag `*` or `+` (round 2), and a forged literal marker that Stalwart
echoed raw, so the output scanner read the next 100 MB as a literal and missed
an `UNAUTHENTICATE` and a second `LOGIN` behind it (round 3). Each was patched in
the front's parsers, and each patch was a parser trying to follow Stalwart's.

**So the boundary is not a parser.** Every person sign-in the front forwards
carries a token in front of the password (`internal/bindtoken`):

```
i10mf2.<base64url: key id | expiry | nonce | HMAC-SHA256>.<the real password>
```

The HMAC, under a key the front shares with authd, covers a fixed domain label,
the key id, the Clerk user id the front looked the login up as, the mail device
the real password names (its 16-byte id, length-prefixed; nothing when it is
not a device code), the expiry (60 seconds) and a 16-byte nonce.

⚠ **The device is read, on both sides, from the real password, by the same
parser** (`devicecode.Of`). So the device the front credits a connection to and
the device authd verifies are the same by construction: a token minted in front
of one device's code does not open in front of another's, or in front of a
password (`TestATokenForOneDeviceDoesNotOpenAnother`). `bindtoken.Unwrap`
returns the device its MAC covered, and the device lane reads exactly that row.
v1 tokens (`i10mf1.`) carried no device and are refused: the front and authd
are one image in one pod and switch together. Stalwart passes the password through to authd's
LDAP bind unchanged. authd accepts a **person** bind only with a valid token for
the very user id the bind DN names, takes the token off, and only then checks
the password the usual way. Whatever Stalwart does after the front lost track,
a second sign-in carries what the client typed: a raw password, or a token the
client cannot make. authd refuses it. Probed against a live Stalwart v1.1.0
(`docs/research/mail-device-binding.md` section 9): round 3's exact bytes now
end `e NO [AUTHENTICATIONFAILED]`.

- **Every person DN, every lane.** Pass-through accounts (LDAP, OIDC) have the
  same `uid=<clerk id>,ou=people,...` DN, so the token covers them too. The
  service bind (`cn=stalwart`, Stalwart's delivery lookups) needs none.
- **No permissive phase, no fallback.** A bind without a valid token is never
  retried as a raw password, and a password that starts with `i10mf2.` is
  wrapped like any other, so exactly one layer comes off.
- **A refused bind costs nothing.** authd refuses it right after reading the
  DN: before the projection, the credential cache, the failure budget, the
  per-DN throttle, Clerk or any pass-through directory. A client signed in as
  itself can send `LOGIN victim guess` as often as it likes without spending
  the victim's budget or locking them out
  (`TestARefusedBindTouchesNoBudgetNoThrottleAndNoProvider`).
- **Not single use.** Stalwart binds once per sign-in, and a token is good for
  one account for one minute. A replay inside that minute needs the bind
  password, which only crosses loopback inside the pod.
- **One spelling.** The parser takes the exact encoded length in the URL
  alphabet and nothing else (`FuzzUnwrap` found that Go's base64 skips CR and
  LF).

**Every failure is closed:**

| What is wrong                                     | What happens                                                                                                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| authd has no keys, or cannot read them            | Every person bind is answered unavailable (`bind_token_no_keys_configured`, at ERROR), so clients retry instead of asking for a password. authd still runs, so delivery's service bind works. |
| The front has no key, or cannot read it           | The front forwards no sign-in: IMAP `NO [UNAVAILABLE] Sign-in is temporarily unavailable.`, SMTP `454 4.7.0`. Logged at ERROR at start.                                                       |
| The front's key is not among authd's              | `bind_token_unknown_key`: unavailable as above, at ERROR. Never a wrong password, because the fault is ours.                                                                                  |
| A token for another account, or tampered          | `bind_token_bad_mac`.                                                                                                                                                                         |
| A token older than a minute, or the clocks differ | `bind_token_expired`. The front, Stalwart and authd share the pod's clock; 5 seconds of skew are allowed ahead.                                                                               |
| The front's lookup failed (database down)         | The front answers unavailable as above and forwards nothing.                                                                                                                                  |
| The login is unknown to the front                 | Forwarded with no token; authd refuses it. A login Stalwart answers alone (its recovery admin) signs in unattributed, and the front closes it.                                                |

Each refusal is logged by authd as `bind rejected` with its reason and the
user id, at INFO.

**Rotating the key.** authd takes a list (`AUTHD_BIND_TOKEN_KEYS`), the front
signs with one (`MAILFRONT_BIND_TOKEN_KEY`), each `<id>:<base64 of at least 32
bytes>`. In the `prod_mail_bind_token` Doppler config:

1. Add the new key to `AUTHD_BIND_TOKEN_KEYS` beside the old one, under a new
   id: `1:<old>,2:<new>`.
2. Restart the Stalwart pods (a Doppler change needs a restart; authd reads the
   list at start). Both keys are accepted.
3. Set `MAILFRONT_BIND_TOKEN_KEY` to `2:<new>` and restart again. Open
   sessions are not affected; the next sign-in uses the new key.
4. Remove `1:<old>` from `AUTHD_BIND_TOKEN_KEYS` and restart once more.

Each restart drops every connection, which clients take as a reconnect. A key
leak alone signs nobody in: a token still needs the person's password behind
it. It only takes the attribution back to where the parsers left it.

**Outside the token design, on purpose:**

- **Stalwart's recovery admin** (`STALWART_RECOVERY_ADMIN`) is checked by
  Stalwart before any directory and never reaches authd, so no token covers it.
  It stays set: it is how we administer Stalwart, including when authd is down.
  Through the front, a first sign-in as it is closed as unattributed. A second
  sign-in as it, behind round 3's forged literal, is not seen and stays open
  (probed, section 9), and the same goes for impersonating a person with
  `<user>%admin`. Both need the recovery admin's password, which already opens
  the whole server over the management API.
- **App passwords, API keys and Stalwart's OAuth tokens** are checked by
  Stalwart locally too. The `i10user` role takes away the permissions to create
  app passwords and API keys, Stalwart's OAuth endpoints are not published, and
  the bearer mechanisms are off upstream (below).
- **Bearer sign-ins** (OAUTHBEARER, XOAUTH2) are checked by Stalwart alone. The
  front refuses them before sign-in, and as defence in depth Stalwart is set to
  refuse them too: IMAP goes upstream without the SSL TLV, so Stalwart treats it
  as cleartext, where it refuses bearer tokens, and `Imap.allowPlainTextAuth`
  keeps LOGIN working; SMTP keeps the TLV and its `saslMechanisms` offer only
  PLAIN and LOGIN on 465. Both probed on v1.1.0
  (`infra/k8s/i10/stalwart/config/README.md`, "The mail front").
- **JMAP and webmail** reach Stalwart's HTTP listener directly and never pass
  the front, so they never carry a token: they would fail every person sign-in.
  **Webmail stays off until the Bulwark JMAP proxy lands** (a later PR). Note
  for that PR: Stalwart caches a successful HTTP Basic sign-in keyed on the
  `Authorization` header for `OidcProvider.accessTokenExpiry`, default one hour
  and at least ten minutes (`http/src/auth/authenticate.rs:112-126`,
  `registry/src/schema/structs_impl.rs:53755`), and drops an entry earlier only
  when the account's revision inside Stalwart changes. So a revocation does not
  end an HTTP session for up to an hour unless the proxy ends it.

### Its database role

`mailfront` may SELECT `authd.accounts`, `authd.managed_accounts`,
`authd.required_domains`, `authd.required_exempt` and
`authd.passthrough_versions`, and EXECUTE `core.mailbox_domain_refused`:
exactly what `projection.accountColumns` reads
(`apps/api/drizzle/*_mailfront_role_grants`). Of `authd.mail_devices` it may
SELECT six columns, by column grant: `id`, `clerk_user_id`, `email`,
`tenant_id` and `platform`, what `gate.DeviceRefusal` matches, and
`cert_key_sha256`, the bound certificate key (#383 PR 3). Never the code's
hash or key id, the serial, the model, the name or who created it
(`*_mail_devices_grants_and_triggers`, `*_mail_device_cert_grants_and_triggers`).
It may also SELECT the access-change log, `authd.access_changes`
(`*_access_change_triggers`), and the Mac liveness rows,
`authd.mail_device_cert_binds`, and nothing else; never the certificate permits. It writes nothing, not even the log: the retention job prunes it. It is not
`authd`'s role because `authd` may INSERT and UPDATE `authd.bind_failure_budget`,
and a bug in a parser of internet bytes must not be able to reset or exhaust
anyone's failure budget. `TestTheMailFrontRoleReadsTheGateAndWritesNothing`
connects as the role and proves both halves. There are no default privileges:
a table the gate starts reading later must be granted here, and that test fails
until it is.

⚠ **The role must exist before the grants run, and the grants are not
guarded.** CNPG creates it (`managed.roles` in `platform-db/cluster.yaml`, with
`i10-mailfront-db-role` from Doppler, like `authd`'s). The migrator records a
folder once and never runs it again, so a guard that skipped the grants while
the role was missing (as `20260917035550_pdns_role_grants` does) would leave the
role without them for good. Unguarded, a migration run before the role exists
fails the PreSync hook, loudly, and blocks the deploy until it does. So the
order is:

1. Doppler: `MAILFRONT_DB_USERNAME=mailfront` and an alphanumeric
   `MAILFRONT_DB_PASSWORD` in their own config, a service token from it, and the
   `doppler-token-i10-mailfront-db` Secret in `i10-prod` (by hand, like the other
   tokens). Beside them, the bind token keys, in a `prod_mail_bind_token`
   config of their own (Stalwart must not hold them, and it takes `prod_stalwart`
   whole): one fresh key, `1:` followed by `openssl rand -base64 32`, as
   `MAILFRONT_BIND_TOKEN_KEY`, the same value as `AUTHD_BIND_TOKEN_KEYS`, a
   service token, and the `doppler-token-i10-mail-bind-token` Secret.
2. Merge the role: the managed role and its DopplerSecret. Check that CNPG
   created it (`\du mailfront`).
3. Merge the code: the binary, the grants, the pass-through versions and the
   domain indexes. Nothing runs the front yet; the pin commit publishes the
   image that carries it. While the API pods roll, an authd that already reads
   versions can be answered by an API pod that sends none (version 0). Once a
   new API pod has raised a connection's version, those answers are older
   than the bind's, so that connection's managed sign-ins are unavailable
   (never accepted on old settings) until the API has rolled.
   ⚠ **From the pin commit's roll, every person sign-in is refused until step
   4's restart.** The new authd needs the front's token and has no keys yet;
   nothing sends a token until the front runs. Delivery is not affected. This
   is the "no permissive phase" decision; prod has no mail users yet. With
   users, step 4 follows the pin at once.
4. Merge the deploy: the `mailfront` container, Stalwart's loopback listeners,
   the two bearer settings and the `i10-mail-bind-token` DopplerSecret that
   carries the keys to the `authd` and `mailfront` containers
   (`infra/k8s/i10/stalwart/config/README.md`, "The mail front"). Argo's roll
   starts the front, which waits while Stalwart still holds 993 and 465; the
   PostSync hook then writes the new listeners, which Stalwart reads only at
   start. The pod restart after it (`./bootstrap.sh`) is what moves them.

### The port layout

```
client ──TLS──▶ podIP:993  mailfront ──PROXY v2──────────▶ 127.0.0.1:993  Stalwart `imaps` (no TLS)
client ──TLS──▶ podIP:465  mailfront ──PROXY v2 + SSL TLV──▶ 127.0.0.1:465  Stalwart `submissions` (no TLS)
client ─────▶ :25 and in-cluster :2525 go to Stalwart directly, unchanged
```

- **The numbers do not change.** psl-vps's ufw ROUTED rules match the port after
  the hostPort DNAT, so the hostPorts 993 and 465 moved from the `stalwart`
  container to the `mailfront` container. Stalwart reads `local_port` from the
  PROXY header's destination (probed: a header naming port 4999 made
  `local_port == 465` false). The front sends the port the client reached, so the
  plan's 465 rules hold.
- **Both binds work in one network namespace.** The front binds the pod's own
  addresses (`status.podIPs`, both families), and Stalwart binds `127.0.0.1` on
  the same ports. Probed in Docker with the two containers sharing a namespace.
  `mailfront.Config.Validate` refuses a wildcard or loopback address for the
  front.
- **Only the front reaches Stalwart's 993 and 465.** They are on `127.0.0.1`, so
  only processes in this pod can connect, and Stalwart takes the PROXY header
  from loopback only (`overrideProxyTrustedNetworks`). The other containers here
  are authd and Stalwart itself. Stalwart sets `SO_REUSEPORT`, which Linux
  shares only between sockets of the same user, so the front runs as uid 65532,
  never Stalwart's 2000.
- **The SSL TLV is required.** Without it Stalwart treats the connection as
  cleartext: IMAP says LOGINDISABLED, SMTP offers no AUTH.
- **TLS is what Stalwart served.** Measured against Stalwart v1.1.0 and the front
  with the same RSA certificate: TLS 1.2 and 1.3 only, for 1.2 only
  `ECDHE-RSA-AES128-GCM-SHA256`, `-AES256-GCM-SHA384` and `-CHACHA20-POLY1305`,
  all three TLS 1.3 suites, and X25519MLKEM768 as the group. The front reloads
  the mounted certificate files every 30 seconds, so a renewal reaches 993 and
  465 without a restart. Port 25 is still Stalwart's and still needs
  `cert-reload.yaml`.

### What it parses, and where it stops

Until a sign-in succeeds, the front reads the client's commands one at a time
and sends Stalwart the next only after Stalwart has answered the last
("lock-step").

**Nothing a client sends reaches Stalwart as sent.** The front reads each
command, then sends Stalwart a command it wrote itself, from what it read:

- **IMAP:** only `CAPABILITY`, `NOOP`, `LOGOUT`, `ID`, `LOGIN` and
  `AUTHENTICATE PLAIN`. `LOGIN`'s two arguments and every `ID` string go as
  LITERAL+ literals, and a SASL response as freshly encoded base64. Every other
  command (`SELECT`, `ENABLE`, anything unknown) is answered `BAD` by the front
  and never forwarded; `STARTTLS` is answered too, since the client is already
  on TLS. `ID` fields are logged (device naming, later PRs).
- **SMTP:** only `EHLO`/`HELO` (with one domain word), `NOOP`, `RSET`, `QUIT`
  and `AUTH PLAIN` / `AUTH LOGIN`. Anything else is answered `503` before AUTH.
- **Every IMAP command goes under a random tag of the front's own** (`mf` and
  16 hex digits), and the answer gets the client's tag back. A tagged answer for
  any tag the front did not just use ends the session.

Why: Stalwart's parser and the front's are two parsers, and wherever they
differed a client could sign Stalwart in as one person while the front recorded
another. One difference was real (found in review, 2026-11-21): Stalwart opens a
literal only after whitespace, so `a NOOP x{N}` was a literal to the front and a
word to Stalwart. The front answered `+`, forwarded N bytes, and Stalwart ran
them as a `LOGIN` the front never saw, which a pipelined `LOGIN` under the same
tag then took the credit for. With every forwarded command written by the front,
Stalwart parses only text whose meaning is fixed, and with the front's own
tags, no answer can be taken for another command's.

**The front reads by Stalwart's grammar and refuses where the two could
differ** (`readIMAPRequest`, written against Stalwart v1.1.0's
`crates/imap-proto/src/receiver.rs`, and `parseSMTPCommand` against
`Rfc5321Parser::hashed_value`): a tab, form feed or lone CR anywhere, a `"` or
`{` in the middle of a word, literal8, an escape other than `\"` and `\\`,
anything but a line end after a literal's brace, a verb byte that is not a
letter or digit, and for SMTP a leading space or any control byte. Any of
these before sign-in ends the connection. The tests run against a fake
Stalwart whose reader is an independent port of Stalwart's
(`stalwart_rules_test.go`), and `FuzzReadIMAPRequest` checks that everything
the front reads, rebuilt, reads back through that port as the same arguments.

- **Mechanisms it cannot attribute are refused and not advertised.**
  `OAUTHBEARER` and `XOAUTH2` carry a user name that is only the client's claim.
  They are taken out of the greeting, `CAPABILITY` and `EHLO`, and refused with
  `BAD` / `504` before reaching Stalwart. Refusing them breaks nothing: no i10
  client uses them, Stalwart's OAuth endpoints are not published, and the OAuth
  lane is not being built. Closing the connection after the sign-in succeeded
  would have looked like a working sign-in that keeps dropping. Stalwart
  refuses them upstream as well (the bind token, above). `COMPRESS` is
  also stripped, because compressed output would hide Stalwart's answers from
  the scan below. PLAIN with an `authzid` naming somebody else is cancelled.
- **Bounded.** 12290-byte lines (RFC 4954's AUTH line), 8 KiB literals and
  16 KiB commands, 64 commands, 2 minutes from accept to signed in (30 s of that
  for the handshake), 6000 connections, 2000 not signed in, 32 not signed in
  per address (per /64 for IPv6). Stalwart keeps its own per-IP limits and
  bans, and it sees the real address.

After the sign-in, the client's bytes are spliced to Stalwart with no parsing.
**Stalwart's output is still scanned, for one thing, as defence in depth only.**
The bind token is the boundary: a second sign-in the scan misses is still
refused by authd (round 3 was exactly such a miss). The scan stays because it
closes the connection instead of leaving the client signed in as the first
account, and because the recovery admin is outside the token. Stalwart answers
`UNAUTHENTICATE` and then a second `LOGIN` on the same connection (probed), so
a client could sign in as one account and carry on as another that is revoked
later. Following the client's stream to catch that cannot be made exact: if
Stalwart refuses a synchronizing literal, the bytes after it are read as
commands. Stalwart's own output can be followed exactly, because it always sends
the literal it announces. Every successful sign-in it answers has a
`[CAPABILITY ...]` code on its OK, and nothing else after the greeting does, so
after sign-in the front closes the connection on any OK with that code,
**whatever word comes before it**. Stalwart takes any non-blank bytes as a tag
and echoes them, so `* LOGIN b pw` is answered `* OK [CAPABILITY ...]`, which
looks untagged (found in review, 2026-11-22; an earlier scan skipped `*` and
`+` lines and let that sign-in through). Before sign-in the front refuses those
tags, and every other byte RFC 3501 keeps out of a tag. SMTP gets the same
guard for `235`, although Stalwart refuses a second AUTH today. The scan keeps a
few bytes of state and skips literals by length, so message text that looks like
a sign-in is never read as one. That rests on Stalwart never ending a line with
bytes a client chose, which its v1.1.0 error texts do not (they quote client
input, then end in fixed text). It is tested, fuzzed across read boundaries,
and fuzzed against an independent line-by-line oracle (`secondSignInAt`).

### Who the connection is

Before the sign-in is forwarded, the front looks the login up the way
Stalwart's `filterLogin` (`mail=?`) does through authd's search: normalised,
primary address only (`projection.AccountByLogin`). It reads the row before
forwarding, not after the OK. A revocation that lands before the read is seen
by authd too, and the sign-in fails. A revocation that lands after the read
changes the row away from what the front recorded, and the next sweep closes
the connection.

**No row means no session.** If the lookup found no active account, or found
one the gate refuses, and Stalwart still answers OK, the front closes the
connection. That is how a first sign-in as Stalwart's recovery admin ends. A
lookup that failed forwards nothing (the bind token, above). The row is also
what the token is minted for: its Clerk user id is the one authd checks against
the bind DN.

### The sweep

Two loops close revoked connections (`Sweeper.Run`), and both decide with the
same code: `Grant.revoked` on rows read by `projection.SweepQuery`, which is the
bind's own column list, so whatever authd would refuse at the next sign-in
closes the connection that is already open.

- **The poll, every second** (`MAILFRONT_SWEEP_INTERVAL`, `Sweeper.Poll`), reads
  the access-change log for what committed since its last read, and re-checks
  only the open connections that names, plus every connection that signed in
  since the last poll. With nothing changed and nobody new it reads no account.
- **The backstop, every minute** (`DefaultBackstop`, `Sweeper.Sweep`),
  re-checks every open connection, as the front once did every second. It is
  the bound for a write the log missed, and it also runs as soon as it may when
  a poll asks for it (below). It runs in its own goroutine, so a slow full sweep
  never holds the poll back.

Either closes a connection whose account:

- the gate now refuses. This is `internal/gate`, the code authd's bind uses,
  with every row reason, plus SSO-required as `ManagedResolver` decides it, plus
  losing an SSO exemption;
- has a different `credential_epoch` or `clerk_updated_at` than at sign-in (the
  values the credential cache is keyed on). Any Clerk profile change counts, so
  a renamed person reconnects once, with the password their client already has;
- is now answered by a different verifier (Clerk, or another connection);
- has a different primary address than the one it signed in with: that address
  is the login, and its domain is how the poll finds the connection;
- has no active row any more;
- for a session that signed in with a device code, has a device row that is
  gone or no longer matches (`gate.DeviceRefusal`, the bind's own rule:
  `device_revoked`, `device_mismatch`, `device_platform_refused`). A device
  session closed for the epoch or `clerk_updated_at` reconnects with the code it
  holds.

**Who the device is.** The front parses the password it forwards with the
bind token's own parser and records the device in that sign-in attempt's
`Grant` (`DeviceID`), so it is the device the token covers. ⚠ One per attempt:
a code refused and then a password accepted on the same connection is a
password session (`TestAnEarlierAttemptsDeviceIsNeverCreditedToTheSignIn`). The
re-check reads the device rows of the connections that have one, by
`id = ANY($2)`, in the same statement as their accounts (`projection.SweepQuery`),
one row per account however many devices it has.

**The access-change log** (`authd.access_changes`). A statement-level trigger,
`authd.log_access_change`, on every table the gate reads (`authd.accounts`,
`authd.managed_accounts`, `authd.passthrough_versions`, `authd.required_domains`,
`authd.required_exempt`, `authd.mail_devices`, `core.domains`, `core.join_domains`) inserts one row
per distinct key a statement touched, in the writer's own transaction:

| Kind         | Key                    | Written by                                                              | Re-checks                                            |
| ------------ | ---------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------- |
| `account`    | Clerk user id          | `accounts`, `managed_accounts`, `required_exempt`, `mail_devices`       | the connections of that account                      |
| `domain`     | lowercased mail domain | `required_domains`, `core.domains`, `core.join_domains` (`lower(name)`) | the connections that signed in with an address there |
| `connection` | SSO connection id      | `passthrough_versions`                                                  | the connections that connection answers for          |
| `all`        | (none)                 | a TRUNCATE of any of them                                               | every connection                                     |

INSERT, UPDATE and DELETE are logged; foreign key cascades fire them too, so a
workspace or mailbox deleted reaches the log. An update logs the old and the new
key of every row it changed, so an address or a domain name that moves is
re-checked under both. A bulk update of 10,000 accounts is one trigger call that
inserts 10,000 small rows in one statement. An update that moves only columns
the gate never reads logs nothing: each trigger names those columns (a
deny-list, so a column added to a table later is watched), and
`TestEveryTableTheGateReadsLogsItsChanges` checks each one against the gate's
SQL text. The same test reads the tables from the gate's own SQL and from every
`core` function it reaches, so a table the gate starts reading fails it until it
has its four triggers. `gatePaths` (`internal/mailfront/paths_db_test.go`) lists
every input, each column and each insert and delete, and
`TestEveryGateInputReachesThePoll` commits each one against a real database and
checks that the next poll, not the backstop, closes the connection. The one
clock read, `locked_until > now()`, only ever lifts a lock, so it needs no
trigger; the pass-through maximum age (below) is the front's own clock.

⚠ **The poll reads by snapshot, not by id.** Ids and transaction ids are
assigned before commit, so a transaction that commits after a later one lands
below what a reader has already passed, and "id greater than the last one" loses
it for good. Each poll is one statement that returns the rows of every
transaction not yet visible in the previous poll's snapshot, and the current
snapshot for the next poll (`projection.AccessChanges`). "Not visible in
`prev`" is exactly "at or above `prev`'s xmax, or in its in-progress list", so
the statement is `txid >= pg_snapshot_xmax(prev)` UNION ALL `txid = ANY
(pg_snapshot_xip(prev))`: one index range scan from xmax plus one index lookup
per transaction that was in progress. (Written as an OR, it was planned as a
sequential scan of the whole log.) Visibility only grows from one snapshot to
the next, so each committed change is returned exactly once, however late it
commits (`TestAccessChangesReturnsALateCommitOnceItCommits`). A long writing
transaction elsewhere holds xmin back but not xmax, so it costs each poll one
more lookup, not a re-read of everything committed since it began. This is one
statement through PgBouncer in transaction mode, with no LISTEN, no session state
and no prepared statement.

⚠ **Transaction ids that go back are caught, not read past.** After a
point-in-time restore, or a failover to a replica that had not replayed
everything, the server hands out ids below the previous snapshot's xmax again,
and a snapshot test would call each of them already seen. The same statement
compares the server's current xmax with the previous one and also returns
`pg_postmaster_start_time()`, which the poll keeps next to the snapshot so a
promoted lagging replica is still caught even after new commits push its xmax
past the old one. When xmax went back or the server start time changed, the
poll asks for a full sweep, starts again from the current snapshot and start
time, and logs it (`TestAccessChangesReportsTransactionIDsThatWentBack`).

⚠ **Every connection that signed in since the last poll is re-checked, whatever
the log says.** Its row was read at sign-in, before it was registered with the
sweeper. A revocation that commits between that read and the registration can
be read by a poll that runs in between, when the connection is not there to be
matched, and no later poll returns it again. So each registration gets a
sequence number, and the first poll whose registry snapshot holds it re-checks
it with a row read taken after that poll's log read: a change committed before
that row read is in the row, and one committed after it was not visible to the
log read either, so a later poll returns it. `TestAPollRechecksAConnectionThatSignedInDuringAChange`
(and its `OnTheDatabase` twin) pin it, and both fail without the rule.

**When the poll cannot tell whom a change names.** A `TRUNCATE` (kind `all`), a
kind this front does not know, more than 10,000 changes in one read
(`DefaultMaxChanges`), a position older than ten minutes (after a long outage),
transaction ids that went back, or a changed database start time
(`pg_postmaster_start_time()`, a restart, restore or failover) make the poll
ask the sweep loop for a full
sweep, logged at WARN. It re-checks nobody itself: it advances its position and
polls again at its normal interval, so a burst does not hold the next targeted
revocation back by the seconds a full sweep takes at 50,000 accounts. The
request is one slot (a channel of one), so requests made before the sweep loop
takes one are the same request and nothing queues. ⚠ The sweep that answers it
re-checks every connection with a row read after the poll's log read: the poll
asks after its log read, and the sweep loop takes the request before the pass
that answers it starts, so that pass's registry snapshot and row read both come
later; a request made while a sweep is already running stays in the slot and
starts another sweep after it (`TestAFullPollIsAnsweredByASweepThatStartsAfterIt`).
A requested sweep still waits out the duty cycle below and at least one poll
interval after the previous sweep, and one that fails asks again at that pace.
With no connection open, the poll reads nothing and forgets its position: the
next connection is new, so nothing before it matters.

**The position moves only after the re-check has read the rows**, or once the
poll has asked for a full sweep. A failed read of the log or of the accounts
leaves it, and the next poll reads the same changes again. Re-checks are
idempotent.

**Pruning.** Rows live an hour. `authd.prune_access_changes()`, a `SECURITY
DEFINER` function whose one-hour cutoff is fixed inside it, deletes older rows
at most 10,000 a call, and the hourly retention job (`apps/api/src/retention.ts`,
step 0, as `i10_api`) calls it until a call returns 0 (up to 100 calls per run). It is the retention
job and not the front because the triggers write the log wherever the API
writes, whether or not a front runs to read it, and it keeps the `mailfront`
role free of any write. The front needs a row for about a second, and re-checks
everyone after ten minutes without a successful read, so nothing it reads is
that old. Rows are deleted by id below the oldest row of the last hour, so a
prune reads only what it deletes. Neither the API nor authd may write or delete
the log; only the triggers and the prune do.

⚠ **The prune's remaining window.** A row's `at` is its transaction's start
(`now()`), and its id is taken when it is written, not when it commits. A
transaction that writes a gate table more than an hour before it commits, and
commits in the second before an hourly prune, can have its rows deleted before
the next poll reads them. Its revocation then waits for the backstop, at most a
minute. Nothing on a request path keeps a transaction open that long.

**A change to pass-through.** Whether a managed account's connection still has
pass-through on, and where it asks, is the API's answer behind
`AUTHD_API_SECRET`, which the front must not hold. It reaches the front and authd
through two numbers, both moved in the transaction of the change itself, by one
function (`mirrorPassthrough` in `apps/api/src/identity/authd-mirror.ts`):

- the connection's version (`authd.passthrough_versions`), which the bind reads
  with the account. authd's copy of the settings, kept up to a minute, is
  fetched again at the first bind that read a newer version, on every pod, and
  an answer older than the bind's version is never used. So no sign-in after a
  change is checked against the settings it replaced;
- the `credential_epoch` of every account the connection manages, which ends
  authd's cached successes and makes the sweep close the open sessions.

`mirrorPassthrough` hashes exactly what `passthroughFor` answers from: whether
the connection is active, whether a live proof backs it, its provider, its
`ldap` and `oidcMail` settings and its sealed secrets. It runs from every change
that can move any of those: the LDAP and OIDC console routes (through
`setConnectionSecrets`), any connection update (status included), and
`mirrorRequiredDomains`, which already ran on every domain attached or detached
and every proof lapsing, coming back or being displaced. Where the hash moved,
both numbers move. A change to anything else (a rename, a SAML metadata
refresh) moves neither. Before this, the API raised the epochs after the commit
and again a minute later from a timer, and a failure or a restart in between
left the sessions open for good. `test/passthrough-mirror-db.test.ts` covers
every path, and that a rolled-back change takes its raise with it.

**A revocation i10 cannot see is bounded by a maximum age.** A person disabled
or given a new password in their company's own directory (the LDAP lane), or at
an OIDC provider that sends neither Universal Logout nor SCIM, never reaches a
row, so no sweep can see it. A session signed in through a pass-through lane is
therefore closed `MAILFRONT_PASSTHROUGH_MAX_AGE` after sign-in (default 15
minutes, the OIDC lane's success cache, so both lanes share one bound; 1 minute
to 24 hours, with no "off"), logged as `passthrough_max_age`. The client signs in
again with the password it saved, and the directory is asked again. Each session
ends at a random point in the last tenth of the age, never after it, so clients
that signed in together do not all come back together. A Clerk-routed session is
not affected, because a Clerk change moves `clerk_updated_at`, which the sweep
already watches. The check needs only the clock, so both the poll and the
sweep run it first, before any query, and hold it during a database outage too: an expired
pass-through session is closed even when nothing else can be.

**A device session has a maximum age too: 24 hours, plus up to an hour at
random** (`DeviceMaxAge`, `DeviceMaxAgeJitter`), logged as `device_max_age`.
Not for revocation, which reaches the row: so that a device in use re-binds at
least daily and moves its `last_used_at`. An iPhone in push can hold one IMAP
session for weeks, and without this its device would look idle to the 90-day
prune while in use. The pass-through maximum age never applies to a device
session, even on a managed account: the code is i10's, checked by authd.

What it costs (measured 2026-11-22: 1.033 sign-ins per connection per max-age
period, against the 1.026 the jitter predicts, with clients that reconnect at
once). At 15 minutes that is about 4.2 reconnects an hour per open connection.
On the LDAP lane each one is a directory sign-in (a service bind, a search and
the person's bind), since authd caches no LDAP success. On the OIDC lane the
credential cache answers the person's other connections, so it is about 4 token
calls an hour per person, however many connections they hold.

| Client (open IMAP connections, typical) | Reconnects / hour | LDAP directory sign-ins / hour | OIDC token calls / hour |
| --------------------------------------- | ----------------- | ------------------------------ | ----------------------- |
| iPhone Mail, push on (1)                | 4.2               | 4.2                            | about 4                 |
| Apple Mail on a Mac (3)                 | 12.6              | 12.6                           | about 4                 |
| Thunderbird (5, its default cache)      | 21                | 21                             | about 4                 |

The connection counts are typical figures, not measured here. A thousand people
on Apple Mail through one company's LDAP is about 3.5 directory sign-ins a
second on top of the clients' own reconnects. A company that finds that too
many can raise the age, which widens the window instead.

**Not covered: JMAP and webmail on 8080.** They reach Stalwart directly, not
through the front, so they carry no bind token and every person sign-in there
is refused. Webmail stays off until the Bulwark JMAP proxy lands (a later PR,
which also has to end sessions: Stalwart caches an HTTP Basic sign-in for up to
an hour, see "Outside the token design" above). The API's own JMAP calls use
an `x:ApiKey` bearer and never bind to authd, so they are unaffected.

**If the database cannot be read, nothing is closed.** Closing every connection
when the database blinks would disconnect every client at once, into an authd
that cannot verify them either. A revocation made during the outage is still in
the rows, and the first poll or sweep that can read them closes the connection
(the poll's position has not moved, so it reads the same changes again). Each
loop logs this at ERROR on its first failure and every minute after, with how
long it has lasted.

**A slow pass waits longer; it never runs back to back.** In each loop, at
least five times the last pass's query time goes by before the next pass, so
each loop keeps a database backend busy at most a sixth of the time (T busy,
then 5T idle). The query time is the database's own: the front acquires a pooled
connection first and times only the statement, so a reconnect storm that holds
all of `pool_max_conns` does not stretch the interval while the database is
idle. The
backstop keeps its minute until one full sweep takes more than 12 seconds; the
poll keeps its second until a poll and its re-check take more than 200 ms. The
cost is a longer window, logged at WARN. The query timeout is 30 s, because a
pass that times out closes nothing; it guards a hung query, not a large one.

**A revoked connection gets no goodbye.** The sweep closes the TCP connection
under TLS, not the TLS one, which would first send a close_notify and wait up to
five seconds for a client that is not reading, one connection after another.

**What it costs** (measured 2026-11-24 on the 500,000-account seed; tables,
method, CSVs and plans in `docs/research/mail-device-binding.md`, "Change-driven
re-check").

- **The poll** is one index range scan of the log from the previous snapshot's
  xmax plus a lookup per transaction it listed as in progress: 2 to 4 buffers
  and under 0.4 ms in the server with 0 to 100 changes a second, whatever the
  log holds. Re-checking 100 changed accounts adds about 12 ms. At 100 changes
  a second that is 1.2% of a database core.
- **The backstop** is the old full sweep once a minute: 645 ms clustered and
  2.5 s spread at 50,000 live accounts, so 1.1% and 4.2% of a core. The 1 Hz
  sweep it replaces cost 56% and 367% there.
- **A long writing transaction elsewhere** holds the snapshot's xmin back but
  not its xmax, so it costs each poll one more index lookup: 9 buffers and
  0.05 ms with 100,000 changes committed behind one, where reading from xmin
  took 1,039 buffers and 7.4 ms.
- **The triggers** add about 0.2 ms to a single-row write of a gate table, and
  about 20 µs a row to a bulk update (10,000 accounts: 159 ms without, 364 ms
  with). An update of only ignored columns logs nothing but still pays the
  comparison (10,000 domains: 322 ms).
- **Revocation latency**: every one of the 43 paths that revokes access closed
  its connection within 882 ms of `COMMIT` (three runs each, at the production
  one-second interval). The bound is one interval plus one poll. Rerun
  2026-11-25 with the device table and `passthrough_versions.active` added:
  all 50 paths within 871 ms, the seven new ones between 168 and 871 ms.
- **The front itself** stays near 2% of a core with 10,000 idle connections;
  its limit is memory, about 61 KiB a connection.
- **Several fronts** each poll and sweep their own connections, so the database
  cost adds up across them.

**A sign-in surge is shed at accept, not queued into the database.** Measured
2026-11-22 (`front-storm-2026-11-22.csv`): 6,000 clients signing in at the
same instant, with the defaults (`pool_max_conns=4`, `MAILFRONT_MAX_PREAUTH`
2000).

- 2,000 were in within 1.1 s, none slower than that, and no lookup timed out.
  The other 4,000 were closed at accept, and clients retry.
- With the pre-auth cap raised to 6,000, every client got in, but the slowest
  sign-in took 3.1 s, at the edge of the 3 s lookup timeout.
- A pool of 8 brought that down to 2.4 s.

So the cap is what keeps the timeout safe, and both defaults stay. Refusals at
accept are logged once per 10 seconds, with a count per cap. The shutdown close
has no jitter: the node runs one Stalwart pod, so the new front is not
listening until the old one is gone, and the clients' own retry timers spread
the reconnects.

### Shutdown and failure modes

- **SIGTERM:** close the listeners and every connection. Mail clients reconnect.
- **The front dies:** 993 and 465 refuse until the kubelet restarts it. LDAP,
  port 25 and JMAP are untouched.
- **Stalwart dies:** each upstream connection ends, and the front closes the
  matching client connection.
- **The certificate or the database is not there at start:** the front waits,
  retrying with backoff from one second to thirty and logging each attempt,
  instead of exiting into a CrashLoopBackOff whose delay grows. It listens on
  nothing meanwhile, so 993 and 465 refuse.
- **The port is taken at start:** the front waits and retries every second, for
  as long as it takes. On the first rollout Stalwart still holds `[::]:993` and
  `[::]:465` until it restarts with the new listeners, and keeps serving them as
  before. Any other listen error is retried for 30 seconds and then ends the
  process with that error.
- **The bind token key is missing or broken:** see the table under "The bind
  token". Neither process exits over it.
- **No probes.** The front listens on the pod's address, so the kubelet could
  probe it, but no probe it offers is worth having. A `tcpSocket` probe on 993
  passes against Stalwart itself during the first rollout, and against a front
  whose database is down (it still accepts). A readiness probe gates the whole
  pod, so a mail-port problem would take this node's JMAP out of the
  `i10-stalwart` Service. A liveness probe would only restart a process that
  exits by itself on a fatal error. `bootstrap.sh --verify` checks that 993 and 465 are the front: both answer `STARTTLS` with the front's own words (`startTLSAnswer`), which Stalwart words differently.

### Configuration

| Variable                        | Default                      |                                                  |
| ------------------------------- | ---------------------------- | ------------------------------------------------ |
| `MAILFRONT_LISTEN_IPS`          | -                            | The pod's addresses. Never a wildcard/loopback.  |
| `MAILFRONT_IMAP_PORT`           | `993`                        |                                                  |
| `MAILFRONT_SMTP_PORT`           | `465`                        |                                                  |
| `MAILFRONT_IMAP_UPSTREAM`       | `127.0.0.1:993`              | Must be loopback.                                |
| `MAILFRONT_SMTP_UPSTREAM`       | `127.0.0.1:465`              | Must be loopback.                                |
| `MAILFRONT_TLS_CERT_FILE`       | `/etc/mailfront/tls/tls.crt` | Re-read every 30 s.                              |
| `MAILFRONT_TLS_KEY_FILE`        | `/etc/mailfront/tls/tls.key` |                                                  |
| `MAILFRONT_DATABASE_URL`        | -                            | The `mailfront` role.                            |
| `MAILFRONT_BIND_TOKEN_KEY`      | -                            | `<id>:<base64>`. Without it, no sign-ins.        |
| `MAILFRONT_MAX_CONNECTIONS`     | `6000`                       | Sized with the memory limit; raise together.     |
| `MAILFRONT_MAX_PREAUTH`         | `2000`                       | Not signed in yet. Bounds a sign-in surge.       |
| `MAILFRONT_MAX_PREAUTH_PER_IP`  | `32`                         | Per address; per /64 for IPv6.                   |
| `MAILFRONT_PREAUTH_TIMEOUT`     | `2m`                         | 10 s to 10 m.                                    |
| `MAILFRONT_SWEEP_INTERVAL`      | `1s`                         | 200 ms to 10 s. The poll: the revocation window. |
| `MAILFRONT_PASSTHROUGH_MAX_AGE` | `15m`                        | 1 m to 24 h. Ends pass-through sessions.         |
| `MAILFRONT_LOG_LEVEL`           | `info`                       | `debug` logs every sweep's timings.              |

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

**No password material anywhere.** Not a hash, not a verifier, not a salt of any
person's password - neither in the schema nor in an LDAP attribute. With
`bindAuthentication: true` Stalwart never reads a password attribute, so there
is nothing to serve. The one secret-derived value authd reads is a device code's
keyed hash (`authd.mail_devices.code_hash`, "Mail device codes" above): i10's own
secret, never a password, and never in an LDAP attribute.

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

| Variable                    | Default                    |                                                       |
| --------------------------- | -------------------------- | ----------------------------------------------------- |
| `AUTHD_LISTEN`              | `127.0.0.1:3893`           | Must be loopback.                                     |
| `AUTHD_BASE_DN`             | `dc=i10,dc=tech`           |                                                       |
| `AUTHD_SERVICE_BIND_DN`     | -                          | Stalwart's own bind, needed even in bind-auth mode.   |
| `AUTHD_SERVICE_BIND_SECRET` | -                          |                                                       |
| `AUTHD_DATABASE_URL`        | -                          | The projection. Goes through PgBouncer.               |
| `AUTHD_CLERK_SECRET_KEY`    | -                          |                                                       |
| `AUTHD_CLERK_BASE_URL`      | `https://api.clerk.com/v1` |                                                       |
| `AUTHD_CLERK_TIMEOUT`       | `5s`                       | Must be positive and at most `12s`.                   |
| `AUTHD_BINDS_PER_MINUTE`    | `30`                       | Per DN, burst equal to one minute.                    |
| `AUTHD_CRED_CACHE_TTL`      | `2h`                       | Verified passwords only. `0` disables; max `3h`.      |
| `AUTHD_API_URL`             | -                          | The API, for pass-through settings. Both or neither.  |
| `AUTHD_API_SECRET`          | -                          | Same value as the API's. 32+ characters.              |
| `AUTHD_API_TIMEOUT`         | `5s`                       | Must be positive and at most `12s`.                   |
| `AUTHD_BIND_TOKEN_KEYS`     | -                          | `<id>:<base64>`, comma list. Without, no person bind. |
| `MAIL_DEVICE_CODE_KEYS`     | -                          | `<id>:<base64>`, comma list. Without, no device bind. |
| `AUTHD_LOG_LEVEL`           | `info`                     | ⚠ `debug` logs every LDAP packet, passwords too.      |

## Layout

```
cmd/authd            entrypoint, signal handling, readiness
cmd/mailfront        the mail front's entrypoint: listeners, the sweep, shutdown
internal/config      env loading, the loopback guard, the shared logger
internal/gate        whether an account's row lets it sign in, and who answers;
                     shared by the bind, the resolver and the mail front
internal/mailfront   the TLS front: IMAP/SMTP before sign-in, PROXY v2, the scan
                     of Stalwart's output, the sweep
internal/devicecode  the mail device code: the strict parser, the keyed hash, the
                     key ring, test vectors shared with the API's minter
internal/keyring     "<id>:<base64>" key lists (bind token and device code keys)
internal/bindtoken   the front's bind token: the MAC over the person and device
internal/directory   the LDAP view: entries, DNs, filter evaluation
internal/verify      the Verifier / Resolver / BudgetStore seam, Outcome
internal/clerkauth   the Clerk verifier: verify_password and its status mapping
internal/passthrough the company verifier and ManagedResolver: settings client,
                     the lane choice, the LDAP walk
internal/oidc        the OIDC password grant: the preset table, validation, the
                     vetted dial, the answer mapping (oidctest is its fake
                     endpoint, with one fixture per preset)
internal/egress      which addresses authd may connect to for a tenant
internal/credcache   verified-password cache and the remembered refusals
internal/inflight    one verification for concurrent identical binds
internal/budgetstore the shared failure budget in Postgres
internal/projection  the Clerk read model (Store interface + Postgres)
internal/ldapsrv     Bind and Search handlers, and the device code lane
internal/throttle    per-DN token bucket
```

```bash
go test -race ./...
```

## The schema lives elsewhere

authd is a **reader**, with a few narrow writes: the shared failure budget
(`authd.bind_failure_budget`), a mail device's two clock stamps
(`first_used_at`, `last_used_at` on `authd.mail_devices`, by column grant), and
the Mac liveness rows (`authd.mail_device_cert_binds`, #383 PR 3). The
`authd.*` tables are defined in Drizzle at
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
