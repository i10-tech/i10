import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import { describe, expect, it, mock } from "bun:test"
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
const log = { info: mock(), warn: mock(), error: mock() }

function fakeDb(rows: unknown[]) {
  const seen: { sql: string; params: unknown[] }[] = []
  const execute = mock(async (query: SQL) => {
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

/**
 * A mail server that knows exactly these mailboxes. Anything absent is a
 * mailbox it could not answer for — which is how the real adapter reports a
 * mailbox our directory has and Stalwart's does not.
 */
const snapshotOf = (usage: Record<string, number>) => ({
  snapshot: async () => new Map(Object.entries(usage)),
})

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
      mail: snapshotOf({ "a@acme.com": 1_000, "b@acme.com": 1_000 }),
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
      mail: snapshotOf({ "ok@acme.com": 1_000 }),
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
      mail: snapshotOf({ "ok@other.com": 7 }),
      log,
    })

    const written = writes(seen)
    expect(written).toHaveLength(1)
    expect(written[0]?.params).toContain(B)
  })

  it("scopes each write to its own tenant", async () => {
    const { db, seen } = fakeDb([{ tenant_id: A, email: "a@acme.com" }])
    await sampleStorage({ db, mail: snapshotOf({ "a@acme.com": 1 }), log })
    expect(seen.some((s) => s.sql.includes("set_config('app.tenant_id'"))).toBe(true)
  })
})

describe("asking Stalwart", () => {
  /**
   * ⚠ THESE BODIES ARE THE REAL ONES. Every field below was read off the
   * running server on 2026-09-06 — the `x:` prefix, the opaque id, the `@type`
   * union, `usedDiskQuota` in bytes. The version this file replaced asserted an
   * invented shape and passed, which is precisely how the adapter shipped
   * broken.
   */
  const server = (responses: unknown[], ok = true) => {
    const calls: unknown[] = []
    let n = 0
    const mail = stalwartStorage({
      baseUrl: "http://i10-stalwart:8080",
      token: "t",
      fetch: (async (_url: string, init: { body: string }) => {
        calls.push(JSON.parse(init.body))
        return new Response(JSON.stringify(responses[n++] ?? responses.at(-1)), {
          status: ok ? 200 : 500,
          headers: { "content-type": "application/json" },
        })
      }) as unknown as typeof fetch,
    })
    return { mail, calls }
  }

  const query = (ids: string[]) => ({
    methodResponses: [["x:Account/query", { ids, position: 0 }, "q"]],
  })
  const get = (list: unknown[]) => ({
    methodResponses: [["x:Account/get", { list, notFound: [] }, "g"]],
  })

  it("reads usage out of the registry", async () => {
    const { mail } = server([
      query(["b"]),
      get([
        {
          id: "b",
          "@type": "User",
          emailAddress: "mohamed@i10.tech",
          usedDiskQuota: 30_116,
        },
      ]),
    ])

    expect(await mail.snapshot()).toEqual(new Map([["mohamed@i10.tech", 30_116]]))
  })

  /**
   * ⚠ THE CAPABILITY AND THE PREFIX ARE THE TWO THINGS THAT WERE WRONG BEFORE.
   * `Account/get` answers `unknownMethod`, and naming a Stalwart URI in `using`
   * is what a conforming server MUST reject — the session advertises none.
   */
  it("sends only the core capability, and the x: namespace", async () => {
    const { mail, calls } = server([query([]), get([])])
    await mail.snapshot()

    const first = calls[0] as { using: string[]; methodCalls: [string][] }
    expect(first.using).toEqual(["urn:ietf:params:jmap:core"])
    expect(first.methodCalls[0]?.[0]).toBe("x:Account/query")
  })

  // ⚠ A GROUP HAS NO usedDiskQuota AT ALL — it is a different variant of the
  // union, not a User missing a field. Failing on it would abort a whole
  // tenant's sample over a mailing list.
  it("treats a group as zero rather than as a failure", async () => {
    const { mail } = server([
      query(["g"]),
      get([{ id: "g", "@type": "Group", emailAddress: "team@i10.tech" }]),
    ])

    expect(await mail.snapshot()).toEqual(new Map([["team@i10.tech", 0]]))
  })

  /**
   * ⚠ A MISSING PROPERTY ON A USER IS A FAILURE, NEVER A ZERO. A renamed
   * property reads as "uses no space" if allowed to fall through, which grants
   * the whole allowance to everybody in the direction nobody reports.
   */
  it("throws rather than reading a missing quota as zero", async () => {
    const { mail } = server([
      query(["b"]),
      get([{ id: "b", "@type": "User", emailAddress: "a@acme.com" }]),
    ])

    await expect(mail.snapshot()).rejects.toThrow(/usedDiskQuota/)
  })

  /**
   * ⚠ A JMAP ERROR IS A 200. The failure that shipped — `unknownMethod` for a
   * name we guessed — arrives with an HTTP 200 and `error` in the slot where
   * the method name goes, so checking `response.ok` alone reads it as an empty
   * success and every mailbox silently becomes zero.
   */
  it("throws on a method error inside a 200", async () => {
    const { mail } = server([
      {
        methodResponses: [
          ["error", { type: "unknownMethod", description: "x:Account/query" }, "q"],
        ],
      },
    ])

    await expect(mail.snapshot()).rejects.toThrow(/unknownMethod/)
  })

  it("throws on a non-2xx", async () => {
    const { mail } = server([query([])], false)
    await expect(mail.snapshot()).rejects.toThrow(/500/)
  })
})
