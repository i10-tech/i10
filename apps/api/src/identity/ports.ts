import type { JoinRole } from "../console/roles.js"
import type {
  AttemptPurpose,
  BoundSession,
  Connection,
  ConnectionStatus,
  DeprovisionMode,
  Enforcement,
  ManagedReason,
  Protocol,
  SessionPolicy,
} from "./model.js"

/**
 * What the identity core needs from the world: our database (`IdentityStore`,
 * identity/store.ts) and Clerk's backend API (`ClerkIdentity`,
 * identity/clerk.ts). The bridge, the gate and the managed-account rules see
 * only these, so the tests run them with fakes and the database half has its
 * own test against Postgres (test/identity-db.test.ts).
 */

export interface AttemptRow {
  id: string
  tenantId: string
  connectionId: string
  purpose: AttemptPurpose
  bindingHash: string
  stepUpSessionId: string | null
  /** For `sign_in`: the address typed on our sign-in page, lowercased. */
  loginHint: string | null
  returnTo: string | null
  nonce: string | null
  /** Opened from its seal. */
  pkceVerifier: string | null
  requestId: string | null
  expiresAt: Date
  consumedAt: Date | null
  outcome: string | null
  clerkUserId: string | null
  identityId: string | null
  clerkOrgId: string | null
  idpSession: string | null
  authTime: Date | null
  handoffExpiresAt: Date | null
  redeemedAt: Date | null
  signInTokenId: string | null
  tokenMintedAt: Date | null
  boundAt: Date | null
}

export interface NewAttempt {
  tenantId: string
  connectionId: string
  purpose: AttemptPurpose
  stateHash: string
  bindingHash: string
  nonce?: string | null
  pkceVerifier?: string | null
  requestId?: string | null
  returnTo?: string | null
  stepUpSessionId?: string | null
  loginHint?: string | null
  expiresAt: Date
}

export interface AttemptFinish {
  outcome: "signed_in" | "refused" | "tested" | "stepped_up"
  failureReason?: string | null
  clerkUserId?: string | null
  identityId?: string | null
  clerkOrgId?: string | null
  idpSession?: string | null
  authTime?: Date | null
  handoffCodeHash?: string | null
  handoffExpiresAt?: Date | null
}

export interface ManagedRow {
  clerkUserId: string
  tenantId: string
  connectionId: string | null
  reason: ManagedReason
  emails: string[]
}

export interface ConnectionPatch {
  name?: string
  status?: ConnectionStatus
  enforcement?: Enforcement
  jitEnabled?: boolean
  mfaRequired?: boolean
  maxSessionSeconds?: number | null
  idleTimeoutSeconds?: number | null
  config?: Record<string, unknown>
  attributeMapping?: Record<string, string>
}

export interface ConnectionDomain {
  joinDomainId: string
  name: string
  /** Verified, not lapsed, not displaced: what a sign-in may use. */
  live: boolean
}

/**
 * What the gate reads for one request, in one transaction.
 *
 * ⚠ `managed: null` IS THE COMMON ANSWER, and the one the gate caches.
 */
export type GateRead =
  | { managed: null }
  | {
      managed: {
        tenantId: string
        /**
         * The live connection to send this person through now: one covering
         * a live proof of their address's domain (the one they were claimed
         * through first, while it qualifies); for an owner or admin, only one
         * they are linked on (#338). Null when none does.
         */
        connectionId: string | null
      }
      session:
        | (BoundSession & {
            tenantId: string
            connectionStatus: ConnectionStatus
            /** The connection still covers a live domain proof. */
            domainLive: boolean
            maxSessionSeconds: number | null
            idleTimeoutSeconds: number | null
          })
        | null
    }

/** A group-to-role rule (#341): `groupValue` in the IdP's groups gives `role`. */
export interface GroupRoleRule {
  id: string
  connectionId: string
  groupValue: string
  role: JoinRole
  precedence: number
}

/**
 * What a JIT creation may do while it holds its lock (#341): read and write
 * the identity link in the lock's own transaction.
 */
export interface ProvisionLock {
  identityBySubject(
    subject: string,
  ): Promise<{ id: string; clerkUserId: string } | null>
  link(input: {
    subject: string
    clerkUserId: string
    email: string
  }): Promise<{ id: string }>
}

/** One row of the identity audit log. Nothing secret, ever. */
export interface AuditEvent {
  type: string
  actorUserId?: string | null
  subjectUserId?: string | null
  connectionId?: string | null
  sessionId?: string | null
  reason?: string | null
  data?: Record<string, unknown>
}

export interface StoredEvent extends Required<Omit<AuditEvent, "data">> {
  id: string
  data: Record<string, unknown>
  createdAt: Date
}

export interface IdentityStore {
  // ── connections ──
  connection(tenantId: string, id: string): Promise<Connection | null>
  /** The one row a start URL names, with no workspace in scope. */
  connectionForStart(id: string): Promise<Connection | null>
  connections(
    tenantId: string,
  ): Promise<(Connection & { domains: ConnectionDomain[] })[]>
  createConnection(
    tenantId: string,
    input: { name: string; protocol: Protocol; provider: string; createdBy: string },
  ): Promise<Connection>
  updateConnection(
    tenantId: string,
    id: string,
    patch: ConnectionPatch,
  ): Promise<Connection | null>
  /** `not_found`: no such verified proof in this workspace; `taken`: another connection has it. */
  addDomain(
    tenantId: string,
    connectionId: string,
    joinDomainId: string,
  ): Promise<"added" | "not_found" | "taken">
  removeDomain(
    tenantId: string,
    connectionId: string,
    joinDomainId: string,
  ): Promise<boolean>
  /** Names whose proof is live right now. */
  liveDomains(tenantId: string, connectionId: string): Promise<string[]>
  /**
   * The connection's sealed `secrets`, opened: a JSON object the engine
   * defines (#338: the OIDC client secret, the private_key_jwt keys). `{}` when
   * none are set, null when there is no such connection.
   *
   * ⚠ THROWS WITHOUT `WEBHOOK_SECRET_KEY`: there is nothing to open them with,
   * and an empty answer would read as "no secret set".
   */
  connectionSecrets(
    tenantId: string,
    id: string,
  ): Promise<Record<string, unknown> | null>
  /**
   * Changes a connection's sealed `secrets` and its `config` together:
   * `edit` gets both as they are NOW, under a row lock, and returns both.
   *
   * ⚠ A READ-MODIFY-WRITE UNDER ONE LOCK. Setting a client secret and rotating
   * a key both edit the same sealed blob; read outside the lock, two at once
   * would each write the other's change away.
   */
  setConnectionSecrets(
    tenantId: string,
    id: string,
    edit: (current: {
      secrets: Record<string, unknown>
      config: Record<string, unknown>
    }) => { secrets: Record<string, unknown>; config: Record<string, unknown> },
  ): Promise<Connection | null>
  /** The workspace's Clerk organization, or null once the workspace is gone. */
  workspaceOrg(tenantId: string): Promise<string | null>
  /** The workspace's name, for what a person is told ("Acme is full right now"). */
  workspaceName(tenantId: string): Promise<string | null>
  /**
   * Names covered by an ACTIVE connection of this workspace whose proof is
   * live: the domains whose people the IdP admits, and #326's access rules
   * no longer do (#341).
   */
  coveredDomains(tenantId: string): Promise<string[]>

  // ── group-to-role rules (#341) ──
  /** The connection's rules, first by precedence, then oldest first. */
  groupRules(tenantId: string, connectionId: string): Promise<GroupRoleRule[]>
  /** `exists`: that group already has a rule; `not_found`: no such connection; `too_many`: at the limit. */
  createGroupRule(
    tenantId: string,
    input: {
      connectionId: string
      groupValue: string
      role: JoinRole
      precedence: number
      createdBy: string
    },
  ): Promise<GroupRoleRule | "exists" | "not_found" | "too_many">
  updateGroupRule(
    tenantId: string,
    connectionId: string,
    ruleId: string,
    patch: { groupValue?: string; role?: JoinRole; precedence?: number },
  ): Promise<GroupRoleRule | "exists" | null>
  deleteGroupRule(
    tenantId: string,
    connectionId: string,
    ruleId: string,
  ): Promise<GroupRoleRule | null>

  /**
   * Runs `fn` holding the JIT lock for one address, on every connection (#341):
   * a second first sign-in for the same person waits here, then finds the
   * first one's link.
   *
   * ⚠ `fn` MAY CALL CLERK WHILE THE LOCK'S TRANSACTION IS OPEN. Nothing is
   * written in it but the identity link (`lock.link`, same transaction, so the
   * pool is never asked for a second connection); the lock goes with the
   * commit.
   */
  provisionLocked<T>(
    tenantId: string,
    key: { connectionId: string; email: string },
    fn: (lock: ProvisionLock) => Promise<T>,
  ): Promise<T>

  // ── attempts ──
  createAttempt(input: NewAttempt): Promise<{ id: string }>
  attemptByState(stateHash: string): Promise<AttemptRow | null>
  /** Compare-and-set on `consumed_at`: true for the one caller that got it. */
  consumeAttempt(tenantId: string, id: string, at: Date): Promise<boolean>
  finishAttempt(tenantId: string, id: string, finish: AttemptFinish): Promise<void>
  attemptByHandoffCode(codeHash: string): Promise<AttemptRow | null>
  /** Compare-and-set on `redeemed_at`. */
  claimRedeem(tenantId: string, id: string, at: Date): Promise<boolean>
  recordToken(
    tenantId: string,
    id: string,
    token: { signInTokenId: string; mintedAt: Date; handoffSecretHash: string },
  ): Promise<void>
  attemptByHandoffSecret(secretHash: string): Promise<AttemptRow | null>
  /** Compare-and-set on `bound_at`. */
  markBound(tenantId: string, id: string, sessionId: string, at: Date): Promise<boolean>

  // ── identities ──
  identityBySubject(
    tenantId: string,
    connectionId: string,
    subject: string,
  ): Promise<{ id: string; clerkUserId: string } | null>
  identityByUser(
    tenantId: string,
    connectionId: string,
    clerkUserId: string,
  ): Promise<{ id: string; subject: string } | null>
  link(
    tenantId: string,
    input: {
      connectionId: string
      subject: string
      clerkUserId: string
      email: string | null
    },
  ): Promise<{ id: string }>
  touchIdentity(
    tenantId: string,
    id: string,
    email: string | null,
    at: Date,
  ): Promise<void>

  // ── managed accounts ──
  /** With no workspace in scope: the user's own row, wherever it is. */
  managedByUser(clerkUserId: string): Promise<ManagedRow | null>
  /** With no workspace in scope: whether this identifier is a managed account's. */
  managedByIdentifier(identifier: string): Promise<boolean>
  /** `elsewhere`: another workspace already controls this account. */
  claimManaged(
    tenantId: string,
    row: ManagedRow,
  ): Promise<"created" | "kept" | "elsewhere">
  /** The addresses it keeps and, when given, the connection it signs in through. */
  setManagedEmails(
    tenantId: string,
    clerkUserId: string,
    emails: string[],
    connectionId?: string,
  ): Promise<void>
  releaseManaged(tenantId: string, clerkUserId: string): Promise<boolean>
  /** A deleted Clerk user: their links and managed row in this workspace go. */
  forgetUser(tenantId: string, clerkUserId: string): Promise<void>

  // ── the gate and sessions ──
  gateRead(clerkUserId: string, sessionId: string): Promise<GateRead>
  bindSession(
    tenantId: string,
    row: {
      sessionId: string
      clerkUserId: string
      connectionId: string
      identityId: string | null
      idpSession: string | null
      authTime: Date | null
      at: Date
      freshAt: Date
    },
  ): Promise<void>
  touchSession(tenantId: string, sessionId: string, at: Date): Promise<void>
  /** True when this call revoked it; false when it was already revoked or absent. */
  revokeSessionRow(
    tenantId: string,
    sessionId: string,
    reason: string,
    at: Date,
  ): Promise<boolean>
  sessionRow(
    tenantId: string,
    sessionId: string,
  ): Promise<(BoundSession & { tenantId: string }) | null>
  /** Live (unrevoked) bound sessions of one person in one workspace. */
  sessionsOf(tenantId: string, clerkUserId: string): Promise<BoundSession[]>
  setFresh(tenantId: string, sessionId: string, at: Date): Promise<void>

  // ── the rest ──
  /** On the workspace's block list (#326). */
  isBlocked(tenantId: string, email: string): Promise<boolean>
  deprovisionMode(tenantId: string): Promise<DeprovisionMode>
  setDeprovisionMode(tenantId: string, mode: DeprovisionMode, by: string): Promise<void>
  recordTestRun(
    tenantId: string,
    row: {
      connectionId: string
      attemptId: string
      outcome: "passed" | "failed"
      reason: string | null
      claims: Record<string, unknown>
      resolution: Record<string, unknown>
    },
  ): Promise<{ id: string }>
  /** A connection's test runs, newest first (#340's screens). */
  testRuns(tenantId: string, connectionId: string, limit: number): Promise<TestRunRow[]>
  record(tenantId: string, event: AuditEvent): Promise<void>
  events(
    tenantId: string,
    options: { limit: number; subjectUserId?: string },
  ): Promise<StoredEvent[]>
}

/** One finished test run: the verified claims and what a real sign-in would have done. */
export interface TestRunRow {
  id: string
  connectionId: string
  outcome: "passed" | "failed"
  reason: string | null
  claims: Record<string, unknown>
  resolution: Record<string, unknown>
  createdAt: Date
}

/** One IdP signing certificate of a SAML connection (`identity.saml_certificates`). */
export interface SamlCertificateRow {
  id: string
  fingerprint: string
  /** The DER, base64. */
  certificate: string
  subject: string
  notBefore: Date
  notAfter: Date
  /** `upload` (an admin pasted it) or `metadata` (the metadata URL listed it). */
  source: "upload" | "metadata"
  /** The smallest expiry threshold (30, 7, 1 days) already alerted on, or null. */
  alertedDays: number | null
  createdAt: Date
}

/** At most this many IdP certificates per connection: a rotation, with room. */
export const SAML_CERTIFICATE_LIMIT = 5

/**
 * The SAML half of the identity store (#339): the certificate table, what SLO
 * needs to find sessions, and the cross-workspace list the daily refresh reads.
 */
export interface SamlStore {
  certificates(tenantId: string, connectionId: string): Promise<SamlCertificateRow[]>
  /** `limit`: the connection already has SAML_CERTIFICATE_LIMIT. */
  addCertificate(
    tenantId: string,
    connectionId: string,
    cert: Omit<SamlCertificateRow, "id" | "alertedDays" | "createdAt">,
    by: string | null,
  ): Promise<"added" | "exists" | "limit">
  removeCertificate(
    tenantId: string,
    connectionId: string,
    id: string,
  ): Promise<boolean>
  /**
   * Makes the `metadata` certificates exactly `certs`, leaving uploaded ones
   * alone, in one transaction. Returns the fingerprints added and removed.
   */
  replaceMetadataCertificates(
    tenantId: string,
    connectionId: string,
    certs: Omit<SamlCertificateRow, "id" | "alertedDays" | "createdAt" | "source">[],
  ): Promise<{ added: string[]; removed: string[] }>
  noteAlert(tenantId: string, certificateId: string, days: number): Promise<void>
  /** A bound session as SP-initiated logout needs it: its IdP session and subject. */
  boundSession(
    tenantId: string,
    sessionId: string,
  ): Promise<{
    clerkUserId: string
    connectionId: string
    idpSession: string | null
    subject: string | null
    revokedAt: Date | null
  } | null>
  /**
   * Live bound sessions an IdP LogoutRequest names on this connection: the
   * identity `subject`'s, narrowed to `sessionIndexes` when the IdP sent any;
   * with no subject, those `sessionIndexes` alone (never "all of them").
   */
  sessionsForLogout(
    tenantId: string,
    connectionId: string,
    match: { subject: string | null; sessionIndexes: readonly string[] },
  ): Promise<{ sessionId: string; clerkUserId: string }[]>
  /**
   * SAML connections the daily refresh should look at, across every
   * workspace, in id order after `after` (a SECURITY DEFINER function: ids
   * only, nothing else of any workspace's).
   */
  dueConnections(
    after: string | null,
    limit: number,
  ): Promise<{ id: string; tenantId: string }[]>
}

/**
 * Seen-once keys (SAML assertion ids, logout request ids), in Redis.
 *
 * ⚠ `claim` THROWS WHEN IT CANNOT TELL (Redis down). A replay cache that
 * answers "not seen" on an outage is no replay cache; the caller turns the
 * throw into a 503, never a sign-in.
 */
export interface ReplayCache {
  /** True for the first caller of `key` within `ttlMs`, false for any other. */
  claim(key: string, ttlMs: number): Promise<boolean>
  /**
   * Gives a claim back. Only for a caller whose work failed AFTER the claim
   * and is safe to repeat (a back-channel logout, #345), so the IdP's retry
   * is not refused as a replay of something that never happened.
   */
  release(key: string): Promise<void>
}

/** A Clerk user as the managed-account rules see it. */
export interface ClerkUserSnapshot {
  id: string
  banned: boolean
  firstName: string | null
  lastName: string | null
  primaryEmailId: string | null
  emails: { id: string; address: string; verified: boolean }[]
  passwordEnabled: boolean
  twoFactorEnabled: boolean
  totpEnabled: boolean
  backupCodeEnabled: boolean
  externalAccountIds: string[]
  passkeyIds: string[]
  /** Phone numbers: a sign-in identifier and an SMS second factor, both not the IdP. */
  phoneIds: string[]
  /** Web3 wallets: a sign-in method of their own. */
  web3WalletIds: string[]
  deleteSelfEnabled: boolean
}

export interface ClerkSessionSnapshot {
  id: string
  userId: string
  clientId: string
  status: string
  createdAt: Date
}

/**
 * Clerk's backend API, as much of it as identity needs.
 *
 * ⚠ EVERY METHOD THROWS WHEN CLERK CANNOT BE ASKED, and answers null or an
 * explicit outcome only for what Clerk actually said. The callers turn a throw
 * into a refusal or a 503; nothing here may turn an outage into "no".
 */
export interface ClerkIdentity {
  /**
   * `POST /sign_in_tokens` with `second_factor_verification: "fresh"` (P1),
   * `expires_in_seconds: 60` and `org_id`. A raw call: the SDK types know
   * neither the parameter nor its effect.
   */
  mintSignInToken(input: {
    userId: string
    orgId: string
  }): Promise<{ id: string; token: string }>
  /**
   * `revoked`: it was still pending (so it was NOT accepted). `not_revocable`:
   * Clerk refused with `sign_in_token_cannot_be_revoked_code`, which it says
   * for an accepted token (probed on dev 2026-10-20) and for one already
   * revoked. An EXPIRED token that was never used answers `revoked` (probed
   * on dev 2026-10-20, 65 s after a 60 s mint), so expiry never reads as
   * acceptance.
   */
  revokeSignInToken(id: string): Promise<"revoked" | "not_revocable">
  session(sessionId: string): Promise<ClerkSessionSnapshot | null>
  /** The client's `last_authentication_strategy` (P4), or null for no client. */
  lastStrategy(clientId: string): Promise<string | null>
  /** Ends a session. Already ended or gone is done. */
  revokeSession(sessionId: string): Promise<void>
  /** Every active session of a user, every page of them. */
  activeSessions(userId: string): Promise<{ id: string; createdAt: Date }[]>
  user(userId: string): Promise<ClerkUserSnapshot | null>
  /** Users holding this address, verified or not. */
  usersByEmail(email: string): Promise<ClerkUserSnapshot[]>
  /**
   * JIT (#341): a new user holding exactly this address, VERIFIED (Clerk
   * marks backend-created addresses verified), with no password
   * (`skip_password_requirement`). `exists` when Clerk refuses because the
   * address is already somebody's (`form_identifier_exists`): Clerk's own
   * uniqueness, the net under our lock. `incomplete` when the instance requires
   * something (first and last name, today) that was not given.
   */
  createUser(input: {
    email: string
    firstName: string | null
    lastName: string | null
  }): Promise<
    | { outcome: "created"; userId: string }
    | { outcome: "exists" }
    /** Clerk's `form_data_missing`: the instance requires a field the IdP did not send. */
    | { outcome: "incomplete" }
  >
  /** Profile sync at sign-in (#341): only the names given are changed. */
  updateProfile(
    userId: string,
    names: { firstName?: string; lastName?: string },
  ): Promise<void>
  removePassword(userId: string): Promise<void>
  deleteExternalAccount(userId: string, id: string): Promise<void>
  deletePasskey(userId: string, id: string): Promise<void>
  deletePhoneNumber(id: string): Promise<void>
  deleteWeb3Wallet(userId: string, id: string): Promise<void>
  disableMfa(userId: string): Promise<void>
  deleteBackupCodes(userId: string): Promise<void>
  deleteEmailAddress(id: string): Promise<void>
  /** `delete_self_enabled: false`. */
  forbidSelfDelete(userId: string): Promise<void>
  ban(userId: string): Promise<void>
}

export interface Logger {
  info: (o: object, m: string) => void
  warn: (o: object, m: string) => void
  error: (o: object, m: string) => void
}

// ── Enforcement, break-glass, setup links and discovery (#340) ─────────────

/** An active connection whose enforcement is a required mode, as the gate reads it. */
export interface RequiredConnection {
  id: string
  enforcement: Extract<Enforcement, "required_domain" | "required_all">
  createdAt: Date
  /** Names whose proof is live right now. */
  domains: string[]
  /** The signed-in person is on this connection's bypass list. */
  bypassed: boolean
}

/**
 * What the enforcement gate reads for one person, session and workspace, in
 * one transaction.
 *
 * ⚠ `required: false` IS THE COMMON ANSWER (no active connection in the
 * workspace requires SSO), read with one query and cached per workspace.
 */
export type EnforcementRead =
  | { required: false }
  | {
      required: true
      connections: RequiredConnection[]
      /** The workspace's owner exemption (decision 7), on unless two owners turned it off. */
      exemption: boolean
      /** An owner or an admin in our roles table. */
      privileged: boolean
      /** A managed account, in any workspace. */
      managed: boolean
      /**
       * This session as the bridge bound it IN THIS WORKSPACE, on a connection
       * that is active and covers a live proof, or null.
       */
      session:
        | (Pick<BoundSession, "boundAt" | "lastSeenAt" | "revokedAt"> & SessionPolicy)
        | null
    }

export interface BypassEntry {
  clerkUserId: string
  reason: string | null
  addedBy: string | null
  createdAt: Date
}

export interface OwnerExemption {
  enabled: boolean
  /** A first owner's request to turn it off, while it can still be approved. */
  pending: { requestedBy: string; requestedAt: Date; expiresAt: Date } | null
}

export interface SetupLinkRow {
  id: string
  tenantId: string
  connectionId: string
  contactEmail: string | null
  createdBy: string | null
  expiresAt: Date
  usedAt: Date | null
  revokedAt: Date | null
  revokedReason: string | null
  createdAt: Date
}

/** An active connection covering a live proof of an address's domain (discovery). */
export interface DiscoveredConnection {
  id: string
  tenantId: string
  name: string
  enforcement: Enforcement
  createdAt: Date
}

/** The database half of #340: see identity/policy-store.ts for the policies. */
export interface SsoPolicyStore {
  enforcementRead(
    tenantId: string,
    clerkUserId: string,
    sessionId: string,
  ): Promise<EnforcementRead>
  /**
   * Notes a bypass sign-in and audits `sso.bypass_used`, in one transaction.
   * True only for the call that saw this session first in this workspace.
   */
  noteBypassSignIn(
    tenantId: string,
    row: { sessionId: string; clerkUserId: string; connectionIds: string[] },
  ): Promise<boolean>

  bypassList(tenantId: string, connectionId: string): Promise<BypassEntry[]>
  /** `exists`: already listed; `not_found`: no such connection in this workspace. */
  addBypass(
    tenantId: string,
    connectionId: string,
    entry: { clerkUserId: string; reason: string; addedBy: string },
  ): Promise<"added" | "exists" | "not_found">
  removeBypass(
    tenantId: string,
    connectionId: string,
    clerkUserId: string,
  ): Promise<BypassEntry | null>

  ownerExemption(tenantId: string, now: Date): Promise<OwnerExemption>
  /** `off`: already off; `pending`: a live request already waits (anybody's). */
  requestExemptionOff(
    tenantId: string,
    by: string,
    now: Date,
  ): Promise<"requested" | "off" | "pending">
  /**
   * Applies a live request made by a DIFFERENT owner who is still an owner,
   * in one transaction under the settings row's lock. `none`: no live request
   * (or its maker is no longer an owner); `same_owner`: the approver made it.
   */
  approveExemptionOff(
    tenantId: string,
    by: string,
    now: Date,
  ): Promise<
    | { outcome: "applied"; requestedBy: string }
    | { outcome: "none" }
    | { outcome: "same_owner" }
  >
  cancelExemptionOff(tenantId: string): Promise<boolean>
  /** True when it was off (or a request was pending) and is now on with none. */
  enableExemption(tenantId: string, by: string): Promise<boolean>

  /** A test run with outcome `passed` on this connection at or after `since`. */
  passedTestRunSince(
    tenantId: string,
    connectionId: string,
    since: Date,
  ): Promise<boolean>

  /** Active connections covering a live proof of exactly this name, any workspace. */
  discover(domain: string): Promise<DiscoveredConnection[]>

  createSetupLink(
    tenantId: string,
    input: {
      connectionId: string
      tokenHash: string
      contactEmail: string | null
      createdBy: string
      expiresAt: Date
    },
  ): Promise<SetupLinkRow>
  setupLinks(tenantId: string, connectionId: string): Promise<SetupLinkRow[]>
  revokeSetupLink(
    tenantId: string,
    connectionId: string,
    id: string,
    reason: string,
    at: Date,
  ): Promise<SetupLinkRow | null>
  /** Every live link of the connection, revoked; the ids revoked. */
  revokeSetupLinksOf(
    tenantId: string,
    connectionId: string,
    reason: string,
    at: Date,
  ): Promise<string[]>
  /** With no workspace in scope: the one row this token hash names. */
  setupLinkByHash(
    tokenHash: string,
  ): Promise<(SetupLinkRow & { tokenHash: string }) | null>
  /** Compare-and-set on `used_at`: true for the first use. */
  markSetupLinkUsed(tenantId: string, id: string, at: Date): Promise<boolean>
}

// ── Workspace session, second-factor and network policy (#345) ───────────

/** The IP allowlist's saved state. Ranges are canonical CIDR text (identity/network.ts). */
export interface NetworkPolicy {
  /** Console sessions are held to `ranges`. */
  console: boolean
  /** API keys are held to `ranges`. */
  apiKeys: boolean
  ranges: string[]
  /**
   * The owner who saved a console list without their own address, and that
   * address: allowed for them alone until `until`.
   */
  grace: { userId: string; address: string; until: Date } | null
}

export interface WorkspacePolicy {
  maxSessionSeconds: number | null
  idleTimeoutSeconds: number | null
  requireSecondFactor: boolean
  network: NetworkPolicy
}

/** The change a policy write makes. Each kind is one audited event. */
export type WorkspacePolicyChange =
  | {
      kind: "session"
      maxSessionSeconds: number | null
      idleTimeoutSeconds: number | null
    }
  | { kind: "second_factor"; required: boolean }
  | {
      kind: "network"
      console: boolean
      apiKeys: boolean
      ranges: string[]
      grace: { userId: string; address: string; until: Date } | null
      /** The saving owner confirmed a list that excludes their address. */
      lockoutConfirmed: boolean
    }

/**
 * A session's age as the workspace policy measures it: a bound session from
 * its bind (and its connection's own limits, `connection*`), any other from
 * the activity row.
 */
export interface SessionFacts {
  bound: {
    boundAt: Date
    lastSeenAt: Date
    connectionMaxSessionSeconds: number | null
    connectionIdleTimeoutSeconds: number | null
  } | null
  activity: { startedAt: Date; lastSeenAt: Date } | null
}

/**
 * The workspace policy store (#345): the saved policy, the activity of
 * sessions no SSO bind tracks, and the audited writes.
 *
 * ⚠ A WRITE AND ITS AUDIT ROW ARE ONE TRANSACTION, under the settings row's
 * lock: a policy that changed has a row saying who changed it, from what.
 */
export interface WorkspacePolicyStore {
  /** The saved policy; the defaults (nothing set) for a workspace with no row. */
  policy(tenantId: string): Promise<WorkspacePolicy>
  /** Applies `change` and audits it as `actorUserId`. Returns both states. */
  update(
    tenantId: string,
    actorUserId: string,
    change: WorkspacePolicyChange,
  ): Promise<{ before: WorkspacePolicy; after: WorkspacePolicy }>
  /**
   * The session's bind (any status of it) and, unless it is bound, its
   * activity row. `revoked` for a row that was ended: it never comes back.
   */
  sessionFacts(
    tenantId: string,
    sessionId: string,
  ): Promise<SessionFacts & { revoked: boolean }>
  /** First sight of an unbound session. Idempotent; returns the row as it is. */
  startActivity(
    tenantId: string,
    row: { sessionId: string; clerkUserId: string; startedAt: Date; now: Date },
  ): Promise<{ startedAt: Date; lastSeenAt: Date; revoked: boolean }>
  touchActivity(tenantId: string, sessionId: string, at: Date): Promise<void>
  /** True only for the call that ended it. */
  revokeActivity(
    tenantId: string,
    sessionId: string,
    reason: string,
    at: Date,
  ): Promise<boolean>
}
