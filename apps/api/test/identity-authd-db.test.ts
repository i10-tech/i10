import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { identityStore } from "../src/identity/store.js"
import { secretBox } from "../src/webhooks/signing.js"

/**
 * What authd is told about managed accounts (#344), against a real database as
 * `i10_api`: `authd.managed_accounts` follows every claim, move, release and
 * forget of `identity.managed_accounts`, in the same transaction.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/templates_scratch_344 bun test test/identity-authd-db.test.ts
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
const ada = `user_ada_${suffix}`
const bob = `user_bob_${suffix}`
const box = secretBox("ab".repeat(32))

suite("authd.managed_accounts", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    database = drizzle(db, { schema }) as unknown as Database
    for (const [id, name] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const)
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                  values (${id}, ${`a-${id.slice(0, 8)}`}, ${name}, ${`owner-${id}`}, ${`org_${id.slice(0, 8)}`})`
  })
  afterAll(async () => {
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await db.end()
  })

  const store = () => identityStore(database, box)
  const mirrored = async (userId: string) =>
    (
      await owner`select connection_id from authd.managed_accounts where clerk_user_id = ${userId}`
    ).map((r) => r.connection_id as string | null)
  const row = (userId: string, connectionId: string | null) => ({
    clerkUserId: userId,
    tenantId: acme,
    connectionId,
    reason: "linked" as const,
    emails: [`${userId}@acme.test`],
  })

  let one = ""
  let two = ""
  it("is not there for an account nobody manages", async () => {
    expect(await mirrored(ada)).toEqual([])
    const a = await store().createConnection(acme, {
      name: "One",
      protocol: "test",
      provider: "generic",
      createdBy: "u",
    })
    const b = await store().createConnection(acme, {
      name: "Two",
      protocol: "test",
      provider: "generic",
      createdBy: "u",
    })
    one = a.id
    two = b.id
  })

  it("follows a claim, with the connection that answers its binds", async () => {
    expect(await store().claimManaged(acme, row(ada, one))).toBe("created")
    expect(await mirrored(ada)).toEqual([one])
    // Before the account has any mailbox row: managed does not wait for one.
    expect(
      await owner`select 1 from authd.accounts where clerk_user_id = ${ada}`,
    ).toHaveLength(0)
  })

  it("heals a missing mirror when the same workspace claims again, and leaves another workspace's account alone", async () => {
    await owner`delete from authd.managed_accounts where clerk_user_id = ${ada}`
    expect(await store().claimManaged(acme, row(ada, one))).toBe("kept")
    expect(await mirrored(ada)).toEqual([one])
    expect(
      await store().claimManaged(rival, { ...row(ada, null), tenantId: rival }),
    ).toBe("elsewhere")
    expect(await mirrored(ada)).toEqual([one])
  })

  it("follows the connection when the account moves to another", async () => {
    await store().setManagedEmails(acme, ada, [`ada@acme.test`], two)
    expect(await mirrored(ada)).toEqual([two])
    // Changing only the addresses keeps it where it is.
    await store().setManagedEmails(acme, ada, [`ada2@acme.test`])
    expect(await mirrored(ada)).toEqual([two])
  })

  it("is managed by nothing, not freed, when its connection is deleted", async () => {
    await owner`delete from identity.connections where id = ${two}`
    expect(await mirrored(ada)).toEqual([null])
    expect((await store().managedByUser(ada))?.connectionId).toBeNull()
  })

  it("goes when the account is released, not when someone else tries to release it", async () => {
    expect(await store().releaseManaged(rival, ada)).toBe(false)
    expect(await mirrored(ada)).toEqual([null])
    expect(await store().releaseManaged(acme, ada)).toBe(true)
    expect(await mirrored(ada)).toEqual([])
  })

  it("goes when the user is forgotten", async () => {
    await store().claimManaged(acme, row(bob, one))
    expect(await mirrored(bob)).toEqual([one])
    await store().forgetUser(acme, bob)
    expect(await mirrored(bob)).toEqual([])
  })

  it("goes with the workspace", async () => {
    await store().claimManaged(acme, row(bob, one))
    expect(await mirrored(bob)).toEqual([one])
    await owner`delete from core.tenants where id = ${acme}`
    expect(await mirrored(bob)).toEqual([])
  })
})
