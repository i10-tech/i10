# SSO admin setup in open source products: survey

Scope: how open source products build the SSO admin setup. Code was read from shallow clones (sentry, posthog, infisical, dub, grafana, mattermost, cal.com) and from public docs. Paths below are relative to each repo root. Images are in `gallery/<product>/`.

Method notes and limits:

- I could not drive the products, so page anatomy comes from code plus doc screenshots. Guesses are labelled GUESS.
- Motion: none of the products defines SSO-specific motion in the files I read. Sentry setup is server-rendered Django with Bootstrap tabs. The rest use stock design-system dialogs and sheets whose animation lives in shared components I did not read (Infisical `@app/components/v3`, PostHog `LemonModal`, Dub `Modal`, Grafana `CollapsableSection`). I give no motion values because I did not see any. Treat motion as an open gap in this survey.
- Dropped for thin SSO UI: Cal.com (SAML lives in a private ee package, the open repo only has login-side `packages/features/auth/lib/identityProviders.ts`), Plane, Twenty, Ente (not investigated further, no SSO admin UI surfaced in the time available).
- GitLab and Supabase were studied from docs only (no clone, no docs screenshots for GitLab).

## Per product

### Sentry

- **Location**: Org settings > Authentication, its own page. Route `auth/` at `static/app/router/routes.tsx:1120`; nav at `static/app/views/settings/organization/userOrgNavigationConfiguration.tsx:191`.
- **Flow**: Provider list page (`static/app/views/settings/organizationAuth/organizationAuthList.tsx:73-116`) is a single Panel titled "Choose a provider". Each row is a logo, name, one-line description ("Enable your organization to sign in with %s") and a **Configure** button (`providerItem.tsx:94-129`). Providers are sorted by a hard-coded popularity table (Google, GitHub, Okta, Active Directory, SAML2, OneLogin, Rippling, Auth0, JumpCloud; `organizationAuthList.tsx:18-28`), then plan-locked ones are sorted to the end and show a muted "disabled" tag with a lock and a hovercard (`providerItem.tsx:171-188`). Generic SAML is labelled "SAML2" with the description "your preferred SAML2 compliant provider like Ping Identity, Google SAML, Keycloak, or VMware Identity Manager" (`providerItem.tsx:68-80`).
- **Steps for SAML2** (pipeline views `src/sentry/auth/providers/saml2/generic/views.py:54-93`): (1) pick a provider (1 decision), (2) "Register Identity Provider" with three tabs, Metadata URL / XML / IdP Data (`generic/templates/sentry_auth_saml2/select-idp.html`), (3) "Map Attributes" form (`AttributeMappingForm`, `saml2/forms.py:112`), (4) a configure page showing the SP metadata URL for the IdP. Rough cost: 1 provider click, 1 pasted URL (or 4 fields on the IdP Data tab: entity id, SSO URL, optional SLO URL, x509), attribute mapping fields, 1-3 copy actions. The pipeline puts IdP details before SP details, so an admin has to bounce between tabs.
- **After setup**: the page redirects away from the React page to a Django-rendered settings view (`index.tsx:44-59`, "window.location.replace"). That view (`src/sentry/templates/sentry/organization-auth-provider-settings.html`) stacks boxes: Login URL, Unlinked Members with "Send Reminders", General Settings (Require SSO checkbox, Enable SCIM, Default Role; `src/sentry/web/frontend/organization_auth_settings.py:58-90`), SCIM info, and a red "Disable ... Authentication" box.
- **Test step**: none in the UI. The docs end with a "success" screenshot after the first login (`gallery/sentry/05-saml2-success.png`).
- **Form factor**: full page, server rendered. Modal-style layout (`bases/modal.html`) with a "Back to Organization Settings" link.
- **Steal**: the "Unlinked members: N, Send Reminders" block is a clean way to show rollout state and the exact blast radius of enforcing SSO (template lines 33-54). Also the IdP Data tab as an escape hatch for IdPs with no metadata.
- **Bad**: the jump from a React page to a different-looking Django page; no test; setup pipeline order is IdP-first.
- Images: `gallery/sentry/01-05` from https://docs.sentry.io/organization/authentication/sso/saml2/ (the `/mdx-images/saml2-*.png` files).

### PostHog

- **Location**: Org settings > Authentication > "Authentication Domains" (`frontend/src/scenes/settings/SettingsMap.tsx:2380-2392`). Not a separate page: it is a section with a table.
- **Anatomy**: SSO is configured per **verified domain**. A table with columns Domain name, Automatic provisioning (switch), Enforce SSO (select), Integrations (SAML / OIDC / SCIM badges, green when on, muted with a lock when plan-locked, each with a tooltip) and a "More" menu (`frontend/src/scenes/settings/organization/VerifiedDomains/VerifiedDomains.tsx:153-400`). Domain verification is a TXT record modal (`VerifyDomainModal.tsx:42`).
- **Legacy flow**: "Configure SAML" opens a modal (`ConfigureSAMLModal.tsx`). **Redesign** (behind feature flag `SSO_SETTINGS_REDESIGN`, `VerifiedDomains.tsx:132`) navigates to a full scene `IdentityProviderConfigScene.tsx` titled "Configure SAML", with this order: name field ("For example, Okta production"), copyable SP values (ACS consumer URL, Relay state, Audience / entity ID), then 3 typed fields (ACS URL, entity id, X.509 cert with a 10-row textarea), then a divider and a "Domains" radio (All domains / Selected domains, with descriptions) plus a multiselect (`IdentityProviderDomainScope.tsx:46-82`), then Save and Cancel, and a Danger zone with a type-to-confirm delete (`IdentityProviderConfigScene.tsx:204-270`). `SAMLConfigFields.tsx:51-56` shows a blue banner: "SAML remains disabled until you enter the ACS URL, entity ID, and X.509 certificate. You can save a partial configuration."
- **Enforcement**: per domain `SSOSelect` (`SSOSelect.tsx:21-80`): options "Don't enforce", Google, GitHub, GitLab, SAML, OIDC, each with an icon, and unavailable ones disabled with the reason "This provider is not configured." This is the only product here where enforcement is a choice of which provider, not a boolean.
- **Steps**: add domain (1 typed field) > add TXT record (1 copy) > verify > configure SAML (3 copies from PostHog, 3 pastes, 1 name, 1 scope choice). No provider picker, no logos for IdPs, no test step.
- **Steal**: the Integrations badge column (state of SAML, OIDC, SCIM at a glance with tooltips); partial save allowed with an honest banner; domain scope radio with descriptions; type-the-name-to-delete.
- **Bad**: everything is per domain, so the first-time mental model (domain first, then IdP, then enforcement select in a table cell) is heavy; two parallel UIs (modal and scene) behind a flag; the enforce control sits in a table cell far from the IdP config.
- Images: none retrievable. The docs page https://posthog.com/docs/settings/sso had only generic Cloudinary art. `identityProviderConfigLogic`/stories could render it but I did not run anything.

### Infisical (strongest reference)

- **Location**: Organization settings > Security tab > SSO, section `OrgSsoTab` (`frontend/src/pages/organization/SettingsPage/components/OrgSsoTab/OrgSsoTab.tsx`). Own tab in settings, two-column grid: left column holds provider card and Email Domains, right column holds the Enforcement card (`OrgSsoTab.tsx:430-470`).
- **Empty state**: one card "Connect an Identity Provider" with an Empty block, "No identity providers connected", and the copy "Verify a domain first to add a connection." when no email domain exists (`OrgSsoTab.tsx:346-376`). An info Alert "Email domain verification required" tells you to verify a domain before configuring an IdP (`OrgSsoTab.tsx:88-97`). So domain-first ordering is explicit.
- **Protocol picker**: Dialog "Add Identity Provider", "Pick a protocol to configure.", RadioGroup of SAML / OIDC / LDAP rows, each with a one-line description ("Standard enterprise SSO - Okta, Azure, Google Workspace"), and a primary Connect button disabled until a choice is made (`OrgSsoTab.tsx:503-557`). No logos at this level. "Switch Method" in the card menu reopens the chooser with the current protocol excluded, and a confirm dialog warns that the current config will be cleared (`OrgSsoTab.tsx:577-586`).
- **SAML config**: a right-side **Sheet** `max-w-2xl` ("Manage SAML Configuration" with a docs badge link; `SSOModal.tsx:305-316`) with sections "Identity Provider", "Certificate"-style fields and "MFA Signal" (collapsed into its own section with an "In Use" badge; `SSOModal.tsx:430-440`). Provider select options: Okta, Azure / Entra, JumpCloud, Keycloak, Google, Auth0 (`SSOModal.tsx:60-66`); picking one changes the **field labels to match that IdP's console** and adds the generic SAML term as a hint (e.g. Azure "Reply URL" with hint "ACS URL"; Okta "Audience URI (SP Entity ID)"; `SSOModal.tsx:75-160`). Section description: "Field names below match what your provider calls them." Generic SAML is the `default` branch of that switch with plain names (`SSOModal.tsx:147-157`). The docs screenshots show the older centred modal with Type, ACS URL, SP Entity ID, SSO URL, Issuer, Certificate and Update / Cancel / Delete (`gallery/infisical/05`); the Sheet is the current code.
- **Behaviour on create**: clicking Add creates an inactive config row first (`OrgSSOSection.tsx:102-117`, `isActive: false`, blank fields) so the ACS URL (which embeds the config id) exists for the admin to copy. Enable is a separate Toggle in the card (`OrgSSOSection.tsx:165-199`), so "configured" and "live" are distinct steps.
- **Enforcement** (the best of the set): a separate Enforcement card with a green "Active" badge, per-protocol toggles "Enforce SAML SSO: Members can only sign in via SAML." (`OrgGeneralAuthSection.tsx:245-300`). Enabling opens a Dialog with a warning Alert: all other methods will be disabled, password sign-up for the verified domains is blocked, make sure a break-glass admin exists. Inside the dialog is an **"Enable Admin SSO Bypass"** switch so the admin sets the escape hatch at the moment of enforcing (`OrgGeneralAuthSection.tsx:395-440`). Toggles are hidden or disabled when they conflict (Google OAuth enforced vs SAML).
- **Steps** (SAML + Okta, from docs https://infisical.com/docs/documentation/platform/sso/okta): verify domain (1 TXT), Add Identity Provider (1 radio choice), pick provider type (1 select), copy ACS URL and entity id into the IdP (2 copies), create the IdP app (outside), paste SSO URL, issuer, certificate (3 pastes), Update, toggle Enable, optional Enforce (1 dialog). No test button.
- **Steal**: provider-specific labels with a generic hint; create the inactive row first; enforce dialog with break-glass built in; domain verification as a hard precondition; "Switch Method" instead of a delete-and-redo.
- **Bad**: no test step; Sheet is dense on small screens (GUESS, not viewed); provider logos are absent in the picker; MFA Signal fields are advanced but sit in the same sheet.
- Images: `gallery/infisical/01-06` from https://infisical.com/docs/documentation/platform/sso/okta and `/google-saml` (mintlify S3). Note 02 and 03 are the IdP-side Okta screens, kept because they show Okta's numbered "needed to configure" list that Infisical mirrors with numbered values; 01 and 05 are Infisical-side.

### Dub

- **Location**: Workspace settings > Security (`apps/web/app/app.dub.co/(dashboard)/[slug]/(ee)/settings/security/page-client.tsx`), a card "SAML Single Sign-On" and a sibling SCIM card (`.../security/saml.tsx`, `scim.tsx`). Enterprise plan only for enforcement (`saml.tsx` Switch `disabled={plan !== "enterprise"}`).
- **Anatomy**: the card has a status row (logo of the configured IdP, "Okta SAML", "SAML SSO is configured for your workspace", a menu with Remove) and a footer row with a Switch: "Require workspace members to login with SAML to access this workspace" plus a blue badge with the domain when enforced (`saml.tsx:132-228`). Unconfigured state reads "Choose an identity provider to get started." (`saml.tsx:73-82`).
- **Setup modal**: one small centred modal, lock icon, "Configure SAML", sub copy "Select a provider to configure SAML for your Dub workspace." A native `<select>` of 3 providers (Okta, Entra ID, Google) then exactly one input, labelled per provider: "Metadata URL" (Okta), "App Federation Metadata URL" (Entra), "XML Metadata File" upload (Google) (`apps/web/ui/modals/saml-modal.tsx:82-211`; labels from `packages/utils/src/constants/saml.ts:1-38`). Below the select, a text link "Read the guide on Okta SSO". Submit "Save changes" is disabled until a provider is picked. Toasts via sonner on success and error (`saml-modal.tsx:68-77`).
- **Count**: 2 decisions (provider, then the value), 1 typed or pasted field, **0 copy actions in the app**: all SP values (ACS URL, entity id) are in the help article, not the UI. That is the cheapest in-app setup in the survey, and the cost moves to the guide (6 steps in the IdP). GUESS: this works because BoxyHQ Jackson (`apps/web/lib/jackson.ts`) uses fixed SP values.
- **Sign-in side**: "Continue with SAML SSO" button reveals a workspace-slug field with a tooltip (`apps/web/ui/auth/login/sso-sign-in.tsx:46-80`) and a "last used" method memory.
- **Test step**: none.
- **Steal**: logo + name once configured (a status row that shows who your IdP is); one-field modal; per-provider label for the single field; disabled primary until a provider is chosen; the enforcement switch inside the same card, with the covered domain as a badge.
- **Bad**: no copy of SP values in the app; no test; native select with no logos; guide-only for the hardest part.
- Images: `gallery/dub/01` (modal, https://assets.dub.co/help/okta-saml-modal.png), `02` (security page, https://assets.dub.co/cms/saml-directory-sync-2.png), `03` (SCIM modal with two values to copy, https://assets.dub.co/help/okta-scim-modal-configured.png).

### Grafana

- **Location**: Administration > Authentication, a page `navId="authentication"` (`public/app/features/auth-config/AuthProvidersListPage.tsx:81-134`). Own page with a **grid of provider Cards** (`Grid minColumnWidth={34}`), each showing a name, the protocol label (OAuth, LDAP, SAML) and enabled state. Each Card links to `/admin/authentication/<provider>`. OSS builds also show non-clickable-upsell SAML and SCIM cards (`AuthProvidersListPage.tsx:123-128`).
- **Config page**: single form `max-width 600px` (`ProviderConfigForm.tsx:160`) with `CollapsableSection`s, **only the first open** (`isOpen={index === 0}`, line 182): General settings, User mapping, Extra security measures (`fields.tsx:23-25`, generic_oauth sections at `fields.tsx:73-110`). Fields show or hide through `dependsOn` toggles (for example `defineAllowedGroups`). Advanced options live in the closed sections.
- **Buttons**: "Save and enable" (primary), "Save" (secondary), "Discard", and a more-actions menu with "Reset to default values" (`ProviderConfigForm.tsx:206-243`). After save, a 300 ms delayed redirect back to the list (`ProviderConfigForm.tsx:97-101`) and a toast "Settings saved". `FormPrompt` blocks navigation when dirty (line 161).
- **SAML UI** (Enterprise, docs `docs/sources/setup-grafana/configure-access/configure-authentication/saml/saml-ui/_index.md`): General settings (allow signup, auto login, single logout, IdP-initiated), Sign requests toggle with cert and key fields, and the doc says the UI "carries out input validation and gives feedback on whether the configuration works" (a light form of testing).
- **Steal**: separating Save from Save and enable; "Reset to default values" as the safe undo; only-first-section-open collapsibles; the dirty-form navigation prompt; the card grid showing protocol and state.
- **Bad**: field-heavy forms (OAuth general has about 14 fields, `fields.tsx:77-92`); no logos for IdPs; no first-run guidance.
- Images: none. Grafana docs pages had no SSO UI screenshots in the HTML I fetched.

### GitLab (docs only)

- **Location**: Group > Settings > SAML SSO (https://docs.gitlab.com/user/group/saml_sso/). Page is a group-level form: the GitLab-provided values (Identifier, Assertion consumer service URL, GitLab single sign-on URL, and a **GitLab metadata URL** that some IdPs can ingest directly) then IdP SSO URL and certificate fingerprint, a **"Verify SAML Configuration"** button (the only real test step among the products here), enable checkbox, default membership role, and two enforcement checkboxes: "Enforce SSO-only authentication for web activity" and one for Git and Dependency Proxy. Docs include a per-IdP field mapping table (for OneLogin: Identifier = Audience, ACS URL = Recipient / ACS) which is the same idea as Infisical's per-provider labels, but in prose.
- **Steal**: Verify button; offering the SP metadata URL so the admin pastes one thing into the IdP; separate enforcement for web vs Git.
- **Bad**: per-IdP guidance in docs rather than in the form; the NameID "persistent" warning is told to be ignored in docs (copy mismatch).
- Images: none obtained.

### Mattermost

- **Location**: System Console > Authentication > SAML 2.0 (`webapp/channels/src/components/admin_console/admin_definition.tsx:4693-4702`).
- **Anatomy**: one flat settings page driven by a schema array, with about 30 fields in order: Enable, Sync with LDAP, IdP metadata URL, IdP URL, descriptor URL, certificate file, Verify, ACS URL, SP identifier, Encrypt, private key, public cert, Sign request, algorithms, then 10+ attribute fields (email, username, id, guest, admin, first, last, nickname, position, locale), login button text (`admin_definition.tsx:4706-5150` keys). Provider-specific advice is only in docs.
- **Bad (the anti-pattern)**: no sections for common vs advanced, no provider picker, no test. Good only as a reminder of what happens when schema-driven settings pages grow.

### Supabase (docs only)

- **Location**: Organization settings > SSO (https://supabase.com/docs/guides/platform/sso). For project users it is CLI only (docs "Single Sign-On with SAML 2.0 for Projects").
- **Anatomy** (screenshot `gallery/supabase/01`): one card form. Master switch "Enable Single Sign-On"; "Enable SP-initiated login" switch with the note that email domains are required; "Metadata" with **URL / Upload file tabs**; "Attribute mapping" with **preset chips GSuite, Azure, Okta** that fill the mapping fields, plus "Add another" per attribute; "Automatically add users to organization on sign up" switch; Cancel and Save changes.
- **Steal**: IdP preset chips that autofill the advanced mapping; metadata URL and file as tabs; switches with plain-English descriptions.
- **Bad**: all mapping fields shown at once and empty by default; no test; enable switch at the top before anything is configured.
- Image: `gallery/supabase/01-sso-dashboard-enabled-idp.png` from https://supabase.com/docs/img/sso-dashboard-enabled-idp.png.

## Comparison

| Product    | Location                                      | Form factor                                              | Setup steps (decisions / typed or pasted / copies) | IdP logos            | Test step                         | Enforcement control                                      |
| ---------- | --------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- | -------------------- | --------------------------------- | -------------------------------------------------------- |
| Sentry     | Org settings > Authentication (own page)      | Row list, then Django wizard (provider, IdP, attributes) | 1 / 1-4 plus mapping / about 1-3                   | Yes, on the list     | No                                | Checkbox "Require SSO" in settings form                  |
| PostHog    | Org settings > Authentication > domains table | Table plus modal (legacy) or full scene (flag)           | 3 (domain, scope, enforce) / 4-5 / 3 plus TXT      | No                   | No                                | Per-domain select (which provider)                       |
| Infisical  | Org settings > Security > SSO tab             | Empty-state card, protocol dialog, Sheet                 | 3 (protocol, provider, enable) / 3 / 2 plus TXT    | No (names only)      | No                                | Toggle in separate card, confirm dialog with break-glass |
| Dub        | Workspace > Security                          | Card plus one small modal                                | 2 / 1 / 0                                          | Yes, once configured | No                                | Switch in the same card, domain badge                    |
| Grafana    | Administration > Authentication               | Card grid, then one long form with collapsibles          | 1 / 8-14 / varies                                  | No                   | Validation only (Enterprise SAML) | Not a toggle: disabling the provider                     |
| GitLab     | Group > Settings > SAML SSO                   | Single form                                              | 0 / 2-3 / 3-4                                      | No                   | Verify SAML Configuration button  | Two checkboxes (web, Git)                                |
| Mattermost | System Console > SAML 2.0                     | One flat page                                            | 0 / 10-30 / 3                                      | No                   | No                                | Enable toggle only                                       |
| Supabase   | Org settings > SSO                            | Single card form                                         | 1 / 1-4 / 0                                        | No                   | No                                | Not seen                                                 |

Counts are my reading of the code and docs, not measured sessions.

## Top 10 ideas worth taking, ranked

1. **Provider-specific labels with the generic term as a hint** (Infisical `SSOModal.tsx:75-160`). Show "Reply URL (ACS URL)" for Entra, "Audience URI (SP Entity ID)" for Okta. Biggest single win for copy-paste setups; i10 can key it off the same provider list used for the guide.
2. **Zero in-app copying where possible** (Dub). If SP values are fixed or can be handed over as one SP metadata URL (GitLab), the in-app task shrinks to pick IdP and paste one URL. Offer metadata URL first, with file upload and manual fields as tabs (Sentry three tabs, Supabase URL / Upload tabs).
3. **Enforce dialog with break-glass built in** (Infisical `OrgGeneralAuthSection.tsx:395-440`): warning text states the consequence in full, and the admin chooses the escape hatch right there. Pair with Sentry's "N members not yet linked, Send Reminders" for blast radius.
4. **Domain verification as a gate with an explicit empty state** (Infisical `OrgSsoTab.tsx:88-97, 346-376`: "Verify a domain first to add a connection."). Skip PostHog's per-domain table as the primary surface.
5. **Create the inactive config first, enable separately** (Infisical `OrgSSOSection.tsx:102-117, 165-199`; Grafana "Save" vs "Save and enable"). Lets the admin copy SP values early and activate only when ready.
6. **A status row that shows who is connected** (Dub `saml.tsx:48-84`: logo, "Okta SAML", configured copy) with the enforcement switch in the card footer and the covered domain as a badge.
7. **Integration badge column** (PostHog `VerifiedDomains.tsx:232-358`): SAML, OIDC, SCIM state at a glance with tooltips. Good for an overview row when more than one protocol exists.
8. **A real test step**. No open source product here has an in-app sign-in test; GitLab's "Verify SAML Configuration" and Grafana's validation feedback are the closest. This is the clear gap to beat: a "Test sign-in" action that opens the IdP in a popup and reports the returned attributes. (This is an opportunity, not copied code.)
9. **Presets that autofill the advanced block** (Supabase attribute mapping chips GSuite, Azure, Okta) and Grafana's only-first-section-open collapsibles (`ProviderConfigForm.tsx:182`) so advanced settings exist but stay closed.
10. **Safe undo and honest partial saves**: Grafana "Reset to default values" and the dirty-form navigation prompt (`ProviderConfigForm.tsx:161`), PostHog "You can save a partial configuration" banner (`SAMLConfigFields.tsx:51-56`), type-the-name-to-delete (`IdentityProviderConfigScene.tsx:247`).

## Cross-cutting observations

- The three best-feeling flows (Dub, Infisical, Supabase) all put the master switch or enforcement in the same visual unit as the config, not on a separate settings page.
- Nobody uses a multi-step wizard with a progress indicator in the open source set; Sentry's pipeline is the only stepwise flow and it is server-rendered with no progress indicator.
- Generic SAML is treated as the default/fallback (Infisical `default:` branch, Sentry "SAML2" row with named examples). OIDC is a separate protocol choice (Infisical, PostHog), not a provider.
- Unread gaps: Infisical `@app/components/v3` Sheet/Dialog motion values, Supabase studio source, Plane, Twenty and Ente.
