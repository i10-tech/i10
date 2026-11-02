import { SECOND_FACTORS } from "./model.js"
import { NAMEID } from "./saml-verify.js"

/**
 * The SAML IdPs the setup screen knows by name (#339). A preset shapes the
 * defaults and the guide; every connection is verified by the same engine
 * (identity/saml.ts), whatever its preset.
 *
 * What each IdP needs (the setup guide, #340, shows `requires`):
 *
 *   - Okta: a SAML 2.0 app integration. Single sign-on URL = our ACS URL
 *     ("Use this for Recipient URL and Destination URL" ticked), Audience URI
 *     (SP Entity ID) = our entity id, Name ID format Persistent, signed
 *     assertions (the default) with RSA-SHA256. Attribute statements `email`,
 *     `firstName`, `lastName`; a group attribute statement `groups` for group
 *     rules. Entity id looks like `http://www.okta.com/<id>` - http, not
 *     https, and that is Okta's real value. Signed requests: upload our
 *     certificate under "Signature Certificate". Encryption: upload it as the
 *     encryption certificate, AES256-GCM.
 *   - Microsoft Entra ID: an Enterprise application, "Set up single sign on"
 *     with SAML. Identifier (Entity ID) = our entity id, Reply URL = our ACS
 *     URL, Logout URL = our SLO URL. Unique User Identifier (Name ID) =
 *     `user.objectid`, format Persistent, so a rename at Entra never moves an
 *     account; signing option "Sign SAML assertion" (or response and
 *     assertion), SHA-256. Entity id `https://sts.windows.net/<tenant id>/`.
 *     Entra sends the email as the `.../claims/emailaddress` claim and MFA as
 *     `authnmethodsreferences` containing `multipleauthn`. Token encryption:
 *     upload our certificate (Entra encrypts with AES-256-CBC).
 *   - Google Workspace: Apps, Web and mobile apps, "Add custom SAML app". ACS
 *     URL and Entity ID as below, Name ID format EMAIL or PERSISTENT with
 *     Name ID "Basic Information > Primary email"; attribute mapping `email`,
 *     `firstName`, `lastName`. Entity id `https://accounts.google.com/o/saml2?idpid=<id>`.
 *     ⚠ GOOGLE'S NAME ID IS THE PRIMARY EMAIL, whatever format it is labelled:
 *     a Workspace admin who renames a user changes their subject (the
 *     connection's `relink` setting handles it, sso.md 2.22), and one who gives
 *     a departed user's address to somebody new lets them in as the old
 *     person (the nOAuth shape). Map
 *     an immutable custom attribute (an employee id) as the subject if that
 *     matters; the connection's `subjectAttribute` does exactly that. Google
 *     does not encrypt assertions and does not take signed requests.
 *   - Generic: any SAML 2.0 IdP with the HTTP-Redirect binding for requests,
 *     the HTTP-POST binding for responses, and signed assertions.
 *
 * Google SAML ignores `ForceAuthn="true"` (probed: returns the old
 * `AuthnInstant`), so Google SAML step-up falls back to i10's own verification
 * (sso.md 2.22). Unverified against real tenants (inferred): that Entra issues
 * its pairwise persistent identifier when the NameIDPolicy asks for persistent
 * and the claim is left at its default.
 */

export type SamlProvider = "okta" | "entra" | "google" | "generic"

export interface SamlPreset {
  id: SamlProvider
  label: string
  entityIdHint: string
  /** Asked for in the AuthnRequest's NameIDPolicy. */
  nameIdFormat: string
  /** Attribute names this IdP uses, for each of our fields, in order of preference. */
  attributes: {
    email: readonly string[]
    givenName: readonly string[]
    familyName: readonly string[]
    groups: readonly string[]
  }
  /**
   * An attribute whose values say how the person authenticated, and which of
   * them mean MFA (Entra's `authnmethodsreferences`).
   */
  amr?: { attribute: string; mfa: readonly string[] }
  signsRequests: boolean
  encrypts: boolean
  requires: readonly string[]
}

const COMMON_EMAIL = [
  "email",
  "mail",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "urn:oid:0.9.2342.19200300.100.1.3",
] as const
const COMMON_GIVEN = [
  "firstName",
  "givenName",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
  "urn:oid:2.5.4.42",
] as const
const COMMON_FAMILY = [
  "lastName",
  "surname",
  "sn",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
  "urn:oid:2.5.4.4",
] as const
const COMMON_GROUPS = [
  "groups",
  "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups",
  "memberOf",
] as const
const COMMON = {
  email: COMMON_EMAIL,
  givenName: COMMON_GIVEN,
  familyName: COMMON_FAMILY,
  groups: COMMON_GROUPS,
}

export const SAML_PRESETS: Readonly<Record<SamlProvider, SamlPreset>> = {
  okta: {
    id: "okta",
    label: "Okta",
    entityIdHint: "http://www.okta.com/exk...",
    nameIdFormat: NAMEID.persistent,
    attributes: COMMON,
    // Okta's `session.amr` mapped to an attribute, read with the same RFC 8176
    // words as an OIDC `amr` (`provedMfa`).
    amr: { attribute: "amr", mfa: [...SECOND_FACTORS] },
    signsRequests: true,
    encrypts: true,
    requires: [
      "A SAML 2.0 app integration with the ACS URL below as the Single sign-on URL, used for Recipient and Destination.",
      "The entity id below as the Audience URI (SP Entity ID).",
      "Name ID format Persistent, and signed assertions with RSA-SHA256.",
      "Attribute statements email, firstName and lastName; a groups attribute statement for group rules.",
      "To sign requests or encrypt assertions: our certificate below, uploaded in the app's SAML settings.",
    ],
  },
  entra: {
    id: "entra",
    label: "Microsoft Entra ID",
    entityIdHint: "https://sts.windows.net/<tenant id>/",
    nameIdFormat: NAMEID.persistent,
    attributes: COMMON,
    amr: {
      attribute: "http://schemas.microsoft.com/claims/authnmethodsreferences",
      mfa: ["http://schemas.microsoft.com/claims/multipleauthn"],
    },
    signsRequests: true,
    encrypts: true,
    requires: [
      "An Enterprise application with SAML single sign-on.",
      "Give us the App Federation Metadata URL, not a downloaded file: with the URL, a rotated Entra signing certificate is picked up on its own.",
      "Identifier (Entity ID) and Reply URL (ACS) as below, Logout URL as our SLO URL.",
      "Unique User Identifier (Name ID) = user.objectid with format Persistent.",
      "Signing option: sign the SAML assertion, with SHA-256.",
      "To encrypt assertions: our certificate below under Token encryption.",
    ],
  },
  google: {
    id: "google",
    label: "Google Workspace (SAML)",
    entityIdHint: "https://accounts.google.com/o/saml2?idpid=...",
    nameIdFormat: NAMEID.unspecified,
    attributes: COMMON,
    signsRequests: false,
    encrypts: false,
    requires: [
      "A custom SAML app with the ACS URL and Entity ID below.",
      "Name ID: Basic Information > Primary email (or an immutable custom attribute, set as the subject attribute here).",
      "Attribute mapping: email, firstName, lastName.",
      "Google's Name ID is the primary email: renaming a user changes their subject, and the connection's relink setting decides whether i10 moves their link on its own or waits for an owner. An address given to somebody new is the same subject, so reuse needs offboarding first.",
    ],
  },
  generic: {
    id: "generic",
    label: "Other SAML 2.0 identity provider",
    entityIdHint: "https://idp.example.com/saml",
    nameIdFormat: NAMEID.persistent,
    attributes: COMMON,
    signsRequests: true,
    encrypts: true,
    requires: [
      "HTTP-Redirect binding for our AuthnRequest, HTTP-POST binding to our ACS URL.",
      "Signed assertions (RSA-SHA256 or better), Audience = our entity id, Recipient = our ACS URL.",
      "A persistent Name ID, and an email attribute.",
    ],
  },
}

export function samlPresetOf(provider: string): SamlPreset | null {
  return Object.hasOwn(SAML_PRESETS, provider)
    ? SAML_PRESETS[provider as SamlProvider]
    : null
}
