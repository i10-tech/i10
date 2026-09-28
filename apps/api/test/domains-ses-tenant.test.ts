import { describe, expect, it, mock } from "bun:test"
import type { Database } from "../src/db/client.js"
import { TENANT_LAYOUT } from "../src/domains/identity.js"
import { ensureSesTenant } from "../src/domains/ses-tenant.js"

/**
 * Attach, then record (#156).
 *
 * ⚠ THE ORDER IS THE WHOLE POINT. The worker names a tenant on a send only when
 * `ses_tenant_name` is set, and SES refuses a tenant send it cannot match to
 * associated resources - so writing the column before, or despite, a failed
 * attach would turn an SES hiccup into refused mail.
 */

const TENANT = "0190a3e4-5b6c-7d8e-9f00-112233445566"
const WANTED = `i10-${TENANT}`

/** A database whose one domain row is `row`, recording every update. */
const fakeDb = (
  row: { name: string; current: string | null; layout?: number | null } | null,
) => {
  const updates: unknown[] = []
  const tx = {
    execute: async () => [],
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (row ? [{ layout: null, ...row }] : []) }),
      }),
    }),
    update: () => ({
      set: (values: unknown) => ({
        where: async () => {
          updates.push(values)
        },
      }),
    }),
  }
  const db = {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as Database
  return { db, updates }
}

describe("ensureSesTenant", () => {
  it("attaches and records a domain with no tenant yet", async () => {
    const { db, updates } = fakeDb({ name: "example.com", current: null })
    const attach = mock(async () => {})

    expect(await ensureSesTenant({ db, identity: { attach } }, TENANT, "dom-1")).toBe(
      "attached",
    )
    expect(attach).toHaveBeenCalledWith("example.com", WANTED)
    expect(updates).toEqual([{ sesTenantName: WANTED, sesTenantLayout: TENANT_LAYOUT }])
  })

  it("leaves a domain already recorded in the right tenant alone", async () => {
    const { db, updates } = fakeDb({
      name: "example.com",
      current: WANTED,
      layout: TENANT_LAYOUT,
    })
    const attach = mock(async () => {})

    expect(await ensureSesTenant({ db, identity: { attach } }, TENANT, "dom-1")).toBe(
      "current",
    )
    expect(attach).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })

  // ⚠ #154 added configuration sets; an older attach is missing them, and SES
  // refuses a tenant send through a set the tenant does not hold.
  it("re-attaches a domain recorded at an older layout", async () => {
    const { db, updates } = fakeDb({ name: "example.com", current: WANTED, layout: 1 })
    const attach = mock(async () => {})

    expect(await ensureSesTenant({ db, identity: { attach } }, TENANT, "dom-1")).toBe(
      "attached",
    )
    expect(updates).toEqual([{ sesTenantName: WANTED, sesTenantLayout: TENANT_LAYOUT }])
  })

  // ⚠ After a (re-)registration SES may still hold a previous owner's tenant.
  it("attaches anyway when forced", async () => {
    const { db } = fakeDb({ name: "example.com", current: WANTED })
    const attach = mock(async () => {})

    await ensureSesTenant({ db, identity: { attach } }, TENANT, "dom-1", {
      force: true,
    })
    expect(attach).toHaveBeenCalledTimes(1)
  })

  it("re-attaches a domain recorded under another workspace's tenant", async () => {
    const { db, updates } = fakeDb({ name: "example.com", current: "i10-someone-else" })
    const attach = mock(async () => {})

    await ensureSesTenant({ db, identity: { attach } }, TENANT, "dom-1")
    expect(attach).toHaveBeenCalledWith("example.com", WANTED)
    expect(updates).toEqual([{ sesTenantName: WANTED, sesTenantLayout: TENANT_LAYOUT }])
  })

  it("records nothing, and does not throw, when the attach fails", async () => {
    const { db, updates } = fakeDb({ name: "example.com", current: null })
    const error = mock(() => {})
    const attach = mock(async () => {
      throw new Error("ThrottlingException")
    })

    expect(
      await ensureSesTenant(
        { db, identity: { attach }, log: { error } },
        TENANT,
        "dom-1",
      ),
    ).toBe("failed")
    expect(updates).toEqual([])
    expect(error).toHaveBeenCalledTimes(1)
  })

  it("answers missing for a row it cannot see", async () => {
    const { db } = fakeDb(null)
    const attach = mock(async () => {})

    expect(await ensureSesTenant({ db, identity: { attach } }, TENANT, "dom-1")).toBe(
      "missing",
    )
    expect(attach).not.toHaveBeenCalled()
  })
})
