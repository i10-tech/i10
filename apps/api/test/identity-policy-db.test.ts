import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { assertRlsSubject, withTenant, type Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { identityStore } from "../src/identity/store.js"
import { ssoPolicyStore } from "../src/identity/policy-store.js"
import { hashSecret } from "../src/identity/model.js"
import { setupLinks } from "../src/db/identity.js"

/**
 * #340's tables and reads against a real database as `i10_api`: enforcement
 * facts read in one workspace, the bypass audit once per session, two owners
 * for the exemption, a setup link found only by its own hash, and discovery
 * through #326's seeker policy.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/templates_scratch bun test test/identity-policy-db.test.ts
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let db: ReturnType<typeof postgres>
let database: Database
const acme = crypto.randomUUID()
const rival = crypto.randomUUID()
const suffix = acme.slice(0, 8)
const live = `acme-${suffix}.test`
const gone = `gone-${suffix}.test`
const ada = `user_ada_${suffix}`
const boss = `user_boss_${suffix}`
const boss2 = `user_boss2_${suffix}`
let liveProof = ""
let goneProof = ""
let connectionId = ""
let draftId = ""

suite("#340 policy store", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    database = drizzle(db, { schema }) as unknown as Database
    for (const [id, name] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const)
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                  values (${id}, ${`p-${id.slice(0, 8)}`}, ${name}, ${`owner-${id}`}, ${`org_${id.slice(0, 8)}`})`
    const [a] =
      await owner`insert into core.join_domains (tenant_id, name, clerk_org_id, source, verified_at)
                  values (${acme}, ${live}, 'org_a', 'txt', now()) returning id`
    const [b] =
      await owner`insert into core.join_domains (tenant_id, name, clerk_org_id, source, verified_at, displaced_at)
                  values (${acme}, ${gone}, 'org_a', 'txt', now(), now()) returning id`
    liveProof = a!.id as string
    goneProof = b!.id as string
    for (const [user, role] of [
      [boss, "owner"],
      [boss2, "owner"],
      [ada, "member"],
    ] as const)
      await owner`insert into core.workspace_roles (tenant_id, clerk_user_id, role, source)
                  values (${acme}, ${user}, ${role}, 'test')`
    const identity = identityStore(database, null)
    const made = await identity.createConnection(acme, {
      name: "Acme Okta",
      protocol: "test",
      provider: "generic",
      createdBy: boss,
    })
    connectionId = made.id
    expect(await identity.addDomain(acme, connectionId, liveProof)).toBe("added")
    const draft = await identity.createConnection(acme, {
      name: "Draft",
      protocol: "test",
      provider: "generic",
      createdBy: boss,
    })
    draftId = draft.id
    expect(await identity.addDomain(acme, draftId, goneProof)).toBe("not_found")
  })
  afterAll(async () => {
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await db.end()
  })

  const store = () => ssoPolicyStore(database)

  it("keeps the boot check passing with the new table and policy", async () => {
    await assertRlsSubject(db)
  })

  it("reads nothing required until an active connection requires SSO", async () => {
    expect(await store().enforcementRead(acme, ada, "sess_a")).toEqual({
      required: false,
    })
    await owner`update identity.connections set status = 'active', enforcement = 'optional' where id = ${connectionId}`
    expect(await store().enforcementRead(acme, ada, "sess_a")).toEqual({
      required: false,
    })
    await owner`update identity.connections set enforcement = 'required_domain' where id = ${connectionId}`
    const read = await store().enforcementRead(acme, ada, "sess_a")
    expect(read).toMatchObject({
      required: true,
      connections: [{ id: connectionId, domains: [live], bypassed: false }],
      exemption: true,
      privileged: false,
      managed: false,
      session: null,
    })
    expect(
      (await store().enforcementRead(acme, boss, "sess_b")) as unknown,
    ).toMatchObject({
      privileged: true,
    })
    // Another workspace sees none of Acme's.
    expect(await store().enforcementRead(rival, ada, "sess_a")).toEqual({
      required: false,
    })
  })

  it("sees a managed row of another workspace, and a bound session only in this one", async () => {
    await owner`insert into identity.managed_accounts (clerk_user_id, tenant_id, reason)
                values (${ada}, ${rival}, 'claimed')`
    await owner`insert into identity.sso_sessions (session_id, tenant_id, clerk_user_id, connection_id)
                values ('sess_bound', ${acme}, ${ada}, ${connectionId})`
    const read = await store().enforcementRead(acme, ada, "sess_bound")
    expect(read).toMatchObject({ managed: true, session: { revokedAt: null } })
    expect(await store().enforcementRead(acme, ada, "sess_other")).toMatchObject({
      session: null,
    })
    await owner`update identity.sso_sessions set revoked_at = now() where session_id = 'sess_bound'`
    expect(await store().enforcementRead(acme, ada, "sess_bound")).toMatchObject({
      session: null,
    })
    await owner`delete from identity.managed_accounts where clerk_user_id = ${ada}`
  })

  it("lists a bypass for its person and connection only, and audits a bypass sign-in once", async () => {
    expect(
      await store().addBypass(acme, connectionId, {
        clerkUserId: ada,
        reason: "IdP outage",
        addedBy: boss,
      }),
    ).toBe("added")
    expect(
      await store().addBypass(acme, connectionId, {
        clerkUserId: ada,
        reason: "x",
        addedBy: boss,
      }),
    ).toBe("exists")
    expect(
      await store().addBypass(rival, connectionId, {
        clerkUserId: ada,
        reason: "x",
        addedBy: boss,
      }),
    ).toBe("not_found")
    expect(await store().enforcementRead(acme, ada, "s")).toMatchObject({
      connections: [{ bypassed: true }],
    })
    expect(await store().enforcementRead(acme, boss, "s")).toMatchObject({
      connections: [{ bypassed: false }],
    })
    const note = () =>
      store().noteBypassSignIn(acme, {
        sessionId: "sess_bypass",
        clerkUserId: ada,
        connectionIds: [connectionId],
      })
    expect(await Promise.all([note(), note(), note()])).toEqual(
      expect.arrayContaining([true, false, false]),
    )
    const events = await owner`select session_id, connection_id from identity.events
                  where tenant_id = ${acme} and type = 'sso.bypass_used'`
    expect([...events]).toEqual([
      { session_id: "sess_bypass", connection_id: connectionId },
    ])
    expect((await store().removeBypass(acme, connectionId, ada))?.reason).toBe(
      "IdP outage",
    )
    expect(await store().removeBypass(acme, connectionId, ada)).toBeNull()
  })

  it("needs two different owners, within a day, to turn the exemption off", async () => {
    const now = new Date()
    expect(await store().ownerExemption(acme, now)).toEqual({
      enabled: true,
      pending: null,
    })
    expect(await store().approveExemptionOff(acme, boss2, now)).toEqual({
      outcome: "none",
    })
    expect(await store().requestExemptionOff(acme, boss, now)).toBe("requested")
    expect(await store().requestExemptionOff(acme, boss2, now)).toBe("pending")
    expect(await store().approveExemptionOff(acme, boss, now)).toEqual({
      outcome: "same_owner",
    })
    // A day later the request is gone.
    const later = new Date(now.getTime() + 24 * 3600_000 + 1000)
    expect(await store().approveExemptionOff(acme, boss2, later)).toEqual({
      outcome: "none",
    })
    // A request from somebody no longer an owner is nobody's.
    await owner`update core.workspace_roles set role = 'admin' where tenant_id = ${acme} and clerk_user_id = ${boss}`
    expect(await store().approveExemptionOff(acme, boss2, now)).toEqual({
      outcome: "none",
    })
    await owner`update core.workspace_roles set role = 'owner' where tenant_id = ${acme} and clerk_user_id = ${boss}`
    const both = await Promise.all([
      store().approveExemptionOff(acme, boss2, now),
      store().approveExemptionOff(acme, boss2, now),
    ])
    expect(both.map((b) => b.outcome).sort()).toEqual(["applied", "none"])
    expect(await store().ownerExemption(acme, now)).toEqual({
      enabled: false,
      pending: null,
    })
    expect(await store().enforcementRead(acme, ada, "s")).toMatchObject({
      exemption: false,
    })
    expect(await store().requestExemptionOff(acme, boss, now)).toBe("off")
    expect(await store().enableExemption(acme, boss)).toBe(true)
    expect(await store().enableExemption(acme, boss)).toBe(false)
    expect(await store().requestExemptionOff(acme, boss, now)).toBe("requested")
    expect(await store().cancelExemptionOff(acme)).toBe(true)
    expect(await store().cancelExemptionOff(acme)).toBe(false)
  })

  it("counts only a passed test run inside the window", async () => {
    await owner`insert into identity.test_runs (tenant_id, connection_id, outcome, created_at)
                values (${acme}, ${connectionId}, 'failed', now()),
                       (${acme}, ${connectionId}, 'passed', now() - interval '2 days')`
    const since = new Date(Date.now() - 24 * 3600_000)
    expect(await store().passedTestRunSince(acme, connectionId, since)).toBe(false)
    await owner`insert into identity.test_runs (tenant_id, connection_id, outcome)
                values (${acme}, ${connectionId}, 'passed')`
    expect(await store().passedTestRunSince(acme, connectionId, since)).toBe(true)
    expect(await store().passedTestRunSince(rival, connectionId, since)).toBe(false)
  })

  it("discovers only active connections covering a live proof of exactly that name", async () => {
    expect(await store().discover(live)).toEqual([
      expect.objectContaining({
        id: connectionId,
        tenantId: acme,
        name: "Acme Okta",
        enforcement: "required_domain",
      }),
    ])
    expect(await store().discover(`sub.${live}`)).toEqual([])
    expect(await store().discover(gone)).toEqual([])
    expect(await store().discover(`${live},${gone}`)).toEqual([])
    await owner`update identity.connections set status = 'disabled' where id = ${connectionId}`
    expect(await store().discover(live)).toEqual([])
    await owner`update identity.connections set status = 'active' where id = ${connectionId}`
  })

  it("finds a setup link by its own hash only, and spends its first use once", async () => {
    const hashA = hashSecret(`i10_setup_${"a".repeat(43)}`)
    const hashB = hashSecret(`i10_setup_${"b".repeat(43)}`)
    const a = await store().createSetupLink(acme, {
      connectionId: draftId,
      tokenHash: hashA,
      contactEmail: "it@acme.test",
      createdBy: boss,
      expiresAt: new Date(Date.now() + 3600_000),
    })
    await store().createSetupLink(acme, {
      connectionId: draftId,
      tokenHash: hashB,
      contactEmail: null,
      createdBy: boss,
      expiresAt: new Date(Date.now() + 3600_000),
    })
    expect((await store().setupLinkByHash(hashA))?.id).toBe(a.id)
    expect(await store().setupLinkByHash(hashSecret("unknown"))).toBeNull()
    expect(await store().setupLinkByHash("not-a-hash")).toBeNull()
    // ⚠ THE SETTING ADMITS ITS OWN ROW AND NOTHING ELSE, whatever the query asks.
    const seen = await withTenant(
      database,
      "00000000-0000-0000-0000-000000000000",
      async (tx) => {
        await tx.execute(sql`select set_config('app.setup_token', ${hashA}, true)`)
        return tx.select({ id: setupLinks.id }).from(setupLinks)
      },
    )
    expect(seen).toEqual([{ id: a.id }])
    expect(await store().setupLinks(rival, draftId)).toEqual([])
    const at = new Date()
    expect(await store().markSetupLinkUsed(acme, a.id, at)).toBe(true)
    expect(await store().markSetupLinkUsed(acme, a.id, at)).toBe(false)
    expect(
      await store().revokeSetupLink(acme, draftId, a.id, "done", at),
    ).toMatchObject({
      revokedReason: "done",
    })
    expect(await store().revokeSetupLink(acme, draftId, a.id, "again", at)).toBeNull()
    expect(
      await store().revokeSetupLinksOf(acme, draftId, "connection_left_setup", at),
    ).toHaveLength(1)
    expect(
      await store().revokeSetupLinksOf(acme, draftId, "connection_left_setup", at),
    ).toEqual([])
  })
})
