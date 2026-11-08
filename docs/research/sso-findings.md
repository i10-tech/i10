# SSO: research findings

Collected 2026-10-14. This file holds facts only: what was read, measured or probed, and the questions those facts raise. It deliberately contains no decisions and no recommendations. Anything that was inferred rather than verified is marked **(inferred)**, and anything stated from general knowledge without being checked in this research is marked **(not verified here)**.

## 1. What is being asked for

Stated by the user:

- Clerk stays as the auth provider.
- An SSO abstraction that works with Clerk's enterprise connections AND with an SSO of our own, so the rest of the system does not care which one authenticated a person.
- Motivation: Clerk's SSO is limited by plan and charges per extra connection; self-serve appears to cost extra.
- Coverage wanted: at least everything Clerk supports (SAML, OIDC, SCIM / directory sync), more if possible.
- Self-serve setup, in a UI we own.
- Google Workspace support, including its directory.
- SSO users should still be able to use mail clients (IMAP) through `i10-authd`.
- Better Auth may be brought in for this module or for new work, without moving to it fully.
- SSO is expected to extend the team access domains and member capacity work on `feat/327-member-limits-capacity` (#325, #326, #327).

## 2. Relevant state of i10 today

- **Clerk org usage** (measured 2026-10-14): 34 non-test files reference Clerk orgs. Backend calls in use: `getOrganization`, `updateOrganization`, `getOrganizationMembershipList`, `deleteOrganizationMembership`, `createOrganizationMembership`, `updateOrganizationMetadata`, `createOrganizationInvitation`, `getOrganizationInvitationList`, `revokeOrganizationInvitation`, `createOrganization`, `deleteOrganization` (and wrappers). Webhooks handled: `organization.created/updated/deleted`, `organizationInvitation.accepted/revoked`, `organizationMembership.created/deleted`.
- **Tenant resolution**: `apps/api/src/middleware/tenant.ts` takes the session's `orgId` and calls `core.tenant_for_principal(userId, orgId)`. `core.tenants` is our table.
- **Team access domains (#326)**: per-workspace domains proven by TXT record (or by an existing verified sending domain), with pattern rules (exact, subdomain, `*.` any depth) set to off / suggest / auto-join, most specific wins. Latest proof wins across workspaces (`displaced_at`). Removed and block lists are per workspace, keyed by email. Free-mail domains are blocked.
- **Member capacity (#327)**: member limits per plan (Free 3, Pro 20, custom sets its own), synced to Clerk `maxAllowedMemberships`. Clerk counts pending invitations toward the limit (`organization_membership_quota_exceeded`, verified). A full workspace turns auto-join into a request; a waiting list with "Add and notify"; admin alerts at 80% and 100%. Invitations are Clerk's.
- **Sign-in tokens, probed on the dev instance 2026-10-02**: a Clerk sign-in token (`createSignInToken`, then `signIn.ticket()`) does NOT skip 2FA (an account with TOTP got `needs_second_factor`). A ticket session reads `fva: [0, -1]`. Saved-accounts resume already uses this path, and `clerkFreshAuth` refuses ticket-resumed sessions for step-up (`resumedNear`).
- **Step-up**: `requireFreshAuth` checks `has({ reverification: "strict" })`; the dialog is ours (`apps/console/components/step-up-dialog.tsx`) on Clerk's session-verification API.
- **Mail identity bridge**: Stalwart's directory is LDAP with `bindAuthentication: true`. `i10-authd` (Go, sidecar) answers the bind by calling Clerk `POST /users/{id}/verify_password`; searches are served from a local Postgres projection fed by Clerk webhooks, which also enables offline recipient lookup. Standing user rule: one email, one password, no app passwords.
- **API stack**: `apps/api` is Hono on bun, Drizzle on Postgres, `@clerk/backend` 3.x. Schema changes go through `drizzle-kit generate`, never hand-written SQL.

## 3. Clerk facts

### Pricing (clerk.com/pricing, read 2026-10-14)

| Item                                           | Detail                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enterprise SSO connections (SAML, OIDC, EASIE) | Not on Hobby. Pro/Business: 1 included per app; 2-15 at $75/mo each; 16-100 at $60/mo each; 101+ contact sales                                                                                                                                                                                       |
| Directory Sync (SCIM, Google Workspace)        | Attaches to an SSO connection but is counted and billed separately. Same tiers: 1 included, then $75 / $60. Billing starts 2027-01-01                                                                                                                                                                |
| Development instances                          | SSO and Directory Sync free, max 25 SSO connections                                                                                                                                                                                                                                                  |
| Members per organization                       | Up to 20 on every plan without the add-on                                                                                                                                                                                                                                                            |
| Monthly retained organizations (MROs)          | 100 included per app. An MRO is "an organization with at least 2 members", at least one of them a monthly retained user that month. Exceeding 100 requires the B2B add-on (one-month grace)                                                                                                          |
| Enhanced B2B Authentication add-on             | $100/mo ($85/mo annually). "Add-ons apply to all of your applications" (a flat price, not per organization). Unlimited members per org, linking enterprise connections to orgs, 100 MROs included, extra MROs $1/mo each (101-1,000), $0.90 (1,001-10,000), $0.75 (10,001-100,000), $0.60 (100,001+) |
| Monthly retained users (MRUs)                  | "A user who visits your app in a given month at least one day after signing up." Pro includes 50,000 per app; then $0.02/mo each (50,001-100,000), down to $0.012 at 10M+. A user who signs up and never returns is never billed                                                                     |
| Self-serve SSO                                 | Not mentioned on the pricing page                                                                                                                                                                                                                                                                    |

**(inferred)** Clerk users created through the API who never sign in do not count as MRUs, from the definition above.

### Enterprise connections (docs: enterprise-connections/overview)

- Protocols: SAML (Azure AD, Google Workspace, Okta Workforce, any SAML IdP), OIDC (custom provider), EASIE (multi-tenant OpenID for Google Workspace and Microsoft Entra).
- SAML requires the user's email domain to match the connection domain exactly; subdomains off by default ("Allow subdomains" requires an eTLD+1 connection domain).
- Existing users whose email domain matches a SAML or EASIE connection must authenticate through the IdP, and the enterprise account is linked to their existing account.
- Deleting a connection does not delete its users.
- If MFA is enabled in Clerk, users complete additional factors after returning from the IdP (optional).
- IdP-initiated SSO is supported for SAML only.
- EASIE checks for IdP deprovisioning before issuing a new session token (up to 10 minutes).

### Directory Sync (docs: enterprise-connections/directory-sync)

- Requires an existing SAML or OIDC enterprise connection; configured per connection.
- SCIM 2.0 for Okta, Entra and custom providers. Google Workspace is not SCIM: Clerk reads the directory through the Google Admin SDK (service account, uploaded JSON key, domain-wide delegation with two read-only scopes, plus an admin email), checking at 5-minute granularity.
- Org admins can set it up self-serve through `<OrganizationProfile />`.
- SCIM user attributes synced: `id`, `userName`, `emails[0].value`, `name.givenName`, `name.familyName`, `active`. Read-only in Clerk. No fallback from `emails` to `userName`.
- Create fires `user.created`; update fires `user.updated`; delete or disable deactivates the user, revokes all sessions, and fires `user.updated`. Membership changes fire `organizationMembership.created/deleted`.
- Group-to-role mapping requires the connection to be linked to an Organization; mapped roles cannot be manually overridden.
- Multiple directories per user: active while any enabled directory reports active.
- Limits: no nested groups; disabling a directory does not deactivate its users; enabling JIT and SCIM together blocks unsynced users from signing in.
- The doc page does not mention an API for configuring Directory Sync programmatically. Third-party articles disagree on GA status and on whether role mapping needs the add-on.

### Backend SDK resources

From the Backend SDK overview: Users, Organizations, Billing, Allowlist identifiers, API keys, Domains, Sessions, Clients, Invitations, Redirect URLs, Email addresses, Phone numbers, SAML connections, Sign-in tokens, Agent Tasks, Testing Tokens, M2M tokens, OAuth applications. There is no separate "enterprise connections" resource listed.

### Facts that matter for a non-Clerk SSO

- Clerk has no knowledge of an SSO it does not run. **(inferred)** For an email covered only by our SSO, Clerk will still accept that user's other sign-in methods (password, social, email code) through its Frontend API, bypassing our UI.
- **(inferred)** Because our SSO is not a Clerk enterprise connection, Clerk would let such a user have a password, and `verify_password` would answer for it.
- Sign-in tickets do not skip Clerk 2FA, and ticket sessions read `fva: [0, -1]` (probed, see section 2).
- Organizations and memberships: Clerk's active organization, roles in the session token, `has()` checks and invitation acceptance all depend on membership records. **(inferred)** An organization whose memberships live elsewhere cannot be an active org in a Clerk session.

## 4. Protocol facts

- OAuth 2.0 is an authorization framework. OpenID Connect is an identity layer on top of it that adds the ID token (who the user is). Enterprise sign-in through OIDC uses the OAuth authorization code flow (with PKCE).
- OAuth 2.1 drops the implicit grant and the resource owner password credentials (ROPC) grant.
- Better Auth deprecated its `oidc-provider` plugin in favour of `@better-auth/oauth-provider` ("OAuth 2.1 Provider"). Both are for Better Auth acting as an authorization server for other apps, not for signing users in through an external IdP. External OIDC/OAuth sign-in is the SSO plugin (enterprise) or the Generic OAuth plugin (social-style).
- SAML can carry `ForceAuthn` to require a fresh IdP login; OIDC uses `prompt=login` and `max_age`, with `auth_time` in the ID token.

## 5. Better Auth (`@better-auth/sso`, `@better-auth/scim`)

### Versions and dependencies (npm, 2026-10-14)

- `@better-auth/sso` 1.7.7, modified 2026-09-30. Dependencies: `samlify ^2.13.1`, `@xmldom/xmldom ^0.9.12`, `fast-xml-parser ^5.8.0`, `jose ^6.2.3`, `tldts ^7.4.3`, `zod`. Peers: `better-auth`, `@better-auth/core`, `better-call`.
- `@better-auth/scim` 1.7.7. Dependencies: `@noble/hashes`, `zod`. Same peers.
- Licence: MIT.

### SSO plugin features (docs: /docs/plugins/sso)

- OIDC providers with discovery; SAML providers; IdP-initiated SSO (SAML, and OIDC with `allowIdpInitiated` plus `baseURL`).
- `resolveUser` callback runs after the protocol identity is verified, returning `continue`, `link` (to a given user id, `profile: preserve | update`) or `reject`. Account key: OIDC `iss` + `sub`; SAML IdP entity ID + signed `NameID` (case-sensitive). Runs inside a database transaction; needs native transactions.
- `provisionUser` (new users, or every login with `provisionUserOnEveryLogin`) and organization provisioning when its organization plugin is enabled.
- SAML security: InResponseTo validation (default on), assertion replay protection (always on), timestamp validation (`requireTimestamps` option), algorithm validation, size limits, single-assertion check, response binding checks (audience, recipient, bearer confirmation), certificate lists for rotation, metadata-document certificates, `guardProviderMutation` hook.
- OIDC sign-in accepts `additionalParams` (so `prompt`, `max_age` can be passed). For SAML, `additionalParams` is rejected ("the SAML AuthnRequest is signed and cannot carry caller-supplied query parameters"). No `ForceAuthn` option found in the source.
- Its own domain verification (DNS token) feature; when enabled, a verified domain is trusted for automatic account linking by email.
- A "self-service SSO dashboard" with onboarding links exists only in Better Auth Infrastructure (their paid hosted product).

### SCIM plugin features (docs: /docs/plugins/scim)

- Inbound SCIM 2.0 (RFC 7643/7644). Server-only; needs a database adapter with interactive transactions (not Cloudflare D1).
- Connections with bearer credentials; `provisioningDomainId` maps a connection to a workspace or tenant; optional `managedConnections` catalog for runtime onboarding and token rotation (stores token digests).
- A SCIM User links to one Better Auth User; provisioning creates no sign-in method. Never links by email. `identity.resolveUser` can link to an existing user (prefer immutable `externalId`).
- `identity.reconcileUser` runs in the same transaction as the SCIM change; throwing rolls it back. Network side effects inside it cannot be rolled back.
- Deactivating or deleting the last active source deletes the user's Better Auth sessions; the docs warn this does not prevent signing in again.
- `acquireActiveSCIMUserLink` pairs SCIM with SSO: inside SSO `resolveUser`, it returns the active link for an exact connection + `externalId`, or null.
- Groups and role projection are on a separate page (`/docs/plugins/scim/groups-and-roles`, not read in this research).
- Test files include Entra and Google conformance suites. No Google Admin SDK (non-SCIM) directory sync was found in the source.

### Repository measurements (cloned `better-auth/better-auth`, 2026-10-14)

|                                           | `packages/sso` | `packages/scim` |
| ----------------------------------------- | -------------- | --------------- |
| Source lines (ts/tsx/js, excluding tests) | 10,279         | 12,933          |
| Test lines                                | 22,499         | 20,129          |
| First commit touching it                  | 2025-06-27     | 2025-11-21      |
| Commits, last 12 months                   | 363            | 213             |
| Commits, last 3 months                    | 55             | 41              |
| Distinct non-bot authors, last 12 months  | 36             | 14              |

Non-bot commits per month across both packages, 2025-10 to 2026-10: 14, 50, 59, 35, 36, 18, 23, 20, 37, 10, 19, 2, 11.

### Breaking changes (1.7 upgrade guide)

- SCIM: "The new SCIM models do not read or convert the 1.6 SCIM tables", so upgrading requires a maintenance window and full reprovisioning.
- SAML: certificates became lists; configuration simplified (callback URL derived, ACS path `/sso/saml2/sp/acs/:providerId`); error codes changed; "In 1.6, `wantAssertionsSigned` enforced a signature on the SAML response message instead of" the assertion (signature enforcement changed meaning).

### Security advisories (GitHub advisory database, 2026-10-14)

`@better-auth/sso`:

- 2026-07-20 high CVE-2026-53515: SSO provider registration allowed for any org member without a role check.
- 2026-07-07 critical CVE-2026-53513: server-side request forgery through unvalidated OIDC endpoints in provider registration.

`@better-auth/scim`:

- 2026-07-24 critical GHSA-rjg6-39jm-rgg4: account takeover and stale access through SCIM provider-id collision.
- 2026-07-07 high GHSA-j8v8-g9cx-5qf4: account/provider takeover through missing owner binding on non-org SCIM providers.
- 2026-07-07 low GHSA-2vg6-77g8-24mp: stale sessions after user deletion (admin, anonymous, SCIM).

`better-auth` (core and other plugins) has a longer list, including on 2026-07-07: OAuth refresh-token replay (critical), concurrent authorization-code redemption, refresh-token family forking, `alg=none` advertised and plain PKCE accepted in `oidcProvider`, stored XSS via `javascript:` redirect URIs, account takeover via OAuth auto-link to an unverified email, and CVE-2026-53514 (invitation acceptance via unverified email match in the organization plugin). Also: 2026-04-03 critical 2FA bypass via `session.cookieCache`; 2025-10-09 high unauthenticated API key creation; several open redirects in 2024-2025.

### samlify (the SAML engine under Better Auth)

- `tngan/samlify`: not archived, 662 stars, 53 open issues, last push 2026-08-11.
- Advisories: 2026-05-21 high CVE-2026-46490 (XML injection in AttributeValue allowing privilege escalation in signed assertions); 2025-05-19 critical CVE-2025-47949 (signature wrapping); 2018 high CVE-2017-1000452 (token reuse with different usernames).

## 6. Ory Polis (formerly BoxyHQ SAML Jackson)

- Repository `ory/polis`: Apache-2.0, not archived, 2,268 stars, last push 2026-07-27. Latest releases: v26.2.0 (2026-03-20), v1.52.1 (2025-07-14), v1.52.0 (2025-07-11).
- What it is: bridges SAML to OAuth 2.0 / OIDC (the app talks OAuth to Polis), plus SCIM 2.0 directory sync. Runs as a standalone Next.js service with an admin portal, or as the npm library `@boxyhq/saml-jackson` (Node only).
- Enterprise licence: `npm/src/ee` is under the Ory Enterprise License and gated by `throwIfInvalidLicense`: identity federation, branding, product. Core SSO and directory sync are not gated. Ory's product page also sells self-hosted support under that licence.
- Storage: TypeORM and others (Postgres, MySQL, MariaDB, MSSQL, SQLite, MongoDB, DynamoDB, Redis, PlanetScale).
- SAML engine: `@boxyhq/saml20` (repo now `ory/saml20`), built on `xml-crypto` 6.3.3, `xml-encryption`, `@xmldom/xmldom`, `xml2js`, `xpath`. `ory/saml20` last commit 2026-10-13 (release 1.22.0 on 2026-10-12). Polis pins `@boxyhq/saml20` 1.16.0.
- Other dependencies in the library include `openid-client`, `jose`, `node-forge`, `axios`, `lodash`, `mixpanel`, `@googleapis/admin`, the AWS DynamoDB SDK, `mongodb`, `mssql`, `mysql2`, `pg`, `redis`, `better-sqlite3`.
- Features found in source: SAML and OIDC connections, `forceAuthn` per connection and per request, setup links (`controller/setup-link.ts`, not EE-gated) for customer IT admins, SP config/metadata, logout, OIDC discovery, OpenTelemetry, SSO traces.
- Directory sync: SCIM (`directory-sync/scim`: Users, Groups) and non-SCIM Google Workspace (`directory-sync/non-scim/google`: syncUsers, syncGroups, syncGroupMembers). Events: `user.created/updated/deleted`, `group.created/updated/deleted`, `group.user_added/user_removed`, delivered to webhooks (batch queue available).
- No published GitHub advisories found for `@boxyhq/saml-jackson` or `@boxyhq/saml20`.

### Repository measurements (cloned `ory/polis`, 2026-10-14)

|                                                                       | Value                             |
| --------------------------------------------------------------------- | --------------------------------- |
| Core library source lines (`npm/src`)                                 | 15,259                            |
| Library test lines (`npm/test`)                                       | 8,729                             |
| End-to-end test lines (`e2e`)                                         | 5,250                             |
| UI and app source (`pages`, `components`, `internal-ui`, `lib`, `ee`) | about 12,800                      |
| First commit                                                          | 2021-08-14 (`npm/src` 2022-01-05) |
| Commits, last 12 months: whole repo / `npm/src`                       | 300 / 29                          |
| Commits, last 3 months: whole repo / `npm/src`                        | 3 / 0                             |
| Non-bot authors, last 12 months: whole repo / `npm/src`               | 14 / 4                            |
| Last commit touching `npm/src`                                        | 2026-07-07                        |

Non-bot commits per month, whole repo, 2025-10 to 2026-07: 1, 2, 4, 8, 17, 36, 9, 6, 9, 5.

## 7. Side by side (facts only)

|                                         | Better Auth sso + scim                                                       | Ory Polis                                       |
| --------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- |
| Runs as                                 | Library inside our server (Hono route), our database via its Drizzle adapter | Separate service with UI, or Node library       |
| Licence                                 | MIT                                                                          | Apache-2.0 core, OEL for `ee`                   |
| SAML engine                             | samlify plus Better Auth's own checks                                        | ory/saml20 on xml-crypto (pinned behind latest) |
| OIDC                                    | Yes, extra auth params allowed                                               | Yes                                             |
| SAML ForceAuthn                         | Not found                                                                    | Yes                                             |
| SCIM users / groups                     | Yes / yes, role projection                                                   | Yes / yes, webhook events                       |
| Google Workspace directory without SCIM | Not found                                                                    | Yes (Admin SDK)                                 |
| Customer setup links                    | Paid hosted product only                                                     | In core                                         |
| Admin UI                                | None in the packages                                                         | Admin portal                                    |
| Activity, last 3 months                 | 96 commits across both packages                                              | 0 commits in the core library                   |
| Published advisories                    | 4 (sso/scim), plus many in core                                              | None found                                      |
| Recent breaking changes                 | 1.6 to 1.7 SCIM reprovision, SAML signature semantics                        | None observed                                   |

To reproduce the measurements: clone both repos with `--filter=blob:none`, count lines under the paths above, and run `git log --since=<date> --oneline -- <path>`.

## 8. Password verification for SSO users (IMAP)

When an IdP owns the password, i10 never sees it unless the IdP offers a way to check it.

| IdP                            | Password check available to a third party                                     | Notes                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Okta                           | LDAP Interface **(not verified here)**                                        | Customer enables it                                                                                                                                                                                                                                                                                                                      |
| Google Workspace               | Secure LDAP **(not verified here)**                                           | Enterprise, Education and Cloud Identity Premium editions only **(not verified here)**                                                                                                                                                                                                                                                   |
| Microsoft Entra                | Entra Domain Services managed LDAP **(not verified here)**, or the ROPC grant | ROPC, per Microsoft docs: blocked when MFA is required; not supported for federated (AD FS) accounts unless `AllowCloudPasswordValidation` with synced passwords; works with pass-through authentication; no passwordless accounts; no leading/trailing whitespace; invited personal accounts excluded; Microsoft advises migrating away |
| On-prem AD, JumpCloud, FreeIPA | LDAP **(not verified here for JumpCloud)**                                    | Must be reachable                                                                                                                                                                                                                                                                                                                        |
| SAML-only or OIDC-only         | None                                                                          | Neither protocol checks passwords                                                                                                                                                                                                                                                                                                        |

Related facts:

- `i10-authd` already serves LDAP binds to Stalwart; today every bind goes to Clerk `verify_password`.
- Stalwart's own docs (from the mail-bridge research) say Apple Mail, Outlook and Thunderbird do not support OAUTHBEARER with third-party providers.
- **(inferred)** A Clerk password could be set on a user authenticated by our own SSO (backend `updateUser({ password })`), and `verify_password` would check it. That would be a second secret besides the IdP password.

## 9. Google Workspace

- Google Workspace sign-in can be plain Google OIDC; the ID token's `hd` claim carries the Workspace domain **(not verified here)**. Google Workspace also supports custom SAML apps configured by its admin.
- Google does not push SCIM to arbitrary apps **(not verified here)**; directory data comes from the Admin SDK Directory API.
- Clerk's approach: the customer creates a service account, uploads its JSON key, grants domain-wide delegation with two read-only scopes, and gives an admin email; Clerk polls at 5-minute granularity.
- Alternative shape **(not verified here)**: the customer authorizes a service account owned by the app under Admin console > Security > API controls > Domain-wide delegation, so no key is exchanged; the Directory API also offers push notifications (`users.watch`). Directory scopes may require Google OAuth app verification.
- Polis's Apache-2.0 implementation is at `ory/polis` `npm/src/directory-sync/non-scim/google`.

## 10. Where SSO touches existing work (questions, unanswered)

- Access domains (#326) already prove domains by TXT; how does SSO domain ownership relate to them, including "latest proof wins" displacement?
- Auto-join and per-rule roles versus just-in-time provisioning and IdP group-to-role mapping.
- A SCIM push into a full workspace (#327): SCIM has no "request to join" concept.
- A SCIM push for someone on the workspace's block list.
- A user banned or deleted in Clerk while the directory still reports them active.
- SSO enforcement per workspace versus per email domain, given Clerk will not enforce an SSO it does not run.
- Ticket sessions and 2FA: whether IdP MFA plus Clerk 2FA both apply.
- Step-up for SSO users, given ticket sessions read `fva: [0, -1]` and `resumedNear` refuses them.
- Whether SCIM-provisioned users should exist in Clerk before first sign-in (the authd projection is fed by Clerk webhooks, so a mailbox can only receive mail once its Clerk user exists).
- Members of an SSO-required workspace whose email is outside the domain (contractors).
- Recovering a workspace whose IdP connection breaks (expired certificate, misconfiguration).
- IMAP for SSO users whose IdP offers no password check (section 8) versus the one-password rule.
- Where memberships live if the 20-member and 100-MRO limits are not covered by the add-on.

## Sources

- Clerk: [pricing](https://clerk.com/pricing), [enterprise connections overview](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/overview), [directory sync](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/directory-sync.md), [backend SDK overview](https://clerk.com/docs/reference/backend/overview)
- Better Auth: [SSO plugin](https://better-auth.com/docs/plugins/sso), [SCIM plugin](https://better-auth.com/docs/plugins/scim), [1.7 upgrade guide](https://better-auth.com/docs/guides/1-7-upgrade-guide), [OAuth 2.1 Provider](https://better-auth.com/docs/plugins/oauth-provider), [Generic OAuth](https://better-auth.com/docs/plugins/generic-oauth), [repository](https://github.com/better-auth/better-auth)
- Ory: [polis](https://github.com/ory/polis), [saml20](https://github.com/ory/saml20), [Polis directory sync](https://ory.sh/docs/polis/directory-sync)
- [samlify](https://github.com/tngan/samlify)
- Microsoft: [ROPC](https://learn.microsoft.com/en-gb/entra/identity-platform/v2-oauth-ropc)
- GitHub advisory database, npm ecosystem: `@better-auth/sso`, `@better-auth/scim`, `better-auth`, `samlify`, `@boxyhq/saml-jackson`, `@boxyhq/saml20`
- i10 internal: probes of 2026-10-02 (sign-in tokens), `docs/decisions` and the membership work on `feat/327-member-limits-capacity`
