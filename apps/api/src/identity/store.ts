import { and, arrayContains, desc, eq, isNull, sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { joinDomains, joinExclusions, tenants, workspaceRoles } from "../db/core.js"
import {
  connectionDomains,
  connections,
  events,
  groupRoleRules,
  identities,
  loginAttempts,
  managedAccounts,
  ssoSessions,
  testRuns,
  workspaceSettings,
} from "../db/identity.js"
import { NO_TENANT } from "../middleware/tenant.js"
import type { SecretBox } from "../webhooks/signing.js"
import type {
  AttemptPurpose,
  BoundSession,
  Connection,
  ConnectionStatus,
  DeprovisionMode,
  Enforcement,
  ManagedReason,
  Protocol,
} from "./model.js"
import { readJoinRole } from "../console/roles.js"
import { MAX_GROUP_RULES } from "./jit.js"
import type { AttemptRow, GroupRoleRule, IdentityStore, ManagedRow } from "./ports.js"
import { mirrorManaged, unmirrorManaged } from "./authd-mirror.js"

const toRule = (r: typeof groupRoleRules.$inferSelect): GroupRoleRule => ({
  id: r.id,
  connectionId: r.connectionId,
  groupValue: r.groupValue,
  // ⚠ READ AS A JOINING ROLE: never owner, whatever a row could say.
  role: readJoinRole(r.role),
  precedence: r.precedence,
})

/** A unique violation: Postgres's 23505, wherever the driver put it. */
const isUniqueViolation = (error: unknown): boolean => {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null
  return e?.code === "23505" || e?.cause?.code === "23505"
}

/**
 * The database half of the identity core. See db/identity.ts for the
 * policies each read relies on.
 *
 * ⚠ AN OUTSIDER READ STILL SETS `app.tenant_id`, TO THE NIL TENANT. Every
 * table's workspace policy reads `current_setting('app.tenant_id')` without
 * `missing_ok`, and Postgres may evaluate it beside the outsider policy; on a
 * connection that never set it, that raises instead of answering. The nil
 * uuid matches no workspace, so only the outsider policy can admit a row.
 */

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

type OutsiderSetting =
  | "app.user_id"
  | "app.identifier"
  | "app.connection_id"
  | "app.attempt_state"
  | "app.handoff_code"
  | "app.handoff_secret"

async function asOutsider<T>(
  db: Database,
  setting: OutsiderSetting,
  value: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withTenant(db, NO_TENANT, async (tx) => {
    await tx.execute(sql`select set_config(${setting}, ${value}, true)`)
    return fn(tx)
  })
}

const toConnection = (r: typeof connections.$inferSelect): Connection => ({
  id: r.id,
  tenantId: r.tenantId,
  name: r.name,
  protocol: r.protocol as Protocol,
  provider: r.provider,
  status: r.status as ConnectionStatus,
  enforcement: r.enforcement as Enforcement,
  jitEnabled: r.jitEnabled,
  mfaRequired: r.mfaRequired,
  maxSessionSeconds: r.maxSessionSeconds,
  idleTimeoutSeconds: r.idleTimeoutSeconds,
  config: r.config,
  attributeMapping: r.attributeMapping,
})

const toSession = (
  r: typeof ssoSessions.$inferSelect,
): BoundSession & { tenantId: string } => ({
  sessionId: r.sessionId,
  tenantId: r.tenantId,
  clerkUserId: r.clerkUserId,
  connectionId: r.connectionId,
  boundAt: r.boundAt,
  freshAt: r.freshAt,
  lastSeenAt: r.lastSeenAt,
  revokedAt: r.revokedAt,
})

const toManaged = (r: typeof managedAccounts.$inferSelect): ManagedRow => ({
  clerkUserId: r.clerkUserId,
  tenantId: r.tenantId,
  connectionId: r.connectionId,
  reason: r.reason as ManagedReason,
  emails: r.emails,
})

/** A proof a sign-in may use: verified, not lapsed, not displaced. */
const liveProof = sql`${joinDomains.verifiedAt} is not null and ${joinDomains.lapsedAt} is null and ${joinDomains.displacedAt} is null`

export function identityStore(db: Database, secrets: SecretBox | null): IdentityStore {
  const toAttempt = (r: typeof loginAttempts.$inferSelect): AttemptRow => ({
    id: r.id,
    tenantId: r.tenantId,
    connectionId: r.connectionId,
    purpose: r.purpose as AttemptPurpose,
    bindingHash: r.bindingHash,
    stepUpSessionId: r.stepUpSessionId,
    loginHint: r.loginHint,
    returnTo: r.returnTo,
    nonce: r.nonce,
    pkceVerifier: r.pkceVerifier && secrets ? secrets.open(r.pkceVerifier) : null,
    requestId: r.requestId,
    expiresAt: r.expiresAt,
    consumedAt: r.consumedAt,
    outcome: r.outcome,
    clerkUserId: r.clerkUserId,
    identityId: r.identityId,
    clerkOrgId: r.clerkOrgId,
    idpSession: r.idpSession,
    authTime: r.authTime,
    handoffExpiresAt: r.handoffExpiresAt,
    redeemedAt: r.redeemedAt,
    signInTokenId: r.signInTokenId,
    tokenMintedAt: r.tokenMintedAt,
    boundAt: r.boundAt,
  })

  async function managedByUser(clerkUserId: string): Promise<ManagedRow | null> {
    const [row] = await asOutsider(db, "app.user_id", clerkUserId, (tx) =>
      tx
        .select()
        .from(managedAccounts)
        .where(eq(managedAccounts.clerkUserId, clerkUserId))
        .limit(1),
    )
    return row ? toManaged(row) : null
  }

  return {
    // ── connections ──
    async connection(tenantId, id) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(connections)
          .where(and(eq(connections.tenantId, tenantId), eq(connections.id, id)))
          .limit(1),
      )
      return row ? toConnection(row) : null
    },

    async connectionForStart(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null
      const [row] = await asOutsider(db, "app.connection_id", id, (tx) =>
        tx.select().from(connections).where(eq(connections.id, id)).limit(1),
      )
      return row ? toConnection(row) : null
    },

    async connections(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(connections)
          .where(eq(connections.tenantId, tenantId))
          .orderBy(connections.createdAt)
        const domains = await tx
          .select({
            connectionId: connectionDomains.connectionId,
            joinDomainId: connectionDomains.joinDomainId,
            name: joinDomains.name,
            live: sql<boolean>`(${liveProof})`,
          })
          .from(connectionDomains)
          .innerJoin(joinDomains, eq(joinDomains.id, connectionDomains.joinDomainId))
          .where(eq(connectionDomains.tenantId, tenantId))
        return rows.map((r) => ({
          ...toConnection(r),
          domains: domains
            .filter((d) => d.connectionId === r.id)
            .map((d) => ({
              joinDomainId: d.joinDomainId,
              name: d.name,
              live: Boolean(d.live),
            })),
        }))
      })
    },

    async createConnection(tenantId, input) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .insert(connections)
          .values({
            tenantId,
            name: input.name,
            protocol: input.protocol,
            provider: input.provider,
            createdBy: input.createdBy,
          })
          .returning(),
      )
      return toConnection(row!)
    },

    async updateConnection(tenantId, id, patch) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .update(connections)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(eq(connections.tenantId, tenantId), eq(connections.id, id)))
          .returning(),
      )
      return row ? toConnection(row) : null
    },

    async addDomain(tenantId, connectionId, joinDomainId) {
      return withTenant(db, tenantId, async (tx) => {
        const [proof] = await tx
          .select({ id: joinDomains.id })
          .from(joinDomains)
          .where(
            and(
              eq(joinDomains.tenantId, tenantId),
              eq(joinDomains.id, joinDomainId),
              sql`${liveProof}`,
            ),
          )
          .limit(1)
        const [connection] = await tx
          .select({ id: connections.id })
          .from(connections)
          .where(
            and(eq(connections.tenantId, tenantId), eq(connections.id, connectionId)),
          )
          .limit(1)
        if (!proof || !connection) return "not_found" as const
        const made = await tx
          .insert(connectionDomains)
          .values({ tenantId, connectionId, joinDomainId })
          .onConflictDoNothing()
          .returning({ id: connectionDomains.joinDomainId })
        if (made.length > 0) return "added" as const
        const [held] = await tx
          .select({ connectionId: connectionDomains.connectionId })
          .from(connectionDomains)
          .where(eq(connectionDomains.joinDomainId, joinDomainId))
          .limit(1)
        return held?.connectionId === connectionId
          ? ("added" as const)
          : ("taken" as const)
      })
    },

    async removeDomain(tenantId, connectionId, joinDomainId) {
      const gone = await withTenant(db, tenantId, (tx) =>
        tx
          .delete(connectionDomains)
          .where(
            and(
              eq(connectionDomains.tenantId, tenantId),
              eq(connectionDomains.connectionId, connectionId),
              eq(connectionDomains.joinDomainId, joinDomainId),
            ),
          )
          .returning({ id: connectionDomains.joinDomainId }),
      )
      return gone.length > 0
    },

    async liveDomains(tenantId, connectionId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ name: joinDomains.name })
          .from(connectionDomains)
          .innerJoin(joinDomains, eq(joinDomains.id, connectionDomains.joinDomainId))
          .where(
            and(
              eq(connectionDomains.tenantId, tenantId),
              eq(connectionDomains.connectionId, connectionId),
              eq(joinDomains.tenantId, tenantId),
              sql`${liveProof}`,
            ),
          ),
      )
      return rows.map((r) => r.name)
    },

    async connectionSecrets(tenantId, id) {
      if (!secrets) throw new Error("connection secrets need WEBHOOK_SECRET_KEY")
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ sealed: connections.secrets })
          .from(connections)
          .where(and(eq(connections.tenantId, tenantId), eq(connections.id, id)))
          .limit(1),
      )
      if (!row) return null
      if (!row.sealed) return {}
      const opened: unknown = JSON.parse(secrets.open(row.sealed))
      return opened && typeof opened === "object" && !Array.isArray(opened)
        ? (opened as Record<string, unknown>)
        : {}
    },

    async setConnectionSecrets(tenantId, id, edit) {
      const box = secrets
      if (!box) throw new Error("connection secrets need WEBHOOK_SECRET_KEY")
      return withTenant(db, tenantId, async (tx) => {
        const [current] = await tx
          .select({ sealed: connections.secrets, config: connections.config })
          .from(connections)
          .where(and(eq(connections.tenantId, tenantId), eq(connections.id, id)))
          .for("update")
          .limit(1)
        if (!current) return null
        const opened: unknown = current.sealed
          ? JSON.parse(box.open(current.sealed))
          : {}
        const next = edit({
          secrets:
            opened && typeof opened === "object" && !Array.isArray(opened)
              ? (opened as Record<string, unknown>)
              : {},
          config: current.config,
        })
        const [row] = await tx
          .update(connections)
          .set({
            secrets: box.seal(JSON.stringify(next.secrets)),
            config: next.config,
            updatedAt: new Date(),
          })
          .where(and(eq(connections.tenantId, tenantId), eq(connections.id, id)))
          .returning()
        return row ? toConnection(row) : null
      })
    },

    async workspaceOrg(tenantId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ org: tenants.clerkOrgId, status: tenants.status })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1),
      )
      return row && row.status !== "deleted" ? row.org : null
    },

    async workspaceName(tenantId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ name: tenants.name })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1),
      )
      return row?.name ?? null
    },

    async coveredDomains(tenantId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ name: joinDomains.name })
          .from(connectionDomains)
          .innerJoin(joinDomains, eq(joinDomains.id, connectionDomains.joinDomainId))
          .innerJoin(connections, eq(connections.id, connectionDomains.connectionId))
          .where(
            and(
              eq(connectionDomains.tenantId, tenantId),
              eq(connections.tenantId, tenantId),
              eq(joinDomains.tenantId, tenantId),
              eq(connections.status, "active"),
              sql`${liveProof}`,
            ),
          ),
      )
      return [...new Set(rows.map((r) => r.name))]
    },

    // ── group-to-role rules ──
    async groupRules(tenantId, connectionId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(groupRoleRules)
          .where(
            and(
              eq(groupRoleRules.tenantId, tenantId),
              eq(groupRoleRules.connectionId, connectionId),
            ),
          )
          // ⚠ uuidv7 ids sort by creation, so a tie goes to the older rule.
          .orderBy(groupRoleRules.precedence, groupRoleRules.id),
      )
      return rows.map(toRule)
    },

    async createGroupRule(tenantId, input) {
      try {
        return await withTenant(db, tenantId, async (tx) => {
          // ⚠ THE CONNECTION'S ROW IS LOCKED, so two creations at the limit
          // cannot both count 99 and both insert.
          const [connection] = await tx
            .select({ id: connections.id })
            .from(connections)
            .where(
              and(
                eq(connections.tenantId, tenantId),
                eq(connections.id, input.connectionId),
              ),
            )
            .for("update")
            .limit(1)
          if (!connection) return "not_found" as const
          const [count] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(groupRoleRules)
            .where(
              and(
                eq(groupRoleRules.tenantId, tenantId),
                eq(groupRoleRules.connectionId, input.connectionId),
              ),
            )
          if ((count?.n ?? 0) >= MAX_GROUP_RULES) return "too_many" as const
          const [row] = await tx
            .insert(groupRoleRules)
            .values({ tenantId, ...input })
            .onConflictDoNothing()
            .returning()
          return row ? toRule(row) : ("exists" as const)
        })
      } catch (error) {
        if (isUniqueViolation(error)) return "exists"
        throw error
      }
    },

    async updateGroupRule(tenantId, connectionId, ruleId, patch) {
      try {
        const [row] = await withTenant(db, tenantId, (tx) =>
          tx
            .update(groupRoleRules)
            .set({ ...patch, updatedAt: new Date() })
            .where(
              and(
                eq(groupRoleRules.tenantId, tenantId),
                eq(groupRoleRules.connectionId, connectionId),
                eq(groupRoleRules.id, ruleId),
              ),
            )
            .returning(),
        )
        return row ? toRule(row) : null
      } catch (error) {
        if (isUniqueViolation(error)) return "exists"
        throw error
      }
    },

    async deleteGroupRule(tenantId, connectionId, ruleId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .delete(groupRoleRules)
          .where(
            and(
              eq(groupRoleRules.tenantId, tenantId),
              eq(groupRoleRules.connectionId, connectionId),
              eq(groupRoleRules.id, ruleId),
            ),
          )
          .returning(),
      )
      return row ? toRule(row) : null
    },

    async provisionLocked(tenantId, key, fn) {
      return withTenant(db, tenantId, async (tx) => {
        /*
         * ⚠ ADVISORY AND `_xact_`, AS THE ROLES TABLE'S LOCK IS (roles-db.ts):
         * there is no row yet to lock - the person does not exist - and
         * PgBouncer pools by transaction. Keyed on the address ALONE, the
         * thing Clerk makes unique, so two connections covering one domain
         * wait for each other too instead of racing to Clerk's refusal.
         */
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`identity_jit:${key.email}`}, 0))`,
        )
        return fn({
          async identityBySubject(subject) {
            const [row] = await tx
              .select({ id: identities.id, clerkUserId: identities.clerkUserId })
              .from(identities)
              .where(
                and(
                  eq(identities.tenantId, tenantId),
                  eq(identities.connectionId, key.connectionId),
                  eq(identities.subject, subject),
                ),
              )
              .limit(1)
            return row ?? null
          },
          async link(input) {
            const [row] = await tx
              .insert(identities)
              .values({
                tenantId,
                connectionId: key.connectionId,
                subject: input.subject,
                clerkUserId: input.clerkUserId,
                email: input.email,
              })
              .returning({ id: identities.id })
            return { id: row!.id }
          },
        })
      })
    },

    // ── attempts ──
    async createAttempt(input) {
      if (input.pkceVerifier && !secrets)
        throw new Error("a PKCE verifier needs WEBHOOK_SECRET_KEY to be kept sealed")
      const [row] = await withTenant(db, input.tenantId, async (tx) => {
        /*
         * ⚠ PRUNED AS THEY ARE MADE. Starting a sign-in is public, so this
         * table grows with whoever asks; a day is far past every window an
         * attempt has (ten minutes, then two, then five), and the audit log,
         * not this table, is the record. A bounded delete per insert keeps
         * one workspace's rows to about a day's worth without a sweeper that
         * would need to see every workspace at once.
         */
        await tx.execute(sql`
          delete from identity.login_attempts
           where id in (
             select id from identity.login_attempts
              where tenant_id = ${input.tenantId}::uuid
                and created_at < now() - interval '1 day'
              order by created_at
              limit 200)`)
        return tx
          .insert(loginAttempts)
          .values({
            tenantId: input.tenantId,
            connectionId: input.connectionId,
            purpose: input.purpose,
            stateHash: input.stateHash,
            bindingHash: input.bindingHash,
            nonce: input.nonce ?? null,
            pkceVerifier:
              input.pkceVerifier && secrets ? secrets.seal(input.pkceVerifier) : null,
            requestId: input.requestId ?? null,
            returnTo: input.returnTo ?? null,
            stepUpSessionId: input.stepUpSessionId ?? null,
            loginHint: input.loginHint ?? null,
            expiresAt: input.expiresAt,
          })
          .returning({ id: loginAttempts.id })
      })
      return { id: row!.id }
    },

    async attemptByState(stateHash) {
      const [row] = await asOutsider(db, "app.attempt_state", stateHash, (tx) =>
        tx
          .select()
          .from(loginAttempts)
          .where(eq(loginAttempts.stateHash, stateHash))
          .limit(1),
      )
      return row ? toAttempt(row) : null
    },

    async consumeAttempt(tenantId, id, at) {
      const done = await withTenant(db, tenantId, (tx) =>
        tx
          .update(loginAttempts)
          .set({ consumedAt: at })
          .where(
            and(
              eq(loginAttempts.tenantId, tenantId),
              eq(loginAttempts.id, id),
              isNull(loginAttempts.consumedAt),
            ),
          )
          .returning({ id: loginAttempts.id }),
      )
      return done.length > 0
    },

    async finishAttempt(tenantId, id, finish) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(loginAttempts)
          .set({
            outcome: finish.outcome,
            failureReason: finish.failureReason ?? null,
            ...(finish.clerkUserId !== undefined
              ? { clerkUserId: finish.clerkUserId }
              : {}),
            ...(finish.identityId !== undefined
              ? { identityId: finish.identityId }
              : {}),
            ...(finish.clerkOrgId !== undefined
              ? { clerkOrgId: finish.clerkOrgId }
              : {}),
            ...(finish.idpSession !== undefined
              ? { idpSession: finish.idpSession }
              : {}),
            ...(finish.authTime !== undefined ? { authTime: finish.authTime } : {}),
            ...(finish.handoffCodeHash !== undefined
              ? { handoffCodeHash: finish.handoffCodeHash }
              : {}),
            ...(finish.handoffExpiresAt !== undefined
              ? { handoffExpiresAt: finish.handoffExpiresAt }
              : {}),
          })
          .where(and(eq(loginAttempts.tenantId, tenantId), eq(loginAttempts.id, id))),
      )
    },

    async attemptByHandoffCode(codeHash) {
      const [row] = await asOutsider(db, "app.handoff_code", codeHash, (tx) =>
        tx
          .select()
          .from(loginAttempts)
          .where(eq(loginAttempts.handoffCodeHash, codeHash))
          .limit(1),
      )
      return row ? toAttempt(row) : null
    },

    async claimRedeem(tenantId, id, at) {
      const done = await withTenant(db, tenantId, (tx) =>
        tx
          .update(loginAttempts)
          .set({ redeemedAt: at })
          .where(
            and(
              eq(loginAttempts.tenantId, tenantId),
              eq(loginAttempts.id, id),
              isNull(loginAttempts.redeemedAt),
            ),
          )
          .returning({ id: loginAttempts.id }),
      )
      return done.length > 0
    },

    async recordToken(tenantId, id, token) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(loginAttempts)
          .set({
            signInTokenId: token.signInTokenId,
            tokenMintedAt: token.mintedAt,
            handoffSecretHash: token.handoffSecretHash,
          })
          .where(and(eq(loginAttempts.tenantId, tenantId), eq(loginAttempts.id, id))),
      )
    },

    async attemptByHandoffSecret(secretHash) {
      const [row] = await asOutsider(db, "app.handoff_secret", secretHash, (tx) =>
        tx
          .select()
          .from(loginAttempts)
          .where(eq(loginAttempts.handoffSecretHash, secretHash))
          .limit(1),
      )
      return row ? toAttempt(row) : null
    },

    async markBound(tenantId, id, sessionId, at) {
      const done = await withTenant(db, tenantId, (tx) =>
        tx
          .update(loginAttempts)
          .set({ boundAt: at, boundSessionId: sessionId })
          .where(
            and(
              eq(loginAttempts.tenantId, tenantId),
              eq(loginAttempts.id, id),
              isNull(loginAttempts.boundAt),
            ),
          )
          .returning({ id: loginAttempts.id }),
      )
      return done.length > 0
    },

    // ── identities ──
    async identityBySubject(tenantId, connectionId, subject) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ id: identities.id, clerkUserId: identities.clerkUserId })
          .from(identities)
          .where(
            and(
              eq(identities.tenantId, tenantId),
              eq(identities.connectionId, connectionId),
              eq(identities.subject, subject),
            ),
          )
          .limit(1),
      )
      return row ?? null
    },

    async identityByUser(tenantId, connectionId, clerkUserId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ id: identities.id, subject: identities.subject })
          .from(identities)
          .where(
            and(
              eq(identities.tenantId, tenantId),
              eq(identities.connectionId, connectionId),
              eq(identities.clerkUserId, clerkUserId),
            ),
          )
          .limit(1),
      )
      return row ?? null
    },

    async link(tenantId, input) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .insert(identities)
          .values({ tenantId, ...input })
          .returning({ id: identities.id }),
      )
      return { id: row!.id }
    },

    async touchIdentity(tenantId, id, email, at) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(identities)
          .set({ email, lastLoginAt: at })
          .where(and(eq(identities.tenantId, tenantId), eq(identities.id, id))),
      )
    },

    // ── managed ──
    managedByUser,

    async managedByIdentifier(identifier) {
      const value = identifier.trim().toLowerCase()
      if (!value) return false
      const rows = await asOutsider(db, "app.identifier", value, (tx) =>
        tx
          .select({ id: managedAccounts.clerkUserId })
          .from(managedAccounts)
          // ⚠ `@>`, NOT `= any(...)`: only containment can use the GIN index
          // on `emails`, and this answers every gateway sign-in lookup.
          .where(arrayContains(managedAccounts.emails, [value]))
          .limit(1),
      )
      return rows.length > 0
    },

    async claimManaged(tenantId, row) {
      const made = await withTenant(db, tenantId, async (tx) => {
        const inserted = await tx
          .insert(managedAccounts)
          .values({
            clerkUserId: row.clerkUserId,
            tenantId,
            connectionId: row.connectionId,
            reason: row.reason,
            emails: row.emails,
          })
          .onConflictDoNothing()
          .returning({ id: managedAccounts.clerkUserId })
        /*
         * ⚠ AUTHD IS TOLD IN THE SAME TRANSACTION, from the row as it stands:
         * this workspace's own (policy-scoped), whether just made or already
         * there. Re-claiming heals a mirror that went missing; another
         * workspace's row is invisible here and is left alone.
         */
        const [own] = await tx
          .select({ connectionId: managedAccounts.connectionId })
          .from(managedAccounts)
          .where(
            and(
              eq(managedAccounts.tenantId, tenantId),
              eq(managedAccounts.clerkUserId, row.clerkUserId),
            ),
          )
          .limit(1)
        if (own) await mirrorManaged(tx, row.clerkUserId, own.connectionId)
        return inserted
      })
      if (made.length > 0) return "created"
      // ⚠ A CONFLICT ON A ROW WE CANNOT SEE IS ANOTHER WORKSPACE'S. Asked as
      // the user, which reads their row wherever it is.
      const existing = await managedByUser(row.clerkUserId)
      if (!existing)
        throw new Error("managed account conflict with no row to show for it")
      return existing.tenantId === tenantId ? "kept" : "elsewhere"
    },

    async setManagedEmails(tenantId, clerkUserId, emails, connectionId) {
      await withTenant(db, tenantId, async (tx) => {
        const [moved] = await tx
          .update(managedAccounts)
          .set({
            emails,
            ...(connectionId !== undefined ? { connectionId } : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(managedAccounts.tenantId, tenantId),
              eq(managedAccounts.clerkUserId, clerkUserId),
            ),
          )
          .returning({ connectionId: managedAccounts.connectionId })
        // ⚠ THE CONNECTION CAN MOVE HERE, and authd answers binds by it.
        if (moved) await mirrorManaged(tx, clerkUserId, moved.connectionId)
      })
    },

    async releaseManaged(tenantId, clerkUserId) {
      const gone = await withTenant(db, tenantId, async (tx) => {
        const removed = await tx
          .delete(managedAccounts)
          .where(
            and(
              eq(managedAccounts.tenantId, tenantId),
              eq(managedAccounts.clerkUserId, clerkUserId),
            ),
          )
          .returning({ id: managedAccounts.clerkUserId })
        if (removed.length > 0) await unmirrorManaged(tx, clerkUserId)
        return removed
      })
      return gone.length > 0
    },

    async forgetUser(tenantId, clerkUserId) {
      await withTenant(db, tenantId, async (tx) => {
        await tx
          .delete(identities)
          .where(
            and(
              eq(identities.tenantId, tenantId),
              eq(identities.clerkUserId, clerkUserId),
            ),
          )
        const removed = await tx
          .delete(managedAccounts)
          .where(
            and(
              eq(managedAccounts.tenantId, tenantId),
              eq(managedAccounts.clerkUserId, clerkUserId),
            ),
          )
          .returning({ id: managedAccounts.clerkUserId })
        if (removed.length > 0) await unmirrorManaged(tx, clerkUserId)
      })
    },

    // ── the gate ──
    async gateRead(clerkUserId, sessionId) {
      /*
       * ⚠ ONE TRANSACTION, TWO AUDIENCES. The managed row is read as the user
       * (no workspace known yet); then `app.tenant_id` is set to the tenant
       * that row names - taken from the database, never the request - and the
       * session and its connection are read as that workspace.
       */
      return asOutsider(db, "app.user_id", clerkUserId, async (tx) => {
        const [managed] = await tx
          .select()
          .from(managedAccounts)
          .where(eq(managedAccounts.clerkUserId, clerkUserId))
          .limit(1)
        if (!managed) return { managed: null }
        await tx.execute(
          sql`select set_config('app.tenant_id', ${managed.tenantId}, true)`,
        )
        const [row] = await tx
          .select({
            session: ssoSessions,
            status: connections.status,
            maxSessionSeconds: connections.maxSessionSeconds,
            idleTimeoutSeconds: connections.idleTimeoutSeconds,
            // ⚠ DISPLACEMENT ENDS SSO FOR THE DOMAIN, BOUND SESSIONS INCLUDED:
            // a session passes only while its connection still covers a live
            // proof (verified, not lapsed, not displaced).
            domainLive: sql<boolean>`exists (
              select 1 from ${connectionDomains}
                join ${joinDomains} on ${joinDomains.id} = ${connectionDomains.joinDomainId}
               where ${connectionDomains.connectionId} = ${ssoSessions.connectionId}
                 and ${liveProof})`,
          })
          .from(ssoSessions)
          .innerJoin(connections, eq(connections.id, ssoSessions.connectionId))
          .where(
            and(
              eq(ssoSessions.sessionId, sessionId),
              eq(ssoSessions.tenantId, managed.tenantId),
              eq(ssoSessions.clerkUserId, clerkUserId),
            ),
          )
          .limit(1)
        /*
         * ⚠ WHERE TO SEND THEM IS THE LIVE CONNECTION THAT COVERS ONE OF THEIR
         * ADDRESSES NOW, NOT THE ONE THEY WERE CLAIMED THROUGH. After a domain
         * moves, the old connection can no longer vouch for the address, and
         * naming it sent the person round a loop (2026-11-01). The claimed one
         * wins while it still qualifies; none qualifying is null, and the
         * console then offers no dead button.
         *
         * ⚠ AND AN OWNER OR ADMIN ONLY EVER TO A CONNECTION THEY ARE LINKED ON,
         * the bridge's own rule (#338, `role_exempt` in bridge.ts): any other
         * connection refuses them, so naming it is the same dead end. Once
         * their linked connection loses the domain there is no SSO way back
         * for them, by design, and the answer is null.
         */
        const [route] = await tx
          .select({ id: connections.id })
          .from(connections)
          .innerJoin(
            connectionDomains,
            eq(connectionDomains.connectionId, connections.id),
          )
          .innerJoin(joinDomains, eq(joinDomains.id, connectionDomains.joinDomainId))
          .innerJoin(managedAccounts, eq(managedAccounts.clerkUserId, clerkUserId))
          .where(
            and(
              eq(connections.tenantId, managed.tenantId),
              eq(connections.status, "active"),
              liveProof,
              sql`${joinDomains.name} = any (
                select lower(split_part(address, '@', 2))
                  from unnest(${managedAccounts.emails}) as address)`,
              sql`(not exists (
                     select 1 from ${workspaceRoles}
                      where ${workspaceRoles.tenantId} = ${managed.tenantId}
                        and ${workspaceRoles.clerkUserId} = ${clerkUserId}
                        and ${workspaceRoles.role} in ('owner', 'admin'))
                   or exists (
                     select 1 from ${identities}
                      where ${identities.tenantId} = ${managed.tenantId}
                        and ${identities.connectionId} = ${connections.id}
                        and ${identities.clerkUserId} = ${clerkUserId}))`,
            ),
          )
          .orderBy(
            sql`${connections.id} is distinct from ${managed.connectionId}`,
            connections.createdAt,
          )
          .limit(1)
        return {
          managed: { tenantId: managed.tenantId, connectionId: route?.id ?? null },
          session: row
            ? {
                ...toSession(row.session),
                connectionStatus: row.status as ConnectionStatus,
                domainLive: Boolean(row.domainLive),
                maxSessionSeconds: row.maxSessionSeconds,
                idleTimeoutSeconds: row.idleTimeoutSeconds,
              }
            : null,
        }
      })
    },

    async bindSession(tenantId, row) {
      await withTenant(db, tenantId, (tx) =>
        tx.insert(ssoSessions).values({
          sessionId: row.sessionId,
          tenantId,
          clerkUserId: row.clerkUserId,
          connectionId: row.connectionId,
          identityId: row.identityId,
          idpSession: row.idpSession,
          authTime: row.authTime,
          boundAt: row.at,
          freshAt: row.freshAt,
          lastSeenAt: row.at,
        }),
      )
    },

    async touchSession(tenantId, sessionId, at) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(ssoSessions)
          .set({ lastSeenAt: at })
          .where(
            and(
              eq(ssoSessions.tenantId, tenantId),
              eq(ssoSessions.sessionId, sessionId),
            ),
          ),
      )
    },

    async revokeSessionRow(tenantId, sessionId, reason, at) {
      const done = await withTenant(db, tenantId, (tx) =>
        tx
          .update(ssoSessions)
          .set({ revokedAt: at, revokedReason: reason })
          .where(
            and(
              eq(ssoSessions.tenantId, tenantId),
              eq(ssoSessions.sessionId, sessionId),
              isNull(ssoSessions.revokedAt),
            ),
          )
          .returning({ id: ssoSessions.sessionId }),
      )
      return done.length > 0
    },

    async sessionRow(tenantId, sessionId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(ssoSessions)
          .where(
            and(
              eq(ssoSessions.tenantId, tenantId),
              eq(ssoSessions.sessionId, sessionId),
            ),
          )
          .limit(1),
      )
      return row ? toSession(row) : null
    },

    async sessionsOf(tenantId, clerkUserId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(ssoSessions)
          .where(
            and(
              eq(ssoSessions.tenantId, tenantId),
              eq(ssoSessions.clerkUserId, clerkUserId),
              isNull(ssoSessions.revokedAt),
            ),
          )
          .orderBy(desc(ssoSessions.boundAt)),
      )
      return rows.map(toSession)
    },

    async setFresh(tenantId, sessionId, at) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(ssoSessions)
          .set({ freshAt: at })
          .where(
            and(
              eq(ssoSessions.tenantId, tenantId),
              eq(ssoSessions.sessionId, sessionId),
            ),
          ),
      )
    },

    // ── the rest ──
    async isBlocked(tenantId, email) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ id: joinExclusions.id })
          .from(joinExclusions)
          .where(
            and(
              eq(joinExclusions.tenantId, tenantId),
              eq(joinExclusions.email, email.toLowerCase()),
              eq(joinExclusions.kind, "blocked"),
            ),
          )
          .limit(1),
      )
      return rows.length > 0
    },

    async deprovisionMode(tenantId): Promise<DeprovisionMode> {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ mode: workspaceSettings.deprovision })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.tenantId, tenantId))
          .limit(1),
      )
      return row?.mode === "account" ? "account" : "membership"
    },

    async setDeprovisionMode(tenantId, mode, by) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .insert(workspaceSettings)
          .values({ tenantId, deprovision: mode, updatedBy: by })
          .onConflictDoUpdate({
            target: workspaceSettings.tenantId,
            set: { deprovision: mode, updatedBy: by, updatedAt: new Date() },
          }),
      )
    },

    async recordTestRun(tenantId, row) {
      const [made] = await withTenant(db, tenantId, (tx) =>
        tx
          .insert(testRuns)
          .values({ tenantId, ...row })
          .returning({ id: testRuns.id }),
      )
      return { id: made!.id }
    },

    async testRuns(tenantId, connectionId, limit) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(testRuns)
          .where(
            and(
              eq(testRuns.tenantId, tenantId),
              eq(testRuns.connectionId, connectionId),
            ),
          )
          .orderBy(desc(testRuns.createdAt))
          .limit(Math.min(Math.max(limit, 1), 50)),
      )
      return rows.map((r) => ({
        id: r.id,
        connectionId: r.connectionId,
        outcome: r.outcome === "passed" ? ("passed" as const) : ("failed" as const),
        reason: r.reason,
        claims: r.claims,
        resolution: r.resolution,
        createdAt: r.createdAt,
      }))
    },

    async record(tenantId, event) {
      await withTenant(db, tenantId, (tx) =>
        tx.insert(events).values({
          tenantId,
          type: event.type,
          actorUserId: event.actorUserId ?? null,
          subjectUserId: event.subjectUserId ?? null,
          connectionId: event.connectionId ?? null,
          sessionId: event.sessionId ?? null,
          reason: event.reason ?? null,
          data: event.data ?? {},
        }),
      )
    },

    async events(tenantId, options) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(events)
          .where(
            and(
              eq(events.tenantId, tenantId),
              options.subjectUserId
                ? eq(events.subjectUserId, options.subjectUserId)
                : undefined,
            ),
          )
          .orderBy(desc(events.createdAt))
          .limit(Math.min(Math.max(options.limit, 1), 200)),
      )
      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        actorUserId: r.actorUserId,
        subjectUserId: r.subjectUserId,
        connectionId: r.connectionId,
        sessionId: r.sessionId,
        reason: r.reason,
        data: r.data,
        createdAt: r.createdAt,
      }))
    },
  }
}
