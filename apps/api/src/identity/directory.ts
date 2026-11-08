import { DEFAULT_ROLE, type JoinRole } from "../console/roles.js"
import { verifiedAddresses, type ResolveContext } from "./bridge.js"
import type {
  ClerkProvisioning,
  DirectoryConflict,
  DirectoryStore,
  DirectoryUserRow,
  OutboxEntry,
} from "./directory-ports.js"
import { mailForActive, type DirectoryMailDeps } from "./directory-mail.js"
import { profileChanges, readName } from "./jit.js"
import {
  deprovision,
  enforceManaged,
  type DeprovisionDeps,
  type ManagedDeps,
} from "./managed.js"
import { normaliseEmail, onLiveDomain } from "./model.js"
import type {
  ClerkIdentity,
  ClerkUserSnapshot,
  IdentityStore,
  Logger,
  ManagedRow,
} from "./ports.js"

/**
 * What a directory's changes do to Clerk, to the membership and to the
 * account's management (#342, sso.md 2.7): the apply job, the bridge's hooks
 * and the kick that finds entries nobody scheduled.
 *
 * ⚠ THE DIRECTORY DECIDES WHO SHOULD EXIST; WHAT IS DONE ABOUT IT IS OURS.
 * `applyDirectoryUser` reads the row as it is now and brings Clerk to it. It
 * claims no account outside the workspace's proved domains, takes over no
 * owner or admin, creates nobody a name cannot be found for, and when it
 * refuses it says why on the row (`DirectoryConflict`) and in the audit log -
 * the directory is never answered with an error for it, or it would retry and
 * flag the app for something only the workspace's admins can settle.
 */

export interface ApplyJob {
  tenantId: string
  directoryUserId: string
}

export interface DirectoryDeps {
  store: DirectoryStore
  identity: IdentityStore
  clerk: ClerkIdentity
  provisioning: ClerkProvisioning
  /** What deactivating does: the same primitive an admin's deprovision ends in. */
  deprovision: DeprovisionDeps
  isMember(orgId: string, userId: string): Promise<boolean>
  /** Our plan's limit, asked before Clerk's (`beforeSeatUse`), for somebody who is not a member yet. */
  seats(tenantId: string, orgId: string): Promise<{ full: boolean }>
  /** Membership through our roles code (#335). `full`: Clerk's own limit. */
  join(input: {
    tenantId: string
    orgId: string
    userId: string
    role: JoinRole
  }): Promise<"added" | "full">
  /** An owner or an admin in our roles table: SCIM never takes one over. */
  isExempt(tenantId: string, userId: string): Promise<boolean>
  /**
   * Mail from the directory (#344): the mailbox, aliases and lists of the
   * people it activates, and the reactivation of a suspended one.
   */
  mail: DirectoryMailDeps
  /** The gate's cache of this account's managed state. */
  forget(input: { userId: string }): void
  log: Logger
  now?: () => Date
}

export type ApplyOutcome =
  | {
      outcome: "applied"
      action:
        | "created"
        | "claimed"
        | "updated"
        | "conflict"
        | "deprovisioned"
        | "kept_by_other_directory"
        | "nothing_to_do"
        | "purged"
        | "retained"
      conflict?: DirectoryConflict
    }
  /** A disabled directory: nothing is done and nothing is marked applied. */
  | { outcome: "skipped"; action: "directory_disabled" | "workspace_gone" }
  | { outcome: "gone"; action: "no_such_row" }

const clock = (d: { now?: () => Date }) => (d.now ?? (() => new Date()))()

/**
 * An error as a log line may carry it: its kind and its database or Clerk code.
 *
 * ⚠ NEVER ITS MESSAGE. A failed query's message holds the query's parameters
 * (a directory's people, a token's hash), and a Clerk error's holds the
 * request; neither belongs in a log.
 */
export function safeError(error: unknown): { error: string; code?: string } {
  const read = (e: unknown): string | undefined => {
    const code = (e as { code?: unknown } | null)?.code
    return typeof code === "string" ? code : undefined
  }
  const code =
    read(error) ??
    read((error as { cause?: unknown } | null)?.cause) ??
    ((error as { errors?: { code?: unknown }[] } | null)?.errors ?? [])
      .map((e) => e.code)
      .find((c): c is string => typeof c === "string")
  return {
    error: error instanceof Error ? error.name : typeof error,
    ...(code ? { code } : {}),
  }
}

/** A failure's short reason for the outbox: a Clerk error code or the error's name, never its message. */
function reasonOf(error: unknown): string {
  const codes = ((error as { errors?: { code?: unknown }[] } | null)?.errors ?? [])
    .map((e) => e.code)
    .filter((c): c is string => typeof c === "string")
  if (codes.length > 0) return codes.join(",")
  return error instanceof Error ? error.name : "error"
}

/**
 * Carries one person's directory row to Clerk, the membership and the
 * managed-account rules.
 *
 * ⚠ IDEMPOTENT, ORDER-FREE, AND ONLY THEN MARKED APPLIED. The outbox entry
 * names the person; the row is read now, whatever the entry was written for.
 * `markApplied` stamps the entries up to the newest one seen BEFORE the row
 * was read (`forApply`), so a change that lands while this runs keeps its own
 * entry and is applied by the next job. A Clerk failure throws after
 * recording the failure, and the queue retries; a refusal is a conflict, not
 * a failure, and is marked applied.
 *
 * ⚠ A DISABLED DIRECTORY IS SKIPPED WITHOUT MARKING ANYTHING APPLIED, so
 * enabling it again replays what it said meanwhile.
 */
export async function applyDirectoryUser(
  d: DirectoryDeps,
  input: ApplyJob,
): Promise<ApplyOutcome> {
  const read = await d.store.forApply(input.tenantId, input.directoryUserId)
  if (!read) return { outcome: "gone", action: "no_such_row" }
  const { row, upTo } = read
  if (!row.directoryEnabled) return { outcome: "skipped", action: "directory_disabled" }
  if (upTo === null) return { outcome: "applied", action: "nothing_to_do" }

  try {
    const finish = async (result: ApplyOutcome): Promise<ApplyOutcome> => {
      await d.store.markApplied(row.tenantId, row.id, upTo, clock(d))
      return result
    }
    const settled =
      row.deletedAt || !row.active ? await deactivate(d, row) : await activate(d, row)
    // A purged row took its entries with it; anything else is applied as far as it can be.
    if (settled.outcome !== "applied" || settled.action === "purged") return settled
    return finish(settled)
  } catch (error) {
    await d.store.noteFailure(row.tenantId, row.id, reasonOf(error))
    throw error
  }
}

// ── Conflicts ───────────────────────────────────────────────────────────────

/**
 * Sets or clears the row's conflict. Audited only when it CHANGED, so a
 * directory that pushes the same person every forty minutes (Entra) does not
 * fill the log.
 */
async function settleConflict(
  d: DirectoryDeps,
  row: DirectoryUserRow,
  kind: DirectoryConflict | null,
): Promise<void> {
  const changed = await d.store.setConflict(row.tenantId, row.id, kind, null, clock(d))
  if (!changed) return
  await d.identity.record(row.tenantId, {
    type: kind ? "scim.conflict" : "scim.conflict_resolved",
    subjectUserId: row.clerkUserId,
    reason: kind ?? row.conflict,
    data: { directoryId: row.directoryId, directoryUserId: row.id },
  })
}

const conflicted = async (
  d: DirectoryDeps,
  row: DirectoryUserRow,
  kind: DirectoryConflict,
): Promise<ApplyOutcome> => {
  await settleConflict(d, row, kind)
  return { outcome: "applied", action: "conflict", conflict: kind }
}

// ── Active ──────────────────────────────────────────────────────────────────

/**
 * An active person: the Clerk account is found, claimed or made, brought to
 * the directory's address and names, managed, and a member.
 */
async function activate(
  d: DirectoryDeps,
  row: DirectoryUserRow & { createMailboxes: boolean },
): Promise<ApplyOutcome> {
  const t = row.tenantId
  const email = normaliseEmail(row.email)
  if (!email) return conflicted(d, row, "no_email")
  // ⚠ BEFORE ANY CLERK WORK: the block list wins (sso.md 2.7).
  if (await d.identity.isBlocked(t, email)) return conflicted(d, row, "blocked")
  /*
   * ⚠ ONLY AN ADDRESS ON A DOMAIN THE WORKSPACE HAS PROVED AND STILL HOLDS, and
   * before Clerk is asked anything about it. Creating the account would mark
   * verified an address the workspace never proved (locking its real owner
   * out), claiming would take over somebody else's; and an answer that depended
   * on whether an account exists would let a directory admin probe which
   * addresses are in i10.
   */
  if (!onLiveDomain(email, await d.store.liveDomains(t)))
    return conflicted(d, row, "domain_not_verified")
  const orgId = await d.identity.workspaceOrg(t)
  if (!orgId) return { outcome: "skipped", action: "workspace_gone" }
  /*
   * ⚠ NOBODY IS PUT UNDER MANAGEMENT WITHOUT A WAY IN. A managed account loses
   * its password and every other sign-in, and the gateway sends it to the IdP;
   * with no ACTIVE connection covering the address there is no IdP to send it
   * to, and the person would be locked out of i10 entirely. Their row waits as
   * a conflict until a connection goes live (a push or the console's retry).
   */
  const ssoReady = onLiveDomain(email, await d.identity.coveredDomains(t))
  if (!row.clerkUserId && !ssoReady) return conflicted(d, row, "no_sso_connection")

  const linkedBefore = row.clerkUserId !== null
  let created = false
  let user: ClerkUserSnapshot | null = null
  if (row.clerkUserId) {
    user = await d.clerk.user(row.clerkUserId)
    // ⚠ NEVER MADE AGAIN ON OUR OWN: the row stays linked to the account that
    // is gone, so the next push finds it gone again rather than a new person.
    if (!user) return conflicted(d, row, "account_deleted")
  } else {
    const found = await findOrCreate(d, row, email)
    if ("conflict" in found) return conflicted(d, row, found.conflict)
    user = found.user
    created = found.created
  }

  const managed = await d.identity.managedByUser(user.id)
  if (managed && managed.tenantId !== t) return conflicted(d, row, "managed_elsewhere")
  if (!managed && !ssoReady) return conflicted(d, row, "no_sso_connection")
  /*
   * ⚠ AN OWNER OR ADMIN IS TAKEN OVER ONLY THROUGH A LINK THAT ALREADY EXISTS
   * (decision 7). A row that is not linked yet, or whose account is not managed
   * by this workspace, never claims one: whoever runs the directory could
   * otherwise make themselves the workspace's owner's keeper by pushing their
   * address.
   */
  if ((!linkedBefore || !managed) && (await d.isExempt(t, user.id)))
    return conflicted(d, row, "role_exempt")
  if (user.banned) {
    // ⚠ A BAN THAT IS NOT OURS WINS (sso.md 2.7); one we placed is lifted.
    const ours = row.bannedByDirectory || (await d.store.bannedByDirectory(t, user.id))
    if (!ours) return conflicted(d, row, "banned")
    await d.provisioning.unban(user.id)
    await d.store.setBannedByDirectory(t, user.id, false)
    await d.identity.record(t, {
      type: "scim.unbanned",
      subjectUserId: user.id,
      data: { directoryId: row.directoryId, directoryUserId: row.id },
    })
    user = { ...user, banned: false }
  }
  if (!linkedBefore && (await d.store.linkUser(t, row.id, user.id)) === "taken")
    return conflicted(d, row, "already_linked")

  // ── The address and the names ──
  const addressed = await bringAddress(d, row, email, user, linkedBefore)
  if ("conflict" in addressed) return conflicted(d, row, addressed.conflict)
  user = addressed.user
  const names = profileChanges(user, {
    givenName: row.givenName,
    familyName: row.familyName,
  })
  if (names) {
    await d.clerk.updateProfile(user.id, names)
    await d.identity.record(t, {
      type: "scim.profile_updated",
      subjectUserId: user.id,
      data: { directoryId: row.directoryId, directoryUserId: row.id },
    })
  }

  // ── Managed, before anything can fail the membership ──
  const claim = await manage(d, row, user, email, managed)
  if (claim === "elsewhere") return conflicted(d, row, "managed_elsewhere")

  // ── The membership ──
  const member = await d.isMember(orgId, user.id)
  if (!member) {
    const room = await d.seats(t, orgId)
    /*
     * ⚠ THE DEFAULT ROLE, AND NOTHING ELSE. Group rules (#341) belong to an SSO
     * connection and a directory is not tied to one, so the person's role comes
     * from the rules of the connection they sign in through, at their first
     * sign-in there.
     */
    const joined = room.full
      ? "full"
      : await d.join({ tenantId: t, orgId, userId: user.id, role: DEFAULT_ROLE })
    if (joined === "full") {
      // ⚠ ACCEPTED, AND ON THE WAITING LIST: an error would make the IdP retry
      // and flag the app for something its admins settle (sso.md 2.7).
      await d.store.fileWaitlist(t, { userId: user.id, email })
      return conflicted(d, row, "workspace_full")
    }
    await d.identity.record(t, {
      type: "scim.member_added",
      subjectUserId: user.id,
      data: { directoryId: row.directoryId, directoryUserId: row.id },
    })
  }
  await d.store.closeWaitlist(t, user.id, true)
  /*
   * ⚠ THE MAILBOX ONLY FOR SOMEBODY WHO IS IN, MANAGED AND A MEMBER - the
   * `workspace_full` and every earlier refusal returned above. A person the
   * directory brought back gets their suspended mailbox back unchanged.
   */
  await mailForActive(d.mail, {
    row,
    userId: user.id,
    primary: email,
    createMailboxes: row.createMailboxes,
  })
  await settleConflict(d, row, null)
  d.forget({ userId: user.id })
  return {
    outcome: "applied",
    action: created ? "created" : claim === "created" ? "claimed" : "updated",
  }
}

/**
 * The Clerk account for an unlinked row: the one verified holder of the
 * address, or a new one when nobody holds it at all.
 *
 * ⚠ AT MOST TWICE, AS THE BRIDGE'S RESOLVE. `taken` from Clerk means an account
 * for the address appeared while we looked (another directory's job, the
 * person signing up); the second pass finds it as a holder and never creates.
 */
async function findOrCreate(
  d: DirectoryDeps,
  row: DirectoryUserRow,
  email: string,
): Promise<
  { user: ClerkUserSnapshot; created: boolean } | { conflict: DirectoryConflict }
> {
  for (let pass = 0; pass < 2; pass++) {
    const all = await d.clerk.usersByEmail(email)
    const holders = all.filter((u) =>
      u.emails.some((e) => e.verified && e.address.toLowerCase() === email),
    )
    if (holders.length > 1) return { conflict: "ambiguous_account" }
    if (holders.length === 1) return { user: holders[0]!, created: false }
    // Held, but not verified: claiming needs it verified, and Clerk would refuse a new one.
    if (all.length > 0) return { conflict: "address_taken" }

    // ⚠ NO NAME, NO ACCOUNT, AND NO CLERK CALL: nothing is made up from the address.
    const firstName = readName(row.givenName)
    const lastName = readName(row.familyName)
    if (!firstName || !lastName) return { conflict: "profile_incomplete" }
    const made = await d.provisioning.createUser({
      email,
      firstName,
      lastName,
      externalId: row.id,
    })
    if (made.outcome === "incomplete") return { conflict: "profile_incomplete" }
    if (made.outcome === "taken") continue
    const user = await d.clerk.user(made.id)
    if (!user) throw new Error("clerk does not know the user it just made")
    await d.identity.record(row.tenantId, {
      type: "scim.account_created",
      subjectUserId: made.id,
      data: { directoryId: row.directoryId, directoryUserId: row.id },
    })
    return { user, created: true }
  }
  return { conflict: "address_taken" }
}

/**
 * A rename: the account must hold the directory's address, verified and
 * primary. The address passed the domain and block-list checks already; here
 * nobody else may hold it.
 */
async function bringAddress(
  d: DirectoryDeps,
  row: DirectoryUserRow,
  email: string,
  user: ClerkUserSnapshot,
  linkedBefore: boolean,
): Promise<{ user: ClerkUserSnapshot } | { conflict: DirectoryConflict }> {
  const held = user.emails.find((e) => e.verified && e.address.toLowerCase() === email)
  if (held) {
    if (linkedBefore && user.primaryEmailId !== held.id)
      await d.provisioning.makePrimary(user.id, held.id)
    return { user }
  }
  const others = (await d.clerk.usersByEmail(email)).filter((u) => u.id !== user.id)
  if (others.length > 0) return { conflict: "address_taken" }
  if ((await d.provisioning.addPrimaryEmail(user.id, email)) === "taken")
    return { conflict: "address_taken" }
  const renamed = await d.clerk.user(user.id)
  if (!renamed) throw new Error("clerk lost a user it just changed")
  await d.identity.record(row.tenantId, {
    type: "scim.email_changed",
    subjectUserId: user.id,
    data: { directoryId: row.directoryId, directoryUserId: row.id },
  })
  return { user: renamed }
}

/**
 * Makes (or keeps) the account managed by this workspace and takes every other
 * way in away from it, as the bridge's `manage` does - without a connection:
 * the first SSO sign-in sets it.
 *
 * ⚠ A NEWLY MANAGED ACCOUNT LOSES EVERY SESSION IT HAD before anyone signs in
 * through the IdP: those sessions never passed it.
 */
async function manage(
  d: DirectoryDeps,
  row: DirectoryUserRow,
  user: ClerkUserSnapshot,
  email: string,
  existing: ManagedRow | null,
): Promise<"created" | "kept" | "elsewhere"> {
  const t = row.tenantId
  const keep = verifiedAddresses(
    user,
    existing ? [email, ...existing.emails] : null,
    email,
  )
  const claimed = await d.identity.claimManaged(t, {
    clerkUserId: user.id,
    tenantId: t,
    connectionId: null,
    reason: "scim",
    emails: keep,
  })
  if (claimed === "elsewhere") return claimed
  if (claimed === "created") {
    for (const session of await d.clerk.activeSessions(user.id))
      await d.clerk.revokeSession(session.id)
    await d.identity.record(t, {
      type: "managed.claimed",
      subjectUserId: user.id,
      reason: "scim",
      data: { directoryId: row.directoryId, directoryUserId: row.id, notified: false },
    })
  } else await d.identity.setManagedEmails(t, user.id, keep)
  const deps: ManagedDeps = { store: d.identity, clerk: d.clerk, log: d.log }
  await enforceManaged(
    deps,
    { tenantId: t, clerkUserId: user.id, emails: keep },
    "scim",
  )
  return claimed
}

// ── Inactive or deleted ─────────────────────────────────────────────────────

/**
 * A person the directory switched off, or deleted: out of the workspace by the
 * same primitive an admin's deprovision uses, unless another enabled directory
 * still says they are active.
 *
 * ⚠ ONLY PEOPLE THIS WORKSPACE MANAGES. A directory takes out the accounts it
 * (or SSO) put under management; an account nobody claimed is not its to
 * remove.
 *
 * ⚠ THE LAST OWNER STAYS, AND STAYS VISIBLE: `last_owner` on the row, the row
 * kept even when the directory deleted it.
 */
async function deactivate(
  d: DirectoryDeps,
  row: DirectoryUserRow,
): Promise<ApplyOutcome> {
  const t = row.tenantId
  const deleted = row.deletedAt !== null
  const done = async (
    action: "deprovisioned" | "kept_by_other_directory" | "nothing_to_do",
    keepRow = false,
  ): Promise<ApplyOutcome> => {
    if (deleted && !keepRow) {
      await d.store.purgeUser(t, row.id)
      return { outcome: "applied", action: "purged" }
    }
    if (deleted) return { outcome: "applied", action: "retained" }
    await settleConflict(d, row, null)
    return { outcome: "applied", action }
  }
  const userId = row.clerkUserId
  if (!userId) return done("nothing_to_do")

  // ⚠ ACTIVE WHILE ANY ENABLED DIRECTORY SAYS ACTIVE (sso.md 2.7).
  if ((await d.store.personStatus(t, userId, row.id)) === "active")
    return done("kept_by_other_directory")

  const before = await d.clerk.user(userId)
  if (!before) {
    // ⚠ A USER CLERK NO LONGER KNOWS STILL HAS A ROW THE `user.deleted` WEBHOOK HAS
    // NOT REMOVED YET, and a password authd cached for it opens that mailbox until
    // it does. Closed here, as for anybody the directory switches off.
    await closeMailbox(d, row, userId)
    await d.identity.forgetUser(t, userId)
    d.forget({ userId })
    await d.store.closeWaitlist(t, userId, false)
    return done("deprovisioned")
  }
  const result = await deprovision(d.deprovision, {
    tenantId: t,
    clerkUserId: userId,
    actorUserId: null,
    cause: "scim",
  })
  switch (result.outcome) {
    case "membership":
      // The identity links go with a deleted person, or their next sign-in would find the old one.
      if (deleted) await d.identity.forgetUser(t, userId)
      break
    case "account":
      // ⚠ A BAN THAT WAS THERE BEFORE IS NOT OURS TO LIFT LATER.
      if (!before.banned) {
        await d.store.setBannedByDirectory(t, userId, true)
        if (deleted) {
          d.forget({ userId })
          await d.store.closeWaitlist(t, userId, false)
          return done("deprovisioned", true)
        }
      }
      break
    case "not_managed":
    case "workspace_gone":
      // ⚠ NOT OURS TO RELEASE OR BAN, BUT THE MAILBOX IS. `deprovision` returns
      // before it suspends for somebody this workspace does not manage - one who
      // was never claimed, was released earlier, or is managed by another
      // workspace - and the directory has said the person is off. Without this
      // their mailbox in THIS workspace kept its login.
      await closeMailbox(d, row, userId)
      break
    case "last_owner":
      await settleConflict(d, row, "last_owner")
      return deleted
        ? { outcome: "applied", action: "retained", conflict: "last_owner" }
        : { outcome: "applied", action: "conflict", conflict: "last_owner" }
    default:
      // `unconfirmed` is Clerk not answering; `forbidden` and `owner_only` cannot
      // happen with the workspace itself as the actor. Retried either way.
      throw new Error(`deprovisioning was refused: ${result.outcome}`)
  }
  await d.store.closeWaitlist(t, userId, false)
  d.forget({ userId })
  return done("deprovisioned")
}

/**
 * Suspends the person's mailbox in this workspace and takes them off its lists,
 * for a deactivation that `deprovision` did not carry out (it does both itself
 * when it does). Idempotent: a mailbox already suspended is left as it is.
 */
async function closeMailbox(
  d: DirectoryDeps,
  row: DirectoryUserRow,
  userId: string,
): Promise<void> {
  const mailbox = await d.deprovision.mail.suspend({
    tenantId: row.tenantId,
    clerkUserId: userId,
    actorUserId: null,
    cause: "scim",
  })
  await d.deprovision.mail.leaveLists(row.tenantId, userId)
  if (mailbox === "suspended")
    await d.identity.record(row.tenantId, {
      type: "mailbox.suspended_unmanaged",
      subjectUserId: userId,
      reason: "directory_inactive",
      data: { directoryId: row.directoryId, directoryUserId: row.id },
    })
}

// ── The bridge ──────────────────────────────────────────────────────────────

/**
 * `BridgeDeps.preProvisioned` (#342): the Clerk account a directory made or
 * claimed for this subject, so the first SSO sign-in finds the person the
 * directory provisioned instead of claiming by address.
 *
 *   - A subject match (`externalId` or `userName`) beats an address match.
 *   - Several different accounts for one subject are refused as no match, never
 *     guessed at (the bridge then goes on as for anybody unknown).
 *   - A person the directory knows and says is inactive is `deprovisioned`: the
 *     sign-in is refused, because membership-mode deprovisioning releases the
 *     managed row, and claiming by address or JIT would put them straight back.
 */
export function directoryPreProvisioned(d: { store: DirectoryStore; log: Logger }) {
  return async (ctx: ResolveContext): Promise<string | null | "deprovisioned"> => {
    const rows = await d.store.provisioned(ctx.tenantId, {
      subject: ctx.assertion.subject,
      email: ctx.email,
    })
    const bySubject = rows.filter((r) => r.by === "subject")
    const pool = bySubject.length > 0 ? bySubject : rows
    const active = pool.filter((r) => r.active)
    if (active.length === 0) return pool.length > 0 ? "deprovisioned" : null
    const accounts = new Set(
      active.map((r) => r.clerkUserId).filter((id): id is string => id !== null),
    )
    if (accounts.size > 1) {
      d.log.warn(
        { tenantId: ctx.tenantId, accounts: accounts.size },
        "a directory subject matches several accounts - not used",
      )
      return null
    }
    return [...accounts][0] ?? null
  }
}

/** `BridgeDeps.deprovisioned`: every enabled directory that knows the account says it is off. */
export function directoryDeprovisioned(d: { store: DirectoryStore }) {
  return async (tenantId: string, clerkUserId: string): Promise<boolean> =>
    (await d.store.personStatus(tenantId, clerkUserId)) === "inactive"
}

// ── Scheduling and the kick ─────────────────────────────────────────────────

/** Adds one job to the queue. `bucket` tells a re-kick's job id from the first one's. */
export type Enqueue = (
  job: ApplyJob & { entryId: string },
  bucket: number | null,
) => Promise<void>

/**
 * Schedules the entries a write just committed.
 *
 * ⚠ AFTER THE COMMIT, AND A FAILURE HERE IS NOT THE REQUEST'S. The entries are
 * in the database; if Redis cannot be reached the request still succeeded, the
 * failure is logged, and the kick finds the entries later.
 */
export async function scheduleEntries(
  d: { enqueue: Enqueue; log: Logger },
  tenantId: string,
  entries: readonly OutboxEntry[],
): Promise<void> {
  for (let i = 0; i < entries.length; i += 100) {
    const results = await Promise.allSettled(
      entries
        .slice(i, i + 100)
        .map((e) =>
          d.enqueue(
            { tenantId, directoryUserId: e.directoryUserId, entryId: e.id },
            null,
          ),
        ),
    )
    const failed = results.filter((r) => r.status === "rejected").length
    if (failed > 0)
      d.log.error(
        { tenantId, failed },
        "could not schedule directory entries - the kick will find them",
      )
  }
}

/** An entry waits this long before a kick takes it for lost. */
export const KICK_AFTER_MS = 30_000
/** A directory is kicked at most this often by SCIM traffic. */
export const KICK_EVERY_MS = 60_000
const KICK_LIMIT = 100

/**
 * Re-schedules a directory's entries that nobody applied: the ones whose job
 * was lost (Redis down at write time), failed until the queue gave up, or were
 * skipped while the directory was disabled. A kick also retries the people the
 * workspace was too full for (`workspace_full`), once `room` says there is a
 * free seat - oldest waiting first, at most `KICK_LIMIT` a kick.
 *
 * ⚠ THERE IS NO SWEEPER ACROSS WORKSPACES - that would need a role that reads
 * every tenant. A directory is kicked when it talks to us (throttled, per
 * process) and when its admins look at it or enable it (`force`).
 *
 * ⚠ THE JOB ID CARRIES A MINUTE BUCKET. groupmq dedupes by job id and keeps
 * failed jobs, so a re-kick under the original id would be dropped as a
 * duplicate of the one that gave up.
 */
export function directoryKicker(d: {
  store: DirectoryStore
  enqueue: Enqueue
  log: Logger
  /** Whether the workspace has a free seat now. Asked once a kick, only when someone waits. */
  room?: (tenantId: string) => Promise<boolean>
  now?: () => Date
}) {
  const last = new Map<string, number>()
  /** Looks again at the people parked as `workspace_full`, if a seat is free. */
  const retryWaiting = async (
    tenantId: string,
    directoryId: string,
    bucket: number,
  ): Promise<number> => {
    if (!d.room) return 0
    try {
      // `conflicts` is newest first; the longest wait goes first.
      const waiting = (await d.store.conflicts(tenantId, directoryId))
        .filter((u) => u.conflict === "workspace_full")
        .reverse()
        .slice(0, KICK_LIMIT)
      if (waiting.length === 0 || !(await d.room(tenantId))) return 0
      const results = await Promise.allSettled(
        waiting.map(async (u) => {
          const entry = await d.store.requeue(tenantId, directoryId, u.id)
          if (!entry) return false
          await d.enqueue(
            { tenantId, directoryUserId: entry.directoryUserId, entryId: entry.id },
            bucket,
          )
          return true
        }),
      )
      const failed = results.filter((r) => r.status === "rejected").length
      if (failed > 0)
        d.log.error(
          { tenantId, directoryId, failed },
          "a directory kick could not retry the waiting list",
        )
      return results.filter((r) => r.status === "fulfilled" && r.value).length
    } catch (error) {
      d.log.error(
        { ...safeError(error), tenantId, directoryId },
        "a directory kick could not retry the waiting list",
      )
      return 0
    }
  }
  return async (
    tenantId: string,
    directoryId: string,
    options: { force?: boolean } = {},
  ): Promise<number> => {
    const now = clock(d).getTime()
    if (!options.force) {
      const at = last.get(directoryId)
      if (at !== undefined && now - at < KICK_EVERY_MS) return 0
    }
    if (last.size > 10_000) last.delete(last.keys().next().value!)
    last.set(directoryId, now)
    try {
      const entries = await d.store.pending(
        tenantId,
        directoryId,
        new Date(now - KICK_AFTER_MS),
        KICK_LIMIT,
      )
      const bucket = Math.floor(now / 60_000)
      const results = await Promise.allSettled(
        entries.map((e) =>
          d.enqueue(
            { tenantId, directoryUserId: e.directoryUserId, entryId: e.id },
            bucket,
          ),
        ),
      )
      const failed = results.filter((r) => r.status === "rejected").length
      if (failed > 0)
        d.log.error({ tenantId, directoryId, failed }, "a directory kick failed")
      return (
        entries.length - failed + (await retryWaiting(tenantId, directoryId, bucket))
      )
    } catch (error) {
      d.log.error(
        { ...safeError(error), tenantId, directoryId },
        "a directory kick failed",
      )
      return 0
    }
  }
}
