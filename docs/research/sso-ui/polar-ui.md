# Polar's SSO admin UI, read from source

Read-only study of github.com/polarsource/polar (shallow clone, HEAD of 2026-11-04). Paths are relative to `clients/`. Shorthand: **W** = `apps/web/src`, **O** = `packages/orbit/src`, **SSO** = `W/components/Settings/SSO`.

## 0. The plain verdict

Polar's SSO UI is thin and behind a staff flag. The whole feature is about 970 lines across 8 files (`wc -l SSO/*`). It is OIDC only, with exactly two provider presets (`SSO/SSOConnectionForm.ts:8-14`: "Google Workspace", "Custom OIDC provider"). It does not look better than ours because it does more. It looks better because it does almost nothing and sits inside a very consistent settings system. The owner is most likely responding to the settings pattern language (grouped bordered cards, one right-hand drawer for every create/edit, a single status chip, copy fields), not to SSO-specific cleverness.

Flag: `organization.feature_settings.sso_enabled` (`server/polar/organization/schemas.py:226-229`, default `False`). The nav item is hidden unless it is true (`W/components/Dashboard/navigationSettings.tsx:92`) and the page 404s (`W/app/(main)/dashboard/[organization]/(header)/settings/sso/page.tsx:23-25`). Gated by `organization:manage` (`.../sso/layout.tsx:13-18`).

## 1. Where it lives

- Own page, under the **Organization** group of the settings sidebar: General, Members, Notifications, Billing, **Single Sign-On**, Domains, Preview Features (`navigationSettings.tsx:62-96`). Icon `LogIn`. Route `/dashboard/{org}/settings/sso`.
- Neighbours are Members (above) and Domains (right below). Domains is a separate page (`settings/domains`, `settingsSections.ts:20`); SSO does not embed domain verification, it links to it.
- Page shell: `DashboardBody` (`W/components/Layout/DashboardLayout.tsx`, ~line 113-153) with `wrapperClassName="max-w-(--breakpoint-md)!"` (768px column), title "Single Sign-On" as `h4 text-2xl font-medium`, and the primary action in the page header (`SSOPage.tsx:22-30`). Whole body fades in with `opacity 0->1, 0.3s` (DashboardLayout `variants`, `m.div`). Card is `rounded-2xl border bg-white px-4 md:px-8 md:shadow-xs`, content `pt-8 gap-8`.

## 2. Every screen and state, in order

There is no wizard. The page is one vertical stack (`SSOSettings.tsx:72`, `Box flexDirection=column rowGap=2xl` = 32px) of up to four blocks.

**A. Header.** Title "Single Sign-On". Button "Add connection" (default/primary), `disabled={!hasVerifiedDomain}` (`SSOPage.tsx:26-28`). No tooltip on why it is disabled; the reason is in block B.

**B. Domain gate (info Alert).** Shown only if domains loaded and none verified (`SSOSettings.tsx:73-90`). Title "Verify your email domain". Body: "SSO only works for a domain you own. [Add and verify it] before adding a connection." Link goes to `/settings/domains`. One-sentence prerequisite, nothing else.

**C. Connections.**
- Empty (`SSOSettings.tsx:100-106`): `SettingsSection title="Connections"` containing `EmptyState` with `LogIn` icon (text-5xl, gray-500), title "No SSO connections", description "Add a connection so members can sign in with your identity provider." No button inside the empty state; the only CTA is the page header button.
- Populated (`:92-98`): `SettingsGroup title="Connections"`, one `SettingsGroupRow` per connection (`SSOConnectionRow.tsx:58-97`): title (name, else issuer) in `Text variant=title` (14px medium), `Status` chip "Enabled" green / "Disabled" gray (small), issuer URL beneath in muted caption, a ghost icon button (ellipsis-vertical, `aria-label="Connection actions"`) opening a dropdown: **Edit / Enable|Disable / Delete**. Enable and Disable act immediately, no confirm; failure toasts "Update failed".
- Delete: `ConfirmModal` title "Delete SSO connection", "Members will no longer be able to sign in with this connection." destructive, button text defaults to "Delete" (`SSOConnectionRow.tsx:98-105`). No typed confirmation.

**D. Create (right drawer, `NewSSOConnectionModal.tsx`).** Header "New SSO connection" (`heading-xs`, 20/24px). Fields in this order (`SSOConnectionFormFields.tsx:69-194`):
1. "Identity provider" select: Google Workspace | Custom OIDC provider. Default `custom` (`NewSSOConnectionModal.tsx:30`). Choosing Google writes issuer `https://accounts.google.com` and auth method `client_secret` (`:41-50`).
2. "Callback URL" read-only mono field with a "Copy" button; hint "Register this redirect URI with your identity provider." (`:89-93`).
3. "Name", placeholder "Acme SSO (optional)".
4. "Issuer URL" (required), placeholder `https://idp.example.com`.
5. "Client ID" (required).
6. "Authentication method" select (Client secret | Private key JWT). Hidden under Google preset when client_secret (`:143-145`).
7. If client secret: "Client secret" password input (required). If private key JWT: "JWKS URL" copy field, hint "Configure your identity provider to fetch Polar's public keys from this URL."
8. Google only: "Workspace domain", placeholder "acme.com (optional)", live hint "Appended to the sign-in URL as ?...&hd=acme.com" else "Preselects accounts from this domain on Google's sign-in screen, via the hd parameter." (`SSOAuthorizationParamsFields.tsx:53-76`).
9. Always: "Additional authorization parameters" with key/value rows, a "Remove" secondary button per row, "Add parameter" small secondary button. Zero rows by default.
Submit "Create" (`:103-109`). Connection is created **disabled** (`enabled: false`, `:61`). Toast: "SSO connection created" / "Enable it once your identity provider is configured." Drawer closes. Server validation errors are mapped onto fields (`setValidationErrors`) plus a toast "Connection creation failed".

**E. Domain verification** is not on this page. It lives on `settings/domains` (`W/components/Settings/OrganizationDomainsSettings.tsx`): a single `SettingsGroupItem` "Domains" - "Prove you own a domain by adding a DNS TXT record." (`:69-71`), a list of rows (`rounded-s`, `background-card`, 12px/8px padding), each showing domain and "Pending verification" or "Verified on {date}". Pending rows show a small "Verify" button and an X icon button, and expand a `DomainDnsRecord` (`DomainDnsRecord.tsx:12-27`): label "Name" + mono copy field, label "Value" + mono copy field. Below the list: one input (placeholder `example.com`, Enter submits) plus "Add" (`:142-165`). Footnote: "Keep the TXT record in place once verified: Polar checks it again during reviews." Failed verify toasts "Domain not verified yet". No polling, no auto-recheck in the UI, no countdown.

**F. Enabling.** There is no test sign-in and no health check. Enabling is the dropdown item "Enable" on the row (`SSOConnectionRow.tsx:89-91`). The create toast is the only guidance.

**G. Login link (`SSOSettings.tsx:108-122`).** Shown only while not "automatic". `SettingsGroup title="Login link"` with a stacked item "SSO login URL" - "Share this link with your members to sign in via SSO." and a mono copy field. Hidden once enforced and a verified domain exists, because discovery becomes automatic.

**H. Enforcement (`:123-183`).** `SettingsGroup title="Enforcement"`, inline item "Enforce SSO" with a status chip ("Enforced" green / "Not enforced" gray) and a secondary button "Enforce" / "Stop enforcing". The description is a state machine of one-line reasons, in priority order: enforced -> "Members must sign in through SSO to access this organization."; no enabled connection -> "Add and enable an SSO connection before enforcing SSO."; no verified domain -> "Verify your email domain before enforcing SSO."; not signed in via SSO -> "Sign in through this organization's SSO to enforce it."; else "Require members to sign in through SSO to access this organization." The button is disabled in the failing cases (`:151-154`), and the description tells you why. Enforcing is blocked unless your current session is SSO-scoped (`canEnforce = currentUser.organization_scoped`, `:52`), which is a built-in lockout guard. Confirm: `ConfirmModal` "Enforce SSO", "All members and authorized third-party apps will be disconnected and must be re-authorized through SSO.", destructive "Enforce", and a **typed prompt of the org slug** (`:185-194`). When enforced, an extra stacked "Domains" item lists verified domains with "Verified on {long date}" (`SSODomains.tsx`).

**I. Edit (`EditSSOConnectionModal.tsx`).** Same drawer and same fields, minus the provider picker (`onPresetChange` is omitted so the select does not render, `FormFields:69`). Preset is inferred from the issuer (`:47`). Client secret starts empty and is still `secretRequired` (`:94`), so every edit forces re-entering the secret, which is a rough edge. Button "Save changes", toast "SSO connection updated".

**J. Sign-in side.** `/auth/sso/{slug}` (`W/app/(main)/auth/sso/[slug]/page.tsx`): centered card, `maxWidth 448`, `padding 3xl` (48px), `borderRadius xl` (32px), `background-secondary`, gap 2xl (`:45-57`). `OrgAuth` starts an org-scoped session and, if SSO is the only factor, redirects at once (`OrgAuth.tsx:67-74`); otherwise SSO buttons (key icon, primary) first, an "or" divider, then Apple/GitHub/Google/email (`:126-163`). Loading copy "Loading sign-in options..." / "Signing you in...". Error: warning box "Could not load single sign-on for this organization. Please try again."

## 3. Decision and field count, zero to working

Required path with Google Workspace: add domain (1 field), copy TXT name and value into DNS (2 copies), Verify (1 click), Add connection, pick provider (1 decision), copy Callback URL (1 copy; Google fills the issuer). Then Client ID + Client secret (2 fields), Create, then Enable from the row menu. Total: about 3 typed values, 3 copies, 1 select, 5 clicks, across two pages and one drawer.

Custom OIDC: Issuer URL + Client ID + Client secret = 3 typed values, plus an optional Name. Auth method defaults to client secret; private key JWT is one select away.

What exists: provider picker (2 options, no logos), a Google preset that prefills issuer and hides auth method, copy-to-clipboard on Callback URL, JWKS URL, login URL, and DNS record. What does not exist: discovery (".well-known/openid-configuration" fetch), a test button, provider logos, per-provider setup instructions, Okta/Entra presets, SAML, SCIM, role mapping, any "paste metadata" shortcut. Confirmed by `SSO_PROVIDER_PRESETS` having two entries.

## 4. Layout and visual anatomy

Sketchable:

```
[ sidebar ] | [ white card rounded-2xl, 768px content column, px-8, pt-8 ]
            |  Single Sign-On (24px medium)                [Add connection]
            |  (info Alert: rounded-m, 1px border, bg-secondary, px-24 py-16)
            |  Connections                      <- 16px body, mt 12px to group
            |  +----------------------------------------------------+ r=16px, 1px border
            |  | Acme SSO  [Enabled]                          [...] | px-24 py-16
            |  | https://accounts.google.com  (12px muted)          |
            |  +----------------------------------------------------+
            |  Login link        (same group card, stacked item, mono copy field)
            |  Enforcement       (group card, inline item: label left, chip+button right)
```

Values:
- Grouped card: `SettingsGroup` = section title (`Text variant=body`, 16px, h2) + optional muted caption, then a box with `borderRadius l` (16px), 1px `border-primary`, `overflow hidden`, children separated by 1px top rules (`SettingsGroup.tsx:32-59`). Items: `paddingHorizontal xl` 24px, `paddingVertical l` 16px; item title `Text variant=title` (14px, medium), description 14px muted; layouts `split`, `stacked`, `inline` (`:69-95`).
- Section rhythm: rowGap 2xl (32px) between groups, rowGap m (12px) title to card.
- Type: Geist; role sizes from `O/tokens/semantics.stylex.ts:63-90`: title 14/medium, body 16, label 12/medium, caption 12. Heading-xs drawer title is 20px (24px at md).
- Spacing scale: 4, 8, 12, 16, 24, 32, 48, 64, 96 (`O/tokens/value.stylex.ts:152-163`). Radii: 8, 12, 16, 32, full.
- Input: height 40, `rounded-xl`, 1px gray-200 border, `shadow-xs`, 14px at md; focus: blue-300 border plus 3px blue-100 ring (`O/components/Input.tsx:15`). Copy field is an Input without border inside a `rounded-xl` bordered shell with a ghost "Copy" button on the right that swaps to a Check icon for 2000ms (`packages/ui/src/components/atoms/CopyToClipboardInput.tsx:35-37, 64-68`).
- Status chip: `rounded-[0.5em]`, `px-[0.5em] py-[0.2em] text-xs`, tinted bg (emerald-100/500 text, gray-200/500) (`O/components/Status.tsx:3-26`). No dot, no icon.
- Alert: grid `auto 1fr`, 16px icon, `title` 14px medium, description muted, border-secondary, radius m (12px), padding 16/24 (`O/components/Alert.tsx:109-122`).
- Empty state: solid 1px border, radius m, padding 3xl (48px), 48px icon, centered (`W/components/Shared/EmptyState.tsx:23-41`).
- Dialogs vs pages: create and edit are a **right drawer** (`InlineModal`, 540px wide at md, full width below, `bg-white`, scroll inside); confirmations are centered `Modal` (800px max, `rounded-3xl` shell with a 4px inset gray frame and `rounded-[20px]` inner panel, `O/components/Modal.tsx:83-107`). Drawer header: `px-8 py-6`, title left, 24px X right. Body: `padding 2xl` (32px), field gap `l` (16px), labels above inputs with gap 4px.
- Logos: none. The only iconography is `LogIn` in nav and empty state, a key icon on the login button.

## 5. Motion

All Motion (`motion/react`, the framer-motion successor), no springs.
- Drawer (`O/components/InlineModal.tsx:66-97`): scrim `backgroundColor rgba(0,0,0,0) -> rgba(0,0,0,0.5)` (default tween, no custom duration); panel `x: 100% -> 0, opacity 0 -> 1`, **0.32s, ease [0,0,0,1]** (comments say it mirrors the `slow` + `decelerate` tokens, "a tween settles without the overshoot an underdamped spring produces", `:87-89`). Exit **0.2s, ease [0.3,0,1,1]**. `AnimatePresence` on a portal. Esc and scrim mousedown close. Body scroll locked. `react-focus-lock` with an iframe escape hatch.
- Centered modal: `opacity 0->1, scale 0.99->1, 0.1s easeInOut` (`Modal.tsx:88-90`). No exit animation (no AnimatePresence).
- Page body: fade 0.3s in and out (`DashboardLayout`).
- Dropdown, buttons, row hover: CSS only, `transitionDuration fast` (120ms) (`WebhookSettings.tsx:85-87`). Motion tokens: instant 0, fast 120, base 200, slow 320, slower 480; easings standard `(0.2,0,0,1)`, decelerate `(0,0,0,1)`, accelerate `(0.3,0,1,1)`, spring `(0.5,1.25,0.4,1)` (`O/tokens/value.stylex.ts:201-213`).
- Forms **do not animate reveals**. Switching the auth method, or choosing Google, swaps fields instantly via conditional render (`FormFields:145-193`, `AuthParams:36,53`). No height animation, no layout animation. Toast duration 3000ms. Copy button check lasts 2s.
- The live hint under "Workspace domain" is the only reactive text.

## 6. Components worth adopting in spirit

1. `SettingsGroup`/`SettingsGroupItem`: one bordered card, hairline-separated rows, three layouts (split, stacked, inline) that cover every settings row.
2. `CopyToClipboardInput`: read-only mono field, ghost "Copy" button inside the border, check icon for 2s, toast.
3. Right drawer for create/edit with one header style, used by SSO, access tokens (`CreateAccessTokenModal.tsx:51-71`), and webhooks.
4. `Status` chip with a closed API (`color`, `size` only, no className).
5. `Alert` with a closed API (variant chooses icon and color; optional `actions`).
6. `ConfirmModal` with an optional typed prompt (`ConfirmModal.tsx:121-156`), whitespace-normalized.
7. Row-level `...` menu: Edit / Enable|Disable / Delete.
8. Enforce control: a status chip, one button, and a one-line reason that changes with state, with the control disabled until prerequisites are met.

## 7. What Polar does worse, and why it still feels better

Worse than a good product should:
- Domain verification is on another page; the user leaves the flow and has to come back. "Add connection" is disabled with no inline reason.
- No test sign-in, no "it works" confirmation, no indicator that the IdP side is correct. Enabling is a buried menu item and the connection is created disabled, so the user ends the drawer with nothing visibly working.
- No per-IdP instructions, no logos, no Okta/Entra, no SAML, no SCIM, no discovery from an issuer URL (the user must know the issuer).
- Edit re-requires the client secret every time (`secretRequired` on edit, `EditSSOConnectionModal.tsx:94`).
- No animation on conditional fields; field blocks pop in.
- Empty state has no button; the CTA is far away in the header.
- Delete a connection or disable it has no lockout protection in the UI (the server returns 409 for the last one while enforced; the UI only toasts it).
- "Additional authorization parameters" is a raw key/value editor exposed to every user, with a non-descriptive "Remove" text button per row.

Why it still feels better:
- Restraint. At most four blocks, each a plain bordered card, each with one title and one control. There is no tab bar, no stepper, no sidebar of sub-sections, no badge soup.
- State is expressed in a single sentence that changes (the Enforce description), not in extra UI.
- Dense forms are short: Custom OIDC is three fields. Google is two.
- Consistency: the same card, chip, copy field, drawer and menu are used by every settings page, so SSO feels native to the product and nothing needs learning.
- Type is small and quiet (14px titles, 12px captions, muted descriptions), with one accent colour (green) used only for state.
- A 768px reading column on a white rounded card keeps eyes on one axis.

## Top 8 things worth taking

1. **One settings-card primitive** (`SettingsGroup` + `SettingsGroupItem`, 16px radius, 1px hairlines, 24/16 padding, three row layouts). Build every SSO block out of it, no bespoke panels.
2. **Right-hand drawer, 540px, for create and edit**, with the 0.32s `[0,0,0,1]` slide plus fade and 0.2s `[0.3,0,1,1]` exit, scrim to 50% black. Apple-like and cheap.
3. **Status as a sentence plus a chip plus one button**: the Enforce row's state machine of one-line reasons that disables the control until prerequisites hold. Do this for every gated action (enabling, enforcing, SCIM).
4. **Copy fields as the only way to show values the admin must paste elsewhere**: mono, bordered shell, inline ghost "Copy", check for 2s. Every callback/ACS/entity ID/SCIM base URL/token should use it.
5. **Domain prerequisite as a single info Alert with a link**, not a wizard step. Improve on it: do it inline (add + TXT record + Verify in the same card) so the user never leaves the page, and disable "Add connection" with a reason.
6. **Hard cap on fields at first sight**: provider pick, then only what that provider needs (Polar's Google preset hides auth method and prefills issuer). Extend this idea to Okta, Entra, Google with logos, metadata-URL discovery, and hide everything else under a collapsed "Advanced" instead of Polar's always-visible parameters editor.
7. **Closed-API Status and Alert components** (no className escape hatch) so colour and weight stay uniform across the console.
8. **Typed-slug confirm for destructive/lockout-risk actions** (Enforce), plus the "must be signed in through this org's SSO to enforce" guard. Keep it, and add what Polar lacks: a visible "Test sign-in" step that turns the row's chip to Verified before Enable is offered.
