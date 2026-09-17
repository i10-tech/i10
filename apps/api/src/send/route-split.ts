import { sql, type SQL } from "drizzle-orm"

/**
 * How much mail left by which route.
 *
 * ⚠ THE COLUMN HAS BEEN WRITTEN SINCE 0033 AND READ BY NOTHING. Every `sent` row
 * records the MTA that carried it — which is exactly the record the routing
 * decision promised to keep — and until this existed the only way to ask "how
 * much went direct" was to open psql and write the query by hand. A column
 * nobody can read is a column that quietly stops being correct, and the first
 * time anyone would have noticed is the first time the answer mattered.
 *
 * ⚠ THIS IS NOT METERING AND MUST NEVER BECOME IT. Both routes are metered
 * identically and billed at one price — `sent_usage_snapshot` counts `sent` rows
 * with no route predicate at all, and that is deliberate. This answers a
 * different question with the same rows: how much SES are we buying, and how
 * much of our own IP reputation are we spending. Two queries over one table, and
 * the billing one is the one that must not grow a `where`.
 *
 * ⚠ AND IT IS OURS, NOT THE CUSTOMER'S. Publishing the split on the customer API
 * would make the route visible in the product — a customer could see that their
 * mail moved from SES to our MTA when their plan changed, and would reasonably
 * ask to choose. The whole point of the per-domain lever is that the route is an
 * operational decision with no product surface. So this is read by the
 * reconciler's log and by whoever has psql, and it stops there.
 */

/** One tenant's sends in one bucket, by the route that carried them. */
export interface RouteSplitBucket {
  tenantId: string
  /** Start of the bucket, aligned to UTC midnight. */
  periodStart: Date
  /**
   * `ses`, `direct`, or `unknown`.
   *
   * ⚠ `unknown` IS A FAULT AND NOT A CATEGORY. `sent_route` is nullable, 0033
   * backfilled everything that existed, and `markSentStatement` has written it
   * on every row since — so a `sent` message with no route means a write path
   * skipped it. It is surfaced rather than folded into `ses` precisely so it
   * cannot add up to a plausible number and disappear.
   */
  route: string
  count: number
}

export function routeSplitStatement(from: Date, to: Date): SQL {
  // ⚠ THROUGH THE `SECURITY DEFINER` FUNCTION, because this question spans every
  // tenant and no tenant-scoped connection can answer it — the same reason
  // `sentUsageStatement` goes through one. See 0035.
  //
  // ⚠ AND THE DATES ARE SERIALISED BY HAND. postgres.js binds a parameter by
  // writing its bytes and a `Date` is not a string: passing `${from}` throws
  // `ERR_INVALID_ARG_TYPE` before the query is sent. That mistake kept usage
  // reconciliation from ever completing once already.
  return sql`
    select tenant_id::text as tenant_id, period_start, route, count
      from core.route_split_snapshot(
             ${from.toISOString()}::timestamptz,
             ${to.toISOString()}::timestamptz
           )
     order by 1, 2, 3
  `
}

export interface RouteSplitSummary {
  /** Messages carried by SES. */
  ses: number
  /** Messages carried by our own MTA. */
  direct: number
  /**
   * Messages whose route was never recorded.
   *
   * ⚠ NON-ZERO IS A BUG REPORT, NOT A ROUNDING ERROR. See `RouteSplitBucket`.
   */
  unknown: number
  /** Every `sent` row in the window, whichever route carried it. */
  total: number
  /** How many tenants sent anything at all. */
  tenants: number
  /** Tenants with at least one direct-routed message. */
  tenantsDirect: number
}

/**
 * ⚠ THE SUM IS COMPUTED HERE RATHER THAN IN SQL SO THE FUNCTION STAYS ONE
 * QUESTION. `route_split_snapshot` returns the finest grain anyone might want —
 * tenant, day, route — and every coarser answer is a fold over it. A second
 * function returning totals would be a second place for the `status = 'sent'`
 * predicate to drift out of agreement with the first.
 */
export function summariseRouteSplit(
  buckets: readonly RouteSplitBucket[],
): RouteSplitSummary {
  const tenants = new Set<string>()
  const tenantsDirect = new Set<string>()
  let ses = 0
  let direct = 0
  let unknown = 0

  for (const bucket of buckets) {
    tenants.add(bucket.tenantId)
    switch (bucket.route) {
      case "ses":
        ses += bucket.count
        break
      case "direct":
        direct += bucket.count
        if (bucket.count > 0) tenantsDirect.add(bucket.tenantId)
        break
      default:
        // ⚠ ANYTHING UNRECOGNISED COUNTS AS `unknown` RATHER THAN BEING DROPPED.
        // A value added to the enum and not added here would otherwise vanish
        // from the total, and the total is what somebody checks against the SES
        // invoice.
        unknown += bucket.count
    }
  }

  return {
    ses,
    direct,
    unknown,
    total: ses + direct + unknown,
    tenants: tenants.size,
    tenantsDirect: tenantsDirect.size,
  }
}
