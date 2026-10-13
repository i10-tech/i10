import { describe, expect, it } from "bun:test"
import {
  DAY_MS,
  HOUR_MS,
  beforeSeatUse,
  checkExpiry,
  clerkDays,
  evaluateAlerts,
  expireInvitation,
  invitationEmail,
  onClerkEvent,
  openInvitation,
  revokeExpired,
  sendInvitations,
  syncMemberLimit,
  withMemberLimitSync,
  withdrawInvitation,
} from "../src/console/members.js"
import { answerJoinRequest, joinNow } from "../src/console/team-domains.js"
import { ACME, world } from "./member-fixtures.js"
import { deps as teamDeps } from "./team-access-fixtures.js"

/**
 * Invitations with a chosen expiry, member limits in Clerk, capacity alerts
 * and Accept and notify (#327), against an in-memory Clerk.
 */

const NOW = new Date("2027-03-15T12:00:00Z")
const inHours = (h: number) => new Date(NOW.getTime() + h * HOUR_MS).toISOString()

const invite = (
  w: ReturnType<typeof world>,
  over: Partial<Parameters<typeof sendInvitations>[1]> = {},
) =>
  sendInvitations(w.d, {
    tenantId: ACME.tenantId,
    orgId: ACME.orgId,
    userId: "user_admin",
    emails: ["new@acme.test"],
    role: "org:member",
    expiresAt: inHours(36),
    zone: "Europe/Paris",
    country: "FR",
    ...over,
  })

describe("expiry bounds", () => {
  it("takes 1 hour to 7 days ahead", () => {
    expect(checkExpiry(inHours(1), NOW)).toEqual({
      ok: true,
      at: new Date(NOW.getTime() + HOUR_MS),
    })
    expect(checkExpiry(inHours(7 * 24), NOW).ok).toBe(true)
    expect(checkExpiry(inHours(0.5), NOW)).toEqual({ ok: false, error: "too_soon" })
    expect(checkExpiry(inHours(7 * 24 + 1), NOW)).toEqual({
      ok: false,
      error: "too_late",
    })
    expect(checkExpiry("not a date", NOW)).toEqual({ ok: false, error: "invalid" })
    expect(checkExpiry(undefined, NOW)).toEqual({ ok: false, error: "invalid" })
  })

  // ⚠ The quick picks are computed in the browser a moment before arriving.
  it("pulls a pick a minute or two either side to the bound", () => {
    const early = checkExpiry(new Date(NOW.getTime() + HOUR_MS - 60_000), NOW)
    expect(early).toEqual({ ok: true, at: new Date(NOW.getTime() + HOUR_MS) })
    const late = checkExpiry(new Date(NOW.getTime() + 7 * DAY_MS + 60_000), NOW)
    expect(late).toEqual({ ok: true, at: new Date(NOW.getTime() + 7 * DAY_MS) })
  })

  it("rounds Clerk's whole days up, as an outer bound", () => {
    const at = (h: number) => new Date(NOW.getTime() + h * HOUR_MS)
    expect(clerkDays(at(1), NOW)).toBe(1)
    expect(clerkDays(at(24), NOW)).toBe(1)
    expect(clerkDays(at(25), NOW)).toBe(2)
    expect(clerkDays(at(36), NOW)).toBe(2)
    expect(clerkDays(at(7 * 24), NOW)).toBe(7)
  })
})

describe("sending invitations", () => {
  it("sends with Clerk's days rounded up and schedules the job at the instant", async () => {
    const w = world({ now: NOW })
    const sent = await invite(w)
    expect(sent.outcome).toBe("ok")
    expect(w.invited).toEqual([{ email: "new@acme.test", expiresInDays: 2 }])
    const row = w.rows[0]!
    expect(row.expiresAt.toISOString()).toBe(inHours(36))
    expect(row.zone).toBe("Europe/Paris")
    expect(row.country).toBe("FR")
    expect(row.clerkInvitationId).toBe(w.clerkPending[0]!.id)
    expect(w.scheduled).toEqual([{ id: row.id, at: new Date(inHours(36)) }])
  })

  it("refuses more addresses than free spots, whole", async () => {
    const w = world({ now: NOW, limit: 3, members: 2 })
    const sent = await invite(w, { emails: ["a@x.test", "b@x.test"] })
    expect(sent).toEqual({
      outcome: "full",
      free: 1,
      reasons: ["Remove a member", "Upgrade"],
    })
    expect(w.invited).toEqual([])
    expect(w.rows).toEqual([])
  })

  it("holds a downgraded workspace to its plan, not to Clerk's maximum", async () => {
    // Clerk still allows 20 after a downgrade to 3 with 3 members.
    const w = world({ now: NOW, limit: 3, members: 3, maxAllowed: 20 })
    expect((await invite(w)).outcome).toBe("full")
  })

  it("refuses a Personal workspace, a bad zone and a bad expiry", async () => {
    expect((await invite(world({ now: NOW, personal: true, limit: 20 }))).outcome).toBe(
      "personal",
    )
    expect(await invite(world({ now: NOW }), { zone: "Nowhere/Here" })).toEqual({
      outcome: "invalid",
      error: "Pick a time zone.",
    })
    expect(await invite(world({ now: NOW }), { expiresAt: inHours(0.25) })).toEqual({
      outcome: "invalid",
      error: "An invitation has to last at least an hour.",
    })
  })

  it("drops our row when Clerk refuses one address", async () => {
    const w = world({ now: NOW })
    w.failNextInvite({ errors: [{ code: "duplicate_record" }] })
    const sent = await invite(w, { emails: ["dup@x.test", "ok@x.test"] })
    expect(sent).toMatchObject({
      outcome: "ok",
      failed: [{ email: "dup@x.test", reason: "Already invited." }],
    })
    expect(w.rows.map((r) => r.email)).toEqual(["ok@x.test"])
    expect(w.scheduled).toHaveLength(1)
  })
})

describe("revoking before every seat use", () => {
  it("revokes expired invitations first, freeing their spots", async () => {
    const w = world({ now: NOW, limit: 3, members: 2 })
    await invite(w, { expiresAt: inHours(1) })
    w.state.now = new Date(NOW.getTime() + 2 * HOUR_MS)
    const room = await beforeSeatUse(w.d, ACME.tenantId, ACME.orgId)
    expect(w.revoked).toHaveLength(1)
    expect(w.rows[0]!.status).toBe("expired")
    expect(w.cancelled).toEqual([w.rows[0]!.id])
    expect(room).toMatchObject({ members: 2, invitations: 0, free: 1, full: false })
  })

  it("leaves invitations still in time", async () => {
    const w = world({ now: NOW })
    await invite(w)
    expect(await revokeExpired(w.d, ACME.tenantId)).toBe(0)
    expect(w.revoked).toEqual([])
  })

  it("puts Clerk's maximum right when a plan change's sync was missed", async () => {
    const w = world({ now: NOW, limit: 3, members: 1, maxAllowed: 20 })
    await beforeSeatUse(w.d, ACME.tenantId, ACME.orgId)
    expect(w.limits).toEqual([3])
  })

  it("is asked by auto-join and by accepting a request", async () => {
    const asked: string[] = []
    const t = teamDeps([{ pattern: "pslhq.app", mode: "auto", role: "org:member" }], {
      seats: {
        beforeSeatUse: async (tenantId) => {
          asked.push(tenantId)
          return { full: true }
        },
      },
    })
    const joined = await joinNow(t.d, {
      currentTenantId: "t_other",
      userId: "user_new",
      emails: ["new@pslhq.app"],
      tenantId: "t_acme",
    })
    // Full by our count: a request, and Clerk was never asked to add them.
    expect(joined).toEqual({ outcome: "full" })
    expect(t.added).toEqual([])
    expect(t.requests[0]?.full).toBe(true)
    const answered = await answerJoinRequest(t.d, {
      tenantId: "t_acme",
      userId: "user_admin",
      orgId: "org_acme",
      id: t.requests[0]!.id,
      accept: true,
    })
    expect(answered).toBe("full")
    expect(asked).toEqual(["t_acme", "t_acme"])
  })
})

describe("the delayed job", () => {
  it("does not revoke before its time, and says how long is left", async () => {
    const w = world({ now: NOW })
    await invite(w, { expiresAt: inHours(2) })
    const job = { id: w.rows[0]!.id, tenantId: ACME.tenantId }
    // Promoted a second early.
    w.state.now = new Date(NOW.getTime() + 2 * HOUR_MS - 1_000)
    expect(await expireInvitation(w.d, job)).toEqual({ outcome: "early", ms: 1_000 })
    expect(w.revoked).toEqual([])
    expect(w.rows[0]!.status).toBe("pending")
    w.state.now = new Date(NOW.getTime() + 2 * HOUR_MS)
    expect(await expireInvitation(w.d, job)).toEqual({ outcome: "expired" })
    expect(w.revoked).toEqual([w.rows[0]!.clerkInvitationId!])
    expect(w.rows[0]!.status).toBe("expired")
  })

  it("is cancelled on withdraw, and does nothing if it runs anyway", async () => {
    const w = world({ now: NOW })
    await invite(w)
    const id = w.rows[0]!.id
    expect(await withdrawInvitation(w.d, { tenantId: ACME.tenantId, id })).toBe("ok")
    expect(w.cancelled).toEqual([id])
    expect(w.rows[0]!.status).toBe("withdrawn")
    expect(await withdrawInvitation(w.d, { tenantId: ACME.tenantId, id })).toBe(
      "missing",
    )
    w.state.now = new Date(NOW.getTime() + 40 * HOUR_MS)
    expect(await expireInvitation(w.d, { id, tenantId: ACME.tenantId })).toEqual({
      outcome: "done",
    })
    expect(w.revoked).toHaveLength(1)
  })

  it("is cancelled on accept", async () => {
    const w = world({ now: NOW })
    await invite(w)
    const row = w.rows[0]!
    const outcome = await onClerkEvent(w.d, "organizationInvitation.accepted", {
      id: row.clerkInvitationId,
      organization_id: ACME.orgId,
      user_id: "user_new",
    })
    expect(outcome).toBe("accepted")
    expect(row.status).toBe("accepted")
    expect(w.cancelled).toEqual([row.id])
    expect(w.removed).toEqual([])
  })
})

describe("the webhook backstop", () => {
  it("removes a membership made through an invitation we had expired", async () => {
    const w = world({ now: NOW })
    await invite(w, { expiresAt: inHours(1) })
    const row = w.rows[0]!
    w.state.now = new Date(NOW.getTime() + 2 * HOUR_MS)
    await revokeExpired(w.d, ACME.tenantId)
    const outcome = await onClerkEvent(w.d, "organizationInvitation.accepted", {
      id: row.clerkInvitationId,
      organization_id: ACME.orgId,
      user_id: "user_late",
    })
    expect(outcome).toBe("removed_late")
    expect(w.removed).toEqual([{ orgId: ACME.orgId, userId: "user_late" }])
  })

  it("also catches one past its expiry that every backup missed", async () => {
    const w = world({ now: NOW })
    await invite(w, { expiresAt: inHours(1) })
    const row = w.rows[0]!
    w.state.now = new Date(NOW.getTime() + HOUR_MS + 1)
    await onClerkEvent(w.d, "organizationInvitation.accepted", {
      id: row.clerkInvitationId,
      organization_id: ACME.orgId,
      user_id: "user_late",
    })
    expect(w.removed).toHaveLength(1)
    expect(row.status).toBe("expired")
  })

  it("ends our row when the invitation is revoked elsewhere", async () => {
    const w = world({ now: NOW })
    await invite(w)
    const row = w.rows[0]!
    expect(
      await onClerkEvent(w.d, "organizationInvitation.revoked", {
        id: row.clerkInvitationId,
        organization_id: ACME.orgId,
      }),
    ).toBe("revoked")
    expect(row.status).toBe("withdrawn")
    expect(w.cancelled).toEqual([row.id])
  })
})

describe("member limits in Clerk", () => {
  it("syncs the plan's limit on a plan change", async () => {
    const w = world({ now: NOW, limit: 20, members: 2, maxAllowed: 3 })
    expect(await syncMemberLimit(w.d, ACME.tenantId)).toBe("synced")
    expect(w.limits).toEqual([20])
    expect(await syncMemberLimit(w.d, ACME.tenantId)).toBe("unchanged")
  })

  it("keeps everybody and every invitation on a downgrade", async () => {
    const w = world({ now: NOW, limit: 20, members: 2, maxAllowed: 20 })
    await invite(w, { emails: ["a@x.test", "b@x.test", "c@x.test"] })
    w.state.limit = 3
    await syncMemberLimit(w.d, ACME.tenantId)
    // Nothing withdrawn; Clerk held at members plus invitations so it accepts it.
    expect(w.rows.map((r) => r.status)).toEqual(["pending", "pending", "pending"])
    expect(w.revoked).toEqual([])
    expect(w.limits).toEqual([5])
  })

  it("never sets Clerk below the members already in", async () => {
    const w = world({ now: NOW, limit: 3, members: 5, maxAllowed: 20 })
    await syncMemberLimit(w.d, ACME.tenantId)
    expect(w.limits).toEqual([5])
  })

  it("gives a Personal workspace one", async () => {
    const w = world({ now: NOW, limit: 20, members: 1, maxAllowed: 20, personal: true })
    await syncMemberLimit(w.d, ACME.tenantId)
    expect(w.limits).toEqual([1])
  })

  it("follows every grant through the wrapped port, without failing it", async () => {
    const w = world({ now: NOW, limit: 3, members: 1, maxAllowed: 20 })
    const granted: string[] = []
    const wrapped = withMemberLimitSync(
      {
        grantPlan: async ({ planId }: { tenantId: string; planId: string }) =>
          void granted.push(planId),
      },
      () => w.d,
    )
    await wrapped.grantPlan({ tenantId: ACME.tenantId, planId: "free" })
    expect(granted).toEqual(["free"])
    expect(w.limits).toEqual([3])

    w.d.clerk.setLimit = async () => {
      throw new Error("clerk is down")
    }
    w.state.limit = 20
    await wrapped.grantPlan({ tenantId: ACME.tenantId, planId: "pro" })
    expect(granted).toEqual(["free", "pro"])
  })
})

describe("capacity alerts", () => {
  it("emails the admins once per crossing, members only", async () => {
    const w = world({ now: NOW, limit: 20, members: 10 })
    // Six invitations do not raise it.
    await invite(w, { emails: ["1@x.t", "2@x.t", "3@x.t", "4@x.t", "5@x.t", "6@x.t"] })
    expect(await evaluateAlerts(w.d, ACME.tenantId, ACME.orgId)).toBeNull()
    w.state.members = 16
    expect(await evaluateAlerts(w.d, ACME.tenantId, ACME.orgId)).toBe(80)
    expect(await evaluateAlerts(w.d, ACME.tenantId, ACME.orgId)).toBeNull()
    w.state.members = 20
    expect(await evaluateAlerts(w.d, ACME.tenantId, ACME.orgId)).toBe(100)
    expect(w.mailed.map((m) => (m.input as { level: number }).level)).toEqual([80, 100])
    expect((w.mailed[0]!.input as { to: string[] }).to).toEqual([
      "owner@acme.test",
      "ops@acme.test",
    ])
    // Under 80% re-arms; back over sends again.
    w.state.members = 12
    await evaluateAlerts(w.d, ACME.tenantId, ACME.orgId)
    expect(w.state.alert.level).toBe(0)
    w.state.members = 16
    expect(await evaluateAlerts(w.d, ACME.tenantId, ACME.orgId)).toBe(80)
  })

  it("runs on members joining or leaving", async () => {
    const w = world({ now: NOW, limit: 3, members: 3 })
    expect(
      await onClerkEvent(w.d, "organizationMembership.created", {
        organization: { id: ACME.orgId },
      }),
    ).toBe("alert:100")
  })

  it("moves nothing in a process with no way to send", async () => {
    const w = world({ now: NOW, limit: 3, members: 3 })
    delete w.d.mail
    expect(await evaluateAlerts(w.d, ACME.tenantId, ACME.orgId)).toBeNull()
    expect(w.state.alert.level).toBe(0)
  })
})

describe("accept and notify", () => {
  it("adds them and tells them a spot opened up", async () => {
    const notified: unknown[] = []
    const t = teamDeps([{ pattern: "pslhq.app", mode: "auto", role: "org:member" }], {
      seats: {
        beforeSeatUse: async () => ({ full: false }),
        accepted: async (input) => void notified.push(input),
      },
    })
    await t.store.fileRequest("t_acme", {
      userId: "user_wait",
      email: "wait@pslhq.app",
      via: "pslhq.app",
      full: true,
    })
    const id = t.requests[0]!.id
    expect(
      await answerJoinRequest(t.d, {
        tenantId: "t_acme",
        userId: "user_admin",
        orgId: "org_acme",
        id,
        accept: true,
      }),
    ).toBe("ok")
    expect(t.added).toEqual([
      { orgId: "org_acme", userId: "user_wait", role: "org:member" },
    ])
    expect(notified).toEqual([
      { tenantId: "t_acme", requestId: id, email: "wait@pslhq.app", waited: true },
    ])
  })

  it("never emails a decline", async () => {
    const notified: unknown[] = []
    const t = teamDeps([], {
      seats: {
        beforeSeatUse: async () => ({ full: false }),
        accepted: async (input) => void notified.push(input),
      },
    })
    await t.store.fileRequest("t_acme", {
      userId: "u",
      email: "u@pslhq.app",
      via: null,
      full: false,
    })
    await answerJoinRequest(t.d, {
      tenantId: "t_acme",
      userId: "user_admin",
      orgId: "org_acme",
      id: t.requests[0]!.id,
      accept: false,
    })
    expect(notified).toEqual([])
  })
})

describe("the invitation email and its link", () => {
  it("states the expiry in the chosen zone and routes the link through us", async () => {
    const w = world({ now: NOW })
    await invite(w)
    const row = w.rows[0]!
    const email = await invitationEmail(w.d, {
      to: "New@acme.test",
      actionUrl: "https://clerk.test/accept?ticket=t",
    })
    // 36 hours after noon UTC on 15 March is midnight UTC: 1 AM in Paris (GMT+1).
    expect(email).toEqual({
      expires: "17 March at 1:00 AM Paris time",
      url: `https://console.test/invite/${row.id}`,
    })
    expect(row.actionUrl).toBe("https://clerk.test/accept?ticket=t")
  })

  it("leaves an invitation we did not send alone", async () => {
    const w = world({ now: NOW })
    expect(await invitationEmail(w.d, { to: "x@y.test", actionUrl: "u" })).toBeNull()
  })

  it("opens in time, and revokes on opening once expired", async () => {
    const w = world({ now: NOW })
    await invite(w, { expiresAt: inHours(1) })
    const row = w.rows[0]!
    await invitationEmail(w.d, { to: row.email, actionUrl: "https://clerk.test/a" })
    expect(await openInvitation(w.d, row.id)).toEqual({
      outcome: "open",
      url: "https://clerk.test/a",
    })
    w.state.now = new Date(NOW.getTime() + 2 * HOUR_MS)
    expect(await openInvitation(w.d, row.id)).toEqual({ outcome: "expired" })
    expect(w.revoked).toEqual([row.clerkInvitationId!])
    expect(await openInvitation(w.d, "nope")).toEqual({ outcome: "missing" })
  })

  it("says full while the workspace is at its plan, and opens again once there is room", async () => {
    const w = world({ now: NOW, limit: 3, members: 2 })
    await invite(w, { expiresAt: inHours(24) })
    const row = w.rows[0]!
    await invitationEmail(w.d, { to: row.email, actionUrl: "https://clerk.test/a" })
    w.state.members = 3
    expect(await openInvitation(w.d, row.id)).toEqual({ outcome: "full" })
    expect(w.rows[0]!.status).toBe("pending")
    w.state.members = 2
    expect(await openInvitation(w.d, row.id)).toEqual({
      outcome: "open",
      url: "https://clerk.test/a",
    })
  })
})
