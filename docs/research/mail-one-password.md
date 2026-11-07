# One password for every mail app, including SSO users

**Status:** research, 2026-11-07. No code changed, no tenant touched. Nothing here is decided.

**The principle (owner's):** one password. We store no password, no hash, no app password, no per-device secret. Clerk holds passwords for normal users; the customer's IdP holds them for SSO users. Per-device generated passwords are out.

**How to read the evidence tags:** `[doc]` read on a vendor page during this session (dated in Sources); `[sum]` came from a search summary and was not read at source, so treat as a lead; `[mem]` from background knowledge, not re-fetched; `[probe]` must be checked on a real tenant or device before anyone builds on it.

---

## 1. The short answer

There is no single mechanism that keeps the principle AND works in every mail client AND survives IdP MFA. The honest map is two lanes that together cover most people:

1. **Password lane (every client, SASL PLAIN).** authd asks the customer's own IdP "is this password right?" at bind time, per workspace. Real, documented, and cheap for **Okta** (direct-auth password grant, or the LDAP Interface). Fragile for **Entra** (ROPC: dead the moment MFA applies, which is the default). Narrow for **Google** (Secure LDAP wants the Google password, which an SSO-federated person does not use, and 2SV behaviour is unconfirmed). Impossible for generic SAML/OIDC IdPs. This lane only works when the IdP does not demand MFA for the mail-app sign-in.
2. **OAuth lane (MFA-safe, few clients).** The mail app does OAuth against us (Stalwart's own issuer, advertised through PACC), and the browser step federates to Clerk or the customer's IdP through the SSO layer we already own. Covers Thunderbird 156+ today (manual issuer and client id) and, per Stalwart's own docs, Apple Mail when the server conforms to the open public client profile `[probe]`. Does not cover Outlook (any), the Gmail app, or Android clients without custom OAuth.

People who are MFA-enforced AND on Outlook or the Gmail app have no answer without a stored secret. That set is real and should be said out loud to the customer, not hidden.

**Two findings that change earlier conclusions** (details in section 9):

- Stalwart's own docs say Apple Mail "still fails against a non-conforming provider", which implies it works against a conforming one. The earlier "Apple Mail cannot do OAuth against an arbitrary IMAP server" is therefore unproven in the other direction. Needs one device test.
- Google Secure LDAP checks the **Google** password, not the third-party IdP's. For a Google Workspace that federates to Okta or Entra, it does not give "their IdP password". The pass-through line in `docs/decisions/sso.md` 2.8 overstated it for Google.

---

## 2. Ground truth: how a bind works today

Read in `services/authd`:

- Stalwart 1.0.3 uses an LDAP directory with `bindAuthentication: true`. It searches (answered from the Postgres projection), then binds as the user. `internal/ldapsrv/bind.go` answers the bind: projection lookup, then credcache (60 s, HMAC of verified passwords, in memory), then the per-DN token bucket (30/min), then `clerkauth.Client.Verify`.
- `Verify` returns a tri-state `Outcome` (`Rejected`, `Verified`, `Unavailable`). The rule that must survive any new provider: **an IdP outage or a rate limit is never `invalidCredentials`.** `Unavailable` maps to LDAP 52, local throttle to 51.
- `verify_password` does not feed Clerk's lockout counter (measured on dev; README says re-run on prod). That is why authd's throttle protects Clerk's request budget, not the user. **That property does not transfer to any IdP below.** Okta and Entra count failed passwords toward lockout. This flips the throttle's job (section 7).
- authd is loopback-only, speaks plaintext LDAP, and never sees the mail client's IP (Stalwart binds on the client's behalf). Per-source-IP limiting cannot live in authd.
- Seam for this work: `s.verifier.Verify(ctx, account.ClerkUserID, password)` is one call. A per-account `auth_source` selecting a verifier is a small change; the tri-state contract already fits.

**A consistency point worth deciding on purpose.** Clerk users who turned on TOTP today reach IMAP with the password alone, because `verify_password` never checks a second factor. Stalwart's FAQ says the same of any password login: it "can't carry a 2FA code" and 2FA exists only for the internal directory. So the product already has an "IMAP bypasses MFA" policy for Clerk users. Whatever we offer SSO users should be stated as the same policy, not a new weaker or stronger one.

---

## 3. Direction 1: delegate the password check to the IdP

### 3.1 Okta (two real routes, one legacy)

**A. Direct authentication, password grant. Best fit.** `[doc]`

- `POST https://{org}.okta.com/oauth2/v1/token` (org authorization server; a custom server is `/oauth2/{id}/v1/token`) with `grant_type=password&username=…&password=…&scope=openid&client_id=…`. A native-app integration is a public client: **no client secret to store**.
- Okta describes direct authentication as letting a client "directly verify user credentials and authentication factors without relying on browser interactions" and says to use it "where there's a high degree of trust". Enabling the direct-auth grants needs **super admin**.
- MFA: the token endpoint "can't grant a token until the client's app sign-in policy is satisfied." When the policy wants more, Okta answers `mfa_required` (plus an `mfa_token`), and the client continues with the OTP or out-of-band grants. For IMAP that continuation is unusable: there is no field for a code at every reconnect.
- Rate limit: Okta limits password validation to **4 requests per second per username** on endpoints that accept a password, explicitly including the OAuth password flow. `[sum]` of an Okta support article; the same 4/s per user appears on the Okta rate-limit page snippet. Org-wide buckets also apply.
- Failed passwords count toward the org's account-lockout policy. `[mem]` (standard Okta password policy; `[probe]` that ROPG failures show in the System Log and increment lockout).
- Customer setup: create a native app integration, enable the password grant for it, add an app sign-in policy rule, assign users. We store: org URL and `client_id`. Nothing else.

**B. LDAP Interface.** `[doc]`

- Okta's cloud LDAP proxy: "uses Universal Directory for authentication", "a cloud proxy that consumes LDAP commands and translates them to Okta API calls". Operations: BIND, UNBIND, SEARCH only. **TLS 1.2 only, LDAPS or StartTLS required**; an unencrypted connection is rejected. Authentication goes through the Okta sign-on policy.
- MFA is supported in the password field: `password,123456` for an Okta Verify code, `password,push` for push, and if the user is enrolled in Verify Push and sends no suffix "the push notification is sent automatically". SMS and voice need the code generated before the bind. Factors: Okta Verify push and OTP. Okta's support article says not to use Duo here.
- Consequence for IMAP: every reconnect of a push-enrolled user fires a push. Apple Mail reconnects constantly. That is a push-fatigue machine. The credcache (60 s) softens it but does not remove it.
- Known limitation that matters: "the reported IP address is the appserver IP rather than the client IP", so Okta's own IP-based policy and risk see our egress, not the user. (Good for the zone idea below, bad for Okta's anomaly detection.)
- We store: org name only. The user's bind DN comes from the app's sign-in mapping (`[probe]` exact DN shape and whether the user must be assigned to the LDAP Interface app).

**C. `POST /api/v1/authn` (primary authentication).** Legacy. `[doc]` Okta treats it as a Classic-Engine API, says new apps should use the Identity Engine flows, and notes it does not support Multiple Identifiers and some Identity Engine setups. No removal date was found. Do not build on it.

**Federated Okta users.** An Okta user who is routed to another IdP (Entra, Google) has no Okta password. All three routes fail for them. Okta documents delegated authentication for LDAP-sourced users only.

**The scoped-exemption trick (the main mitigation worth designing).** The only way password-only works with a customer that enforces MFA is an app sign-in policy rule for the mail app that asks for the password alone. Make that rule apply **only from i10's static egress IPs** (an Okta network zone). Then a stolen password is useless directly against Okta for this app: the attacker has to come through authd, which throttles. MFA is not removed for the person's other apps. Cost: i10 needs stable egress IPs for authd's calls. Whether that ties into the parked egress-IP decision (#304) is for the owner.

### 3.2 Microsoft Entra ID (ROPC)

`[doc]` Microsoft's page (page metadata updated 2026-06-15; body last updated 2025-02):

- `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`, `grant_type=password`, `username` = UPN, `password`, `client_id`, `scope`. Public client, no secret. Tenant-specific or `organizations` only; `common` and `consumers` are refused.
- "Microsoft recommends you do not use the ROPC flow; it's incompatible with multifactor authentication (MFA)." "If users need to use MFA to log in to the application, they will be blocked instead."
- Not supported: personal accounts, accounts without passwords (SMS, FIDO, Authenticator sign-in), passwords with leading or trailing whitespace, and **federated users** (AD FS and other on-premises IdPs) because Entra cannot test the password against the other IdP. Pass-through authentication works. Exception: a Home Realm Discovery policy with `AllowCloudPasswordValidation = true` lets federated users work when the on-prem password is synced to the cloud.
- Consent: the app needs consent for the scopes ahead of time or the call returns `consent_required`.
- Status in 2026: **not removed, not deprecated, actively discouraged.** Microsoft's mandatory-MFA programme (Azure portal, Azure CLI, PowerShell, ARM writes) does not name custom apps, but Microsoft's own migration advice is that "applications and test rigs relying on ROPC will be locked out" as MFA spreads.
- Why this is weak for us: new tenants start with **Security Defaults** (MFA for everyone). A tenant using Security Defaults cannot also use Conditional Access exclusions; to exempt our app the customer must turn Security Defaults off and write a CA policy that excludes it. That is a security downgrade a sensible admin will refuse.
- Lockout: failed ROPC attempts and Entra smart lockout. `[probe]` A Microsoft Q&A answer reports no lockout after 10 bad ROPC attempts on a cloud-only tenant; that is anecdotal and must be measured.
- Errors to map (AADSTS, `[mem]`, verify): `50126` bad password, `50076` and `50079` MFA required or MFA enrolment, `50053` locked, `50057` disabled, `50055` password expired.
- Cheap read-only pre-check: `GET https://login.microsoftonline.com/common/userrealm/{upn}?api-version=1.0` returns `NameSpaceType` Managed or Federated with no authentication. Use it at setup time to tell the admin "ROPC will not work for this domain".
- Alternative: Entra Domain Services secure LDAP. `[mem]` Needs a managed domain, password hash sync, and cloud-only users must reset passwords after it is enabled. Heavy for the customer and not "their IdP password" in the live sense. Not recommended.

### 3.3 Google Workspace (Secure LDAP)

`[doc]` Google's Secure LDAP FAQ (updated 2026-10-26):

- "There's no impact on using Secure LDAP … because third-party identity providers affect only HTTP-based transactions such as SAML-based authentication." And: "make sure they know their **Google user name and password**, as these credentials (not their third-party identity provider credentials) are needed for authentication. Users cannot access Secure LDAP applications by signing in through a third-party IdP using SSO."
- So for a Google tenant that federates to Okta or Entra, Secure LDAP does **not** deliver "their IdP password". It only fits a Google-native workspace where people really have and know a Google password.
- Editions: Frontline Standard and Plus; Business Plus; Enterprise Standard and Plus; Education Fundamentals, Standard, Plus; Enterprise Essentials Plus. One page in the same help set says "the user must have a Google Workspace Enterprise or Cloud Identity Premium license". The two disagree; `[probe]` on the i10.tech tenant.
- Client authentication is **mutual TLS with a certificate generated in the Admin console** (`ldaps://ldap.google.com:636`); optional access credentials exist (max two active). So we would hold a client certificate and key per customer: a connection secret, not a user secret. Acceptable under the principle, but it is the first thing in this report that we would have to protect like a key.
- Bind methods: SIMPLE, SASL PLAIN, SASL EXTERNAL; user bind DN is the email. `[sum]`
- Quota: about 4 queries per second per customer, and Google warns that heavy use "might cause you to exceed daily quotas on SLDAP queries". `[sum]` `[probe]` Real numbers on the error-code page. Our credcache is essential here.
- 2SV: Google's pages are silent on how Secure LDAP treats a user with 2-Step Verification. A community report says binds fail every time for users with 2SV enforced `[sum]`. If true, Google-native + MFA = no password lane. `[probe]` this first; it decides whether Google gets this lane at all.
- No password grant exists in Google's OAuth. `[mem]` There is no other documented "verify this user's password" API for Workspace.

### 3.4 Generic SAML and OIDC IdPs

Impossible. SAML and OIDC are redirect protocols; the IdP's password check is behind its own login page. The only routes are an LDAP surface (JumpCloud, Ping, AD, Authentik, Keycloak with LDAP, and so on, already the "LDAP pass-through" in `sso.md` 2.8) or a vendor ROPC grant that the IdP happens to support and the admin turns on (Keycloak and Auth0 do; Okta and Entra covered above). We should say "not possible" in the product for any IdP without one of these.

---

## 4. Direction 2: the mail app does OAuth against us

### 4.1 What Stalwart 1.0.3 gives us `[doc]`

- Its own OAuth server: authorization code + PKCE S256, refresh tokens, device code, RFC 7591 dynamic registration at `/auth/register`, RFC 8414 metadata, RFC 9207 `iss` parameter. Authorization endpoint is `/login`; the sign-in form posts to `/api/auth`. SASL `OAUTHBEARER` and `XOAUTH2` on IMAP, POP3, SMTP and ManageSieve, **only over TLS**; the token needs the `mail` scope.
- **Who authenticates at `/login`?** The directory: a password typed into Stalwart's form is checked by the directory. With our LDAP directory that is authd, so an SSO person has no password to type. Stalwart's page is not a federation point. 2FA exists only for the internal directory.
- PACC (`/.well-known/user-agent-configuration.json` on `ua-auto-config.<domain>`, digest in a `_ua-auto-config` TXT record) advertises OAuth for domains of the built-in server (internal, LDAP and SQL directories advertise Stalwart's own issuer) and password-only otherwise. Autoconfig and autodiscover cannot advertise OAuth; a maintainer says they are frozen in favour of PACC.
- Tokens from an **external** issuer (an `Oidc` directory): JWT validated offline against the issuer's keys (HMAC refused), or opaque via introspection or UserInfo; audience must match a server resource id or `acceptedAudiences`; `claimUsername` must be in every access token; accounts are created on first sign-in, so **mail for an unknown address is rejected** unless accounts are pre-created. Issuers with a `{tenantid}` placeholder are not supported.
- The Oidc directory **has no password check at all** ("None: clients sign in at the provider"). A domain served by it cannot do SASL PLAIN. So it is a replacement, not an addition, for a domain. Per-domain directory assignment is an **Enterprise** feature (Stalwart's Enterprise page lists per-domain directories; SCIM is also Enterprise). After an external token validates, the account's domain must be served by that same directory, so you cannot keep LDAP as the domain's directory and also accept Okta-issued tokens for it. Price is a per-mailbox slider; Open Collective shows tiers from about $300 per year. `[sum]`
- Net: the external-issuer route (customer's IdP issues the mail token directly) forces an SSO workspace's domain to tokens-only, killing Outlook and Apple Mail-with-password for it. Worse than LDAP pass-through for every non-OAuth client. Keep it only as a deliberate "SSO-only mail domain" product choice, never the default.

### 4.2 How SSO users could still use Stalwart's own issuer `[probe]`

Stalwart's `/login` cannot redirect to an IdP. Three ways to make the browser step federate, none confirmed:

1. **Front `/login` and `/api/auth` with our own page** (Traefik routes those two paths to an i10 service; `/auth/token`, `/auth/register`, the metadata and JWKS stay on Stalwart). Our page does Clerk or SSO sign-in with step-up. Then it must obtain an authorization code that Stalwart's token endpoint will redeem. That needs an admin or impersonation call that mints a grant for an account. Stalwart's FAQ mentions an `impersonate` permission used to create app passwords through JMAP; whether an equivalent mints OAuth codes is unknown. **Probe on a dev Stalwart before choosing.**
2. **Run our own authorization server** (issuer `auth.i10.tech`, we already own sign-in, SSO, MFA and step-up) and point an `Oidc` directory at it. Same drawback as 4.1: replaces the domain's directory, no password lane, Enterprise per-domain, no recipient lookup. Rejected for the same reasons.
3. **Single-use login code in the `/login` password field** (user gets it from the i10 console after SSO + MFA, pastes it into Stalwart's page; authd accepts it once for a bind). It works with no Stalwart change but needs a short-lived hashed secret and an extra manual step. It is a one-time, minutes-long credential that never reaches the mail app (the app keeps a refresh token), which is a different animal from an app password, but it is still a stored secret. Listed for completeness; not recommended.

### 4.3 Client matrix (custom domain, 2026)

| Client | Password (SASL PLAIN) | OAuth to a custom IMAP server | Notes |
|---|---|---|---|
| Thunderbird desktop 156+ (released 2026-09-15) | yes | **yes, manual**: custom OAuth with issuer id and client fields for IMAP and POP3 (155 added IMAP and SMTP) `[doc]` | Not auto-discovered: Mozilla autoconfig XML cannot advertise OAuth. User or admin policy supplies issuer and client. Exact fields and whether it does dynamic registration `[probe]` |
| Thunderbird for Android / K-9 | yes | `[probe]` no evidence found for generic custom OAuth; its OAuth is a built-in provider list | Open |
| Apple Mail, macOS and iOS | yes | **claimed yes against a conforming server** by Stalwart's docs ("Apple Mail … still fails against a non-conforming provider"); PACC and the OAuth public-client profile are co-authored by Apple `[doc]`. No Apple documentation or release note found confirming it `[probe]` | The MDM Mail payload has no OAuth keys (Password, MD5, NTLM, HTTP-MD5 only). The Exchange payload does have `OAuth`, `OAuthSignInURL`, `OAuthTokenRequestURL`, but that means running an ActiveSync server |
| Outlook classic, new Outlook, Outlook mobile | yes | **no** for non-Microsoft, non-Google IMAP `[sum]` | Microsoft support pages tie OAuth to Microsoft servers; no source shows generic XOAUTH2 |
| Gmail app (third-party account) | yes (IMAP) | **no** for generic servers `[sum]` | Third-party account support still exists in the mobile app; Gmailify and POP are going away |
| eM Client, Spark, BlueMail, Mailspring, FairEmail, Evolution | yes | not established. Mailspring, FairEmail, Evolution and Thunderbird are listed as OAuth-capable in general `[sum]` | `[probe]` per client for custom issuers |
| Fastmail-style JMAP apps (Ltt.rs, Mailtemi) | n/a | JMAP + Stalwart dynamic OAuth, per the Mailtemi developer `[sum]` | Niche |
| Any desktop client via a local OAuth proxy (`email-oauth2-proxy`) | proxy speaks plain to the client | proxy does OAuth upstream | Desktop only, user installs it, tokens live on the device. Not for phones |

Stalwart's `device_code` grant exists, but no mainstream mail client uses it for IMAP (already established; nothing found to challenge it).

---

## 5. Direction 3: ActiveSync, EWS, JMAP

- **Exchange ActiveSync with OAuth.** Apple's Exchange payload exposes `OAuth`, `OAuthSignInURL`, `OAuthTokenRequestURL`; Outlook mobile and iOS Mail accept Microsoft endpoints natively. Pointing them at our endpoints is technically a profile setting, but we would have to implement an ActiveSync server and a profile delivery path. Stalwart does not implement EAS or EWS (not found in its docs; `[probe]` to confirm). Months of work for a protocol Microsoft is steadily removing from third-party reach. Reject.
- **JMAP-native apps.** Stalwart speaks JMAP with the same OAuth server. Real but few clients (see matrix). Worth supporting through the same lane for free; not a coverage answer.
- **Local OAuth proxy** is a user-side workaround for desktop only. A line in the help centre, not a product feature.

---

## 6. Options by what they give

| # | Option | Works with IdP MFA | Clients covered | Customer setup | What we store | Main risk |
|---|---|---|---|---|---|---|
| A | Okta password grant (direct auth) in authd | Only if the mail app's sign-in policy is password-only (ideally from our IPs); else `mfa_required` = blocked | All (SASL PLAIN) | Super admin: native app, password grant, policy rule, assign users | Org URL, public `client_id`, zone | Okta lockout from stale mail clients; weakened MFA for that one app |
| B | Okta LDAP Interface | Yes via `password,code` / `,push`, but impractical per reconnect | All | Enable interface, policy, assign users | Org name | Push fatigue; same lockout |
| C | Entra ROPC | No (AADSTS50076); only with a CA exclusion and Security Defaults off | All | App registration, consent, CA exclusion, tenant not federated | Tenant id, public `client_id` | Microsoft discourages it; dies as MFA spreads; federated domains impossible |
| D | Google Secure LDAP | Unknown for 2SV (reports say it fails) | All | Edition, enable service, mTLS cert, users know the Google password | Client cert + key per customer | Wrong password for SSO-federated tenants; 4 qps per customer |
| E | LDAP pass-through to a customer directory (AD, JumpCloud, Ping) | No MFA on LDAP binds | All | Expose LDAPS, service account | Host, bind creds | Customer exposes a directory to the internet |
| F | Stalwart's own issuer + PACC, authorize step federated to Clerk/SSO | **Yes, full** (browser does MFA) | Thunderbird 156 (manual), Apple Mail (to verify), JMAP apps. Not Outlook, not Gmail app | None beyond the SSO connection | Nothing new (refresh tokens live in Stalwart's store, as for any OAuth) | Needs the code-mint answer from 4.2; Stalwart `/login` is not a federation point |
| G | External OIDC directory (customer IdP issues mail tokens) | Yes | Same OAuth clients, **no** password clients | Register a public client and an API in the IdP | Issuer config | Replaces the domain's directory; Enterprise; no recipient lookup |
| H | Local OAuth proxy | Yes | Desktop only | User installs a tool | Tokens on the device | Support burden |
| I | ActiveSync / EWS server | Yes | Outlook, Apple Mail | Profile install | n/a | Months of work |
| J | Per-device passwords (rejected, for scale) | n/a | All | None | Hashes | Breaks the principle |
| K | One-time code pasted at `/login` | Yes (MFA done in console) | OAuth-capable clients only | None | Hashed code, minutes TTL | A stored secret after all |

---

## 7. Security: what goes wrong and what authd must do

1. **Credential stuffing becomes our problem against someone else's IdP.** An open IMAP port is a password oracle for the customer's company account. authd cannot rate-limit by source IP (it never sees one). Use Stalwart's own failed-auth IP banning (`[probe]` the exact 1.0.3 setting) and keep authd's per-DN bucket. Set the per-user IdP budget well **below the IdP's lockout threshold** (Okta and Entra defaults are about 10).
2. **Lockout amplification.** The thing Clerk spared us does not hold here. A phone with a stale saved password retries every few minutes and can lock the person out of Okta, Entra or Google for the whole company. Mitigations, cheapest first:
   - Remember the HMAC of the **last rejected password per user** for about 15 minutes; an identical retry is answered `invalidCredentials` locally with no IdP call. The README's rule against caching rejections protects a *corrected* password from being blocked; keying on the exact password keeps that safe, because the corrected one has a different HMAC.
   - A per-user failure budget (for example 3 distinct wrong passwords per 15 minutes) after which authd answers `busy` (51) without calling the IdP.
   - Respect the 4/s per username Okta limit and Google's 4 qps per customer with a per-workspace limiter, not just the per-DN one.
3. **Never turn "password right, MFA required" into success.** Okta's `mfa_required` and Entra's `50076` both mean the password was correct. Mapping that to `Verified` would let anyone with a stolen password into the mailbox and silently remove the customer's MFA. Map it to rejected, mark the user `mfa_blocked`, and log it distinctly. (The scoped policy in 3.1 is the legitimate way to get a password-only path.)
4. **Graceful MFA handling.** Mail clients cannot show a message. So handle it before the bind: at connection setup, probe once with the admin (Entra `userrealm`; Okta policy GET) and show "mail passwords will not work for MFA-required sign-in; use X" in the console; on the first `mfa_blocked`, email the person once with the right setup (Thunderbird OAuth, webmail, the i10 app). Do not answer `invalidCredentials` forever with no explanation.
5. **Outage semantics carry over.** Okta 429 (`E0000047`), Entra throttling, Google quota, any 5xx or timeout: `Unavailable` (52), never 49. Add a circuit breaker per workspace so one IdP outage does not hold LDAP worker threads for 5 s each.
6. **Phishing and consent.** Open dynamic registration (RFC 7591) lets anyone register a client named "Outlook". Stalwart shows a verification status on the consent page; keep it visible, restrict redirect URIs to loopback and private-use schemes as the profile requires, and put the issuer and client name in the confirmation email. Device code is the most phishable grant; leave it unadvertised.
7. **Secrets we would hold, honestly listed.** Okta org URL + public client id, Entra tenant + public client id, a Google mTLS cert and key per customer, and any LDAP service account for pass-through. Never a user password, hash or per-device secret. The credcache's in-memory HMACs already exist and should be listed in the same breath.
8. **IdP-side visibility.** Every bind appears in the customer's IdP log as a sign-in from the authd app (and from our IPs). Tell the customer admin up front; otherwise the first support ticket is "why is i10 signing in as my users".
9. **Recipient lookup is separate.** Whichever lane is used, inbound mail for SSO users already resolves through authd's projection and SCIM/directory sync. None of the password routes need to change that, which is why LDAP stays the directory (and why option G hurts).

---

## 8. Recommendation, ranked

1. **Make authd's verifier pluggable per workspace and ship Okta first (option A).** Password grant over HTTPS fits the existing `Verify` shape, stores no secret, and has a documented MFA story (the zone-scoped password-only policy). Keep B (LDAP Interface) as the fallback for customers whose policy blocks A. Both give "their password, in every client".
2. **Build the OAuth lane (option F) in parallel as the MFA-safe answer.** It is the only route that keeps MFA intact and still gives Thunderbird and (probably) Apple Mail a real sign-in. It is blocked on one fact: how a federated authorize step gets Stalwart to issue its own code (4.2). Spend one probe session on that before committing engineering time.
3. **Entra ROPC (C) as best-effort, off by default.** Offer it only after the `userrealm` check says Managed and the admin accepts the Conditional Access exclusion. Document that it ends the day their tenant tightens policy.
4. **Google Secure LDAP (D) only for Google-native workspaces whose people use a Google password, after the 2SV probe passes.** Not offered to Google tenants that federate elsewhere.
5. **Do not build:** the external OIDC directory as default (G), ActiveSync (I), any "treat MFA-required as success", per-device passwords (J), the pasted code (K).
6. **Honest remainder:** MFA-enforced people on Outlook or the Gmail app have no path that respects the principle. Say so in setup and point them to webmail, the i10 app, Thunderbird, or an admin-approved scoped exemption.

On coverage: no number can be given. There is no client-mix data for i10 yet. Cheap to get: log the IMAP `ID` command and the SMTP EHLO name that Stalwart receives (Apple Mail and Thunderbird send `ID`; Outlook usually does not) and count distinct clients per workspace before sizing either lane.

---

## 9. What this changes in earlier conclusions

- **"Apple Mail cannot do OAuth against an arbitrary IMAP server."** Weakened. Stalwart's docs imply the opposite for conforming servers, and Apple co-authors PACC (draft -04 dated 2026-10-05) and the open public client profile (draft -06, 2026-09-16, Informational). No Apple document was found. One test on a current macOS and iOS decides it.
- **`sso.md` 2.8 "Google Secure LDAP".** Needs a correction: it authenticates the Google password only. For Google-as-IdP workspaces that is the right password; for Google tenants federated to another IdP it is not.
- **`sso.md` 2.8 "no IMAP" fallback** is no longer the only alternative. Option A and option F both beat it for an Okta customer and for Thunderbird/Apple users.
- **Stalwart OIDC directory** (already rejected in the authd README) is now doubly ruled out: no password check, no recipient lookup, and per-domain assignment is Enterprise. The README's reasoning holds and is stronger.
- **authd throttle's purpose.** README: "protects the Clerk budget, not the user". True for Clerk only. For Okta, Entra and Google it must protect the user's company account. Same code, opposite job.
- **Clerk 2FA users already bypass MFA on IMAP** (section 2). Not new, but unwritten until now.
- **Thunderbird 156 detail.** The release note says "issuer ID and client secret field"; the earlier summary said "issuer + client". Treat the exact field set as unverified.

---

## 10. Open questions to probe

Read-only, safe against the test tenants now:

1. Entra: `GET https://login.microsoftonline.com/common/userrealm/{user@domain}?api-version=1.0` for the Entra test domain. Managed or Federated? Also Graph `GET /policies/identitySecurityDefaultsEnforcementPolicy` and `GET /identity/conditionalAccess/policies` with a read-only admin token: are Security Defaults on?
2. Okta: `GET /.well-known/openid-configuration` and `/.well-known/oauth-authorization-server` on the integrator org (`grant_types_supported`); `GET /api/v1/policies?type=OKTA_SIGN_ON` and `ACCESS_POLICY`; `GET /api/v1/apps` to see whether an LDAP Interface app exists; `GET /api/v1/authorizationServers`. Drive via `/api/v1` with the admin-page xsrf, as in the existing notes.
3. Google: which edition is the i10.tech tenant on (Admin console > Billing, read only)? Is Secure LDAP listed?
4. Stalwart (dev instance, no prod): `GET /.well-known/user-agent-configuration.json` on `ua-auto-config.<domain>` with the LDAP directory. What does it advertise? Does `/.well-known/oauth-authorization-server` pass the open-public-client checklist (DCR, S256, `none`, `iss` parameter, interoperable scopes)?

Needs a change (do not run without a go-ahead; the Okta integrator org has a standing "throwaway, any change" note, Entra and Google do not):

5. Okta: create a native app with the password grant; call `/oauth2/v1/token` with a good password, a bad password, and a user whose policy wants MFA. Record status and error body, the System Log event, and whether failures count toward lockout (lock a throwaway user on purpose). Repeat with the zone-scoped password-only rule.
6. Okta LDAP Interface: exact bind DN, whether an unassigned user can bind, push behaviour on reconnect, rate-limit headers.
7. Entra: register a public client; ROPC with a good password, bad password, MFA-required user, a federated domain; does a failure increment smart lockout (`signInActivity`, `lockoutTime` in Graph)?
8. Google: enable Secure LDAP, bind a user with and without 2SV enforced. This one result decides lane D.
9. Stalwart dev: (a) can an admin or service principal mint an authorization code or token for an account (the 4.2 question)? (b) with an `Oidc` directory as default and an Enterprise licence in a scratch instance, does issuer-matched routing accept the token for a domain served by LDAP, or does the post-validation domain check refuse it? (c) which failed-auth IP ban setting exists in 1.0.3?
10. Devices: Apple Mail on current macOS and iOS against a Stalwart dev host with PACC; Thunderbird 156 custom OAuth against Stalwart (does it use dynamic registration, which fields are needed); Thunderbird Android; Outlook new on Windows and iOS Outlook with a custom IMAP host and `AUTH=OAUTHBEARER` advertised.
11. authd: confirm that a Stalwart LDAP bind carries no client IP, so the IP limit has to be Stalwart's.

---

## Sources

Vendor and standards pages read for this report (accessed 2026-11-06 and 2026-11-07; Firecrawl caches were from 2026-11-05 and 2026-11-06 unless stated):

- Stalwart, OpenID Connect directory: https://stalw.art/docs/auth/backend/oidc/
- Stalwart, directories overview and per-domain directories: https://stalw.art/docs/auth/backend/
- Stalwart, sign-in FAQ (OAUTHBEARER, app passwords, 2FA only for internal): https://stalw.art/docs/faq/sign-in/
- Stalwart, OAuth endpoints and metadata: https://stalw.art/docs/auth/oauth/endpoints/
- Stalwart, Enterprise edition: https://stalw.art/docs/server/enterprise/
- Stalwart, autoconfig and PACC: https://stalw.art/docs/server/autoconfig/
- Microsoft, ROPC (page metadata updated 2026-06-15): https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth-ropc
- Microsoft, mandatory MFA plan: https://learn.microsoft.com/en-us/entra/identity/authentication/concept-mandatory-multifactor-authentication
- Microsoft, smart lockout: https://learn.microsoft.com/en-us/entra/identity/authentication/howto-password-smart-lockout
- Okta, direct authentication concept: https://developer.okta.com/docs/concepts/direct-authentication/
- Okta, configure direct authentication: https://developer.okta.com/docs/guides/configure-direct-auth-grants/aotp/main/
- Okta, LDAP Interface overview: https://help.okta.com/en-us/content/topics/directory/ldap-interface-main.htm
- Okta, LDAP Interface MFA: https://help.okta.com/en-us/content/topics/directory/ldap-interface-mfa.htm
- Okta, LDAP Interface known limitations: https://help.okta.com/oie/en-us/content/topics/directory/ldap-interface-limitations.htm
- Okta, Authentication API (legacy): https://developer.okta.com/docs/reference/api/authn/
- Okta, password validation rate limit (support article, snippet only): https://support.okta.com/help/s/article/What-is-the-Rate-Limit-for-Password-Validation?language=en_US
- Google, Secure LDAP FAQ (updated 2026-10-26): https://knowledge.workspace.google.com/admin/apps/faqs-secure-ldap-service
- Google, about Secure LDAP: https://knowledge.workspace.google.com/admin/apps/about-the-secure-ldap-service
- Google, connect LDAP clients: https://knowledge.workspace.google.com/admin/apps/connect-ldap-clients-to-the-secure-ldap-service
- Thunderbird 156.0 release notes (2026-09-15): https://www.thunderbird.net/en-US/thunderbird/156.0/releasenotes/
- IETF, OAuth Profile for Open Public Clients, draft-ietf-mailmaint-oauth-public-06 (2026-09-16): https://datatracker.ietf.org/doc/draft-ietf-mailmaint-oauth-public/
- IETF, PACC, draft-ietf-mailmaint-pacc (-04 per search result, 2026-10-05): https://datatracker.ietf.org/doc/draft-ietf-mailmaint-pacc/
- Apple, Mail payload settings (no OAuth fields): https://support.apple.com/en-kg/guide/deployment/dep9c14bfc5/web
- Apple, Configuration Profile Reference (Exchange payload OAuth keys, snippet): https://developer.apple.com/business/documentation/Configuration-Profile-Reference.pdf
- email-oauth2-proxy (local OAuth bridge): https://github.com/simonrob/email-oauth2-proxy

Only seen as search summaries, not read at source (tagged `[sum]` above): Google Secure LDAP bind quota and 2SV failure report (Reddit r/sysadmin), Okta 4/s per-user limit, Outlook and Gmail app third-party OAuth limits, Mailtemi/JMAP, Stalwart Enterprise pricing tiers, Microsoft Q&A on ROPC lockout.

Repo files read: `services/authd/README.md`, `services/authd/internal/ldapsrv/bind.go`, `services/authd/internal/clerkauth/clerkauth.go`, and `docs/decisions/sso.md` from `origin/fix/sso-setup-friction` (2.8 mail, 2.9 Google).
