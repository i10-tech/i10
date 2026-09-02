import type { SendEmail } from "@repo/contracts"
import { PgDialect } from "drizzle-orm/pg-core"
import { describe, expect, it, vi } from "vitest"
import type { Database } from "../src/db/client.js"
import {
  apiKeys,
  idempotencyKeys,
  messageBodies,
  messages,
  suppressions,
} from "../src/db/core.js"
import type { SendJob } from "../src/queue/send-queue.js"
import { acceptDatabaseOps } from "../src/send/accept-db.js"
import type { AcceptOps, PreparedMessage } from "../src/send/accept.js"

/**
 * The adapter, against a fake transaction.
 *
 * What is worth asserting here is not that drizzle emits SQL — it is the
 * handful of properties that decide whether a customer gets one email or two:
 * the order of the writes, the alignment of ids to submissions, and what a
 * reused idempotency key is allowed to answer.
 */

const dialect = new PgDialect()
const AT = new Date("2026-09-02T10:00:00.000Z")
const MINTED = ["id-a", "id-b", "id-c"]

interface Canned {
  /** Rows the `on conflict do nothing … returning` gives back. `[]` = it lost. */
  keyInsert?: { key: string }[]
  /** The existing idempotency row, read after losing the insert. */
  priorKey?: { requestHash: string; messageIds: string[] | null }[]
  suppressed?: { address: string }[]
}

type Op = {
  kind: "execute" | "insert" | "select" | "update"
  table?: unknown
  sql?: string
  params?: unknown[]
  values?: Record<string, unknown>[]
  set?: Record<string, unknown>
}

/**
 * A transaction that records what it is asked to do and answers with `canned`.
 *
 * The builders are thenable so that `await tx.insert(t).values(v)` and
 * `await tx.insert(t).values(v).onConflictDoNothing().returning(…)` both work,
 * which is how drizzle's own builders behave.
 */
function fakeDb(canned: Canned = {}) {
  const recorded: Op[] = []

  /** `answer` is lazy: `select` only knows its table once `.from()` is called. */
  function chain(op: Op, answer: () => unknown): Record<string, unknown> {
    const self: Record<string, unknown> = {
      values: (v: Record<string, unknown>[]) => {
        op.values = v
        return self
      },
      set: (s: Record<string, unknown>) => {
        op.set = s
        return self
      },
      from: (table: unknown) => {
        op.table = table
        return self
      },
      where: () => self,
      onConflictDoNothing: () => self,
      returning: () => Promise.resolve(answer()),
      limit: () => Promise.resolve(answer()),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(answer()).then(resolve),
    }
    return self
  }

  const tx = {
    execute: (query: unknown) => {
      const built = dialect.sqlToQuery(query as never)
      recorded.push({ kind: "execute", sql: built.sql, params: built.params })
      if (!built.sql.includes("uuidv7")) return Promise.resolve([])
      const count = Number(built.params[0])
      return Promise.resolve(
        MINTED.slice(0, count).map((id) => ({ id, minted_at: AT.toISOString() })),
      )
    },

    insert: (table: unknown) => {
      const op: Op = { kind: "insert", table }
      recorded.push(op)
      return chain(op, () =>
        table === idempotencyKeys ? (canned.keyInsert ?? [{ key: "k" }]) : [],
      )
    },

    select: () => {
      const op: Op = { kind: "select" }
      recorded.push(op)
      return chain(op, () => {
        if (op.table === idempotencyKeys) return canned.priorKey ?? []
        if (op.table === suppressions) return canned.suppressed ?? []
        if (op.table === apiKeys) return [{ id: "key-uuid" }]
        return []
      }) as never
    },

    update: (table: unknown) => {
      const op: Op = { kind: "update", table }
      recorded.push(op)
      return chain(op, () => [])
    },
  }

  const db = {
    transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as Database

  return { db, recorded }
}

function ops(canned: Canned = {}) {
  const { db, recorded } = fakeDb(canned)
  const add = vi.fn(async () => ({ id: "job-1" }))
  const queue = { add } as never
  const adapter: AcceptOps = acceptDatabaseOps({
    db,
    queues: { transactional: queue, bulk: queue },
  })
  return { ...adapter, recorded, add }
}

const prepared = (over: Partial<SendEmail> = {}): PreparedMessage => ({
  payload: {
    from: "hello@i10.tech",
    to: "user@example.com",
    subject: "Hi",
    text: "body",
    ...over,
  } as SendEmail,
  to: ["user@example.com"],
  cc: [],
  bcc: [],
  scheduledAt: null,
})

type PersistInput = Parameters<AcceptOps["persist"]>[0]

const input = (over: Partial<PersistInput> = {}): PersistInput => ({
  tenantId: "ten-1",
  apiKeyId: "ak_clerk",
  queue: "transactional",
  messages: [prepared()],
  requestHash: "hash-1",
  ...over,
})

const insertsOf = (recorded: Op[]) => recorded.filter((op) => op.kind === "insert")
const wrote = (recorded: Op[], table: unknown) =>
  recorded.find((op) => op.kind === "insert" && op.table === table)?.values ?? []

describe("persist", () => {
  // ⚠ THE TENANT BOUNDARY IS A TRANSACTION SETTING, NOT A WHERE CLAUSE. Without
  // it every policy in `core` raises rather than returning nothing — so its
  // absence is loud, but its presence is what makes every statement below legal.
  it("sets the tenant on the transaction first", async () => {
    const o = ops()
    await o.persist(input())
    expect(o.recorded[0]?.kind).toBe("execute")
    expect(o.recorded[0]?.sql).toContain("set_config")
    expect(o.recorded[0]?.params).toEqual(["ten-1"])
  })

  it("returns one id per submitted message, in order", async () => {
    const o = ops()
    const result = await o.persist(
      input({ messages: [prepared(), prepared({ subject: "Second" })] }),
    )

    expect(result).toMatchObject({ status: "written", ids: ["id-a", "id-b"] })
    expect(result.status === "written" && result.refs).toEqual([
      { id: "id-a", createdAt: AT },
      { id: "id-b", createdAt: AT },
    ])
  })

  // ⚠ THE ONE THAT SENDS THE WRONG EMAIL TO THE WRONG PERSON IF IT REGRESSES.
  // `ids[i]` must describe `messages[i]` in both tables — the body written under
  // an id has to belong to the message written under that same id. Nothing
  // downstream can detect a shuffle here: it just sends.
  it("keeps bodies aligned with their messages", async () => {
    const o = ops()
    await o.persist(
      input({
        messages: [
          prepared({ subject: "First", text: "one" }),
          prepared({ subject: "Second", text: "two" }),
        ],
      }),
    )

    expect(wrote(o.recorded, messages).map((v) => [v.id, v.subject])).toEqual([
      ["id-a", "First"],
      ["id-b", "Second"],
    ])
    expect(wrote(o.recorded, messageBodies).map((v) => [v.messageId, v.text])).toEqual([
      ["id-a", "one"],
      ["id-b", "two"],
    ])
  })

  it("writes the partition key it minted, not one derived from the id", async () => {
    const o = ops()
    await o.persist(input())
    expect(wrote(o.recorded, messages)[0]?.createdAt).toEqual(AT)
    expect(wrote(o.recorded, messageBodies)[0]?.createdAt).toEqual(AT)
  })

  it("records the tenant's own key id rather than Clerk's", async () => {
    const o = ops()
    await o.persist(input())
    expect(wrote(o.recorded, messages)[0]?.apiKeyId).toBe("key-uuid")
  })

  // ⚠ THE KEY BEFORE THE MESSAGES, BECAUSE THE PRIMARY KEY IS THE LOCK. Two
  // simultaneous retries of one key must not both mint a set of messages, and
  // what stops them is the second insert blocking on the first's uncommitted
  // row. Written after the messages, both would already have minted them.
  it("inserts the idempotency row before any message", async () => {
    const o = ops()
    await o.persist(input({ idempotencyKey: "k-1" }))

    expect(insertsOf(o.recorded).map((op) => op.table)).toEqual([
      idempotencyKeys,
      messages,
      messageBodies,
    ])
  })

  it("records the ids against the key once they exist", async () => {
    const o = ops()
    await o.persist(input({ idempotencyKey: "k-1" }))

    const update = o.recorded.find((op) => op.kind === "update")
    expect(update?.table).toBe(idempotencyKeys)
    expect(update?.set).toEqual({ messageIds: ["id-a"] })
  })

  it("does not touch the key table when no key was given", async () => {
    const o = ops()
    await o.persist(input())
    expect(o.recorded.some((op) => op.table === idempotencyKeys)).toBe(false)
  })

  describe("when the key already exists", () => {
    /** The insert returned nothing: another transaction owns this key. */
    const lost = { keyInsert: [] }

    it("replays the original ids for the same body", async () => {
      const o = ops({
        ...lost,
        priorKey: [{ requestHash: "hash-1", messageIds: ["first", "second"] }],
      })

      const result = await o.persist(input({ idempotencyKey: "k-1" }))

      expect(result).toEqual({ status: "replayed", ids: ["first", "second"] })
      // ⚠ AND MINTS NOTHING. A replay that also wrote messages would leave rows
      // nobody enqueues and nobody sends.
      expect(o.recorded.some((op) => op.table === messages)).toBe(false)
    })

    it("conflicts when the body differs", async () => {
      const o = ops({
        ...lost,
        priorKey: [{ requestHash: "another-hash", messageIds: ["first"] }],
      })
      expect(await o.persist(input({ idempotencyKey: "k-1" }))).toEqual({
        status: "conflict",
      })
      expect(o.recorded.some((op) => op.table === messages)).toBe(false)
    })

    // The 24-hour prune racing a very late retry. We cannot answer with ids we
    // no longer hold, and minting new ones would be a second send.
    it("conflicts when the row has been pruned out from under it", async () => {
      const o = ops({ ...lost, priorKey: [] })
      expect(await o.persist(input({ idempotencyKey: "k-1" }))).toEqual({
        status: "conflict",
      })
    })

    it("conflicts rather than replaying an empty answer", async () => {
      const o = ops({
        ...lost,
        priorKey: [{ requestHash: "hash-1", messageIds: null }],
      })
      expect(await o.persist(input({ idempotencyKey: "k-1" }))).toEqual({
        status: "conflict",
      })
    })
  })
})

describe("suppressedFor", () => {
  it("returns what the tenant's suppression list holds", async () => {
    const o = ops({ suppressed: [{ address: "bob@x.com" }] })
    const found = await o.suppressedFor("ten-1", ["Bob <Bob@X.com>"])
    expect(found).toEqual(new Set(["bob@x.com"]))
    expect(o.recorded[0]?.params).toEqual(["ten-1"])
  })

  it("does not open a transaction for an empty list", async () => {
    const o = ops()
    expect(await o.suppressedFor("ten-1", [])).toEqual(new Set())
    expect(o.recorded).toHaveLength(0)
  })
})

describe("enqueue", () => {
  it("pushes onto the queue for the class", async () => {
    const o = ops()
    const job: SendJob = {
      tenantId: "ten-1",
      messages: [{ id: "id-a", createdAt: AT }],
    }
    await o.enqueue("bulk", job)
    expect(o.add).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: "ten-1", jobId: "batch:id-a" }),
    )
  })
})
