import type { AddOutcome, TeamDomainDeps } from "../src/console/team-domains.js"
import type {
  AccessDomainRow,
  ExclusionRow,
  JoinRecord,
  JoinRequestRow,
  JoinStore,
} from "../src/console/join.js"
import type { JoinRule } from "../src/db/core.js"

/**
 * An in-memory team access store and Clerk (#326), shared by the logic and
 * route tests. One workspace, Acme, with one verified access domain.
 */

export const ACME = { tenantId: "t_acme", orgId: "org_acme" }

export function memory(rules: JoinRule[], domainName = "pslhq.app") {
  const requests: (JoinRequestRow & { tenantId: string; answered: boolean })[] = []
  const exclusions = new Map<string, ExclusionRow["kind"]>()
  const joins: (JoinRecord & { tenantId: string })[] = []
  const domains: AccessDomainRow[] = [
    {
      id: "jd_1",
      name: domainName,
      source: "domains",
      status: "verified",
      txt: { name: `_i10-access.${domainName}`, value: "i10-access=x" },
      rules,
      orphaned: false,
      verified_at: "now",
      checked_at: null,
      created_at: "now",
    },
  ]
  let n = 0
  const store: JoinStore = {
    accessDomains: async () => domains,
    addAccessDomain: async () => ({ outcome: "created", id: "jd_new" }),
    verifyTxt: async () => "proven",
    removeAccessDomain: async () => true,
    setRules: async (_t, id, next) => {
      const row = domains.find((d) => d.id === id)
      if (!row) return null
      row.rules = next
      return row.name
    },
    dismissed: async () => [],
    dismiss: async () => {},
    pending: async (tenantId) =>
      requests.filter((r) => r.tenantId === tenantId && !r.answered),
    answer: async (tenantId, id) => {
      const r = requests.find(
        (q) => q.id === id && q.tenantId === tenantId && !q.answered,
      )
      if (!r) return null
      r.answered = true
      return r
    },
    exclusions: async () =>
      [...exclusions].map(([email, kind]) => ({ email, kind, created_at: "now" })),
    excluded: async (_t, emails) =>
      new Map(
        emails.flatMap((e) => {
          const kind = exclusions.get(e.toLowerCase())
          return kind ? [[e.toLowerCase(), kind] as const] : []
        }),
      ),
    exclude: async (_t, emails, kind) => {
      for (const e of emails) {
        const held = exclusions.get(e.toLowerCase())
        if (held === "blocked" && kind === "removed") continue
        exclusions.set(e.toLowerCase(), kind)
      }
    },
    allow: async (_t, emails) => {
      for (const e of emails) exclusions.delete(e.toLowerCase())
    },
    joins: async (tenantId) => joins.filter((j) => j.tenantId === tenantId),
    forgetJoin: async (tenantId, userId) => {
      const i = joins.findIndex((j) => j.tenantId === tenantId && j.user_id === userId)
      if (i >= 0) joins.splice(i, 1)
    },
    recordJoin: async (tenantId, { userId, email, how, via }) => {
      if (joins.some((j) => j.tenantId === tenantId && j.user_id === userId)) return
      joins.push({ tenantId, user_id: userId, email, how, via, created_at: "now" })
    },
    fileRequest: async (tenantId, { userId, email, via, full }) => {
      if (
        requests.some(
          (r) => r.tenantId === tenantId && r.user_id === userId && !r.answered,
        )
      )
        return "exists"
      requests.push({
        tenantId,
        id: `req_${++n}`,
        user_id: userId,
        email,
        via,
        full,
        created_at: "now",
        answered: false,
      })
      return "created"
    },
    accessFor: async ({ userId }) => ({
      domains: domains
        .filter((d) => d.status === "verified")
        .map((d) => ({
          tenantId: ACME.tenantId,
          clerkOrgId: ACME.orgId,
          name: d.name,
          rules: d.rules,
        })),
      requested: new Set(
        requests
          .filter((r) => r.user_id === userId && !r.answered)
          .map((r) => r.tenantId),
      ),
      joined: new Set(joins.filter((j) => j.user_id === userId).map((j) => j.tenantId)),
    }),
    arrivals: async () => [],
  }
  return { store, requests, exclusions, joins, domains }
}

export function deps(
  rules: JoinRule[],
  over: Partial<TeamDomainDeps> & { full?: boolean; member?: string[] } = {},
) {
  const mem = memory(rules)
  const added: { orgId: string; userId: string; role: string }[] = []
  const removed: string[] = []
  const invited: string[] = []
  const members = new Set(over.member ?? [])
  const d: TeamDomainDeps = {
    verified: async () => ["pslhq.app", "notifications.other.app"],
    can: async () => true,
    store: mem.store,
    memberOrgIds: async (userId) => (members.has(userId) ? [ACME.orgId] : []),
    describe: async () => ({}),
    addMember: async (orgId, userId, role): Promise<AddOutcome> => {
      if (over.full) return "full"
      added.push({ orgId, userId, role })
      members.add(userId)
      return "added"
    },
    removeMember: async (_o, userId) => void removed.push(userId),
    invite: async (_o, _i, email) => void invited.push(email),
    emailsOf: async () => ["gone@pslhq.app", "Other@Example.com"],
    isPersonal: async () => false,
    ...over,
  }
  return { d, added, removed, invited, ...mem }
}
