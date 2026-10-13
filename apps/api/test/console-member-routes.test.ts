import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mountTeam } from "../src/routes/console/team.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import { createInvitationLinks } from "../src/routes/invitation-links.js"
import { authEmailDelivery } from "../src/auth-email/deliver.js"
import { invitationEmail } from "../src/console/members.js"
import { deps as teamDeps } from "./team-access-fixtures.js"
import { ACME, world } from "./member-fixtures.js"

/**
 * The member routes (#327): the codes the invitation form branches on, the
 * capacity read the Team page and banner use, the invitation link, and the
 * expiry in our invitation email.
 */

const NOW = new Date("2027-03-15T12:00:00Z")

function appWith(w: ReturnType<typeof world>, canManage = true) {
  const t = teamDeps([{ pattern: "pslhq.app", mode: "auto", role: "org:member" }], {
    can: async () => canManage,
  })
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId: ACME.tenantId, scopes: [], mode: "live" })
    c.set("user", { userId: "user_admin", orgId: ACME.orgId })
    await next()
  })
  mountTeam(app, { teamDomains: t.d, members: w.d } as unknown as ConsoleDeps)
  return app
}

const call = (app: Hono, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const form = {
  emails: ["new@acme.test"],
  role: "org:member",
  expires_at: new Date(NOW.getTime() + 24 * 3600_000).toISOString(),
  zone: "America/New_York",
  country: "US",
}

describe("invitation routes", () => {
  it("sends, lists with the expiry, and withdraws", async () => {
    const w = world({ now: NOW })
    const app = appWith(w)
    const sent = await call(app, "POST", "/team/invitations", form)
    expect(sent.status).toBe(201)
    const listed = (await (await call(app, "GET", "/team/invitations")).json()) as {
      data: { id: string; expires_at: string; zone: string; country: string }[]
    }
    expect(listed.data).toMatchObject([
      { expires_at: form.expires_at, zone: "America/New_York", country: "US" },
    ])
    const gone = await call(app, "DELETE", `/team/invitations/${listed.data[0]!.id}`)
    expect(gone.status).toBe(204)
    expect(w.cancelled).toEqual([listed.data[0]!.id])
  })

  it("answers 409 with what would make room when there are too few spots", async () => {
    const w = world({ now: NOW, limit: 3, members: 3, canUpgrade: false })
    const res = await call(appWith(w), "POST", "/team/invitations", form)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      name: "workspace_full",
      free: 0,
      reasons: ["Remove a member"],
    })
  })

  it("answers 403 to somebody who cannot manage members", async () => {
    const res = await call(
      appWith(world({ now: NOW }), false),
      "POST",
      "/team/invitations",
      form,
    )
    expect(res.status).toBe(403)
  })

  it("answers 422 for an expiry out of bounds", async () => {
    const res = await call(appWith(world({ now: NOW })), "POST", "/team/invitations", {
      ...form,
      expires_at: new Date(NOW.getTime() + 8 * 24 * 3600_000).toISOString(),
    })
    expect(res.status).toBe(422)
  })
})

describe("capacity", () => {
  it("reports seats, the shut-out patterns and the alert to an admin", async () => {
    const w = world({ now: NOW, limit: 20, members: 10 })
    w.state.alert = { level: 80, alertedAt: NOW }
    const res = await call(appWith(w), "GET", "/team/capacity")
    expect(await res.json()).toEqual({
      data: {
        members: 10,
        invitations: 0,
        limit: 20,
        free: 10,
        full: false,
        reasons: [],
        can_upgrade: true,
        personal: false,
        patterns: ["pslhq.app"],
        alert: { level: 80, alerted_at: NOW.toISOString() },
      },
    })
  })

  it("keeps the alert from somebody who is not an admin", async () => {
    const w = world({ now: NOW })
    w.state.alert = { level: 100, alertedAt: NOW }
    const res = await call(appWith(w, false), "GET", "/team/capacity")
    expect(((await res.json()) as { data: { alert: unknown } }).data.alert).toBeNull()
  })
})

describe("the invitation link", () => {
  it("hands over Clerk's link in time and says expired after", async () => {
    const w = world({ now: NOW })
    await call(appWith(w), "POST", "/team/invitations", form)
    const row = w.rows[0]!
    await invitationEmail(w.d, { to: row.email, actionUrl: "https://clerk.test/x" })
    const links = createInvitationLinks(w.d)
    expect(await (await links.request(`/${row.id}`)).json()).toEqual({
      outcome: "open",
      url: "https://clerk.test/x",
    })
    w.state.now = new Date(NOW.getTime() + 25 * 3600_000)
    const late = await links.request(`/${row.id}`)
    expect(late.status).toBe(410)
    expect(await late.json()).toEqual({ outcome: "expired" })
    expect((await links.request("/../etc")).status).toBe(404)
  })
})

describe("the invitation email", () => {
  it("states the expiry in the invitee's time and links through us", async () => {
    const w = world({ now: NOW })
    await call(appWith(w), "POST", "/team/invitations", form)
    const sent: { html: string; text?: string }[] = []
    const delivery = authEmailDelivery({
      sender: { send: async (input) => void sent.push(input) },
      invitation: (input) => invitationEmail(w.d, input),
    })
    await delivery.onEmailCreated({
      id: "em_1",
      slug: "organization_invitation",
      to_email_address: "new@acme.test",
      delivered_by_clerk: false,
      data: { action_url: "https://clerk.test/accept", org: { name: "Acme" } },
    })
    // Noon UTC on 16 March is 8 AM in New York (daylight saving from 14 March).
    expect(sent[0]!.text).toContain("16 March at 8:00 AM New York time")
    expect(sent[0]!.html).toContain(`https://console.test/invite/${w.rows[0]!.id}`)
    expect(sent[0]!.html).not.toContain("https://clerk.test/accept")
  })
})
