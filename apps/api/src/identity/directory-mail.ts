import type { DirectoryUserRow } from "./directory-ports.js"
import { normaliseEmail } from "./model.js"
import type { AuditEvent, Logger } from "./ports.js"
import type { DirectoryMailboxOutcome } from "../mailboxes/provision.js"
import type { GroupMailStore } from "./mail-store.js"

/**
 * Mail from the directory (#344 slice B, sso.md 2.8): the mailbox of a person
 * a directory provisions, its aliases, directory groups as lists, and what
 * happens to the mailbox when the directory switches the person off.
 *
 * ⚠ THE DIRECTORY ASKS; THE WORKSPACE'S DOMAINS DECIDE. Nothing here makes an
 * address that is not on a domain this workspace proved and hosts mail for: the
 * primary, every alias and every list address go through `hostedBy`, and the
 * answer must be THIS tenant. A directory's admin can therefore never make a
 * mailbox on somebody else's domain, or on i10's own.
 *
 * ⚠ NOTHING IS DELETED IMMEDIATELY. Deprovisioning SUSPENDS: the login is
 * refused, mail keeps arriving and is kept. Deleting is a date at least seven
 * days out that an admin chose, re-checked against the directories when it
 * arrives (`runDeletion`).
 */

export const LEAVER_MIN_DAYS = 7
export const LEAVER_MAX_DAYS = 365
const DAY_MS = 24 * 60 * 60 * 1000

export type LeaverAction = "keep" | "forward_manager" | "delete_after"
/** What a suspended mailbox does next. Only an admin's pick or the workspace default sets it. */
export type MailboxNext = "keep" | "forward_manager" | "delegate" | "delete"

export interface MailboxRow {
  tenantId: string
  clerkUserId: string
  address: string
  state: "active" | "suspended"
  suspendedAt: Date | null
  next: MailboxNext
  targetUserId: string | null
  deleteAfterDays: number | null
  deleteAt: Date | null
}

/** Where a suspended mailbox is going: what the row and the authd routes are set to. */
export interface Plan {
  next: MailboxNext
  /** Forward: who gets a copy. Delegate: who may open it. */
  targetUserId: string | null
  /** The recipient's address, for the forward route. */
  targetAddress: string | null
  days: number | null
  deleteAt: Date | null
}

export const KEEP: Plan = {
  next: "keep",
  targetUserId: null,
  targetAddress: null,
  days: null,
  deleteAt: null,
}

/** What the person's row says about their manager, before we judge it. */
export type ManagerRead =
  | { status: "none" }
  | {
      status: "found"
      clerkUserId: string | null
      /** Active in an enabled directory, not deleted. */
      active: boolean
      /** The manager's mailbox address in this workspace, if they have one. */
      address: string | null
      suspended: boolean
    }

export type MailboxNote = "domain_not_hosted" | "limit" | "address_taken"

export interface DirectoryMailStore {
  /** The tenant owning a verified, mail-hosting domain, or null. */
  hostedBy(domain: string): Promise<string | null>
  leaverDefault(
    tenantId: string,
  ): Promise<{ action: LeaverAction; days: number | null }>
  setLeaverDefault(
    tenantId: string,
    input: { action: LeaverAction; days: number | null; by: string },
    audit: AuditEvent,
  ): Promise<void>
  mailbox(tenantId: string, clerkUserId: string): Promise<MailboxRow | null>
  mailboxes(tenantId: string): Promise<MailboxRow[]>
  /** The person's mailbox as the projection has it (this workspace's only). */
  account(
    tenantId: string,
    clerkUserId: string,
  ): Promise<{ address: string; suspended: boolean } | null>
  /** The lifecycle row of an active mailbox. */
  recordActive(tenantId: string, clerkUserId: string, address: string): Promise<void>
  /**
   * Suspends the authd account and writes the row, the routes and the audit
   * event in ONE transaction. `already`: it was suspended (nothing changes, the
   * clock does not restart). `no_mailbox`: this workspace gave them none.
   */
  suspend(
    tenantId: string,
    clerkUserId: string,
    plan: Plan,
    at: Date,
    audit: AuditEvent,
  ): Promise<"suspended" | "already" | "no_mailbox">
  /** Lifts it, clears the plan and the routes. `none`: it was not suspended. */
  resume(
    tenantId: string,
    clerkUserId: string,
    audit: AuditEvent,
  ): Promise<"resumed" | "none">
  /** Changes what a SUSPENDED mailbox does next. `not_suspended`: refused. */
  choose(
    tenantId: string,
    clerkUserId: string,
    plan: Plan,
    audit: AuditEvent,
  ): Promise<"ok" | "not_suspended">
  /**
   * Deletes a suspended mailbox whose date has passed: the account, its
   * aliases, its routes and the row, with the audit event. Checks the date
   * itself, in the database, so a clock that is wrong here deletes nothing.
   */
  remove(
    tenantId: string,
    clerkUserId: string,
    at: Date,
    audit: AuditEvent,
  ): Promise<"deleted" | "not_due" | "not_scheduled">
  /** Mailboxes whose deletion date has passed (for the backup run). */
  due(tenantId: string, at: Date): Promise<MailboxRow[]>
  manager(tenantId: string, clerkUserId: string): Promise<ManagerRead>
  /** Sets the aliases a directory gives and says what it could not. */
  setAliases(
    tenantId: string,
    clerkUserId: string,
    wanted: readonly string[],
    audit: (added: string[], removed: string[]) => AuditEvent,
  ): Promise<{ taken: string[] }>
  noteAliases(tenantId: string, directoryUserId: string, ignored: number): Promise<void>
  /** True when it changed. */
  setNote(
    tenantId: string,
    directoryUserId: string,
    note: MailboxNote | null,
  ): Promise<boolean>
  /** Brings the person's seats on directory lists to what the directories say. */
  syncLists(
    tenantId: string,
    clerkUserId: string,
  ): Promise<{ added: number; removed: number }>
}

export interface DirectoryMailDeps {
  store: DirectoryMailStore
  /** `provisionForDirectory`, with its Clerk, projection and capacity wired. */
  provision(input: {
    tenantId: string
    userId: string
  }): Promise<DirectoryMailboxOutcome>
  isMember(tenantId: string, userId: string): Promise<boolean>
  /** Whether ANY enabled directory of the workspace says the person is active. */
  directoryActive(tenantId: string, userId: string): Promise<boolean>
  /** Puts the deletion on the queue for its date; a failure is not the caller's. */
  scheduleDeletion(
    job: { tenantId: string; clerkUserId: string; dueAt: number },
    at: Date,
  ): Promise<void>
  /** The identity audit log (`IdentityStore.record`). */
  record(tenantId: string, event: AuditEvent): Promise<void>
  log: Logger
  now?: () => Date
}

const clock = (d: { now?: () => Date }) => (d.now ?? (() => new Date()))()
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1)

// ── Aliases ─────────────────────────────────────────────────────────────────

/**
 * The directory's other addresses (`emails[]`) split by what we may do with
 * them: only an address on a domain THIS workspace hosts mail for becomes an
 * alias; every other one is ignored and counted.
 *
 * ⚠ AN ALIAS IS A RECIPIENT. Mail for the address is delivered to the person,
 * so an address on a domain the workspace does not host would swallow another
 * organisation's mail (the same trap `projectUser` guards).
 */
export async function aliasesOf(
  tenantId: string,
  resource: Record<string, unknown>,
  primary: string,
  hostedBy: (domain: string) => Promise<string | null>,
): Promise<{ keep: string[]; ignored: number }> {
  const listed = Array.isArray(resource.emails) ? resource.emails : []
  const seen = new Set<string>()
  let ignored = 0
  const keep: string[] = []
  const owners = new Map<string, Promise<string | null>>()
  for (const entry of listed) {
    const value = (entry as { value?: unknown } | null)?.value
    const address = typeof value === "string" ? normaliseEmail(value) : null
    if (address === primary) continue
    if (address === null) {
      ignored++
      continue
    }
    if (seen.has(address)) continue
    seen.add(address)
    const domain = domainOf(address)
    if (!owners.has(domain)) owners.set(domain, hostedBy(domain))
    if ((await owners.get(domain)) === tenantId) keep.push(address)
    else ignored++
  }
  return { keep, ignored }
}

// ── A person who is active ──────────────────────────────────────────────────

/**
 * Gives the person their mailbox (when the directory asks for it), its
 * aliases, and their seats on the lists; and lifts a suspension if there was
 * one. Called by the apply job after the membership is settled.
 *
 * ⚠ A SUSPENDED MAILBOX COMES BACK WHETHER OR NOT THE DIRECTORY ASKS FOR NEW
 * ONES. The opt-in is about CREATING mailboxes; a person the directory brings
 * back gets the mailbox they had, unchanged, even if the opt-in has since been
 * turned off.
 */
export async function mailForActive(
  d: DirectoryMailDeps,
  input: {
    row: DirectoryUserRow
    userId: string
    primary: string
    createMailboxes: boolean
  },
): Promise<void> {
  const t = input.row.tenantId
  const resumed = await d.store.resume(t, input.userId, {
    type: "mailbox.resumed",
    subjectUserId: input.userId,
    reason: "directory",
    data: { directoryId: input.row.directoryId, directoryUserId: input.row.id },
  })
  if (resumed === "resumed")
    d.log.info(
      { tenantId: t, userId: input.userId },
      "a reactivated person's mailbox is back",
    )
  if (input.createMailboxes) {
    const made = await d.provision({ tenantId: t, userId: input.userId })
    const note =
      made.status === "domain_not_hosted" ||
      made.status === "address_taken" ||
      made.status === "limit"
        ? made.status
        : null
    // Audited when it CHANGES, so a directory that pushes the same person
    // every forty minutes does not fill the log.
    if (await d.store.setNote(t, input.row.id, note))
      await d.record(t, {
        type: note ? "mailbox.refused" : "mailbox.refusal_cleared",
        subjectUserId: input.userId,
        reason: note,
        data: { directoryId: input.row.directoryId, directoryUserId: input.row.id },
      })
    if (made.status === "created")
      await d.record(t, {
        type: "mailbox.created",
        subjectUserId: input.userId,
        data: {
          directoryId: input.row.directoryId,
          directoryUserId: input.row.id,
          address: made.address,
        },
      })
    if (made.status === "created" || made.status === "exists") {
      await d.store.recordActive(t, input.userId, made.address)
      const wanted = await aliasesOf(t, input.row.resource, made.address, (domain) =>
        d.store.hostedBy(domain),
      )
      const { taken } = await d.store.setAliases(
        t,
        input.userId,
        wanted.keep,
        (added, removed) => ({
          type: "mailbox.aliases_changed",
          subjectUserId: input.userId,
          data: {
            directoryId: input.row.directoryId,
            directoryUserId: input.row.id,
            added,
            removed,
          },
        }),
      )
      await d.store.noteAliases(t, input.row.id, wanted.ignored + taken.length)
    }
  }
  await d.store.syncLists(t, input.userId)
}

// ── Who a suspended mailbox's mail may go to ────────────────────────────────

export type TargetRefusal =
  | "no_manager"
  | "manager_not_active"
  | "manager_not_member"
  | "manager_not_hosted"
  | "delegate_not_member"
  | "delegate_no_mailbox"
  | "delegate_is_self"

/**
 * The person's manager as a forward target, or why not.
 *
 * ⚠ ONLY A MANAGER WHO IS, RIGHT NOW, ACTIVE IN AN ENABLED DIRECTORY, AN ACTIVE
 * MEMBER OF THE WORKSPACE, AND HOLDS A MAILBOX ON A DOMAIN THE WORKSPACE HOSTS.
 * The manager is a string the directory sent (`manager.value`); a copy of a
 * leaver's mail sent to someone who has left, or who is not in the workspace,
 * or whose address is elsewhere, would be mail leaving the company.
 */
export async function managerTarget(
  d: DirectoryMailDeps,
  tenantId: string,
  leaverId: string,
): Promise<{ userId: string; address: string } | { refused: TargetRefusal }> {
  const read = await d.store.manager(tenantId, leaverId)
  if (read.status === "none" || !read.clerkUserId || read.clerkUserId === leaverId)
    return { refused: "no_manager" }
  if (!read.active || read.suspended) return { refused: "manager_not_active" }
  if (!(await d.isMember(tenantId, read.clerkUserId)))
    return { refused: "manager_not_member" }
  if (!read.address || (await d.store.hostedBy(domainOf(read.address))) !== tenantId)
    return { refused: "manager_not_hosted" }
  return { userId: read.clerkUserId, address: read.address }
}

/** A named member as a delegate, or why not. */
export async function delegateTarget(
  d: DirectoryMailDeps,
  tenantId: string,
  leaverId: string,
  delegateId: string,
): Promise<{ userId: string; address: string } | { refused: TargetRefusal }> {
  if (delegateId === leaverId) return { refused: "delegate_is_self" }
  if (!(await d.isMember(tenantId, delegateId)))
    return { refused: "delegate_not_member" }
  const account = await d.store.account(tenantId, delegateId)
  if (!account || account.suspended) return { refused: "delegate_no_mailbox" }
  return { userId: delegateId, address: account.address }
}

const deletion = (days: number, at: Date): Plan => ({
  next: "delete",
  targetUserId: null,
  targetAddress: null,
  days,
  deleteAt: new Date(at.getTime() + days * DAY_MS),
})

// ── Deprovisioning ──────────────────────────────────────────────────────────

/**
 * The deprovisioning primitive's mailbox half (decision 5): the mailbox is
 * SUSPENDED, then goes where the workspace's default says.
 *
 * ⚠ A DEFAULT THAT CANNOT BE CARRIED OUT FALLS BACK TO `keep`, AND SAYS SO.
 * "Forward to the manager" with no active manager on a hosted domain is not an
 * error to retry forever and not a reason to leave the login open: the mailbox
 * is suspended and kept, and the audit event names why the forward was not made.
 *
 * ⚠ IDEMPOTENT: a retried deprovision finds it suspended and changes nothing,
 * so the deletion clock is never restarted.
 */
export async function suspendMailbox(
  d: DirectoryMailDeps,
  input: {
    tenantId: string
    clerkUserId: string
    actorUserId: string | null
    cause: string
  },
): Promise<"suspended" | "already" | "no_mailbox"> {
  const t = input.tenantId
  const at = clock(d)
  const policy = await d.store.leaverDefault(t)
  let plan = KEEP
  let refused: TargetRefusal | null = null
  if (policy.action === "delete_after" && policy.days !== null)
    plan = deletion(policy.days, at)
  else if (policy.action === "forward_manager") {
    const manager = await managerTarget(d, t, input.clerkUserId)
    if ("refused" in manager) refused = manager.refused
    else
      plan = {
        next: "forward_manager",
        targetUserId: manager.userId,
        targetAddress: manager.address,
        days: null,
        deleteAt: null,
      }
  }
  const outcome = await d.store.suspend(t, input.clerkUserId, plan, at, {
    type: "mailbox.suspended",
    actorUserId: input.actorUserId,
    subjectUserId: input.clerkUserId,
    reason: input.cause,
    data: {
      next: plan.next,
      ...(plan.targetUserId ? { targetUserId: plan.targetUserId } : {}),
      ...(plan.deleteAt ? { deleteAt: plan.deleteAt.toISOString() } : {}),
      ...(refused ? { forwardRefused: refused } : {}),
    },
  })
  if (outcome === "suspended" && plan.deleteAt)
    await scheduleDeletion(d, input, plan.deleteAt)
  return outcome
}

async function scheduleDeletion(
  d: DirectoryMailDeps,
  input: { tenantId: string; clerkUserId: string },
  at: Date,
): Promise<void> {
  try {
    await d.scheduleDeletion(
      { tenantId: input.tenantId, clerkUserId: input.clerkUserId, dueAt: at.getTime() },
      at,
    )
  } catch (error) {
    // ⚠ NOT THE CALLER'S FAILURE: the date is in the database, and `runDue`
    // (the console's backup run) finds it. A lost job deletes LATE, never early.
    d.log.error(
      {
        tenantId: input.tenantId,
        error: error instanceof Error ? error.name : "error",
      },
      "could not schedule a mailbox deletion - the backup run will find it",
    )
  }
}

// ── The admin's pick ────────────────────────────────────────────────────────

export type Choice =
  | { next: "keep" }
  | { next: "forward_manager" }
  | { next: "delegate"; delegateUserId: string }
  | { next: "delete"; days: number }

export type ChooseOutcome =
  | { outcome: "ok"; next: MailboxNext }
  | { outcome: "not_suspended" }
  | { outcome: "bad_days" }
  | { outcome: "still_active" }
  | { outcome: "refused"; reason: TargetRefusal }

/**
 * What an admin decides for a suspended mailbox. Refusals are audited too.
 *
 * ⚠ ONLY A SUSPENDED MAILBOX. A live one is the person's; the only way to
 * make it suspended is the directory (or an admin's deprovision).
 *
 * ⚠ DELETE NEEDS 7 TO 365 DAYS, AND NOBODY WHOM A DIRECTORY STILL SAYS IS
 * ACTIVE. The second is also checked when the date arrives, but refusing it
 * here means the admin hears about it today.
 */
export async function chooseNext(
  d: DirectoryMailDeps,
  input: { tenantId: string; clerkUserId: string; actorUserId: string; choice: Choice },
): Promise<ChooseOutcome> {
  const t = input.tenantId
  const at = clock(d)
  const refuse = async (
    outcome: ChooseOutcome,
    why: string,
  ): Promise<ChooseOutcome> => {
    await d.record(t, {
      type: "mailbox.choice_refused",
      actorUserId: input.actorUserId,
      subjectUserId: input.clerkUserId,
      reason: why,
      data: { next: input.choice.next },
    })
    return outcome
  }
  const current = await d.store.mailbox(t, input.clerkUserId)
  if (!current || current.state !== "suspended")
    return refuse({ outcome: "not_suspended" }, "not_suspended")

  let plan: Plan = KEEP
  const choice = input.choice
  if (choice.next === "delete") {
    if (
      !Number.isInteger(choice.days) ||
      choice.days < LEAVER_MIN_DAYS ||
      choice.days > LEAVER_MAX_DAYS
    )
      return refuse({ outcome: "bad_days" }, "bad_days")
    if (await d.directoryActive(t, input.clerkUserId))
      return refuse({ outcome: "still_active" }, "still_active")
    plan = deletion(choice.days, at)
  } else if (choice.next === "forward_manager" || choice.next === "delegate") {
    const target =
      choice.next === "forward_manager"
        ? await managerTarget(d, t, input.clerkUserId)
        : await delegateTarget(d, t, input.clerkUserId, choice.delegateUserId)
    if ("refused" in target)
      return refuse({ outcome: "refused", reason: target.refused }, target.refused)
    plan = {
      next: choice.next,
      targetUserId: target.userId,
      targetAddress: target.address,
      days: null,
      deleteAt: null,
    }
  }
  const done = await d.store.choose(t, input.clerkUserId, plan, {
    type: "mailbox.next_chosen",
    actorUserId: input.actorUserId,
    subjectUserId: input.clerkUserId,
    data: {
      from: current.next,
      next: plan.next,
      ...(plan.targetUserId ? { targetUserId: plan.targetUserId } : {}),
      ...(plan.deleteAt ? { deleteAt: plan.deleteAt.toISOString() } : {}),
    },
  })
  if (done === "not_suspended") return { outcome: "not_suspended" }
  if (plan.deleteAt) await scheduleDeletion(d, input, plan.deleteAt)
  return { outcome: "ok", next: plan.next }
}

// ── Deletion ────────────────────────────────────────────────────────────────

export interface DeletionJob {
  tenantId: string
  clerkUserId: string
  /** ms since epoch: when the deletion was due when it was scheduled. */
  dueAt: number
}

export type DeletionOutcome =
  | { outcome: "deleted" }
  /** Not suspended, not scheduled, or the plan changed since this job was made. */
  | { outcome: "not_scheduled" }
  | { outcome: "early"; ms: number }
  /** A directory says the person is active: nothing is deleted. */
  | { outcome: "held_active" }

/**
 * Deletes a suspended mailbox whose date has passed.
 *
 * ⚠ THE DATE AND THE PLAN ARE READ FROM THE DATABASE, NOT THE JOB. A job is
 * only a reminder: an admin may have changed the plan since, the person may be
 * back, and a clock that disagrees must not delete early. So `early` waits,
 * `held_active` deletes nothing and leaves the mailbox suspended, and the
 * transaction in `remove` checks the date once more itself.
 */
export async function runDeletion(
  d: DirectoryMailDeps,
  job: DeletionJob,
): Promise<DeletionOutcome> {
  const t = job.tenantId
  const at = clock(d)
  const row = await d.store.mailbox(t, job.clerkUserId)
  if (!row || row.state !== "suspended" || row.next !== "delete" || !row.deleteAt)
    return { outcome: "not_scheduled" }
  if (at.getTime() < row.deleteAt.getTime())
    return { outcome: "early", ms: row.deleteAt.getTime() - at.getTime() }
  if (await d.directoryActive(t, job.clerkUserId)) {
    await d.record(t, {
      type: "mailbox.deletion_held",
      subjectUserId: job.clerkUserId,
      reason: "directory_active",
    })
    return { outcome: "held_active" }
  }
  const done = await d.store.remove(t, job.clerkUserId, at, {
    type: "mailbox.deleted",
    subjectUserId: job.clerkUserId,
    data: { days: row.deleteAfterDays },
  })
  return done === "deleted" ? { outcome: "deleted" } : { outcome: "not_scheduled" }
}

/** The backup for lost jobs: every deletion of this workspace that is due. */
export async function runDue(d: DirectoryMailDeps, tenantId: string): Promise<number> {
  let deleted = 0
  for (const row of await d.store.due(tenantId, clock(d))) {
    const done = await runDeletion(d, {
      tenantId,
      clerkUserId: row.clerkUserId,
      dueAt: row.deleteAt?.getTime() ?? 0,
    })
    if (done.outcome === "deleted") deleted++
  }
  return deleted
}

/**
 * What the deprovisioning primitive calls (managed.ts `DeprovisionDeps.mail`).
 * `leaveLists`: the person is not active any more, so they are off the lists.
 */
export interface MailboxLifecycle {
  suspend(input: {
    tenantId: string
    clerkUserId: string
    actorUserId: string | null
    cause: string
  }): Promise<"suspended" | "already" | "no_mailbox">
  leaveLists(tenantId: string, clerkUserId: string): Promise<void>
}

export function mailboxLifecycle(d: DirectoryMailDeps): MailboxLifecycle {
  return {
    suspend: (input) => suspendMailbox(d, input),
    async leaveLists(tenantId, clerkUserId) {
      await d.store.syncLists(tenantId, clerkUserId)
    },
  }
}

// ── Groups as lists ─────────────────────────────────────────────────────────

export type GroupMailOutcome =
  | "ok"
  | "not_found"
  /** The address is not on a domain this workspace hosts mail for. */
  | "address_not_hosted"
  /** The group's NAME is an address on a domain the workspace does not host. */
  | "name_not_hosted"
  | "invalid_address"
  | "taken"

/**
 * An admin opts a directory group in as a distribution list or a shared
 * mailbox, or out (`input` null).
 *
 * ⚠ NEVER A LIST FOR A GROUP WHOSE NAME OR ADDRESS IS NOT ON A HOSTED DOMAIN.
 * The address is where mail for the group is delivered, so it must be on a
 * domain THIS workspace hosts mail for. A group whose name is itself an
 * address (`all@elsewhere.com`) is refused too: a list that quietly answers to
 * another name than the one the directory shows is how a group of 400 people
 * gets mail meant for somebody else.
 *
 * ⚠ OPTING OUT NEEDS NO CHECK, so it can never be blocked by a domain that has
 * since left.
 */
export async function setGroupMail(
  d: {
    store: GroupMailStore & Pick<DirectoryMailStore, "hostedBy">
    record(tenantId: string, event: AuditEvent): Promise<void>
  },
  input: {
    tenantId: string
    directoryId: string
    groupId: string
    actorUserId: string
    mail: { address: string; kind: "list" | "shared" } | null
  },
): Promise<GroupMailOutcome> {
  const t = input.tenantId
  const refuse = async (outcome: GroupMailOutcome): Promise<GroupMailOutcome> => {
    await d.record(t, {
      type: "directory.group_mail_refused",
      actorUserId: input.actorUserId,
      reason: outcome,
      data: { directoryId: input.directoryId, groupId: input.groupId },
    })
    return outcome
  }
  const group = await d.store.group(t, input.directoryId, input.groupId)
  if (!group) return "not_found"
  let address: string | null = null
  if (input.mail) {
    address = normaliseEmail(input.mail.address)
    if (!address) return refuse("invalid_address")
    if ((await d.store.hostedBy(domainOf(address))) !== t)
      return refuse("address_not_hosted")
    const at = group.displayName.lastIndexOf("@")
    if (
      at >= 0 &&
      (await d.store.hostedBy(group.displayName.slice(at + 1).toLowerCase())) !== t
    )
      return refuse("name_not_hosted")
  }
  const done = await d.store.setGroupMail(
    t,
    input.directoryId,
    input.groupId,
    input.mail && address ? { address, kind: input.mail.kind } : null,
    {
      type: input.mail
        ? "directory.group_mail_enabled"
        : "directory.group_mail_disabled",
      actorUserId: input.actorUserId,
      data: {
        directoryId: input.directoryId,
        groupId: input.groupId,
        ...(input.mail && address ? { address, kind: input.mail.kind } : {}),
        ...(group.mailAddress ? { from: group.mailAddress } : {}),
      },
    },
  )
  return done === "taken" ? refuse("taken") : done
}
