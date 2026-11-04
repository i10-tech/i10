# Our SSO console experience, audited (2026-11-04)

Branch `fix/sso-setup-friction`. Read-only audit; no code changed. Paths are relative to `apps/console` unless they start with `packages/` or `apps/api`. Counts are read from the code (what the UI forces), not from a recorded session; where I infer behaviour I say so.

Files read: `app/(app)/settings/security/{page,[id]/page,audit/page}.tsx`, every file in `components/sso/`, `lib/sso-*.ts`, `lib/step-up.tsx`, the settings and account layouts and pages, `components/{provider-mark,connect-progress,detection-panel,add-domain-form,steps,team-access}.tsx`, `lib/dns-connect.ts`, `packages/ui/src/components/motion-tokens.ts`, `packages/ui/src/components/i10/*`, `apps/api/src/identity/{oidc,saml}-presets.ts`, `features.ts`, `docs/decisions/sso.md` 2.10.

---

## 1. Flow walk

### 1.0 Shared structure (what every provider goes through)

The stages, as the code forces them:

1. **Prove a domain** (prerequisite, on a different page). `/settings/team` > "+ Add domain" dialog (`components/team-access.tsx:200-286`): choose "Another domain, proved with a TXT record" or an already verified sending domain (`:220`), type the domain (`:262`), Add. Then a row shows "Add this TXT record at your DNS provider, then verify" with two `CopyField`s (Name, Value; `:409-410`) and a Verify button (`:412`). The DNS edit happens outside i10.
2. **Open the wizard.** `/settings/security` (`app/(app)/settings/security/page.tsx:34`), "New connection" button (`components/sso/connections-panel.tsx:105-112`). A dialog opens; the page does not change.
3. **Wizard, three dialog steps** (`connections-panel.tsx:137`, `:235-376`): `domain` > `idp` > `name`. Create fires `createSsoConnection` then, if a domain was chosen, `addSsoDomain` (`:199-206`), then `router.push('/settings/security/[id]')` (`:228`).
4. **Connection page**, status `draft`, tab `Setup` (`components/sso/connection-page.tsx:33`, `:176-208`). Fill in the IdP's values (OIDC form or SAML form, `idp-setup.tsx`).
5. **Start testing** (header button > ConfirmDialog; `connection-page.tsx:38-43`, `:262-280`). `draft` > `testing`.
6. **Test tab > "Start a test"** (`test-runs.tsx:73-77`). A native (full page) navigation to `${authOrigin}/sso/test-run`, then to the IdP, then back to `?tab=test#sso_test=passed` (`test-runs.tsx:40-52`, `:59-65`).
7. **Activate** (header button > ConfirmDialog with the generated summary; `connection-page.tsx:46`, `:283-292`). `testing` > `active`. Step-up is required (`lib/sso-authorization.ts:12-18`: `patch.status === "active"`).
8. **Make it actually usable** (not part of the "Activate" step, and not hinted at by it): Access tab > Enforcement select (default `off`, `apps/api/src/db/identity.ts:76`) and JIT toggle (default false, `:77`). With both at default, an active connection offers itself to nobody (`shared.tsx:55`: "Nobody is offered this connection at sign-in.") and creates no accounts.
9. **Optional hard line: require SSO.** Access tab > Enforcement select > `required_domain` / `required_all` > ConfirmDialog that first fetches test runs (`access-panel.tsx:~140-155`, "Checking your test runs..."), needs a pass within 24 hours (`sso-runs.ts` `DAY_MS`), and step-up (`sso-authorization.ts:16-17`).
10. **Tell the team.** Copy "Sign-in link for your team" (`connection-page.tsx:123-129`, appears only after leaving draft).

Step-up mechanics: `useSsoCall` calls `stepUp()` (a server probe) before every write unless the caller passes `stepUp: false` (`shared.tsx:73-90`). The dialog opens only when the API answers with a reverification hint; SSO-signed-in admins are bounced through the IdP and must press the action again (`lib/step-up.tsx:78-95`). So "step-up" is an invisible server round trip on most clicks and a dialog (passkey/code, or a redirect away) on stale sessions. Writes that ask: Save settings / secret / key (all of `idp-setup.tsx` via `connectionWriteNeedsStepUp`, true once the connection is `active|disabled`; false while draft/testing), Activate, require SSO, add domain in the wizard (`connections-panel.tsx:206` passes no option, so the probe runs), most Access-tab toggles on a live connection. Not asked: create connection (`stepUp:false`, `:202`), revoke setup link, fetch metadata.

### 1.1 Okta, OIDC (the recommended path)

| Stage | Where | Decisions | Typed fields | Copy actions | Clicks | Page changes |
| --- | --- | --- | --- | --- | --- | --- |
| Domain proof (skipped if a sending domain is already verified) | `/settings/team` + DNS provider | 2 (source: sending domain vs TXT; which) | 1 (domain name) | 2 (TXT name, TXT value) | 3 (Add domain, Add, Verify) + DNS edit elsewhere | 1 in, 1 external out and back |
| Open wizard | `/settings/security` | 0 | 0 | 0 | 1 (New connection) | 1 (arrive from wherever) |
| Wizard step 1 domain | dialog | 1 (which domain, or "Continue without a domain") | 0 | 0 | 2 (radio, Continue) | 0 |
| Wizard step 2 IdP | dialog | 2 (provider among 7; protocol OIDC vs SAML, shown because Okta has both, `:305`) | 0 | 0 | 3 (radio, protocol radio, Continue) | 0 |
| Wizard step 3 name | dialog | 0 (prefilled "Okta (OIDC)", `lib/sso-setup-choices.ts:42-44`) | 0 (editable) | 0 | 1 ("Create connection") | 1 (push to `[id]`, `:228`) |
| At Okta | external | create app, grant type, redirect URI, groups claim, Federation Broker Mode, auth policy (6 bullets, `apps/api/src/identity/oidc-presets.ts:94-101`) | 1 (paste redirect URI) | 3 out of Okta (issuer, client id, secret) | many, external | 1 external out and back |
| Setup tab | `idp-setup.tsx:178-329` | 1 (Client authentication select; first item `client_secret_basic` is preselected, `:84`) | 3 required (Issuer, Client ID, Client secret) | 1 (Redirect URI, `:184`) | 2 (Save settings `:252`, Save secret `:316`) | 0 |
| Start testing | header | 1 (confirm) | 0 | 0 | 2 (button, confirm) | 0 |
| Test | Test tab | 0 | 0 | 0 | 1 (Start a test) + optionally expand a run | 3 (auth origin, Okta, back) |
| Activate | header | 1 (confirm the summary) | 0 | 0 | 2 (+ 0-3 for step-up) | 0 (step-up may leave the app for SSO admins) |
| Make it live for people | Access tab | 2 (Enforcement mode; JIT) | 0 | 0 | 4-5 (tab, select open + option, toggle) | 0 (tab = URL param) |
| Share | header | 0 | 0 | 1 (sign-in link) | 1 | 0 |

Totals, Okta OIDC, happy path with TXT-proved domain: **decisions about 12** (the ones that matter to a person: domain, IdP, protocol, auth method, start testing, activate, enforcement, JIT, plus the 2 on the domain proof), **required typed fields 4** (domain name, issuer, client id, secret; plus 1 pasted redirect URI at Okta), **copy actions 7** (2 TXT, 1 redirect URI, 3 out of Okta, 1 sign-in link), **clicks roughly 30**, **page changes 5 in-app (Team, Security, connection, test round trip x3 counted as 2 round trips) plus 2 external excursions** (DNS provider, Okta admin). Optional fields visible while doing it: Discovery URL, Scopes, MFA acr values, Secret expiry date, Name (5), none needed on the happy path.

Decisions a correct default could remove:

- Protocol (OIDC vs SAML): default OIDC when the IdP supports it; surface SAML as "My company requires SAML". Removes 1.
- Domain: preselect the only verified, uncovered domain; for Google derive it. Removes 1 in the common case.
- Name: already defaulted; the whole third wizard step can go (edit the name on the page). Removes 1 step and 1 click.
- Client authentication: default and hide under advanced for presets that support only one sane value. Removes 1.
- Start testing: ceremonial (`describe()` says "Nobody signs in through it yet. You can run test sign-ins and edit every setting." `connection-page.tsx:266`). The first successful save of a complete config could move to testing itself, or "Test" could be offered from draft. Removes 1 confirm dialog.
- Enforcement + JIT: for a first connection the sane default after a passed test is "optional" + JIT on (or ask once, in the activate dialog, in one sentence). Today these two are discovered on another tab after "Active" appears to have worked. Removes 2 hidden decisions, and a failure mode.
- Activate confirm: the summary is already a confirmation; the "Activate" button on the Test result could be the activation. Removes 1.

### 1.2 Okta, SAML

Same stages 1-3 (protocol choice: SAML) then the Setup tab (`idp-setup.tsx:438-696`), five blocks on one tab:

1. "Give your identity provider these": Entity ID (Audience), ACS URL (Reply URL), Logout URL, Metadata URL. 4 copy actions offered; Okta needs 2 (ACS, Entity ID), the Okta guide has 10 bullets (`apps/api/src/identity/saml-presets.ts:123-135`: "Name ID format Persistent, and signed assertions with RSA-SHA256", "Set Honor Force Authentication to Yes ...").
2. "Your provider's metadata": Metadata URL field (1 typed, with a 150-character hint, `:463-467`), "Upload metadata file" button, "Fetch it now" (only after the URL is saved, `:489`).
3. "Provider values": Provider entity ID, Single sign-on URL, Single logout URL (optional), Subject attribute (optional), three toggles (Sign our requests, Require encrypted assertions, Allow sign-in started at your provider), Save settings.
4. "Provider certificates": list + PEM textarea + Add certificate.
5. "Our certificate": fingerprint, PEM, "Rotate our certificate".

Counts (i10 side, after the wizard): decisions 4 (metadata URL vs file vs by hand; three toggles at defaults); required typed fields 1 (Metadata URL) or 3-4 by hand (entity id, SSO URL, certificate PEM); copy actions 2-4 into Okta + 1 out (metadata URL); clicks: Save settings, optional Upload; 5 visible blocks of which 2 (certificates, our certificate) are normally irrelevant. Page changes: same as OIDC. Add ~1 decision/typed field fewer than OIDC when metadata works, since no secret exists.

Likely defect found while reading (unverified at runtime): `SamlForm` initialises `form` once from `data` (`idp-setup.tsx:362-371`) and never resyncs after `setData(after)`. After a metadata URL or file is saved the API fills `idpEntityId`/`ssoUrl`, but the "Provider values" inputs stay as they were (blank). The next "Save settings" compares the blank form against the filled `data` (`:399-403`) and would send empty strings for fields the metadata just populated. The block's own copy promises the opposite ("Filled in from the metadata when you give us one", `:528`). Worth a runtime check before any redesign.

### 1.3 Microsoft Entra, OIDC and SAML

- Wizard identical; protocol choice shown (OIDC "Recommended").
- Guide (OIDC, `oidc-presets.ts` entra `requires`, 9 lines): single-tenant app registration, tenant issuer (not `common`), optional claims `email` AND `xms_edov`, `given_name`/`family_name`/`groups`, group object IDs, client secret only, admin consent, assign users, `auth_time`, and the onmicrosoft.com warning ("Microsoft owns onmicrosoft.com domains, so they cannot be proved here. Add your company's domain in Entra and move your members' logins to it.", `apps/api/src/identity/microsoft-domain.ts:10`). That last one is a blocker discovered only in the guide, after the domain step already asked for a domain.
- OIDC Setup tab: Issuer (hint "Looks like https://login.microsoftonline.com/<tenant id>/v2.0"), Client ID, secret, secret expiry (more relevant here: Entra secrets expire), same counts as Okta OIDC: 3 required typed, 2 saves.
- SAML Setup tab: same five blocks as 1.2; guide has 10 bullets ("Give us the App Federation Metadata URL, not a downloaded file ...").
- Extra Access-tab block for Entra only: toggle "Use the user principal name as the email when Entra sends none" (`access-panel.tsx:~430`) and a sentence about Microsoft sign-out (`:~318`).

### 1.4 Google Workspace

- Wizard: domain (must be the Google primary domain), IdP "Google Workspace", protocol choice (OIDC or SAML; OIDC is the one-click), name.
- Setup tab OIDC (`idp-setup.tsx:184-201`): still shows "Give your identity provider these: Redirect URI" (not needed for Google, i10's own client is used) and the requires list, then a block titled "Nothing to enter".
- Counts: decisions 4 (domain, IdP, protocol, enforcement/JIT), typed 0, copy 0 (+1 sign-in link), clicks about 14, page changes 3 (Security, connection, test round trip). The fewest-step path; still pays for "Start testing" ceremony and a Setup tab with nothing on it.
- Defaults that remove decisions: skip the Setup tab for Google entirely (go to Test), hide the redirect URI, derive the domain, drop the protocol question (SAML-Google is the unusual choice).

### 1.5 Custom SAML ("Another provider")

`lib/sso-setup-choices.ts:19-22` relabels `generic` as "Another provider" when it has both protocols, so the wizard shows one "Another provider" card and then the protocol picker. Guide: 3 bullets ("HTTP-Redirect binding for our AuthnRequest, HTTP-POST binding to our ACS URL." ...). Setup tab: same five SAML blocks; with no hint of what the vendor calls the fields, the user maps "Entity ID (Audience)", "ACS URL (Reply URL)" to unknown terminology. Counts: as 1.2 but metadata is less likely to exist, so typed fields 3-5 (entity id, SSO URL, certificate PEM, subject attribute, SLO) and 3 toggles with no vendor-specific guidance on which to flip.

### 1.6 Custom OIDC ("Another provider")

Guide: 2 bullets ("Discovery at <issuer>/.well-known/openid-configuration, or its URL below." "Authorization Code with PKCE S256, and email_verified in the ID token."). Setup tab: Issuer, Discovery URL, Client ID, Client authentication, Scopes, MFA acr, secret, expiry. Required typed 3; the Discovery URL field exists because the issuer may not serve discovery at the standard path; there is no "we checked discovery for you" feedback after typing the issuer. JumpCloud, OneLogin and Ping are OIDC-only presets with 1-2 bullets each (`oidc-presets.ts`); they appear in the same flat list of 7.

### 1.7 Counts at a glance

| Path | Wizard steps | Required typed in i10 | Copy actions | Decisions a person makes | Page loads (in-app) | External sites |
| --- | --- | --- | --- | --- | --- | --- |
| Okta OIDC | 3 | 3 (+1 domain) | 7 | ~12 | 5 | 2 (DNS, Okta) |
| Okta SAML | 3 | 1 with metadata, up to 4 by hand | 6-8 | ~12 | 5 | 2 |
| Entra OIDC | 3 | 3 (+1 domain) | 7 | ~12 | 5 | 2 + Entra domain move if onmicrosoft |
| Entra SAML | 3 | 1-4 | 6-8 | ~12 | 5 | 2 |
| Google Workspace | 3 | 0 (+1 domain) | 3 | ~8 | 4 | 1 (DNS), 0 at Google |
| Custom SAML | 3 | 3-5 | 6-8 | ~13 | 5 | 2 |
| Custom OIDC | 3 | 3 | 7 | ~13 | 5 | 2 |

---

## 2. Page inventory

### 2.1 Sections on `/settings/security`

All are `Section` blocks of equal visual weight (`app/(app)/settings/security/page.tsx:62-181`). Gating column: plan flags are all ON for every plan today (`apps/api/src/identity/features.ts:44-57`, `PLAN_FEATURES = {}`); the proposed split on record is Google one-click for everyone, OIDC/SAML/enforcement/JIT/group roles on Pro, SCIM, Google directory, mailboxes, SIEM, IP allowlist, long retention and staff setup on custom. Role gating is real today: `sso:manage` (admin) reads everything, `owners:manage` (owner) changes anything trust-related.

| Section (line) | Concern | Who needs it | Role | Plan flag (`identity-features.ts`) |
| --- | --- | --- | --- | --- |
| Single sign-on: connections + wizard (`:62-74`) | setup, then rare (a connection is long-lived) | the person wiring the IdP; later anyone checking health | admin creates; owner for live trust edits | `sso_oidc`, `sso_saml` (Google: `sso_google`) |
| Owner exemption (`:76-85`) | incident / rare | owners only | owner acts (two owners to turn off) | `sso_enforcement` |
| Directories (`:87-96`) | setup, then incident (conflicts, large-drop removal confirms) | IdP admin; owner | owner creates/enables; admin reads/renames/disables/revokes | `scim`, `google_directory` |
| Mailboxes (`:98-110`) | rare (leaver handling) | mail/IT admin | admin per mailbox; owner for default | `directory_mailboxes` |
| Session policy (`:112-121`) | setup | owner / security lead | owner | `session_policy` |
| Second factor (`:123-131`) | setup | owner / security lead | owner | `session_policy` (shared) |
| IP allowlist (`:133-141`) | setup, lockout incident | owner / security lead | owner | `ip_allowlist` |
| Removed people's API keys (`:143-155`) | incident / rare | admin sees; owner rotates/revokes | owner acts | no gate seen in `identity-features.ts` |
| SIEM export (`:157-166`) | setup, rare | security engineer | owner | `siem_export` |
| Audit log link (`:168-181`, route `/settings/security/audit`) | review / incident; the only daily-ish item for a security admin | admin | admin | none (retention length: `audit_retention_long`) |

Per-connection tabs (`connection-page.tsx:176-208`), all reached only from the list:

| Tab | Contents | Concern |
| --- | --- | --- |
| Setup | IdP values (OIDC or SAML forms) | setup once, incident when a secret or cert expires |
| Test | test sign-in, history, raw claims | setup, and a precondition for "required" every 24h |
| Access | Enforcement, Sign-in rules (JIT, MFA, longest session, idle), Domains, Changed logins, Group rules, Bypass list | the real ongoing policy; part setup, part incident (bypass) |
| Setup links | links for an IT contact | setup, delegated |
| Mail | LDAP pass-through for IMAP | rare, niche |

Also header-level on the connection page: lifecycle buttons, sign-in link, Universal Logout URL (Okta only, `connection-page.tsx:131-142`), session note.

Two things worth noticing: (a) "Longest session / idle" exist twice, per connection (Access > Sign-in rules, `access-panel.tsx:300-330`) and workspace-wide (Session policy), with no explanation of which wins. (b) Everything on the page is shown to a workspace with no connection at all, including Owner exemption, Directories, Mailboxes, SIEM and removed-keys, each with its own empty sentence.

### 2.2 Constraints in the data

- **Workspace-scoped**: connections, directories, mailboxes, session policy, second-factor policy, IP allowlist, SIEM, owner exemption, deprovisioned keys, audit log, verified access domains. All API routes are `/console/identity/...` keyed by tenant. Page header `Settings` + `SettingsWorkspace` switcher (`settings/layout.tsx:36-46`).
- **Person-scoped**: `/account` (name, email, password, MFA, passkeys, sessions) is explicitly "across every workspace you belong to" (`account/page.tsx:15-21`, `:73-76`). A Clerk account is one per human; an SSO-managed identity is the link between that person and one workspace's connection. Second factor policy (workspace) governs a person-scoped factor (account). Step-up is session-scoped (the person's current session) and is asked by workspace actions.
- **Shared with Team**: verified access domains live in `/settings/team` (`team-access.tsx`, TXT proof, auto-join rules) and SSO only references them; a domain belongs to one connection ("A domain belongs to one connection", `access-panel.tsx:~570`). The wizard can therefore not complete a domain proof inside itself, which is why step 1 sends people away.
- **Role split** inside one page: reading needs `sso:manage`; many writes need `owners:manage`, producing `OwnerNote` text in many places ("Only a workspace owner can do this on a live connection. Ask an owner.", `shared.tsx:178-185`). A redesign must keep the disabled-with-reason pattern or an admin cannot tell why a control is dead.
- **Lifecycle** is per connection (draft, testing, active, disabled) and changes which writes need step-up (`connectionWriteNeedsStepUp`) and which are owner-only (`isLocked`, `shared.tsx:277-285`).
- **Navigation reality**: `SETTINGS_NAV` (`lib/nav.ts:163-`) has one flat "Security" item with command-menu keywords, a hidden audit item, and a separate Account group with a single "Profile & security" item (`/account`). The rail has no sub-items; settings layout allows `max-w-3xl` (`settings/layout.tsx:53`).

### 2.3 Where each section could live (options, no recommendation)

| Option | What lives there | Pros | Cons |
| --- | --- | --- | --- |
| A. Keep one `/settings/security`, but restructure inside it (tabs or sub-routes: Sign-in, Provisioning, Policies, Logs) | all of today's sections regrouped | no nav change; deep links keep working; one admin mental model | the page is still the only door; tab bar on top of per-connection tabs is two tab levels; settings max width is 3xl |
| B. Own settings area "Single sign-on" in `SETTINGS_NAV` (connections, wizard, per-connection page) and a slimmer "Security" for workspace policies (session, second factor, IP allowlist, SIEM, audit) | two rail items | SSO setup gets its own home and onboarding emptiness; policies stop sitting under "setup"; keywords map cleanly | two items for one concept; "Directories" and "Mailboxes" need a third home or tag along with SSO; more rail rows |
| C. Provisioning as its own area (Directories, Mailboxes, Removed people's keys) | SCIM, Google directory, leaver mailbox rules, deprovisioned keys | groups by concern (people lifecycle), hides entirely until a directory exists | three sections move away from the connection that creates the need; cross-links required |
| D. Domains stay on Team, SSO consumes them; Team gets a "Domains" card that the wizard embeds or links with return state | access domains | removes the dead-end "go to the Team page first" | Team becomes heavier; return-to-wizard state needs a mechanism (sessionStorage hand-over is the existing precedent, `lib/dns-connect.ts:17-20`) |
| E. Person-scoped security (passkeys, MFA, sessions) in `/account`; workspace policies in settings | boundary follows scope | matches the data model (account page note) | Second-factor policy and owner exemption straddle both; users look for "my 2FA" in Security today |
| F. Incident tools (audit log, bypass, owner exemption, deprovisioned keys, IP lockout recovery) as a "Break glass / activity" area | audit, owner exemption, bypass list | daily vs incident separation; audit gets a nav item rather than a link | bypass list is per connection today; splitting it from its connection hides it |
| G. Progressive disclosure on the same page: show only "Single sign-on" until one connection exists; reveal the rest as a "More security settings" list | all | smallest move; fixes "shown too soon" | does not by itself fix the page's information architecture |

Options combine (B + C + F, or A + G). The structure is a decision for the owner.

---

## 3. Motion inventory

### 3.1 What animates in `components/sso` today

Grep for `motion|animate|transition|AnimatePresence|spring|ease|duration` across `components/sso` returns exactly four hits, all Tailwind defaults (no tokens, no `motion/react` import anywhere in the folder):

| Where | What | Values |
| --- | --- | --- |
| `connections-panel.tsx:83` | connection row `transition-colors hover:bg-muted/50` | Tailwind default 150ms, default ease |
| `connection-page.tsx:108` | back link `transition-colors` | same |
| `test-runs.tsx:141` | chevron `transition-transform` + `rotate-180` | same |
| `audit-log.tsx:147` | chevron `transition-transform` + `rotate-90` | same |

Inherited motion that does exist because of shared components (not authored here): Dialog enter/exit (`surface-motion.tsx`: 200ms quint-out, 8px up, 200ms exit), toasts, MorphSelect panel, Switch thumb, Button loading state, FloatingInput hint (`GrowHeight`), Tabs indicator, Badge. Every dialog in the folder (wizard, MakeLink, Revoke, NewDirectory, Conflicts, NextDialog, ShownOnce, ConfirmDialog) gets the surface motion for free; nothing inside a dialog animates when its content changes.

### 3.2 What appears or disappears with no animation

- Wizard steps swap their whole body (`connections-panel.tsx:249-344`): the dialog changes height in one frame between the domain list, the IdP list and the single field; step title/description (`:239-245`) swaps text with no transition.
- Selecting an IdP reveals the Protocol picker and the guide card (`:305-332`); choosing a provider with a long guide (Okta 6 bullets, Entra 9) makes the dialog jump taller; changing protocol swaps the bullet list.
- Setup tab: choosing `private_key_jwt` swaps "Client secret" for "Signing key" (`idp-setup.tsx:259-323`) and shows/hides the JWKS Value (`:185`); Google shows a different block set (`:197-203`).
- "Loading..." (`shared.tsx:234-241`) is a bare line in every Block, then the real content arrives and shoves everything below it. There is no skeleton in the folder.
- Test run details open and close with a conditional render (`test-runs.tsx:145`); only the chevron moves, the panel pops. Same for audit rows (`audit-log.tsx:~147`).
- Lifecycle header: buttons and the `StatusBadge` change when state changes (`connection-page.tsx:77-101`, `shared.tsx:39-45`); "Sign-in link for your team" appears when leaving draft (`:123-129`).
- Access tab: enforcement help paragraph (`ENFORCEMENT_HELP`) changes length per mode; the owner-only note, MFA capability notes, Entra-only toggle and sentence appear conditionally (`access-panel.tsx:~300-330`, `:~430`).
- Lists add/remove rows with no motion: domains, group rules, bypass entries, certificates, setup links (a new link is prepended, `setup-links.tsx:124`), directories, conflicts.
- Save feedback is a toast only; buttons use `loading` but there is no in-place "saved" state (compare `StateButton`, `Swap` used elsewhere).
- Two-step confirm (require SSO) swaps the "Checking your test runs..." line for a result line with no transition (`access-panel.tsx:~202-222`).
- Disabled-with-reason notes (`OwnerNote`) appear and disappear with the role, not state, so mostly static; but `UpgradePrompt` replaces content on a failed load with a hard swap.

### 3.3 Compared to our tokens and the domains flow

Tokens (`packages/ui/src/components/motion-tokens.ts`): durations instant .12, fast .16, exit .18, standard .24, considered .48; eases enter `[0.16,1,0.3,1]`, exit `[0.7,0,0.84,0]`, standard `[0.22,1,0.36,1]`, inOut `[0.65,0,0.35,1]`; springs responsive, gentle, snappy (visualDuration .26, bounce .12; presses/toggles), smooth (visualDuration .4, bounce 0; panels/height), morph (.42, .16; shared layout); stagger item .035; blur subtle 2, soft 4, text 8. The SSO folder uses none; its Tailwind-default 150ms `ease` is not on the token curve (`quint-out`-like).

Domains-flow patterns that already exist and fit SSO:

- `connect-progress.tsx:55-117`: `AnimatePresence initial={false}`, per row `layout="position"`, enter `opacity 0, y -4, blur(subtle=2px)` to rest on `spring.smooth` with opacity on `duration.standard` + `ease.enter`, filter cleared by `transitionEnd`; the tick pops in on `spring.snappy` from `scale .5`; current row uses `TextShimmer` and `Spinner`; reduced motion branch via `useReducedMotion` (`initial` false, `layout` off). This is the right model for a test-run progress readout and for "creating connection / adding domain".
- `add-domain-form.tsx:674-712`: advanced options open with `Reveal show spacing="pt-3"` ("a button and a Reveal, not Collapsible"); `:931-944` an `aside` that fades in (`opacity 0 to 1`) and leaves in `0.12s`; `steps.tsx`: vertical `StepRail` with dot, line that fills, answered steps folded into a card, `AutoHeight grow="animate"`, `Reveal` for done/current with `keepMounted`, `carryBetween` for a value that travels between views.
- `detection-panel.tsx`: no motion of its own; its lesson is the 44px bordered tile (`size-11 rounded-lg border bg-muted/40`) with a `size-7` mark (`:55-78`).
- `onboarding/onboarding.tsx:305`: `Stepper` from `packages/ui` with `LayoutGroup` + `StepRail`.

### 3.4 Shared primitives we already own

In `packages/ui/src/components/i10/`: `reveal.tsx` (height follows content on `spring.smooth`, blur pull, clip only while moving), `grow-height.tsx` (content length changes), `auto-height.tsx` (real animated height via ResizeObserver; carries siblings), `step-stage.tsx` (one box, `AnimatePresence popLayout`, content changes inside it; used by `create-webhook.tsx:241`, `import-contacts.tsx:111`), `swap.tsx` (status text in place, 4px rise, soft blur; used by `template-editor/shell.tsx`, `broadcast-editor.tsx`), `carry.tsx`, `page-transition.tsx`, `surface-motion.tsx` (all overlay motion strings), `state-button.tsx`, `spinner.tsx`, `status.tsx` (drawn state dot/pill with required label), `skeleton-block.tsx`, `toasts.tsx`, `copy-field.tsx`, `floating-field.tsx` (hint uses GrowHeight). Plus `packages/ui` `morph-select`, `icon-morph`, `text-morph`, `text-shimmer`.

### 3.5 Arc components installed in `packages/ui/src/components` that fit and are not used in the SSO folder

(Only `badge`, `button`, `dialog`, `radio-cards`, `morph-select`, `switch`, `tabs` are used.) Candidates: `stepper` (wizard progress, lifecycle draft/testing/active), `segmented-control` (OIDC vs SAML, the three enforcement levels), `accordion` / `expandable-card` (guide bullets, test-run details, advanced fields), `timeline` (lifecycle history, audit log, test history), `file-dropzone` (SAML metadata upload instead of a hidden `<input>`, `idp-setup.tsx:482`), `json-viewer` (replace `JSON.stringify` claims dump, `test-runs.tsx:170`), `tag-input` (scopes, acr values, IP ranges), `code-block` and `copy-button` (PEM, URLs), `password-field` / `i10/password-input` (client secret), `alert` (warnings: onmicrosoft, Entra UPN, would_lock_out), `empty-state` (zero connections, zero directories, no test yet), `progress` / `usage-meter` (setup completeness, secret/cert expiry), `hold-to-confirm` / `confirm-morph` (require SSO, delete, revoke), `text-morph` / `slot-text` (status words), `in-view-title`, `drawer` / `bottom-sheet` (guide on mobile), `combobox` (domain picker), `chip-group`, `tree-view` (group rules hierarchy is not needed, listed for completeness only). `radio-cards` already supports an `icon` slot (`packages/ui/src/components/radio-cards/radio-cards.tsx:17-18`), unused by the IdP picker.

---

## 4. The DNS provider treatment

### 4.1 How it works (`components/provider-mark.tsx`, `lib/dns-connect.ts`)

- **Source**: no asset files. `public/` holds only fonts. Marks are inline SVG path data in the component: `OFFICIAL` (`:61-78`) holds exactly one vendor-published mark, Cloudflare, copied verbatim with its own `viewBox` ("0 0 460 271.2") and two brand fills (`#FF9911`, `#FF5E1F`); `PATHS` (`:80-118`) holds 14 monochrome approximations drawn in `currentColor` (route53, digitalocean, godaddy, vercel, netlify, namecheap, azure-dns, linode, hetzner, dnsimple, squarespace, shopify, google-cloud-dns); anything else falls back to a monogram tile (two letters, `monogram()` `:121-127`, rendered `:192-201`).
- **Rules written into the file**: never redraw or recolour an official mark; approximations never take a brand colour; `currentColor` is the dark/light answer; a monogram, not a globe, is the fallback (`:3-37`, `:40-60`).
- **Size**: official marks letterbox inside a square slot (`size-7`, `:163`); approximations are `size-4` (`:185`); the monogram `size-4` with 7px text (`:196`). Callers: inline in buttons (`connect-provider-button.tsx:102`), in the add-domain provider list (`add-domain-form.tsx:819`), `publish-records.tsx:128`, and in a 44px tile with `size-7` mark in `detection-panel.tsx:55-78` ("The mark gets a tile ... gives all sixteen of them one footprint").
- **Theme**: the Cloudflare official paths carry fixed fills (orange works on light and dark); everything else follows text colour. There is no dark/light asset pair anywhere.
- **Keyed by slug** from the DNS provider registry (`providerLabel(slug)` in `lib/dns-connect.ts:106-115` maps slug to display name); the `name` prop only feeds the monogram.

### 4.2 What it takes for Okta, Entra, Google Workspace, SAML, OIDC

Marks that exist in the repo today: **Google** only, `GoogleIcon` in `packages/ui/src/components/i10/provider-icons.tsx:24` (the four-colour G with literal hex values per Google's sign-in guidance). It is the "Sign in with Google" G, not a Google Workspace logo; using it for "Google Workspace" is a brand-guideline question to settle. **Nothing for Okta, Microsoft/Entra, SAML or OIDC** (searched by file name and content). `GitHubIcon` and `AppleIcon` also exist there but are irrelevant here. `lucide-react` `KeyRound` is already used as the row icon for every connection (`connections-panel.tsx:85`), a generic stand-in.

Work to do the same treatment:

1. Extend the registry keys: add slugs `okta`, `entra`, `google-workspace`, `saml`, `oidc` (the wizard's `idp` ids are `okta`, `entra`, `google`, `jumpcloud`, `onelogin`, `ping`, `generic`; plus a protocol dimension, `lib/sso-setup-choices.ts:1-24`). Decide whether the mark belongs to the IdP (Okta) or the protocol (SAML/OIDC) on the connection row.
2. Okta, Microsoft (the four-square Entra/Microsoft mark), Google Workspace: obtain each vendor's published asset and brand terms, copy verbatim into `OFFICIAL` with its own `viewBox` and fills, per the file's own policy. Caveats to check, not assumed: some vendor marks are dark-on-light wordmarks that vanish on a black canvas, which is the exact reason the file prefers `currentColor`; if the vendor forbids recolouring, use the symbol (not the wordmark) or the monogram.
3. Generic SAML and generic OIDC have no vendor: use a neutral monochrome glyph in `PATHS` (a document-key or shield glyph), not the monogram (the monogram of "Another provider" would be "AN").
4. The file and its component are named for DNS ("A DNS provider's mark, for the Connect button"); either rename to a neutral name or add a second registry; the comments would need a revision.
5. Use sites: the wizard's IdP step through `RadioCards` `icon` (already supported), the connection list row (`connections-panel.tsx:85`, replace `KeyRound`), the connection page header (`connection-page.tsx:119`), and a 44px tile as in `detection-panel`. The tile pattern solves differing aspect ratios.
6. Cost: roughly 5 entries of SVG data plus one prop wiring per call site; the real cost is sourcing assets and brand permission for Okta, Microsoft and Google Workspace. Nothing in the repo today gives permission for any of them.

---

## 5. Visual and copy problems, ranked

Candid. The owner scores this 4 out of 10; most of that is below.

1. **Activating a connection leaves it dead, and the copy lies about it.** New connections have `enforcement: off` and `jitEnabled: false` (`apps/api/src/db/identity.ts:76-77`). The activate dialog says "About to go live with issuer or entity id X; domains Y; JIT off; enforcement Off. People at its domains can sign in through it." (`connection-page.tsx:289-291`) while `ENFORCEMENT_HELP.off` says "Nobody is offered this connection at sign-in." (`shared.tsx:55`). The goal ("my team signs in with Okta") needs two more decisions on a tab the flow never sends you to. The most damaging problem.
2. **The wizard asks the wrong question first, then sends you away.** Step 1 is a verified domain before the IdP is even chosen; with none: "You have no verified access domain yet. Prove one on the Team page first, or continue and add it later - a connection cannot go live without one." (`connections-panel.tsx:255-263`). Leaving closes the dialog and loses state. The Entra "onmicrosoft.com" blocker is revealed only in the guide, after this step.
3. **A wall of provider instructions before anything exists.** Step 2 shows "What you will set up at Okta" as a tiny 12px (`text-xs`) bullet list of up to 10 lines in a 512px dialog (`:321-332`), then the same lines return on the Setup tab (`idp-setup.tsx:188-194`, `:448-454`). Quote: "Federation Broker Mode is on by default for OIDC apps: everyone in the org can sign in, with no assignments and no dashboard tile. Turn it off under the app's Sign On tab to assign people." Accurate, unscannable, and unattached to the field it affects.
4. **The Setup tab is a technical form, not a guided step.** Four to five stacked `Block`s (`shared.tsx:134-161`), two separate save buttons for one app (Save settings, Save secret), and vocabulary straight from the specs: "Client authentication: Client secret (basic) / Client secret (post) / Private key JWT" (`idp-setup.tsx:42-46`), "Authentication context values that prove MFA (optional)" (`:245`), "Discovery URL (optional)", "Scopes (optional) ... Must include openid", "Subject attribute (optional): An immutable attribute such as an employee id, if the name id is the email.", SAML: "Entity ID (Audience)", "ACS URL (Reply URL)", "Sign our requests", "Require encrypted assertions". A 150-character hint sits under the Okta metadata field (`:465`). No field says what to do next; the only progress cue is a final sentence: "Finish these settings before you can test or activate the connection." (`:336`).
5. **The 4-state lifecycle is exposed raw and ceremonial.** Draft > Testing > Active > Disabled, with buttons "Start testing", "Back to draft", "Back to testing", "Enable again" (`connection-page.tsx:38-62`) and dialog copy like "Back to setup. It is not testable until you start testing again." (`:270`). The Test tab then says "Move it back to setup to test again." while the button is "Back to draft" (`test-runs.tsx:84`). Four words for the same state ("draft", "setup", "testing", "test").
6. **One page, ten equal sections, mostly irrelevant on day one.** Owner exemption, Directories, Mailboxes, Session policy, Second factor, IP allowlist, Removed people's API keys, SIEM export appear before a first connection exists, each with an identical heading style and its own empty text: "No directory yet. A directory keeps this workspace's members in step with your company's: people are added, changed and removed there." (`directories-panel.tsx:~82`). Setup, daily, rare and incident concerns have the same weight; the audit log is a small underlined link at the bottom (`page.tsx:174-180`).
7. **Access tab: six blocks, three of them incident tools, all visible on a draft.** Enforcement, Sign-in rules, Domains, Changed logins, Group rules, Bypass list. A first-time admin sees "Bypass list: People who may skip this connection when it is required, for when your provider is down. Every use is audited. Keep it short." and Changed logins ("Someone whose provider login changed (a renamed username or email, a recreated app) is refused until an owner approves the new one below.") before the connection has signed anyone in. Copy for Enforcement ends with a pointer to another page: "See the owner exemption on the Security page." (`access-panel.tsx:~158-160`).
8. **Tab names mean nothing to a first-timer.** "Setup links" (a link for the IT contact), "Mail" (LDAP pass-through for IMAP, `ldap.tsx`), "Access" (policy). A user looking for "invite my IT person" or "make my team use it" cannot guess which.
9. **Test result is a JSON dump.** `JSON.stringify(run.claims, null, 2)` in a `<pre>` under "What your provider said" (`test-runs.tsx:168-173`). The actually useful bits (`wouldDo`, "What to fix") are present but the pass/fail moment is a toast ("Test sign-in passed") and a changed list row; no celebration, no "next: activate" hand-off. The test starts with a full-page round trip and returns to `?tab=test`.
10. **Loading and empty states are one grey line.** "Loading..." for every Block (`shared.tsx:234-241`); every tab fetches on mount (`useRemote`), so switching tabs refetches and shifts layout. Empty copy is sentence-only: "No test run yet.", "No certificate yet.", "No link made yet.", "No key made yet.".
11. **Inconsistent patterns inside the folder.** Row lists in three styles (`divide-y rounded-lg border` for connections/certs/links/test runs, `rounded-lg border p-4` cards for directories, bare spans for Domains); headers in three scales (Section title on the page, `text-lg font-medium` for the connection name, `text-sm font-medium` for `Block`); wizard is a dialog while the rest of onboarding for domains is a vertical rail; confirmations use `ConfirmDialog` in some places and custom dialogs in others; hyphens as separators in data rows (`" - revoked: ..."`, `setup-links.tsx:82`, "Acting as - for -", `directories-panel.tsx:~244`); `StatusBadge` custom badges while `i10/status.tsx` exists.
12. **No identity for providers.** The IdP picker is seven text rows with a description of "OIDC or SAML" (`connections-panel.tsx:299-303`), the connection list uses a generic `KeyRound`. Compared to the DNS provider tile with the real mark, this is where recognition ("is that my Okta?") is lost.
13. **Disabled-with-reason sprawl.** Many controls end with `OwnerNote` ("Only a workspace owner can do this on a live connection. Ask an owner."), repeated per block; useful but noisy and the same sentence everywhere.
14. **Stale-form suspicion on SAML** (section 1.2) and the Google tab showing a Redirect URI block it never needs (`idp-setup.tsx:184`).

---

## 6. Component size and structure

### 6.1 Sizes and what must split

| File | Lines | What is inside | Split before restructuring |
| --- | --- | --- | --- |
| `components/sso/access-panel.tsx` | 921 | six independent blocks: Enforcement (+ require-SSO ConfirmDialog), SignInRules, Domains, LoginChanges, GroupRules, Bypass; constants MAX_SESSION/IDLE/RELINK_HELP | one file per block (already separate functions, `:114`, `:249`, `:374`, `:487`, `:652`, `:801`); share the `patch + replace connection` helper that is hand-copied in SignInRules and LoginChanges (`{...connection, ...result, domains: connection.domains}`) |
| `components/sso/idp-setup.tsx` | 697 | OIDC remote+form and SAML remote+form | `oidc-setup.tsx` and `saml-setup.tsx`; extract a shared "Values to give your provider" block and the guide list (duplicated `:188-194`, `:448-454`) |
| `components/sso/directories-panel.tsx` | 628 | list, `Directory` card (about 280 lines, tokens, Google delegation, conflicts, large-drop confirm), `NewDirectory`, `Conflicts` | move `Directory` and the two dialogs to their own files |
| `components/sso/connections-panel.tsx` | 378 | list, health badge, and a 255-line `NewConnection` wizard (state machine + 3 step bodies + create orchestration) | wizard into `connection-wizard/` (state, steps, create); keep list thin |
| `components/sso/mailboxes-panel.tsx` | 410 | MailboxesPanel, LeaverDefault, NextDialog (two ConfirmDialogs) | optional |
| `components/sso/connection-page.tsx` | 292 | header, lifecycle (`movesFrom`, `describe`, `activationSummary`), 5 tabs, 2 confirm dialogs | move lifecycle functions to a lib module next to `sso-authorization.ts` (pure, testable); header into its own component |
| `components/sso/ldap.tsx` | 316 | form, service account, test, pass-through | optional |

Other facts that make a restructure safe or unsafe:

- **No DOM tests exist in the repo** (memory: no DOM test environment). Pure libs do have tests: `lib/sso-authorization.test.ts`, `sso-domain-choices.test.ts`, `sso-runs.test.ts`, `sso-setup-choices.test.ts`. Move logic into those libs and keep the UI thin; add pure tests for any new default logic (e.g., auto-select domain, default enforcement).
- **State ownership**: `ConnectionPage` holds `connection` in `useState(initial)` (`connection-page.tsx:70`) and passes `onChange`; only Access blocks and the header write to it; the domains array is not returned by PATCH, hence the explicit `domains: connection.domains` carry-over everywhere. Setup, Test, Links and Mail components read the connection but keep their own `useRemote` data.
- **URL contracts that must not break**: `?tab=` values `setup|test|access|links|mail` (`connection-page.tsx:33`, `UrlTabs`); the test-run return uses `redirect_url = .../settings/security/<id>?tab=test` and a hash `#sso_test=passed|failed` (`test-runs.tsx:40-65`; consumer `apps/auth`); setup links are `${authOrigin}/sso/setup#token=<token>` (fragment never path, `setup-links.tsx:125-127`; page in `apps/auth`); the team sign-in link is `${authOrigin}/sso/<connectionId>` (`connection-page.tsx:123`, route `apps/auth/app/sso/[connection]/route.ts`); audit filter is `?user=` and `?limit=` in {50,100,200} (`audit/page.tsx:18`, `:35-36`).
- **Write-only secrets**: OIDC client secret, LDAP service secret and test password, SIEM secret key, SCIM tokens, setup links, new API keys. Forms must clear them on send (`idp-setup.tsx:154`), and one-time reveals live only in `ShownOnce` props (`shared.tsx:193-226`).
- **Behaviours encoded in small details**: `useResetOnOpen` for dialog state; wizard fetches `teamAccessDomains()` + `ssoConnections()` in an effect (`connections-panel.tsx:159-176`) because a server action in render updates the router; the OIDC `clientAuth` comparison is against stored, not shown (`idp-setup.tsx:105-108`); Entra-only and Okta-only branches key off `connection.provider`; ownership locks via `isLocked`.

### 6.2 Capability table (nothing may be lost)

Routes are relative to `/console/identity` (all `sso:manage` at least; owner-only writes noted in the API). Actions are in `lib/sso-actions.ts` and `lib/sso-policy-actions.ts`. `{c}` = `/connections/{id}`.

| Capability | Current component | API route (method) |
| --- | --- | --- |
| Who may do what (admin vs owner) | `lib/sso-server.ts:13` via `/console/me` | `GET /console/me` |
| List connections, presets, protocols | `page.tsx:49`, `connections-panel.tsx`, wizard + Domains effect | `GET /connections` |
| Create connection | wizard `connections-panel.tsx:199` | `POST /connections` |
| Rename / lifecycle / enforcement / JIT / MFA / relink / UPN-as-email / max session / idle | `connection-page.tsx:76`, `access-panel.tsx` Enforcement, SignInRules, LoginChanges | `PATCH {c}` |
| Delete a draft | `connection-page.tsx` ConfirmDialog | `DELETE {c}` |
| Add / remove a domain on a connection | wizard `:206`, `access-panel.tsx` Domains | `POST {c}/domains`, `DELETE {c}/domains/:joinDomainId` |
| Verified access domains (source for pickers) | wizard, Domains block | `GET /console/team/access-domains` (`lib/actions.ts:616`) |
| Test runs list and claims | `test-runs.tsx`, Enforcement confirm | `GET {c}/test-runs` |
| Start a test sign-in | `test-runs.tsx:59-65` (navigation) | auth app `/sso/test-run?connection=&redirect_url=` (not the API) |
| OIDC read / save settings | `idp-setup.tsx` OidcForm | `GET {c}/oidc`, `PUT {c}/oidc` |
| OIDC client secret (+ expiry) | OidcForm | `PUT {c}/oidc/secret` |
| OIDC signing key (private_key_jwt) | OidcForm | `POST {c}/oidc/keys` |
| SAML read / save settings, metadata XML | `idp-setup.tsx` SamlForm | `GET {c}/saml`, `PUT {c}/saml` |
| SAML provider certificate add / remove | SamlForm | `POST {c}/saml/certificates`, `DELETE {c}/saml/certificates/:id` |
| SAML rotate our certificate | SamlForm | `POST {c}/saml/sp-key` |
| SAML fetch metadata now | SamlForm | `POST {c}/saml/refresh` |
| Group-to-role rules | `access-panel.tsx` GroupRules | `GET/POST {c}/group-rules`, `PATCH/DELETE {c}/group-rules/:ruleId` |
| Bypass list | `access-panel.tsx` Bypass (+ `members.tsx` picker from Clerk) | `GET/POST {c}/bypass`, `DELETE {c}/bypass/:userId` |
| Changed-login (relink) requests | `access-panel.tsx` LoginChanges | `GET {c}/relinks`, `POST {c}/relinks/:id/approve|reject` |
| Setup links (list, create, revoke, shown once) | `setup-links.tsx` | `GET/POST {c}/setup-links`, `POST {c}/setup-links/:linkId/revoke` |
| LDAP pass-through (settings, service account, test, enable) | `ldap.tsx` | `GET/PUT {c}/ldap`, `PUT {c}/ldap/service`, `POST {c}/ldap/test` |
| Health badge, capabilities, Universal Logout URL, directoryState note | `connections-panel.tsx:44`, `connection-page.tsx:131-148`, `access-panel.tsx` mfa notes | fields on the connection from `GET /connections` |
| Owner exemption (read, ask off, approve, withdraw, turn on) | `owner-exemption.tsx` | `GET /owner-exemption`, `POST /owner-exemption/off-request`, `POST .../off-request/approve`, `DELETE .../off-request`, `POST /owner-exemption/on` |
| Directories (list, create, rename/enable/disable/mailbox toggle) | `directories-panel.tsx`, `directory-mail.tsx` | `GET/POST /directories`, `PATCH /directories/:id` |
| Directory check, confirm large-drop removals | `directories-panel.tsx` | `POST /directories/:id/check`, `POST .../confirm-removals` |
| SCIM tokens issue / revoke (shown once) | `directories-panel.tsx` | `POST /directories/:id/tokens`, `DELETE .../tokens/:tokenId` |
| Directory conflicts list / retry | `directories-panel.tsx` Conflicts | `GET /directories/:id/conflicts`, `POST .../conflicts/:uid/retry` |
| Directory groups and group mail | `directory-mail.tsx` | `GET /directories/:id/groups`, `PUT/DELETE /directories/:id/groups/:gid/mail` |
| Mailboxes: suspended list, next step per mailbox | `mailboxes-panel.tsx` | `GET /mailboxes`, `PUT /mailboxes/:userId/next` |
| Leaver default for mailboxes | `mailboxes-panel.tsx` LeaverDefault | `PUT /mail/leavers` |
| Session policy | `workspace-policy.tsx` | `GET/PUT /session-policy` |
| Second-factor policy | `workspace-policy.tsx` | `GET/PUT /second-factor-policy` |
| IP allowlist (with lockout confirm) | `ip-allowlist.tsx` | `GET/PUT /ip-allowlist` (422 `would_lock_out`, resend `confirmLockout`) |
| SIEM export (read, save, test, remove) | `siem-export.tsx` | `GET/PUT/DELETE /siem`, `POST /siem/test` |
| Removed people's API keys (list, rotate, revoke) | `deprovisioned-keys.tsx` | `GET /deprovisioned/api-keys`, `POST /deprovisioned/:userId/api-keys/:keyId/rotate|revoke` |
| Identity audit log (filter by person, show more) | `audit-log.tsx`, `audit/page.tsx` | `GET /events?limit=&user=` |
| Plan-gated upgrade state | `shared.tsx` `Loading` > `upgrade-prompt.tsx` | any gated route answers 403 `plan_required` |
| Step-up before sensitive writes | `useSsoCall`/`useSsoAttempt` > `lib/step-up.tsx` | server `stepUp` probe, IdP redirect for SSO admins |
| Member picker for bypass / mailbox delegate / audit filter | `members.tsx` | Clerk members (client-side, only when `CLERK_PUBLISHABLE_KEY`) |

Absent from the table by design: team access domain proof (`/settings/team`, `team-access.tsx`), account security (`/account`), billing. The redesign must keep both reachable (domain proof is a hard prerequisite of "go live").

### 6.3 Safe-restructure checklist

- Keep every route above reachable from some screen; the table is the acceptance list.
- Keep the `?tab=test` return URL and `#sso_test=` hash handler, or change both ends (`apps/auth`) together.
- Preserve write-only secret handling and shown-once dialogs.
- Preserve the admin/owner distinction and disabled-with-reason text.
- Preserve the step-up flag logic, which is pure and tested (`lib/sso-authorization.ts`).
- Move lifecycle, default-choice and activation-summary logic into pure `lib/` functions with tests before touching JSX (no DOM test environment exists).
- Verify the SAML stale-form behaviour first; if confirmed, fix it as part of the split, not after.
