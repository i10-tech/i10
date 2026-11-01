/**
 * The shapes of the identity routes the SSO screens call (#340), read off
 * apps/api/src/routes/console/identity*.ts. Dates arrive as ISO strings.
 */

export type SsoProtocol = "oidc" | "saml" | "test"
export type SsoStatus = "draft" | "testing" | "active" | "disabled"
export type SsoEnforcement = "off" | "optional" | "required_domain" | "required_all"

export interface SsoDomain {
  joinDomainId: string
  name: string
  /** Verified, not lapsed, not displaced: what a sign-in may use. */
  live: boolean
}

export interface SsoConnection {
  id: string
  name: string
  protocol: SsoProtocol
  provider: string
  status: SsoStatus
  enforcement: SsoEnforcement
  jitEnabled: boolean
  mfaRequired: boolean
  maxSessionSeconds: number | null
  idleTimeoutSeconds: number | null
  attributeMapping: Record<string, string>
  domains: SsoDomain[]
  /** Sign-in health (#345); null when the API could not read it, absent on older answers. */
  health?: ConnectionHealth | null
}

/** `health` of a connection, as the API derives it from the audit log. */
export interface ConnectionHealth {
  lastSuccessAt: string | null
  failuresLastHour: number
  failuresLast24Hours: number
  failing: boolean
  reason: "failure_spike" | "no_success" | null
}

export interface OidcPresetInfo {
  id: string
  label: string
  issuerHint: string
  requires: string[]
  clientAuthMethods: string[]
}

export interface SamlPresetInfo {
  id: string
  label: string
  entityIdHint: string
  requires: string[]
}

export interface SsoConnections {
  data: SsoConnection[]
  protocols: SsoProtocol[]
  presets: { oidc: OidcPresetInfo[]; saml: SamlPresetInfo[] }
}

/** `GET .../oidc`: what to paste into the IdP, and what is set. Never a secret. */
export interface OidcSetup {
  provider: string
  label: string
  redirectUri: string
  jwksUrl: string
  issuerHint: string | null
  requires: string[]
  clientAuthMethods: string[]
  defaults: { scopes: string[] }
  issuer: string | null
  discoveryUrl: string | null
  clientId: string | null
  clientAuth: string | null
  scopes: string[] | null
  acrValues: string[]
  mfaAcrValues: string[]
  clientSecretSet: boolean
  keys: { kid: string; createdAt: string }[]
  ready: boolean
}

export interface SamlCertificate {
  id: string
  fingerprint: string
  subject: string
  notBefore: string
  notAfter: string
  source: string
}

/** `GET .../saml`. */
export interface SamlSetup {
  provider: string
  label: string
  entityId: string
  acsUrl: string
  sloUrl: string
  metadataUrl: string
  entityIdHint: string | null
  requires: string[]
  idpEntityId: string | null
  ssoUrl: string | null
  idpSloUrl: string | null
  idpMetadataUrl: string | null
  metadataFetchedAt: string | null
  metadataError: string | null
  nameIdFormat: string | null
  signRequests: boolean
  requireEncryption: boolean
  idpInitiated: boolean
  subjectAttribute: string | null
  mfaContextClasses: string[]
  spCertificates: {
    fingerprint: string
    certificate: string
    notAfter: string
    createdAt: string
  }[]
  certificates: SamlCertificate[]
  ready: boolean
}

export interface TestRun {
  id: string
  connectionId: string
  outcome: "passed" | "failed"
  reason: string | null
  claims: Record<string, unknown>
  resolution: Record<string, unknown>
  createdAt: string
}

export interface GroupRule {
  id: string
  group: string
  role: "member" | "admin"
  precedence: number
}

export interface GroupRules {
  data: GroupRule[]
  defaultRole: "member"
  max: number
}

export interface BypassEntry {
  userId: string
  reason: string
  addedBy: string | null
  createdAt: string
}

export interface OwnerExemption {
  enabled: boolean
  pending: { requestedBy: string; requestedAt: string; expiresAt: string } | null
}

export interface SetupLink {
  id: string
  connectionId: string
  contactEmail: string | null
  createdBy: string | null
  createdAt: string
  expiresAt: string
  usedAt: string | null
  revokedAt: string | null
  revokedReason: string | null
  live: boolean
}

export type CreatedSetupLink = SetupLink & { token: string }

export interface DirectoryToken {
  id: string
  hint: string
  createdBy: string | null
  createdAt: string
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
}

export interface GoogleSetup {
  available: boolean
  unavailableReason: string | null
  clientEmail: string | null
  clientId: string | null
  scopes: readonly string[]
}

export interface SsoDirectory {
  id: string
  name: string
  provider: "okta" | "entra" | "google" | "generic"
  enabled: boolean
  /** Whether the directory gives each person it activates a mailbox (#344). */
  createMailboxes: boolean
  /** SCIM base URL; null for a Google directory. */
  baseUrl: string | null
  adminEmail?: string | null
  domain?: string | null
  lastSyncAt?: string | null
  lastSyncStatus?: string | null
  lastSyncError?: string | null
  google?: GoogleSetup
  createdAt: string
  tokens: DirectoryToken[]
  users: number
  conflicts: number
  pending: number
}

export interface SsoDirectories {
  data: SsoDirectory[]
  max: number
  providers: string[]
  google: GoogleSetup
}

/** A group of a directory, as the group-mail picker lists it (#344). */
export interface DirectoryGroup {
  id: string
  displayName: string
  memberCount: number
}

export interface DirectoryConflict {
  id: string
  userName: string
  displayName: string | null
  email: string | null
  active: boolean
  deleted: boolean
  conflict: string | null
  since: string | null
}

export interface LdapSetup {
  host: string | null
  port: number | null
  tlsMode: "ldaps" | "starttls" | null
  caPem: string | null
  searchBase: string | null
  userFilter: string | null
  enabled: boolean
  serviceSet: boolean
  tested: boolean
  testedAt: string | null
  testValidSeconds: number
  ports: number[]
  tlsModes: string[]
  filterPlaceholder: string
  results: string[]
}

export interface LdapTestOutcome {
  result:
    | "ok"
    | "unreachable"
    | "tls_failed"
    | "service_bind_failed"
    | "user_not_found"
    | "user_bind_failed"
  recorded: boolean
}

/** What a viewer may do, from `/console/team/roles`. */
export interface SsoAbilities {
  /** `sso:manage`: an admin. */
  manage: boolean
  /** `owners:manage`: an owner. */
  owner: boolean
  userId: string | null
}

// ── Directory mail (#344) ───────────────────────────────────────────────────

export type MailboxNext = "keep" | "forward_manager" | "delegate" | "delete"
export type LeaverAction = "keep" | "forward_manager" | "delete_after"

export interface MailboxRow {
  userId: string
  address: string
  state: "active" | "suspended"
  suspendedAt: string | null
  next: MailboxNext
  targetUserId: string | null
  deleteAfterDays: number | null
  deleteAt: string | null
}

/** The workspace default for a person a directory switches off. */
export interface LeaverDefault {
  action: LeaverAction
  days: number | null
}

/** `GET /identity/mailboxes`. */
export interface Mailboxes {
  data: MailboxRow[]
  leavers: LeaverDefault
  limits: { minDays: number; maxDays: number }
}

/** A choice for a suspended mailbox, as `PUT .../next` takes it. */
export type NextChoice =
  | { next: "keep" }
  | { next: "forward_manager" }
  | { next: "delegate"; delegateUserId: string }
  | { next: "delete"; days: number }

// ── Session, second factor and network policy (#345) ────────────────────────

export interface Bounds {
  min: number
  max: number
}

export interface SessionPolicy {
  maxSessionSeconds: number | null
  idleTimeoutSeconds: number | null
  bounds: { maxSessionSeconds: Bounds; idleTimeoutSeconds: Bounds }
}

export interface IpAllowlist {
  console: boolean
  apiKeys: boolean
  ranges: string[]
  maxRanges: number
  /** The address this request came from, or null when it could not be told. */
  yourAddress: string | null
  yourAddressListed: boolean
  /** When the saver's own grace ends (ISO), or null. */
  graceUntil: string | null
}

/** What `PUT /identity/ip-allowlist` answers (a subset of the GET). */
export interface SavedIpAllowlist {
  console: boolean
  apiKeys: boolean
  ranges: string[]
  graceUntil: string | null
}

// ── The identity audit log ──────────────────────────────────────────────────

export interface IdentityEvent {
  id: string
  type: string
  actorUserId: string | null
  subjectUserId: string | null
  connectionId: string | null
  sessionId: string | null
  reason: string | null
  data: Record<string, unknown>
  createdAt: string
}

// ── SIEM export and deprovisioned people's keys (#345) ──────────────────────

/** `GET /identity/siem`'s settings. The key is only a hint (`••••abcd`). */
export interface SiemView {
  endpoint: string
  bucket: string
  region: string
  prefix: string
  accessKeyId: string
  secretAccessKey: string
  enabled: boolean
  lastExportAt: string | null
  lastError: string | null
  lastErrorAt: string | null
}

export interface SiemSettingsAnswer {
  configured: boolean
  settings: SiemView | null
}

export type SiemTestResult = { ok: true; key: string } | { ok: false; error: string }

/** A live API key a deprovisioned person created. */
export interface DeprovisionedKey {
  id: string
  name: string
  prefix: string
  mode: string
  created_at: string
  last_used_at: string | null
  expires_at: string | null
}

/** A removed person with the live keys they created. */
export interface DeprovisionedPerson {
  user_id: string
  deprovisioned_at: string
  keys: DeprovisionedKey[]
}

/** What rotating one answers; `secret` is shown once. */
export interface RotatedDeprovisionedKey {
  id: string
  name: string
  prefix: string
  mode: string
  created_at: string
  secret: string
}
