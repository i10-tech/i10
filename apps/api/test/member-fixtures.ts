import type { AlertLevel } from "../src/console/capacity.js"
import type { InvitationRow, MemberStore } from "../src/console/members-db.js"
import type { ClerkMembers, MemberMail, MembersDeps } from "../src/console/members.js"

/**
 * An in-memory member store, Clerk organization, scheduler and mail (#327).
 * One workspace, Acme, on a plan whose limit the test sets.
 */

export const ACME = { tenantId: "t_acme", orgId: "org_acme" }

export function world(
  opts: {
    limit?: number
    members?: number
    maxAllowed?: number
    personal?: boolean
    canUpgrade?: boolean
    now?: Date
  } = {},
) {
  const state = {
    now: opts.now ?? new Date("2027-03-15T12:00:00Z"),
    limit: opts.limit ?? 20,
    canUpgrade: opts.canUpgrade ?? true,
    members: opts.members ?? 1,
    maxAllowed: opts.maxAllowed ?? 20,
    personal: opts.personal ?? false,
    alert: { level: 0 as AlertLevel, alertedAt: null as Date | null },
  }
  const rows: InvitationRow[] = []
  /** Clerk's own pending invitations, ours or not. */
  const clerkPending: { id: string; email: string; createdAt: number }[] = []
  const revoked: string[] = []
  const removed: { orgId: string; userId: string }[] = []
  const limits: number[] = []
  const scheduled: { id: string; at: Date }[] = []
  const cancelled: string[] = []
  const mailed: { kind: "capacity" | "accepted"; input: unknown }[] = []
  const invited: { email: string; expiresInDays: number }[] = []
  let failNext: unknown = null
  let n = 0

  const store: MemberStore = {
    async createInvitation(tenantId, input) {
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`
      rows.push({
        id,
        tenantId,
        clerkInvitationId: null,
        actionUrl: null,
        status: "pending",
        createdAt: new Date(state.now),
        ...input,
      })
      return id
    },
    async attachClerk(_t, id, clerkId) {
      rows.find((r) => r.id === id)!.clerkInvitationId = clerkId
    },
    async discard(_t, id) {
      rows.splice(
        rows.findIndex((r) => r.id === id),
        1,
      )
    },
    pendingInvitations: async (t) =>
      rows.filter((r) => r.tenantId === t && r.status === "pending"),
    invitation: async (t, id) =>
      rows.find((r) => r.tenantId === t && r.id === id) ?? null,
    byClerkId: async (t, id) =>
      rows.find((r) => r.tenantId === t && r.clerkInvitationId === id) ?? null,
    due: async (t, now) =>
      rows.filter(
        (r) =>
          r.tenantId === t &&
          r.status === "pending" &&
          r.expiresAt.getTime() <= now.getTime(),
      ),
    async end(t, id, status) {
      const row = rows.find((r) => r.tenantId === t && r.id === id)
      if (!row || row.status !== "pending") return false
      row.status = status
      return true
    },
    forInvitee: async (email, since) =>
      [...rows]
        .reverse()
        .find(
          (r) =>
            r.email === email.toLowerCase() &&
            r.status === "pending" &&
            r.createdAt > since,
        ) ?? null,
    async keepLink(_e, id, url) {
      rows.find((r) => r.id === id)!.actionUrl = url
    },
    byLink: async (id) => rows.find((r) => r.id === id) ?? null,
    planLimit: async () => ({
      planId: "plan",
      limit: state.limit,
      canUpgrade: state.canUpgrade,
    }),
    workspace: async () => ({ name: "Acme", clerkOrgId: ACME.orgId }),
    tenantOf: async (orgId) => (orgId === ACME.orgId ? ACME.tenantId : null),
    alert: async () => state.alert,
    async setAlert(_t, level, alertedAt) {
      state.alert = { level, alertedAt }
    },
  }

  const clerk: ClerkMembers = {
    organization: async () => ({
      name: "Acme",
      members: state.members,
      maxAllowed: state.maxAllowed,
      personal: state.personal,
    }),
    pendingInvitations: async () =>
      [...clerkPending].sort((a, b) => b.createdAt - a.createdAt),
    async setLimit(_o, max) {
      state.maxAllowed = max
      limits.push(max)
    },
    async invite(input) {
      if (failNext) {
        const error = failNext
        failNext = null
        throw error
      }
      const id = `inv_${++n}`
      invited.push({ email: input.email, expiresInDays: input.expiresInDays })
      clerkPending.push({ id, email: input.email, createdAt: state.now.getTime() + n })
      return { id }
    },
    async revoke(_o, id) {
      revoked.push(id)
      const i = clerkPending.findIndex((p) => p.id === id)
      if (i >= 0) clerkPending.splice(i, 1)
    },
    async removeMember(orgId, userId) {
      removed.push({ orgId, userId })
    },
    admins: async () => ["owner@acme.test", "ops@acme.test"],
  }

  const mail: MemberMail = {
    async capacity(input) {
      mailed.push({ kind: "capacity", input })
    },
    async accepted(input) {
      mailed.push({ kind: "accepted", input })
    },
  }

  const d: MembersDeps = {
    store,
    clerk,
    expiry: {
      async schedule(job, at) {
        scheduled.push({ id: job.id, at })
      },
      async cancel(id) {
        cancelled.push(id)
      },
    },
    mail,
    inviteLink: (id) => `https://console.test/invite/${id}`,
    now: () => state.now,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  }

  return {
    d,
    state,
    rows,
    clerkPending,
    revoked,
    removed,
    limits,
    scheduled,
    cancelled,
    mailed,
    invited,
    failNextInvite: (error: unknown) => {
      failNext = error
    },
  }
}
