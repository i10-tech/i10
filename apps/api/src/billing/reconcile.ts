import { attribute } from "./attribution.js"
import {
  supersedes,
  toState,
  type DecideOptions,
  type PolarSubscription,
  type SubscriptionState,
} from "./events.js"
import type { SubscriptionOps } from "./db.js"
import type { Logger, SubscriptionGrants } from "./grants.js"
import type { PolarClient } from "./polar.js"

/**
 * Bringing our entitlements back into agreement with Polar.
 *
 * ⚠ THIS IS NOT OPTIONAL, AND IT IS NOT A SAFETY NET FOR SLOPPINESS. Attaching
 * plans with `no_billing_changes: true` makes Polar the state of record and
 * our own tables a downstream copy — and the only thing that carries state from the one
 * to the other is a webhook. A webhook lost during a deploy, dropped by a
 * rollout, or 500'd past its retry budget is a customer silently on the wrong
 * plan, in either direction: paying for Pro with free-tier limits, or holding
 * Pro they stopped paying for. Nothing downstream will ever notice, because it
 * was told the truth as far as it knew.
 *
 * ⚠ IT READS POLAR, NOT OUR OWN TABLES. The question is "does our record match
 * the payment provider", and our record cannot answer it — it holds whatever we
 * last
 * told it, so comparing the two would only ever confirm our own mistake.
 *
 * ⚠ AND IT NEVER REVOKES ON ABSENCE. See `orphaned` below: a subscription
 * missing from Polar's list is a data problem, not a churned customer, and
 * treating absence as cancellation turns one bad access token into every
 * customer being downgraded at once.
 */

export interface ReconcileDeps {
  polar: PolarClient
  subscriptions: SubscriptionOps
  grants: SubscriptionGrants
  options: DecideOptions
  log: Logger
}

export interface ReconcileReport {
  /**
   * Tenants Polar returned at least one i10 subscription for.
   *
   * ⚠ TENANTS, NOT SUBSCRIPTIONS, BECAUSE POLAR NEVER DELETES ONE. A customer
   * who has bought twice has two subscriptions in the list forever, and we
   * hold one row per tenant — so `agreed + repaired + failed` counts decisions
   * made, and this is the number of them.
   */
  checked: number
  /** Entitlements this run repaired. Should be zero on a healthy deployment. */
  repaired: number
  /** Already in agreement. */
  agreed: number
  /**
   * Rows of ours that Polar has no subscription for.
   *
   * ⚠ REPORTED, NEVER ACTED ON. Polar does not delete subscriptions — a
   * cancelled one stays in the list with status `canceled` — so a row missing
   * from it means our data is wrong, or the access token points at a different
   * organisation or the other environment. Downgrading here would mean one
   * mis-scoped token silently strips every paying customer of the plan they
   * bought, and the automation would look like it was working.
   */
  orphaned: string[]
  /** Tenants this run could not repair. Each is a reason the job exits non-zero. */
  failed: { tenantId: string; error: string }[]
  /**
   * Polar subscriptions this run could not attribute to any tenant.
   *
   * ⚠ THIS USED TO BE A BARE `continue`, WHICH MADE THE BACKSTOP SILENT ABOUT
   * THE ONE THING IT CANNOT BACK UP. The reconciler exists because a webhook
   * can be lost — but it attributes subscriptions by `customer.external_id`
   * exactly as the webhook does, so a subscription without one is invisible to
   * both, and skipping it quietly meant a run could report perfect agreement
   * while a paying customer sat on the free plan. It is not `orphaned`: that is
   * a row of OURS with no Polar subscription, and this is the mirror image.
   */
  stranded: { subscriptionId: string; reason: string }[]
  /**
   * Polar subscriptions naming a tenant this database no longer holds.
   *
   * ⚠ THIS USED TO BE A FOREIGN KEY VIOLATION, EVERY THIRTY MINUTES, FOR EVER.
   * Polar keeps `customer.external_id` after the workspace it names is deleted,
   * so a live subscription can point at a tenant that no longer exists. The
   * loop below read "no row for this tenant" as "a webhook we never received" —
   * the one case it is built to repair — tried to repair it, and the insert died
   * on `subscriptions_tenant_id_tenants_id_fk`. It counted as `failed`, exited
   * non-zero, and took the Argo Application to Degraded with it. Three tenants
   * were doing this in production.
   *
   * ⚠ IT IS NEITHER `orphaned` NOR `stranded`, WHICH IS WHY IT NEEDED ITS OWN
   * NAME. `orphaned` is a row of ours with no Polar subscription. `stranded` is
   * a Polar subscription with NO `external_id` — money from somebody we cannot
   * identify. This is a Polar subscription whose `external_id` is perfectly
   * well-formed and names a workspace that is gone: we know exactly who it was
   * and there is no longer anybody to grant anything to.
   *
   * ⚠ AND THE COMMONEST CAUSE IS NOT A DELETED CUSTOMER — IT IS A RE-SIGNUP.
   * See `reassign` in db.ts, which documents the same mechanism from the other
   * end: Polar reuses a returning customer's record and keeps its stale
   * `external_id`, so a brand-new subscription is bound to the tenant id that
   * person had LAST time. The human, their Clerk organisation and their current
   * workspace are all perfectly alive; the only dead thing is the id Polar is
   * holding. Reading this list as "deleted workspaces, revoke them" would
   * cancel live customers' subscriptions.
   *
   * ⚠ WHICH MEANS IT CANNOT BE RESOLVED FROM HERE, and must not be guessed at.
   * Re-pointing the Polar customer at the live tenant is a claim about WHICH
   * workspace a payment belongs to, and the only place that is known for
   * certain is the checkout, which writes the tenant id into metadata itself —
   * that is why `reassign` is set there and nowhere else. A reconciler
   * inferring it from an email address would attach somebody's subscription to
   * the wrong workspace.
   *
   * ⚠ A TERMINATED TENANT IS NOT THIS. `tenants.status` is set to dead and the
   * ROW REMAINS, so a terminated workspace still satisfies the foreign key and
   * never reaches here. Landing in this list means the id was never in this
   * database at all.
   */
  unknownTenant: { tenantId: string; subscriptionId: string; planId: string }[]
  /**
   * Subscriptions Polar and our own table disagree about the owner of.
   *
   * ⚠ THIS WAS A UNIQUE VIOLATION, EVERY THIRTY MINUTES, ALONGSIDE THE FOREIGN
   * KEY ONE. `polar_subscription_id` is UNIQUE deliberately — two tenants
   * pointing at one subscription is one payment entitling two accounts — and the
   * reconciler attributed by `customer.external_id` without ever checking who
   * already held the id. When they disagreed the INSERT died on the constraint,
   * was caught as a generic failure, and was retried for ever.
   *
   * ⚠ AND THE FIELD IT TRUSTS IS THE UNRELIABLE ONE, WHICH IS WHY THIS MUST NOT
   * AUTO-RESOLVE. `reassign` in db.ts records the reason: Polar reuses a
   * returning customer and keeps its stale `external_id`, so external_id can
   * name the tenant that person had LAST time while our row names the one that
   * actually checked out. Believing Polar here would move a live subscription
   * off the workspace that paid for it; believing our row blindly would strand a
   * genuine re-attribution. The checkout's own metadata is the only thing that
   * settles it, and that is not in this job's hands.
   *
   * ⚠ SO IT IS REPORTED AND NEVER ACTED ON, the same rule `orphaned` follows for
   * the same reason: acting on an ambiguous signal at this scale is how one bad
   * assumption moves everybody's plan at once.
   */
  contested: {
    subscriptionId: string
    /** Who Polar's `customer.external_id` names. */
    claimedBy: string
    /** Who our row already binds the subscription to. */
    heldBy: string
  }[]
}

export async function reconcileSubscriptions(
  deps: ReconcileDeps,
): Promise<ReconcileReport> {
  const [polarSubs, ours] = await Promise.all([
    deps.polar.listSubscriptions(),
    deps.subscriptions.snapshot(),
  ])

  const report: ReconcileReport = {
    checked: 0,
    repaired: 0,
    agreed: 0,
    orphaned: [],
    failed: [],
    stranded: [],
    unknownTenant: [],
    contested: [],
  }

  const byTenant = new Map(ours.map((row) => [row.tenantId, row]))
  /*
   * ⚠ THE OTHER WAY ROUND, BECAUSE THE UNIQUE CONSTRAINT IS ON THE SUBSCRIPTION
   * ID RATHER THAN THE TENANT. `byTenant` answers "what do we think this tenant
   * holds"; this answers "who already holds this subscription", which is the
   * question the INSERT actually fails on and the one nothing was asking.
   */
  const holderOf = new Map(ours.map((row) => [row.polarSubscriptionId, row.tenantId]))
  const seen = new Set<string>()

  // ⚠ ONE SUBSCRIPTION PER TENANT DECIDES, AND CHOOSING WHICH IS NOT
  // BOOKKEEPING. Polar never deletes a subscription — a cancelled one stays in
  // the list with status `canceled` forever — so a customer who has bought
  // twice appears twice, while `core.subscriptions` holds exactly one row for
  // them. Feeding both to `grants.apply` in list order means the dead one gets
  // its turn at writing the live one's row, and the only thing standing
  // between a paying customer and a downgrade is `record`'s `event_at` guard
  // rejecting it. That guard holds today, and it holds for a reason it does
  // not control: that Polar happens not to touch `modified_at` on a
  // subscription it has already ended. One such touch, for any reason, and the
  // dead subscription wins.
  //
  // Observed as noise before it was ever a bug — every run logged an "ignored
  // an out-of-order subscription event" for the old subscription and counted
  // it as agreement.
  const decidedByTenant = new Map<string, SubscriptionState>()

  /*
   * ⚠ THE SAME ATTRIBUTION RULE THE WEBHOOK USES, FOR THE REASON `toState` IS
   * SHARED: a backstop that decided ownership by its own slightly different
   * rule would disagree with the hot path on exactly the customers it exists
   * to repair, and present as a plan flipping back and forth every half hour.
   * See billing/attribution.ts.
   *
   * ⚠ `ownerOf` IS THE SNAPSHOT WE ALREADY HAVE, not a query per subscription.
   * `holderOf` was built from `subscriptions_snapshot()` above, so the holder
   * leg costs nothing and only a subscription nothing holds reaches the
   * database again.
   */
  const source = {
    ownerOf: async (id: string) => holderOf.get(id) ?? null,
    checkoutTenant: (id: string) => deps.subscriptions.checkoutTenant(id),
  }

  for (const sub of polarSubs) {
    const polarSub = sub as PolarSubscription
    const attributed = await attribute(polarSub, source)

    const decided = toState(polarSub, deps.options, attributed?.tenantId)
    if (decided.kind === "ignore") {
      if (decided.stranded) {
        report.stranded.push({
          subscriptionId: polarSub.id,
          reason: decided.reason,
        })
      }
      continue
    }

    const state = decided.state
    seen.add(state.polarSubscriptionId)

    /*
     * ⚠ REPORTED, AND NO LONGER SKIPPED. Polar's `external_id` disagreeing with
     * where the subscription actually lives is the ordinary state of every
     * customer who has deleted an account and signed up again — the field is
     * stamped once and immutable, so it names their old workspace for ever.
     * This used to be `contested`, which failed the job and repaired nothing;
     * it is now a count of how many customers carry a stale id, which is worth
     * knowing and is not a fault.
     */
    const claimed = polarSub.customer?.external_id
    if (
      attributed &&
      attributed.via !== "external_id" &&
      claimed &&
      claimed !== state.tenantId
    ) {
      report.contested.push({
        subscriptionId: state.polarSubscriptionId,
        claimedBy: claimed,
        heldBy: state.tenantId,
      })
      deps.log.warn(
        {
          subscriptionId: state.polarSubscriptionId,
          claimedBy: claimed,
          heldBy: state.tenantId,
          via: attributed.via,
        },
        "Polar's customer names a different tenant than the one this " +
          "subscription belongs to — reconciling against ours, because " +
          "external_id goes stale on a re-signup and cannot be updated in Polar",
      )
    }

    const held = decidedByTenant.get(state.tenantId)
    if (!held || supersedes(state, held, deps.options.freePlanId)) {
      decidedByTenant.set(state.tenantId, state)
    }
  }

  /*
   * ⚠ ASKED ONCE FOR THE WHOLE BATCH, AND ASKED BEFORE ANY WRITE. The question
   * is "does this tenant still exist", and the only reason it has to be asked
   * at all is that a `byTenant` miss means two completely different things — a
   * lost webhook for a live tenant, which this job repairs, or a deleted
   * workspace, which it cannot. One definer call for every id beats one failed
   * INSERT per dead tenant per run.
   */
  const alive = await deps.subscriptions.knownTenants([...decidedByTenant.keys()])

  for (const state of decidedByTenant.values()) {
    report.checked += 1

    const row = byTenant.get(state.tenantId)

    /*
     * ⚠ BEFORE `outOfStep`, BECAUSE A DEAD TENANT IS ALWAYS "OUT OF STEP" AND
     * REPAIRING IT IS THE THING THAT CRASHES. There is no row, so the check
     * below would send it straight to `grants.apply` and the foreign key.
     */
    if (!alive.has(state.tenantId)) {
      /*
       * ⚠ ONLY WHILE IT STILL ENTITLES SOMETHING, AND WITHOUT THAT THE JOB IS
       * RED FOR EVER OVER A RESOLVED PROBLEM. What makes an unknown tenant
       * worth waking somebody for is that Polar is BILLING for a workspace that
       * does not exist. Revoke the subscription and that is no longer true —
       * but Polar never deletes a subscription, so the cancelled one stays in
       * the list permanently, and reporting it on every run means the only way
       * to ever get a green run is to have never had the problem.
       *
       * ⚠ AND A PERMANENTLY RED JOB IS WORSE THAN NO JOB. This one exits
       * non-zero to say "a human must act"; an alert that stays lit after the
       * human acted is how everybody learns to ignore it — which is the exact
       * failure `stranded` and `contested` are each written to avoid.
       *
       * Observed 2026-09-21: a dev-environment signup against the SHARED
       * sandbox Polar organisation left a `pro` subscription naming a tenant
       * production had never heard of. Revoking it in Polar changed
       * `entitledPlanId` to free and changed nothing about the alert.
       */
      if (state.entitledPlanId === deps.options.freePlanId) {
        deps.log.info(
          {
            tenantId: state.tenantId,
            subscriptionId: state.polarSubscriptionId,
          },
          "an ended subscription names a workspace this database does not " +
            "hold — nothing is being billed and there is nobody to grant to",
        )
        continue
      }

      report.unknownTenant.push({
        tenantId: state.tenantId,
        subscriptionId: state.polarSubscriptionId,
        planId: state.entitledPlanId,
      })
      deps.log.error(
        {
          tenantId: state.tenantId,
          subscriptionId: state.polarSubscriptionId,
          plan: state.entitledPlanId,
        },
        "Polar is BILLING for a workspace that no longer exists — revoke the " +
          "subscription; the deletion path should have done it",
      )
      continue
    }

    // ⚠ THREE WAYS TO BE OUT OF STEP, AND THE THIRD IS THE ONE THAT MATTERS.
    // No row at all is a webhook we never received. An older `event_at` is one
    // we received out of order or lost. A `granted_plan_id` that disagrees with
    // what the subscription entitles is the row having been written while the
    // grant failed — the state this whole design is built to survive, and
    // the one no other check would ever surface.
    const outOfStep =
      !row ||
      row.eventAt.getTime() < state.eventAt.getTime() ||
      row.grantedPlanId !== state.entitledPlanId

    if (!outOfStep) {
      report.agreed += 1
      continue
    }

    try {
      const outcome = await deps.grants.apply(state)
      if (outcome.status === "applied") {
        report.repaired += 1
        deps.log.warn(
          {
            tenantId: state.tenantId,
            plan: state.entitledPlanId,
            subscriptionId: state.polarSubscriptionId,
            had: row?.grantedPlanId ?? null,
          },
          "reconciler repaired an entitlement the webhook path did not apply",
        )
      } else {
        report.agreed += 1
      }
    } catch (error) {
      // ⚠ ONE TENANT'S FAILURE DOES NOT END THE RUN. The next tenant's plan is
      // unrelated, and aborting would mean a single unreachable customer record
      // holds up every other repair until somebody notices.
      const message = error instanceof Error ? error.message : String(error)
      report.failed.push({ tenantId: state.tenantId, error: message })
      deps.log.error(
        { err: error, tenantId: state.tenantId },
        "could not repair an entitlement",
      )
    }
  }

  for (const row of ours) {
    if (!seen.has(row.polarSubscriptionId)) report.orphaned.push(row.tenantId)
  }

  if (report.orphaned.length > 0) {
    deps.log.error(
      { tenants: report.orphaned, polarSubscriptions: polarSubs.length },
      "subscription rows with no matching Polar subscription — NOT downgraded",
    )
  }

  if (report.stranded.length > 0) {
    deps.log.error(
      { subscriptions: report.stranded },
      "Polar subscriptions that cannot be attributed to a tenant — nothing " +
        "will ever grant these; set each customer's external_id",
    )
  }

  return report
}
