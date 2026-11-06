import type { TeamInbox } from "@repo/contracts"
import { teamGroupName } from "../mail/team-mail.js"

/**
 * Team inboxes: a shared address a workspace's people read and send from.
 *
 * ⚠ A TEAM INBOX IS A ROW IN THE DIRECTORY, NOT A THING WE CREATE IN STALWART.
 * Stalwart delivers to an address only if `i10-authd` answers for it, and an
 * account made in Stalwart's own registry alone is refused (550). So this module
 * writes `authd.groups` and `authd.group_members` - which authd already serves
 * as a `groupOfNames` and as `memberOf` on each member - and Stalwart builds the
 * Group account from that the first time a member signs in. Nothing here talks
 * to Stalwart except `destroy`, and the unprobed parts of that are listed in
 * `mail/team-mail.ts`.
 *
 * ⚠ ACCESS IS GROUP MEMBERSHIP, NOT A PER-MAILBOX ACL. Stalwart documents two
 * ways to let several people into one mailbox: share it with each of them
 * (`Mailbox` `shareWith` / IMAP ACL), or make it a Group account whose members
 * reach it through their own sign-in. The second is chosen because membership is
 * then ONE fact in ONE table, and "add a member", "remove a member" and "delete
 * the inbox" are each one write. With per-mailbox ACLs every one of those is a
 * second system to keep equal to the first, and the failure is a removed member
 * who can still read - the direction nobody notices.
 *
 * ⚠ WHO MAY SEE WHAT IS DECIDED HERE, SERVER-SIDE. Owners and admins manage every
 * team inbox in the workspace; a member sees only the ones they belong to and can
 * change none. A team inbox a member is not in answers `null` - "not found" -
 * rather than "forbidden", so the response does not say the address exists.
 */

/** A team inbox and who is in it. */
export interface TeamInboxRow {
  /** The directory's name for it (`teamGroupName`). */
  name: string
  address: string
  displayName: string | null
  tenantId: string
  createdAt: Date
  members: { userId: string; address: string }[]
}

/** A mailbox, as the directory knows it. */
export interface MailboxAccount {
  userId: string
  address: string
  active: boolean
}

/** Thrown by `TeamInboxStore.create` when the unique constraint refuses the address. */
export class AddressTakenError extends Error {
  constructor(readonly address: string) {
    super(`${address} is already taken`)
    this.name = "AddressTakenError"
  }
}

export interface TeamInboxStore {
  /** The tenant that owns this mail domain, or null. `core.mailbox_domains()`. */
  domainOwner(domain: string): Promise<string | null>
  /** Any mailbox, alias or team inbox already holding this address. */
  addressTaken(address: string): Promise<boolean>
  /**
   * The directory's mailboxes whose PRIMARY address is one of these. An alias
   * does not name a member: the API lists people by the address they sign in with.
   */
  mailboxes(addresses: string[]): Promise<MailboxAccount[]>

  create(input: {
    tenantId: string
    name: string
    address: string
    displayName: string | null
    memberUserIds: string[]
  }): Promise<TeamInboxRow>
  /** Every team inbox of the workspace. */
  forTenant(tenantId: string): Promise<TeamInboxRow[]>
  /** The team inboxes of the workspace this person is in. */
  forMember(tenantId: string, userId: string): Promise<TeamInboxRow[]>
  find(tenantId: string, address: string): Promise<TeamInboxRow | null>
  /** Replaces the set. `null` when the workspace has no such team inbox. */
  setMembers(
    tenantId: string,
    address: string,
    memberUserIds: string[],
  ): Promise<TeamInboxRow | null>
  /** Removes the rows (members and the copy ledger go with them). */
  remove(tenantId: string, address: string): Promise<boolean>
  /** Takes one person out of every team inbox of the workspace; returns those it changed. */
  dropMember(tenantId: string, userId: string): Promise<string[]>
}

export interface TeamInboxDeps {
  store: TeamInboxStore
  /** Whether this person holds the members-manage permission in the organization. */
  isAdmin(userId: string, orgId: string): Promise<boolean>
  /** The user ids of the organization's members, from Clerk. */
  roster(orgId: string): Promise<ReadonlySet<string>>
  /** Destroys the Stalwart account for a team inbox; `false` when there is none. */
  destroyAccount(input: { name: string; address: string }): Promise<boolean>
  /**
   * Takes these members out of the team inbox's Stalwart account now.
   *
   * ⚠ THE DIRECTORY ROW ALONE DOES NOT REVOKE. Stalwart keeps a membership until
   * it next looks the account up in the directory, which an open mail client
   * may not do for hours (measured: still there after 15 minutes). So every
   * removal calls this FIRST and changes the rows second: if it fails, the
   * directory still lists the member, the request fails, and a retry does both.
   */
  revokeAccess(
    team: { name: string; address: string },
    memberAddresses: string[],
  ): Promise<void>
}

/** Who is asking: the verified session, and the workspace it is in. */
export interface Viewer {
  tenantId: string
  userId: string
  /** Absent for a person with no active organization. */
  orgId?: string | undefined
}

export type TeamInboxOutcome =
  | { status: "ok"; inbox: TeamInbox }
  | { status: "forbidden" }
  /** The workspace is not a team one, or no workspace is active. */
  | { status: "no_org" }
  | { status: "missing" }
  | { status: "conflict"; reason: string }
  /** The address, or one of the members, cannot be used. */
  | { status: "rejected"; reason: string }

export const toTeamInbox = (row: TeamInboxRow): TeamInbox => ({
  object: "team_inbox",
  address: row.address,
  display_name: row.displayName,
  members: row.members.map((m) => ({ address: m.address })),
  created_at: row.createdAt.toISOString(),
})

/** The domain half of an address, lowercased. */
const domainOf = (address: string) =>
  address.slice(address.lastIndexOf("@") + 1).toLowerCase()

export interface TeamInboxes {
  list(viewer: Viewer): Promise<TeamInbox[]>
  get(viewer: Viewer, address: string): Promise<TeamInbox | null>
  create(
    viewer: Viewer,
    input: { address: string; displayName?: string | undefined; members: string[] },
  ): Promise<TeamInboxOutcome>
  setMembers(
    viewer: Viewer,
    address: string,
    members: string[],
  ): Promise<TeamInboxOutcome>
  remove(viewer: Viewer, address: string): Promise<"ok" | "forbidden" | "missing">
  /** The workspace lost a member: they leave every team inbox. */
  onMemberRemoved(tenantId: string, userId: string): Promise<string[]>
  /** The workspace is gone: so are its team inboxes. */
  onWorkspaceDeleted(tenantId: string): Promise<string[]>
}

export function teamInboxes(deps: TeamInboxDeps): TeamInboxes {
  const { store } = deps

  const admin = async (viewer: Viewer): Promise<boolean> =>
    Boolean(viewer.orgId && (await deps.isAdmin(viewer.userId, viewer.orgId)))

  /**
   * Mailbox addresses to the people who hold them, or the reason one cannot be.
   *
   * ⚠ TWO CHECKS, AND NEITHER STANDS IN FOR THE OTHER. The directory says the
   * address is a live mailbox; Clerk says its owner is in THIS workspace. A
   * mailbox on a domain the workspace owns can belong to someone outside it, and
   * a workspace member's mailbox can be on someone else's domain - so a team
   * inbox member is whoever passes both, and the second is read from Clerk at
   * the moment of the write, never from a request.
   */
  async function people(
    orgId: string,
    addresses: string[],
  ): Promise<{ userIds: string[] } | { reason: string }> {
    const wanted = [...new Set(addresses.map((a) => a.trim().toLowerCase()))]
    const found = await store.mailboxes(wanted)
    const roster = await deps.roster(orgId)

    const userIds = new Set<string>()
    for (const address of wanted) {
      const mailbox = found.find((m) => m.address === address)
      if (!mailbox || !mailbox.active) {
        return { reason: `${address} is not an active mailbox.` }
      }
      if (!roster.has(mailbox.userId)) {
        return { reason: `${address} is not a member of this workspace.` }
      }
      userIds.add(mailbox.userId)
    }
    return { userIds: [...userIds] }
  }

  return {
    async list(viewer) {
      const rows = (await admin(viewer))
        ? await store.forTenant(viewer.tenantId)
        : await store.forMember(viewer.tenantId, viewer.userId)
      return rows.map(toTeamInbox)
    },

    async get(viewer, address) {
      const row = await store.find(viewer.tenantId, address.toLowerCase())
      if (!row) return null
      if (await admin(viewer)) return toTeamInbox(row)
      return row.members.some((m) => m.userId === viewer.userId)
        ? toTeamInbox(row)
        : null
    },

    async create(viewer, input) {
      if (!viewer.orgId) return { status: "no_org" }
      if (!(await admin(viewer))) return { status: "forbidden" }

      const address = input.address.trim().toLowerCase()

      // ⚠ THE WORKSPACE MUST OWN THE DOMAIN, NOT MERELY SEE IT. Anything else is
      // a way to make Stalwart accept mail for an address on somebody else's
      // verified domain.
      if ((await store.domainOwner(domainOf(address))) !== viewer.tenantId) {
        return {
          status: "rejected",
          reason: `This workspace has not verified ${domainOf(address)}.`,
        }
      }

      if (await store.addressTaken(address)) {
        return { status: "conflict", reason: "That address is already taken." }
      }

      const who = await people(viewer.orgId, input.members)
      if ("reason" in who) return { status: "rejected", reason: who.reason }

      try {
        const row = await store.create({
          tenantId: viewer.tenantId,
          name: teamGroupName(address),
          address,
          displayName: input.displayName ?? null,
          memberUserIds: who.userIds,
        })
        return { status: "ok", inbox: toTeamInbox(row) }
      } catch (error) {
        // Somebody took it between the check above and the write.
        if (error instanceof AddressTakenError) {
          return { status: "conflict", reason: "That address is already taken." }
        }
        throw error
      }
    },

    async setMembers(viewer, address, members) {
      if (!viewer.orgId) return { status: "no_org" }
      if (!(await admin(viewer))) return { status: "forbidden" }

      const wanted = address.toLowerCase()
      // Looked up first so a missing inbox is "missing" whatever the members were.
      const current = await store.find(viewer.tenantId, wanted)
      if (!current) return { status: "missing" }

      const who = await people(viewer.orgId, members)
      if ("reason" in who) return { status: "rejected", reason: who.reason }

      const keep = new Set(who.userIds)
      const leaving = current.members.filter((m) => !keep.has(m.userId))
      if (leaving.length > 0) {
        await deps.revokeAccess(
          current,
          leaving.map((m) => m.address),
        )
      }

      const row = await store.setMembers(viewer.tenantId, wanted, who.userIds)
      return row ? { status: "ok", inbox: toTeamInbox(row) } : { status: "missing" }
    },

    async remove(viewer, address) {
      if (!(await admin(viewer))) return "forbidden"

      const wanted = address.toLowerCase()
      const row = await store.find(viewer.tenantId, wanted)
      if (!row) return "missing"

      // ⚠ THE ACCOUNT FIRST, THE ROWS SECOND. Rows first would leave a Stalwart
      // account with the old mail in it and nothing in the directory pointing at
      // it - and the next team inbox made at that address would find the old
      // inbox waiting. Destroyed first, a failure here leaves everything as it
      // was and the delete can simply be retried.
      await deps.destroyAccount({ name: row.name, address: row.address })
      await store.remove(viewer.tenantId, wanted)
      return "ok"
    },

    async onMemberRemoved(tenantId, userId) {
      for (const row of await store.forMember(tenantId, userId)) {
        const member = row.members.find((m) => m.userId === userId)
        if (member) await deps.revokeAccess(row, [member.address])
      }
      return store.dropMember(tenantId, userId)
    },

    async onWorkspaceDeleted(tenantId) {
      const rows = await store.forTenant(tenantId)
      for (const row of rows) {
        await deps.destroyAccount({ name: row.name, address: row.address })
        await store.remove(tenantId, row.address)
      }
      return rows.map((r) => r.address)
    },
  }
}
