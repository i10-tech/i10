import type {
  ClerkMemberships,
  Decision,
  Role,
  RoleRow,
  RoleStore,
  RolesDeps,
} from "../src/console/roles.js"

/**
 * An in-memory roles table and Clerk (#335), shared by the roles, team and
 * member tests. `transact` runs the same pure decisions the database store
 * runs, one at a time, as the per-workspace lock makes them.
 */

export const ACME = { tenantId: "t_acme", orgId: "org_acme" }

export const row = (
  userId: string,
  role: Role,
  membershipId: string | null = `mem_${userId}`,
): RoleRow => ({ userId, role, membershipId, source: "membership", grantedBy: null })

export function memoryRoles(initial: Record<string, RoleRow[]> = {}) {
  const tables = new Map<string, RoleRow[]>(
    Object.entries(initial).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]),
  )
  const rowsOf = (tenantId: string) => tables.get(tenantId) ?? []
  let queue = Promise.resolve()
  const store: RoleStore = {
    roleOf: async (tenantId, userId) =>
      rowsOf(tenantId).find((r) => r.userId === userId)?.role ?? null,
    list: async (tenantId) => rowsOf(tenantId).map((r) => ({ ...r })),
    transact<T>(tenantId: string, decide: (rows: RoleRow[]) => Decision<T>) {
      // ⚠ ONE AT A TIME, LIKE THE ADVISORY LOCK.
      const run = queue.then(() => {
        const rows = rowsOf(tenantId).map((r) => ({ ...r }))
        const decision = decide(rows)
        let next = rowsOf(tenantId)
        for (const write of decision.writes) {
          if ("remove" in write) next = next.filter((r) => r.userId !== write.remove)
          else
            next = [
              ...next.filter((r) => r.userId !== write.put.userId),
              { ...write.put },
            ]
        }
        tables.set(tenantId, next)
        return decision.result
      })
      queue = run.then(
        () => {},
        () => {},
      )
      return run
    },
  }
  return { store, rowsOf }
}

export function rolesDeps(
  over: {
    rows?: RoleRow[]
    clerk?: Partial<ClerkMemberships>
    invitations?: { id?: string; email: string; role: string; applied?: string }[]
    emails?: string[]
    tenants?: Record<string, string>
  } = {},
) {
  const mem = memoryRoles({ [ACME.tenantId]: over.rows ?? [] })
  const logged: { o: object; m: string; level: string }[] = []
  const calls = {
    created: [] as string[],
    removed: [] as string[],
    demoted: [] as string[],
    /** Owners asked about by `confirmOwners`. */
    confirmed: [] as string[],
    orgs: [] as { name: string; createdBy: string }[],
    emailsAsked: 0,
  }
  /** Our invitations, and which membership used each. */
  const invitations = (over.invitations ?? []).map((i, k) => ({
    id: i.id ?? `inv_${k + 1}`,
    email: i.email,
    role: i.role,
    applied: i.applied ?? null,
  }))
  let n = 0
  const d: RolesDeps = {
    store: mem.store,
    tenantOf: async (orgId) =>
      (over.tenants ?? { [ACME.orgId]: ACME.tenantId })[orgId] ?? null,
    invitations: async (_t, _since, membershipId) =>
      invitations
        .filter((i) => i.applied === null || i.applied === membershipId)
        .map(({ id, email, role }) => ({ id, email, role })),
    applyInvitation: async (_t, id, membershipId) => {
      const i = invitations.find((x) => x.id === id)
      if (!i || (i.applied !== null && i.applied !== membershipId)) return false
      i.applied = membershipId
      return true
    },
    emailsOf: async () => {
      calls.emailsAsked += 1
      return over.emails ?? []
    },
    clerk: {
      create: async (_o, userId) => {
        calls.created.push(userId)
        return { outcome: "created", membershipId: `mem_new_${++n}` }
      },
      remove: async (_o, userId) => void calls.removed.push(userId),
      isMember: async () => true,
      createOrganization: async (input) => {
        calls.orgs.push({ name: input.name, createdBy: input.createdBy })
        return { id: `org_new_${++n}` }
      },
      demote: async (orgId, userId) => void calls.demoted.push(`${orgId}:${userId}`),
      organizationExists: async () => true,
      stillMember: async (_o, userId) => {
        calls.confirmed.push(userId)
        return true
      },
      ...over.clerk,
    },
    now: () => new Date("2027-03-15T12:00:00Z"),
    log: {
      info: (o, m) => void logged.push({ o, m, level: "info" }),
      warn: (o, m) => void logged.push({ o, m, level: "warn" }),
      error: (o, m) => void logged.push({ o, m, level: "error" }),
    },
  }
  return { d, logged, calls, invitations, rows: () => mem.rowsOf(ACME.tenantId) }
}
