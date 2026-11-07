import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { reconcileQuotas, DEFAULT_MAILBOX_QUOTA_BYTES } from "../src/mail/quota.js"
import { allocationStore, workspaceOwnership } from "../src/mailboxes/allocation.js"
import { fakeRegistry, GIB } from "./mailbox-quota-fixtures.js"

/**
 * The allocation write against a real `authd.accounts`: the lock that closes the
 * check-then-write race, the tenant boundary on the write, and the CHECK that
 * keeps zero out of the column.
 *
 *   MAILBOX_QUOTA_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/quota_scratch bun test test/mailbox-quota-db.test.ts
 *
 * Needs the migrated schema (0135 adds the column). It writes under a per-run
 * prefix and removes what it wrote.
 */
const URL = process.env.MAILBOX_QUOTA_TEST_DATABASE_URL
const suite = URL ? describe : describe.skip
const RUN = crypto.randomUUID().slice(0, 8)

const A = crypto.randomUUID()
const B = crypto.randomUUID()
const user = (n: string) => `user_${RUN}_${n}`
const mail = (n: string) => `${n}-${RUN}@acme.test`
const POOL = { kind: "pool", bytes: 10 * GIB } as const

let owner: ReturnType<typeof postgres>
let db: Database
let store: ReturnType<typeof allocationStore>

const allocationOf = async (n: string) => {
  const [r] = await owner`select storage_allocation as a, active from authd.accounts
                           where clerk_user_id = ${user(n)}`
  return {
    allocation: r!.a === null ? null : Number(r!.a),
    active: r!.active as boolean,
  }
}

suite("mailbox storage allocation in Postgres", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 12, onnotice: () => {} })
    db = drizzle(owner, { schema }) as unknown as Database
    store = allocationStore(db)

    for (const n of ["a", "b", "c", "d", "e"]) {
      await owner`insert into authd.accounts (clerk_user_id, email, active, tenant_id)
                  values (${user(n)}, ${mail(n)}, ${n !== "e"}, ${A})`
    }
    await owner`insert into authd.accounts (clerk_user_id, email, active, tenant_id, storage_allocation)
                values (${user("other")}, ${mail("other")}, true, ${B}, ${GIB})`
  })

  afterAll(async () => {
    if (owner) {
      await owner`delete from authd.accounts where clerk_user_id like ${`user_${RUN}_%`}`
      await owner.end()
    }
  })

  /**
   * ⚠ THE RACE THE LOCK CLOSES. Five admins each ask for 4 GiB of a 10 GiB pool
   * at the same instant. Every one of them reads an empty pool and sees room; only
   * a lock that serialises the check with the write lets exactly two through.
   */
  it("lets exactly the allocations that fit through when five race for a 10 GiB pool", async () => {
    const outcomes = await Promise.all(
      ["a", "b", "c", "d", "e"].map((n) =>
        store.allocate({
          tenantId: A,
          address: mail(n),
          bytes: 4 * GIB,
          model: POOL,
        }),
      ),
    )

    expect(outcomes.filter((o) => o.status === "ok")).toHaveLength(2)
    expect(outcomes.filter((o) => o.status === "over_pool")).toHaveLength(3)

    const [sum] = await owner`select coalesce(sum(storage_allocation), 0)::bigint as s
                                from authd.accounts where tenant_id = ${A}`
    expect(Number(sum!.s)).toBe(8 * GIB)
  })

  it("serialises repeated races without deadlock and never passes the pool", async () => {
    await owner`update authd.accounts set storage_allocation = null where tenant_id = ${A}`

    const attempts = Array.from({ length: 30 }, (_, i) =>
      store.allocate({
        tenantId: A,
        address: mail(["a", "b", "c", "d", "e"][i % 5]!),
        bytes: (1 + (i % 4)) * GIB,
        model: POOL,
      }),
    )
    await Promise.all(attempts)

    const [sum] = await owner`select coalesce(sum(storage_allocation), 0)::bigint as s
                                from authd.accounts where tenant_id = ${A}`
    expect(Number(sum!.s)).toBeLessThanOrEqual(10 * GIB)
  })

  it("does not write an address that belongs to another workspace", async () => {
    const outcome = await store.allocate({
      tenantId: A,
      address: mail("other"),
      bytes: 5 * GIB,
      model: POOL,
    })

    expect(outcome.status).toBe("not_found")
    expect((await allocationOf("other")).allocation).toBe(GIB)
  })

  it("activates the inbox in the same write as the allocation", async () => {
    await owner`update authd.accounts set storage_allocation = null where tenant_id = ${A}`
    expect((await allocationOf("e")).active).toBe(false)

    const outcome = await store.allocate({
      tenantId: A,
      address: mail("e"),
      bytes: GIB,
      model: POOL,
      activate: true,
    })

    expect(outcome.status).toBe("ok")
    expect(await allocationOf("e")).toEqual({ allocation: GIB, active: true })
  })

  it("leaves the inbox inactive when the allocation is refused", async () => {
    await owner`update authd.accounts set active = false, storage_allocation = null
                 where clerk_user_id = ${user("e")}`
    await owner`update authd.accounts set storage_allocation = ${9 * GIB}
                 where clerk_user_id = ${user("a")}`

    const outcome = await store.allocate({
      tenantId: A,
      address: mail("e"),
      bytes: 2 * GIB,
      model: POOL,
      activate: true,
    })

    expect(outcome.status).toBe("over_pool")
    expect(await allocationOf("e")).toEqual({ allocation: null, active: false })
  })

  it("keeps zero out of the column", async () => {
    const outcome = await owner`update authd.accounts set storage_allocation = 0
                                 where clerk_user_id = ${user("b")}`.then(
      () => "written",
      (e: { constraint_name?: string }) => e.constraint_name ?? "refused",
    )
    expect(outcome).toBe("accounts_storage_allocation_positive")
  })

  it("lists a workspace's inboxes, oldest legacy ones with a null allocation", async () => {
    await owner`update authd.accounts set storage_allocation = null where tenant_id = ${A}`
    const rows = await store.rows(A)

    expect(rows.map((r) => r.address)).toContain(mail("a"))
    expect(rows.every((r) => r.allocation === null)).toBe(true)
    expect(rows.map((r) => r.address)).not.toContain(mail("other"))
  })

  it("reconciles real rows against a registry: allocation, or the default for null", async () => {
    await owner`update authd.accounts set storage_allocation = ${3 * GIB}
                 where clerk_user_id = ${user("a")}`
    await owner`update authd.accounts set storage_allocation = null
                 where clerk_user_id = ${user("b")}`

    const registry = fakeRegistry([
      { id: "ra", emailAddress: mail("a"), quotas: {} },
      { id: "rb", emailAddress: mail("b"), quotas: { maxDiskQuota: 5 } },
    ])
    await reconcileQuotas({ db, call: registry.call })

    expect(registry.accounts.map((a) => a.quotas)).toEqual([
      { maxDiskQuota: 3 * GIB },
      { maxDiskQuota: DEFAULT_MAILBOX_QUOTA_BYTES },
    ])

    // A second pass finds nothing to do.
    const before = registry.sets().length
    await reconcileQuotas({ db, call: registry.call })
    expect(registry.sets()).toHaveLength(before)
  })

  it("finds no ownership for a tenant that does not exist", async () => {
    expect(await workspaceOwnership(db, crypto.randomUUID())).toBeNull()
  })
})
