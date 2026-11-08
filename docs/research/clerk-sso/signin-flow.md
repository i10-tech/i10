# Clerk end-user SSO flow, read from source

Source: clerk-js monorepo at commit b5803ea (2026-10-30). Paths are relative to the repo root.
Abbreviations: `UI` = `packages/ui/src/components`, `CJ` = `packages/clerk-js/src/core`, `SH` = `packages/shared/src`, `BE` = `packages/backend/src`.

Caveat up front: the client holds only the UI half. Home-realm matching, account linking, JIT, membership creation, and org activation all happen in FAPI (server). The client only reveals them through payload fields and error codes. Where I infer server behaviour, I say so.

---

## 1. Home-realm discovery (typing an email routes to SSO)

**There is no client-side domain matching.** The client never inspects the email domain. It sends the identifier to FAPI via `signIn.create` and lets the server decide.

- Submit: `UI/SignIn/SignInStart.tsx` `signInWithFields` (~367-453) calls `signIn.create({ identifier, ... })`. The password field is only sent in that create call when `userSettings.enterpriseSSO.enabled` is false (`buildSignInParams`, 332-346, comment: FAPI errors if a password is sent for an SSO-matching email).
- Password-with-SSO-enabled trick: when enterprise SSO is enabled on the instance, `safePasswordSignInForEnterpriseSSOInstance` (348-364) creates the sign-in WITHOUT the password. Only if the response has NO `enterprise_sso` factor does it replay the password via `attemptFirstFactor({strategy:'password'})`. So a domain-matched user never gets to use a password typed on the start screen.
- The server signals the match through `signIn.supportedFirstFactors`. A matching email yields factor(s) with `strategy: 'enterprise_sso'`. Each factor carries optional `enterpriseConnectionId`, `enterpriseConnectionName`, `enterpriseConnectionLogoPublicUrl`, `enterpriseConnectionProvider` (`SH/types/factors.ts:124-150`, all marked experimental).
- Routing decision, `UI/SignIn/enterpriseSSOFactors.ts`:
  - `hasOnlyEnterpriseSSOFirstFactors` (11-17): every supported first factor is `enterprise_sso`.
  - `shouldHandOffToEnterpriseConnection` (41-47): SSO-only AND exactly one connection AND no SSO bypass factor. If true the UI redirects straight to the IdP, with no factor-one screen.
  - `shouldHandOffUnidentifiedToEnterpriseConnection` (53-55): for `needs_identifier` responses, any `enterprise_sso` factor triggers an immediate redirect (the IdP identifies the user).
  - `SH/internal/clerk-js/enterpriseSSOFactors.ts:8-21`: "multiple" means more than one factor that has both `enterpriseConnectionId` and `enterpriseConnectionName`.
- Start-page switch: `SignInStart.tsx` 416-446 (`needs_identifier` -> maybe hand-off; `needs_first_factor` -> if not hand-off then `navigate('factor-one')` else `await authenticateWithEnterpriseSSO()`).
- Same logic is reused for the organization ticket path (`signIn.create({strategy:'ticket'})`, SignInStart ~217-285, hand-off at ~246-250), and after a protect-check challenge (`UI/SignIn/handleProtectCheck.ts:86-109`, `SignInProtectCheck.tsx:77-96`).
- `authenticateWithEnterpriseSSO` (SignInStart 456-475): `signIn.authenticateWithRedirect({strategy:'enterprise_sso', redirectUrl: ctx.ssoCallbackUrl, redirectUrlComplete: ctx.afterSignInUrl||'/', oidcPrompt: ctx.oidcPrompt, continueSignIn: true})`. It passes NO connection id, so the server must have exactly one candidate.

**Several connections match.** `SignInFactorOne.tsx:185-187` renders `SignInFactorOneEnterpriseConnections` (`UI/SignIn/SignInFactorOneEnterpriseConnections.tsx`) when `hasMultipleEnterpriseConnections`. It is a picker (`@/ui/common/ChooseEnterpriseConnectionCard.tsx`): one button per connection with name, logo URL, provider icon. On click it calls `authenticateWithRedirect` with `enterpriseConnectionId` and `continueSignIn: true` (36-58). A route guard (72-91) redirects to the sign-in URL if there are not multiple connections. Copy: title "Choose an account", subtitle "Select an enterprise account to continue." (`packages/localizations/src/en-US.ts:1804-1807`).

**Is a password or other factor still offered?**

- If the server returns ANY non-`enterprise_sso` first factor alongside SSO, `shouldHandOffToEnterpriseConnection` is false and the user lands on factor-one with `determineStartingSignInFactor` choosing a factor. So password/OTP coexistence is a server decision (surfaced as extra entries in `supportedFirstFactors`).
- `enterprise_sso` is NOT in `localStrategies` (`UI/SignIn/utils.ts:99`), so it is never listed as a button in the "alternative methods" list (`ui/src/hooks/useAlternativeStrategies.ts:24-30` filters to local strategies only). SSO can therefore only be reached by: auto hand-off, the connection picker, or the bypass screen.
- Combined/sign-up-if-missing: unknown identifiers can fall into the sign-up path (`accountDoesNotExistError` handling, SignInStart ~500-530), unrelated to SSO.

On the sign-up side, domain discovery happens server-side too: `SignUp.create` returns `missing_fields` containing `'enterprise_sso'` (see section 3).

---

## 2. SSO bypass (`SignInFactorOneSSOBypass`)

What it is: a server-offered email-code fallback for users who normally must use SSO. The sign-in resource gets a separate field `ssoBypassFirstFactors` (`CJ/resources/SignIn.ts:124`, parsed at 780, serialized at 853; also on `SignInFuture` at 979). `getSSOBypassFactor` (`enterpriseSSOFactors.ts:23-29`) returns the `email_code` factor from that list, but only if `supportedFirstFactors` also contains an `enterprise_sso` factor. Otherwise null.

Who gets it: decided entirely by the server. From the org-side API, it is an org-managed allowlist: `organization.ssoBypassAllowlist` (`CJ/resources/SSOBypassAllowlist.ts`, REST `/organizations/{id}/sso_bypass_allowlist_users`, add/bulk-add (100 per request)/list/remove). Types doc (`SH/types/ssoBypassAllowlist.ts`, `SH/types/organization.ts:242-246`): "members who may sign in with an email code when the organization's enterprise SSO is unavailable"; requires org permission `org:sys_entconns_sso_bypass:manage`; adding requires the member to hold a verified email served by one of the org's connections (error code surfaced as `sso_bypass_domain_not_served`, en-US ~2227: "could not be added because their email address is not served by a connection"). The allowlist does not sync with roles ("This list does not sync, members are managed manually", en-US ~1520). Allowlist UI: `UI/OrganizationProfile/SecuritySSOBypassSection.tsx`, `SSOBypassAllowlistPage.tsx`. The code comment in `SignInFactorOneSSOBypass.tsx:24` says "a user the instance has allowlisted", and the type docs say organization. Both exist in the code; the allowlist API is org-scoped.

Where it appears: `SignInFactorOne.tsx:122` freezes the bypass factor on mount (comment: client piggybacking could drop the field and unmount mid-flow), and `177-179` returns `<SignInFactorOneSSOBypass bypassFactor=.../>` BEFORE the multi-connection check or any factor card. Also `shouldHandOffToEnterpriseConnection` returns false when a bypass factor exists, so the start page sends these users to factor-one rather than auto-redirecting.

What the UI does (`UI/SignIn/SignInFactorOneSSOBypass.tsx`):

- Two steps, `'sso'` and `'code'` (17, 36).
- SSO step, single connection (132-159): standard sign-in header, a primary "Continue with SSO" button (`signIn.enterpriseSSO.formButtonPrimary`) that calls `authenticateWithRedirect` (no connection id), plus a card action link "Can't use SSO?" (`signIn.ssoBypass.actionLink`) which switches to the code step.
- SSO step, multiple connections (110-130): the same picker as section 1 with the "Can't use SSO?" link as a child.
- Code step (82-99): reuses `SignInFactorOneCodeForm` with `factor = bypassFactor`, `factorAlreadyPrepared=false`, title "Check your email", and a notice `signIn.ssoBypass.notice`: "Your organization requires single sign-on. Continuing without it is recorded." (en-US 1880-1888). The back/alternative link returns to the SSO step. The bypass is explicitly framed as audited.
- A protect-check error on redirect prep navigates to `../protect-check` instead of showing an error (54-60).

---

## 3. Redirect round trip

### Outbound

- `SignIn.authenticateWithRedirect` (`CJ/resources/SignIn.ts:511-525`, impl `authenticateWithRedirectOrPopup` 422-509):
  1. `redirectUrl = clerk.buildUrlWithAuth(params.redirectUrl)` (adds dev-browser/auth token); `actionCompleteRedirectUrl = params.redirectUrlComplete`.
  2. `shouldCreateSignIn = !this.id || !continueSignIn`. With `continueSignIn: true` and an existing sign-in, it reuses it (so the identified user/ticket survives) and only calls `prepare_first_factor`.
  3. If `strategy === 'enterprise_sso'` it POSTs `prepare_first_factor` with `{strategy, redirectUrl, actionCompleteRedirectUrl, oidcPrompt, slackTeamIdHint, enterpriseConnectionId}` (479-488, `coalesce: true`). SignIn config type: `redirectUrl, actionCompleteRedirectUrl, oidcPrompt, enterpriseConnectionId` (lines 294-300).
  4. Navigates to `firstFactorVerification.externalVerificationRedirectURL` if `status === 'unverified'`; otherwise throws an invalid-response error (501-505).
  5. Protect-check handling: a challenge raised during create/prepare either lets the redirect proceed (if create already produced a hand-off URL, the challenge runs after the IdP returns) or throws `ClerkRuntimeError` code `protect_check_required` (453-458) that the UI converts to a navigation to the challenge route.
- Other param names: `identifier` (target a connection by email at sign-in), `emailAddress` (sign-up), `legalAccepted`, `continueSignUp`, `unsafeMetadata`, `oidcPrompt` (`SH/types/redirects.ts:31-90`). `oidcLoginHint` exists only for linking an external account (`CJ/resources/ExternalAccount.ts`, `User.createExternalAccount`). The SAML `login_hint` mode is configured on the connection (section 7).
- Sign-up: `SignUp.authenticateWithRedirect` (`CJ/resources/SignUp.ts:440-515`) `create()`s (or `update()`s when `continueSignUp && id`) with `strategy: 'enterprise_sso'`, `enterpriseConnectionId`, `emailAddress`, then navigates to `verifications.externalAccount.externalVerificationRedirectURL`. It retries once after reloading the environment on a captcha error.
- Sign-up missing field: if the sign-up requires SSO, `missing_fields` contains `'enterprise_sso'`. `completeSignUpFlow` (`SH/internal/clerk-js/completeSignUpFlow.ts:46-60`) then calls `signUp.authenticateWithRedirect({strategy:'enterprise_sso', continueSignUp:true, ...})` automatically. Protect-check is resolved BEFORE the hand-off (34-44). `SignUpStart.tsx:350-353` catches API error code `enterprise_connection_id_is_required_with_multiple_connections` and navigates to `./enterprise-connections`. That page (`UI/SignUp/SignUpEnterpriseConnections.tsx`) GETs `/client/sign_ups/{id}/enterprise_connections` (`SignUp.ts:670-679`, returns `{id,name,provider,logoPublicUrl}`) and shows the same picker with `continueSignUp:true`. `navigateToNextStepSignUp` (`SH/internal/clerk-js/navigateToNextStepSignUp.ts:31-62`) order: protect-check, then `enterprise_sso` missing -> enterprise-connections page, then missing fields -> continue, then verify email/phone.

### Callback (`Clerk.handleRedirectCallback`, `CJ/clerk.ts:2627-2964`; UI wrapper `ui/src/common/SSOCallback.tsx`)

The UI mounts `/sso-callback` (`SignInSSOCallback` / `SignUpSSOCallback`). The component calls `handleRedirectCallback({...params, reloadResource}, navigate)`, where `reloadResource` comes from the `intent=signIn|signUp` query param. On throw: shows the error in the card and bounces to `../` after 4s (`SSOCallback.tsx:34-45`). Param sets: `UI/SignIn/buildOAuthCallbackParams.ts` (first factor `../factor-one`, `../factor-two`, `../reset-password`, `../protect-check`, sign-up step URLs including `enterprise-connections`, `transferable`, `unsafeMetadata`).

Decision order inside `_handleRedirectCallback` (first match wins; line numbers in `clerk.ts`):

1. 2762: `si.status === 'complete'` -> `setActive`, redirect to after-sign-in (or session task route if `session.currentTask`).
2. 2785/2792: sign-in or sign-up protect_check -> protect-check route (scoped by intent so a stale gate from an abandoned attempt cannot hijack).
3. 2796: external account `transferable` with error `external_account_exists` -> `signIn.create({transfer:true})`, then complete / factor-one / factor-two / reset-password.
4. 2828-2836: `user_locked` on sign-up or sign-in -> back to sign-up / sign-in page (the page shows the error).
5. 2839: `needs_first_factor` and NOT every factor is `enterprise_sso` -> factor-one (the "unverified email, ordinary factor" case).
6. `needs_new_password` -> reset-password.
7. 2852-2880: `firstFactorVerification.status === 'transferable'` OR `continuation === 'transfer_to_sign_up'` -> if `params.transferable === false` go to sign-in; otherwise `signUp.create({transfer:true, unsafeMetadata})` then complete or `missing_requirements` via `navigateToNextStepSignUp`.
8. `su.status === 'complete'` -> setActive.
9. 2901: `needs_second_factor` -> factor-two.
10. 2915: `identifier_already_signed_in` -> `setActive` the existing session id.
11. 2932: sign-up has an external account error -> sign-up page (page displays it).
12. verified external account with missing requirements -> next sign-up step.
13. 2948: `session.currentTask` -> `redirectToTasks`.
14. 2955-2961: multi-connection `needs_first_factor` -> factor-one (chooser again).
15. fallthrough -> sign-in page.

### Errors shown

Errors persist on the resource (`signIn.firstFactorVerification.error`, `signUp.verifications.externalAccount.error`) and are rendered when the user lands back on the start page.

- `SignInStart.tsx:288-329` (`handleOauthError`) and `SignUpStart.tsx:~195-225` show the server error object in the card for these codes (`SH/internal/clerk-js/constants.ts:24-60`): `not_allowed_to_sign_up`, `oauth_access_denied`, `not_allowed_access`, `saml_user_attribute_missing`, `oauth_email_domain_reserved_by_saml`, `user_locked`, `external_account_not_found`, `sign_up_mode_restricted`, `sign_up_restricted_waitlist`, `enterprise_sso_user_attribute_missing`, `enterprise_sso_email_address_domain_mismatch`, `enterprise_sso_hosted_domain_mismatch`, `saml_email_address_domain_mismatch`, `organization_membership_quota_exceeded_for_sso`, `captcha_invalid`, `device_blocked`, `action_blocked`, `signup_rate_limit_exceeded`, `user_banned`, `user_deactivated`.
- Any other code is replaced by a generic string: unable to complete the action, contact support (SignInStart 321, SignUpStart ~222).
- After showing, the start page calls `signIn.create({})` / `signUp.create({})` (SignInStart 325) to wipe the failed attempt so a refresh does not replay it.
- The message text is mostly server `long_message`. In `en-US.ts` almost all of these have `unstable__errors` keys set to `undefined` (server text used), except `oauth_access_denied` ("You did not grant access to your account.", ~2188) and `organization_membership_quota_exceeded` ("You have reached your limit of organization memberships, including outstanding invitations.", ~2192; note the SSO-specific `_for_sso` code has no client override). Protect-check codes do have client text (~2210-2220).
- Client-thrown: `protect_check_required` ("This sign-in needs an extra verification step that can't be shown here..."), invalid FAPI response.

### Linking, JIT, account matching (what the client shows)

- Sign-in callback `transferable` plus sign-up transfer is how an SSO login for an unknown user becomes a sign-up (that is JIT creation). If JIT is off the server cannot produce `transferable`; the user instead gets an error from the list above, most plausibly `not_allowed_to_sign_up` / `external_account_not_found` / `sign_up_mode_restricted`. The exact error for `disableJitProvisioning` is not named anywhere in the client. Treat as unverified.
- Existing user + SSO email: `external_account_exists` + `transferable` -> `signIn.create({transfer:true})` (step 3 above). This is Clerk's "attach the enterprise identity to the existing user" path, and the server decides if it is allowed.
- `allowOrganizationAccountLinking` (field on connection): per the backend doc, "Whether existing users who are members of the organization can link their account to their enterprise identity. If false, only sign-up flows apply" (`BE/api/endpoints/EnterpriseConnectionApi.ts:127,155`). So when false, an EXISTING user cannot be silently linked by sign-in via the org connection; only new sign-ups happen. Client use: UserProfile (section 5).
- `disableAdditionalIdentifications` (connection): users arriving through it cannot add other identifiers. The client uses it to hide phone codes as an MFA option (section 6) and to lock name/password editing (section 5).

---

## 4. Organization-scoped connections

What is visible client-side (membership creation and activation are server work; I found no client code that creates a membership or activates an org after SSO):

- A connection has `organizationId` (`CJ/resources/EnterpriseConnection.ts:109,135`; backend `organizationId`, "Organization ID if the connection is scoped to an organization", `BE/.../EnterpriseConnection.ts:238-241`). Created via `Organization.createEnterpriseConnection` -> `POST /organizations/{id}/enterprise_connections` (`CJ/resources/Organization.ts:207-218`), with test runs, directory sync (SCIM) and bypass allowlist beneath the org.
- Domains: connection `domains` must be verified domains of the org (`CreateEnterpriseConnectionParams.domains`, "Verified Domains... at least one"). A localized error exists for adding a domain that already belongs to a connection (`organization_domain_exists_for_enterprise_connection`).
- Membership quota: `organization_membership_quota_exceeded_for_sso` is a first-class SSO sign-in error (section 3). This proves that SSO sign-in creates an org membership server-side and fails when the org's limit is hit. The copy in the SSO card text says new members get a default role: "New members will be assigned to {{role}} in this organization" (`organizationProfile.securityPage.ssoSection.tooltip`, en-US ~1580), and "Members without a matching domain can still sign in using existing auth methods."
- Enforcement semantics shown to admins: "Require members with a matching email domain to sign in through your identity provider" (`ssoSection.descriptionLine1`). Bypass users are the exception. Deactivating a connection frees users from SSO.
- Org activation after SSO: not done by the SSO code. The generic session machinery handles it: `session.currentTask` key `choose-organization` (`SH/types/session.ts:501-504`) when `forceOrganizationSelection` is on (`CJ/clerk.ts:958-960, 1439, 1484, 1998`). `handleRedirectCallback` step 13 sends the user to tasks if a task is pending. `TaskChooseOrganization` lists memberships, suggestions, invitations. So SSO into an org-scoped connection does NOT automatically set the active org on the client; the task or app code does it.
- Self-serve configuration UI (`UI/ConfigureSSO/*`, `UI/OrganizationProfile/Security*`, `EnterpriseConnectionPage/*`): status badges unconfigured / in progress / active / inactive (`enterpriseConnectionStatusBadges.ts`); permissions `org:sys_entconns:manage` and `org:sys_entconns_sso_bypass:manage` (`useSecurityCapabilities.ts`). A test run endpoint validates the connection before activation (`EnterpriseConnectionTestRun`).

---

## 5. UserProfile

- Section visibility (`UI/UserProfile/AccountSections.tsx:70-78`): shown only when `userSettings.enterpriseSSO.enabled`. `EnterpriseAccountsSection.tsx:118-136` renders only if the user has an ACTIVE enterprise account (`enterpriseConnection.active`) or a linkable connection.
- Display: per account, connection name, a dot, the account's email, provider/connection logo; a "requires action" badge when `account.verification.error` exists (`EnterpriseAccount`, 168-212). The error text is read but not shown.
- Linking: `__internal_useUserEnterpriseConnections({withOrganizationAccountLinking:true})` -> `GET /me/enterprise_connections?with_organization_account_linking=true` (`CJ/resources/User.ts:377-397`). A connection is linkable only if `c.allowOrganizationAccountLinking` and the user has no account for it (130-132). "Connect account" menu -> `user.createExternalAccount({enterpriseConnectionId, redirectUrl})` (`POST /me/external_accounts`, `User.ts:171-190`), wrapped in `useReverification` (step-up), then window navigates to `verification.externalVerificationRedirectURL`.
- **Unlinking: not in the UI.** `EnterpriseAccount.destroy` exists on the resource (`CJ/resources/EnterpriseAccount.ts:64`), but the section has no menu or remove action. A user cannot disconnect an enterprise account from the prebuilt UI.
- Locks while an active enterprise account exists: profile name edit disabled (`ProfileForm.tsx:56`), password edit disabled (`PasswordForm.tsx:60`), with explanatory copy "you can sign in only via the enterprise connection" / "provided by the enterprise connection and cannot be edited" (en-US ~2505, ~2534).
- Email verification via connection: `EmailAddress.matchesSsoConnection` (`CJ/resources/EmailAddress.ts:21,128`) selects strategy `enterprise_sso` (`EmailForm.tsx:150-163`, priority over email link/code). `VerifyWithEnterpriseConnection.tsx` calls `email.createEnterpriseSSOLinkFlow()` -> `prepareVerification({strategy:'enterprise_sso', redirectUrl})` (`EmailAddress.ts:81-114`), shows a "Click to sign-in" link to `verification.externalVerificationRedirectURL` and polls `reload()` until `verification.status === 'verified'` (popup/new-tab style, not a redirect-return). Copy: "Complete the sign-in with {{identifier}}" (en-US ~2417).
- Secondary: UserVerification AlternativeMethods also references enterprise SSO for step-up (`UI/UserVerification/AlternativeMethods.tsx`; `Session.ts:278-283` prepares `enterprise_sso` second-level verification with `enterpriseConnectionId`).

---

## 6. Session tasks around SSO

- Task keys (`SH/types/session.ts:501-504`): `choose-organization`, `reset-password`, `setup-mfa` (routes in `SH/internal/clerk-js/sessionTasks.ts:9-12`). There are NO SSO-specific tasks. `SessionTasks/index.tsx` just routes by `session.currentTask.key`.
- After an SSO sign-in, a pending task makes the session `pending`: `handleRedirectCallback` (`clerk.ts:2762-2776, 2948`) either `setActive` + `navigateIfTaskExists` or `redirectToTasks`.
- `setup-mfa` + enterprise: `UI/SessionTasks/tasks/TaskSetupMfa/index.tsx:33-45` filters second factors for users with enterprise accounts. It reads only `enterpriseAccounts[0]`, and drops `phone_code` unless that connection has `disableAdditionalIdentifications === false`. (`SmsCodeFlowScreen.tsx` also references it.) So Clerk assumes an SSO user's MFA is the IdP's job, offers TOTP/backup/etc. only if the instance requires MFA, and blocks adding a phone identification.
- No code skips or auto-satisfies MFA after SSO. Whether SSO sign-in produces `needs_second_factor` is server-decided; the ticket and SSO tests in memory notes ("fresh ticket skips 2FA") are server behaviour.
- `reset-password` task only triggers on compromised/forced reset flows and is not meaningful for SSO-managed accounts (password edit locked).

---

## 7. Backend model (`BE/api/endpoints/EnterpriseConnectionApi.ts`, `BE/api/resources/EnterpriseConnection.ts`, `EnterpriseAccount.ts`)

REST: `POST/GET/PATCH/DELETE /enterprise_connections[/{id}]`. List filters: `organizationId`, `active`, pagination. Body keys are deep-snake-cased.

**EnterpriseConnection (response)**

- `id`, `name`: identity/label.
- `domains[]`: email domains the connection serves (home-realm matching input). Must be at least one on create; "Verified Domains".
- `organizationId | null`: scoped to an org, or instance-wide when null.
- `active`: usable at all.
- `syncUserAttributes`: pull name/email/custom attrs from the IdP on each sign-in. Create ignores it (deprecated); set via update.
- `disableAdditionalIdentifications`: users via this connection cannot add other emails/phones. Update only.
- `allowSubdomains` (top-level deprecated, always undefined; use `samlConnection.allowSubdomains`): match `a.b.corp.com` against `corp.com`.
- `provider`: `saml_custom | saml_okta | saml_google | saml_microsoft | oidc_custom | oidc_github_enterprise | oidc_gitlab`. Not changeable after create.
- `logoPublicUrl`: icon for pickers.
- `allowOrganizationAccountLinking`: existing org members may link accounts to the enterprise identity; false = sign-up only.
- `authenticatable`: connection may be used for sign-in and sign-up (requires the instance feature "authenticatable enterprise connections"). False appears to mean it exists (for domain/SCIM/linking) without handling logins.
- `disableJitProvisioning`: do not create users on first SSO login.
- `customAttributes[]` (only when instance feature enabled): `name` (display), `key` (storage key), `ssoPath` (SAML/OIDC claim path to read), `scimPath` (SCIM attribute path), `multiValued`.
- `samlConnection | null`, `oauthConfig | null`, `createdAt`, `updatedAt`.

**samlConnection**: `id`, `name`, `active`; IdP side: `idpEntityId`, `idpSsoUrl`, `idpCertificate` (+ issued/expires; first of `idpCertificates`), `idpCertificates[{certificate (base64 DER), issuedAt, expiresAt}]` (supports rotation, replaces all on write), `idpMetadataUrl`, `idpMetadata` (XML, write-only, never returned); SP side (Clerk): `acsUrl`, `spEntityId`, `spMetadataUrl`; behaviour: `allowSubdomains`, `allowIdpInitiated` (IdP-initiated login), `forceAuthn` (IdP must re-authenticate every time, ignoring its session), `syncUserAttributes` (deprecated nested, undefined), `loginHint`, plus input-only `attributeMapping {userId, emailAddress, firstName, lastName}` that maps SAML attribute names.

- `loginHint.mode`: `email_address` (send typed identifier as `login_hint` to the IdP), `custom_attribute` (send the value of the user `publicMetadata[source]`), `off` (omit). `source` only with `custom_attribute`.

**oauthConfig (OIDC)**: `id`, `name`, `clientId`, `clientSecret` (write-only), `providerKey` (e.g. `custom_oidc`), `discoveryUrl`, `authUrl`, `tokenUrl`, `userInfoUrl`, `requiresPkce` (must be true for public clients), `logoPublicUrl`, timestamps.

**EnterpriseAccount (per user, on User.enterpriseAccounts)**: `id`, `active`, `emailAddress`, `firstName`/`lastName` from the IdP, `protocol` (`saml|oauth`), `provider`, `providerUserId`, `publicMetadata`, `verification`, `lastAuthenticatedAt`, `enterpriseConnectionId`, and a nested connection summary (`domain`, `allowIdpInitiated`, `allowSubdomains`, `disableAdditionalIdentifications`, `syncUserAttributes`, ...).

Not on BAPI: org bypass allowlist, test runs, and directory sync are FAPI/organization endpoints only (see section 2/4).

---

## 8. What a thorough own-built SSO layer should copy or deliberately differ on

Copy:

1. Server-side domain discovery with the client acting on a factors list. Never match the domain in the browser. Hand off only when SSO is the sole factor AND there is exactly one connection AND no bypass; any choice (multiple connections, bypass) must render a screen.
2. Drop the typed password on the floor when SSO may apply; replay it only after the server confirms no SSO factor (Clerk's `safePassword...` pattern). An SSO domain must never accept a password on the start screen.
3. Never list SSO as an "alternative method" button; only auto hand-off, picker, or bypass screen.
4. Freeze bypass/fallback state on mount so re-fetches cannot unmount the screen mid-flow.
5. Bypass: separate field from normal factors, only valid if SSO is also present, explicit notice that it is recorded/audited, manual allowlist (no role sync) managed by a dedicated permission, rejected at add-time if the user's email is not served by a connection, bulk add in batches of 100 with per-user error codes.
6. Resume semantics: `continueSignIn` reuse plus per-attempt refresh of the redirect; keep error on the resource, show once, then wipe the attempt so a refresh does not replay it.
7. Error allowlist: show server text only for a known set of SSO/auth codes, generic message for the rest. Include quota-exceeded, attribute-missing, domain-mismatch, hosted-domain-mismatch, locked, banned.
8. Callback ordering (section 3): complete -> challenge -> transfer to existing -> locked -> first factor -> transfer to sign-up -> second factor -> already-signed-in -> error -> pending task. Scope stale gates by intent.
9. Lock profile name/password edits and restrict phone-code MFA for SSO-managed users; require re-verification (step-up) before linking an enterprise account.
10. Connection fields worth mirroring in a schema: `domains`, `active`, `authenticatable`, `disableJitProvisioning`, `allowOrganizationAccountLinking`, `syncUserAttributes`, `disableAdditionalIdentifications`, `forceAuthn`, `allowIdpInitiated`, `allowSubdomains`, login-hint mode, multi-cert rotation, custom attribute `ssoPath`/`scimPath`, a `test run` gate before activation.

Differ deliberately (gaps or choices in Clerk's design that your layer should decide on):

1. **No per-workspace enforcement flag in the client.** Clerk enforces implicitly by domain match plus `enterprise_sso`-only factors. You need an explicit "enforce SSO for this workspace" bit, separate from "connection exists", and a defined behaviour for non-domain members (Clerk's copy lets them use existing auth methods).
2. **Unlinking:** Clerk's prebuilt UI offers none, and the resource allows `destroy`. For managed accounts, decide who can unlink (probably nobody, admin only) and what happens to sign-in afterwards.
3. **JIT-off error is unnamed on the client.** Define a dedicated code (for example `sso_jit_disabled`) and message rather than relying on `not_allowed_to_sign_up`.
4. **Org activation after SSO is left to tasks/app.** Decide whether SSO into a workspace connection activates that workspace immediately; with a token-minting bridge you can set it directly.
5. **MFA after SSO is server-implicit.** Make it explicit: trust IdP MFA vs. require your own, and record which.
6. **Bypass scope:** Clerk's bypass is "email code, recorded". Add expiry or one-shot semantics, rate limits, and admin notification on use. Also decide whether bypass applies when the IdP is up (Clerk's UI offers it any time, not only during an outage).
7. **Error messages for ops:** Clerk's `enterprise_sso_*` errors are server-text; surface which connection and which attribute failed, to admins (your test-run equivalent) rather than the end user.
8. **Picker data leaks:** the picker exposes connection names/logos to anyone typing a matching email. Consider whether that is acceptable for private tenants.
9. **Multi-connection ordering:** Clerk has no priority/default. If several workspaces claim a domain, define precedence; with your bridge you can resolve by workspace invite or last used rather than a picker.
10. **Audit:** Clerk's "recorded" notice implies server logging; no client API reads it. Build an audit trail you can query and show to admins.

> **Corrected live (2026-11-02):** org activation after SSO IS done, server-side. On the dev probe the JIT session came back with `last_active_organization_id` set to the connection's org. See `../sso-polar-clerk-study.md` section 3.
