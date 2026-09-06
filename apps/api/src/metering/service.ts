import { createMeter } from "@repo/metering"
import type { Meter } from "@repo/metering"
import { withTenant, type Database } from "../db/client.js"
import {
  assignedTenantIdsStatement,
  hasAssignmentStatement,
  meterEventStore,
  planAssignmentStore,
  usageSnapshotStatement,
} from "./postgres.js"
import { postgresLevels } from "./levels.js"
import type { Metering, QuotaOutcome, SentMessage } from "../send/metering.js"
import type { UsageBucket } from "../send/reconcile.js"

/**
 * The metering seam, implemented against our own database.
 *
 * ⚠ THIS IS THE SWAP. `apps/api/src/send/metering.ts` has always taken metering
 * as a dependency with `AutumnClient` as the implementation; this is the second
 * one, and nothing on the send path changes to accept it. That the interface
 * was there first is the reason the swap is a wiring change rather than a
 * rewrite of `POST /emails`.
 *
 * ⚠ AND THE ANSWER NO LONGER CROSSES A NETWORK. Autumn's `check` was an HTTP
 * call inside the accept path with a two-second budget, and its outage was our
 * outage — softened only by failing open. This is a single indexed read on a
 * connection the request already holds. `resilient()` still wraps it, because
 * the database can be unreachable too and the policy has not changed.
 */

export interface Logger {
  warn: (o: object, m: string) => void
  error: (o: object, m: string) => void
}

export interface MeteringOptions {
  db: Database
  /** The metered feature every email is one unit of. `emails`. */
  featureId: string
  log?: Logger
  /** Injected in tests. The one impure edge in this file. */
  now?: () => Date
}

/**
 * The meter itself, for callers that ask about a feature other than sending.
 *
 * ⚠ ONE INSTANCE PER PROCESS, NOT ONE PER QUESTION. `Metering` below is the
 * send path's narrow view of it — quota and usage for one feature id — and the
 * domains API needs the general form to ask about `domains.sending`. Building a
 * second meter would give the two halves separate adapters and, eventually,
 * separate opinions about the same tenant's plan.
 */
export function postgresMeter(db: Database): Meter {
  return createMeter({
    assignments: planAssignmentStore(db),
    usage: meterEventStore(db),
    // ⚠ IT ONLY KNOWS THE FEATURES IT CAN ACTUALLY COUNT, and throws by name
    // for the rest. `storage.gb` is deliberately absent — see levels.ts and
    // docs/decisions/metering.md for why it is not readable yet.
    levels: postgresLevels(db),
  })
}

export function postgresMetering({
  db,
  featureId,
  log,
  now = () => new Date(),
}: MeteringOptions): Metering {
  const meter = postgresMeter(db)

  return {
    async checkQuota(tenantId, count): Promise<QuotaOutcome> {
      const outcome = await meter.check({
        tenantId,
        featureId,
        requested: count,
        at: now(),
      })

      if (outcome.status === "allowed") return { status: "allowed" }

      // ⚠ `overage` IS A SEND, NOT A REFUSAL, AND THE SPLIT IS NOT COMPUTED HERE.
      // The customer opted in to being billed past their plan, so the answer at
      // the gate is simply yes. Which units were included and which are billable
      // is decided when the send is RECORDED — at that point the message ids
      // exist, and it is those ids that reach Polar's meter. Deciding it here
      // would attribute units for mail that may never go.
      if (outcome.status === "overage") return { status: "allowed" }

      if (outcome.status === "exceeded") {
        return {
          status: "exceeded",
          message: "You have used your sending allowance for this period.",
          ...(outcome.resetsAt === null ? {} : { resetsAt: outcome.resetsAt }),
        }
      }

      // ⚠ `unentitled` BECOMES `unavailable`, NOT `exceeded`, AND THIS IS THE
      // SINGLE MOST IMPORTANT LINE IN THE FILE. A tenant with no plan, or a
      // plan that grants nothing for this feature, is OUR misconfiguration —
      // a signup that never assigned free, a feature id renamed under a running
      // catalogue. Reporting it as "you have used your allowance" tells a
      // customer who has sent nothing to go and upgrade, and the mistake is
      // invisible to us because they do exactly that.
      //
      // `unavailable` fails open, so their mail still goes, and this log line
      // is what the tenant/customer leg of the reconciler exists to confirm.
      log?.error(
        { tenantId, featureId, reason: outcome.reason },
        "tenant has no entitlement — sending unmetered",
      )
      return { status: "unavailable", message: "Could not check the sending quota." }
    },

    async recordSent(tenantId, sent: readonly SentMessage[]): Promise<void> {
      const result = await meter.record({
        tenantId,
        featureId,
        // ⚠ `sentAt` AS THE EVENT CLOCK, NOT `now()`. The reconciler buckets our
        // side by `core.messages.sent_at` and the meter's side by this value; a
        // millisecond of disagreement across midnight shows a deficit in one day
        // and a surplus in the next, and tops the deficit up on every run.
        events: sent.map((m) => ({ id: m.id, at: m.sentAt, value: 1 })),
      })

      // Not an error — the send path is at-least-once by design and the
      // reconciler replays ids on purpose. A rate that is not near zero means
      // something upstream is retrying much harder than it should be, and this
      // is the only place that would show it.
      if (result.duplicates > 0) {
        log?.warn(
          { tenantId, ...result },
          "usage batch contained events already recorded",
        )
      }
    },
  }
}

/**
 * Putting a tenant on a plan.
 *
 * ⚠ SHAPED TO SATISFY BOTH `Entitlements` INTERFACES WITHOUT KNOWING EITHER —
 * `billing/grants.ts` wants `ensureCustomer` and `grantPlan`, `tenants/provision.ts`
 * wants `ensureCustomer` alone. Both are structural, both are deliberately
 * narrow, and that narrowness is the mechanism rather than the style: a caller
 * handed this for provisioning cannot reach plan granting through something it
 * happened to be passed.
 *
 * ⚠ AND IT STILL TAKES NO MONEY, EXACTLY AS AUTUMN'S DID. Whether anybody paid
 * is decided in `billing/grants.ts` against a signature-verified Polar event,
 * and nowhere else. This writes a row.
 */
export interface EntitlementOptions {
  db: Database
  /** The plan a brand-new tenant lands on. `free`. */
  freePlanId: string
  now?: () => Date
}

export function postgresEntitlements({
  db,
  freePlanId,
  now = () => new Date(),
}: EntitlementOptions) {
  const assignments = planAssignmentStore(db)

  return {
    /**
     * ⚠ `ensure`, NOT `assign`, AND THE DIFFERENCE IS A PAYING CUSTOMER. This
     * runs at signup and again on every redelivered provisioning webhook; an
     * upsert would quietly move somebody who had already bought Pro back onto
     * free on the second delivery.
     */
    async ensureCustomer({ tenantId }: { tenantId: string; name?: string }) {
      await assignments.ensure({ tenantId, planId: freePlanId, anchor: now() })
    },

    /**
     * ⚠ THE `anchor` IS ONLY USED IF NO ROW EXISTS. For every tenant that has
     * ever been provisioned it is already set, and the upsert underneath
     * deliberately leaves it alone — a plan change swaps the allowance without
     * moving a single boundary.
     *
     * ⚠ `subscriptionId` IS ACCEPTED AND IGNORED, ON PURPOSE. It was Autumn's
     * idempotency and correlation key; ours is `tenant_id`, which is the
     * primary key of the row being written, so a redelivered event targets the
     * same row by construction. Keeping it in the signature is what lets
     * `subscriptionGrants` stay untouched — including the downgrade case that
     * had to omit it, which no longer has anything to omit.
     */
    async grantPlan({
      tenantId,
      planId,
    }: {
      tenantId: string
      planId: string
      subscriptionId?: string
    }) {
      await assignments.assign({ tenantId, planId, anchor: now() })
    },
  }
}

/**
 * What the reconciler reads, and the top-up it writes.
 *
 * ⚠ BOTH SIDES OF THE COMPARISON NOW LIVE IN ONE DATABASE, AND THEY ARE STILL
 * TWO INDEPENDENT NUMBERS. `core.messages` is what we sent; `core.meter_events`
 * is what we counted. Deriving the second from the first would make the
 * reconciler compare a number against itself and quietly turn the backstop into
 * a tautology — which is the whole reason the ledger is its own table.
 */
export function postgresLedger({ db, featureId }: { db: Database; featureId: string }) {
  const usage = meterEventStore(db)

  return {
    async aggregateByCustomer(start: Date, end: Date): Promise<UsageBucket[]> {
      const rows = (await db.execute(
        usageSnapshotStatement(featureId, start, end),
      )) as unknown as {
        tenant_id: string
        period_start: string | Date
        count: string | number
      }[]

      return rows.map((r) => ({
        tenantId: String(r.tenant_id),
        periodStart: new Date(r.period_start),
        count: Number(r.count),
      }))
    },

    /**
     * The top-up, one message at a time.
     *
     * ⚠ IDEMPOTENT ON THE MESSAGE ID, WHICH IS WHY THE DEFICIT IS CLOSED BY ID
     * AND NEVER BY COUNT. Submitting the same message again — two passes
     * racing, one retried after a timeout — inserts nothing the second time.
     * Submitting "seventeen more" is not safe in the same way: two runs add
     * thirty-four.
     */
    async track(event: { customerId: string; messageId: string; at: Date }) {
      const result = await usage.record(
        { tenantId: event.customerId, featureId, shard: 0 },
        [{ id: event.messageId, at: event.at, value: 1 }],
      )
      return result.recorded === 0 ? ("duplicate" as const) : ("recorded" as const)
    },

    async listCustomerIds(): Promise<string[]> {
      const rows = (await db.execute(assignedTenantIdsStatement())) as unknown as {
        tenant_id: string
      }[]
      return rows.map((r) => String(r.tenant_id))
    },

    /**
     * ⚠ THREE ANSWERS, NOT TWO, AND THE THIRD IS THE POINT. A snapshot and a
     * point lookup can disagree when a tenant is provisioned between them, and
     * reporting that race as "this tenant has no plan" would page somebody over
     * nothing. `unknown` means we could not answer, which must never be
     * reported as an absence.
     */
    async customerExists(tenantId: string): Promise<boolean | "unknown"> {
      return withTenant(db, tenantId, async (tx) => {
        const rows = (await tx.execute(
          hasAssignmentStatement(tenantId),
        )) as unknown as unknown[]
        return rows.length > 0
      })
    },
  }
}
