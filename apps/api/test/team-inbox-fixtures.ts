import {
  AddressTakenError,
  teamInboxes,
  type MailboxAccount,
  type TeamInboxRow,
  type TeamInboxStore,
  type Viewer,
} from "../src/team-inboxes/service.js"

/**
 * An in-memory directory and Clerk for the team inbox tests. One workspace,
 * Acme (`t_acme` / `org_acme`) with the verified domain acme.test, and a second
 * one, Globex, that must never be visible from the first.
 *
 *   alice  admin        alice@acme.test
 *   bob    member       bob@acme.test
 *   carol  member       carol@acme.test
 *   dave   member       dave@acme.test   (in the workspace, in no team inbox)
 *   erin   outsider     erin@acme.test   (a mailbox on Acme's domain, not in its org)
 *   zed    Globex admin zed@globex.test
 */

export const ACME = { tenantId: "t_acme", orgId: "org_acme" }
export const GLOBEX = { tenantId: "t_globex", orgId: "org_globex" }

export const people = {
  alice: { userId: "user_alice", address: "alice@acme.test", active: true },
  bob: { userId: "user_bob", address: "bob@acme.test", active: true },
  carol: { userId: "user_carol", address: "carol@acme.test", active: true },
  dave: { userId: "user_dave", address: "dave@acme.test", active: true },
  erin: { userId: "user_erin", address: "erin@acme.test", active: true },
  zed: { userId: "user_zed", address: "zed@globex.test", active: true },
  idle: { userId: "user_idle", address: "idle@acme.test", active: false },
} satisfies Record<string, MailboxAccount>

export const as = (
  who: keyof typeof people,
  workspace: { tenantId: string; orgId: string } = ACME,
): Viewer => ({
  tenantId: workspace.tenantId,
  userId: people[who].userId,
  orgId: workspace.orgId,
})

export function world() {
  const rows: TeamInboxRow[] = []
  const taken = new Set<string>(["bob@acme.test", "alias@acme.test"])
  const domains = new Map([
    ["acme.test", ACME.tenantId],
    ["globex.test", GLOBEX.tenantId],
  ])
  const destroyed: string[] = []
  const failDestroy = { on: false }

  const mailboxList: MailboxAccount[] = Object.values(people)

  const store: TeamInboxStore = {
    domainOwner: async (domain) => domains.get(domain) ?? null,
    addressTaken: async (address) =>
      taken.has(address) || rows.some((r) => r.address === address),
    mailboxes: async (addresses) =>
      mailboxList.filter((m) => addresses.includes(m.address)),

    async create(input) {
      if (rows.some((r) => r.address === input.address)) {
        throw new AddressTakenError(input.address)
      }
      const row: TeamInboxRow = {
        name: input.name,
        address: input.address,
        displayName: input.displayName,
        tenantId: input.tenantId,
        createdAt: new Date("2027-01-01T00:00:00Z"),
        members: input.memberUserIds.map((userId) => ({
          userId,
          address: mailboxList.find((m) => m.userId === userId)!.address,
        })),
      }
      rows.push(row)
      return row
    },

    forTenant: async (tenantId) => rows.filter((r) => r.tenantId === tenantId),
    forMember: async (tenantId, userId) =>
      rows.filter(
        (r) => r.tenantId === tenantId && r.members.some((m) => m.userId === userId),
      ),
    find: async (tenantId, address) =>
      rows.find((r) => r.tenantId === tenantId && r.address === address) ?? null,

    async setMembers(tenantId, address, memberUserIds) {
      const row = rows.find((r) => r.tenantId === tenantId && r.address === address)
      if (!row) return null
      row.members = memberUserIds.map((userId) => ({
        userId,
        address: mailboxList.find((m) => m.userId === userId)!.address,
      }))
      return row
    },

    async remove(tenantId, address) {
      const at = rows.findIndex((r) => r.tenantId === tenantId && r.address === address)
      if (at < 0) return false
      rows.splice(at, 1)
      return true
    },

    async dropMember(tenantId, userId) {
      const changed: string[] = []
      for (const row of rows) {
        if (row.tenantId !== tenantId) continue
        const kept = row.members.filter((m) => m.userId !== userId)
        if (kept.length !== row.members.length) {
          row.members = kept
          changed.push(row.address)
        }
      }
      return changed
    },
  }

  // Who is in which Clerk organization, and who holds members-manage.
  const rosters = new Map<string, Set<string>>([
    [
      ACME.orgId,
      new Set([
        people.alice.userId,
        people.bob.userId,
        people.carol.userId,
        people.dave.userId,
        people.idle.userId,
      ]),
    ],
    [GLOBEX.orgId, new Set([people.zed.userId])],
  ])
  const admins = new Set([people.alice.userId, people.zed.userId])

  const service = teamInboxes({
    store,
    isAdmin: async (userId, orgId) =>
      admins.has(userId) && rosters.get(orgId)!.has(userId),
    roster: async (orgId) => rosters.get(orgId) ?? new Set(),
    async destroyAccount({ address }) {
      if (failDestroy.on) throw new Error("stalwart is down")
      destroyed.push(address)
      return true
    },
  })

  return { service, store, rows, destroyed, failDestroy, rosters, admins }
}
