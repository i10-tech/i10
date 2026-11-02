# Clerk self-serve SSO / Directory Sync admin UI: what to learn from it

Source: clerk-js monorepo at commit b5803ea (2026-10-30), cloned at `clerk/javascript`. Read-only research.

Path shorthands (all under `packages/`):
- `SSO` = `ui/src/components/ConfigureSSO`
- `DS` = `ui/src/components/ConfigureDirectorySync`
- `OP` = `ui/src/components/OrganizationProfile`
- `RES` = `clerk-js/src/core/resources`
- `TYP` = `shared/src/types`
- `HOOK` = `shared/src/react/hooks`
- `LOC` = `localizations/src/en-US.ts` (all admin copy: `configureSSO` at 379-1051, `configureDirectorySync` at 229-378, `organizationProfile.securityPage` at 1412-1575)

Naming caveat: `SSO/domain/connectionScope.ts` is only a 2-line type (`{kind:'new'} | {kind:'existing', id}`, line 2). The real "scope rules" (which domains a connection may hold) live in `SSO/domain/organizationEnterpriseConnection.ts` and `SSO/hooks/useOrganizationEnterpriseConnection.ts`. See section 3.

---------------------------------------------------------------------

## 0. Architecture in one paragraph

Clerk keeps NO client-side wizard state that has to survive. Everything is derived from server state (connection resource + org domains + a "has a successful test run" probe) through pure reachability predicates. On mount the wizard lands on the furthest step whose predicate chain holds (`SSO/elements/Wizard/reducer.ts:52-62`). Reload, closing the tab, or returning a week later all resume correctly. Nothing is stored in localStorage/sessionStorage/URL (grep across both wizards finds none). One entity (`organizationEnterpriseConnection`, `SSO/domain/organizationEnterpriseConnection.ts:166-183`) drives wizard gating, list badges and menu actions. An org can have several connections; the wizard edits one "scoped" connection (`kind:'new'` while none exists yet). Connections are created early (right after provider selection) and progressively PATCHed; an unfinished one is "In progress" in the list.

---------------------------------------------------------------------

## 1. The wizard

Top level: `SSO/ConfigureSSOWizard.tsx:21-44`. Four breadcrumb steps. Header stepper: `SSO/ConfigureSSOHeader.tsx` (only labelled steps show; `select-provider` has no label, so it is a hidden sub-step).

| # | id / label | Reachable when | Complete when |
|---|---|---|---|
| 1 | `verify-domain` "Domains" | always | `areConnectionDomainsReady` (>=1 domain, all verified, none claimed elsewhere) |
| 2 | `configure` "Connection" | `domainsReady \|\| connection exists` | `hasMinimumConfiguration \|\| active` |
| 3 | `test` "Test" | `hasMinimumConfiguration \|\| active` | `hasSuccessfulTestRun \|\| active` |
| 4 | `activate` "Activate" | `hasSuccessfulTestRun \|\| active` | `active` |

- Breadcrumb items clickable only when reachable; disabled bullet and blocked `goToStep` use the same predicate (`reducer.ts:123-136`). Next/Prev move exactly one slot (`reducer.ts:86-121`).
- A guard-blocked `goNext` right after a save does not fail. It parks a "pending next" and a render-phase resolver advances once fresh data lands (`SSO/elements/Wizard/useWizardMachine.ts:69-78,137-147,178-184`). This avoids the double-click race after "save then advance".
- If the active step becomes unreachable (connection deleted in another tab or via Reset), the machine re-seats to the furthest reachable step during render (`useWizardMachine.ts:99-121`).
- `forceInitialStep`: "Configure"/"Add connection" on the Security page starts at step 1 (`OP/SecuritySsoSection.tsx:90`, `OP/OrganizationSecurityPage.tsx:67-70`, `ConfigureSSOWizard.tsx:46`). "Continue configuration" from the list opens at the furthest reachable step.

### Step 1: Domains (`SSO/steps/OrganizationDomainsStep.tsx`)
- Asks: type a domain, click Add (`DomainsField`, 244). If the org has no domains and the user has a primary email, a one-click suggestion "Your email uses X. Add it?" with dismiss (`DomainSuggestion`, 312-389).
- Client validation: `DOMAIN_REGEX = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i` (241). Trimmed and lowercased. Rejects protocol/path/port/single-label. Duplicate in the org's list rejected (259). Server errors (field or global) show as an alert (77-86).
- Create = two calls: POST domain with `enrollment_mode=enterprise_sso`, then immediately `prepare_ownership_verification` so a TXT challenge exists (`HOOK/useOrganizationDomains.tsx:102-115`).
- Each domain is a card: checkbox "Use X for this connection", badge Verified / Unverified / Expired, plus "Used by another connection" when claimed (489-509).
- Unverified card shows the TXT record: Type `TXT`, Host/Name (`txtRecordName` or `@`), Value (`txtRecordValue`, copy button), copy "Add this TXT record to your DNS provider. We'll verify automatically once the record is live", plus a spinner (`TxtRecord`, 611-671). Verified card: "Verified on <date>". Expired card: expiry-date copy + "Verify again" which re-calls prepare (`ExpiredNotice`, 560-609).
- Verification poller: `__internal_useOrganizationDomains` calls `attempt_ownership_verification` every 10 s for all domains in status `unverified` until all are verified, revalidating the list after each attempt (`HOOK/useOrganizationDomains.tsx:18,147-204`). Newly verified domains auto-attach to the scoped connection via PATCH `domains` unless another connection claims them (`SSO/hooks/useOrganizationEnterpriseConnection.ts:236-262`). Expired domains are NOT polled.
- Blocks Next: `!domainsReady` (216). Not skippable. (Exception: step 2 is reachable for an existing connection even if domains regress, so editing is never locked out.)
- Last-domain lock: with an existing connection and exactly one domain, its checkbox and remove button are disabled with tooltips "At least one verified domain is required to set up SSO" / "...to keep SSO enabled" when active (132-137,196-199).
- Remove domain: dialog (section 5); first PATCHes the connection's `domains` minus X (if selected), then DELETEs the org domain, then revalidates (121-128).

### Step 2: Connection = nested wizard (`SSO/steps/ConfigureStep/index.tsx`)
Sub-steps `select-provider` then `configure-provider` (guard: connection exists, line 39). Starts at select-provider when arriving forward (`direction === 1`), else resumes at furthest reachable (43).

**2a Select provider** (`SSO/steps/SelectProviderStep.tsx`): radio card grid. Groups: SAML (Okta Workforce, Microsoft Entra, Google Workspace, Custom SAML) and OIDC (one "OIDC Provider" card; every `oidc_*`/`oauth_custom_*` collapses to it, `SSO/domain/providers.ts:19-63`). Continue (55-81):
- no connection: POST create with `provider` + currently selected domains, then next. Domain conflicts return as a field error on `domains` and show as the step alert (83-92).
- same provider as existing: just next.
- different provider: "Change provider" dialog (section 5) -> DELETE old connection then POST new one with the old domains (`useOrganizationEnterpriseConnection.ts:312-332`). Deliberately non-atomic.
- A stale localized warning says provider cannot change after selection (`LOC` selectProviderStep.warning); the code allows it with the dialog.

**2b Configure provider** (`resolveConfigureSteps`, `ConfigureStep/index.tsx:22-32`): provider-specific nested linear wizard with a "n/N" counter, always starting at its first step. The last step PATCHes and bubbles `goNext` to the parent, which defers into Test until the PATCH is reflected. Instruction-only steps have no validation (Continue always enabled). Each footer has Reset (when a connection exists), Previous, Continue. An amber dismissible banner warns "This connection is active. Saving changes applies immediately..." when editing an active connection (`ActiveConnectionAlert.tsx`).

Step lists:
- Okta SAML (`SamlOktaConfigureSteps.tsx:41-46`): create-app, attribute-mapping, assign-users, identity-provider-metadata.
- Entra SAML (`SamlMicrosoftConfigureSteps.tsx:49-54`): create-app (includes assign users/groups), service-provider, attribute-mapping, identity-provider-metadata.
- Google SAML (`SamlGoogleConfigureSteps.tsx:28-34`): create-app, identity-provider-metadata, service-provider, attribute-mapping, configure-user-access. IdP metadata comes FIRST, so the connection is "configured" at step 2 of 5.
- Custom SAML (`SamlCustomConfigureSteps.tsx:28-33`): create-app, attribute-mapping, assign-users, identity-provider-metadata.
- OIDC (`OidcCustomConfigureSteps.tsx:10`): redirect-uri, endpoints, credentials.

SAML IdP metadata step (`ConfigureStep/saml/shared/IdentityProviderConfigurationForm.tsx`):
- Mode (segmented): `metadataUrl` | `manual` for Okta/Entra/Custom; `metadataFile` | `manual` for Google. Default is `manual` if config already exists, otherwise the metadata mode (e.g. Okta 510-518, Google 159-165).
- Required to continue: metadataUrl needs a non-empty trimmed URL; manual needs Sign-on URL + Issuer + >=1 certificate.
- Payload (`buildSamlConfigurationPayload`, 199-231): metadataUrl -> `{idpMetadataUrl}`; metadataFile -> `{idpMetadata: <raw XML text>}` (`.xml`); manual -> `{idpSsoUrl, idpEntityId, idpCertificates?}` (certs sent only if the list changed).
- All parsing and validation of metadata is server-side. A server error whose code starts `saml_` with no param name is pinned onto the primary field (`applySamlSubmitError`, 233-253).
- Fields prefill from the saved connection on re-entry.

OIDC (`ConfigureStep/oidc/shared/`):
1. Redirect URI: read-only copy of `oauthConfig.redirectUri`, with "create an OIDC app that supports the authorization code grant". Shows the claims the ID token must carry: `sub` (External user ID, required), `email` (required), `given_name`, `family_name` (optional) (`OidcRedirectUriStep.tsx:18-27`).
2. Endpoints: segmented `discoveryUrl` (default) | `manual` (default flips to manual only when `authUrl` is set and `discoveryUrl` is not, `OidcCustomConfigureSteps.tsx:16`). Discovery needs a URL; manual needs Authorization URL + Token URL, User Info URL optional. PATCH `{oidc:{discoveryUrl}}` or `{oidc:{authUrl,tokenUrl,userInfoUrl}}` (`OidcEndpointsStep.tsx:64-114`).
3. Credentials: Client ID + Client secret, both required. The secret is never returned, so it is blank on re-entry and must be retyped to pass (`OidcCredentialsStep.tsx:42-69`). The PATCH also re-sends the saved discovery/endpoint URLs. No PKCE toggle in the UI although the API accepts `oidc_requires_pkce`.

### Step 3: Test: see section 4. Continue is never disabled; on click, if the local probe says no success it re-queries the server (`status=success`, limit 1) so a success from another tab counts, and only then shows "You need at least one successful test run before you can continue..." (`TestConfigurationStep.tsx:201-260`, handler 226). Footer: Reset, Previous, Continue.

### Step 4: Activate: see section 5.

### Reload / leaving
- Server-derived only; the wizard re-derives its entry step. The Security overview lists an unfinished one as "In Progress" with "Continue configuration" (`OP/SecuritySsoSection.tsx:149-156`).
- Which view is open on the Security page (overview/wizard/connection/directory/bypass) is local React state (`OP/OrganizationSecurityPage.tsx:63`), so a reload returns to the overview. Nothing in the URL.
- Unsaved typed values and a not-yet-saved cert file are lost on leave; only a successful PATCH persists.
- A connection page whose connection vanished falls back to overview at render time (`OrganizationSecurityPage.tsx:79-82`).
- One skeleton on load; test runs only gate the skeleton if a connection was already configured at first load, so mid-flow creates never re-flash it (`useOrganizationEnterpriseConnection.ts:189-210`).

---------------------------------------------------------------------

## 2. Providers and presets

API enum: `saml_custom | saml_okta | saml_google | saml_microsoft | oidc_custom | oidc_github_enterprise | oidc_gitlab` (`TYP/enterpriseConnection.ts:148-155`). Self-serve UI offers only the first five; others show "Unsupported provider" (`ConfigureStep/index.tsx:83-89`).

What Clerk gives the admin to paste into the IdP (all from the create response, no extra call):

| Type | Values (copy buttons) | Fields |
|---|---|---|
| SAML (all) | ACS URL, SP Entity ID. Shown on create-app for Okta/Custom, on the service-provider step for Entra/Google | `samlConnection.acsUrl`, `.spEntityId` |
| SAML, post-setup page | ACS URL, Entity ID, Metadata URL | + `.spMetadataUrl` (`OP/EnterpriseConnectionPage/ServiceProviderSection.tsx`) |
| OIDC | Redirect URI | `oauthConfig.redirectUri` |

SP metadata URL is not shown during setup, only afterward. Many IdPs can import it; worth showing earlier.

"Presets" are static localized instruction text and provider-specific labels. No form values are prefilled except from saved config.
- **Okta Workforce**: SP labels "Single sign-on URL" (ACS) and "Audience URI (SP Entity ID)". Steps: Admin -> Applications -> Create App Integration -> SAML 2.0; General Settings (name); Configure SAML; Feedback: "internal app we have created" -> Finish. Attribute Statements (Add Expression): `mail` = `user.profile.email`, `firstName` = `user.profile.firstName`, `lastName` = `user.profile.lastName`. Assign via Assignments tab. IdP data from Sign On tab: Metadata URL (default) or manual Issuer + Sign-on URL + certificate.
- **Microsoft Entra**: SP labels "Identifier (Entity ID)" and "Reply URL (Assertion Consumer Service URL)". Steps: Azure Portal -> Enterprise applications -> New application -> Create your own -> non-gallery; Manage -> Single sign-on -> SAML -> Basic SAML Configuration -> Edit; paste; Save. Attributes & Claims table with full claim URIs and copy buttons: email `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` = `user.mail`; first `.../givenname` = `user.givenname`; last `.../surname` = `user.surname`. 5-step assign users/groups. IdP data: "App Federation Metadata Url" (default) or manual.
- **Google Workspace**: Admin Console -> Apps -> Web and mobile apps -> Add app -> custom SAML app -> name. IdP metadata via uploaded XML FILE (default) or manual (Entity ID, SSO URL, certificate). SP step: "ACS URL" + "Entity ID" and set Name ID format to Email. Attribute mapping table: Primary email -> `email`, First name -> `firstName`, Last name -> `lastName`. Last step: User access -> ON for everyone -> Save, with the warning Google may take up to 24 hours to propagate and the connection stays inactive until then.
- **Custom SAML**: generic labels "Assertion consumer service (ACS) URL", "Entity ID". Attribute table: email -> `mail` (required badge), firstName, lastName (optional badges). Metadata URL (default) or manual.
- **OIDC custom**: section 1.

Expected SAML attribute names: `mail`, `firstName`, `lastName` (Custom/Okta); Entra xmlsoap claim URIs; Google `email`, `firstName`, `lastName`. The server-side `saml_attribute_mapping` param exists but the UI never sets it.

---------------------------------------------------------------------

## 3. Domains: add, verify, scope rules

Two layers:
1. **Org domain** (`OrganizationDomain`, `enrollment_mode=enterprise_sso`, `RES/OrganizationDomain.ts`). `ownershipVerification = {status:'unverified'|'verified'|'expired', strategy:'txt'|'legacy'|'manual_override'|'parent_domain', attempts, expiresAt, verifiedAt, txtRecordName, txtRecordValue}` (`TYP/organizationDomain.ts:57-102`, mapping `OrganizationDomain.ts:108-121`). Strategies `legacy`, `manual_override`, `parent_domain` mean verified without a TXT challenge (a verified parent can vouch for subdomains).
2. **Connection domains**: `EnterpriseConnection.domains: string[]` = the subset of verified org domains this connection authenticates. This is what sign-in matching uses.

Rules (`SSO/domain/organizationEnterpriseConnection.ts`):
- A domain cannot be shared by two connections of an instance (FAPI rejects it). The UI pre-computes `domainsClaimedByOtherConnections` (98-112), disables those checkboxes and shows "Used by another connection" (`OrganizationDomainsStep.tsx:425`).
- Default for a new connection = all verified org domains nobody else claims (`defaultConnectionDomains`, 118-124). The draft is React state until create (`useOrganizationEnterpriseConnection.ts:272-279`). An existing connection PATCHes `domains` on each toggle (`:280-290`, `OrganizationDomainsStep.tsx:99-119`).
- Ready = >=1 domain AND every one verified AND none claimed elsewhere; a connection domain absent from the org list passes (FAPI already accepted it) (132-144).
- Create requires `domains` (`TYP/enterpriseConnection.ts:194`), so no connection without a verified domain from the UI.
- Subdomains: the Domains step treats `a.b.example.com` as its own org domain (regex accepts it); parent-domain verification is server-side. Sign-in subdomain matching is a per-SAML-connection setting `allowSubdomains` ("Also match subdomains of the connection's domains"), shown only in the post-setup Settings section (`OP/EnterpriseConnectionPage/SettingsSection.tsx:45-49`), SAML only, not OIDC.
- No client check for free-mail/public-suffix domains; server errors show in the alert.

---------------------------------------------------------------------

## 4. Test runs

**Start** (`TestConfigurationStep.tsx:733-790`, `OpenTestUrlButton`): POST `/organizations/{org}/enterprise_connections/{id}/test_runs` returns `{url}`; UI does `window.open(url,'_blank','noopener,noreferrer')` (754). That Clerk-hosted URL runs the IdP round trip and Clerk records the run server-side; the browser never sees the assertion/tokens. After creating: list page reset to 1, list + success probe refetched, polling armed.

**Queries and polling** (`HOOK/useOrganizationEnterpriseConnectionTestRuns.tsx`, `SSO/hooks/useEnterpriseConnectionTestRuns.ts`):
- Success probe (`status=success`, page size 1) drives `hasSuccessfulTestRun` independent of table page. Paginated list, page size 5 (`TEST_RUNS_PAGE_SIZE`, line 6).
- Poll interval 2 s, armed only when the user starts a run, and it stops as soon as the list has ANY row. It waits for the first row, not for pending to become success/failed. After that use the manual "Refresh logs" button (does not arm polling). No poll on entering with zero runs. No refetch in background tabs.
- Queries only enabled when the connection is configured (and, in list mode, not active).

**Result list**: columns timestamp, run summary, status badge. Status: `pending | success | failed` (`TYP/enterpriseConnectionTestRun.ts:13`). Summary: success -> parsed email; failed -> `logs[0].shortMessage`; pending -> badge only (`TestConfigurationStep.tsx:674-730`). Row click opens a drawer (430-445); failed title = first log short message.

**Drawer** (`TestRunDetailsBody`, 507-562): Timestamp, Status, for failed: Error code (`logs[0].code`), "Full message" block with copy (`logs[0].message`), then How to fix. Success: "Parsed user info" with email and first name only (last name and user id exist but are not rendered). Only `logs[0]` is ever read. Raw `saml` / `oauth` payloads exist on the resource and are NOT displayed.

**Resource** (`RES/EnterpriseConnectionTestRun.ts`, JSON `TYP/enterpriseConnectionTestRun.ts:41-50`):
`{id, status, connection_type:'saml'|'oauth', parsed_user_info?{email_address,first_name,last_name,user_id}, logs?[{level,code,short_message,message}], saml?{saml_request,saml_response,relay_state}, oauth?{id_token,access_token,user_info}, created_at}`. List response `{data[], total_count}`. Not reloadable.

**Error codes with "how to fix"** (`SSO/steps/TestRunHowToFixSection.tsx:12-48`, text `LOC` ~960-1000). Exactly six. Any other code displays code + message with no fix block (returns null, 68-70). Each links to `https://clerk.com/docs/guides/organizations/add-members/sso#<code-with-dashes>` (lines 6, 74, 107).

| Code | Fix text, summarized |
|---|---|
| `saml_user_attribute_missing` | (steps) open the IdP app's SAML/attribute mapping and make sure the `mail` attribute maps to the user's email |
| `saml_response_relaystate_missing` | IdP must return the RelayState it was sent in the request |
| `saml_email_address_domain_mismatch` | test user's email must match one of the connection's allowed domains; add domains in settings if needed |
| `oauth_access_denied` | user pressed Cancel/Deny or provider rejected; verify Client ID and Client Secret |
| `oauth_token_exchange_error` | Client ID/Secret must match the OAuth app's credentials in the provider dashboard |
| `oauth_fetch_user_error` | (steps) ensure scopes include profile read permission and the user info endpoint URL is correct |

Not covered: signature invalid, assertion expired/clock skew, audience or issuer mismatch, missing NameID, InResponseTo mismatch, email unverified, state/nonce mismatch, discovery failure, invalid_client. The server's full code list is not in this repo.

**Pass criterion**: any single `success` run ever; later edits do not invalidate it.

---------------------------------------------------------------------

## 5. Activation, status, dialogs

**Activate step** (`SSO/steps/ActivateStep.tsx`): reachable only with a successful run (or already active). Shield icon, "SSO connection configured", "Once activated, anyone signing in with {domains} must use your identity provider." Buttons: "Activate SSO" -> PATCH `{active:true}` then exit; "Skip for now" exits leaving it inactive. If already active: "SSO connection is active" + "Done". Server-side preconditions are not visible in the client. Client enforces configured + >=1 success + verified domains via reachability.
The list menu "Activate" for an `inactive` connection PATCHes `active:true` with no test re-check (`OP/SecuritySsoSection.tsx:166-174`), because list mode probes nothing and treats "configured" as tested (`SSO/hooks/useOrganizationEnterpriseConnectionStatus.ts:30`).

**Status values** (`organizationEnterpriseConnection.ts:60,146-165`; badges `OP/enterpriseConnectionStatusBadges.ts`):
- `unconfigured`: no connection.
- `in_progress`: connection exists, not active, and NOT (configured AND success run).
- `inactive`: configured + success run, not active.
- `active`: `connection.active`.
Labels: Unconfigured / In Progress / Inactive / Active. All four use the same `primary` color scheme (label-only difference). List mode (`probe:false`) shows `inactive` for any configured non-active connection; the detail page probes (default). Inconsistent.
"Configured" = SAML `idpSsoUrl && idpEntityId` (certificate NOT required); OIDC `clientId && (discoveryUrl || (authUrl && tokenUrl))` (`:75-88`).

**List row menu** (`OP/SecuritySsoSection.tsx:142-181`): Edit; Continue configuration (only `in_progress`); Deactivate (only `active`, PATCH `active:false`, no confirmation); Activate (only `inactive`); Remove (destructive). Row = icon, name, domains (or provider label), badge. Button reads "Configure" with 0 connections, "Add connection" otherwise. Info tooltip: members without a matching domain can still use existing auth methods; new members get the default member role.

**Dialogs and what each destroys**
1. Reset connection (wizard footer, `SSO/ResetConnectionDialog.tsx`, `SSO/elements/Step.tsx:208-239`): "irreversible, you will have to configure all steps again". Must type the ORGANIZATION name. DELETE `/enterprise_connections/{id}`: all config and secrets gone; org domains and their verification stay. Wizard re-seats.
2. Remove connection (list menu, same dialog, different copy, `OP/SecuritySsoSection.tsx:261-272`): "deletes the connection and all of its configuration". Same typed confirmation, same DELETE.
3. Change provider (`SSO/ChangeProviderDialog.tsx`): "Switching to X will remove the Y connection 'name' and require a new setup." Single confirm. DELETE old, POST new with same domains. Non-atomic.
4. Remove domain (`SSO/RemoveDomainDialog.tsx`): inactive copy "remove {domain} from this enterprise connection"; active copy adds "Users won't be able to sign-in with {domain} anymore". PATCH connection domains + DELETE org domain (verification record gone; re-adding needs a fresh TXT). No typed confirmation.
5. Remove Directory Sync (`DS/SecurityDirectorySyncSection.tsx`): typed org name; deletes directory and bearer token; existing members keep memberships.
The connection detail page has localized "Danger zone / Deactivate connection / Remove connection" strings that are not rendered by any component (no usage found).

---------------------------------------------------------------------

## 6. Certificates (`SSO/domain/idpCertificates.ts`)

- Model: `idpCertificates[] = {certificate (base64 DER, no PEM armor), issuedAt ms|null, expiresAt ms|null}`; first entry = primary, also surfaced in legacy `idpCertificate` + issued/expires columns. `toIdpCertificateEntries` falls back to the legacy single cert (27-41). Validity (NotBefore/NotAfter) is parsed by the server; the client never parses certs.
- Up to 5 trusted certs (`MAX_IDP_CERTIFICATES`, 9). Tooltip: "Checked first when verifying a sign-in. Every certificate in this list is trusted." Rotation = add new cert, keep old, switch IdP, later remove old.
- Upload accepts `.pem,.key,.crt,.cer,.cert`; `parseCertificateFile` splits on `-----BEGIN CERTIFICATE-----`, strips whitespace, also accepts a bare base64 body; a bundle yields several certs (47-61). `areCertificateBodies` only checks the base64 alphabet (63-65); real validation is server-side. Errors: unreadable file / "not a certificate".
- Dedup by exact body; extras beyond 5 silently dropped (`addCertificates`, 67-80). Remove disabled when only one cert remains.
- Sent only when changed as `saml_idp_certificates[]`, which REPLACES the whole set (`TYP:165`).
- Expiry (`getIdpCertificateStatus`, 97-108): `expired` (<= now), `expiring` (<= 30 days, `EXPIRY_WARNING_DAYS`), `valid`, `unknown` (null, a newly added cert shows "Expiry shows after you save"). Rows: danger icon/badge "Expired {date}", warning "Expires {date}" (`IdentityProviderConfigurationForm.tsx` ~546-575).
- Detail page IdP summary: one cert -> "Certificate expires <date>"; many -> "N certificates, earliest expires <date>" or "..., one expired <date>" (`OP/EnterpriseConnectionPage/IdentityProviderSection.tsx:102-135`).
- Metadata URL/file modes let the server ingest the cert. No client-visible scheduled metadata refresh and no expiry alerting beyond in-page warnings.

---------------------------------------------------------------------

## 7. Directory Sync (SCIM)

Entry: `OP/OrganizationSecurityPage.tsx:163-169` (only with directory-sync capability); also a standalone `DS/ConfigureDirectorySync.tsx` host. Security row (`DS/SecurityDirectorySyncSection.tsx:72`): no directory = unconfigured (Configure button, disabled with an "SSO required" badge if no connection); `directory.enabled` = Active else Inactive. Menu: Edit, Activate/Deactivate (PATCH `enabled`), Remove (typed org name, DELETE).

Model: exactly one directory per org, attached to the first connection sorted by createdAt then id ("Per-connection Directory Sync is not modelled yet", `DS/ConfigureDirectorySyncContext.tsx:95-99`).

**Providers** (`DS/providerMeta.ts:37-77`): SCIM provider derived from the SSO provider: `saml_okta`->okta (push), `saml_microsoft`->entra (push), `saml_google`->google (PULL), everything else (custom SAML, any OIDC)->custom (push). Server is authoritative. Push = Clerk gives a SCIM endpoint + bearer token; pull = Clerk stores a credential and reads the IdP on a schedule.

**Wizard** (`DS/ConfigureDirectorySyncWizard.tsx:41-65`): Configure / Attributes / Test / Roles. Steps 2-4 need SSO connection and directory.
1. **Configure** (`DS/steps/ConfigureStep.tsx`): no SSO connection -> warning "Directory Sync requires an SSO connection...", Continue disabled. Otherwise the directory is auto-created once on entry (POST). Shows connection card (provider, name, domain badges), collapsible numbered "View instructions", and a warning if the SSO connection isn't active ("You can provision members, but they won't be able to sign in until it's active").
   - Push: read-only SCIM endpoint URL (copy) and a Bearer token field. The token only arrives in the create/rotate response (`api_key`), shown once in a copy field with "This token is only shown once. Generate a new token if you lose it". "Generate new token" -> POST `/rotate_api_key` (old token valid for a short grace period, `TYP/directorySync.ts:79`). Kept in provider React state only, never in snapshots (`RES/DirectorySync.ts:240`), keyed to its connection id so a late response can't show for another connection (`ConfigureDirectorySyncContext.tsx:111-120`). Reload loses it.
   - Instructions: Okta (open the SSO app -> Provisioning -> Integration, paste endpoint + token, enable push New Users / Profile Updates / Groups). Entra (Enterprise applications -> Connectivity: Tenant URL = endpoint, Secret Token = token, Test Connection; Provisioning mode Automatic; assign; On). Custom (SCIM 2.0 integration, base URL, bearer auth, enable create/update/deactivate). Google (5 steps, below).
2. **Attributes** (`DS/steps/AttributeMappingStep.tsx:38-101`): READ-ONLY table of `directory.attribute_mapping` (Clerk attribute <- SCIM path), sorted by path. "Standard directory attributes are pre-configured. Attributes not listed here are ignored." The API can edit it (`PATCH attribute_mapping`, JSON string, merge, null deletes; `RES/DirectorySync.ts:56-77`), the UI does not.
3. **Test** (`DS/steps/TestSyncStep.tsx`): "Assign or push a test user from {provider}". Live list of provisioned users, polled every 2 s while mounted (GET `/directory/users`), most recent first, badges Active / Deprovisioned (`active=false`). Note: only users with an email on a configured domain are processed. Empty states: waiting for first user / first sync / none. No pass/fail gate; Continue always enabled.
   - **Test sync (pull/Google)**: `DS/SyncNowRow.tsx` shows last sync time, status badge (Running/Succeeded/Failed/Cancelled), last error. "Sync now" -> POST `/sync` (rejects if already running; surfaced inline, 28-56). Status polled every 2 s (GET `/sync_status`) only for pull. When `lastSyncedAt` changes the user list refetches, and a "users still landing" state uses `lastSyncChangedUserCount` because users are provisioned after the sync reports done (`TestSyncStep.tsx:88-125`).
4. **Roles** (`DS/steps/RoleMappingStep.tsx`): below. "Complete" saves and exits (456-475).

**Google credentials form** (`DS/GoogleCredentialsForm.tsx`): inputs are a service-account JSON key file (`application/json,.json`; read client-side, JSON-parsed only to catch the wrong file, `JSON.stringify`'d, held in component state and wiped after submit) and the Workspace admin email to impersonate (email-shaped; hint: must be an active Workspace admin). Badge Configured / Not configured from `credentialsConfigured`. No in-form button: the wizard's Continue submits (POST `/credentials` `{service_account_json, subject_email}`), the server validates against Google and activates the directory when accepted; its rejection message is shown as the step error (`ConfigureStep.tsx` ~`submitCredentialsAndContinue`). Re-submitting replaces the stored key (rotation). Instructions: create GCP project, service account, JSON key; enable Admin SDK API; Admin console -> Security -> API controls -> Domain-wide delegation with the service account client ID; scopes `admin.directory.user.readonly` + `admin.directory.group.readonly`; upload key + admin email.

**Role mapping** (`DS/roleMapping.ts`, `DS/ConfigureDirectorySyncContext.tsx:164-285`, `RoleMappingStep.tsx`):
- Ordered list; position = priority (index 0 wins; users in several groups get the highest-priority role). Reorder by drag or arrow keys. Unmapped groups listed with a role dropdown including "Unassigned" (`NO_ROLE_KEY`). Fixed last row "Everyone else" shows the org default role, disabled.
- Groups: GET `/groups` (cursor, `limit<=500`, `starting_after`), appearing only after the IdP pushes them (empty state "No groups provisioned yet. Push groups from {provider}"). Mappings: GET `/group_role_mappings` -> `{data[{id,directory_group_id,directory_group_display_name,role,precedence}], total_count, default_role}`; entries whose role was deleted come back `role:null` and are dropped client-side.
- Edits are local drafts until Complete. Save = PUT `/group_role_mappings` with `mappings` = JSON string `[{directory_group_id, role}]` in priority order, max 100, omitted group = unmapped; roles are reassigned in the background.
- "Sync roles" is a separate flag `group_role_mapping_enabled` with confirm dialogs (`DS/RoleSyncDialog.tsx`): ENABLE warns members' roles will be overwritten by the mapped role including manually assigned ones; DISABLE warns members keep current roles, mappings stay saved, re-enabling reapplies to everyone overwriting manual changes. Save order: disable first then mappings; otherwise mappings then enable (`ConfigureDirectorySyncContext.tsx:247-253`).
- Read-only when the admin lacks `org:sys_memberships:manage` or a role-set migration is in progress, with an explanatory alert (177-179).
- The wizard never PATCHes `enabled:true`. Enabling appears server-driven (credential accepted for pull); the only client toggle is the Security-page menu. Confirm server semantics before copying.

---------------------------------------------------------------------

## 8. Who can see what

- Capabilities (`OP/useSecurityCapabilities.ts:10-19`, `OP/useSecurityRouteAccess.ts:10-24`, `ui/src/contexts/components/OrganizationProfile.ts:65-74`):
  - `canConfigureSso = shouldShowSelfServeSSO && has(org:sys_entconns:manage)`, with `shouldShowSelfServeSSO = instance userSettings.enterpriseSSO.self_serve_sso && organization.selfServeSSOEnabled`. Two switches: instance-level and per-organization (`self_serve_sso_enabled` on the org resource, `RES/Organization.ts:512-513`).
  - `canConfigureDirectorySync = instance self_serve_sso && instance self_serve_directory_sync && organization.selfServeDirectorySyncEnabled && org:sys_entconns:manage`. Directory Sync also requires SSO self-serve.
  - `canManageSSOBypass = has(org:sys_entconns_sso_bypass:manage)` (separate permission).
  - Security route/nav allowed = `canConfigureSso || canConfigureDirectorySync || (canManageSSOBypass && org has >=1 connection)`. The connection list is only fetched for the bypass-only case.
- Standalone `<ConfigureSSO>` checks only `org:sys_entconns:manage` (personal workspace with no active org passes) else shows "You do not have permission to manage Single Sign-on (SSO)" (`SSO/ConfigureSSO.tsx:83-95`); it does not check the feature flags.
- Overview composition (`OrganizationSecurityPage.tsx:152-170`): SSO section for all allowed users (Configure/Add and row menus only with manage); SSO-bypass section needs the bypass permission and >=1 connection; Directory Sync section needs its capability.
- Role mapping editing additionally needs `org:sys_memberships:manage`.
- SSO bypass (`OP/SSOBypassAllowlistPage.tsx`, `RES/SSOBypassAllowlist.ts`): per-org allow list of members who can sign in "with an email code when SSO is unavailable". Add by email (must be an org member) or by role (bulk, chunks of 100). Error codes handled: `sso_bypass_domain_not_served` (member's email domain not served by any connection) and a not-a-member code. Copy: list does not sync, managed manually.

---------------------------------------------------------------------

## 9. FAPI endpoints

Org-scoped; no session-reverification middleware on these (`SSO/hooks/useOrganizationEnterpriseConnection.ts:36-41`), so no step-up. Bodies form-encoded, arrays as repeated fields. Sources: `RES/Organization.ts`, `RES/OrganizationDomain.ts`, `RES/DirectorySync.ts`, `clerk-js/src/utils/enterpriseConnection.ts`.

### Enterprise connections (`Organization.ts:190-250`)
| Method + path | Payload / query | Notes |
|---|---|---|
| GET `/organizations/{org}/enterprise_connections` | optional `with_organization_account_linking` | array, unordered (UI sorts createdAt then id) |
| POST same | `provider`, `domains[]` (required; only sent if non-empty), optional `name`, optional flat `saml_*`/`oidc_*` | `organization_id` omitted on purpose |
| PATCH `.../{id}` | any of `name`, `domains[]`, `active`, `sync_user_attributes`, `disable_additional_identifications`, `custom_attributes` (object), `saml_idp_entity_id`, `saml_idp_sso_url`, `saml_idp_certificate` (deprecated), `saml_idp_certificates[]` (replaces all), `saml_idp_metadata_url`, `saml_idp_metadata` (XML), `saml_attribute_mapping` (unused by UI), `saml_allow_subdomains`, `saml_allow_idp_initiated`, `saml_force_authn`, `oidc_client_id`, `oidc_client_secret`, `oidc_discovery_url`, `oidc_auth_url`, `oidc_token_url`, `oidc_user_info_url`, `oidc_requires_pkce` | undefined = not sent; null is forwarded to clear. Activation = `active=true` (`utils/enterpriseConnection.ts:32-89`) |
| DELETE `.../{id}` | none | DeletedObject |

Resource shape: `id, name, active, provider, logo_public_url, domains[], organization_id, sync_user_attributes, disable_additional_identifications, allow_organization_account_linking, custom_attributes[], saml_connection{id,name,active,idp_entity_id,idp_sso_url,idp_certificate,idp_certificate_issued_at,idp_certificate_expires_at,idp_certificates[{certificate,issued_at,expires_at}],idp_metadata_url,idp_metadata,acs_url,sp_entity_id,sp_metadata_url,allow_subdomains,allow_idp_initiated,force_authn}, oauth_config{id,name,client_id,provider_key,redirect_uri,discovery_url,auth_url,token_url,user_info_url,logo_public_url,requires_pkce,created_at,updated_at}, created_at, updated_at` (`TYP/enterpriseConnection.ts`). OIDC client secret is write-only.

### Test runs (`Organization.ts:250-285`)
| Method + path | Payload | Response |
|---|---|---|
| POST `.../enterprise_connections/{id}/test_runs` | none | `{url}` |
| GET same | offset pagination, repeated `status=pending|success|failed` | `{data[], total_count}` |

### Org domains (`Organization.ts:150-200,340-365`, `OrganizationDomain.ts`)
| Method + path | Payload |
|---|---|
| GET `/organizations/{org}/domains` | offset pagination + `enrollment_mode=enterprise_sso` |
| GET `.../domains/{id}` | |
| POST `.../domains` | `name`, `enrollment_mode` |
| POST `.../domains/prepare_ownership_verification/bulk` | `organization_domain_ids[]`; response `{data[], errors[]}` (partial success) |
| POST `.../domains/attempt_ownership_verification/bulk` | same; UI polls it every 10 s |
| DELETE `.../domains/{id}` | |
Also exist but unused by the SSO wizard: `prepare_affiliation_verification`, `attempt_affiliation_verification`, `update_enrollment_mode`.

### Directory sync, base `/organizations/{org}/enterprise_connections/{conn}/directory` (`DirectorySync.ts`, `Organization.ts:285-310`)
| Method + path | Payload | Notes |
|---|---|---|
| GET base | | 404 = none yet (UI maps to null) |
| POST base | `name?` | create; returns one-time `api_key` for push |
| PATCH base | `enabled`, `group_role_mapping_enabled`, `attribute_mapping` (JSON string, merge, null deletes) | |
| DELETE base | | |
| POST `/rotate_api_key` | | new token once; old gets a grace period |
| POST `/credentials` | `service_account_json`, `subject_email` | pull only; validated against IdP |
| POST `/sync` | | pull only; errors while running |
| GET `/sync_status` | | `{last_synced_at, last_sync_status: running|succeeded|failed|cancelled, last_sync_error, last_sync_changed_user_count}` |
| GET `/groups` | `limit<=500`, `starting_after` | `{data[], cursor{starting_after,ending_before,has_next_page}}` |
| GET `/group_role_mappings` | | `{data[], total_count, default_role}` |
| PUT `/group_role_mappings` | `mappings` JSON string `[{directory_group_id, role}]`, <=100, order = priority | |
| GET `/users` | offset pagination | `{data[{id,user_id,first_name,last_name,identifier,image_url,has_image,active,provisioned_at,updated_at}], total_count}` |
Directory resource: `id,name,enterprise_connection_id,endpoint_url,provider(okta|entra|custom|google),enabled,group_role_mapping_enabled,attribute_mapping{},credentials_configured?,api_key?,created_at,updated_at`.

### SSO bypass, `/organizations/{org}/sso_bypass_allowlist` (`RES/SSOBypassAllowlist.ts:26-76`)
GET list; POST `{user_id}`; POST `/bulk` `{user_id:[<=100]}` returning `{data, errors}`; DELETE `/{user_id}`.

### Also used
`GET /organizations/{org}/roles` (`Organization.ts:125`), `GET /organizations/{org}/memberships` (role filter).

Client behaviour: react-query style cache with keep-previous data; sign-out clears queries; connection list invalidated after every mutation (`HOOK/useOrganizationEnterpriseConnections.tsx`).

---------------------------------------------------------------------

## 10. Post-setup connection page (`OP/EnterpriseConnectionPage/`)

Header (icon, name, provider label, status badge with probe, back), Name (rename, PATCH `name`), Domains (read-only list; edit domains in the wizard), Service provider (copy fields), Identity provider (summary + Edit: SAML metadata-URL vs manual with cert list; OIDC discovery vs manual plus client ID and a secret field with placeholder "Leave empty to keep the current secret"), Settings toggles with a single Save PATCH (`SettingsSection.tsx:33-62`):
- all providers: `syncUserAttributes` ("Refresh name and email from the IdP on each sign-in"), `allowAdditionalIdentifiers` (inverse of `disable_additional_identifications`; "Members may keep other sign-in methods").
- SAML only: `allowSubdomains`, `allowIdpInitiated`, `forceAuthn`.

---------------------------------------------------------------------

## 11. Things Clerk does that a thorough own-built implementation might miss

1. Wizard progress is fully derived from server data with monotonic reachability predicates, so reload/other tab/other admin all work. No progress column. Furthest-reachable resume, and a render-time re-seat when a guard flips.
2. Deferred `goNext` after a save, so the next step's guard sees fresh data (otherwise users click Continue twice).
3. Create the connection EARLY (on provider pick) so ACS URL/entity id/redirect URI exist before the admin visits the IdP, and unfinished setups appear as "In progress" and are resumable. Creation requires verified domains first.
4. Domain verification is a real DNS TXT challenge with expiry, an `expired` state, "Verify again", 10 s background polling, auto-attach of newly verified domains to the connection, plus legacy/manual_override/parent_domain strategies.
5. Cross-connection domain exclusivity surfaced in the UI ("Used by another connection"), not only as an error.
6. Last-domain lock for existing connections, with a different tooltip when active.
7. A test run is a server-recorded artifact (status, parsed user, structured logs with code + short + long message, raw SAML/OIDC payloads); the browser only opens a Clerk-hosted URL with `noopener,noreferrer`. Gate on "any success", and re-check the server on Continue to pick up a success from another tab.
8. Polling discipline: only after the user starts a run, stop at first row, never because the list is empty, none in background tabs.
9. Fix-it guidance keyed by stable error code, with a docs deep link derived from the code.
10. Multiple IdP signing certs (max 5), primary-first, bundle upload, per-cert expiry states (expired / expiring within 30 days / unknown until saved), replace-all semantics, earliest-expiry summary. This is the rotation story.
11. Three IdP intake paths (metadata URL, metadata XML file, manual) with all parsing server-side and unscoped `saml_*` errors re-attached to the right field.
12. Provider-specific wording matching each IdP's own UI (Okta "Audience URI", Entra "Reply URL", Google "Name ID format: Email" + 24 h propagation warning) and the exact attribute names/claim URIs expected.
13. OIDC required claims table (sub, email required; given_name, family_name optional) shown before the admin configures the IdP.
14. Write-only secrets: OIDC client secret blank on edit ("leave empty to keep"), SCIM token shown once with an explicit notice and keyed to its connection, service-account JSON never held in long-lived state.
15. Confirmation weight by blast radius: typed org name for reset/remove/remove-SCIM; plain confirm for change-provider/remove-domain; copy distinguishes active vs inactive impact.
16. Directory Sync gated separately (instance flag + org flag + SSO prerequisite), auto-creates the directory, derives SCIM provider from the SSO provider, handles push (token) and pull (Google service account) models, "Sync now", sync status polling, and the lag of users landing after a sync finishes.
17. Role mapping: ordered priority, default "everyone else" row, drafts until save, explicit enable/disable consequence dialogs, disable-before-write/write-before-enable ordering, read-only for missing permission or role-set migration, tolerates deleted roles.
18. SSO bypass allow list (break-glass email-code sign-in for named members; must be served by a connection domain; bulk-by-role).
19. Per-connection runtime settings beyond the wizard: sync user attributes, allow additional identifiers, allow subdomains, IdP-initiated, force re-auth.
20. Telemetry per wizard step mount (`eventFlowStepMounted('configureSSO', step, {connectionStatus, connectionId, organizationId})`) for funnel analysis.

### Weak spots in Clerk's version (do not copy)
- List badge reads `inactive` for any configured non-active connection (no test check) while wizard and detail page require a success; list "Activate" bypasses the test requirement.
- One historical success run satisfies the gate forever; editing the IdP later does not require a re-test.
- All status badges share a color scheme; only the label differs.
- Fix guidance for only six error codes; nothing for signature, audience, issuer, clock skew, InResponseTo, NameID, state/nonce, discovery, invalid_client.
- Test polling stops at the first row, so a pending run never auto-updates; the user must press Refresh logs.
- Parsed user info shows only email and first name.
- Change-provider is delete-then-create, non-atomic.
- Directory Sync limited to the first connection; wizard never PATCHes `enabled:true`; attribute mapping is display-only.
- SAML "configured" does not require a certificate; no UI for OIDC PKCE or SAML `attribute_mapping`.
- Deactivate (which turns SSO enforcement off) has no confirmation; the Danger Zone strings are orphaned.
- Stale warning says provider can't be changed after selection.
- Cert expiry is only visible when someone opens the settings; no alerting, no scheduled metadata refresh shown.
- SP metadata URL only appears after setup.
