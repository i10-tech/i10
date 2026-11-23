import { gte, lte, type SQL } from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import { timestampFromUuidV7 } from "../ids.js"

/**
 * Time bounds for reads of the monthly-partitioned message tables (#507).
 *
 * `core.messages` and `core.message_bodies` are partitioned by `created_at`,
 * `core.message_events` by `occurred_at`. A read that names only an id has to
 * visit every partition: today seven with mail, twelve empty ones ahead (the
 * retention job keeps a year), and the default. Each visit is an index probe
 * or an empty scan, and each partition is also planned. A range on the
 * partition key the planner can see lets it keep one or two.
 *
 * ⚠ WHY A MESSAGE ID CAN BE DATED. Every row in `core.messages` is written by
 * `send/accept-db.ts`, which mints the id with the database's `uuidv7()` in the
 * same transaction whose `now()` becomes `created_at`. So the id's embedded
 * millisecond is never before `created_at` and only as far after it as that
 * transaction had run when it minted. An event or a body cannot predate its
 * message, and nothing in these tables is dated in the future.
 *
 * ⚠ AN ID THAT CANNOT BE DATED GETS NO BOUND, never a guessed one. A v4, or a
 * string that is not a uuid at all, comes back unbounded: every partition is
 * read, the answer is still right, it is only slower. A v7 we did not mint (a
 * forged or random one) is bounded by its own timestamp; no message of ours
 * lies there, so the read finds nothing, which is the answer it would have got
 * anyway.
 */

/**
 * Slack on every bound. A day, against a partition a month wide: it costs at
 * most one extra partition at a month's edge, and it absorbs a transaction that
 * ran long before minting, or any skew between this process's clock and the
 * database's in `notAfter`.
 */
export const PARTITION_SLACK_MS = 24 * 60 * 60 * 1000

/** The `created_at` range a message with this id was written in, or null. */
export function mintedRange(id: string): { from: Date; to: Date } | null {
  const minted = timestampFromUuidV7(id)
  if (!minted) return null
  return {
    from: new Date(minted.getTime() - PARTITION_SLACK_MS),
    to: new Date(minted.getTime() + PARTITION_SLACK_MS),
  }
}

/** `created_at` predicates for the message with this id; none if undatable. */
export function createdAtForId(column: AnyPgColumn, id: string): SQL[] {
  const range = mintedRange(id)
  return range ? [gte(column, range.from), lte(column, range.to)] : []
}

/** Nothing in the message tables is dated after now. */
export function notAfter(column: AnyPgColumn, now: Date = new Date()): SQL {
  return lte(column, new Date(now.getTime() + PARTITION_SLACK_MS))
}

/**
 * `occurred_at` predicates for the events of messages created at `createdAt`
 * or later: an event cannot precede its message, nor be dated in the future.
 */
export function eventsOfMessagesSince(
  column: AnyPgColumn,
  createdAt: Date,
  now: Date = new Date(),
): SQL[] {
  return [
    gte(column, new Date(createdAt.getTime() - PARTITION_SLACK_MS)),
    notAfter(column, now),
  ]
}
