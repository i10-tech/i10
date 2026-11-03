/**
 * The OIDC providers the setup screen knows by name (#338, sso.md Option A).
 * A preset only shapes the defaults and the hints; every connection is checked
 * by the same engine (identity/oidc.ts), whatever its preset.
 *
 * What each IdP needs, for the setup guide (#340) and the setup endpoint:
 *
 *   - Okta: an OIDC Web Application, grant type Authorization Code, the
 *     redirect URI below; issuer `https://<org>.okta.com` (org server) or
 *     `https://<org>.okta.com/oauth2/<id>` (custom server). Okta's ID token
 *     carries no `email_verified` on the code flow; the engine reads it from
 *     /userinfo. The org server sends groups once `groups` is asked for, which
 *     the engine does when discovery lists it; a custom server needs a
 *     `groups` claim and scope of its own. private_key_jwt: paste our JWKS URL as the client's key source.
 *   - Entra ID: an app registration (single tenant), a Web redirect URI, and
 *     the TENANT issuer `https://login.microsoftonline.com/<tenant id>/v2.0`;
 *     `common`, `organizations` and `consumers` are refused because their
 *     tokens name every tenant at once. Entra sends no `email` and no
 *     `email_verified` by default: add the optional claims `email` AND
 *     `xms_edov` (email domain owner verified) to the ID token, or nobody can
 *     be claimed. Client secret only: Entra's private_key_jwt needs an
 *     uploaded X.509 certificate, which this build does not make.
 *   - Google Workspace: nothing to configure. One click on OUR Google OAuth
 *     client (`GOOGLE_SSO_CLIENT_ID`); only ID tokens whose `hd` is one of the
 *     workspace's live verified domains are accepted (sso.md 2.9).
 *   - JumpCloud, OneLogin, Ping: a custom OIDC application with Authorization
 *     Code and PKCE, the redirect URI below, and the issuer the IdP shows.
 *   - Generic: any certified OpenID Provider that publishes discovery.
 */

export type ClientAuthMethod =
  "client_secret_basic" | "client_secret_post" | "private_key_jwt"

export const CLIENT_AUTH_METHODS: readonly ClientAuthMethod[] = [
  "client_secret_basic",
  "client_secret_post",
  "private_key_jwt",
]

export type OidcProvider =
  "okta" | "entra" | "google" | "jumpcloud" | "onelogin" | "ping" | "generic"

export interface OidcPreset {
  id: OidcProvider
  label: string
  /** What the issuer looks like, for the form's placeholder. */
  issuerHint: string
  /**
   * When set, the issuer MUST match: Entra's tenant form, which is the only
   * one whose tokens can be checked against a single issuer.
   */
  issuerPattern: RegExp | null
  scopes: readonly string[]
  /**
   * Scopes asked for too, but only when the IdP's discovery lists them in
   * `scopes_supported`: Okta's org server knows `groups`, and a custom
   * authorization server without it answers `invalid_scope` to the whole
   * sign-in.
   */
  scopesIfSupported?: readonly string[]
  /** Client authentication this IdP supports with us. */
  clientAuth: readonly ClientAuthMethod[]
  /**
   * The claim that says the address is verified, when it is not
   * `email_verified` (Entra: `xms_edov`).
   */
  emailVerifiedClaim?: string
  /**
   * Who a private_key_jwt assertion is addressed to. RFC 7523 and openid-
   * client say the issuer; Okta's documentation names its token endpoint.
   */
  assertionAudience: "issuer" | "token_endpoint"
  /** What an admin must do at the IdP, shown by the setup endpoint. */
  requires: readonly string[]
}

const DEFAULT_SCOPES = ["openid", "email", "profile"] as const
const ALL_AUTH = CLIENT_AUTH_METHODS

export const GOOGLE_ISSUER = "https://accounts.google.com"

export const OIDC_PRESETS: Readonly<Record<OidcProvider, OidcPreset>> = {
  okta: {
    id: "okta",
    label: "Okta",
    issuerHint: "https://your-org.okta.com",
    issuerPattern: null,
    scopes: DEFAULT_SCOPES,
    scopesIfSupported: ["groups"],
    clientAuth: ALL_AUTH,
    assertionAudience: "token_endpoint",
    requires: [
      "An OIDC Web Application with the Authorization Code grant.",
      "The redirect URI below as a sign-in redirect URI.",
      "For groups: a groups claim on the ID token and the groups scope.",
      "The app's authentication policy decides whether a first sign-in asks for another factor. A new app gets your org's default policy, so people may be asked for a new factor or to enrol a passkey. Pick the policy you want on the app's Sign On tab.",
    ],
  },
  entra: {
    id: "entra",
    label: "Microsoft Entra ID",
    issuerHint: "https://login.microsoftonline.com/<tenant id>/v2.0",
    issuerPattern:
      /^https:\/\/login\.microsoftonline\.com\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/v2\.0$/,
    scopes: DEFAULT_SCOPES,
    clientAuth: ["client_secret_basic", "client_secret_post"],
    emailVerifiedClaim: "xms_edov",
    assertionAudience: "issuer",
    requires: [
      "A single-tenant app registration with the redirect URI below as a Web redirect URI.",
      "The tenant issuer: https://login.microsoftonline.com/<tenant id>/v2.0, not common or organizations.",
      "Optional ID token claims email and xms_edov, or nobody can be signed in.",
      "A client secret: certificate credentials are not supported yet.",
      "For step-up re-verification: add the optional claim auth_time to the ID token.",
    ],
  },
  google: {
    id: "google",
    label: "Google Workspace",
    issuerHint: GOOGLE_ISSUER,
    issuerPattern: null,
    scopes: DEFAULT_SCOPES,
    clientAuth: ["client_secret_basic"],
    assertionAudience: "issuer",
    requires: [
      "Nothing at Google: i10's own Google client is used.",
      "The workspace's Google primary domain verified here as an access domain.",
    ],
  },
  jumpcloud: {
    id: "jumpcloud",
    label: "JumpCloud",
    issuerHint: "https://oauth.id.jumpcloud.com/",
    issuerPattern: null,
    scopes: DEFAULT_SCOPES,
    clientAuth: ALL_AUTH,
    assertionAudience: "issuer",
    requires: [
      "A custom OIDC application with Authorization Code and the redirect URI below.",
    ],
  },
  onelogin: {
    id: "onelogin",
    label: "OneLogin",
    issuerHint: "https://your-subdomain.onelogin.com/oidc/2",
    issuerPattern: null,
    scopes: DEFAULT_SCOPES,
    clientAuth: ALL_AUTH,
    assertionAudience: "issuer",
    requires: [
      "An OpenId Connect (OIDC) application, Web type, with the redirect URI below.",
      "Token endpoint authentication set to match the method chosen here.",
    ],
  },
  ping: {
    id: "ping",
    label: "Ping Identity",
    issuerHint: "https://auth.pingone.com/<environment id>/as",
    issuerPattern: null,
    scopes: DEFAULT_SCOPES,
    clientAuth: ALL_AUTH,
    assertionAudience: "issuer",
    requires: [
      "An OIDC Web App with Authorization Code, PKCE S256 and the redirect URI below.",
    ],
  },
  generic: {
    id: "generic",
    label: "Other OpenID Connect provider",
    issuerHint: "https://idp.example.com",
    issuerPattern: null,
    scopes: DEFAULT_SCOPES,
    clientAuth: ALL_AUTH,
    assertionAudience: "issuer",
    requires: [
      "Discovery at <issuer>/.well-known/openid-configuration, or its URL below.",
      "Authorization Code with PKCE S256, and email_verified in the ID token.",
    ],
  },
}

export function presetOf(provider: string): OidcPreset | null {
  return Object.hasOwn(OIDC_PRESETS, provider)
    ? OIDC_PRESETS[provider as OidcProvider]
    : null
}
