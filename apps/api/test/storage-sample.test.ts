import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import { describe, expect, it, vi } from "vitest"
import {
  mailboxesStatement,
  recordStorageStatement,
  sampleStorage,
} from "../src/mail/storage.js"
import { stalwartStorage } from "../src/mail/stalwart.js"
import type { Database } from "../src/db/client.js"

const dialect = new PgDialect()
const A = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const B = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6072"
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function fakeDb(rows: unknown[]) {
  const seen: { sql: string; params: unknown[] }[] = []
  const execute = vi.fn(async (query: SQL) => {
    const rendered = dialect.sqlToQuery(query)
    seen.push({ sql: rendered.sql, params: rendered.params })
    return rendered.sql.includes("tenant_mailboxes") ? rows : []
  })
  const db = {
    execute,
    transaction: async (fn: (tx: { execute: typeof execute }) => Promise<unknown>) =>
      fn({ execute }),
  } as unknown as Database
  return { db, seen }
}

const writes = (seen: { sql: string; params: unknown[] }[]) =>
  seen.filter((s) => s.sql.includes("insert into core.tenant_storage"))

describe("what gets asked", () => {
  // Cross-tenant: the job holds no tenant context, so it goes through the
  // definer function rather than reading `authd.accounts` directly.
  it("reads mailboxes through the definer function", () => {
    expect(dialect.sqlToQuery(mailboxesStatement()).sql).toContain(
      "core.tenant_mailboxes()",
    )
  })

  // One row per tenant, overwritten. A level has no history worth keeping where
  // the gate reads it.
  it("upserts one row per tenant", () => {
    const { sql: statement } = dialect.sqlToQuery(recordStorageStatement(A, 42))
    expect(statement).toContain("on conflict (tenant_id) do update")
    expect(statement).toContain("bytes = excluded.bytes")
  })
})

describe("sampling", () => {
  it("sums a tenant's mailboxes into one figure", async () => {
    const { db, seen } = fakeDb([
      { tenant_id: A, email: "a@acme.com" },
      { tenant_id: A, email: "b@acme.com" },
    ])

    const report = await sampleStorage({
      db,
      mail: { usedBytes: async () => 1_000 },
      log,
    })

    expect(report).toMatchObject({ tenants: 1, mailboxes: 2, failed: 0 })
    expect(writes(seen)[0]?.params).toContain(2_000)
  })

  /**
   * ⚠ THE ASSERTION THIS FILE EXISTS FOR. One unreadable mailbox makes the
   * tenant's total silently low — which on a cap lets them past their limit and
   * on billing under-charges, both invisibly. Keeping the previous sample is
   * stale and honest; writing a partial one is neither.
   */
  it("writes nothing for a tenant it could not read completely", async () => {
    const { db, seen } = fakeDb([
      { tenant_id: A, email: "ok@acme.com" },
      { tenant_id: A, email: "broken@acme.com" },
    ])

    const report = await sampleStorage({
      db,
      mail: {
        usedBytes: async (email) => {
          if (email === "broken@acme.com") throw new Error("500")
          return 1_000
        },
      },
      log,
    })

    expect(report.failed).toBe(1)
    expect(writes(seen)).toHaveLength(0)
  })

  // ⚠ And one tenant's failure is not another's. A shared mail server having a
  // bad moment for one mailbox must not freeze everybody's figure.
  it("still writes the tenants it could read", async () => {
    const { db, seen } = fakeDb([
      { tenant_id: A, email: "broken@acme.com" },
      { tenant_id: B, email: "ok@other.com" },
    ])

    await sampleStorage({
      db,
      mail: {
        usedBytes: async (email) => {
          if (email === "broken@acme.com") throw new Error("500")
          return 7
        },
      },
      log,
    })

    const written = writes(seen)
    expect(written).toHaveLength(1)
    expect(written[0]?.params).toContain(B)
  })

  it("scopes each write to its own tenant", async () => {
    const { db, seen } = fakeDb([{ tenant_id: A, email: "a@acme.com" }])
    await sampleStorage({ db, mail: { usedBytes: async () => 1 }, log })
    expect(seen.some((s) => s.sql.includes("set_config('app.tenant_id'"))).toBe(true)
  })
})

describe("asking Stalwart", () => {
  const client = (response: unknown, ok = true) =>
    stalwartStorage({
      baseUrl: "https://mail.i10.tech",
      token: "t",
      fetch: (async () =>
        new Response(JSON.stringify(response), {
          status: ok ? 200 : 500,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    })

  it("reads the quota out of the method response", async () => {
    const bytes = await client({
      methodResponses: [["Account/get", { list: [{ usedDiskQuota: 4_096 }] }, "s0"]],
    }).usedBytes("a@acme.com")

    expect(bytes).toBe(4_096)
  })

  /**
   * ⚠ A MISSING PROPERTY IS A FAILURE, NEVER A ZERO. A renamed property, a
   * different method name or an unknown account all read as "uses no space" if
   * allowed to fall through — which grants the whole allowance to everybody.
   * The wire shape here is the one part of this feature no repository can
   * confirm, so it has to fail loudly when it is wrong.
   */
  it("throws rather than reading a missing quota as zero", async () => {
    for (const body of [
      { methodResponses: [["Account/get", { list: [{}] }, "s0"]] },
      { methodResponses: [["Account/get", { list: [] }, "s0"]] },
      {},
    ]) {
      await expect(client(body).usedBytes("a@acme.com")).rejects.toThrow()
    }
  })

  it("throws on a non-2xx", async () => {
    await expect(
      client({ methodResponses: [] }, false).usedBytes("a@acme.com"),
    ).rejects.toThrow(/500/)
  })
})
