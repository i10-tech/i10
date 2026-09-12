import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import { describe, expect, it, mock } from "bun:test"
import {
  MAILBOXES,
  MAILBOX_DOMAINS,
  STORAGE,
  SENDING_DOMAINS,
  mailboxDomainsStatement,
  mailboxesStatement,
  postgresLevels,
  sendingDomainsStatement,
} from "../src/metering/levels.js"
import type { Database } from "../src/db/client.js"

const dialect = new PgDialect()
const render = (q: SQL) => dialect.sqlToQuery(q)
const TENANT = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"

function fakeDb(rowsFor: (statement: string) => unknown[]) {
  const seen: string[] = []
  const execute = mock(async (query: SQL) => {
    const { sql: statement } = dialect.sqlToQuery(query)
    seen.push(statement)
    return rowsFor(statement)
  })
  const db = {
    execute,
    transaction: async (fn: (tx: { execute: typeof execute }) => Promise<unknown>) =>
      fn({ execute }),
  } as unknown as Database
  return { db, seen }
}

const key = (featureId: string, shard = 0) => ({ tenantId: TENANT, featureId, shard })

describe("the domain counts", () => {
  /**
   * ⚠ AN UNVERIFIED DOMAIN HOLDS ITS SLOT. It is a row somebody created and can
   * see in their dashboard; counting only verified ones lets a tenant park
   * fifty pending domains against a limit of three.
   */
  it("counts rows without regard to verification", () => {
    for (const statement of [
      render(sendingDomainsStatement(TENANT)).sql,
      render(mailboxDomainsStatement(TENANT)).sql,
    ]) {
      expect(statement).toContain("count(*)")
      expect(statement).not.toContain("verified_at")
      expect(statement).not.toContain("dns_checked_at")
    }
  })

  /**
   * ⚠ TWO COUNTS OVER TWO FLAGS, NOT A PARTITION OF ONE TOTAL. A domain that
   * both sends and hosts mailboxes is counted by both — otherwise the cheapest
   * way to hold a domain is to claim both roles for it.
   */
  it("reads each flag on its own", () => {
    const sending = render(sendingDomainsStatement(TENANT)).sql
    const mailbox = render(mailboxDomainsStatement(TENANT)).sql

    expect(sending).toContain("and sends")
    expect(sending).not.toContain("hosts_mailboxes")
    expect(mailbox).toContain("and hosts_mailboxes")
    expect(mailbox).not.toContain("and sends")
  })

  it("binds the tenant rather than inlining it", () => {
    const { sql: statement, params } = render(sendingDomainsStatement(TENANT))
    expect(statement).toContain("tenant_id = $1::uuid")
    expect(params).toEqual([TENANT])
  })
})

describe("reading a level", () => {
  it("returns the count as a number", async () => {
    const { db } = fakeDb(() => [{ level: "7" }])
    expect(await postgresLevels(db).levelOf(key(SENDING_DOMAINS))).toBe(7)
  })

  it("reads an empty tenant as zero", async () => {
    const { db } = fakeDb(() => [])
    expect(await postgresLevels(db).levelOf(key(MAILBOX_DOMAINS))).toBe(0)
  })

  // ⚠ `core.domains` is under row level security, so the tenant context is
  // required — the WHERE clause is defence in depth, not the boundary.
  it("carries the tenant into the transaction", async () => {
    const { db, seen } = fakeDb(() => [{ level: "1" }])
    await postgresLevels(db).levelOf(key(SENDING_DOMAINS))
    expect(seen[0]).toContain("set_config('app.tenant_id'")
  })

  /**
   * ⚠ THE ASSERTION THIS FILE EXISTS FOR. Zero held means the whole allowance
   * is free, so a plan granting a feature this store cannot count would hand
   * every tenant an unlimited number of them — silently, and in the customer's
   * favour, which is the direction nobody ever reports.
   */
  it("throws for a feature it cannot count, rather than answering zero", async () => {
    const { db } = fakeDb(() => [])
    for (const featureId of ["emails", "seats", "storage.gb"]) {
      await expect(postgresLevels(db).levelOf(key(featureId))).rejects.toThrow(
        /no level source/,
      )
    }
  })

  /**
   * ⚠ A LEVEL IS NEVER SHARDED. Splitting a consumable allowance across shards
   * is arithmetic; splitting "how many domains exist" is not a question with an
   * answer, and a caller passing a shard believes something untrue.
   */
  it("refuses a sharded key", async () => {
    const { db } = fakeDb(() => [{ level: "1" }])
    await expect(postgresLevels(db).levelOf(key(SENDING_DOMAINS, 1))).rejects.toThrow(
      RangeError,
    )
  })
})

describe("the seat count", () => {
  /**
   * ⚠ `active` IS THE SUBSCRIPTION GATE, NOT AN EXISTENCE TEST. A suspended
   * mailbox still exists, still holds its storage and still reserves its
   * address; counting only active ones would let a tenant hold any number of
   * seats by switching them off.
   */
  it("counts every mailbox, including inactive ones", () => {
    const { sql: statement } = render(mailboxesStatement(TENANT))
    expect(statement).toContain("from authd.accounts")
    expect(statement).not.toContain("active")
  })

  /**
   * ⚠ THE `authd` SCHEMA HAS NO ROW LEVEL SECURITY, so this predicate is the
   * whole of the isolation rather than defence in depth. Dropping it would
   * count every mailbox on the platform against one tenant's limit.
   */
  it("scopes to the tenant in the statement itself", () => {
    const { sql: statement, params } = render(mailboxesStatement(TENANT))
    expect(statement).toContain("tenant_id = $1::uuid")
    expect(params).toEqual([TENANT])
  })

  it("reads through the store", async () => {
    const { db } = fakeDb(() => [{ level: "12" }])
    expect(await postgresLevels(db).levelOf(key(MAILBOXES))).toBe(12)
  })
})

describe("the storage level", () => {
  /**
   * ⚠ THE LAST SAMPLE, NOT A LIVE READ. Storage lives in Stalwart; asking it on
   * the request path would put its availability inside ours for an accuracy a
   * plan limit does not need.
   */
  it("reads the sampled figure, not the mail server", async () => {
    const { db, seen } = fakeDb(() => [{ level: "10737418240" }])
    expect(await postgresLevels(db).levelOf(key(STORAGE))).toBe(10_737_418_240)
    expect(seen.some((s) => s.includes("core.tenant_storage"))).toBe(true)
  })

  /**
   * ⚠ THE ONE PLACE AN ABSENT ROW IS HONESTLY ZERO. No sample means no mailbox
   * has ever been measured for this tenant — they hold no storage. An unknown
   * FEATURE still throws; this is a known feature with no data yet.
   */
  it("reads a tenant with no sample as holding nothing", async () => {
    const { db } = fakeDb(() => [])
    expect(await postgresLevels(db).levelOf(key(STORAGE))).toBe(0)
  })
})
