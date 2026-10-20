# SSO, SCIM and the rest of enterprise identity, on our own layer

**Status:** APPROVED 2026-10-19. Every decision in Part 6 is settled (plans
deferred on purpose) and the build plan in Part 7 is approved; each step has
its own GitHub issue (listed in Part 7). Engine A, L1 through our gateway at
`clerk.i10.tech`, SAML from the start.

Facts gathered earlier are in `docs/research/sso-findings.md`. Anything inferred
rather than read or probed is marked **(inferred)**. Anything that needs a probe
on the dev instance before we rely on it is marked **(probe Pn)**.

---

## Fixed by the user

- Clerk stays the auth layer: users, sessions, passwords, passkeys, 2FA,
  organizations, memberships, invitations.
- The 20-member cap is accepted until we buy Clerk's $100/mo B2B add-on, and so
is $1/mo per retained organization past 100. Memberships stay in Clerk.
- **No Clerk enterprise connections and no Clerk Directory Sync.** SSO, SCIM,
  JIT and everything around them are ours. No $75/$60 per connection, ever.
- Self-serve (the customer sets it up in our console) AND team-served (our staff
  set it up for them). We own every UI.
- The bar: as safe and as complete as Clerk or WorkOS, and better where owning
  the layer lets it reach the rest of i10 (mail, domains, capacity, webhooks).
- The protocol engine is open: our own SP, Better Auth, or another. Weighed in
  Part 4.

---

## Part 1. Clerk's API, read end to end

Read 2026-10-19 from Clerk's published OpenAPI specs (`clerk/openapi-specs`,
latest version `2026-08-20`, last updated 2026-10-16): **256 Backend API
operations in 41 groups and 214 Frontend API operations.** Our SDK is
`@clerk/backend` 3.17.1; the latest is 3.25.0 (2026-10-16). Neither types
every parameter below, so a few calls need a raw request.

### 1.1 What helps us build this

| Endpoint                                                                                                                                                                                                                         | What it gives us                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /sign_in_tokens` (`user_id`, `org_id`, `expires_in_seconds`, `**second_factor_verification**`: `fresh` or `stale`)                                                                                                         | The bridge from our SSO to a Clerk session. `org_id` opens the right workspace. **Probed (P1): `fresh` completes sign-in for a user with TOTP and the session reads `fva [0,0]`; `stale` completes and reads `[0,99999]`; without it the sign-in stops at `needs_second_factor`.** Present since spec `2025-11-10`, missing from both SDK versions' types, so it is a raw call. This replaces the earlier finding that a ticket "does not skip 2FA": that was true of the call we made, not of the API |
| `POST /sign_in_tokens/{id}/revoke`, token status `pending`, `accepted` or `revoked`                                                                                                                                              | Kill an unused token. There is no GET for a token (404), so "was it redeemed" is answered by the session, not the token                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /sessions`                                                                                                                                                                                                                 | **Not usable:** "intended only for use in testing, and is not available for production instances"                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /sessions?user_id=&status=`, `GET /sessions/{id}`, `POST /sessions/{id}/revoke`                                                                                                                                             | List and revoke a person's sessions (deprovisioning, IdP logout, per-workspace lifetime). Session carries `actor`, `last_active_organization_id`, `tasks`                                                                                                                                                                                                                                                                                                                                              |
| `GET /sessions/{id}/reverifications/{rid}`                                                                                                                                                                                       | Server-side check of a reverification: real, for this session, completed, and when each factor was verified. Replay detection is ours. A better primitive than reading `fva` for step-up                                                                                                                                                                                                                                                                                                               |
| `POST /sessions/{id}/tokens/{template}`, `/jwt_templates`                                                                                                                                                                        | Short-lived tokens with our claims, e.g. a `managed` flag from `public_metadata` so the gate can skip a lookup for unmanaged people                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /clients/{id}` (`last_authentication_strategy`)                                                                                                                                                                             | Which strategy last authenticated a client. **Probed (P4): `ticket` after a sign-in token, `email_code` after an email code.** A clean sweeper signal: a managed account whose client says anything but `ticket` was not us                                                                                                                                                                                                                                                                            |
| `POST /users` with `skip_password_requirement`, `external_id`, `email_address_identification_status`, `delete_self_enabled`, `create_organization_enabled`, `create_organizations_limit`, `banned`, `locked`, `private_metadata` | SCIM and JIT create real Clerk users with no password, our ids, self-delete off and org creation limited, per user                                                                                                                                                                                                                                                                                                                                                                                     |
| `PATCH /users/{id}` (same flags)                                                                                                                                                                                                 | Turn self-delete off when an account becomes managed                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /users/{id}/remove_password` (`sign_out_of_other_sessions`)                                                                                                                                                                | Strip a password from a managed account                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `DELETE /users/{id}/external_accounts/{id}`, `/passkeys/{id}`, `/totp`, `/mfa`, `/backup_code`                                                                                                                                   | Strip every other credential                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `POST /users/{id}/ban`, `/unban`, `/lock`, `/unlock`, `POST /users/ban` (bulk)                                                                                                                                                   | Deactivate a managed account everywhere (ban revokes all sessions)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PUT /users/{id}/email_address` (`identification_status`: `verified`, `reserved` or `unverified`)                                                                                                                                | Replace a person's email when the IdP renames them. **Probed (P3): with the address `reserved`, password and email-code sign-in still work, a ticket works, `verify_password` works, and another sign-up with that address gets `form_identifier_exists`.** So `reserved` locks the address against others but does NOT lock the owner out of any method. Not an enforcement tool                                                                                                                      |
| `POST /email_addresses` (`verified`, `primary`)                                                                                                                                                                                  | Add IdP-sent aliases as verified addresses                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /users` filters (`external_id`, `email_address`, `organization_id`, `last_active_at_*`, `banned`)                                                                                                                           | Matching and reporting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Organization memberships CRUD with `role` and `public_metadata`/`private_metadata`                                                                                                                                               | JIT and SCIM membership, with `source: scim`, directory id and so on on the membership itself                                                                                                                                                                                                                                                                                                                                                                                                          |
| `/organization_roles`, `/organization_permissions`, `/role_sets`                                                                                                                                                                 | Custom roles (an IT-admin role), and roles WITHOUT Clerk's system permissions (see 1.3)                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /actor_tokens` (`actor`, `session_max_duration_in_seconds`)                                                                                                                                                                | Staff impersonation for team-served setup and support. **Probed on dev (P5): the actor ticket signs in, the session's `actor` and the token's `act` both carry `{ sub: <staff user> }`, `fva [0,0]`.** Whether our production plan includes it is not checked                                                                                                                                                                                                                                          |
| `/blocklist_identifiers`, `PATCH /instance/restrictions`                                                                                                                                                                         | **Probed (P2): not an enforcement tool.** `allowlist_blocklist_disabled_on_sign_in` is `true` and Clerk refuses to change it ("isn't allowed to be set for this instance"), so the blocklist applies to sign-up only: a blocklisted user still signed in by email code, by ticket, and kept refreshing an older session. Restrictions were restored afterwards                                                                                                                                         |
| `POST /users/{id}/verify_password`, `/verify_totp`                                                                                                                                                                               | Unchanged role in authd                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /jwks`                                                                                                                                                                                                                      | Unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### 1.2 Clerk's own enterprise features, read as a parity checklist

We are not using these, but their parameters list what a complete product has.
Each row is matched in Part 2.

| Clerk feature                                                                                          | Parameters worth copying                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/enterprise_connections`                                                                              | providers `saml_custom/okta/google/microsoft`, `oidc_custom`, `oidc_github_enterprise`, `oidc_gitlab`; several `domains`; `sync_user_attributes` on sign-in; `**disable_additional_identifications**` (a managed person cannot add other emails); `custom_attributes` mapped from SSO or SCIM; enabling removes overlapping org domains |
| `/enterprise_connections/{id}/test_runs`                                                               | Test runs: a short-lived URL that starts the IdP flow, and a list of past runs with status                                                                                                                                                                                                                                              |
| `/scim_directories`, `/directories`                                                                    | One directory per connection, `attribute_mapping`, `group_role_mappings` with precedence, `rotate_api_key` with a grace period, `enabled`                                                                                                                                                                                               |
| `/sso_bypass_allowlist_users` (backend and org-level frontend)                                         | Break-glass: listed users "may verify an email code instead of reaching their identity provider when enterprise SSO is unreachable"                                                                                                                                                                                                     |
| `/admin_portal_link_tokens` (`organization_id`, `it_contact_id`, `scopes`, expiry, revoke with reason) | Setup links for the customer's IT contact, scoped and revocable                                                                                                                                                                                                                                                                         |
| Org domain `enrollment_mode: enterprise_sso`, `verify_ownership` (manual override, audited)            | Staff can mark a domain verified, with an audit event                                                                                                                                                                                                                                                                                   |

### 1.3 What a Clerk session can do at Clerk without passing through us

The Frontend API is reachable with any session. These are the routes that matter
for a managed account, and the answer to each:

| Frontend API                                                                                                                                                                           | Risk                                                                                                                                                                    | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/client/sign_ins` with `email_code`, `email_link`, `password`, `passkey`, `oauth_*`, `google_one_tap`, `reset_password_code`, `trusted_device`                                | A Clerk session that skipped the IdP                                                                                                                                    | Not usable in i10 (the gate, Part 2.2). Revoked by the sweeper. Clerk itself will not refuse it: neither the blocklist (P2) nor a `reserved` email (P3) stops these strategies. Only removing the browser's access to Clerk does (1.4)                                                                                                                                                                                                                                                                                                                             |
| `POST /v1/me/change_password`                                                                                                                                                          | A second secret; `verify_password` would answer for IMAP                                                                                                                | `user.updated` → `remove_password`. authd never asks Clerk for managed accounts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /v1/me/email_addresses`, `PATCH /v1/me` (primary)                                                                                                                                | Identity drifts from the IdP                                                                                                                                            | Revert on `user.updated`; the link is `(connection, subject)`, never email                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST /v1/me/external_accounts`, `/passkeys`, `/totp`, `/backup_codes`                                                                                                                 | Other sign-in methods                                                                                                                                                   | Removed on link and on webhook; hidden in our UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DELETE /v1/me`                                                                                                                                                                        | Account deleted under the company                                                                                                                                       | `delete_self_enabled: false` per managed user                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /v1/organizations`                                                                                                                                                               | A managed person makes side workspaces                                                                                                                                  | `create_organization_enabled` per policy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `DELETE /v1/me/organization_memberships/{id}`                                                                                                                                          | Leaves the company workspace                                                                                                                                            | A normal leave; SCIM shows the conflict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `POST /v1/organizations/{id}/invitations`, `/memberships`, `PATCH .../memberships/{user}`, `DELETE .../memberships/{user}`, membership requests, `update_enrollment_mode`, org domains | **An org admin can add, remove and re-role members directly at Clerk, skipping our waiting list, block list and SCIM ownership.** This exists today, independent of SSO | **Probed (P6):** a member without Clerk's system permissions gets `403 missing_organization_permission` at the Frontend API for invite, remove, re-role and rename; an `org:admin` gets 200 for the same invite. So roles without `org:sys_memberships:manage`, `org:sys_domains:manage` and `org:sys_profile:`* make our API (backend API) the only way to change memberships. Today's roles are the defaults `org:admin` / `org:member`. The system permissions are `sys_domains`, `sys_memberships`, `sys_profile`, `sys_entconns`, `sys_billing` (read/manage) |
| `POST /v1/client/sessions/{id}/verify/*`                                                                                                                                               | Clerk reverification for a person with no password and no 2FA                                                                                                           | Our IdP step-up instead (Part 2.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### 1.4 Can we be the only layer people ever talk to?

The user's goal (2026-10-19): nobody interacts with Clerk directly, no Clerk UI,
no Clerk session we did not make. Everyone talks to i10; i10 talks to Clerk.

**What removing `accounts.i10.tech` does and does not do.** It removes Clerk's
hosted Account Portal, a UI. It does not remove the Frontend API, which is what
every table in 1.3 is about and what our own `apps/auth` calls from the browser
through clerk-js today. Checked 2026-10-19:

- `clerk.i10.tech` is a CNAME to `frontend-api.clerk.services` and
  `GET https://clerk.i10.tech/v1/environment` answers 200. Anyone can call it.
- `**accounts.i10.tech` is still published**: Cloudflare's authoritative
  nameserver (`byron.ns.cloudflare.com`) answers `CNAME accounts.clerk.services`,
  and the host answers 403. If the record was meant to be gone, it is not.

So there are three levels:

| Level                             | What the browser can reach                                                               | What it takes                                                                                                                                                                                                                                                                                                                                                                                                                                          | What we lose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L0, today**                     | Clerk's whole Frontend API at `clerk.i10.tech`                                           | Nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                | Nothing; but every row in 1.3 needs a gate, a sweeper or a webhook                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **L1, filtered proxy**            | Only the Frontend API paths we allow, through our own domain (`auth.i10.tech/__clerk/`*) | Clerk's FAPI proxy: our server forwards to `frontend-api.clerk.dev` adding `Clerk-Proxy-Url`, `Clerk-Secret-Key` and the real client IP in `X-Forwarded-For`; supported for dev and prod; prod needs the domain's `proxy_url`. Then delete the `clerk.i10.tech` CNAME. Our proxy allows the sign-in, session and token paths our UI uses and refuses the rest (`/v1/me/change_password`, email and external-account adds, org admin routes, and so on) | Little: clerk-js keeps working for what we allow                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **L2, Clerk behind our API only** | Nothing of Clerk. The browser holds only an i10 session cookie                           | Our API runs every sign-in step on the Backend API: `verify_password`, `verify_totp`, email codes through `POST /email_addresses/{id}/prepare_verification` and `attempt_verification` (documented by Clerk "for example, in a custom, backend-driven sign-in flow"), `createUser`, `updateUser` for password resets, org and membership calls. Our own session store and cookies. Our own Google/GitHub OAuth and our own WebAuthn passkeys           | Clerk's sessions, `fva`, reverification, `has()`, clerk-js; Clerk's passkeys and social links (no Backend API verifies a passkey or creates an external account, so both become ours; moot today, since i10 has no real users yet); Clerk's sign-in bot protection and lockout (`verify_password` does not lock out, so throttling password guesses becomes ours, as authd already does for IMAP). Only L2 has this cost: under L0 and L1 the browser still signs in at Clerk, and Clerk keeps rate-limiting it |

**L1 at the same name: `clerk.i10.tech` points at us (proposed 2026-10-19 by
the user).** Instead of a new path, we keep the hostname clerk-js already uses
(it is encoded in our publishable key) and point its DNS at our own gateway, so
every Frontend API request reaches us first:

- Pass-through for what Clerk should handle: forward to `frontend-api.clerk.dev`
  with `Clerk-Proxy-Url: https://clerk.i10.tech`, `Clerk-Secret-Key` and the
  browser's real IP first in `X-Forwarded-For` (from `CF-Connecting-IP`, never
  from the forwarded header the CDN passes on, per Clerk's guide).
- Refuse what nobody should do at Clerk directly: the 1.3 routes (password
  changes, adding emails or social accounts, org admin calls).
- **Act differently where we want to.** For example: a sign-in attempt whose
  identifier is a managed account gets "use your company's SSO" instead of an
  email code; a ticket sign-in is the only way in for those accounts; every
  response can be logged or audited. This is the Clerk-side enforcement P2 and
  P3 showed Clerk will not give us, enforced by us at the door.
- Register it with `PATCH /domains/{id}` `proxy_url` (production instances
  only; "the full URL of the proxy", the example being a path, so a whole
  hostname as the proxy is **(inferred to be accepted; `POST /proxy_checks`
  validates it before switching, without downtime)**).

What it changes:

- The sweeper and most of 1.3 become a backstop rather than the defence; the
  gate in our API stays (defence in depth).
- **We are on the critical path for every sign-in and token refresh.** clerk-js
  refreshes the session token about every minute, so the gateway needs the
  availability of the API itself, and Clerk's outage rules (answer
  "unavailable", never "signed out") apply to it too.
- Clerk's cookies, redirects and handshake now run through our host; the
  gateway must pass `Set-Cookie`, redirects and bodies through untouched apart
  from what it deliberately blocks.
- The dev instance cannot be proxied (`proxy_url` is production-only; its
  Frontend API is fixed at `*.clerk.accounts.dev`), so the gateway is tested
  against dev by pointing it at the dev Frontend API, and the switch itself is
  proven only on production.

**What it still leaves open (P8).** Whether Clerk keeps serving
`clerk.i10.tech` traffic that reaches its edge some other way, for example a
client that resolves `frontend-api.clerk.services` itself and sends
`Host: clerk.i10.tech`, while Clerk's old certificate for the name is still
valid. Once the DNS points at us, Clerk cannot renew that certificate, so the
window should close **(inferred)**. Ask Clerk support before relying on it.

**What L2 changes for SSO.** Almost everything in the hard part disappears. There
is no Clerk session in the browser, so no sign-in token, no handoff code, no
bind, no sweeper and no 1.3 table: our SSO callback creates an i10 session like
every other sign-in. Step-up, session lifetime, IdP logout and "managed accounts
sign in only through their IdP" become plain rules in our own session code.
Clerk becomes the user directory, credential checker and organization store.

**What L2 costs.** It is a rewrite of the sign-in and session layer we built on
Clerk sessions: `apps/auth`'s flows, saved-account resume, the step-up dialog,
`requireUser` / `requireTenant` (verify our cookie instead of a Clerk JWT), the
console's Clerk hooks. It is its own project, before or alongside SSO, not a
step inside it. One thing to check before choosing it: how Clerk counts monthly
retained users when no session is ever created through its Frontend API, and
whether its terms say anything about backend-only use **(not checked)**.

**Where it lands.** The user's gateway idea is L1, built at the same hostname,
not a third level: same mechanism (Clerk's Frontend API proxy), but nothing
changes for clerk-js and every request reaches us first. i10 is greenfield (no
real users), so neither level carries a migration cost. Both keep Clerk as the
user and org store.

### 1.5 L1 (our gateway) vs L2 (Clerk behind our API), weighed

Scores 1 (poor) to 5 (best) **(judgement)**:

| Criterion                             | Weight | L1 gateway                                                                    | L2 Clerk behind API                                                           |
| ------------------------------------- | ------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Meets "nobody talks to Clerk but us"  | 5      | 4 (every request passes us; the browser still holds a Clerk session; P8 open) | 5 (the browser never sees Clerk)                                              |
| Strength of SSO enforcement           | 5      | 4 (refused at the door and at our API)                                        | 5 (no Clerk session exists to misuse)                                         |
| SSO design complexity                 | 4      | 3 (ticket, handoff, bind; sweeper as backstop)                                | 5 (the callback makes an i10 session)                                         |
| Build cost now                        | 4      | 4 (a small gateway; apps/auth flows stay)                                     | 2 (new session layer, sign-in flows, OAuth, passkeys, step-up, throttling)    |
| Security-critical code we own forever | 4      | 4 (Clerk keeps sessions, password and bot protection)                         | 2 (sessions, cookies, CSRF, brute-force throttling, WebAuthn, OAuth all ours) |
| Availability                          | 3      | 3 (gateway in the path of every token refresh, about once a minute)           | 4 (Clerk only in the path of sign-ins)                                        |
| Value from what we pay Clerk          | 3      | 5 (sessions, `has()`, reverification, client trust, bot protection)           | 2 (Clerk shrinks to a user and org database)                                  |
| Reversibility                         | 2      | 5 (unset `proxy_url`, restore the CNAME)                                      | 2                                                                             |
| Open unknowns                         | 3      | 3 (P8; a whole hostname as `proxy_url` is inferred)                           | 3 (how Clerk counts retained users with no frontend sessions; its terms)      |
| **Weighted total (of 165)**           |        | **127**                                                                       | **117**                                                                       |

**Decided 2026-10-19 by the user: L1 through the gateway, default-deny.** It
gets nearly all of L2's control (we see, refuse or rewrite every request) while
Clerk keeps doing the session and credential work we pay it for. L2 turns Clerk
into a database, and if Clerk is only a database, the honest next question is
why Clerk at all, which contradicts the constraint to keep it.

What the gateway does:

- **Allowlist, default deny:** only the Frontend API paths our UI and Clerk's
  server-side handshake use pass. Everything else gets a 404 from us and never
  reaches Clerk.
- **Managed accounts at the door (wired by #337):** a sign-in whose identifier
  is a managed account gets "continue with your company's SSO"; for them, only
  a ticket passes, and the self-service account routes are refused.
- **Never at Clerk directly:** organization creation (ours since #335), org
  admin routes, account deletion.
- **Logged:** every request, with the real client IP, nothing secret.
- **Outage rule:** Clerk unreachable is a 503, never "signed out".
- Our API's own gate stays, so a gap in the gateway is not a gap in i10.

**Where it runs, decided 2026-10-20: a Cloudflare Worker** on `clerk.i10.tech`
(`services/clerk-gateway`), over a Bun service on psl-vps or a route in
`apps/api`. It does not depend on our cluster, it reads the real client IP from
`CF-Connecting-IP`, and it is faster: Clerk's Frontend API is itself behind
Cloudflare (`frontend-api.clerk.services` → `worker.clerkprod-cloudflare.net`),
so a Worker adds only its own execution, while a cluster service adds the trip
from Cloudflare to psl-vps and back on every request. Measured from one
location on 2026-10-20 (median of 5, Cloudflare's Palermo edge):
`clerk.i10.tech` first byte about 180 ms, `api.i10.tech` (edge to cluster)
about 320 ms. That matters because every signed-in browser refreshes its
session token through the gateway about once a minute. Only sign-in attempts
will consult our API (the managed-account check, #337), with a short cache.

**The question for Clerk support (P8), to send before the switch:**

> We plan to run Clerk's Frontend API through our own proxy at
> `https://clerk.i10.tech` (production instance, `proxy_url` set to that URL)
> and point the `clerk.i10.tech` DNS record at our proxy instead of
> `frontend-api.clerk.services`.
>
> 1. Is a whole hostname accepted as `proxy_url`, or must it be a path on the
>    application's domain?
> 2. Once `proxy_url` is set, does Clerk refuse Frontend API requests for our
>    instance that do not come through the proxy (no `Clerk-Proxy-Url` and
>    `Clerk-Secret-Key`)? For example, a client that connects to
>    `frontend-api.clerk.services` directly with `Host: clerk.i10.tech`.
> 3. What happens to Clerk's certificate for `clerk.i10.tech` after the DNS
>    moves, and is there any other hostname that serves our instance's Frontend
>    API?
> 4. Do Clerk webhooks, sign-in tokens, actor tokens and OAuth callbacks keep
>    working unchanged through the proxy?

**When to revisit L2:** if Clerk support says it keeps serving
`clerk.i10.tech` in a way we cannot close (P8), or if the gateway ends up
overriding most of Clerk's behaviour anyway.

---

## Part 2. The core, whichever engine we pick

Everything in this part is ours in every option. The engine (Part 3) only
changes who verifies the SAML/OIDC response and who speaks SCIM.

### 2.1 Sign-in bridge

1. **Email first** on `apps/auth`. Our API answers "is this address on an

   SSO-required domain?" (home realm discovery). If yes, only "Continue with
   Acme SSO" shows. Also a per-workspace URL (`/sso/acme`) and IdP tiles
   (IdP-initiated).

2. **Start:** a login attempt row (state, nonce, PKCE verifier or SAML request

   id, connection, return path, hash of a browser-binding cookie), then the
   redirect.

3. **Callback:** the engine verifies the response; we check the attempt is

   unused, unexpired and bound to this browser, and get `(connection, subject,  email, attributes, groups, auth_time, amr/acr, idp_session)`.

4. **Resolve** (2.3): existing link, pre-provisioned SCIM user, JIT, or refuse.

   Never an email-only match unless that workspace verified the domain.

5. **Membership:** join or keep, role from group rules, capacity from #327.
6. **Mint** a sign-in token: `expires_in_seconds: 60`, `org_id`,

   `second_factor_verification: fresh` (proven in P1). Store its id. Give the browser a
   one-time handoff code, not the ticket.

7. `apps/auth` swaps the code (POST, same browser cookie) for the ticket and

   calls `signIn.ticket()`.

8. **Bind:** `POST /sso/bind` with the new session JWT and the handoff secret.

   We check the user matches, the token is `accepted`, the session is newer
   than the token, the handoff unused; then write `sso_sessions(sid, user,  connection, idp_session, auth_time, bound_at)`.

### 2.2 Enforcement, three layers

1. **UX:** discovery hides every other method for managed addresses.
2. **The gate (the real one):** `requireUser` / `requireTenant`: for a managed

   account, the request's `sid` needs a live `sso_sessions` row on a still
   enabled connection, else `403 sso_required` with the start URL. Covers every
   console and API route; authd applies the same rule to mail (2.8).

3. **The sweeper:** on `session.created` for a managed account, no bind within

   2 minutes → `revokeSession`. Limits what an unbound session can do in 1.3.

4. **No fourth layer at Clerk.** P2 and P3 ruled out the blocklist and

   `reserved` emails. The only stronger layer is cutting the browser off from
   Clerk (1.4, L1 or L2). Under L2 this whole section collapses into "our
   session code refuses a non-SSO sign-in for a managed account".

All of 2.1 and 2.2 assumes L0 or L1. Under L2 the bridge is one step: the SSO
callback creates an i10 session.

### 2.3 Identity model

New schema `identity` (Drizzle, generated migrations, RLS by tenant):

| Table                                                                                             | Holds                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connections`                                                                                     | per workspace: protocol, provider preset, status (draft, testing, active, disabled), config, encrypted secrets, enforcement mode, JIT, MFA requirement, session policy, attribute mapping |
| `connection_domains`                                                                              | access domains (#326) the connection covers; FK to the proof, so displacement disables SSO for that domain                                                                                |
| `saml_certificates`                                                                               | several per connection, `not_after`, for rotation and alerts                                                                                                                              |
| `identities`                                                                                      | `(connection, subject)` → Clerk user id, unique. The only identifier after first link                                                                                                     |
| `login_attempts`, `test_runs`                                                                     | short-lived attempts; test runs kept with raw claims for the setup screen                                                                                                                 |
| `sso_sessions`                                                                                    | `sid` → connection, idp session, auth_time, bound_at, fresh_at, last_seen                                                                                                                 |
| `managed_accounts`                                                                                | Clerk user → controlling workspace, and why (SCIM, JIT on a verified domain, claimed)                                                                                                     |
| `directories`, `directory_users`, `directory_groups`, `directory_memberships`, `group_role_rules` | the directory as the IdP sent it, and group → role with precedence                                                                                                                        |
| `bypass_users`                                                                                    | break-glass list per connection (Clerk's SSO bypass, ours)                                                                                                                                |
| `setup_links`                                                                                     | hashed token, scopes, IT contact, expiry, revoked reason                                                                                                                                  |
| `events`                                                                                          | identity audit log                                                                                                                                                                        |

**Managed accounts.** A Clerk user on a domain the workspace verified, created
by its SCIM or JIT or claimed by it. Cannot change email (Clerk's
`disable_additional_identifications`, ours), sign in any other way, or delete
itself; the workspace can deactivate it. The Slack / Atlassian / GitHub EMU model.

**Claiming existing accounts.** Someone at `acme.com` who signed up before Acme
turned on SSO: first IdP sign-in on a matching verified domain links them, the
account becomes managed, and they are told. Memberships elsewhere stay.

**Clerk stays the user list.** Every SCIM or JIT person is a real Clerk user on
Clerk's users page. Created at SCIM time, not at first login, because authd's
projection is fed by Clerk webhooks. A user created by API who never signs in is
not an MRU **(inferred, from the definition)**.

### 2.4 Second factor and step-up

- With `second_factor_verification: fresh` (P1) a managed account that has Clerk
  2FA is not asked for it again after the IdP. Better still, managed accounts
  get no Clerk 2FA at all: the IdP owns MFA. A connection can require proof of
  IdP MFA through OIDC `amr`/`acr` or SAML `AuthnContextClassRef`, which Clerk's
  own SSO does not offer.
- **Step-up:** back to the IdP with OIDC `prompt=login max_age=0` (check
  `auth_time`) or SAML `ForceAuthn="true"` (check `AuthnInstant`), then
  `sso_sessions.fresh_at`. `requireFreshAuth` accepts Clerk strict OR `fresh_at`
  under 10 minutes. `resumedNear` keeps refusing saved-account tickets; an SSO
  ticket is told apart by its bind row.

### 2.5 Sessions and logout

- Per-workspace max session length and idle timeout, enforced by the gate, then
  `revokeSession`.
- IdP logout: OIDC back-channel logout and SAML SLO, mapped through
  `idp_session` to revocations.
- Deprovisioning revokes every bound session at once.
- Admin view of a member's sessions with revoke.

### 2.6 JIT

Per connection, off by default. Create on first login for subjects on the
connection's verified domains (Clerk user, identity, managed account,
membership). Role from `group_role_rules` against the groups claim, else the
default; re-evaluated each login. Profile synced at login (Clerk's
`sync_user_attributes`). A full workspace turns JIT into a waiting-list request,
like auto-join. With SCIM on, JIT can be switched off.

### 2.7 SCIM and directory semantics

Whatever speaks the protocol (Part 3), the semantics are ours:

- Base URL per directory, bearer token per directory, rotation with overlap.
- Users, Groups, ServiceProviderConfig, Schemas, ResourceTypes; filters
  `userName`, `externalId`, `emails.value`, `displayName`; Entra's PATCH dialect
  (`aadOptscim062020`, `"False"` strings, capitalised ops) and Okta's.
- Enterprise extension (department, manager, employeeNumber) and custom
  attributes, usable in rules.
- Changes land in an outbox in the same transaction; a groupmq job applies them
  to Clerk and memberships (Clerk calls cannot sit inside a transaction).
- `active: false`: revoke sessions, remove or suspend the membership, ban the
  Clerk user if no other workspace needs them. DELETE: the same, plus the row.

| Conflict                                      | Rule                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Push into a full workspace                    | Accept (201), waiting list "from directory". An error makes the IdP retry and flag the app |
| Push for a blocked email                      | Directory row kept, no membership, shown                                                   |
| Clerk ban by our staff, directory says active | Ban wins                                                                                   |
| Directory reactivates a removed member        | Allowed; the directory is the admin's newer decision                                       |
| Two directories, one person                   | Active while any enabled directory says active                                             |

### 2.8 Mail, where owning the layer pays

- SCIM user on a domain the workspace hosts mail for: create the mailbox
  (opt-in), `emails[]` as aliases.
- SCIM group: optionally a distribution list or shared mailbox (authd already
  serves `filterMemberOf`).
- Deactivated: mailbox suspended, mail kept and still arriving; admin picks
  forward to the manager, delegate, or delete after N days.
- IMAP for managed accounts: authd never answers from Clerk `verify_password`
  for them. Per connection: **LDAP pass-through** to the company's directory
  (Okta LDAP Interface, Google Secure LDAP, Entra Domain Services, AD,
  JumpCloud): one password, theirs. Or **no IMAP** (web and our mail app via
  SSO). A Clerk mailbox password is the app password ruled out on 2026-09-01.
- Directory seats feed #327's meter.

### 2.9 Google Workspace

- **Sign-in:** one-click connection on our Google OAuth client, accepting only
  ID tokens whose `hd` is a domain the workspace verified (Google: check `hd`,
  never the email's domain; `sub` is the identifier).
- **Directory:** the customer's admin authorises our service account's client
  id with `admin.directory.user.readonly` and `admin.directory.group.readonly`
  under Domain-wide delegation; no key changes hands. A worker pulls users,
  groups and members on a schedule and on `users.watch`, emitting the same
  events as SCIM. Check early whether those scopes trigger Google verification.

### 2.10 Setup: self-serve and team-served

- **Wizard** (Settings, Security): verified access domain, IdP preset with a
  guide (Okta, Entra, Google, JumpCloud, OneLogin, Ping, generic OIDC, generic
  SAML), our values with copy buttons, metadata URL or file.
- **Test runs** like Clerk's: a real sign-in, the raw claims, what we would do;
  "required" needs a passed run in the last 24 hours.
- **Enforcement modes:** off, optional, required for the domain, required for
  everyone.
- **Setup links** for the IT contact, scoped and revocable (Clerk's admin portal
  link tokens, ours).
- **Team-served:** the same screens in the staff app (#217), audited, plus
  staff marking a domain verified with an audit event, plus actor-token
  impersonation for support (P5).
- **Break-glass:** owners exempt from "required" by default and keep a passkey;
  a bypass list per connection; staff recovery after a fresh DNS proof.
- Certificate expiry alerts at 30, 7 and 1 days; metadata URL refreshed daily.

### 2.11 Everything that usually comes with it

| Feature                         | Notes                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Identity audit log              | sign-ins, failures with reason, setup changes, SCIM operations, role changes, revocations; filterable, retention per plan |
| SIEM streaming                  | identity events as customer webhooks (our Svix-parity system) and scheduled export to their bucket                        |
| Identity webhooks               | `member.provisioned`, `member.deprovisioned`, `sso.connection.failed`, `sso.certificate.expiring`                         |
| Require 2FA for non-SSO members | workspace policy from `fva` or reverifications                                                                            |
| IP allowlist                    | per workspace, console and API keys                                                                                       |
| Roles                           | an IT-admin role (SSO and SCIM, not billing); roles without Clerk system permissions (1.3)                                |
| Guests                          | outside the verified domains: allowed, with approval, or not when SSO is required                                         |
| API keys on deprovision         | list keys the person created, offer rotation                                                                              |
| Health                          | last good sign-in per connection, failure spikes                                                                          |
| Marketplace listings            | Okta OIN (multi-tenant, SHA-256 SAML, OIN Wizard tests) and the Entra gallery                                             |

### 2.12 Questions from the findings doc, answered (proposed)

| Question                                         | Proposed answer                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| SSO domains vs access domains                    | Same proofs; displacement disables SSO for the domain and alerts both workspaces |
| Auto-join vs JIT                                 | A connected IdP supersedes auto-join for its domains                             |
| SCIM into a full workspace / for a blocked email | Waiting list / block wins                                                        |
| Banned in Clerk, active in directory             | Ban wins                                                                         |
| Enforcement scope                                | Per connection over its domains; "everyone" as a mode                            |
| IdP MFA plus Clerk 2FA                           | IdP only; `fresh` ticket; optional `amr`/`acr`                                   |
| Step-up for SSO users                            | IdP re-auth, `fresh_at`                                                          |
| SCIM users in Clerk before first login           | Yes                                                                              |
| Contractors                                      | Guest policy                                                                     |
| Broken connection                                | Owner exemption, bypass list, alerts, staff DNS recovery                         |
| IMAP                                             | LDAP pass-through, else none                                                     |
| Memberships                                      | Clerk (settled)                                                                  |

---

### 2.13 Where #337 departs from 2.1 to 2.5, on purpose (2026-10-20)

- **The ticket is minted at the handoff swap, not at completion** (2.1 step 6).
  Its sixty seconds start when the browser is ready to use it, and nothing at
  rest can be turned into a session; only its id is stored, for the bind.
- **The bind proves acceptance three ways.** Clerk has no "was this token
  redeemed" read, so: the session is the user's, active and newer than the
  mint; its client's last strategy is `ticket`; and revoking the token is
  refused with `sign_in_token_cannot_be_revoked_code`. Probed on dev: an
  accepted token is not revocable, a pending one revokes, and an expired one
  that was never used also revokes, so expiry never reads as acceptance.
- **Step-up for a managed account is the IdP only** (2.4 said Clerk strict OR
  `fresh_at`). A managed account has no password and no Clerk 2FA, so Clerk's
  strict check would fall back to an email code, which is not what the company
  asked for. Everybody else keeps Clerk's strict check, unchanged.
- **Session limits are per connection, not per workspace** (2.5). A workspace
  with one connection sees no difference; one with two IdPs can hold them to
  different policies. The console (#340) can still present one setting.
- **Owners and admins who are not managed are refused SSO** (decision 7,
  `role_exempt`).
- **Displacement** refuses new sign-ins and, since the review, bound sessions
  too (the gate checks the connection still covers a live proof). Still open
  (#340): the displaced workspace's managed accounts stay managed by it, so the
  person cannot sign in anywhere until that row is released; releasing managed
  rows on displacement, or handing them to the new owner's connection, has to
  be decided.

## Part 3. The options for the engine

### 3.0 Do we need SAML at all?

The question from 2026-10-19: is OIDC (the identity layer on OAuth 2.0; OAuth
alone does not say who someone is) plus SCIM enough?

**What OIDC plus SCIM covers.** Sign-in through Google Workspace, Microsoft
Entra, Okta, OneLogin, JumpCloud, Ping, Auth0, Keycloak and AD FS 2016+ all
offer OIDC **(general knowledge, not checked per IdP here)**. SCIM is
independent of the sign-in protocol: the directory pushes users whatever the
login is. Step-up is cleaner on OIDC (`prompt=login`, `max_age`, `auth_time`).
And it leaves out the code with the worst security history in this whole space
(Part 3, Option A risks).

**Where SAML is still needed, found 2026-10-19:**

- **Okta, private app, with SCIM.** Okta's own help page: "SCIM provisioning
  isn't supported for OIDC integrations that were created in the Classic
  experience", and the steps say to "create a custom SSO integration using
  either SAML or SWA" before enabling SCIM. OIDC with SCIM works only for
  integrations made in the Okta Integration Wizard, which is the path to an OIN
  catalog listing. So until i10 is in the OIN, an Okta customer who wants SCIM
  must create a SAML (or SWA) app for us. A listing in the OIN with OIDC + SCIM
  removes this, and we want that listing anyway.
- **Legacy and regulated IdPs:** older AD FS setups, Shibboleth (education),
  some PingFederate and government deployments are configured for SAML only
  **(general knowledge)**.
- **Procurement checklists** that ask for "SAML SSO" by name, even when OIDC
  would do (one industry guide says OIDC-only vendors "will lose deals").
- **Peers:** SendGrid's SSO is SAML 2.0 (SP- and IdP-initiated, JIT), on its
  higher tiers. Resend sells SSO as an add-on on its Scale plan, with an
  enforced mode; its protocol was not found.

**Decided by the user, 2026-10-19: everything, SAML included, from the start.**
OIDC, SAML, SCIM, JIT and Google Workspace are all in the first build. That also
removes the Okta gap above (customers can create a SAML app and add SCIM to it
before we are in the OIN). The SAML advisory suite is written before the SAML
parser is wired up, as the first step of the SAML piece.

### Option A: our own SP on narrow primitives

**Shape.** Inside `apps/api` and the worker. No new service.

- OIDC: `openid-client` 6.8.8 (panva; certified, zero advisories, on
  `oauth4webapi`). Discovery and JWKS through our webhook SSRF guard.
- SAML: one engine (`@boxyhq/saml20` 1.22.0, or `xml-crypto` 6.4.0 directly),
  wrapped in our rules: reject DTDs and entities, multiple assertions or
  signatures, comments in signed values; read only from the signed references;
  assertion signature required, SHA-256 or better; audience, recipient,
  destination, InResponseTo, timestamps with 2 minutes skew; replay cache in
  Redis; IdP-initiated per connection; certificate lists; signed requests and
  encrypted assertions; `ForceAuthn`.
- SCIM server: ours, Users and Groups, with Better Auth's and Polis's conformance
  suites (MIT / Apache-2.0) as test vectors.
- Google directory: ours, with Polis's Apache-2.0 code as a reference.

**We write:** everything in Part 2 plus the protocol layer.
**We get:** one user model (Clerk), one transaction, no foreign tables, every
feature in Part 2 including SAML `ForceAuthn`, upgrades only when we choose.
**Risks:** SAML signature handling is the classic place to get breached
(xml-crypto: two criticals 2025-03, one 2024-05; node-saml: two criticals
2025-07; samlify: high 2026-05, critical 2025-05). Our wrapper and a fuzz /
regression suite built from every published advisory are what stand between us
and the same bug. SCIM dialect quirks are found by real IdPs, not specs.
**Rough size (inferred):** OIDC 0.5k lines, SAML wrapper 1.5k plus a larger
test suite, SCIM server 2.5k, Google sync 0.8k, before Part 2.

### Option B: Better Auth `sso` + `scim`, used narrowly

**Shape.** A `betterAuth()` instance inside `apps/api`, Drizzle adapter on its
own Postgres schema, every built-in sign-in method off, only the SSO callback,
SAML ACS/metadata and `/scim/v2` routes mounted. Providers registered through
`auth.api.*` from our console routes after our own permission checks (both
2026-07 SSO advisories were in its public registration endpoint).

**How a sign-in runs.** Better Auth's docs: on callback it "processes the
assertion, creates a session, and redirects". So:

1. `resolveUser` runs after verification: `link` to the Better Auth user we keep

   for each Clerk user (a `clerkUserId` field), or `reject`; never `continue`
   into email matching.

2. Better Auth commits its own user, account and session in one transaction and

   redirects to our `callbackURL`.

3. Our handler reads that Better Auth session server-side, deletes it, and runs

   2.1 steps 5 to 8 (membership, ticket, bind).

**How SCIM runs.** SCIM users link to Better Auth users (`identity.resolveUser`,
by immutable `externalId`, never email). `projection.reconcileUser` writes our
outbox in the same transaction; the worker applies it to Clerk. Groups map to
roles through `projection.roles`. `acquireActiveSCIMUserLink` inside SSO
`resolveUser` refuses anyone the directory deactivated. Runtime connections
through `managedConnections` (token digests, rotation).

**We write:** Part 2, the Clerk mirror of Better Auth users, the session
hand-off, and guards around its routes.
**We get:** a maintained SAML layer with InResponseTo, replay, timestamp,
algorithm, size and single-assertion checks; SCIM with Entra and Google
conformance tests, group projection, credential rotation, decommissioning.
**Gaps we still fill:** SAML `ForceAuthn` (none found in source, and SAML
requests cannot carry extra parameters), so SAML step-up is "re-sign-in"
without a guaranteed fresh IdP login; Google directory; setup links (its paid
hosted product only); test runs; break-glass; everything mail.
**Risks:** a second user model kept in sync with Clerk; native transactions and
async context required (enforced in `user-resolution.ts`; the Drizzle adapter
has a `transaction` option, Bun behaviour is P7); fast-moving (sso 55 and scim
41 commits in three months); 1.6 → 1.7 required a full SCIM reprovision and
changed what `wantAssertionsSigned` meant; four advisories in sso/scim in
2026-07 (two critical); samlify underneath. Every minor version must be read
like a migration and pinned.
**Rough size (inferred):** glue 1.5k lines plus Part 2; less protocol code than
A, more integration code.

**Read at source** (`better-auth/better-auth` at `f9ac706`, 2026-10-19; `sso`
1.7.11):

- The SAML pipeline ends with "Provision user", "Organization assignment", then
  `setSessionCookie(ctx, { session, user })` (`routes/saml-pipeline.ts`, steps
  17 to 19). The OIDC route does the same (`routes/sso.ts`). A Better Auth
  session is always created and then thrown away by us.
- SAML hardening on top of samlify is real and careful
  (`saml/assertions.ts`): exactly one plaintext Assertion as a direct child of
  the Response, exactly one Signature in it, decoy `Signature` elements of any
  namespace stripped from the Response before samlify sees it (samlify selects
  by `local-name()` only), then the authenticated Assertion is re-parsed and its
  ID compared with the one that was checked. Replay protection by assertion ID
  (`saml-pipeline.ts`), response binding (`saml/response-binding.ts`),
  algorithm, timestamp and size checks.
- **SAML single logout exists** (`saml.enableSingleLogout`, session records by
  NameID and SessionIndex).
- **No `ForceAuthn`** anywhere in `packages/sso/src`, and no AuthnRequest
  template option.
- **No Google directory** in `packages/scim/src`; SCIM conformance tests exist
  for Entra, Google and **Okta** (`scim-okta-conformance.test.ts`).
- Release pace: `@better-auth/sso` 1.7.8, 1.7.9, 1.7.10, 1.7.11 and
  1.8.0-beta.0/.1 all between 2026-10-14 and 2026-10-19. 1.8 is the next
  upgrade to read.

The hardening in `saml/assertions.ts` is MIT and is the same wrapper Option A
would write: A can copy it (with attribution) instead of inventing it, which
narrows the security gap between A and B.

### Option C: Ory Polis as a service (for completeness)

A separate Next.js service with its own database and TypeORM migrations; our API
is its OAuth client; directory events by webhook. Brings `forceAuthn`, setup
links and Google directory sync in core. Against it: a service to run and
upgrade, core library with no commits in three months, pinned six releases
behind its SAML engine, an admin UI we would hide. Not developed further unless
the weighing asks for it.

### Option D: mixed

Our own OIDC (Option A, cheap and the safest code) with Better Auth only for
SAML and SCIM. Halves Better Auth's surface but keeps its user model, so most of
B's integration cost remains. Listed so it is weighed, not forgotten.

---

## Part 4. Weighing

Scores 1 (poor) to 5 (best) **(judgement, to be challenged)**:

| Criterion                            | Weight | A own SP                                                           | B Better Auth                                        | C Polis       | D mixed |
| ------------------------------------ | ------ | ------------------------------------------------------------------ | ---------------------------------------------------- | ------------- | ------- |
| Security of SAML verification        | 5      | 4 (proven engine, Better Auth's checks copied, our advisory suite) | 4 (careful checks, but samlify and recent criticals) | 3 (stale pin) | 4       |
| Security of the Clerk bridge         | 5      | 5                                                                  | 4 (extra session to delete, second user model)       | 4             | 4       |
| Feature completeness vs Part 2       | 4      | 5                                                                  | 4 (no ForceAuthn, no Google dir; has SLO)            | 4             | 4       |
| Fit with Clerk as the one user model | 4      | 5                                                                  | 2                                                    | 3             | 2       |
| Upgrade and breakage risk            | 3      | 5 (we choose)                                                      | 2 (1.7-style breaks, 1.8 in beta)                    | 3             | 3       |
| Code we write and own                | 3      | 2                                                                  | 3                                                    | 4             | 3       |
| Time to first customer on OIDC       | 3      | 4                                                                  | 4                                                    | 3             | 4       |
| Time to SAML + SCIM                  | 3      | 2                                                                  | 4                                                    | 4             | 4       |
| Operations (new services, schemas)   | 2      | 5                                                                  | 4                                                    | 2             | 4       |
| **Weighted total (of 160)**          |        | **134**                                                            | **111**                                              | **109**       | **114** |

How to read it: B wins on time to SAML and SCIM, and its SAML layer has more
people looking at it. A wins on fit: Clerk stays the only user model, the bridge
has no extra session to tear down, nothing upgrades under us, and every feature
in Part 2 is reachable, `ForceAuthn` included. A's real cost is that SAML
safety rests on our wrapper and test suite, so that work is not optional.

**Decided 2026-10-19: A**, with SAML in the first build (3.0) and its advisory
suite written before the SAML parser is wired up.

---

## Part 5. Probe results (dev instance, 2026-10-19)

Run against the dev instance (`environment_type: development`) with throwaway
`+clerk_test` users created through the Backend API and signed in through the
Frontend API with dev-browser tokens. Every probe user and org was deleted
afterwards and the instance restrictions were restored and re-read. Dev
instances get every feature, so these prove behaviour, not what our production
plan includes. Scripts were kept in the session scratchpad, not the repo.

| #   | Question                                                                                 | Result                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | Does `second_factor_verification` skip Clerk 2FA?                                        | **Yes.** User with TOTP: no parameter → `needs_second_factor`; `fresh` → `complete`, `fva [0,0]`; `stale` → `complete`, `fva [0,99999]`                                                                |
| P2  | Does the blocklist stop sign-in?                                                         | **No.** Clerk will not let us turn off `allowlist_blocklist_disabled_on_sign_in`; with the blocklist on and the email listed, email code, ticket and an older session's token refresh all still worked |
| P3  | Does a `reserved` email change sign-in?                                                  | **No.** Password, email code, ticket and `verify_password` all still work; it only stops someone else signing up with that address (`form_identifier_exists`)                                          |
| P4  | Does the client say how it signed in?                                                    | **Yes.** `last_authentication_strategy` is `ticket` or `email_code`                                                                                                                                    |
| P5  | Do actor tokens work, and what do sessions carry?                                        | **Yes on dev.** `actor` and `act` = `{ sub: <staff user> }`, `fva [0,0]`. Production plan not checked                                                                                                  |
| P6  | Can a member without system permissions change memberships at Clerk?                     | **No.** `403 missing_organization_permission` for invite, remove, re-role, rename; `org:admin` → 200                                                                                                   |
| P7  | Do Better Auth's SSO preconditions pass on Bun + postgres-js + Drizzle?                  | **Yes, both:** the adapter exposes a native `transaction` function, and the transaction async-context storage resolves. Only the preconditions were exercised, not a full SSO flow                     |
| P8  | Once proxied and the CNAME is gone, does Clerk still serve our Frontend API another way? | **Not run.** Production only; ask Clerk support before testing (1.4)                                                                                                                                   |

Also seen: Clerk's dev Frontend API rate-limits sign-ins hard (repeated `429`
after about ten sign-ins in a minute from one address); and a new user with a
password got `needs_second_factor` on a password sign-in from a new client,
which looks like Clerk's client-trust check (`bypass_client_trust` exists on
users) **(inferred)**.

---

## Part 6. Decisions (settled 2026-10-19)

1. ~~The engine~~ **Decided 2026-10-19: A, our own SP** (Part 3, Part 4).
2. ~~The layer level~~ **Decided 2026-10-19: L1 through our gateway at
   `clerk.i10.tech` (1.5).** P8 goes to Clerk support (question in 1.5).
3. ~~SAML now or later~~ **Decided 2026-10-19: SAML from the start (3.0).**
4. **Plans: deferred on purpose (2026-10-19).** Everything is built behind
   per-feature plan flags; the split is set before launch. Proposed split on
   record: Google one-click for everyone; OIDC + SAML SSO, enforcement, JIT and
   group roles on Pro; SCIM, Google directory, mailbox provisioning, SIEM, IP
   allowlist, long audit retention and staff setup on custom.
5. ~~Managed accounts~~ **Decided 2026-10-19: membership by default** (remove
   the membership, suspend the mailbox), with a per-workspace setting to
   deactivate the whole i10 account instead. SSO enforcement locks the person
   out of that workspace's identity either way.
6. ~~IMAP~~ **Decided 2026-10-19: LDAP pass-through where the company has
   LDAP (bind tested in the wizard before it is enabled), otherwise no IMAP**
   for that connection's managed accounts. No mailbox password; ROPC out.
7. ~~Owner exemption~~ **Decided 2026-10-19: owners exempt from "required" by
   default, passkey required on exempt owners**, every bypass sign-in audited
   and alerting the other admins; removing the exemption needs two owners.
   **Found while building #337 (2026-10-20):** the exemption has to work both
   ways. An admin holds `sso:manage`, so an admin can set up a connection and
   run the IdP behind it; if the bridge signed in whoever the IdP named, that
   admin could sign in AS the owner by asserting the owner's address. So the
   bridge refuses an owner or admin who is not managed (`role_exempt`) before
   anything is joined, linked or minted, and they sign in with their own
   passkey. Admins are included because the same admin could otherwise claim a
   fellow admin, and the planned IT-admin role would make that an escalation.
   Still open, for #338 and #340: (a) an owner who chooses to use SSO, linked
   from their own session; (b) a managed account later made an owner, whose
   sign-in the connection's admins still control, so changing such a
   connection's trust (issuer, keys, domains, status) should need an owner;
   (c) claiming (2.3) also reaches somebody who owns a DIFFERENT workspace if
   their address is on this workspace's proved domain. That follows the domain
   authority model on purpose, but it should be a conscious choice before
   launch.
8. ~~Roles~~ **Decided 2026-10-19: workspace roles live in OUR database.**
   Clerk gives every member one powerless role (`org:member`, reads only) and
   `creator_role` moves to it as well; our table holds the real roles and our
   own permissions (any number, e.g. an IT-admin role that manages SSO but not
   billing); our API enforces them; SCIM and JIT group mapping write only our
   table. Workspace deletion moves from `organization.destroy()` in the browser
   to our API (backend `deleteOrganization`, behind step-up). **Found while
   building #335 (dev, 2026-10-19): `creator_role` cannot be made powerless.**
   Clerk refuses with `organization_missing_creator_role_permissions` ("The
   creator role must contain ... org:sys_memberships:manage,
   org:sys_profile:delete, org:sys_memberships:read"), and our provisioning
   needs Clerk's `created_by`, so every creator is a Clerk admin at creation.
   Answer: workspaces are created through our API, which demotes the creator to
   `org:member` in the same request, and the roles webhook demotes any powerful
   membership that appears any other way. `domains_default_role` did switch to
   `org:member` on dev. Prod limits read
   2026-10-19: `max_allowed_roles` 10, `max_allowed_permissions` 0 (no custom
   permissions in Clerk), roles today `org:admin` (all 9 system permissions)
   and `org:member` (`sys_memberships:read`, `sys_billing:read`).

---

## Part 7. Build order (APPROVED 2026-10-19, one issue and PR each)

Assuming engine A, everything in scope including SAML, on L1 (both decided
2026-10-19). Each step is a GitHub issue, all part of #319.

1. **#335** **Roles in our database** (decision 8): our roles table and permission
   checks, every Clerk membership on `org:member` (creators demoted on
   creation, since `creator_role` cannot be switched), workspace creation and
   deletion through our API. Ships before the gateway; it closes
   today's org-admin hole on its own.
2. **#336** **The gateway (L1, decided):** `clerk.i10.tech` pointed at our gateway,
   default-deny allowlist, managed-account rules at the door, Clerk's
   `proxy_url` set after `POST /proxy_checks` passes and Clerk support answers
   P8. Delete the leftover `accounts.i10.tech` record.
3. **#337** Identity core: schema, connections, the bridge (ticket, handoff, bind,
   gate, sweeper as backstop), audit log.
4. **#338** OIDC, and Google Workspace one-click sign-in.
5. **#339** SAML: the advisory suite first, then the engine and our checks (signed

   assertions only, replay cache, ForceAuthn, certificate rotation, SLO,
   IdP-initiated per connection).

6. **#340** Console wizard, test runs, enforcement modes, setup links, staff path,

   break-glass.

7. **#341** JIT and group-to-role rules.
8. **#342** SCIM server, outbox, Clerk apply jobs; Okta, Entra and Google conformance

   suites.

9. **#343** Google directory sync.
10. **#344** Mail: SCIM mailboxes, groups as lists, deprovisioning, LDAP pass-through.
11. **#345** Extras: back-channel logout, session policy, IP allowlist, SIEM export, OIN

    and Entra gallery listings.

---

## Sources

- Clerk: `github.com/clerk/openapi-specs` `bapi/2026-08-20.yml` and
  `fapi/2026-08-20.yml` (updated 2026-10-16), `bapi/2025-11-10.yml`;
  `@clerk/backend` 3.17.1 types in our tree, 3.25.0 on unpkg;
  [session tasks](https://clerk.com/docs/authentication/configuration/session-tasks)
- Clerk: [Frontend API proxy](https://clerk.com/docs/guides/dashboard/dns-domains/proxy-fapi)
- Better Auth: [SSO plugin](https://better-auth.com/docs/plugins/sso),
  [SCIM groups and roles](https://better-auth.com/docs/plugins/scim/groups-and-roles),
  [SCIM plugin](https://better-auth.com/docs/plugins/scim)
- Google: [OpenID Connect reference](https://developers.google.com/identity/openid-connect/reference),
  [verify ID tokens](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token),
  [Directory API authorization](https://developers.google.com/admin-sdk/directory/v1/guides/authorizing)
- Microsoft: [Entra SCIM compliance known issues](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/application-provisioning-config-problem-scim-compatibility)
- Okta: [SCIM on app integrations](https://help.okta.com/en-us/Content/Topics/Apps/Apps_App_Integration_Wizard_SCIM.htm),
  [OIN submission prerequisites](https://developer.okta.com/docs/guides/submit-app-prereq/main),
  [SAML submission](https://developer.okta.com/docs/guides/submit-sso-app/saml2/main/)
- SendGrid: [Single Sign-On](https://www.twilio.com/docs/sendgrid/ui/account-and-settings/sso); Resend: [SSO](https://resend.com/docs/dashboard/settings/sso)
- npm registry and GitHub advisory database: `openid-client`, `oauth4webapi`,
  `xml-crypto`, `@node-saml/node-saml`, `@boxyhq/saml20`, `samlify`
