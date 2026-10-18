import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import { sql } from "drizzle-orm"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { joinStore, recheckAccessDomains } from "../src/console/join.js"
import { NO_TENANT } from "../src/middleware/tenant.js"

/**
 * Team access domains against a real database as `i10_api` (#326): the
 * audiences are row-level-security policies, and only Postgres can say
 * whether a seeker sees exactly what their verified domains entitle them to,
 * and whether "latest proof wins" reaches across workspaces.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/templates_scratch bun test test/join-db.test.ts
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
const acmeDomain = `acme-${suffix}.test`
const txtDomain = `txt-${suffix}.test`

suite("team access domains", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    database = drizzle(db, { schema }) as unknown as Database
    for (const [id, name] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const) {
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
                  values (${id}, ${`j-${id.slice(0, 8)}`}, ${name}, ${`join-${id}`})`
    }
    await owner`insert into core.domains (tenant_id, name, status)
                values (${acme}, ${acmeDomain}, 'verified'),
                       (${rival}, ${`other-${suffix}.test`}, 'pending')`
  })
  afterAll(async () => {
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await db.end()
  })

  const store = () => joinStore(database)
  let acmeId = ""
  let txtId = ""

  it("adds from /domains only a name the workspace verified there", async () => {
    expect(
      await store().addAccessDomain(rival, {
        name: `other-${suffix}.test`,
        clerkOrgId: "org_r",
        source: "domains",
      }),
    ).toEqual({ outcome: "not_verified", id: null })
    const made = await store().addAccessDomain(acme, {
      name: acmeDomain.toUpperCase(),
      clerkOrgId: "org_a",
      source: "domains",
    })
    expect(made.outcome).toBe("created")
    acmeId = made.id!
    const [row] = await store().accessDomains(acme)
    expect(row).toMatchObject({
      name: acmeDomain,
      source: "domains",
      status: "verified",
    })
  })

  it("matches a seeker at a subdomain through the parent's row, and nobody else", async () => {
    await store().setRules(acme, acmeId, [
      { pattern: `*.${acmeDomain}`, mode: "auto", role: "org:member" },
    ])
    const seen = await store().accessFor({
      currentTenantId: NO_TENANT,
      userId: "user_s",
      emails: [`s@dev.${acmeDomain}`],
    })
    expect(seen.domains.map((d) => d.tenantId)).toEqual([acme])
    const stranger = await store().accessFor({
      currentTenantId: NO_TENANT,
      userId: "user_x",
      emails: ["x@elsewhere.test"],
    })
    expect(stranger.domains).toEqual([])
  })

  it("files a request and records a join into the other workspace, which the person can read", async () => {
    expect(
      await store().fileRequest(acme, {
        userId: "user_s",
        email: `s@dev.${acmeDomain}`,
        via: `*.${acmeDomain}`,
        full: true,
      }),
    ).toBe("created")
    expect(
      await store().fileRequest(acme, {
        userId: "user_s",
        email: `s@dev.${acmeDomain}`,
        via: null,
        full: true,
      }),
    ).toBe("exists")
    const arrived = await store().arrivals("user_s", new Date(Date.now() - 60_000))
    expect(arrived).toEqual([
      { tenantId: acme, via: `*.${acmeDomain}`, outcome: "full" },
    ])
    await store().recordJoin(acme, {
      userId: "user_j",
      email: `j@dev.${acmeDomain}`,
      how: "auto",
      via: `*.${acmeDomain}`,
    })
    expect((await store().joins(acme)).map((j) => j.user_id)).toEqual(["user_j"])
    // Another person reads nothing of it.
    expect(await store().arrivals("user_other", new Date(0))).toEqual([])
  })

  it("keeps the removed and block lists by address, blocked the stronger", async () => {
    await store().exclude(acme, ["Gone@x.test"], "blocked")
    await store().exclude(acme, ["gone@x.test"], "removed")
    expect([...(await store().excluded(acme, ["GONE@x.test"]))]).toEqual([
      ["gone@x.test", "blocked"],
    ])
    expect(await store().excluded(rival, ["gone@x.test"])).toEqual(new Map())
    await store().allow(acme, ["gone@x.test"])
    expect(await store().exclusions(acme)).toEqual([])
  })

  it("refuses at the database a workspace reading another's lists", async () => {
    await store().exclude(acme, ["secret@x.test"], "blocked")
    const rows = await database.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${rival}, true)`)
      return tx.execute(sql`select email from core.join_exclusions`)
    })
    expect([...(rows as unknown as unknown[])]).toEqual([])
  })

  it("proves a TXT entry only with the exact record", async () => {
    const made = await store().addAccessDomain(rival, {
      name: txtDomain,
      clerkOrgId: "org_r",
      source: "txt",
    })
    txtId = made.id!
    const [row] = await store().accessDomains(rival)
    expect(row?.status).toBe("pending")
    expect(await store().verifyTxt(rival, txtId, async () => ["nope"])).toBe("absent")
    expect(
      await store().verifyTxt(rival, txtId, async () => {
        throw new Error("timeout")
      }),
    ).toBe("unreachable")
    expect(await store().verifyTxt(rival, txtId, async () => [row!.txt.value])).toBe(
      "proven",
    )
    expect((await store().accessDomains(rival))[0]?.status).toBe("verified")
  })

  it("latest proof wins: another workspace proving the same name displaces the older", async () => {
    const made = await store().addAccessDomain(acme, {
      name: txtDomain,
      clerkOrgId: "org_a",
      source: "txt",
    })
    const value = (await store().accessDomains(acme)).find((r) => r.id === made.id)!.txt
      .value
    expect(await store().verifyTxt(acme, made.id!, async () => [value])).toBe("proven")
    const rivals = await store().accessDomains(rival)
    expect(rivals.find((r) => r.name === txtDomain)?.status).toBe("displaced")
  })

  it("a lapsed proof stops matching, and comes back by itself", async () => {
    const fail = async () => [] as string[]
    const old = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
    await recheckAccessDomains({
      db: database,
      lookup: fail,
      now: () => old,
      batch: 5000,
    })
    const row = (await store().accessDomains(acme)).find((r) => r.name === txtDomain)!
    expect(row.status).toBe("lapsed")
    const later = new Date(old.getTime() + 2 * 24 * 60 * 60 * 1000)
    await recheckAccessDomains({
      db: database,
      lookup: async () => [row.txt.value],
      now: () => later,
      batch: 5000,
    })
    expect(
      (await store().accessDomains(acme)).find((r) => r.name === txtDomain)?.status,
    ).toBe("verified")
  })

  it("a /domains entry whose domain is deleted stops matching and asks for its own TXT", async () => {
    await owner`delete from core.domains where tenant_id = ${acme}`
    const row = (await store().accessDomains(acme)).find((r) => r.name === acmeDomain)!
    expect(row).toMatchObject({ status: "pending", orphaned: true })
    const seen = await store().accessFor({
      currentTenantId: NO_TENANT,
      userId: "user_s",
      emails: [`s@dev.${acmeDomain}`],
    })
    expect(seen.domains.map((d) => d.name)).not.toContain(acmeDomain)
  })
})
