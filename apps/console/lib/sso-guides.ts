/**
 * What the setup flow tells someone to do at their provider, in that provider's
 * own words. A provider and protocol with an entry here runs in the flow.
 */

export type SamlCopyFieldKey = "acsUrl" | "entityId" | "sloUrl" | "metadataUrl"

export type SamlCopyField = {
  key: SamlCopyFieldKey
  label: string
  hint?: string
}

export type GuideStep = {
  title: string
  body: string
  copy?: "redirectUri"
  copyFields?: SamlCopyField[]
}

export type OidcGuide = {
  protocol: "oidc"
  steps: GuideStep[]
  /** The last numbered step, where the values come back. */
  back: { title: string; body: string }
  issuer: { label: string; hint?: string }
  clientId: { label: string }
  secret: { label: string }
  noFields?: boolean
}

export type SamlGuide = {
  protocol: "saml"
  steps: GuideStep[]
  back: { title: string; body: string }
  metadataUrlHint?: string
  entityIdHint?: string
}

export type ProviderGuide = OidcGuide | SamlGuide

const GUIDES: Record<string, ProviderGuide> = {
  "okta:oidc": {
    protocol: "oidc",
    steps: [
      {
        title: "Create the app in Okta",
        body: "In the Okta Admin Console, open Applications, then Create App Integration. Choose OIDC - OpenID Connect, then Web Application.",
      },
      {
        title: "Add this redirect URI",
        body: "Name the app i10, keep Authorization Code selected, and paste this as the Sign-in redirect URI.",
        copy: "redirectUri",
      },
      {
        title: "Choose who can sign in",
        body: "Under Assignments, pick who can use i10, then save the app.",
      },
    ],
    back: {
      title: "Bring these back from Okta",
      body: "They are on the app's General tab.",
    },
    issuer: { label: "Okta domain", hint: "Like acme.okta.com" },
    clientId: { label: "Client ID" },
    secret: { label: "Client secret" },
  },

  "okta:saml": {
    protocol: "saml",
    steps: [
      {
        title: "Create the SAML app in Okta",
        body: "In the Okta Admin Console, open Applications, then Create App Integration. Choose SAML 2.0 and name it i10.",
      },
      {
        title: "Configure SAML settings",
        body: "Paste the Single sign-on URL and Audience URI. Keep Use this for Recipient URL and Destination URL checked, and set Name ID format to Persistent.",
        copyFields: [
          {
            key: "acsUrl",
            label: "Single sign-on URL",
            hint: "ACS URL",
          },
          {
            key: "entityId",
            label: "Audience URI (SP Entity ID)",
            hint: "Entity ID",
          },
        ],
      },
      {
        title: "Add attribute statements and assign users",
        body: "Under Attribute Statements, add email, firstName and lastName mapped to user.email, user.firstName and user.lastName. Under Assignments, assign who can use i10.",
      },
    ],
    back: {
      title: "Bring back Okta's metadata",
      body: "On the app's Sign On tab, copy the Metadata URL. It uses the app's exk key, not the 0oa ID.",
    },
    metadataUrlHint: "https://your-org.okta.com/app/exk.../sso/saml/metadata",
    entityIdHint: "http://www.okta.com/exk...",
  },

  "entra:oidc": {
    protocol: "oidc",
    steps: [
      {
        title: "Register the app in Entra",
        body: "In the Microsoft Entra admin center, open App registrations, then New registration. Choose single tenant and register i10.",
      },
      {
        title: "Add this redirect URI",
        body: "Under Authentication, add a Web platform and paste this as the Redirect URI.",
        copy: "redirectUri",
      },
      {
        title: "Configure claims and create a secret",
        body: "Under Token configuration, add optional ID token claims email and xms_edov. Under Certificates & secrets, create a client secret.",
      },
    ],
    back: {
      title: "Bring these back from Entra",
      body: "Directory ID and Client ID are on the Overview tab. The secret value is under Certificates & secrets.",
    },
    issuer: {
      label: "Directory (tenant) ID",
      hint: "Like 00000000-0000-0000-0000-000000000000",
    },
    clientId: { label: "Application (client) ID" },
    secret: { label: "Client secret value" },
  },

  "entra:saml": {
    protocol: "saml",
    steps: [
      {
        title: "Create an Enterprise application",
        body: "In the Microsoft Entra admin center, open Enterprise applications, then New application and Create your own application.",
      },
      {
        title: "Set up single sign-on",
        body: "Select Single sign-on, then SAML. Enter the Identifier and Reply URL.",
        copyFields: [
          {
            key: "entityId",
            label: "Identifier (Entity ID)",
            hint: "Entity ID",
          },
          {
            key: "acsUrl",
            label: "Reply URL (ACS URL)",
            hint: "ACS URL",
          },
          {
            key: "sloUrl",
            label: "Logout URL (optional)",
            hint: "Single logout URL",
          },
        ],
      },
      {
        title: "Assign users and groups",
        body: "Under Users and groups, assign the members who should have access to i10.",
      },
    ],
    back: {
      title: "Bring back Entra's metadata",
      body: "Under SAML Certificates, copy the App Federation Metadata URL so certificate rotations are picked up automatically.",
    },
    metadataUrlHint:
      "https://login.microsoftonline.com/<tenant-id>/federationmetadata/2007-06/federationmetadata.xml",
    entityIdHint: "https://sts.windows.net/<tenant-id>/",
  },

  "google:oidc": {
    protocol: "oidc",
    steps: [],
    back: {
      title: "Google Workspace sign-in",
      body: "Google Workspace uses i10's own client. Only people with an account on your verified domain can sign in.",
    },
    issuer: { label: "Issuer" },
    clientId: { label: "Client ID" },
    secret: { label: "Client secret" },
    noFields: true,
  },

  "google:saml": {
    protocol: "saml",
    steps: [
      {
        title: "Add a custom SAML app",
        body: "In the Google Admin Console, open Apps, then Web and mobile apps. Select Add app, then Add custom SAML app, and name it i10.",
      },
      {
        title: "Enter service provider details",
        body: "Paste the ACS URL and Entity ID. Set Name ID to Basic Information > Primary email.",
        copyFields: [
          {
            key: "acsUrl",
            label: "ACS URL",
            hint: "Reply URL",
          },
          {
            key: "entityId",
            label: "Entity ID",
            hint: "Audience URI",
          },
        ],
      },
      {
        title: "Map attributes and turn access on",
        body: "Map attributes for email, firstName and lastName. Save, then set User access to ON for your organization.",
      },
    ],
    back: {
      title: "Bring back Google's metadata",
      body: "Download the IdP metadata XML file from Google, or copy the SSO URL and certificate.",
    },
    entityIdHint: "https://accounts.google.com/o/saml2?idpid=...",
  },

  "jumpcloud:oidc": {
    protocol: "oidc",
    steps: [
      {
        title: "Create the OIDC application",
        body: "In the JumpCloud Admin Portal, open SSO Applications, select Add Application, then Custom Application > OIDC.",
      },
      {
        title: "Add this redirect URI",
        body: "Name the application i10 and paste this as the Redirect URI.",
        copy: "redirectUri",
      },
      {
        title: "Assign user groups",
        body: "Under User Groups, select the groups who can access i10, then save.",
      },
    ],
    back: {
      title: "Bring these back from JumpCloud",
      body: "Copy the Client ID and Client Secret from the application details.",
    },
    issuer: {
      label: "JumpCloud issuer",
      hint: "https://oauth.id.jumpcloud.com/",
    },
    clientId: { label: "Client ID" },
    secret: { label: "Client secret" },
  },

  "jumpcloud:saml": {
    protocol: "saml",
    steps: [
      {
        title: "Create the SAML application",
        body: "In the JumpCloud Admin Portal, open SSO Applications, select Add Application, then Custom Application > SAML.",
      },
      {
        title: "Enter SAML endpoints",
        body: "Enter the SP Entity ID and ACS URL.",
        copyFields: [
          {
            key: "acsUrl",
            label: "ACS URL",
            hint: "Reply URL",
          },
          {
            key: "entityId",
            label: "SP Entity ID",
            hint: "Audience URI",
          },
        ],
      },
      {
        title: "Assign user groups",
        body: "Under User Groups, select the groups who can access i10, then save.",
      },
    ],
    back: {
      title: "Bring back JumpCloud's metadata",
      body: "Copy the metadata URL or export the certificate from the application.",
    },
    entityIdHint: "https://oauth.id.jumpcloud.com/saml2/...",
  },

  "onelogin:oidc": {
    protocol: "oidc",
    steps: [
      {
        title: "Add the OIDC application",
        body: "In the OneLogin admin portal, open Applications, click Add App, and choose OpenId Connect (OIDC).",
      },
      {
        title: "Add this redirect URI",
        body: "Name the application i10, and under Configuration, paste this as the Redirect URI.",
        copy: "redirectUri",
      },
      {
        title: "Assign roles",
        body: "Under Access, select the roles who can sign in, then save.",
      },
    ],
    back: {
      title: "Bring these back from OneLogin",
      body: "Copy the Client ID and Client Secret from the SSO tab.",
    },
    issuer: {
      label: "OneLogin issuer",
      hint: "Like https://your-subdomain.onelogin.com/oidc/2",
    },
    clientId: { label: "Client ID" },
    secret: { label: "Client secret" },
  },

  "onelogin:saml": {
    protocol: "saml",
    steps: [
      {
        title: "Add the SAML application",
        body: "In the OneLogin admin portal, open Applications, click Add App, and choose SAML Custom Connector (Advanced).",
      },
      {
        title: "Enter SAML endpoints",
        body: "Under Configuration, enter the ACS URL and Audience.",
        copyFields: [
          {
            key: "acsUrl",
            label: "ACS (Consumer) URL",
            hint: "ACS URL",
          },
          {
            key: "entityId",
            label: "Audience (EntityID)",
            hint: "Entity ID",
          },
        ],
      },
      {
        title: "Assign roles",
        body: "Under Access, select the roles who can sign in, then save.",
      },
    ],
    back: {
      title: "Bring back OneLogin's metadata",
      body: "On the SSO tab, copy the Issuer URL or download the SAML metadata.",
    },
    entityIdHint: "https://app.onelogin.com/saml/metadata/...",
  },

  "ping:oidc": {
    protocol: "oidc",
    steps: [
      {
        title: "Create the OIDC application",
        body: "In the Ping admin console, open Applications, click Add Application, and choose OIDC Web App.",
      },
      {
        title: "Add this redirect URI",
        body: "Name the application i10, select Authorization Code and PKCE, and paste this as the Redirect URI.",
        copy: "redirectUri",
      },
      {
        title: "Assign access",
        body: "Assign the user groups that should have access to i10, then save.",
      },
    ],
    back: {
      title: "Bring these back from Ping",
      body: "Copy the Issuer, Client ID and Client Secret from Configuration.",
    },
    issuer: {
      label: "Ping issuer",
      hint: "Like https://auth.pingone.com/<env-id>/as",
    },
    clientId: { label: "Client ID" },
    secret: { label: "Client secret" },
  },

  "ping:saml": {
    protocol: "saml",
    steps: [
      {
        title: "Create the SAML application",
        body: "In the Ping admin console, open Applications, click Add Application, and choose SAML.",
      },
      {
        title: "Enter SAML endpoints",
        body: "Enter the ACS URL and Entity ID.",
        copyFields: [
          {
            key: "acsUrl",
            label: "ACS URL",
            hint: "Reply URL",
          },
          {
            key: "entityId",
            label: "Entity ID",
            hint: "Audience URI",
          },
        ],
      },
      {
        title: "Assign access",
        body: "Assign the user groups that should have access to i10, then save.",
      },
    ],
    back: {
      title: "Bring back Ping's metadata",
      body: "Copy the metadata URL or download the metadata file from the application.",
    },
    entityIdHint: "https://auth.pingone.com/...",
  },

  "generic:oidc": {
    protocol: "oidc",
    steps: [
      {
        title: "Create the app at your provider",
        body: "Create an OpenID Connect web application with the Authorization Code flow and PKCE.",
      },
      {
        title: "Add this redirect URI",
        body: "Paste this as the sign-in redirect URI in your provider.",
        copy: "redirectUri",
      },
      {
        title: "Assign access",
        body: "Assign the users or groups who should be allowed to sign in.",
      },
    ],
    back: {
      title: "Bring these back from your provider",
      body: "Enter the issuer or discovery URL, client ID, and client secret from your provider.",
    },
    issuer: {
      label: "Issuer or discovery URL",
      hint: "Like https://idp.example.com",
    },
    clientId: { label: "Client ID" },
    secret: { label: "Client secret" },
  },

  "generic:saml": {
    protocol: "saml",
    steps: [
      {
        title: "Create the SAML application",
        body: "In your identity provider, create a SAML 2.0 application or service provider connection.",
      },
      {
        title: "Enter SAML endpoints",
        body: "Enter the ACS URL and Entity ID.",
        copyFields: [
          {
            key: "acsUrl",
            label: "ACS URL",
            hint: "Reply URL",
          },
          {
            key: "entityId",
            label: "Entity ID",
            hint: "Audience URI",
          },
          {
            key: "sloUrl",
            label: "Logout URL (optional)",
            hint: "Single logout URL",
          },
        ],
      },
      {
        title: "Configure attributes",
        body: "Map attributes for email, firstName, and lastName. Ensure assertions are signed with RSA-SHA256.",
      },
    ],
    back: {
      title: "Bring back your provider's metadata",
      body: "Give us your provider's metadata URL or upload the XML file below.",
    },
    entityIdHint: "https://idp.example.com/saml/metadata",
  },
}

export function guideFor(provider: string, protocol: string): ProviderGuide | null {
  return GUIDES[`${provider}:${protocol}`] ?? null
}

/** Providers the setup flow can finish. */
export function flowCovers(provider: string, protocol: string): boolean {
  return guideFor(provider, protocol) !== null
}
