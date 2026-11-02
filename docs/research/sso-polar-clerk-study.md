# SSO, read at the source: Polar and Clerk (2026-11-02)

What two other SSO implementations do that ours could learn from. Polar's
server and dashboard were read at `polarsource/polar` 33d6928 (2026-11-01),
with the history of every SSO commit since May 2026. Clerk's UI and SDK were
read at `clerk/javascript` b5803ea (2026-10-30), and Clerk's flow was run live
on our dev instance against the lab Keycloak. The full Clerk source reports are
in `clerk-sso/admin-ui.md` and `clerk-sso/signin-flow.md` next to this file.

Our side is `docs/decisions/sso.md` (2.13 to 2.21) and `tools/sso-lab/FINDINGS.md`.
Where we already do better, this says so and moves on.

---

## 1. What to take, ranked

Each item names its source and the gap it closes in ours.

1. **Tell a member WHY they cannot get in, and send them to their SSO**
   (Polar). `/v1/users/me` returns two lists: `organizations` (reachable in
   THIS session) and `member_organizations` (every membership, each with
   `requires_sso`). The dashboard layout uses them to tell "member who must
   re-authenticate" from "not a member": the first goes to `/auth/sso/{slug}`,
   the second gets a 404. FINDINGS lists "an unbound or refused SSO session
   lands on onboarding" and "Could not finish signing you in gives no reason";
   this is the shape that fixes both. Our gate already knows (`sso_required`
   carries the connection id); the console needs the membership list with that
   flag, and a page that starts the right connection.

2. **Record EVERY test run, failures included, and say how to fix it**
   (Clerk). A test run is a server row: status, parsed user, structured logs
   (`code`, short, long), and the raw SAML request/response or OIDC tokens.
   The admin opens a drawer per run with the error code, the full message and
   "how to fix" keyed by code, with a docs deep link derived from the code.
   FINDINGS: "A refused test run lands on a generic dead-end page, and the
   connection's History still says No test run yet". Clerk covers only six
   codes (`saml_user_attribute_missing`, `saml_response_relaystate_missing`,
   `saml_email_address_domain_mismatch`, `oauth_access_denied`,
   `oauth_token_exchange_error`, `oauth_fetch_user_error`); ours should cover
   our whole refusal list (signature, audience, issuer, clock skew,
   InResponseTo, `email_unverified`, `role_exempt`, `domain_not_verified`,
   `profile_incomplete`, discovery, `invalid_client`).
   **Ours is already better on:** the gate. Clerk passes on any success ever,
   and editing the IdP later does not ask for a new test; ours needs a pass in
   the last 24 hours.

3. **Generic extra authorization parameters on OIDC** (Polar). Up to 10
   `key: value` pairs appended to the authorization request, keys matching
   `^[a-zA-Z0-9_.-]{1,64}$`, values up to 256, with a reserved set refused
   (`response_type`, `client_id`, `redirect_uri`, `scope`, `state`, `nonce`,
   `code_challenge`, `code_challenge_method`). The Google preset owns `hd`
   ("pin a Workspace domain"). Ours has no Scopes field in the console and no
   way to send `hd`, `acr_values` or an IdP-specific parameter. Polar also
   strips a pasted `/.well-known/openid-configuration` back to the issuer,
   since that is what admins paste.

4. **Make the setup wizard a function of server state** (Clerk). Steps
   Domains, Connection, Test, Activate; each has a "reachable" and a
   "complete" predicate read from the connection, the domains and the latest
   test; reload, another tab or another admin all resume at the furthest
   reachable step, and a step whose guard flips re-seats itself. The
   connection is created as soon as a provider is picked, so the ACS URL,
   entity id and redirect URI exist before the admin goes to the IdP. "Next"
   after a save waits for the refetch instead of needing a second click.
   Worth checking our console screens against this, especially FINDINGS'
   "two save buttons; saving the secret alone drops unsaved settings": Clerk
   sends the OIDC secret write-only in the same PATCH, blank on edit, "leave
   empty to keep".

5. **Show conflicts where they happen** (Clerk). A domain held by another
   connection is shown on its card as "Used by another connection" with the
   checkbox disabled, not only as an error on save. The last domain of a live
   connection cannot be unticked, with a tooltip saying why. FINDINGS has both
   problems ("its domain was not added" reads like a failed save; removing a
   domain from a live connection locks people out without warning).

6. **Certificate expiry visible and alerted** (Clerk, partly). Up to 5
   trusted IdP certificates (ours: the same 5), each with `expired`,
   `expiring` (30 days) or `unknown` until saved, and a summary "N
   certificates, earliest expires ...". Clerk only shows it when someone opens
   the page. We refresh metadata nightly already; add the 30-day state to the
   console and an email to the connection's admins (#345's alert path).

7. **Provider-exact wording** (Clerk). Each preset uses the IdP's own field
   names: Okta "Single sign-on URL" and "Audience URI (SP Entity ID)", Entra
   "Reply URL" and "Identifier (Entity ID)", Google "ACS URL" plus "Name ID
   format: Email" and a warning that Google takes up to 24 hours. Entra's
   claim table lists the full `http://schemas.xmlsoap.org/...` URIs with copy
   buttons. Show the SP metadata URL during setup (Clerk only shows it after).

8. **Confirmation weight by blast radius** (Clerk, Polar). Typed workspace
   name for remove/reset of a connection and removing a directory; plain
   confirm for changing provider and removing a domain, with copy that says
   what happens to people when the connection is live. Polar asks for the
   slug before turning enforcement on. Clerk's "Deactivate" (which ends
   enforcement) has NO confirmation: do not copy that.

9. **Enforcement only from a session that proved it works** (Polar). Turning
   `sso_enforced` on is refused unless the admin's own session was minted by
   this org's SSO, plus an enabled connection and a verified domain. Ours asks
   for a passing test run in 24 hours instead, which covers the same risk
   without forcing an owner (exempt by default) through SSO. Keep ours; note
   that Polar's check reads the persisted scope, not a request header.

10. **Lock what the IdP owns, on the person's own profile** (Clerk). With an
    active enterprise account, name and password edits are disabled with a
    reason, phone-code MFA is not offered, and there is no unlink. Check our
    account page for managed accounts.

11. **Drop a typed password when SSO may apply** (Clerk). With enterprise SSO
    on, the sign-in is created WITHOUT the password; it is replayed only if the
    answer has no SSO factor. Check our auth app's discovery for the same
    property.

12. **The bypass screen says it is recorded** (Clerk). "Continue with SSO"
    plus "Can't use SSO?", and the code step says continuing without SSO is
    recorded. Ours audits and alerts other admins already; add the notice so
    the person knows.

### Session scope, weighed and NOT ranked

Polar's central design is a **down-scoped session**: an SSO sign-in mints a
session whose `organization_scopes` hold only that org, every membership query
goes through one helper that applies it (enforced by a custom AST linter,
`server/scripts/linters/org_scope.py`), and an enforced org is unreachable by
any session or OAuth token not scoped to it (personal access tokens exempt;
org-scoped OAuth tokens revoked when enforcement turns on). Ours binds a
session to its workspace for that workspace's enforcement, but the Clerk
session the bridge mints also reaches the person's other workspaces.

That looks like a hole (workspace A's IdP admin reaching B) but is not a new
one: A proved the domain, so A controls its mail, and can already get an email
code for the same account. Down-scoping would add a second sign-in for people
in two workspaces and gains little while domain authority stands. Revisit only
if we ever let a workspace manage addresses on a domain it has not proved.
The linter idea is worth taking on its own: a rule that a route reading a
workspace's data goes through `requireTenant` (and so through enforcement).

---

## 2. Polar, briefly

OIDC only (`client_secret` or `private_key_jwt` with Polar's own signer and
JWKS), per-org connections behind a staff feature flag, built June to October
2026 in about 40 PRs. No SAML, no SCIM, no JIT beyond "create user and
membership on first sign-in", no group roles, no break-glass, no test run, no
logout propagation. Ours is far broader. What is sound:

- Sign-in: `/{slug}/start` binds an authentication session to the org;
  `/{slug}/sso/{connection}/authorize` keeps the connection id in OAuth state,
  not a query parameter; the callback checks the state cookie, requires
  `email_verified` (falling back to userinfo when the ID token omits it, the
  Okta case we also hit), and requires the address on a verified domain of
  THAT org.
- SSO counts as both factors (`advance_by=2`, "Skip MFA factors after SSO
  login", #13809). Clerk counts it as the first only (below). We mint with
  `second_factor_verification: fresh`, so we sit with Polar.
- Login page: if SSO is the only factor, redirect at once; otherwise SSO
  buttons first, then the base factors. A shareable `/auth/sso/{slug}` link is
  shown until enforcement makes discovery automatic.
- Domains: `_polar-challenge.{domain}` TXT, one verified owner per domain
  (partial unique index), periodic re-verification with `verification_lost_at`
  and an email to everyone with `organization_manage`. Ours re-checks too
  (`domains/recheck.ts`, `recheck.ts`), more cautiously: absence must persist.
- A refused "last enabled connection" while enforced (409) so an admin cannot
  remove the only way in.

## 3. Clerk, live on our dev instance

Set up 2026-11-02: Clerk org `clerk-sso-probe` (org_3LWqT4lqRcEooSVV3DjDX9SIO2k),
SAML connection `entc_3LWqdn44YXqzAgqXZiUGBxgDqsA` for
`clerk-probe.sso-lab.i10.tech` against the lab Keycloak (realm `i10-lab`,
client = Clerk's SP entity id, user `probe`). A separate domain, so our own lab
connections on `sso-lab.i10.tech` are untouched. Driven from a script with its
own cookie jar through the Frontend API, so no browser session was disturbed.

- **Creation defaults** (Backend API): `active: false`, `authenticatable:
  true`, JIT on, `sync_user_attributes: true`,
  `disable_additional_identifications: true`,
  `allow_organization_account_linking: false`, `allow_idp_initiated: false`,
  `force_authn: false`, `login_hint: off`. Certificates come back as a list
  with `issued_at` and `expires_at`.
- **Clerk's SP is laxer than ours:** `AuthnRequestsSigned="false"`, no SLO
  endpoint, no encryption key, NameID `emailAddress`, and the metadata is
  `validUntil` two days out.
- **Discovery:** `POST /v1/client/sign_ins {identifier}` answers
  `needs_first_factor` with only `{"strategy":"enterprise_sso"}`, identically
  for an address with no account and for one with an account, so it reveals
  nothing (ours: the same property, `POST /sso/discover`).
- **First sign-in:** `prepare_first_factor {strategy: enterprise_sso}` gives
  the IdP URL (SAML redirect binding); the ACS answers 303 to `redirect_url`;
  the sign-in is then `transferable` with `external_account_not_found`, and
  `POST /v1/client/sign_ups {transfer: true}` completes it: account created
  with the IdP's names, membership `org:member`, session ACTIVE in the
  connection's org (`last_active_organization_id` set). The source alone
  suggests the client never activates the org; live, the server does.
- **Next sign-ins:** the ACS completes the sign-in directly, no transfer.
- **`factor_verification_age` is `[0, -1]`:** Clerk does not count SSO as a
  second factor. A user with 2FA would be asked for it after SSO.
- **Self-serve components:** orgs carry `self_serve_sso_enabled` and
  `self_serve_directory_sync_enabled` (settable on the Backend API, absent from
  the SDK types). The runtime is clerk-js 6.41.0 with @clerk/ui 1.42.0;
  `ConfigureSSO` mounts through `clerk.__internal_mountConfigureSSO`. Its
  calls (`GET /v1/organizations/{id}/enterprise_connections`,
  `GET .../domains?enrollment_mode=enterprise_sso`) need
  `org:sys_entconns:manage`, and our roles webhook demotes the probe admin to
  `org:member` within seconds (by design, `fixClerkRole`), so they answered
  403. See section 4.

## 4. The probe page

`apps/console/app/probe/clerk/` (dev only: `notFound()` in a production build,
and the action refuses a live key). "Prepare" makes the signed-in person Clerk
admin of `clerk-sso-probe`, turns on both self-serve switches, activates the
org, and shows the Backend API's view; tabs mount `<OrganizationProfile>`,
`ConfigureSSO` and `ConfigureDirectorySync`. While the dev webhook tunnel is
up, our roles webhook demotes the admin again before Clerk's components finish
loading, so the wizard needs the demotion paused for that one org to be
explored by hand.

Cleanup when done: delete the connection, the org, the Clerk user
`probe@clerk-probe.sso-lab.i10.tech`, and the Keycloak client and user.
