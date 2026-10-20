/**
 * Every Frontend API request the gateway lets through, and the ones it refuses
 * by name. One file, so a review of what reaches Clerk is a review of this file.
 *
 * ⚠ DEFAULT DENY. A method + path that matches nothing here is a 404 from the
 * Worker and never reaches Clerk. Adding a route is a deliberate edit in this
 * file; see "Adding an allowlist entry" in the README.
 *
 * ⚠ THE EXPLICIT DENY LIST IS CHECKED FIRST AND WINS. It names the routes that
 * must stay closed even if a careless allow entry later overlaps one of them -
 * org admin, org creation, account deletion, enterprise connections. A test
 * asserts no allow entry matches any of them.
 *
 * ⚠ METHODS ARE THE EFFECTIVE METHOD. clerk-js sends every PATCH, PUT and
 * DELETE as a `POST` carrying `_method=<METHOD>` in the query string (see
 * `fapiClient.request` in @clerk/clerk-js 6.39.1: `"GET"===l?"GET":"POST"` and
 * `o.append("_method",t)`), and Clerk honours the override. policy.ts resolves
 * it before anything here is consulted, so `DELETE /v1/me` below also covers
 * `POST /v1/me?_method=DELETE`.
 *
 * Paths are templates: `:name` is one path segment of the kind named in
 * `PARAMS`, everything else is literal. Patterns are anchored at both ends and
 * no parameter can match a `/`.
 */

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

/** How the managed-account hook is consulted for an entry (see policy.ts). */
export type Guard =
  /** A self-service account change: refused for a managed account. */
  | "self_service"
  /** Creates a sign-in: a managed identifier may only use `strategy=ticket`. */
  | "sign_in_create"

export interface AllowEntry {
  /** Logged on every request. Stable: dashboards and alerts key on it. */
  name: string
  method: Method
  path: string
  /** The UI call or SDK behaviour that needs this route. */
  why: string
  guard?: Guard
  /** Only on a development instance (`INSTANCE=development`). */
  devOnly?: true
  /** May carry a file (multipart/form-data or application/octet-stream). */
  upload?: true
}

export interface DenyEntry {
  /** `*` is every method. */
  method: Method | "*"
  /** A template; a trailing `/**` also matches the path itself and anything below it. */
  path: string
  reason: string
  why: string
}

/**
 * The segment kinds. Clerk ids are a lowercase prefix, an underscore and a
 * base62 body; none of these can contain `/`, `%`, `.` or `..`.
 */
const PARAMS: Record<string, string> = {
  sess: "sess_[A-Za-z0-9]{1,64}",
  sia: "sia_[A-Za-z0-9]{1,64}",
  sua: "sua_[A-Za-z0-9]{1,64}",
  org: "org_[A-Za-z0-9]{1,64}",
  orginv: "orginv_[A-Za-z0-9]{1,64}",
  // Email addresses and passkeys are both `idn_` (read from the dev instance).
  idn: "idn_[A-Za-z0-9]{1,64}",
  // External accounts: `eac_` in Clerk's docs; `idn_` accepted in case.
  eac: "(?:eac|idn)_[A-Za-z0-9]{1,64}",
  // An OAuth application's client id, URL-safe by construction (deny list only).
  client: "[A-Za-z0-9_-]{1,128}",
  // `6`, `6.39.1`, `1.40.3-canary.v20261019212020`: a dist-tag or a version.
  version: "[0-9A-Za-z][0-9A-Za-z.+-]{0,63}",
  file: "[A-Za-z0-9][A-Za-z0-9_.-]{0,159}\\.(?:js|css|map)",
  // Deny-list only: any single segment.
  any: "[^/]+",
}

const escape = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** `/v1/client/sessions/:sess/touch` → an anchored RegExp. */
export function compile(template: string): RegExp {
  let rest = template
  let tail = ""
  if (rest.endsWith("/**")) {
    rest = rest.slice(0, -3)
    tail = "(?:/.*)?"
  }
  const source = rest.replace(
    /:([a-z]+)|([^:]+)/g,
    (_, param?: string, literal?: string) => {
      if (param !== undefined) {
        const pattern = PARAMS[param]
        if (!pattern) throw new Error(`unknown path parameter :${param} in ${template}`)
        return `(?:${pattern})`
      }
      return escape(literal ?? "")
    },
  )
  return new RegExp(`^${source}${tail}$`)
}

// ── What passes ─────────────────────────────────────────────────────────────

export const ALLOW: readonly AllowEntry[] = [
  // Load, refresh and the server-side handshake.
  {
    name: "script.clerk_js",
    method: "GET",
    path: "/npm/@clerk/clerk-js@:version/dist/:file",
    why: "@clerk/shared loadClerkJsScript loads clerk-js and its chunks from the FAPI host",
  },
  {
    name: "script.clerk_ui",
    method: "GET",
    path: "/npm/@clerk/ui@:version/dist/:file",
    why: "@clerk/ui (TaskResetPassword, TaskSetupMFA, the CAPTCHA widget) loads from the FAPI host",
  },
  {
    name: "environment.read",
    method: "GET",
    path: "/v1/environment",
    why: "clerk-js load; server-side reads in apps/auth _lib/environment.ts and apps/console lib/clerk-environment.ts",
  },
  {
    name: "environment.touch",
    method: "PATCH",
    path: "/v1/environment",
    why: "clerk-js load on a DEVELOPMENT instance fetches the environment with touch=true",
    devOnly: true,
  },
  {
    name: "dev_browser.create",
    method: "POST",
    path: "/v1/dev_browser",
    why: "clerk-js on a development instance mints the __clerk_db_jwt dev browser",
    devOnly: true,
  },
  {
    name: "client.read",
    method: "GET",
    path: "/v1/client",
    why: "clerk-js load and client.reload(); signIn.finalize() reloads it",
  },
  {
    name: "client.handshake",
    method: "GET",
    path: "/v1/client/handshake",
    why: "clerkMiddleware (apps/auth, apps/console) redirects document requests here to refresh the session cookie",
  },
  {
    name: "client.touch",
    method: "GET",
    path: "/v1/client/touch",
    why: "clerk-js decorates navigations through it to extend the client cookie (Safari ITP)",
  },
  {
    name: "client.captcha",
    method: "POST",
    path: "/v1/client/verify",
    why: "clerk-js posts the bot-protection token when FAPI answers requires_captcha (sign-up CAPTCHA is on in prod)",
  },
  {
    name: "client.sessions.remove_all",
    method: "DELETE",
    path: "/v1/client/sessions",
    why: "clerk.signOut() (account-bar, DeleteAccount): client.removeSessions()",
  },

  // Sign-in.
  {
    name: "sign_in.create",
    method: "POST",
    path: "/v1/client/sign_ins",
    why: "signIn.create / password / passkey / ticket, the OAuth buttons, signIn.create({ transfer }) in sso-callback",
    guard: "sign_in_create",
  },
  {
    name: "sign_in.read",
    method: "GET",
    path: "/v1/client/sign_ins/:sia",
    why: "signIn reload while a flow resumes (sso-callback, mfa)",
  },
  {
    name: "sign_in.prepare_first_factor",
    method: "POST",
    path: "/v1/client/sign_ins/:sia/prepare_first_factor",
    why: "signIn.passkey(), resetPasswordEmailCode.sendCode()",
  },
  {
    name: "sign_in.attempt_first_factor",
    method: "POST",
    path: "/v1/client/sign_ins/:sia/attempt_first_factor",
    why: "signIn.passkey(), signIn.password() on an existing attempt, resetPasswordEmailCode.verifyCode()",
  },
  {
    name: "sign_in.prepare_second_factor",
    method: "POST",
    path: "/v1/client/sign_ins/:sia/prepare_second_factor",
    why: "signIn.mfa.sendEmailCode() in mfa-form",
  },
  {
    name: "sign_in.attempt_second_factor",
    method: "POST",
    path: "/v1/client/sign_ins/:sia/attempt_second_factor",
    why: "signIn.mfa.verifyTOTP / verifyBackupCode / verifyEmailCode in mfa-form",
  },
  {
    name: "sign_in.reset_password",
    method: "POST",
    path: "/v1/client/sign_ins/:sia/reset_password",
    why: "resetPasswordEmailCode.submitPassword() in reset-password-form",
  },

  // Sign-up.
  {
    name: "sign_up.create",
    method: "POST",
    path: "/v1/client/sign_ups",
    why: "signUp.password() in sign-up-form, signUp.create({ transfer }) in sso-callback",
  },
  {
    name: "sign_up.read",
    method: "GET",
    path: "/v1/client/sign_ups/:sua",
    why: "signUp reload while a flow resumes",
  },
  {
    name: "sign_up.update",
    method: "PATCH",
    path: "/v1/client/sign_ups/:sua",
    why: "signUp.password() on an existing attempt",
  },
  {
    name: "sign_up.prepare_verification",
    method: "POST",
    path: "/v1/client/sign_ups/:sua/prepare_verification",
    why: "signUp.verifications.sendEmailCode()",
  },
  {
    name: "sign_up.attempt_verification",
    method: "POST",
    path: "/v1/client/sign_ups/:sua/attempt_verification",
    why: "signUp.verifications.verifyEmailCode()",
  },

  // Social sign-in, invitations.
  {
    name: "oauth.callback",
    method: "GET",
    path: "/v1/oauth_callback",
    why: "Google and GitHub return the browser here (sign-in buttons, user.createExternalAccount, reauthorize)",
  },
  {
    name: "oauth.callback_form_post",
    method: "POST",
    path: "/v1/oauth_callback",
    why: "Apple returns with response_mode=form_post (enabled on the dev instance)",
  },
  {
    name: "ticket.accept",
    method: "GET",
    path: "/v1/tickets/accept",
    why: "the link in Clerk's invitation email (apps/api clerk-members.ts createOrganizationInvitation)",
  },

  // The session.
  {
    name: "session.read",
    method: "GET",
    path: "/v1/client/sessions/:sess",
    why: "session.reload() during step-up and pending-task handling",
  },
  {
    name: "session.touch",
    method: "POST",
    path: "/v1/client/sessions/:sess/touch",
    why: "clerk.setActive(): every finalize(), workspace switching, setActive({ organization: null })",
  },
  {
    name: "session.token",
    method: "POST",
    path: "/v1/client/sessions/:sess/tokens",
    why: "session.getToken(): the background refresh about once a minute, and every API call from the console",
  },
  {
    name: "session.end",
    method: "POST",
    path: "/v1/client/sessions/:sess/end",
    why: "session.end() in apps/auth _lib/devices.ts",
  },
  {
    name: "session.remove",
    method: "POST",
    path: "/v1/client/sessions/:sess/remove",
    why: "clerk.signOut({ sessionId }) with several sessions on the client",
  },
  {
    name: "session.verify.start",
    method: "POST",
    path: "/v1/client/sessions/:sess/verify",
    why: "session.startVerification() in the step-up dialog (packages/ui step-up-dialog.tsx)",
  },
  {
    name: "session.verify.prepare_first_factor",
    method: "POST",
    path: "/v1/client/sessions/:sess/verify/prepare_first_factor",
    why: "session.prepareFirstFactorVerification() in the step-up dialog",
  },
  {
    name: "session.verify.attempt_first_factor",
    method: "POST",
    path: "/v1/client/sessions/:sess/verify/attempt_first_factor",
    why: "session.attemptFirstFactorVerification() in the step-up dialog",
  },
  {
    name: "session.verify.prepare_second_factor",
    method: "POST",
    path: "/v1/client/sessions/:sess/verify/prepare_second_factor",
    why: "session.prepareSecondFactorVerification() in the step-up dialog",
  },
  {
    name: "session.verify.attempt_second_factor",
    method: "POST",
    path: "/v1/client/sessions/:sess/verify/attempt_second_factor",
    why: "session.attemptSecondFactorVerification() in the step-up dialog",
  },

  // The signed-in user: reads and memberships.
  {
    name: "me.read",
    method: "GET",
    path: "/v1/me",
    why: "user.reload() after account changes",
  },
  {
    name: "me.memberships",
    method: "GET",
    path: "/v1/me/organization_memberships",
    why: "useOrganizationList({ userMemberships }) in the workspace switcher, settings, choose-workspace",
  },
  {
    name: "me.invitations",
    method: "GET",
    path: "/v1/me/organization_invitations",
    why: "useOrganizationList({ userInvitations }) in the workspace switcher, join-suggestions, choose-workspace",
  },
  {
    name: "me.invitation.accept",
    method: "POST",
    path: "/v1/me/organization_invitations/:orginv/accept",
    why: "invitation.accept() in workspace-switcher, join-suggestions, choose-workspace",
  },
  {
    name: "org.read",
    method: "GET",
    path: "/v1/organizations/:org",
    why: "organization.reload() in workspace-general, team-panel, rename-workspace, the switcher",
  },
  {
    name: "org.memberships.read",
    method: "GET",
    path: "/v1/organizations/:org/memberships",
    why: "useOrganization({ memberships }) in team-panel (reading; every change goes through our API)",
  },

  // Self-service account changes (managed accounts refused, see policy.ts).
  {
    name: "me.update",
    method: "PATCH",
    path: "/v1/me",
    why: "user.update() for the name and the primary email in profile-details",
    guard: "self_service",
  },
  {
    name: "me.profile_image.set",
    method: "POST",
    path: "/v1/me/profile_image",
    why: "user.setProfileImage({ file }) in profile-details",
    guard: "self_service",
    upload: true,
  },
  {
    name: "me.profile_image.remove",
    method: "DELETE",
    path: "/v1/me/profile_image",
    why: "user.setProfileImage({ file: null }) in profile-details",
    guard: "self_service",
  },
  {
    name: "me.email.create",
    method: "POST",
    path: "/v1/me/email_addresses",
    why: "user.createEmailAddress() in profile-details",
    guard: "self_service",
  },
  {
    name: "me.email.prepare_verification",
    method: "POST",
    path: "/v1/me/email_addresses/:idn/prepare_verification",
    why: "emailAddress.prepareVerification({ strategy: email_code }) in profile-details",
    guard: "self_service",
  },
  {
    name: "me.email.attempt_verification",
    method: "POST",
    path: "/v1/me/email_addresses/:idn/attempt_verification",
    why: "emailAddress.attemptVerification({ code }) in profile-details",
    guard: "self_service",
  },
  {
    name: "me.email.remove",
    method: "DELETE",
    path: "/v1/me/email_addresses/:idn",
    why: "emailAddress.destroy() in profile-details",
    guard: "self_service",
  },
  {
    name: "me.external_account.create",
    method: "POST",
    path: "/v1/me/external_accounts",
    why: "user.createExternalAccount() in profile-details and the sign-up secure steps",
    guard: "self_service",
  },
  {
    name: "me.external_account.reauthorize",
    method: "PATCH",
    path: "/v1/me/external_accounts/:eac/reauthorize",
    why: "account.reauthorize() in profile-details and sso-callback",
    guard: "self_service",
  },
  {
    name: "me.external_account.remove",
    method: "DELETE",
    path: "/v1/me/external_accounts/:eac",
    why: "externalAccount.destroy() in profile-details",
    guard: "self_service",
  },
  {
    name: "me.password.change",
    method: "POST",
    path: "/v1/me/change_password",
    why: "user.updatePassword() in security.tsx and Clerk's TaskResetPassword",
    guard: "self_service",
  },
  {
    name: "me.passkey.create",
    method: "POST",
    path: "/v1/me/passkeys",
    why: "user.createPasskey() in security.tsx and the sign-up secure steps",
    guard: "self_service",
  },
  {
    name: "me.passkey.attempt_verification",
    method: "POST",
    path: "/v1/me/passkeys/:idn/attempt_verification",
    why: "the second half of user.createPasskey()",
    guard: "self_service",
  },
  {
    name: "me.passkey.rename",
    method: "PATCH",
    path: "/v1/me/passkeys/:idn",
    why: "passkey.update({ name }) in security.tsx",
    guard: "self_service",
  },
  {
    name: "me.passkey.remove",
    method: "DELETE",
    path: "/v1/me/passkeys/:idn",
    why: "passkey.delete() in security.tsx",
    guard: "self_service",
  },
  {
    name: "me.totp.create",
    method: "POST",
    path: "/v1/me/totp",
    why: "user.createTOTP() in security.tsx, the sign-up secure steps and Clerk's TaskSetupMFA",
    guard: "self_service",
  },
  {
    name: "me.totp.verify",
    method: "POST",
    path: "/v1/me/totp/attempt_verification",
    why: "user.verifyTOTP() in the same places",
    guard: "self_service",
  },
  {
    name: "me.totp.remove",
    method: "DELETE",
    path: "/v1/me/totp",
    why: "user.disableTOTP() in security.tsx",
    guard: "self_service",
  },
  {
    // ⚠ clerk-js sends this one WITH a trailing slash (`/me/backup_codes/`);
    // policy.ts strips one trailing slash before matching.
    name: "me.backup_codes.create",
    method: "POST",
    path: "/v1/me/backup_codes",
    why: "user.createBackupCode() in security.tsx, sign-up-form, the secure steps, TaskSetupMFA",
    guard: "self_service",
  },
  {
    name: "me.sessions.list",
    method: "GET",
    path: "/v1/me/sessions/active",
    why: "user.getSessions() in security.tsx (active devices)",
    guard: "self_service",
  },
  {
    name: "me.session.revoke",
    method: "POST",
    path: "/v1/me/sessions/:sess/revoke",
    why: "session.revoke() in security.tsx",
    guard: "self_service",
  },

  // The rollout itself.
  {
    name: "proxy.health",
    method: "GET",
    path: "/v1/proxy-health",
    why: "Clerk's POST /v1/proxy_checks probe calls this through the proxy before proxy_url is set",
  },
]

// ── What never passes, by name ──────────────────────────────────────────────

/** Clerk acting as an OAuth provider for i10, every route of it. */
const OAUTH_PROVIDER = [
  "/v1/me/oauth/consent/:client",
  "/oauth/authorize",
  "/oauth/token",
  "/oauth/userinfo",
  "/oauth/token/revoke",
  "/.well-known/openid-configuration",
  "/.well-known/oauth-authorization-server",
  "/.well-known/jwks.json",
]

export const DENY: readonly DenyEntry[] = [
  {
    method: "POST",
    path: "/v1/organizations",
    reason: "org_create_via_api",
    why: "workspaces are created through our API since #335, which demotes the creator",
  },
  {
    method: "PATCH",
    path: "/v1/organizations/:org",
    reason: "org_admin_via_api",
    why: "renaming goes through our API (backend updateOrganization)",
  },
  {
    method: "DELETE",
    path: "/v1/organizations/:org",
    reason: "org_admin_via_api",
    why: "workspace deletion goes through our API behind step-up since #335",
  },
  {
    method: "*",
    path: "/v1/organizations/:org/logo",
    reason: "org_admin_via_api",
    why: "organization logo upload and removal",
  },
  {
    method: "*",
    path: "/v1/organizations/:org/invitations/**",
    reason: "org_admin_via_api",
    why: "invitation create, bulk, list, pending and revoke: ours since #326",
  },
  {
    method: "POST",
    path: "/v1/organizations/:org/memberships/**",
    reason: "org_admin_via_api",
    why: "adding members; only reading the list passes",
  },
  {
    method: "PATCH",
    path: "/v1/organizations/:org/memberships/**",
    reason: "org_admin_via_api",
    why: "re-roling members: roles are ours since #335",
  },
  {
    method: "DELETE",
    path: "/v1/organizations/:org/memberships/**",
    reason: "org_admin_via_api",
    why: "removing members: ours since #326",
  },
  {
    method: "*",
    path: "/v1/organizations/:org/membership_requests/**",
    reason: "org_admin_via_api",
    why: "accepting and rejecting membership requests",
  },
  {
    method: "*",
    path: "/v1/organizations/:org/domains/**",
    reason: "org_admin_via_api",
    why: "Clerk org domains, verification and enrollment mode: access domains are ours",
  },
  {
    method: "*",
    path: "/v1/organizations/:org/roles",
    reason: "org_admin_via_api",
    why: "Clerk roles are powerless since #335; ours live in our database",
  },
  {
    method: "*",
    path: "/v1/organizations/:org/sso_bypass_allowlist_users/**",
    reason: "sso_bypass_ours",
    why: "SSO bypass is our owner exemption (sso.md Part 6.7), not Clerk's",
  },
  {
    method: "*",
    path: "/v1/organizations/:org/enterprise_connections/**",
    reason: "enterprise_connections_not_used",
    why: "no Clerk enterprise connections: SSO is our own SP (engine A)",
  },
  {
    method: "*",
    path: "/v1/me/enterprise_connections/**",
    reason: "enterprise_connections_not_used",
    why: "no Clerk enterprise connections",
  },
  {
    method: "*",
    path: "/v1/enterprise_connections/**",
    reason: "enterprise_connections_not_used",
    why: "no Clerk enterprise connection test runs",
  },
  {
    method: "*",
    path: "/v1/client/sign_ups/:sua/enterprise_connections",
    reason: "enterprise_connections_not_used",
    why: "no Clerk enterprise connections at sign-up",
  },
  {
    method: "*",
    path: "/v1/saml/**",
    reason: "enterprise_connections_not_used",
    why: "Clerk's SAML is off; SAML is ours (#339)",
  },
  {
    method: "*",
    path: "/v1/organizations/:org/billing/**",
    reason: "billing_not_clerk",
    why: "billing is Polar",
  },
  {
    method: "*",
    path: "/v1/me/billing/**",
    reason: "billing_not_clerk",
    why: "billing is Polar",
  },
  {
    method: "*",
    path: "/v1/billing/**",
    reason: "billing_not_clerk",
    why: "billing is Polar",
  },
  {
    method: "DELETE",
    path: "/v1/me",
    reason: "user_delete_via_api",
    why: "account deletion is ours",
  },
  {
    method: "DELETE",
    path: "/v1/me/organization_memberships/:org",
    reason: "org_admin_via_api",
    why: "leaving a workspace goes through our API since #335",
  },
  {
    method: "*",
    path: "/v1/me/organization_suggestions/**",
    reason: "org_admin_via_api",
    why: "join suggestions are ours (team access domains)",
  },
  {
    method: "*",
    path: "/v1/me/organization_creation_defaults",
    reason: "org_create_via_api",
    why: "only Clerk's <CreateOrganization /> reads it",
  },
  /*
   * ⚠ i10 AS AN OAUTH PROVIDER IS CLOSED AT THE DOOR. apps/auth/app/oauth-consent
   * exists, and is unreachable through the gateway on purpose: with no OAuth
   * application registered, every one of these is a surface with no user.
   */
  ...OAUTH_PROVIDER.map((path) => ({
    method: "*" as const,
    path,
    reason: "oauth_provider_not_used",
    why: "no OAuth applications exist on either instance (checked 2026-10-20); the group comes back, reviewed, the day i10 becomes an OAuth provider",
  })),
  {
    method: "*",
    path: "/oauth/register",
    reason: "oauth_provider_not_used",
    why: "dynamic client registration would let anyone register an OAuth client",
  },
  {
    method: "*",
    path: "/oauth/device_authorization",
    reason: "oauth_provider_not_used",
    why: "the device flow is not used",
  },
  {
    method: "*",
    path: "/v1/me/oauth/device/**",
    reason: "oauth_provider_not_used",
    why: "the device flow is not used",
  },
  {
    method: "*",
    path: "/oauth/token_info",
    reason: "oauth_provider_not_used",
    why: "token introspection is for resource servers we do not run",
  },
  {
    method: "*",
    path: "/api_keys/**",
    reason: "api_keys_ours",
    why: "API keys are ours since 2026-09-08",
  },
  {
    method: "*",
    path: "/v1/account_portal",
    reason: "account_portal_removed",
    why: "no Clerk Account Portal; every screen is ours",
  },
]

export interface Compiled<T> {
  entry: T
  pattern: RegExp
}

export const COMPILED_ALLOW: readonly Compiled<AllowEntry>[] = ALLOW.map((entry) => ({
  entry,
  pattern: compile(entry.path),
}))

export const COMPILED_DENY: readonly Compiled<DenyEntry>[] = DENY.map((entry) => ({
  entry,
  pattern: compile(entry.path),
}))
