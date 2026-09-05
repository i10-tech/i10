import type { ResetWindow } from "./interval.js"
import type { Assignment } from "./plan.js"
import type { MeterKey } from "./key.js"

/**
 * The ports.
 *
 * ⚠ EVERYTHING THAT TOUCHES A DISK, A SOCKET OR A CLOCK IS ON THIS SIDE OF THE
 * LINE, AND THAT IS WHAT MAKES THE PACKAGE PORTABLE. There are two adapters
 * coming and they have nothing in common: Postgres over Drizzle on the box, and
 * Durable Object storage at the edge. Neither can be imported here — one needs
 * `pg`, the other needs the Workers runtime — so the core names what it needs
 * and is handed an implementation.
 *
 * ⚠ AND THE INTERFACES ARE DELIBERATELY NARROW. `UsageStore` cannot read a
 * plan and `AssignmentStore` cannot write usage, which is the same argument as
 * `Entitlements` in apps/api/src/billing/grants.ts: a caller handed one of them
 * must not be able to reach the other by way of an object it happened to be
 * given.
 */

/**
 * One recorded unit of usage.
 *
 * ⚠ `id` IS `messageId`, AND IT IS THE PROPERTY THE WHOLE DESIGN RESTS ON. The
 * buffer entry at the edge, the row in Postgres and Polar's `external_id` all
 * key on the same value, which is what makes every leg of the pipeline
 * independently retryable — and being independently retryable is what makes
 * buffering usage at the edge safe at all. A count can only ever be added to;
 * an id can be checked.
 */
export interface UsageEvent {
  id: string
  /**
   * ⚠ THE `sent_at` THE DATABASE STORED, NOT THE WORKER'S CLOCK. The reconciler
   * buckets our side by `core.messages.sent_at` and the meter's side by this
   * value; if they differ by a millisecond across a boundary, one window shows
   * a deficit and the next a surplus, and the deficit is topped up on every run
   * forever. Same rule, and the same reason, as `SentMessage.sentAt` in
   * apps/api/src/send/metering.ts.
   */
  at: Date
  /** Units consumed. One email is 1. */
  value: number
}

export interface RecordResult {
  /** Events that were new. */
  recorded: number
  /** Events already present under the same id. Normal, and not a failure. */
  duplicates: number
}

export interface UsageStore {
  /**
   * Units recorded for this key inside this window.
   *
   * ⚠ FOR THIS KEY, WHICH MEANS FOR THIS SHARD — NOT FOR THE TENANT. When a
   * meter is split, each shard gates against its own slice of the allowance and
   * never reads its siblings, because a cross-shard read is exactly the
   * coordination the split was bought to avoid. Summing the shards is a
   * reporting query against the ledger, not something the gate does.
   */
  usedIn(key: MeterKey, window: ResetWindow): Promise<number>

  /**
   * Record usage. ⚠ MUST BE IDEMPOTENT ON `UsageEvent.id`.
   *
   * An adapter that appends blindly turns every retry into double billing, and
   * the retries are not optional: the send path takes a gap over a duplicate
   * precisely because it trusts this to be safe to call twice. In Postgres that
   * is a unique index and `ON CONFLICT DO NOTHING`.
   */
  record(key: MeterKey, events: readonly UsageEvent[]): Promise<RecordResult>
}

export interface AssignmentStore {
  /**
   * The plan this tenant holds, or `null` if they hold none.
   *
   * ⚠ `null` MEANS "NO ROW", NOT "COULD NOT ANSWER". An adapter that cannot
   * reach its storage must throw, so that the failure stays distinguishable
   * from an absence all the way up to `shouldSend`. Reporting an outage as
   * "this tenant has no plan" is how a metering incident turns into every
   * customer being told they are over quota.
   */
  find(tenantId: string): Promise<Assignment | null>
}
