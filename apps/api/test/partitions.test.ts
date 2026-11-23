import { PgDialect } from "drizzle-orm/pg-core"
import { and } from "drizzle-orm"
import { describe, expect, it } from "bun:test"
import {
  PARTITION_SLACK_MS,
  createdAtForId,
  eventsOfMessagesSince,
  mintedRange,
} from "../src/db/partitions.js"
import { messageEvents, messages } from "../src/db/core.js"

const dialect = new PgDialect()
const render = (parts: ReturnType<typeof createdAtForId>) =>
  dialect.sqlToQuery(and(...parts)!)

// 2026-09-02T10:00:00.000Z, as a v7.
const V7 = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const V4 = "6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e"
const MINTED = 0x0199a3f2b4c1

describe("dating a message id", () => {
  it("brackets the id's own millisecond by the slack on both sides", () => {
    const range = mintedRange(V7)!
    expect(range.from.getTime()).toBe(MINTED - PARTITION_SLACK_MS)
    expect(range.to.getTime()).toBe(MINTED + PARTITION_SLACK_MS)
  })

  // ⚠ NO GUESS FOR AN ID WE CANNOT DATE: unbounded is slow, a wrong window is
  // a 404 for a message that exists.
  it("gives no bound for an id that is not a v7", () => {
    for (const id of [V4, "not-a-uuid", ""]) {
      expect(mintedRange(id)).toBeNull()
      expect(createdAtForId(messages.createdAt, id)).toEqual([])
    }
  })

  it("bounds created_at on both sides for a v7", () => {
    const { sql, params } = render(createdAtForId(messages.createdAt, V7))
    expect(sql).toContain(`"created_at" >= $1`)
    expect(sql).toContain(`"created_at" <= $2`)
    expect(params).toEqual([
      new Date(MINTED - PARTITION_SLACK_MS).toISOString(),
      new Date(MINTED + PARTITION_SLACK_MS).toISOString(),
    ])
  })
})

describe("bounding the events of messages", () => {
  // An event cannot precede its message, nor be dated in the future.
  it("reads from the message's creation to now, with slack", () => {
    const createdAt = new Date("2026-09-02T10:00:00.000Z")
    const now = new Date("2026-11-23T12:00:00.000Z")
    const { sql, params } = render(
      eventsOfMessagesSince(messageEvents.occurredAt, createdAt, now),
    )
    expect(sql).toContain(`"occurred_at" >= $1`)
    expect(sql).toContain(`"occurred_at" <= $2`)
    expect(params).toEqual([
      new Date(createdAt.getTime() - PARTITION_SLACK_MS).toISOString(),
      new Date(now.getTime() + PARTITION_SLACK_MS).toISOString(),
    ])
  })
})
