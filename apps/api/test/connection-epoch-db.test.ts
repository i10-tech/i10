import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { identityStore } from "../src/identity/store.js"
import { raiseConnectionCredentialEpochs } from "../src/projection/connection-epoch.js"
import { secretBox } from "../src/webhooks/signing.js"

/**
 * Revoking a connection's cached mail passwords (#383), against a real database
 * as `i10_api`: only the accounts the connection manages have their
 * `credential_epoch` raised, and nothing else about them moves.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/templates_scratch_383 bun test test/connection-epoch-db.test.ts
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let db: ReturnType<typeof postgres>
let database: Database
const acme = crypto.randomUUID()
const suffix = acme.slice(0, 8)
const [ada, bob, carol, dan, eve] = ["ada", "bob", "carol", "dan", "eve"].map(
  (n) => `user_${n}_${suffix}`,
) as [string, string, string, string, string]
const box = secretBox("ab".repeat(32))

suite("raising a connection's credential epochs", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    database = drizzle(db, { schema }) as unknown as Database
    await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                values (${acme}, ${`a-${suffix}`}, 'Acme', ${`owner-${acme}`}, ${`org_${suffix}`})`
  })
  afterAll(async () => {
    await owner`delete from authd.accounts where clerk_user_id in ${owner([ada, bob, carol, dan, eve])}`
    await owner`delete from core.tenants where id = ${acme}`
    await owner.end()
    await db.end()
  })

  const store = () => identityStore(database, box)
  const claim = (userId: string, connectionId: string) =>
    store().claimManaged(acme, {
      clerkUserId: userId,
      tenantId: acme,
      connectionId,
      reason: "linked" as const,
      emails: [`${userId}@acme.test`],
    })
  const account = async (userId: string) => {
    const [row] =
      await owner`select credential_epoch, active, clerk_updated_at, suspended_at, updated_at
                              from authd.accounts where clerk_user_id = ${userId}`
    return row
  }

  it("raises the epoch of the accounts one connection manages, and no others", async () => {
    const one = (
      await store().createConnection(acme, {
        name: "One",
        protocol: "test",
        provider: "okta",
        createdBy: "u",
      })
    ).id
    const two = (
      await store().createConnection(acme, {
        name: "Two",
        protocol: "test",
        provider: "okta",
        createdBy: "u",
      })
    ).id
    await claim(ada, one)
    await claim(bob, one)
    await claim(carol, two)
    // eve is managed by `one` but has never authenticated: no mailbox row.
    await claim(eve, one)
    const changed = new Date("2026-11-01T00:00:00Z")
    for (const [userId, epoch] of [
      [ada, 0],
      [bob, 5],
      [carol, 0],
      [dan, 0],
    ] as const)
      await owner`insert into authd.accounts (clerk_user_id, email, active, credential_epoch, clerk_updated_at, suspended_at)
                  values (${userId}, ${`${userId}@acme.test`}, true, ${epoch}, ${changed}, ${changed})`

    const before = await account(ada)
    await raiseConnectionCredentialEpochs(database, one)

    expect(Number((await account(ada))!.credential_epoch)).toBe(1)
    expect(Number((await account(bob))!.credential_epoch)).toBe(6)
    // Another connection's account, and one nobody manages: untouched.
    expect(Number((await account(carol))!.credential_epoch)).toBe(0)
    expect(Number((await account(dan))!.credential_epoch)).toBe(0)
    // An account with no mailbox row is not created by the raise.
    expect(await account(eve)).toBeUndefined()

    // Nothing else about the account moves.
    const after = await account(ada)
    expect(after!.active).toBe(true)
    expect(after!.suspended_at).toEqual(before!.suspended_at)
    expect(after!.clerk_updated_at).toEqual(before!.clerk_updated_at)
    expect(after!.updated_at.getTime()).toBeGreaterThanOrEqual(
      before!.updated_at.getTime(),
    )

    // Each raise is one more.
    await raiseConnectionCredentialEpochs(database, one)
    expect(Number((await account(ada))!.credential_epoch)).toBe(2)
    expect(Number((await account(carol))!.credential_epoch)).toBe(0)
  })

  it("is a no-op for a connection that manages nobody", async () => {
    await raiseConnectionCredentialEpochs(database, crypto.randomUUID())
    expect(Number((await account(dan))!.credential_epoch)).toBe(0)
  })
})
