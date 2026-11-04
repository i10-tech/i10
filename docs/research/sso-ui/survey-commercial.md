# SSO admin UI: commercial products survey

Purpose: how closed-source products present SSO setup, from public material only (help centers, docs, launch posts, a public demo). No logins, no sign-ups. Date of research: 2026-11-04.

Image folder: `gallery/<product>/`. 32 images saved by this survey (workos 9, vercel 3, resend 3, linear 3, notion 5, auth0 8, tailscale 1). The `gallery/clerk/` folder belongs to another pass and was not touched. Images I opened and looked at are marked (seen). Images saved but not individually opened are marked (not opened); I did not describe them from guesswork.

Labels: FACT = stated by the cited source or visible in an image I opened. GUESS = my inference.

## Evidence quality, up front

| Product | Visual evidence | Verdict |
|---|---|---|
| WorkOS | Good (blog screenshots of the real portal, docs guide frames, setup-link card, public live demo) | Benchmark, full report |
| Resend | Good (3 real dashboard frames, full text steps) | Full report, most relevant to i10 (email platform) |
| Notion | Good (modal, settings rows, enforcement dropdown, gate screen) | Full report |
| Auth0 self-service | Good (assistant frames) | Full report |
| Linear | Partial (metadata step, domain rules) | Report |
| Vercel | Partial (settings rows, login page) | Report |
| Stripe | Text only; the 4 images on the Okta page are IdP-side (Okta console) so not saved | Report from text |
| Tailscale | One image (login picker with generic OIDC row) | Short report |
| Atlassian, Datadog, Frontegg, Retool, Scalekit, Stytch, SSOReady, Slack, GitHub Enterprise, Figma, Loom, Cloudflare Access | No usable product screenshots of the admin SSO screen surfaced via scrape (pages 404'd, rendered without images, or only showed IdP-side consoles). Dropped from the visual comparison. Text-only notes below where I got any. | Dropped |

Dropped detail (FACT, scrape results): Atlassian support page returned zero images (https://support.atlassian.com/security-and-access-policies/docs/configure-saml-single-sign-on-with-an-identity-provider/). Datadog SAML page returned only nav icons (https://docs.datadoghq.com/account_management/saml/). GitHub's SAML page returned two tiny cropped fragments only (https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/using-saml-for-enterprise-iam/configuring-saml-single-sign-on-for-your-enterprise). Cloudflare's generic SAML page images are IdP attribute screens, not Cloudflare's own picker. Retool, Scalekit and Frontegg URLs 404'd or redirected to a home page; Stytch's page returned no images; ssoready.com did not resolve (DNS) and its README hero is marketing art, so I deleted it.

---

## 1. WorkOS (benchmark)

Sources: https://workos.com/admin-portal , https://workos.com/blog/seamless-onboarding-with-the-workos-admin-portal , https://explore.workos.com/ (live public demo, text read), https://workos.com/docs/admin-portal

### Where it lives
A separate, WorkOS-hosted portal, not inside the customer's settings nav. The vendor app (for example the fictional "Helix" in the demo) shows an "Admin Settings" page with four cards: Domain Verification (shows "Verified"), Single Sign-On, Directory Sync, Audit Logs, Log Streams; each card has "Configure" that opens the real portal in a throwaway org (FACT, https://explore.workos.com/). Two ways in: a button in the vendor's own app that calls the API to mint a link, or a "setup link" the vendor copies from the WorkOS dashboard and emails to the customer's IT person (FACT, blog above).

### Steps from nothing to working
- The IT admin never sees the vendor's product. They arrive via link. The link from the dashboard expires in 30 days or when the connection is configured; an API-generated link expires after 5 minutes (FACT: image `workos/01-setup-link-dashboard.png` (seen) says "Link expires in 30 days or once the connection is successfully configured"; blog says API links last 5 minutes).
- Flow (FACT, blog): pick provider, follow the embedded guide, upload metadata, test, done. Okta guide has 6 numbered steps: Create SAML Integration, Configure Attribute Statements, Submit Application Feedback, Add Users to SAML App, Upload Identity Provider Metadata, Test Single Sign-On (`workos/06-blog-sso-provider-picker.png`, seen; despite the filename this frame is the Okta guide, the picker itself is the directory variant in `07`). Azure guide has 6 steps ending in "Confirmation" (`workos/04-docs-azure-guide.png`, seen).
- Decisions: provider (1). Typed fields: on the vendor side, none beyond pasting metadata URL or uploading XML (GUESS from the "Upload Identity Provider Metadata" step; the dashboard UI itself was not visible). Copy actions: the ACS URL and Entity ID shown in the guide (GUESS, standard for SAML; not visible in saved frames).
- Domain verification: a separate screen, "Verify your Domain": one field "Enter your organization domain" with a Continue button, and the portal then shows TXT record instructions tailored to the DNS provider it detects, with a provider logo in the field (`workos/09-blog-domain-verification.png`, seen shows a Cloudflare cloud icon inside the input; blog says it "will display the appropriate guide ... based on the DNS provider").
- Test: a "Test Identity Provider" exists so admins can simulate the whole flow before going live (FACT, blog). The final portal step validates the connection and, on failure, shows debugging steps; the admin can "reset the connection" and start over (FACT, blog).
- Enforcement control: none in the portal. Enforcement is the vendor's app logic (GUESS, nothing in sources about a portal toggle).

### Page anatomy
Centered card, thin header bar with the vendor's logo and a title ("Configure Single Sign-On", "Verify your Domain", "Configure Directory Sync"), no side nav on picker and domain screens. Guide screens are two-column: left rail with provider logo, numbered steps with one filled dark circle for current and grey circles for later; right column has "Step 1: Create SAML Integration" heading, one sentence, then a large annotated screenshot of the IdP console with the target control spotlighted in white while the rest is dimmed (`06`, seen). Azure variant uses a vertical connected-line stepper (`04`, seen).
Provider picker (directory variant, `07`, seen): heading "Select your directory provider", a search field "Find your provider" on top with an orange focus ring, a scrolling list of rows each with a real brand logo, name and a chevron (Okta, Entra ID (Azure AD), Google Workspace, Access People HR, BambooHR, Breathe HR...), then an "OR" divider and two equal outlined tiles "Custom SCIM" and "SFTP" with a generic gear icon. The SSO picker is the same pattern with "Custom SAML" and "Custom OIDC" (FACT, blog text: "configure custom SAML and OIDC connections"; the SSO picker frame itself was not captured).
Advanced options are hidden by being deferred: custom attribute mapping is a separate screen in the portal ("Map attributes": left column IdP attribute names in monospace, arrow, right column `user.firstName` etc.; `workos/05-map-attributes.png`, seen).

### Motion
None visible (stills only). The launch video exists (https://www.youtube.com/watch?v=PZ-XdLamC1c) but I could not play it, so no motion claims.

### Steal / avoid
Steal: the provider guide is one numbered rail plus one annotated screenshot per action, with the clicked control spotlighted. And the setup link: the person who can configure the IdP is usually not the person who is paying, so the product mints a link they forward.
Avoid: the portal is "outside" the product, so brand continuity and enforcement live elsewhere; free tier is unbranded (FACT, pricing blurb on the admin-portal page).

---

## 2. Resend (closest peer: email platform)

Sources: https://resend.com/docs/dashboard/settings/sso (full text), images from mintcdn.com/resend/.../images/sso-*.png

### Where it lives
Inside Team Settings, on the Members card: an "Enable SSO" button sits next to "Invite" in the card header (`resend/01-team-settings-enable-sso.png`, seen; the page is dimmed behind a modal-like overlay in the capture). After setup the Team Settings page has a "Single Sign-On" section.

### Steps from nothing to working (FACT, docs)
1. Click Enable SSO (admin only; your own email must be on the SSO domain).
2. Enter the organization domain (one typed field).
3. Add one TXT record at the apex: `resend-domain-verification=<value>`. Copy the value from the dashboard.
4. Click "I've added the record". Resend polls DNS for up to an hour and updates the page live.
5. Click "Finish setup": a new tab opens for the IdP connection (this step is not documented in detail; GUESS it is a WorkOS-style portal because the shape matches, but the doc does not say).
Counts: 3 decisions (go, domain, finish), 1 typed field (domain), 1 copy action (the TXT value), plus the IdP half in another tab.
Clever shortcuts (FACT): if the domain is already verified for sending, steps 3 and 4 are marked complete automatically. "Copy instructions" emails the record to your DNS admin, but only to your own address or one on the domain being verified. Progress is kept if you leave; the button turns into "Continue SSO setup".

### Page anatomy
`resend/03-dns-txt-record-step.png` (seen): full app chrome stays (left nav, Settings highlighted), header block with an icon tile, title "Set up Single Sign-On", one-line subtitle. Below it a vertical timeline (a thin line with circle nodes). Each step is a card on the timeline: the completed one is a green-tinted rounded card with a check next to "Domain" and the value shown read-only ("resend.com"); the current one, "DNS record", is plain text with a small table (Type, Name, Content, TTL) where Content is truncated in the middle ("resend-d [...] 56ae2ac"), then a white pill button "I've added the record" with a check icon and a small "..." overflow button beside it. Nothing else on screen: no logos, no provider picker, no advanced fields.

### Enforcement
A single "Enforce SSO" control in the SSO section of Team Settings, admin-only. Docs warn to complete one successful SSO sign-in first, and to keep one admin on an email outside the SSO domain as a way back in (FACT). "Restrict joining other teams" is not self-serve: contact support (FACT). Disable requires typing `DISABLE SSO` and the domain cannot be edited after setup (FACT).

### Test step
No separate test step documented; the advice is "complete at least one successful SSO sign-in before enforcing" (FACT).

### Motion
None visible. Live polling is described ("updates the page as it goes") but no frames of it.

### Steal / avoid
Steal: timeline of cards where finished steps collapse to a green read-only summary; auto-complete the domain proof when it is already proven elsewhere; the truncated-middle DNS value with copy; the email-to-your-DNS-admin affordance with a safe-recipient rule; resume with "Continue SSO setup".
Avoid: domain not editable (must disable and redo); IdP step opens in another tab with no described return signal other than a settings flag.

---

## 3. Notion

Sources: https://www.notion.com/help/saml-sso-configuration (text and images)

### Where it lives
Business plan: Settings, then the "Identity & provisioning" tab (left rail item, `notion/02-saml-config-modal.png` seen shows it highlighted). Enterprise: workspace switcher, "Manage organization", General tab, "SAML configurations" (up to 25 configurations) (FACT).

### Steps (FACT)
Remove "allowed email domains", verify a domain (separate flow), toggle "Enable SAML SSO", a modal opens. Modal (`02`, seen): title "SAML SSO Configuration"; first block "Assertion Consumer Service (ACS) URL" with "Enter this in your IDP's SAML configuration." and a read-only box with an inline Copy; second block "Identity Provider Details" with two radio rows "Identity Provider URL" and "Identity Provider Metadata XML" and a single input; footer "Cancel" and "Save changes". Login method and auto account creation are chosen before saving, one save (FACT, "Do I have to save my SAML settings twice? No.").
Counts: decisions 3 (domain, URL vs XML, login method), typed fields 1 (metadata URL), copy actions 1 on Business (ACS), 2 on Enterprise (ACS plus Entity ID).
No provider picker, no logos, instructions live on a separate help page ("Set up Identity Provider (IdP) for SAML SSO").

### Enforcement
Enterprise row (`04`, seen): a heading "SAML Single sign-on (SSO)", row "Enable SAML SSO" with a blue "Configure" link and a toggle, row "Login method: Customize login methods for SAML-enabled workspaces. Owners retain password access." with a dropdown whose options are "Only SAML SSO" and "Any method" (checkmark on the current). Third row "Automatic account creation" with a toggle. The row copy states the lockout escape (owners keep password access) right where the choice is made.
Enforced-for-workspace gate (`05`, seen): empty white screen, shield-with-lock icon, bold "Authorize with SAML SSO to access Skipper", one grey sentence, one blue button, footer "Logged in as ... . Switch workspace".

### Sign-in routing (FACT)
One configuration for your domain: straight to the IdP. More than one: pick from a list with the last used marked. None: usual sign-in. Required configuration: skip the list.

### Steal / avoid
Steal: the enforcement dropdown with the escape hatch in its description; per-configuration "Only SAML SSO" scoped to its domains; the "last used" marker on the provider chooser; one save for all choices. Avoid: no in-product IdP instructions or test step; the user has to remove "allowed email domains" first (a prerequisite the UI does not do for you).

---

## 4. Auth0 Self-Service Enterprise Configuration

Sources: https://auth0.com/docs/authenticate/enterprise-connections/self-service-enterprise-configuration (text via the .md endpoint) and images from mintlify.s3.us-west-1.amazonaws.com/auth0/docs/images/

### Where it lives
A separate "setup assistant" reached by a ticket URL the vendor sends (same shape as WorkOS). Vendor creates a self-service profile (up to 20), then a self-service access ticket, then sends the URL (FACT).

### Steps (FACT)
Select IdP (Okta Workforce, Auth0, Entra ID, Google Workspace, Keycloak, ADFS, PingFederate, Generic OIDC, Generic SAML; which appear is set by the profile), Create Application, Configure Connection (domain, client ID, client secret), Claims Mapping, Assign Access, Test SSO, optional Provisioning (SCIM token generated in the assistant), Domain verification and association.
Hub screen (`auth0/02-idp-picker.png`, seen, despite filename): "Configure Your Connection / Complete each configuration to get set up with Testing Inc.." and three rows with checkmark circles: Single Sign-On, Provisioning, Domain Configuration, each with a chevron, and a disabled "Enable Connection" button at the top right. So the three jobs are peers, and the connection can only be enabled when all rows are done.
Assistant frame (`05`, seen): left rail "Configure Okta" with 5 numbered text steps (Create Application, Configure Connection, Claims Mapping, Assign Access, Test SSO); right pane "Claims Mapping" with a collapsed "Required attributes" panel open (a table: "Email" with an info icon, mapping field "email" read-only with a copy icon) and a collapsed "Optional attributes" panel; green "Next" in a footer bar.
Test (`06`, seen): "Test SSO", two short sentences, an outlined "Test Connection" button with an external-link icon, warning "Please do not close out this window while testing", green "Done".

### Domain verification placement
Last, and skippable if the ticket is scoped to one Organization with Discovery enabled: domains already verified are detected and can be associated without redoing the TXT record (FACT, doc text). `07-domain-verification.png` and `08-assign-access.png` and the other frames were saved but not opened.

### Steal / avoid
Steal: required attributes collapsed to one read-only row ("email"), optional ones hidden behind a closed panel; reuse of an existing verified domain with no second proof; hub with three equal rows and a gated "Enable Connection". Avoid: Test needs a new window and an instruction not to close this one; domain verification placed after enabling in some configurations means traffic may go live before routing is proven (GUESS).

---

## 5. Linear

Source: https://linear.app/docs/saml-and-access-control

Location (FACT): Settings > Administration > Security > "Authentication methods" > Configure beside "SAML & SCIM". Dark UI.
Steps (FACT): copy values from Linear into the IdP, press Continue, then a second step with a segmented control "XML URL | Paste XML", one labelled input "SAML configuration XML URL" with `https://...` placeholder, helper "If you're unsure of what this means, read the instructions provided by your Identity Provider (IdP), or contact Linear support." and footer "Back" and "Configure SAML" (`linear/02-saml-metadata-step.png`, seen). Two decisions (URL vs XML, then the domains), one typed field, N copy actions for the Linear-side values (not visible in saved frames).
IdP help is a tab strip (Okta, Microsoft Entra ID, Google Workspace, OneLogin) on the docs page, text bullets, no per-step screenshots (FACT).
Domains and enforcement: "Domain rules" (`03`, seen): "SAML-approved email domains" list with "+", each row has an @ tile, domain, "Added Sep 11, 2024", a blue outlined "Claimed" badge and an overflow menu. Below, "Other domains": toggles for "Google authentication" and "Email & passkey authentication" each with "Currently available to all members and guests". So enforcement is expressed as what stays open for domains that are not SAML-approved, rather than a single "require SSO" switch. Domain claim is by TXT code (FACT).
Multi-IdP: "+" next to "Connected identity providers", each IdP tied to one or more domains (FACT).
Steal: enforcement as domain rules with toggles per fallback method and the live count; the "Claimed" badge. Avoid: IdP steps are prose only; the two-step modal separates Linear's values from the paste step.

---

## 6. Vercel

Source: https://vercel.com/docs/saml

Location (FACT): Team Settings > Security & Privacy > "Authentication and User Provisioning". `vercel/01-saml-settings-light.png` (seen): section title, one-line description, two bordered rows (lock icon "SAML: Allow team members to log in with an identity provider.", book icon "Directory Sync: Provision and deprovision accounts with your identity provider.") each with a "Configure" button and a "..." menu. Under SAML a slightly grey sub-row "Require team members to log in with SAML." with a toggle (disabled look until SAML is configured).
Walkthrough: "Configure" starts a walkthrough; the docs do not show its frames (FACT, no images). Provider list in docs is plain text (23 names, includes Okta, Auth0, Google, Entra, OneLogin, Keycloak, OpenID), no logos (FACT).
Enforcement: toggle "Require Team Members to login with SAML" is allowed only if you are currently signed in via SAML, to prove the configuration works before tightening access; editing the config turns the toggle off automatically (FACT). `vercel/02-saml-enforced-light.png` is the enforced state (not opened).
Login: a "SAML only" login page via `?saml=team_id` query, showing only a "Team Slug" input and a "Continue with SAML SSO" button with a lock icon (`03`, seen).
Steal: the enforcement gate (must be signed in with SAML to turn it on; auto-off after edit); a share-able SAML-only login URL. Avoid: no domain-based discovery, user types a team slug.

---

## 7. Stripe (text only)

Sources: https://docs.stripe.com/get-started/account/sso , https://docs.stripe.com/get-started/account/sso/okta

Location (FACT): Settings > Team and security > Single sign-on (SSO).
Steps (FACT): Add domain, get `stripe-verification=...` TXT, "Save and verify" (can take 24 h; do not delete the record). Then "Edit Configuration" next to the domain: three typed fields (IdP URL, Issuer ID, X.509 certificate), Continue, enter a test email, Continue opens a new window for the test, if pass Continue, then pick enforcement Off / Optional / Required, Save. So decisions about 4, typed fields 4, plus a mandatory test gate inside the wizard.
IdP side: Okta catalog app or custom app alternatives tab; role assignment via attribute statements or in the Stripe Dashboard (switch via "Configure role assignment"; warns that switching back to IdP-managed under Required can lock out admins).
Certificate rotation: add a second cert, test, then "Set as primary" (FACT).
Direct URL: `/login/saml_direct/domain/{domain}/merchant/{account}`.
Steal: three-state enforcement Off / Optional / Required chosen at the end of the wizard after a passed test; secondary-certificate rotation with a primary label. Avoid: three certificate-and-URL paste fields with no metadata shortcut; 24-hour domain wait.

---

## 8. Tailscale (short)

Source: https://tailscale.com/kb/1119/sso-saml-oidc (resolves to custom-oidc page)
`tailscale/01-signup-custom-oidc-picker.png` (seen): login chooser "Sign up with your identity provider", five equal outlined buttons with brand marks for Google, Microsoft, GitHub, Apple, and a fifth "Sign up with OIDC" with the OpenID logo, highlighted in the doc with a red box. Generic OIDC is simply another peer button, not a hidden link. Bad: this is sign-up, and "You'll use this provider to log in to your network" has a "(more)" link carrying the important consequence.

---

## 9. Others with partial or no visuals

- Atlassian Guard (Jira/Confluence): the docs page is text only here; no admin-screen evidence obtained.
- Slack, GitHub Enterprise, Figma, Loom, Datadog, Cloudflare Access, Retool, Frontegg, Stytch, Scalekit, SSOReady: no usable admin UI screenshots collected; not described to avoid guessing. SSOReady's own pitch (HN, https://news.ycombinator.com/item?id=41110850) describes a hosted setup UI minted by a short-lived URL "like Stripe Checkout" (FACT, secondary excerpt from a search snippet; not verified on its own site, whose domain did not resolve).

---

## Comparison table

| Product | Location | Form factor | Steps / typed fields | Provider logos | Test step | Enforcement control |
|---|---|---|---|---|---|---|
| WorkOS | Hosted portal via link | Full-page guided portal | picker, guide (6 steps), metadata upload, domain | Yes, searchable list plus Custom SAML/OIDC tiles | Yes, validation and a built-in test IdP | None in portal (vendor-side) |
| Resend | Team Settings > Members card | In-app timeline wizard, then IdP tab | domain, TXT, finish; 1 field, 1 copy | None seen | Advice only | Single "Enforce SSO", admin-only, escape-hatch advice |
| Notion | Settings > Identity & provisioning | Modal | domain, URL/XML, login method; 1 field | None | None | Dropdown "Only SAML SSO / Any method", owners keep password |
| Auth0 assistant | Ticket link | Multi-step assistant, hub of 3 rows | pick IdP, 5 steps, domain | Picker by profile (names, assumed icons) | Yes, button opens new window | Not in assistant |
| Linear | Settings > Administration > Security | Two-step modal | copy values, XML URL/XML; 1 field | None | None documented | Domain rules with per-method toggles |
| Vercel | Settings > Security & Privacy | Row + walkthrough | not documented | None (text list) | Implied: must be signed in via SAML to enforce | Toggle gated on a working SAML session |
| Stripe | Settings > Team and security > SSO | Wizard | domain, 3 fields, test, enforcement; ~4 fields | None | Yes, mandatory test email | Off / Optional / Required at end |
| Tailscale | Login chooser | Button list | n/a | Yes + generic OIDC peer | n/a | n/a |

## Patterns the best ones share

1. The IT person is not the buyer, so the best flows are shareable: a link (WorkOS, Auth0) or an email-the-DNS-admin action (Resend).
2. Settings row is one line with a "Configure" button; the work happens in a focused wizard, not on the settings page (Vercel, Notion, Linear, Stripe).
3. Our values out, their values in, in that order, with copy buttons inline on read-only boxes (Notion modal).
4. Metadata URL preferred; XML paste is one tab away, not two fields of manual URL/issuer/cert (Linear, Notion vs Stripe).
5. Domain proof is a single TXT record with a middle-truncated copyable value, shown once (Resend, WorkOS), and is reused when already proven (Resend, Auth0).
6. Enforcement is gated on proof that SSO works (Vercel, Resend advice, Stripe test-before-enforce) and carries its own lockout escape in the control text (Notion).
7. IdP guidance is one numbered rail plus one annotated screenshot per action, current step dark, others grey (WorkOS); Azure variant with connected vertical line.
8. Advanced inputs (attribute mapping, optional claims) are separate screens or closed panels (WorkOS, Auth0).
9. Generic SAML/OIDC is a peer tile in the same list, set apart by an "OR" divider (WorkOS), or a plain extra button (Tailscale).

## Top 10 ideas worth taking (ranked)

1. Timeline of step cards where done steps collapse to a green read-only summary and only the current step is open (Resend, `resend/03`). Fits i10's existing flow with the least rework.
2. "Send setup link" for the IdP half: a 30-day, single-purpose link that dies when the connection is configured (WorkOS, `workos/01`), so a workspace owner can forward it to their IT person.
3. Auto-complete the domain step when the same domain is already verified for sending, and say so in the UI (Resend docs).
4. Enforcement control gated on a working sign-in: disabled until at least one successful SSO sign-in, switched off automatically when config is edited (Vercel docs).
5. Enforcement dropdown with the lockout escape hatch written in its description line: "Only SAML SSO / Any method ... Owners retain password access" (Notion, `notion/04`).
6. Two-column guide for each IdP: left rail numbered steps (one dark, rest grey), right one sentence plus one screenshot with the target control spotlighted (WorkOS, `workos/06`). One step per screen section, no walls of text.
7. One searchable provider list with real logos, then an "OR" divider and two equal tiles "Custom SAML" and "Custom OIDC" (WorkOS, `workos/07`).
8. Show our values (ACS URL, Entity ID) in read-only boxes with inline Copy, above a single "metadata URL or XML" choice, with a single Save (Notion, `notion/02`).
9. Hub of three equal rows (Single sign-on, Provisioning, Domain) with a check each and a final "Enable connection" button disabled until all are checked (Auth0, `auth0/02`).
10. Required attributes shown as one read-only row, optional ones inside a closed panel (Auth0, `auth0/05`); and a "Test connection" button that opens in a new tab with the page staying put (Auth0, `auth0/06`).

## Open gaps

- No motion evidence was available for any product beyond the WorkOS launch video I could not play.
- Resend's final IdP step and WorkOS's real SSO provider-picker screenshot were not captured.
- `workos/02`, `workos/03`, `resend/02`, `auth0/01,03,04,07,08`, `vercel/02`, `linear/01`, `notion/01,03` were saved but not opened; use at your own risk or open them before relying on them.
