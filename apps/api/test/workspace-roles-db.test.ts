import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { roleStore } from "../src/console/roles-db.js"
import { changeRole, membershipCreated, seedOwner } from "../src/console/roles.js"

/**
 * Workspace roles against a real database as `i10_api` (#335): the policy
 * keeps each workspace to its own rows, the check keeps roles to ours, and
 * `transact`'s lock serialises two decisions about the same workspace.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/templates_scratch bun test test/workspace-roles-db.test.ts
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let db: ReturnType<typeof postgres>
let database: Database
const acme = crypto.randomUUID()
const rival = crypto.randomUUID()

suite("workspace roles", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    database = drizzle(db, { schema }) as unknown as Database
    for (const [id, name] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const)
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
                  values (${id}, ${`r-${id.slice(0, 8)}`}, ${name}, 'u_founder')`
  })
  afterAll(async () => {
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await db.end()
  })

  const store = () => roleStore(database)

  it("seeds the owner, attaches the membership, and keeps each workspace's own", async () => {
    expect(await store().transact(acme, (rows) => seedOwner(rows, "u_founder"))).toBe(
      "seeded",
    )
    expect(
      await store().transact(acme, (rows) =>
        membershipCreated(rows, {
          userId: "u_founder",
          membershipId: "mem_f",
          role: "member",
          source: "membership",
        }),
      ),
    ).toBe("attached")
    expect(await store().list(acme)).toEqual([
      {
        userId: "u_founder",
        role: "owner",
        membershipId: "mem_f",
        source: "creator",
        grantedBy: null,
      },
    ])
    expect(await store().roleOf(acme, "u_founder")).toBe("owner")
    // ⚠ The policy: another workspace sees none of it.
    expect(await store().list(rival)).toEqual([])
    expect(await store().roleOf(rival, "u_founder")).toBeNull()
  })

  it("refuses a role that is not ours", async () => {
    /*
     * ⚠ CAUGHT BY HAND, NOT `expect(...).rejects`. A postgres.js query is a
     * lazy thenable that is only sent when something calls `.then` on it, and
     * bun's `rejects` never does - so the INSERT is never sent, the matcher
     * waits on a promise nothing will settle, and the whole file hangs with
     * the connection idle (see the same note in risk-db.test.ts).
     */
    let refused: unknown = null
    try {
      await owner`insert into core.workspace_roles (tenant_id, clerk_user_id, role, source)
                  values (${acme}, 'u_x', 'superadmin', 'membership')`
    } catch (error) {
      refused = error
    }
    expect(String(refused)).toMatch(/workspace_roles_role_check/)
  })

  it("serialises two owners demoting each other: one owner is left", async () => {
    await store().transact(acme, () => ({
      writes: [
        {
          put: {
            userId: "u_second",
            role: "owner",
            membershipId: "mem_s",
            source: "changed",
            grantedBy: "u_founder",
          },
        },
      ],
      result: null,
    }))
    const results = await Promise.all([
      store().transact(acme, (rows) =>
        changeRole(rows, {
          actorUserId: "u_founder",
          userId: "u_second",
          role: "member",
        }),
      ),
      store().transact(acme, (rows) =>
        changeRole(rows, {
          actorUserId: "u_second",
          userId: "u_founder",
          role: "member",
        }),
      ),
    ])
    expect(results.map((r) => r.outcome).sort()).toEqual(["forbidden", "ok"])
    const owners = (await store().list(acme)).filter((r) => r.role === "owner")
    expect(owners).toHaveLength(1)
  })
})
