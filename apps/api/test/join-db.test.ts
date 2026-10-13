import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import { sql } from "drizzle-orm"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { joinStore } from "../src/console/join.js"

/**
 * Join suggestions against a real database as `i10_api` (2026-10-13): the two
 * audiences are row-level-security policies, and only Postgres can say whether
 * a seeker sees exactly what their verified domains entitle them to.
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
const other = crypto.randomUUID()
const seekerHome = crypto.randomUUID()
const suffix = acme.slice(0, 8)
const acmeDomain = `acme-${suffix}.test`

suite("join suggestions and requests", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    database = drizzle(db, { schema }) as unknown as Database
    for (const [id, name] of [
      [acme, "Acme"],
      [other, "Other"],
      [seekerHome, "Home"],
    ] as const) {
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
                  values (${id}, ${`j-${id.slice(0, 8)}`}, ${name}, ${`join-${id}`})`
    }
    await owner`insert into core.domains (tenant_id, name, status)
                values (${acme}, ${acmeDomain}, 'verified'),
                       (${other}, ${`other-${suffix}.test`}, 'pending')`
  })
  afterAll(async () => {
    await owner`delete from core.tenants where id in (${acme}, ${other}, ${seekerHome})`
    await owner.end()
    await db.end()
  })

  const store = () => joinStore(database)

  it("switches on only a domain the workspace has verified", async () => {
    expect(
      await store().set(other, {
        name: `other-${suffix}.test`,
        on: true,
        clerkOrgId: "org_o",
      }),
    ).toBe("missing")
    expect(
      await store().set(acme, {
        name: acmeDomain.toUpperCase(),
        on: true,
        clerkOrgId: "org_a",
      }),
    ).toBe("ok")
    expect(await store().enabled(acme)).toEqual([acmeDomain])
  })

  it("suggests it to a seeker with a verified address there, and nobody else", async () => {
    const seen = await store().suggestionsFor({
      currentTenantId: seekerHome,
      userId: "user_s",
      seekerDomains: [acmeDomain],
      exceptOrgIds: [],
    })
    expect(seen).toEqual([
      { tenantId: acme, clerkOrgId: "org_a", domain: acmeDomain, requested: false },
    ])
    const stranger = await store().suggestionsFor({
      currentTenantId: seekerHome,
      userId: "user_x",
      seekerDomains: ["elsewhere.test"],
      exceptOrgIds: [],
    })
    expect(stranger).toEqual([])
  })

  it("leaves out a workspace they are already in", async () => {
    const seen = await store().suggestionsFor({
      currentTenantId: seekerHome,
      userId: "user_s",
      seekerDomains: [acmeDomain],
      exceptOrgIds: ["org_a"],
    })
    expect(seen).toEqual([])
  })

  it("lets a seeker ask only a workspace that suggests their domain, once", async () => {
    const ask = (domains: string[]) =>
      store().request({
        currentTenantId: seekerHome,
        userId: "user_s",
        email: `s@${acmeDomain}`,
        seekerDomains: domains,
        tenantId: acme,
      })
    expect(await ask(["elsewhere.test"])).toBe("not_suggested")
    expect(await ask([acmeDomain])).toBe("created")
    expect(await ask([acmeDomain])).toBe("exists")
  })

  it("refuses at the database a request smuggled past the check", async () => {
    // As a seeker whose domains do not include Acme's: the policy says no.
    const refused = await database
      .transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${seekerHome}, true)`)
        await tx.execute(sql`select set_config('app.user_id', 'user_y', true)`)
        await tx.execute(
          sql`select set_config('app.seeker_domains', 'elsewhere.test', true)`,
        )
        await tx.execute(
          sql`insert into core.join_requests (tenant_id, user_id, email) values (${acme}, 'user_y', 'y@elsewhere.test')`,
        )
      })
      .then(
        () => null,
        (error: unknown) => error as { message?: string; cause?: { message?: string } },
      )
    // Drizzle wraps the query; Postgres's own reason is the cause.
    expect(refused?.cause?.message ?? refused?.message).toMatch(/row-level security/)
  })

  it("shows the workspace its requests, and an answer closes one", async () => {
    const [request] = await store().pending(acme)
    expect(request).toMatchObject({ user_id: "user_s", email: `s@${acmeDomain}` })
    expect(await store().pending(other)).toEqual([])
    expect(await store().answer(other, request!.id, true)).toBeNull()
    expect(await store().answer(acme, request!.id, true)).toMatchObject({
      id: request!.id,
    })
    expect(await store().pending(acme)).toEqual([])
    const after = await store().suggestionsFor({
      currentTenantId: seekerHome,
      userId: "user_s",
      seekerDomains: [acmeDomain],
      exceptOrgIds: [],
    })
    expect(after[0]?.requested).toBe(false)
  })

  it("stops suggesting when switched off, or when the domain goes", async () => {
    await store().set(acme, { name: acmeDomain, on: false, clerkOrgId: "org_a" })
    expect(await store().enabled(acme)).toEqual([])
    await store().set(acme, { name: acmeDomain, on: true, clerkOrgId: "org_a" })
    await owner`delete from core.domains where tenant_id = ${acme}`
    expect(await store().enabled(acme)).toEqual([])
  })
})
