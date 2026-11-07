import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { memberStore } from "../src/console/members-db.js"

/**
 * Member limits, invitations and alerts against a real database as `i10_api`
 * (#327): the catalogue's limits come from the migration, and the invitee and
 * link audiences are row-level-security policies only Postgres can check.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/templates_scratch bun test test/members-db.test.ts
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let db: ReturnType<typeof postgres>
let database: Database
const acme = crypto.randomUUID()
const rival = crypto.randomUUID()
const org = `org_${acme.slice(0, 8)}`

suite("member store", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    database = drizzle(db, { schema }) as unknown as Database
    await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                values (${acme}, ${`m-${acme.slice(0, 8)}`}, 'Acme', 'u_a', ${org}),
                       (${rival}, ${`m-${rival.slice(0, 8)}`}, 'Rival', 'u_r', null)`
    await owner`insert into core.plan_assignments (tenant_id, plan_id, anchor)
                values (${acme}, 'free', now()), (${rival}, 'pro', now())`
  })
  afterAll(async () => {
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await db.end()
  })

  const store = () => memberStore(database)

  it("reads the catalogue's limits: Free 3, Pro 20", async () => {
    expect(await store().planLimit(acme)).toEqual({
      planId: "free",
      limit: 3,
      canUpgrade: true,
    })
    expect(await store().planLimit(rival)).toMatchObject({ planId: "pro", limit: 20 })
  })

  it("finds the tenant for a Clerk organization", async () => {
    expect(await store().tenantOf(org)).toBe(acme)
    expect(await store().tenantOf("org_nobody")).toBeNull()
  })

  let id = ""
  it("keeps one UTC instant per invitation, and ends it once", async () => {
    const expiresAt = new Date(Date.now() + 36 * 3600_000)
    id = await store().createInvitation(acme, {
      clerkOrgId: org,
      email: "New@Acme.test",
      role: "member",
      inviterUserId: "u_a",
      expiresAt,
      zone: "Europe/Paris",
      country: "FR",
    })
    await store().attachClerk(acme, id, `inv_${acme}`)
    expect(await store().byClerkId(acme, `inv_${acme}`)).toMatchObject({
      email: "new@acme.test",
      expiresAt,
      status: "pending",
    })
    // Another workspace cannot see it.
    expect(await store().invitation(rival, id)).toBeNull()
    expect(await store().due(acme, new Date())).toEqual([])
    expect((await store().due(acme, new Date(Date.now() + 40 * 3600_000))).length).toBe(
      1,
    )
  })

  it("lets the email path read the invitee's newest pending one, and only that", async () => {
    const found = await store().forInvitee(
      "NEW@acme.test",
      new Date(Date.now() - 3600_000),
    )
    expect(found?.id).toBe(id)
    expect(await store().forInvitee("other@acme.test", new Date(0))).toBeNull()
    await store().keepLink("new@acme.test", id, "https://clerk.test/accept")
    expect((await store().byLink(id))?.actionUrl).toBe("https://clerk.test/accept")
    // The link reads only the row it names.
    expect(await store().byLink(crypto.randomUUID())).toBeNull()
  })

  // #335: what a new membership's role is matched against, and only once.
  it("lists recent invitations, reads an old Clerk role as ours, and gives each once", async () => {
    await owner`insert into core.member_invitations
                  (tenant_id, clerk_org_id, email, role, inviter_user_id, expires_at, zone)
                values (${acme}, ${org}, 'old@acme.test', 'org:admin', 'u_a',
                        now() + interval '1 day', 'UTC')`
    const since = new Date(Date.now() - 3600_000)
    const recent = await store().recentInvitations(acme, since, "mem_1")
    expect(recent.map((r) => ({ email: r.email, role: r.role }))).toEqual([
      { email: "old@acme.test", role: "admin" },
      { email: "new@acme.test", role: "member" },
    ])
    expect(await store().recentInvitations(rival, new Date(0), "mem_1")).toEqual([])
    const old = recent[0]!.id
    expect(await store().applyInvitation(acme, old, "mem_1")).toBe(true)
    // The same membership again (a redelivery) still has it; another never does.
    expect(await store().applyInvitation(acme, old, "mem_1")).toBe(true)
    expect(await store().applyInvitation(acme, old, "mem_2")).toBe(false)
    expect((await store().recentInvitations(acme, since, "mem_1"))[0]!.id).toBe(old)
    expect(
      (await store().recentInvitations(acme, since, "mem_2")).map((r) => r.email),
    ).toEqual(["new@acme.test"])
    await owner`delete from core.member_invitations where email = 'old@acme.test'`
  })

  it("ends a pending row once", async () => {
    expect(await store().end(acme, id, "withdrawn")).toBe(true)
    expect(await store().end(acme, id, "expired")).toBe(false)
    expect(await store().pendingInvitations(acme)).toEqual([])
    expect(await store().forInvitee("new@acme.test", new Date(0))).toBeNull()
  })

  it("stores the alert level per workspace", async () => {
    expect(await store().alert(acme)).toEqual({ level: 0, alertedAt: null })
    const at = new Date()
    await store().setAlert(acme, 80, at)
    await store().setAlert(acme, 100, at)
    expect(await store().alert(acme)).toEqual({ level: 100, alertedAt: at })
    expect(await store().alert(rival)).toEqual({ level: 0, alertedAt: null })
  })
})
