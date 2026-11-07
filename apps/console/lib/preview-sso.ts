import type { AccessDomain } from "@/lib/actions"
import type {
  BypassEntry,
  CreatedSetupLink,
  DeprovisionedPerson,
  DirectoryConflict,
  DirectoryGroup,
  GoogleSetup,
  GroupRule,
  GroupRules,
  IdentityEvent,
  IpAllowlist,
  LdapSetup,
  LdapTestOutcome,
  LeaverDefault,
  Mailboxes,
  OidcSetup,
  OwnerExemption,
  RelinkRequest,
  RotatedDeprovisionedKey,
  SamlSetup,
  SavedIpAllowlist,
  SessionPolicy,
  SetupLink,
  SiemSettingsAnswer,
  SiemTestResult,
  SsoConnection,
  SsoConnections,
  SsoDirectories,
  SsoDirectory,
  TestRun,
} from "@/lib/sso-types"

type Query = Record<string, string | number | undefined | null> | undefined
type Route = [
  RegExp,
  (match: RegExpMatchArray, query: Query, method: string, body?: unknown) => unknown,
]

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const now = Date.now()
const ago = (days: number, hours = 0, minutes = 0) =>
  new Date(now - days * DAY - hours * HOUR - minutes * MINUTE).toISOString()
const fromNow = (days: number, hours = 0, minutes = 0) =>
  new Date(now + days * DAY + hours * HOUR + minutes * MINUTE).toISOString()

const FAKE_SP_CERT =
  "-----BEGIN CERTIFICATE-----\n" +
  "MIIC/DCCAeSgAwIBAgIUFakeCertForTestingOnly0001MA0GCSqGSIb3DQEBCwUAMBsx\n" +
  "GTAXBgNVBAMTEGFjbWUuZGV2IFNpZ25pbmcwHhcNMjYwMTAxMDAwMDAwWhcNMjcwMTAx\n" +
  "MDAwMDAwWjAbMRkwFwYDVQQDExBhY21lLmRldiBTaWduaW5nMIIBIjANBgkqhkiG9w0B\n" +
  "AQEFAAOCAQ8AMIIBCgKCAQEA0FakeCert00000000000000000000000000000000000\n" +
  "00000000000000000000000000000000000000000000000000000000000000000000\n" +
  "00000000000000000000000000000000000000000000000000000000000000000000\n" +
  "00000000000000000000000000000000000000000000000000000000000000000000\n" +
  "0000000000000000000000000000000000000000000000000000000000000IDAQAB\n" +
  "MA0GCSqGSIb3DQEBCwUAA4IBAQC0FakeCertSignature000000000000000000000000\n" +
  "-----END CERTIFICATE-----"

export const PREVIEW_CONNECTIONS: SsoConnection[] = [
  {
    id: "conn_okta_saml",
    name: "Okta SAML",
    protocol: "saml",
    provider: "okta",
    status: "active",
    enforcement: "required_domain",
    jitEnabled: true,
    mfaRequired: true,
    relink: "ask",
    upnAsEmail: false,
    maxSessionSeconds: 86400,
    idleTimeoutSeconds: 7200,
    attributeMapping: {},
    domains: [
      {
        joinDomainId: "dom_acme_dev_01",
        name: "acme.dev",
        live: true,
      },
    ],
    directoryState: "enabled",
    universalLogoutUrl: "https://acme.okta.com/app/acme_app_1/sso/logout",
    health: {
      lastSuccessAt: ago(0, 0, 15),
      failuresLastHour: 0,
      failuresLast24Hours: 0,
      failing: false,
      reason: null,
    },
    capabilities: {
      label: "Okta SAML",
      canProveMfa: "yes",
      canProveFreshAuth: "yes",
      mfaSetting: null,
      freshAuthSetting: null,
      mfaUnprovableReason: null,
    },
  },
  {
    id: "conn_entra_saml",
    name: "Microsoft Entra ID (SAML)",
    protocol: "saml",
    provider: "entra",
    status: "testing",
    enforcement: "off",
    jitEnabled: false,
    mfaRequired: false,
    relink: "ask",
    upnAsEmail: true,
    maxSessionSeconds: null,
    idleTimeoutSeconds: null,
    attributeMapping: {},
    domains: [
      {
        joinDomainId: "dom_acme_dev_01",
        name: "acme.dev",
        live: true,
      },
    ],
    directoryState: "none",
    health: {
      lastSuccessAt: null,
      failuresLastHour: 3,
      failuresLast24Hours: 3,
      failing: true,
      reason: "failure_spike",
    },
    capabilities: {
      label: "Microsoft Entra SAML",
      canProveMfa: "yes",
      canProveFreshAuth: "yes",
      mfaSetting: null,
      freshAuthSetting: null,
      mfaUnprovableReason: null,
    },
  },
  {
    id: "conn_google_oidc",
    name: "Google Workspace (OIDC)",
    protocol: "oidc",
    provider: "google",
    status: "draft",
    enforcement: "off",
    jitEnabled: false,
    mfaRequired: false,
    relink: "auto",
    upnAsEmail: false,
    maxSessionSeconds: null,
    idleTimeoutSeconds: null,
    attributeMapping: {},
    domains: [],
    directoryState: "none",
    health: null,
    capabilities: {
      label: "Google Workspace OIDC",
      canProveMfa: "no",
      canProveFreshAuth: "no",
      mfaSetting: null,
      freshAuthSetting: null,
      mfaUnprovableReason: "Google does not include an AMR claim on standard tokens.",
    },
  },
  {
    id: "conn_custom_oidc",
    name: "Custom OIDC",
    protocol: "oidc",
    provider: "generic",
    status: "active",
    enforcement: "optional",
    jitEnabled: true,
    mfaRequired: false,
    relink: "ask",
    upnAsEmail: false,
    maxSessionSeconds: 43200,
    idleTimeoutSeconds: 3600,
    attributeMapping: {
      email: "email",
      groups: "roles",
    },
    domains: [
      {
        joinDomainId: "dom_acme_dev_01",
        name: "acme.dev",
        live: true,
      },
    ],
    directoryState: "none",
    health: {
      lastSuccessAt: ago(1, 4),
      failuresLastHour: 0,
      failuresLast24Hours: 0,
      failing: false,
      reason: null,
    },
    capabilities: {
      label: "Custom OIDC",
      canProveMfa: "with_setting",
      canProveFreshAuth: "yes",
      mfaSetting: "mfa",
      freshAuthSetting: "pwd",
      mfaUnprovableReason: null,
    },
  },
  {
    id: "conn_custom_saml",
    name: "Custom SAML",
    protocol: "saml",
    provider: "generic",
    status: "disabled",
    enforcement: "off",
    jitEnabled: false,
    mfaRequired: false,
    relink: "ask",
    upnAsEmail: false,
    maxSessionSeconds: null,
    idleTimeoutSeconds: null,
    attributeMapping: {},
    domains: [
      {
        joinDomainId: "dom_partner_acme_dev",
        name: "partner.acme.dev",
        live: false,
      },
    ],
    directoryState: "none",
    health: {
      lastSuccessAt: ago(45),
      failuresLastHour: 0,
      failuresLast24Hours: 5,
      failing: true,
      reason: "no_success",
    },
    capabilities: {
      label: "Custom SAML",
      canProveMfa: "no",
      canProveFreshAuth: "no",
      mfaSetting: null,
      freshAuthSetting: null,
      mfaUnprovableReason: "No authentication context mapped.",
    },
  },
]

const PREVIEW_PRESETS: SsoConnections["presets"] = {
  oidc: [
    {
      id: "okta",
      label: "Okta",
      issuerHint: "https://example.okta.com",
      requires: ["issuer", "clientId", "clientSecret"],
      clientAuthMethods: [
        "client_secret_basic",
        "client_secret_post",
        "private_key_jwt",
      ],
    },
    {
      id: "entra",
      label: "Microsoft Entra ID",
      issuerHint:
        "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0",
      requires: ["issuer", "clientId", "clientSecret"],
      clientAuthMethods: ["client_secret_post"],
    },
    {
      id: "google",
      label: "Google Workspace",
      issuerHint: "https://accounts.google.com",
      requires: [],
      clientAuthMethods: [],
    },
    {
      id: "jumpcloud",
      label: "JumpCloud",
      issuerHint: "https://oauth.id.jumpcloud.com/",
      requires: ["issuer", "clientId", "clientSecret"],
      clientAuthMethods: ["client_secret_basic", "client_secret_post"],
    },
    {
      id: "onelogin",
      label: "OneLogin",
      issuerHint: "https://example.onelogin.com/oidc/2",
      requires: ["issuer", "clientId", "clientSecret"],
      clientAuthMethods: ["client_secret_basic", "client_secret_post"],
    },
    {
      id: "ping",
      label: "PingIdentity",
      issuerHint: "https://auth.pingone.com/00000000-0000-0000-0000-000000000000/as",
      requires: ["issuer", "clientId", "clientSecret"],
      clientAuthMethods: ["client_secret_basic", "client_secret_post"],
    },
    {
      id: "generic",
      label: "Other OpenID Connect provider",
      issuerHint: "https://identity.example.com",
      requires: ["issuer", "clientId", "clientSecret"],
      clientAuthMethods: [
        "client_secret_basic",
        "client_secret_post",
        "private_key_jwt",
      ],
    },
  ],
  saml: [
    {
      id: "okta",
      label: "Okta",
      entityIdHint: "http://www.okta.com/exk...",
      requires: ["ssoUrl", "certificate"],
    },
    {
      id: "entra",
      label: "Microsoft Entra ID",
      entityIdHint: "https://sts.windows.net/00000000-0000-0000-0000-000000000000/",
      requires: ["ssoUrl", "certificate"],
    },
    {
      id: "google",
      label: "Google Workspace (SAML)",
      entityIdHint: "https://accounts.google.com/o/saml2?idpid=...",
      requires: ["ssoUrl", "certificate"],
    },
    {
      id: "jumpcloud",
      label: "JumpCloud",
      entityIdHint: "https://oauth.id.jumpcloud.com/saml2/...",
      requires: ["ssoUrl", "certificate"],
    },
    {
      id: "onelogin",
      label: "OneLogin",
      entityIdHint: "https://app.onelogin.com/saml/metadata/...",
      requires: ["ssoUrl", "certificate"],
    },
    {
      id: "ping",
      label: "PingIdentity",
      entityIdHint: "https://auth.pingone.com/...",
      requires: ["ssoUrl", "certificate"],
    },
    {
      id: "generic",
      label: "Other SAML 2.0 identity provider",
      entityIdHint: "https://identity.example.com/saml/metadata",
      requires: ["ssoUrl", "certificate"],
    },
  ],
}

const GOOGLE_SETUP: GoogleSetup = {
  available: true,
  unavailableReason: null,
  clientEmail: "sso-directory@acme-service-account.iam.gserviceaccount.com",
  clientId: "112233445566778899001",
  scopes: [
    "https://www.googleapis.com/auth/admin.directory.user.readonly",
    "https://www.googleapis.com/auth/admin.directory.group.readonly",
  ],
}

export const PREVIEW_DIRECTORIES: SsoDirectory[] = [
  {
    id: "dir_okta_scim",
    name: "Okta SCIM",
    provider: "okta",
    enabled: true,
    createMailboxes: true,
    baseUrl: "https://api.example.com/scim/v2/dir_okta_scim",
    createdAt: ago(90),
    tokens: [
      {
        id: "tok_okta_01",
        hint: "••••9a1f",
        createdBy: "user_preview",
        createdAt: ago(90),
        expiresAt: fromNow(180),
        revokedAt: null,
        lastUsedAt: ago(0, 0, 10),
      },
    ],
    users: 142,
    conflicts: 0,
    pending: 0,
    lastSyncAt: ago(0, 0, 10),
    lastSyncStatus: "ok",
    liveUpdates: true,
    watchStatus: "ok",
  },
  {
    id: "dir_entra_scim",
    name: "Microsoft Entra SCIM",
    provider: "entra",
    enabled: true,
    createMailboxes: false,
    baseUrl: "https://api.example.com/scim/v2/dir_entra_scim",
    createdAt: ago(45),
    tokens: [
      {
        id: "tok_entra_01",
        hint: "••••4c2d",
        createdBy: "user_preview",
        createdAt: ago(45),
        expiresAt: fromNow(2, 4),
        revokedAt: null,
        lastUsedAt: ago(0, 1),
      },
    ],
    users: 88,
    conflicts: 2,
    pending: 1,
    lastSyncAt: ago(0, 1),
    lastSyncStatus: "ok",
    liveUpdates: true,
    watchStatus: "ok",
  },
  {
    id: "dir_google_pull",
    name: "Google Workspace Directory",
    provider: "google",
    enabled: true,
    createMailboxes: true,
    baseUrl: null,
    adminEmail: "admin@acme.dev",
    domain: "acme.dev",
    createdAt: ago(30),
    tokens: [],
    users: 85,
    conflicts: 0,
    pending: 0,
    lastSyncAt: ago(0, 2),
    lastSyncStatus: "failed",
    lastSyncError: "large_drop",
    lastSyncDetail: {
      removedUsers: 24,
      existingUsers: 85,
      keptUsers: 61,
    },
    liveUpdates: false,
    watchStatus: "failed",
    google: GOOGLE_SETUP,
  },
]

const DIRECTORY_CONFLICTS: Record<string, DirectoryConflict[]> = {
  dir_entra_scim: [
    {
      id: "usr_conf_1",
      userName: "carol@acme.dev",
      displayName: "Carol Danvers",
      email: "carol@acme.dev",
      active: true,
      deleted: false,
      conflict: "Email address is already used by an existing workspace account.",
      since: ago(3),
    },
    {
      id: "usr_conf_2",
      userName: "david@acme.dev",
      displayName: "David Miller",
      email: "david@acme.dev",
      active: true,
      deleted: false,
      conflict: "Username conflict with a provisioned user in another directory.",
      since: ago(5),
    },
  ],
}

const DIRECTORY_GROUPS: Record<string, DirectoryGroup[]> = {
  dir_okta_scim: [
    { id: "grp_okta_all", displayName: "All Employees", memberCount: 142 },
    { id: "grp_okta_eng", displayName: "Engineering", memberCount: 45 },
    { id: "grp_okta_sec", displayName: "Security Team", memberCount: 6 },
  ],
  dir_entra_scim: [
    { id: "grp_entra_all", displayName: "Acme Staff", memberCount: 88 },
    { id: "grp_entra_sales", displayName: "Sales Dept", memberCount: 22 },
  ],
  dir_google_pull: [
    { id: "grp_goog_all", displayName: "Everyone", memberCount: 85 },
    { id: "grp_goog_leads", displayName: "Team Leads", memberCount: 12 },
  ],
}

const TEST_RUNS: Record<string, TestRun[]> = {
  conn_okta_saml: [
    {
      id: "run_okta_01",
      connectionId: "conn_okta_saml",
      outcome: "passed",
      reason: null,
      claims: {
        sub: "00u1234567890abcdef",
        email: "alice@acme.dev",
        email_verified: true,
        name: "Alice Smith",
        groups: ["Engineering", "Admins"],
      },
      resolution: {
        email: "alice@acme.dev",
        firstName: "Alice",
        lastName: "Smith",
        role: "admin",
      },
      createdAt: ago(0, 2),
    },
  ],
  conn_entra_saml: [
    {
      id: "run_entra_01",
      connectionId: "conn_entra_saml",
      outcome: "failed",
      reason: "domain_not_verified",
      claims: {
        aud: "https://auth.example.com/sso/saml/conn_entra_saml",
        iss: "https://sts.windows.net/00000000-0000-0000-0000-000000000000/",
        "http://schemas.microsoft.com/identity/claims/objectidentifier": "user-entra-1",
        email: "bob@otherdomain.com",
      },
      resolution: {
        refused: "domain_not_verified",
        providerFailure: {
          protocol: "saml",
          code: "AADSTS50011",
          adminNextStep:
            "Add https://auth.example.com/sso/saml/conn_entra_saml/callback to Reply URLs in Microsoft Entra Admin Center.",
          endUserMessage:
            "The reply address does not match the reply address configured for the application.",
          retry: false,
        },
      },
      createdAt: ago(0, 1),
    },
  ],
  conn_google_oidc: [],
  conn_custom_oidc: [
    {
      id: "run_custom_01",
      connectionId: "conn_custom_oidc",
      outcome: "passed",
      reason: null,
      claims: {
        sub: "cust_user_44",
        email: "david@acme.dev",
        roles: ["Staff"],
      },
      resolution: {
        email: "david@acme.dev",
        role: "member",
      },
      createdAt: ago(3),
    },
  ],
  conn_custom_saml: [
    {
      id: "run_custom_saml_01",
      connectionId: "conn_custom_saml",
      outcome: "failed",
      reason: "certificate_expired",
      claims: {
        error: "Signature validation failed",
      },
      resolution: {
        refused: "certificate_expired",
        providerFailure: {
          protocol: "saml",
          code: "CERT_EXPIRED",
          adminNextStep: "Upload an active IdP signing certificate.",
          endUserMessage: "The IdP signing certificate expired.",
          retry: false,
        },
      },
      createdAt: ago(10),
    },
  ],
}

const RELINK_REQUESTS: Record<string, RelinkRequest[]> = {
  conn_okta_saml: [
    {
      id: "rel_001",
      identityId: "ident_okta_bob",
      clerkUserId: "user_bob_clerk",
      email: "bob@acme.dev",
      createdAt: ago(1, 2),
      expiresAt: fromNow(6),
    },
  ],
}

const GROUP_RULES: Record<string, GroupRules> = {
  conn_okta_saml: {
    data: [
      { id: "grp_rule_1", group: "Admins", role: "admin", precedence: 1 },
      { id: "grp_rule_2", group: "Engineering", role: "member", precedence: 2 },
    ],
    defaultRole: "member",
    max: 20,
  },
  conn_entra_saml: {
    data: [],
    defaultRole: "member",
    max: 20,
  },
}

const BYPASS_LISTS: Record<string, BypassEntry[]> = {
  conn_okta_saml: [
    {
      userId: "user_preview",
      reason: "Emergency break-glass recovery access",
      addedBy: "user_preview",
      createdAt: ago(30),
    },
  ],
}

const SETUP_LINKS: Record<string, SetupLink[]> = {
  conn_okta_saml: [
    {
      id: "link_001",
      connectionId: "conn_okta_saml",
      contactEmail: "it-staff@acme.dev",
      createdBy: "user_preview",
      createdAt: ago(2),
      expiresAt: fromNow(5),
      usedAt: null,
      revokedAt: null,
      revokedReason: null,
      live: true,
    },
    {
      id: "link_002",
      connectionId: "conn_okta_saml",
      contactEmail: "consultant@example.com",
      createdBy: "user_preview",
      createdAt: ago(10),
      expiresAt: ago(3),
      usedAt: ago(4),
      revokedAt: null,
      revokedReason: null,
      live: false,
    },
  ],
}

const OIDC_SETUPS: Record<string, OidcSetup> = {
  conn_google_oidc: {
    provider: "google",
    label: "Google Workspace",
    redirectUri: "https://auth.example.com/sso/oidc/conn_google_oidc/callback",
    jwksUrl: "https://auth.example.com/sso/oidc/conn_google_oidc/jwks",
    issuerHint: "https://accounts.google.com",
    requires: [],
    clientAuthMethods: [],
    defaults: { scopes: ["openid", "email", "profile"] },
    issuer: null,
    discoveryUrl: null,
    clientId: null,
    clientAuth: null,
    scopes: null,
    acrValues: [],
    mfaAcrValues: [],
    clientSecretSet: false,
    secretExpiresAt: null,
    keys: [],
    ready: false,
  },
  conn_custom_oidc: {
    provider: "generic",
    label: "Other OpenID Connect provider",
    redirectUri: "https://auth.example.com/sso/oidc/conn_custom_oidc/callback",
    jwksUrl: "https://auth.example.com/sso/oidc/conn_custom_oidc/jwks",
    issuerHint: "https://identity.example.com",
    requires: ["issuer", "clientId", "clientSecret"],
    clientAuthMethods: ["client_secret_basic", "client_secret_post", "private_key_jwt"],
    defaults: { scopes: ["openid", "email", "profile"] },
    issuer: "https://oidc.example.com",
    discoveryUrl: "https://oidc.example.com/.well-known/openid-configuration",
    clientId: "cust_client_abc123",
    clientAuth: "client_secret_basic",
    scopes: ["openid", "email", "profile", "roles"],
    acrValues: ["pwd", "mfa"],
    mfaAcrValues: ["mfa"],
    clientSecretSet: true,
    secretExpiresAt: fromNow(9, 12),
    keys: [{ kid: "key_cust_1", createdAt: ago(90) }],
    ready: true,
  },
}

const SAML_SETUPS: Record<string, SamlSetup> = {
  conn_okta_saml: {
    provider: "okta",
    label: "Okta",
    entityId: "https://auth.example.com/sso/saml/conn_okta_saml",
    acsUrl: "https://auth.example.com/sso/saml/conn_okta_saml/callback",
    sloUrl: "https://auth.example.com/sso/saml/conn_okta_saml/slo",
    metadataUrl: "https://auth.example.com/sso/saml/conn_okta_saml/metadata",
    entityIdHint: "http://www.okta.com/exk...",
    requires: ["ssoUrl", "certificate"],
    idpEntityId: "http://www.okta.com/exk1234567890abcdef",
    ssoUrl: "https://acme.okta.com/app/acme_app_1/sso/saml",
    idpSloUrl: "https://acme.okta.com/app/acme_app_1/sso/slo",
    idpMetadataUrl: "https://acme.okta.com/app/exk1234567890abcdef/sso/saml/metadata",
    metadataFetchedAt: ago(0, 12),
    metadataError: null,
    nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    signRequests: true,
    requireEncryption: false,
    idpInitiated: false,
    subjectAttribute: null,
    mfaContextClasses: ["http://schemas.microsoft.com/claims/multipleauthn"],
    spCertificates: [
      {
        fingerprint: "11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF:00:11:22:33",
        certificate: FAKE_SP_CERT,
        notAfter: fromNow(365),
        createdAt: ago(180),
      },
    ],
    certificates: [
      {
        id: "cert_okta_01",
        fingerprint: "AA:11:BB:22:CC:33:DD:44:EE:55:FF:66:00:77:88:99:AA:BB:CC:DD",
        subject: "CN=acme.okta.com",
        notBefore: ago(180),
        notAfter: fromNow(365),
        source: "metadata",
      },
    ],
    ready: true,
  },
  conn_entra_saml: {
    provider: "entra",
    label: "Microsoft Entra ID",
    entityId: "https://auth.example.com/sso/saml/conn_entra_saml",
    acsUrl: "https://auth.example.com/sso/saml/conn_entra_saml/callback",
    sloUrl: "https://auth.example.com/sso/saml/conn_entra_saml/slo",
    metadataUrl: "https://auth.example.com/sso/saml/conn_entra_saml/metadata",
    entityIdHint: "https://sts.windows.net/00000000-0000-0000-0000-000000000000/",
    requires: ["ssoUrl", "certificate"],
    idpEntityId: "https://sts.windows.net/00000000-0000-0000-0000-000000000000/",
    ssoUrl:
      "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/saml2",
    idpSloUrl: null,
    idpMetadataUrl:
      "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/federationmetadata/2007-06/federationmetadata.xml",
    metadataFetchedAt: ago(2),
    metadataError: null,
    nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    signRequests: false,
    requireEncryption: false,
    idpInitiated: false,
    subjectAttribute: null,
    mfaContextClasses: [],
    spCertificates: [
      {
        fingerprint: "22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF:00:11:22:33:44",
        certificate: FAKE_SP_CERT,
        notAfter: fromNow(365),
        createdAt: ago(45),
      },
    ],
    certificates: [
      {
        id: "cert_entra_01",
        fingerprint: "BB:22:CC:33:DD:44:EE:55:FF:66:00:77:88:99:AA:BB:CC:DD:EE:FF",
        subject: "CN=Microsoft Azure Federated SSO Certificate",
        notBefore: ago(45),
        notAfter: fromNow(300),
        source: "metadata",
      },
    ],
    ready: true,
  },
  conn_custom_saml: {
    provider: "generic",
    label: "Other SAML 2.0 identity provider",
    entityId: "https://auth.example.com/sso/saml/conn_custom_saml",
    acsUrl: "https://auth.example.com/sso/saml/conn_custom_saml/callback",
    sloUrl: "https://auth.example.com/sso/saml/conn_custom_saml/slo",
    metadataUrl: "https://auth.example.com/sso/saml/conn_custom_saml/metadata",
    entityIdHint: "https://identity.example.com/saml/metadata",
    requires: ["ssoUrl", "certificate"],
    idpEntityId: "https://legacy-idp.example.com/entity",
    ssoUrl: "https://legacy-idp.example.com/sso",
    idpSloUrl: null,
    idpMetadataUrl: null,
    metadataFetchedAt: null,
    metadataError: null,
    nameIdFormat: null,
    signRequests: true,
    requireEncryption: false,
    idpInitiated: false,
    subjectAttribute: null,
    mfaContextClasses: [],
    spCertificates: [
      {
        fingerprint: "33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55",
        certificate: FAKE_SP_CERT,
        notAfter: fromNow(200),
        createdAt: ago(120),
      },
    ],
    certificates: [
      {
        id: "cert_custom_expired",
        fingerprint: "EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11",
        subject: "CN=Legacy Identity Provider Signing Cert",
        notBefore: ago(730),
        notAfter: ago(5),
        source: "upload",
      },
    ],
    ready: true,
  },
}

const LDAP_SETUPS: Record<string, LdapSetup> = {
  conn_okta_saml: {
    host: "ldap.internal.acme.dev",
    port: 636,
    tlsMode: "ldaps",
    caPem: null,
    searchBase: "dc=acme,dc=dev",
    userFilter: "(sAMAccountName={input})",
    enabled: false,
    serviceSet: false,
    tested: false,
    testedAt: null,
    testValidSeconds: 300,
    ports: [389, 636],
    tlsModes: ["ldaps", "starttls"],
    filterPlaceholder: "(uid={input})",
    results: [
      "ok",
      "unreachable",
      "tls_failed",
      "service_bind_failed",
      "user_not_found",
      "user_bind_failed",
    ],
  },
}

const OWNER_EXEMPTION: OwnerExemption = {
  enabled: true,
  pending: {
    requestedBy: "user_charlie",
    requestedAt: ago(0, 4),
    expiresAt: fromNow(0, 20),
  },
}

const IP_ALLOWLIST: IpAllowlist = {
  console: true,
  apiKeys: true,
  ranges: ["198.51.100.0/24", "203.0.113.42/32"],
  maxRanges: 25,
  yourAddress: "203.0.113.42",
  yourAddressListed: true,
  graceUntil: fromNow(1, 12),
}

const SIEM_SETTINGS: SiemSettingsAnswer = {
  configured: true,
  settings: {
    endpoint: "https://s3.us-east-1.amazonaws.com",
    bucket: "acme-security-siem-audit",
    region: "us-east-1",
    prefix: "identity/audit-logs/",
    accessKeyId: "AKIAEXAMPLESIEMKEY",
    secretAccessKey: "••••7x9q",
    enabled: true,
    lastExportAt: ago(0, 1),
    lastError:
      "Access Denied writing to S3 prefix: s3:PutObject on acme-security-siem-audit/identity/audit-logs/2026-11-04.jsonl",
    lastErrorAt: ago(0, 1),
  },
}

const MAILBOXES: Mailboxes = {
  data: [
    {
      userId: "user_alice",
      address: "alice@acme.dev",
      state: "active",
      suspendedAt: null,
      next: "keep",
      targetUserId: null,
      deleteAfterDays: null,
      deleteAt: null,
    },
    {
      userId: "user_bob",
      address: "bob@acme.dev",
      state: "suspended",
      suspendedAt: ago(3),
      next: "forward_manager",
      targetUserId: "user_preview",
      deleteAfterDays: null,
      deleteAt: null,
    },
    {
      userId: "user_charlie",
      address: "charlie@acme.dev",
      state: "suspended",
      suspendedAt: ago(10),
      next: "delegate",
      targetUserId: "user_preview",
      deleteAfterDays: null,
      deleteAt: null,
    },
    {
      userId: "user_dan",
      address: "dan@acme.dev",
      state: "suspended",
      suspendedAt: ago(15),
      next: "delete",
      targetUserId: null,
      deleteAfterDays: 30,
      deleteAt: fromNow(15),
    },
    {
      userId: "user_eve",
      address: "eve@acme.dev",
      state: "suspended",
      suspendedAt: ago(7),
      next: "keep",
      targetUserId: null,
      deleteAfterDays: null,
      deleteAt: null,
    },
  ],
  leavers: {
    action: "delete_after",
    days: 30,
  },
  limits: {
    minDays: 7,
    maxDays: 365,
  },
}

const DEPROVISIONED_PEOPLE: DeprovisionedPerson[] = [
  {
    user_id: "user_deprov_1",
    deprovisioned_at: ago(4),
    keys: [
      {
        id: "key_deprov_101",
        name: "CI Deploy Bot Key",
        prefix: "i10_live_dprv1",
        mode: "live",
        created_at: ago(120),
        last_used_at: ago(0, 6),
        expires_at: fromNow(60),
      },
      {
        id: "key_deprov_102",
        name: "Staging Ingest Key",
        prefix: "i10_test_dprv2",
        mode: "test",
        created_at: ago(60),
        last_used_at: ago(10),
        expires_at: null,
      },
    ],
  },
  {
    user_id: "user_deprov_2",
    deprovisioned_at: ago(12),
    keys: [
      {
        id: "key_deprov_201",
        name: "Old Zapier Webhook Trigger",
        prefix: "i10_live_dprv3",
        mode: "live",
        created_at: ago(200),
        last_used_at: ago(1),
        expires_at: null,
      },
    ],
  },
]

const IDENTITY_EVENTS: IdentityEvent[] = [
  {
    id: "evt_001",
    type: "sso.connection.updated",
    actorUserId: "user_preview",
    subjectUserId: null,
    connectionId: "conn_okta_saml",
    sessionId: null,
    reason: null,
    data: { change: "enforcement: required_domain" },
    createdAt: ago(0, 1),
  },
  {
    id: "evt_002",
    type: "sso.test_run.passed",
    actorUserId: "user_preview",
    subjectUserId: "user_preview",
    connectionId: "conn_okta_saml",
    sessionId: null,
    reason: null,
    data: { email: "alice@acme.dev" },
    createdAt: ago(0, 2),
  },
  {
    id: "evt_003",
    type: "owner_exemption.off_requested",
    actorUserId: "user_charlie",
    subjectUserId: null,
    connectionId: null,
    sessionId: null,
    reason: "Preparing for strict IdP lockdown",
    data: { requestedBy: "user_charlie" },
    createdAt: ago(0, 4),
  },
  {
    id: "evt_004",
    type: "directory.sync.failed",
    actorUserId: null,
    subjectUserId: null,
    connectionId: null,
    sessionId: null,
    reason: "large_drop: 24 users would be removed",
    data: { directoryId: "dir_google_pull", code: "large_drop", removedUsers: 24 },
    createdAt: ago(0, 6),
  },
  {
    id: "evt_005",
    type: "sso.test_run.failed",
    actorUserId: "user_preview",
    subjectUserId: "user_bob",
    connectionId: "conn_entra_saml",
    sessionId: null,
    reason: "domain_not_verified",
    data: { code: "AADSTS50011" },
    createdAt: ago(1, 1),
  },
  {
    id: "evt_006",
    type: "ip_allowlist.updated",
    actorUserId: "user_preview",
    subjectUserId: null,
    connectionId: null,
    sessionId: null,
    reason: "Added office network range",
    data: { ranges: ["198.51.100.0/24", "203.0.113.42/32"] },
    createdAt: ago(2, 3),
  },
  {
    id: "evt_007",
    type: "mailbox.status_changed",
    actorUserId: "user_preview",
    subjectUserId: "user_bob",
    connectionId: null,
    sessionId: null,
    reason: "Person suspended in directory",
    data: { next: "forward_manager", target: "user_preview" },
    createdAt: ago(3, 8),
  },
  {
    id: "evt_008",
    type: "policy.session.updated",
    actorUserId: "user_preview",
    subjectUserId: null,
    connectionId: null,
    sessionId: null,
    reason: null,
    data: { maxSessionSeconds: 86400, idleTimeoutSeconds: 7200 },
    createdAt: ago(5, 12),
  },
  {
    id: "evt_009",
    type: "session.revoked",
    actorUserId: "user_preview",
    subjectUserId: "user_deprov_1",
    connectionId: null,
    sessionId: "sess_99182",
    reason: "Directory deprovisioning",
    data: {},
    createdAt: ago(7, 2),
  },
  {
    id: "evt_010",
    type: "sso.connection.created",
    actorUserId: "user_preview",
    subjectUserId: null,
    connectionId: "conn_okta_saml",
    sessionId: null,
    reason: null,
    data: { protocol: "saml", provider: "okta" },
    createdAt: ago(10, 0),
  },
]

type WalkThrough = {
  created: Map<string, SsoConnection>
  oidc: Map<string, OidcSetup>
  saml: Map<string, SamlSetup>
  runs: Map<string, TestRun[]>
  access: AccessDomain[]
  checks: Map<string, number>
}

function accessDomain(name: string, source: AccessDomain["source"]): AccessDomain {
  return {
    id: `ad_${name}`,
    name,
    source,
    status: source === "domains" ? "verified" : "pending",
    txt: {
      name: `_i10-challenge.${name}`,
      value: "i10-verify=0f3c9a7e41b84d6fa2c1d5e8b7a06c33",
    },
    rules: [],
    orphaned: false,
    verified_at: source === "domains" ? new Date().toISOString() : null,
    checked_at: null,
    created_at: new Date().toISOString(),
  }
}

/**
 * The setup flow is reviewed by walking through it, so a connection made in
 * preview has to remember its steps. On `globalThis` because the page and the
 * server actions can each hold their own copy of this module.
 */
const scope = globalThis as unknown as { __ssoPreviewWalk?: WalkThrough }
const walk = (scope.__ssoPreviewWalk ??= {
  created: new Map(),
  oidc: new Map(),
  saml: new Map(),
  runs: new Map(),
  access: [accessDomain("acme.io", "domains"), accessDomain("acme.co.uk", "domains")],
  checks: new Map(),
})

function newOidcSetup(id: string, input: SsoConnection): OidcSetup {
  const isGoogle = input.provider === "google"
  return {
    provider: input.provider,
    label: input.provider === "okta" ? "Okta" : input.name,
    redirectUri: isGoogle
      ? "https://auth.example.com/sso/google/callback"
      : `https://auth.example.com/sso/oidc/${id}/callback`,
    jwksUrl: `https://auth.example.com/sso/oidc/${id}/jwks`,
    issuerHint:
      input.provider === "okta"
        ? "https://your-org.okta.com"
        : isGoogle
          ? "https://accounts.google.com"
          : null,
    requires: [],
    clientAuthMethods: isGoogle
      ? []
      : ["client_secret_basic", "client_secret_post", "private_key_jwt"],
    defaults: { scopes: ["openid", "email", "profile"] },
    issuer: isGoogle ? "https://accounts.google.com" : null,
    discoveryUrl: null,
    clientId: isGoogle ? "google-sso-client-id" : null,
    clientAuth: isGoogle ? "client_secret_basic" : null,
    scopes: null,
    acrValues: [],
    mfaAcrValues: [],
    clientSecretSet: isGoogle,
    secretExpiresAt: null,
    keys: [],
    ready: isGoogle,
  }
}

function newSamlSetup(id: string, input: SsoConnection): SamlSetup {
  const isOkta = input.provider === "okta"
  const isEntra = input.provider === "entra"
  const isGoogle = input.provider === "google"
  return {
    provider: input.provider,
    label: input.name,
    entityId: `https://auth.example.com/sso/saml/${id}`,
    acsUrl: `https://auth.example.com/sso/saml/${id}/callback`,
    sloUrl: `https://auth.example.com/sso/saml/${id}/slo`,
    metadataUrl: `https://auth.example.com/sso/saml/${id}/metadata`,
    entityIdHint: isOkta
      ? "http://www.okta.com/exk..."
      : isEntra
        ? "https://sts.windows.net/00000000-0000-0000-0000-000000000000/"
        : isGoogle
          ? "https://accounts.google.com/o/saml2?idpid=..."
          : "https://identity.example.com/saml/metadata",
    requires: ["ssoUrl", "certificate"],
    idpEntityId: null,
    ssoUrl: null,
    idpSloUrl: null,
    idpMetadataUrl: null,
    metadataFetchedAt: null,
    metadataError: null,
    nameIdFormat: null,
    signRequests: false,
    requireEncryption: false,
    idpInitiated: false,
    subjectAttribute: null,
    mfaContextClasses: [],
    spCertificates: [
      {
        fingerprint: "11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF:00:11:22:33",
        certificate: FAKE_SP_CERT,
        notAfter: fromNow(365),
        createdAt: new Date().toISOString(),
      },
    ],
    certificates: [],
    ready: false,
  }
}

/** The API answers a write without the connection's `domains`. */
function writeAnswer(connection: SsoConnection): Partial<SsoConnection> {
  const answer: Partial<SsoConnection> = { ...connection }
  delete answer.domains
  return answer
}

function saveWalkOidc(id: string, change: Partial<OidcSetup>): OidcSetup {
  const next = { ...walk.oidc.get(id)!, ...change }
  next.ready = Boolean(
    next.provider === "google" ||
    (next.issuer && next.clientId && next.clientSecretSet),
  )
  walk.oidc.set(id, next)
  return next
}

function saveWalkSaml(id: string, change: Record<string, unknown>): SamlSetup {
  const current =
    walk.saml.get(id) ??
    newSamlSetup(
      id,
      walk.created.get(id) ?? ({ provider: "generic", name: "SAML" } as SsoConnection),
    )
  const next: SamlSetup = { ...current, ...(change as Partial<SamlSetup>) }
  if (change.metadataUrl !== undefined) {
    const url =
      typeof change.metadataUrl === "string" ? change.metadataUrl.trim() : null
    next.idpMetadataUrl = url
    if (url) {
      next.metadataFetchedAt = new Date().toISOString()
      next.metadataError = null
      next.idpEntityId ??= `${url}/entity`
      next.ssoUrl ??= `${url}/sso`
      if (next.certificates.length === 0) {
        next.certificates = [
          {
            id: `cert_${Date.now()}`,
            fingerprint: "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD",
            subject: `CN=${next.label} Signing Certificate`,
            notBefore: new Date().toISOString(),
            notAfter: fromNow(365),
            source: "metadata",
          },
        ]
      }
    }
  }
  if (change.metadataXml !== undefined) {
    next.metadataFetchedAt = new Date().toISOString()
    next.metadataError = null
    next.idpEntityId ??= "https://idp.example.com/entity"
    next.ssoUrl ??= "https://idp.example.com/sso"
    if (next.certificates.length === 0) {
      next.certificates = [
        {
          id: `cert_${Date.now()}`,
          fingerprint: "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD",
          subject: `CN=${next.label} Uploaded Certificate`,
          notBefore: new Date().toISOString(),
          notAfter: fromNow(365),
          source: "upload",
        },
      ]
    }
  }
  next.ready = Boolean(
    (next.idpEntityId && next.ssoUrl && next.certificates.length > 0) ||
    (next.idpMetadataUrl && next.certificates.length > 0),
  )
  walk.saml.set(id, next)
  return next
}

export function ssoRoutes(notFound: unknown): Route[] {
  const findConn = (id: string) =>
    walk.created.get(id) ?? PREVIEW_CONNECTIONS.find((c) => c.id === id) ?? notFound
  const findDir = (id: string) =>
    PREVIEW_DIRECTORIES.find((d) => d.id === id) ?? notFound

  return [
    [
      /^\/console\/team\/access-domains$/,
      (_m, _query, method, body) => {
        if (method === "POST") {
          const { name, source } = body as {
            name: string
            source: AccessDomain["source"]
          }
          const added = accessDomain(name, source)
          walk.access = [...walk.access.filter((d) => d.name !== name), added]
          return { id: added.id }
        }
        return { data: walk.access, verified: [], suggested: [] }
      },
    ],
    [
      /^\/console\/team\/access-domains\/([^/]+)$/,
      (m) => {
        walk.access = walk.access.filter((d) => d.id !== m[1])
        return { ok: true }
      },
    ],
    [
      /^\/console\/team\/access-domains\/([^/]+)\/verify$/,
      (m) => {
        const checks = (walk.checks.get(m[1]!) ?? 0) + 1
        walk.checks.set(m[1]!, checks)
        if (checks < 3) return { proven: false, reason: "absent" }
        walk.access = walk.access.map((d) =>
          d.id === m[1] ? { ...d, status: "verified" as const } : d,
        )
        return { proven: true, reason: "proven" }
      },
    ],
    [
      /^\/console\/identity\/connections$/,
      (_m, _query, method, body) => {
        if (method === "POST") {
          const input = (body ?? {}) as {
            name?: string
            protocol?: "oidc" | "saml"
            provider?: string
          }
          const created: SsoConnection = {
            id: `conn_new_${Date.now()}`,
            name: input.name ?? "New Connection",
            protocol: input.protocol ?? "saml",
            provider: input.provider ?? "generic",
            status: "draft",
            enforcement: "off",
            jitEnabled: false,
            mfaRequired: false,
            relink: "ask",
            upnAsEmail: false,
            maxSessionSeconds: null,
            idleTimeoutSeconds: null,
            attributeMapping: {},
            domains: [],
            directoryState: "none",
            health: null,
          }
          walk.created.set(created.id, created)
          walk.oidc.set(created.id, newOidcSetup(created.id, created))
          walk.saml.set(created.id, newSamlSetup(created.id, created))
          return writeAnswer(created)
        }
        const answer: SsoConnections = {
          data: [...PREVIEW_CONNECTIONS, ...walk.created.values()],
          protocols: ["oidc", "saml"],
          presets: PREVIEW_PRESETS,
        }
        return answer
      },
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)$/,
      (m, _query, method, body) => {
        const conn = findConn(m[1]!)
        if (conn === notFound) return notFound
        if (method === "DELETE") {
          walk.created.delete(m[1]!)
          walk.oidc.delete(m[1]!)
          walk.saml.delete(m[1]!)
          walk.runs.delete(m[1]!)
          return { ok: true }
        }
        if (method === "PATCH") {
          const next = { ...(conn as SsoConnection), ...(body as object) }
          if (walk.created.has(next.id)) walk.created.set(next.id, next)
          return writeAnswer(next)
        }
        return conn
      },
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/domains$/,
      (m, _query, method, body) => {
        const conn = findConn(m[1]!)
        if (conn === notFound) return notFound
        const joinDomainId = (body as { joinDomainId?: string } | undefined)
          ?.joinDomainId
        const domain = walk.access.find((d) => d.id === joinDomainId)
        if (method === "POST" && domain && walk.created.has(m[1]!))
          walk.created.set(m[1]!, {
            ...(conn as SsoConnection),
            domains: [
              ...(conn as SsoConnection).domains,
              { joinDomainId: domain.id, name: domain.name, live: true },
            ],
          })
        return { ok: true }
      },
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/domains\/([^/]+)$/,
      (m) => (findConn(m[1]!) === notFound ? notFound : { ok: true }),
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/test-runs$/,
      (m, _query, method) => {
        if (findConn(m[1]!) === notFound) return notFound
        if (method === "POST") {
          const run: TestRun = {
            id: `run_${Date.now()}`,
            connectionId: m[1]!,
            outcome: "passed",
            reason: null,
            claims: { email: "you@acme.dev", sub: "00u1preview" },
            resolution: { email: "you@acme.dev", role: "member", wouldCreate: false },
            createdAt: new Date().toISOString(),
          }
          walk.runs.set(m[1]!, [run, ...(walk.runs.get(m[1]!) ?? [])])
          return run
        }
        return { data: walk.runs.get(m[1]!) ?? TEST_RUNS[m[1]!] ?? [] }
      },
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/oidc$/,
      (m, _query, method, body) => {
        if (findConn(m[1]!) === notFound) return notFound
        if (walk.oidc.has(m[1]!))
          return method === "PUT"
            ? saveWalkOidc(m[1]!, body as Partial<OidcSetup>)
            : walk.oidc.get(m[1]!)
        const setup = OIDC_SETUPS[m[1]!]
        if (!setup) return notFound
        if (method === "PUT") {
          return { ...setup, ...(body as object), ready: true }
        }
        return setup
      },
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/oidc\/secret$/,
      (m, _query, _method, body) => {
        if (findConn(m[1]!) === notFound) return notFound
        if (walk.oidc.has(m[1]!)) return saveWalkOidc(m[1]!, { clientSecretSet: true })
        const setup = OIDC_SETUPS[m[1]!]
        if (!setup) return notFound
        const b = (body ?? {}) as { secretExpiresAt?: string | null }
        return {
          ...setup,
          clientSecretSet: true,
          secretExpiresAt: b.secretExpiresAt ?? null,
          ready: true,
        }
      },
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/oidc\/keys$/,
      (m) => {
        if (findConn(m[1]!) === notFound) return notFound
        const setup = OIDC_SETUPS[m[1]!]
        if (!setup) return notFound
        return {
          ...setup,
          keys: [
            ...setup.keys,
            { kid: `key_${Date.now()}`, createdAt: new Date().toISOString() },
          ],
          ready: true,
        }
      },
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/saml$/,
      (m, _query, method, body) => {
        if (findConn(m[1]!) === notFound) return notFound
        if (walk.saml.has(m[1]!))
          return method === "PUT"
            ? saveWalkSaml(m[1]!, (body as Record<string, unknown>) ?? {})
            : walk.saml.get(m[1]!)
        const setup = SAML_SETUPS[m[1]!]
        if (!setup) {
          const conn = walk.created.get(m[1]!)
          if (conn) {
            const s = newSamlSetup(m[1]!, conn)
            walk.saml.set(m[1]!, s)
            return method === "PUT"
              ? saveWalkSaml(m[1]!, (body as Record<string, unknown>) ?? {})
              : s
          }
          return notFound
        }
        if (method === "PUT") {
          return { ...setup, ...(body as object), ready: true }
        }
        return setup
      },
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/saml\/certificates$/,
      (m) => {
        if (findConn(m[1]!) === notFound) return notFound
        const newCert = {
          id: `cert_${Date.now()}`,
          fingerprint: "FF:EE:DD:CC:BB:AA:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD",
          subject: "CN=New IdP Certificate",
          notBefore: new Date().toISOString(),
          notAfter: fromNow(365),
          source: "upload",
        }
        if (walk.saml.has(m[1]!)) {
          const current = walk.saml.get(m[1]!)!
          const updated = {
            ...current,
            certificates: [...current.certificates, newCert],
          }
          updated.ready = Boolean(
            (updated.idpEntityId &&
              updated.ssoUrl &&
              updated.certificates.length > 0) ||
            (updated.idpMetadataUrl && updated.certificates.length > 0),
          )
          walk.saml.set(m[1]!, updated)
          return updated
        }
        const setup = SAML_SETUPS[m[1]!]
        if (!setup) return notFound
        return {
          ...setup,
          certificates: [...setup.certificates, newCert],
          ready: true,
        }
      },
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/saml\/certificates\/([^/]+)$/,
      (m) => {
        if (findConn(m[1]!) === notFound) return notFound
        const setup = SAML_SETUPS[m[1]!]
        if (!setup) return notFound
        return {
          ...setup,
          certificates: setup.certificates.filter((c) => c.id !== m[2]),
        }
      },
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/saml\/sp-key$/,
      (m) => {
        if (findConn(m[1]!) === notFound) return notFound
        const setup = SAML_SETUPS[m[1]!]
        if (!setup) return notFound
        return {
          ...setup,
          spCertificates: [
            ...setup.spCertificates,
            {
              fingerprint:
                "55:66:77:88:99:00:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77",
              certificate: FAKE_SP_CERT,
              notAfter: fromNow(365),
              createdAt: new Date().toISOString(),
            },
          ],
        }
      },
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/saml\/refresh$/,
      (m) => {
        if (findConn(m[1]!) === notFound) return notFound
        if (walk.saml.has(m[1]!)) {
          return saveWalkSaml(m[1]!, {
            metadataFetchedAt: new Date().toISOString(),
            metadataError: null,
          })
        }
        const setup = SAML_SETUPS[m[1]!]
        if (!setup) return notFound
        return {
          ...setup,
          metadataFetchedAt: new Date().toISOString(),
          metadataError: null,
        }
      },
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/group-rules$/,
      (m, _query, method, body) => {
        if (findConn(m[1]!) === notFound) return notFound
        const current = GROUP_RULES[m[1]!] ?? {
          data: [],
          defaultRole: "member",
          max: 20,
        }
        if (method === "POST") {
          const input = (body ?? {}) as Partial<GroupRule>
          const created: GroupRule = {
            id: `rule_${Date.now()}`,
            group: input.group ?? "New Group",
            role: input.role ?? "member",
            precedence: input.precedence ?? 1,
          }
          return created
        }
        return current
      },
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/group-rules\/([^/]+)$/,
      (m, _query, method, body) => {
        if (findConn(m[1]!) === notFound) return notFound
        if (method === "DELETE") return { ok: true }
        const input = (body ?? {}) as Partial<GroupRule>
        const updated: GroupRule = {
          id: m[2]!,
          group: input.group ?? "Updated Group",
          role: input.role ?? "member",
          precedence: input.precedence ?? 1,
        }
        return updated
      },
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/bypass$/,
      (m, _query, method, body) => {
        if (findConn(m[1]!) === notFound) return notFound
        if (method === "POST") {
          const input = (body ?? {}) as { userId?: string; reason?: string }
          return {
            userId: input.userId ?? "user_preview",
            reason: input.reason ?? "Admin bypass",
          }
        }
        return { data: BYPASS_LISTS[m[1]!] ?? [] }
      },
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/bypass\/([^/]+)$/,
      (m) => (findConn(m[1]!) === notFound ? notFound : { ok: true }),
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/relinks$/,
      (m) => {
        if (findConn(m[1]!) === notFound) return notFound
        return { data: RELINK_REQUESTS[m[1]!] ?? [] }
      },
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/relinks\/([^/]+)\/approve$/,
      (m) => (findConn(m[1]!) === notFound ? notFound : { ok: true }),
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/relinks\/([^/]+)\/reject$/,
      (m) => (findConn(m[1]!) === notFound ? notFound : { ok: true }),
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/setup-links$/,
      (m, _query, method, body) => {
        if (findConn(m[1]!) === notFound) return notFound
        if (method === "POST") {
          const input = (body ?? {}) as {
            contactEmail?: string | null
            expiresInHours?: number
          }
          const created: CreatedSetupLink = {
            id: `link_${Date.now()}`,
            connectionId: m[1]!,
            contactEmail: input.contactEmail ?? null,
            createdBy: "user_preview",
            createdAt: new Date().toISOString(),
            expiresAt: fromNow(0, input.expiresInHours ?? 24),
            usedAt: null,
            revokedAt: null,
            revokedReason: null,
            live: true,
            token: "setuplink_live_token_sample",
          }
          return created
        }
        return { data: SETUP_LINKS[m[1]!] ?? [] }
      },
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/setup-links\/([^/]+)\/revoke$/,
      (m, _query, _method, body) => {
        if (findConn(m[1]!) === notFound) return notFound
        const reason = ((body ?? {}) as { reason?: string }).reason ?? "Revoked"
        const link: SetupLink = {
          id: m[2]!,
          connectionId: m[1]!,
          contactEmail: "staff@acme.dev",
          createdBy: "user_preview",
          createdAt: ago(1),
          expiresAt: fromNow(2),
          usedAt: null,
          revokedAt: new Date().toISOString(),
          revokedReason: reason,
          live: false,
        }
        return link
      },
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/ldap$/,
      (m, _query, method, body) => {
        if (findConn(m[1]!) === notFound) return notFound
        const current = LDAP_SETUPS[m[1]!] ?? {
          host: null,
          port: null,
          tlsMode: null,
          caPem: null,
          searchBase: null,
          userFilter: null,
          enabled: false,
          serviceSet: false,
          tested: false,
          testedAt: null,
          testValidSeconds: 300,
          ports: [389, 636],
          tlsModes: ["ldaps", "starttls"],
          filterPlaceholder: "(uid={input})",
          results: [
            "ok",
            "unreachable",
            "tls_failed",
            "service_bind_failed",
            "user_not_found",
            "user_bind_failed",
          ],
        }
        if (method === "PUT") {
          return { ...current, ...(body as object) }
        }
        return current
      },
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/ldap\/service$/,
      (m) => {
        if (findConn(m[1]!) === notFound) return notFound
        const current = LDAP_SETUPS[m[1]!]
        if (!current) return notFound
        return { ...current, serviceSet: true }
      },
    ],
    [
      /^\/console\/identity\/connections\/([^/]+)\/ldap\/test$/,
      (m) => {
        if (findConn(m[1]!) === notFound) return notFound
        const result: LdapTestOutcome = { result: "ok", recorded: true }
        return result
      },
    ],
    [/^\/console\/identity\/owner-exemption$/, () => OWNER_EXEMPTION],
    [
      /^\/console\/identity\/owner-exemption\/off-request$/,
      (_m, _query, method) => {
        if (method === "DELETE") {
          return { ...OWNER_EXEMPTION, pending: null }
        }
        return {
          ...OWNER_EXEMPTION,
          pending: {
            requestedBy: "user_preview",
            requestedAt: new Date().toISOString(),
            expiresAt: fromNow(0, 24),
          },
        }
      },
    ],
    [
      /^\/console\/identity\/owner-exemption\/off-request\/approve$/,
      () => ({ enabled: false, pending: null }),
    ],
    [
      /^\/console\/identity\/owner-exemption\/on$/,
      () => ({ enabled: true, pending: null }),
    ],
    [
      /^\/console\/identity\/directories$/,
      (_m, _query, method, body) => {
        if (method === "POST") {
          const input = (body ?? {}) as Partial<SsoDirectory>
          const created: SsoDirectory = {
            id: `dir_new_${Date.now()}`,
            name: input.name ?? "New Directory",
            provider: input.provider ?? "okta",
            enabled: false,
            createMailboxes: false,
            baseUrl: "https://api.example.com/scim/v2/new",
            createdAt: new Date().toISOString(),
            tokens: [],
            users: 0,
            conflicts: 0,
            pending: 0,
          }
          return created
        }
        const answer: SsoDirectories = {
          data: PREVIEW_DIRECTORIES,
          max: 5,
          providers: ["okta", "entra", "google", "generic"],
          google: GOOGLE_SETUP,
        }
        return answer
      },
    ],
    [
      /^\/console\/identity\/directories\/([^/]+)$/,
      (m, _query, method, body) => {
        const dir = findDir(m[1]!)
        if (dir === notFound) return notFound
        if (method === "PATCH") {
          return { ...(dir as SsoDirectory), ...(body as object) }
        }
        return dir
      },
    ],
    [
      /^\/console\/identity\/directories\/([^/]+)\/check$/,
      (m) => (findDir(m[1]!) === notFound ? notFound : { ok: true }),
    ],
    [
      /^\/console\/identity\/directories\/([^/]+)\/confirm-removals$/,
      (m) => (findDir(m[1]!) === notFound ? notFound : { ok: true }),
    ],
    [
      /^\/console\/identity\/directories\/([^/]+)\/tokens$/,
      (m) => {
        if (findDir(m[1]!) === notFound) return notFound
        return {
          id: `tok_${Date.now()}`,
          token: "scim_token_preview_sample_value",
          baseUrl: `https://api.example.com/scim/v2/${m[1]!}`,
        }
      },
    ],
    [
      /^\/console\/identity\/directories\/([^/]+)\/tokens\/([^/]+)$/,
      (m) => (findDir(m[1]!) === notFound ? notFound : { ok: true }),
    ],
    [
      /^\/console\/identity\/directories\/([^/]+)\/conflicts$/,
      (m) => {
        if (findDir(m[1]!) === notFound) return notFound
        return { data: DIRECTORY_CONFLICTS[m[1]!] ?? [] }
      },
    ],
    [
      /^\/console\/identity\/directories\/([^/]+)\/conflicts\/([^/]+)\/retry$/,
      (m) => (findDir(m[1]!) === notFound ? notFound : { ok: true }),
    ],
    [
      /^\/console\/identity\/directories\/([^/]+)\/groups$/,
      (m) => {
        if (findDir(m[1]!) === notFound) return notFound
        return { data: DIRECTORY_GROUPS[m[1]!] ?? [] }
      },
    ],
    [
      /^\/console\/identity\/directories\/([^/]+)\/groups\/([^/]+)\/mail$/,
      (m) => (findDir(m[1]!) === notFound ? notFound : { ok: true }),
    ],
    [/^\/console\/identity\/mailboxes$/, () => MAILBOXES],
    [
      /^\/console\/identity\/mailboxes\/([^/]+)\/next$/,
      (_m, _query, _method, body) => {
        const choice = (body ?? {}) as { next?: string }
        return { ok: true, next: choice.next ?? "keep" }
      },
    ],
    [
      /^\/console\/identity\/mail\/leavers$/,
      (_m, _query, _method, body) => {
        const b = (body ?? {}) as Partial<LeaverDefault>
        return {
          action: b.action ?? "delete_after",
          days: b.days ?? 30,
        }
      },
    ],
    [
      /^\/console\/identity\/session-policy$/,
      (_m, _query, method, body) => {
        if (method === "PUT") {
          const input = (body ?? {}) as Partial<SessionPolicy>
          return {
            maxSessionSeconds: input.maxSessionSeconds ?? 86400,
            idleTimeoutSeconds: input.idleTimeoutSeconds ?? 7200,
          }
        }
        const answer: SessionPolicy = {
          maxSessionSeconds: 86400,
          idleTimeoutSeconds: 7200,
          bounds: {
            maxSessionSeconds: { min: 900, max: 2592000 },
            idleTimeoutSeconds: { min: 300, max: 86400 },
          },
        }
        return answer
      },
    ],
    [
      /^\/console\/identity\/second-factor-policy$/,
      (_m, _query, method, body) => {
        if (method === "PUT") {
          const input = (body ?? {}) as { required?: boolean }
          return { required: input.required ?? true }
        }
        return { required: true }
      },
    ],
    [
      /^\/console\/identity\/ip-allowlist$/,
      (_m, _query, method, body) => {
        if (method === "PUT") {
          const input = (body ?? {}) as Partial<IpAllowlist>
          const saved: SavedIpAllowlist = {
            console: input.console ?? true,
            apiKeys: input.apiKeys ?? true,
            ranges: input.ranges ?? IP_ALLOWLIST.ranges,
            graceUntil: IP_ALLOWLIST.graceUntil,
          }
          return saved
        }
        return IP_ALLOWLIST
      },
    ],
    [
      /^\/console\/identity\/siem$/,
      (_m, _query, method, body) => {
        if (method === "DELETE") return { configured: false }
        if (method === "PUT") {
          const input = (body ?? {}) as Partial<SiemSettingsAnswer["settings"]>
          const updated: SiemSettingsAnswer = {
            configured: true,
            settings: {
              ...SIEM_SETTINGS.settings!,
              ...input,
            },
          }
          return updated
        }
        return SIEM_SETTINGS
      },
    ],
    [
      /^\/console\/identity\/siem\/test$/,
      () => {
        const result: SiemTestResult = { ok: true, key: "test-success-audit-key" }
        return result
      },
    ],
    [
      /^\/console\/identity\/deprovisioned\/api-keys$/,
      () => ({ data: DEPROVISIONED_PEOPLE }),
    ],
    [
      /^\/console\/identity\/deprovisioned\/([^/]+)\/api-keys\/([^/]+)\/rotate$/,
      (m) => {
        const rotated: RotatedDeprovisionedKey = {
          id: m[2]!,
          name: "Rotated API Key",
          prefix: "i10_live_rot",
          mode: "live",
          created_at: new Date().toISOString(),
          secret: "i10_live_rotated_secret_preview_key",
        }
        return rotated
      },
    ],
    [
      /^\/console\/identity\/deprovisioned\/([^/]+)\/api-keys\/([^/]+)\/revoke$/,
      (m) => ({ id: m[2]!, revoked: true }),
    ],
    [
      /^\/console\/identity\/events$/,
      (_m, query) => {
        const user = query?.user ? String(query.user).trim() : null
        const limit = query?.limit ? Number(query.limit) : 50
        const filtered = user
          ? IDENTITY_EVENTS.filter(
              (e) => e.actorUserId === user || e.subjectUserId === user,
            )
          : IDENTITY_EVENTS
        return { data: filtered.slice(0, limit) }
      },
    ],
  ]
}
