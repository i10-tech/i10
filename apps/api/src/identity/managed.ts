import type { MailboxLifecycle } from "./directory-mail.js"
import { SWEEP_AFTER_MS, type DeprovisionMode } from "./model.js"
import type {
  ClerkIdentity,
  ClerkUserSnapshot,
  IdentityStore,
  Logger,
} from "./ports.js"

/**
 * Managed accounts (sso.md 2.3): a Clerk user whose company signs them in.
 *
 * ⚠ CLERK WILL NOT ENFORCE ANY OF THIS FOR US (P2, P3), so it is enforced by
 * taking away every other way in. On link, and again whenever Clerk reports a
 * change (`user.updated`), the account loses its password, social accounts,
 * passkeys, phone numbers, web3 wallets, Clerk 2FA and backup codes, any
 * address it was not linked with, and the ability to delete itself. The gateway refuses the Frontend API
 * routes that would add them back; this is the backstop for whatever reaches
 * Clerk anyway.
 */

/** One change that brings a managed account back to what its company allows. */
export type Fix =
  | { kind: "password" }
  | { kind: "external_account"; id: string }
  | { kind: "passkey"; id: string }
  | { kind: "phone"; id: string }
  | { kind: "web3_wallet"; id: string }
  | { kind: "mfa" }
  | { kind: "backup_codes" }
  | { kind: "email"; id: string; address: string }
  | { kind: "self_delete" }

/**
 * What is wrong with a managed account, as a list of fixes. Pure.
 *
 * ⚠ AN ADDRESS IS KEPT ONLY IF IT IS ON THE LIST THE ACCOUNT WAS LINKED WITH.
 * An address the person added at Clerk since (verified or not) is a second
 * identity the IdP knows nothing about, so it goes - but never the last
 * address the account has, and never the primary while it is on the list.
 */
export function driftOf(user: ClerkUserSnapshot, keep: readonly string[]): Fix[] {
  const fixes: Fix[] = []
  if (user.passwordEnabled) fixes.push({ kind: "password" })
  for (const id of user.externalAccountIds) fixes.push({ kind: "external_account", id })
  for (const id of user.passkeyIds) fixes.push({ kind: "passkey", id })
  for (const id of user.phoneIds) fixes.push({ kind: "phone", id })
  for (const id of user.web3WalletIds) fixes.push({ kind: "web3_wallet", id })
  if (user.twoFactorEnabled || user.totpEnabled) fixes.push({ kind: "mfa" })
  if (user.backupCodeEnabled) fixes.push({ kind: "backup_codes" })
  const allowed = new Set(keep.map((e) => e.toLowerCase()))
  const extra = user.emails.filter((e) => !allowed.has(e.address.toLowerCase()))
  // Never strip the account bare: if NOTHING is on the list, change nothing.
  if (extra.length < user.emails.length)
    for (const e of extra) fixes.push({ kind: "email", id: e.id, address: e.address })
  if (user.deleteSelfEnabled) fixes.push({ kind: "self_delete" })
  return fixes
}

/** Applies the fixes, in order. Throws on the first Clerk failure (callers retry). */
export async function applyFixes(
  clerk: ClerkIdentity,
  userId: string,
  fixes: readonly Fix[],
): Promise<void> {
  for (const fix of fixes) {
    switch (fix.kind) {
      case "password":
        await clerk.removePassword(userId)
        break
      case "external_account":
        await clerk.deleteExternalAccount(userId, fix.id)
        break
      case "passkey":
        await clerk.deletePasskey(userId, fix.id)
        break
      case "phone":
        await clerk.deletePhoneNumber(fix.id)
        break
      case "web3_wallet":
        await clerk.deleteWeb3Wallet(userId, fix.id)
        break
      case "mfa":
        await clerk.disableMfa(userId)
        break
      case "backup_codes":
        await clerk.deleteBackupCodes(userId)
        break
      case "email":
        await clerk.deleteEmailAddress(fix.id)
        break
      case "self_delete":
        await clerk.forbidSelfDelete(userId)
        break
    }
  }
}

export interface ManagedDeps {
  store: IdentityStore
  clerk: ClerkIdentity
  log: Logger
  now?: () => Date
}

/**
 * Brings one managed account into line: reads Clerk, fixes what drifted, and
 * records what it changed. Returns the fixes applied.
 *
 * ⚠ THE PAYLOAD OF A WEBHOOK IS A HINT, NOT THE STATE. Svix delivers out of
 * order and late; Clerk itself is read here, every time.
 */
export async function enforceManaged(
  d: ManagedDeps,
  row: { tenantId: string; clerkUserId: string; emails: string[] },
  cause: string,
): Promise<Fix[]> {
  const user = await d.clerk.user(row.clerkUserId)
  if (!user) return []
  const fixes = driftOf(user, row.emails)
  if (fixes.length === 0) return []
  await applyFixes(d.clerk, row.clerkUserId, fixes)
  await d.store.record(row.tenantId, {
    type: "managed.enforced",
    subjectUserId: row.clerkUserId,
    reason: cause,
    data: { fixes: fixes.map((f) => f.kind) },
  })
  d.log.warn(
    {
      tenantId: row.tenantId,
      userId: row.clerkUserId,
      cause,
      fixes: fixes.map((f) => f.kind),
    },
    "reverted a managed account to what its company allows",
  )
  return fixes
}

/**
 * `user.updated`: the watchdog. Only managed accounts are read from Clerk.
 *
 * ⚠ OUR OWN FIXES FIRE `user.updated` AGAIN, and that is how the loop ends:
 * the second pass finds nothing to fix and writes nothing.
 */
export async function onUserUpdated(
  d: ManagedDeps,
  data: unknown,
): Promise<string | null> {
  const userId = idOf(data)
  if (!userId) return null
  const row = await d.store.managedByUser(userId)
  if (!row) return null
  const fixes = await enforceManaged(d, row, "user.updated")
  return fixes.length ? `managed:fixed:${fixes.length}` : "managed:ok"
}

// ── The sweeper (sso.md 2.2, layer 3) ───────────────────────────────────

/** What `session.created` asks the sweeper to do. */
export type SweepPlan =
  | { action: "none" }
  /** Not a ticket: we did not make this session. Revoke now. */
  | { action: "revoke"; reason: "not_ticket" }
  /** A ticket: give the bind its two minutes, then look. */
  | { action: "later"; at: Date }

export interface SessionCreated {
  sessionId: string
  userId: string
  clientId: string | null
  createdAt: Date
}

export function sessionCreatedOf(data: unknown): SessionCreated | null {
  const s = (data ?? {}) as {
    id?: unknown
    user_id?: unknown
    client_id?: unknown
    created_at?: unknown
  }
  if (typeof s.id !== "string" || typeof s.user_id !== "string") return null
  return {
    sessionId: s.id,
    userId: s.user_id,
    clientId: typeof s.client_id === "string" ? s.client_id : null,
    createdAt: new Date(typeof s.created_at === "number" ? s.created_at : Date.now()),
  }
}

/**
 * `session.created` for a managed account: the backstop behind the gateway.
 *
 * ⚠ THE CLIENT SAYS HOW IT SIGNED IN (P4). Only our ticket is a way in for a
 * managed account; any other strategy is a session we did not make, revoked
 * at once. A ticket session gets `SWEEP_AFTER_MS` to be bound, because a
 * ticket can also be somebody else's (a Clerk invitation, a saved account)
 * and only the bind row says it was ours.
 *
 * ⚠ A CLIENT WE CANNOT READ IS NOT A TICKET. Unknown strategy waits for the
 * bind like a ticket would, so the decision is made by the bind row, never by
 * a guess in either direction.
 */
export async function planSweep(
  d: Pick<ManagedDeps, "store" | "clerk">,
  event: SessionCreated,
): Promise<SweepPlan> {
  const managed = await d.store.managedByUser(event.userId)
  if (!managed) return { action: "none" }
  const strategy = event.clientId ? await d.clerk.lastStrategy(event.clientId) : null
  if (strategy !== null && strategy !== "ticket")
    return { action: "revoke", reason: "not_ticket" }
  return { action: "later", at: new Date(event.createdAt.getTime() + SWEEP_AFTER_MS) }
}

export interface SweepJob {
  sessionId: string
  userId: string
  /** ms since epoch: when the bind's grace ends. */
  dueAt: number
}

/**
 * The delayed half: is the session bound by now? If not, it is revoked.
 *
 * ⚠ AN EARLY RUN NEVER REVOKES. groupmq's retry floors time to the second and
 * a promotion tick can run a job a little early; this answers how long is
 * left instead, and the worker waits it out (queue/identity-sweep-queue.ts).
 */
export async function sweepSession(
  d: ManagedDeps,
  job: SweepJob,
): Promise<{ outcome: "bound" | "revoked" | "not_managed" | "early"; ms?: number }> {
  const now = (d.now ?? (() => new Date()))().getTime()
  if (now < job.dueAt) return { outcome: "early", ms: job.dueAt - now }
  const read = await d.store.gateRead(job.userId, job.sessionId)
  if (!read.managed) return { outcome: "not_managed" }
  if (read.session && !read.session.revokedAt) return { outcome: "bound" }
  await d.clerk.revokeSession(job.sessionId)
  await d.store.record(read.managed.tenantId, {
    type: "session.revoked",
    subjectUserId: job.userId,
    sessionId: job.sessionId,
    reason: "unbound",
  })
  d.log.warn(
    { tenantId: read.managed.tenantId, userId: job.userId, sessionId: job.sessionId },
    "revoked a managed account's session that was never bound through SSO",
  )
  return { outcome: "revoked" }
}

/** Revokes a session the sweeper refused at once (not a ticket). */
export async function revokeNow(
  d: ManagedDeps,
  event: SessionCreated,
  reason: string,
): Promise<void> {
  const managed = await d.store.managedByUser(event.userId)
  await d.clerk.revokeSession(event.sessionId)
  if (managed)
    await d.store.record(managed.tenantId, {
      type: "session.revoked",
      subjectUserId: event.userId,
      sessionId: event.sessionId,
      reason,
    })
  d.log.warn(
    { userId: event.userId, sessionId: event.sessionId, reason },
    "revoked a managed account's session that did not come through SSO",
  )
}

// ── Revocation and deprovisioning ───────────────────────────────────────

/**
 * Ends every bound session of a person in a workspace, at Clerk and here.
 *
 * ⚠ CLERK FIRST, THEN OUR ROW. A row marked revoked for a session Clerk kept
 * would only be the gate refusing a session that still refreshes; the other
 * order is the same until the next call, so a Clerk failure throws and the
 * caller retries the whole thing.
 */
export async function revokeAll(
  d: ManagedDeps,
  input: {
    tenantId: string
    clerkUserId: string
    reason: string
    actorUserId?: string | null
  },
): Promise<number> {
  const now = (d.now ?? (() => new Date()))()
  const live = await d.store.sessionsOf(input.tenantId, input.clerkUserId)
  let revoked = 0
  for (const session of live) {
    await d.clerk.revokeSession(session.sessionId)
    if (
      await d.store.revokeSessionRow(
        input.tenantId,
        session.sessionId,
        input.reason,
        now,
      )
    ) {
      revoked++
      await d.store.record(input.tenantId, {
        type: "session.revoked",
        actorUserId: input.actorUserId ?? null,
        subjectUserId: input.clerkUserId,
        sessionId: session.sessionId,
        connectionId: session.connectionId,
        reason: input.reason,
      })
    }
  }
  return revoked
}

export interface DeprovisionDeps extends ManagedDeps {
  /**
   * Whether the actor may act on this person as removing them would (#335's
   * `mayRemove`): an admin anybody but an owner, an owner anybody. A null
   * actor is the workspace's own directory (SCIM, #342), which may.
   */
  authorize(input: {
    tenantId: string
    actorUserId: string | null
    userId: string
  }): Promise<"ok" | "forbidden" | "owner_only">
  /**
   * Takes the person out of the workspace through our roles code (#335), as
   * the actor: `last_owner` and `unconfirmed` refuse, as removing does.
   */
  removeMembership(input: {
    tenantId: string
    orgId: string
    actorUserId: string | null
    userId: string
  }): Promise<"removed" | "last_owner" | "unconfirmed" | "forbidden" | "owner_only">
  workspaceOrg(tenantId: string): Promise<string | null>
  /** The person's mailbox: suspended when they are deprovisioned (#344). */
  mail: MailboxLifecycle
}

export type DeprovisionOutcome =
  | { outcome: "membership"; sessions: number }
  | { outcome: "account"; sessions: number }
  | {
      outcome:
        | "last_owner"
        | "unconfirmed"
        | "not_managed"
        | "workspace_gone"
        | "forbidden"
        | "owner_only"
    }

/**
 * The deprovisioning primitive (decision 5): SCIM's `active: false` (#342) and
 * an admin's "deprovision" both end here.
 *
 *   - The actor must outrank the person (`authorize`): an admin can never
 *     deprovision, and so never ban, an owner. Checked before anything moves.
 *   - Every bound session in the workspace is revoked next, either way, even
 *     when what follows is refused.
 *   - `membership` (the default): the membership goes and the account stops
 *     being managed, so the person keeps their i10 account and whatever other
 *     workspaces they are in, and signs in to those the ordinary way.
 *   - `account`: the Clerk user is banned, which ends every session it has
 *     anywhere. The managed row stays: nobody re-links a banned account.
 *
 *   - The mailbox is SUSPENDED (#344): the login is refused, mail keeps
 *     arriving and is kept, and what happens next is the admin's pick
 *     (identity/directory-mail.ts). Never deleted here.
 *
 * ⚠ THE MAILBOX IS SUSPENDED AFTER THE MEMBERSHIP GOES AND BEFORE THE ACCOUNT
 * IS RELEASED OR BANNED, and that order is load-bearing. A refusal to remove
 * (the last owner) must leave the mailbox alone, and a failure after the
 * release would be retried against an account that is no longer managed, which
 * returns `not_managed` and never suspends. Before the release, a retry finds
 * the account managed still and suspends again (idempotently).
 */
export async function deprovision(
  d: DeprovisionDeps,
  input: {
    tenantId: string
    clerkUserId: string
    actorUserId: string | null
    cause: string
  },
): Promise<DeprovisionOutcome> {
  const managed = await d.store.managedByUser(input.clerkUserId)
  if (!managed || managed.tenantId !== input.tenantId) return { outcome: "not_managed" }
  const orgId = await d.workspaceOrg(input.tenantId)
  if (!orgId) return { outcome: "workspace_gone" }
  const mode: DeprovisionMode = await d.store.deprovisionMode(input.tenantId)
  /*
   * ⚠ WHO MAY, BEFORE ANY SESSION ENDS. In `account` mode this is a ban of the
   * whole i10 account, so the role rule that guards removing somebody guards
   * it too - an admin who could deprovision an owner could take the workspace.
   */
  const allowed = await d.authorize({
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    userId: input.clerkUserId,
  })
  if (allowed !== "ok") return { outcome: allowed }

  // ⚠ SESSIONS FIRST, WHATEVER HAPPENS NEXT. Even when the membership cannot
  // go (the last owner), a person their company has switched off keeps no
  // session that skipped asking it.
  const sessions = await revokeAll(d, {
    tenantId: input.tenantId,
    clerkUserId: input.clerkUserId,
    reason: "deprovisioned",
    actorUserId: input.actorUserId,
  })
  if (mode === "membership") {
    const removed = await d.removeMembership({
      tenantId: input.tenantId,
      orgId,
      actorUserId: input.actorUserId,
      userId: input.clerkUserId,
    })
    if (removed !== "removed") {
      await d.store.record(input.tenantId, {
        type: "member.deprovision_refused",
        actorUserId: input.actorUserId,
        subjectUserId: input.clerkUserId,
        reason: removed,
        data: { sessions },
      })
      return { outcome: removed }
    }
  }
  const mailbox = await d.mail.suspend({
    tenantId: input.tenantId,
    clerkUserId: input.clerkUserId,
    actorUserId: input.actorUserId,
    cause: input.cause,
  })
  await d.mail.leaveLists(input.tenantId, input.clerkUserId)

  if (mode === "account") await d.clerk.ban(input.clerkUserId)
  else await d.store.releaseManaged(input.tenantId, input.clerkUserId)

  await d.store.record(input.tenantId, {
    type: "member.deprovisioned",
    actorUserId: input.actorUserId,
    subjectUserId: input.clerkUserId,
    reason: input.cause,
    data: { mode, sessions, mailbox },
  })
  return { outcome: mode, sessions }
}

function idOf(data: unknown): string | null {
  const id = (data as { id?: unknown } | null)?.id
  return typeof id === "string" && id ? id : null
}
