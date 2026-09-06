import type { Allowance } from "./balance.js"
import type { ResetInterval } from "./interval.js"

/**
 * Plans, and which allowance applies to a tenant right now.
 *
 * This is the third of the things worth taking from Autumn — entitlement
 * resolution — and like the other two it is taken as semantics rather than as
 * structure. Autumn resolves an entitlement through customer → product →
 * product_items → the Stripe subscription that paid for it. We have no Stripe,
 * one subscription per tenant, and Polar as the state of record, so the same
 * question collapses to: what does the plan this tenant holds grant for this
 * feature?
 */

/**
 * Where a plan came from, and who is allowed to overwrite it.
 *
 * ⚠ THE DISCRIMINATOR IS THE WHOLE MECHANISM, NOT A LABEL. It is what lets the
 * catalogue keep the position a config file used to hold — "the dashboard is
 * not the source of truth, the checked-in definition is" — while still letting
 * a sales deal produce a bespoke plan without a pull request.
 *
 * - `catalog` — seeded from the config file. A config push reconciles these
 *   DESTRUCTIVELY: the file wins, and anything edited by clicking is reverted
 *   on the next push. That is the behaviour we want rather than a hazard.
 * - `custom` — created for one tenant through the dashboard. A config push
 *   never touches them, which is the only reason a push can safely be
 *   destructive at all.
 */
export type PlanSource = "catalog" | "custom"

/**
 * Whether the plan allows this feature to be used past its allowance.
 *
 * ⚠ IT LIVES ON THE ENTITLEMENT, NOT ON THE TENANT, AND THAT IS LOAD-BEARING.
 * The obvious design is one "allow overage" switch per customer, and it is
 * wrong the moment `domains` sits beside `emails`: the same tenant must be able
 * to bill past fifty thousand emails and be refused a fourth domain. Nobody
 * sells a fourth domain for thirty cents.
 *
 * So the plan says whether a feature MAY be exceeded at all, and the tenant's
 * own switch — `Assignment.overageEnabled` — only turns it on where the plan
 * already permits it. Both must agree; see `createMeter`.
 */
export type OveragePolicy =
  /** Units past the allowance are billed. Requires the tenant to opt in too. */
  | "billable"
  /** A hard cap. Refused however the tenant has set their switch. */
  | "never"

interface EntitlementBase {
  featureId: string
  allowance: Allowance
  overage: OveragePolicy
}

/**
 * A feature that is used up and replenished — emails, credits, API requests.
 *
 * It has a reset cycle, its usage is the SUM of events inside the current
 * window, and that sum only ever grows until the window moves.
 */
export interface ConsumableEntitlement extends EntitlementBase {
  kind: "consumable"
  interval: ResetInterval
  /** e.g. `interval: "month", intervalCount: 3` is quarterly. Defaults to 1. */
  intervalCount?: number
}

/**
 * A feature that is held persistently — domains, mailboxes, storage.
 *
 * ⚠ IT HAS NO `interval`, AND THE UNION IS HOW THAT IS ENFORCED RATHER THAN
 * DOCUMENTED. Asking when a domain refills is a category error, and a shape
 * that can carry a reset interval is a shape somebody eventually sets one on —
 * after which `windowFor` computes a boundary, usage is scoped to it, and every
 * mailbox created before the boundary silently stops counting. Making the field
 * unrepresentable costs nothing and removes the failure entirely.
 *
 * ⚠ AND ITS USAGE IS A LEVEL, NOT A SUM. It is read from wherever the things
 * actually live — a count over `core.domains`, a count of mailboxes, bytes
 * reported by the mail server — because it can go DOWN. Domains are removed,
 * mailboxes are deleted, folders are emptied, and no sum of append-only events
 * can represent that.
 */
export interface ContinuousEntitlement extends EntitlementBase {
  kind: "continuous"
}

/** What one plan grants for one feature. */
export type Entitlement = ConsumableEntitlement | ContinuousEntitlement

export interface Plan {
  /** `free`, `pro`, or a generated id for a custom one. */
  id: string
  source: PlanSource
  entitlements: readonly Entitlement[]
}

/**
 * The plan a tenant holds, and the clock its windows are measured from.
 *
 * ⚠ THE ANCHOR BELONGS TO THE TENANT, NOT TO THE PLAN, AND THIS IS A DECISION
 * WITH TEETH. It is set once — when the tenant is first given any plan — and it
 * survives every plan change afterwards.
 *
 * Anchoring to the plan instead is the obvious alternative and it is wrong in
 * two ways at once. It hands every customer a free reset: exhaust the daily
 * allowance, change plan, and a brand-new window starts immediately, over and
 * over. And it makes two windows overlap at the moment of the change, so the
 * same usage falls inside both the old plan's window and the new one's — which
 * means the ledger's buckets no longer partition time, and a reconciler that
 * sums them either double-counts or drops the seam.
 *
 * A plan change therefore swaps the allowance, and may change the shape of the
 * window, without moving the boundary or zeroing anything. An upgrade is felt
 * immediately, because the larger allowance is compared against the usage
 * already recorded in the window the tenant is standing in.
 *
 * ⚠ AND POLAR AGREES WITH THIS ARITHMETIC EXACTLY, PROVIDED EACH PLAN CARRIES
 * ITS OWN METER CREDITS BENEFIT. Their grant service revokes the outdated
 * benefit for the whole of its original units and grants the new one in full,
 * so a customer who had used 45,000 of 50,000 goes 5,000 → −45,000 → 55,000 on
 * an upgrade to 100,000. That is this rule, computed on their side. See
 * docs/decisions/metering.md.
 */
export interface Assignment {
  tenantId: string
  plan: Plan
  /**
   * When this tenant's meters started. The subscription start, or the moment
   * the first plan was assigned.
   *
   * ⚠ IT MUST NOT DRIFT ONCE CHOSEN. Every boundary for this tenant is derived
   * from it, so rewriting it silently re-buckets all of their history.
   */
  anchor: Date
  /**
   * The customer's own switch: "keep sending past my plan and bill me".
   *
   * ⚠ OFF BY DEFAULT, AND IT IS THE CUSTOMER'S TO SET. It is the entire
   * difference between "your sends stopped" and "you owe us twenty-seven
   * dollars you did not expect", and only one of those is a decision we are
   * entitled to make for somebody.
   *
   * It grants nothing on its own — an entitlement with `overage: "never"` is a
   * hard cap whatever this says.
   */
  overageEnabled: boolean
}

/**
 * What this plan grants for one feature, or `undefined` if it grants nothing.
 *
 * ⚠ `undefined` IS NOT "ZERO", AND THE CALLERS MUST NOT COLLAPSE THE TWO. A
 * plan that grants no `emails` entitlement is a misconfiguration — a renamed
 * feature id, a half-written custom plan — and reporting it as an exhausted
 * allowance tells a paying customer they are over quota when they have not sent
 * anything. Autumn's own config file carries this exact warning about renaming
 * `emails.id`: `check` answers "not allowed" for a feature the customer does
 * not have, and every customer gets a 429. See `createMeter`, which keeps it as
 * a separate outcome all the way up.
 */
export function entitlementFor(plan: Plan, featureId: string): Entitlement | undefined {
  const matches = plan.entitlements.filter((e) => e.featureId === featureId)

  // ⚠ TWO ENTITLEMENTS FOR ONE FEATURE IS AMBIGUOUS, SO IT THROWS RATHER THAN
  // PICKING. Taking the first would make the answer depend on the order rows
  // came back from Postgres, which is unspecified without an ORDER BY — the
  // same plan would grant 100 on one request and 50,000 on the next. A custom
  // plan assembled through the dashboard is exactly where this arises.
  if (matches.length > 1) {
    throw new RangeError(
      `plan ${plan.id} has ${matches.length} entitlements for ${featureId}`,
    )
  }

  return matches[0]
}
