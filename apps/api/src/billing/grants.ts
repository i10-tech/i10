import type { SubscriptionState } from "./events.js"
import type { SubscriptionOps } from "./db.js"

/**
 * THE ONLY PLACE IN THIS REPOSITORY THAT PUTS A TENANT ON A PAID PLAN.
 *
 * ⚠ AND THAT IS A STRUCTURAL PROPERTY, NOT A CONVENTION. Plans are attached
 * with `no_billing_changes: true`, which means it takes no money and cannot
 * know whether any was taken — it does what it is told. So the question "has
 * this customer actually paid" is answered here and nowhere else, and the
 * answer comes from exactly one source: a signature-verified Polar event, or
 * the reconciler re-reading Polar's own list.
 *
 * ⚠ WHAT MUST NEVER CALL THIS: the checkout endpoint. It creates a session and
 * knows only what the browser asked for.
 *
 * ⚠ AND THE POST-CHECKOUT STATUS ROUTE CALLS IT, WHICH IS NOT THE EXCEPTION IT
 * LOOKS LIKE. Polar's success redirect is a browser navigation — anybody can
 * type that URL — so ARRIVING there still proves nothing and grants nothing.
 * What that route may do is ask Polar, over our own access token, what
 * subscriptions the checkout's customer holds, and hand the resulting
 * `SubscriptionState` here. That is the same evidence from the same source as a
 * verified webhook; the request merely chose the moment. The rule is not "only
 * the webhook may call this", it is "only Polar may decide", and the type is
 * what enforces it: `apply` takes a state that can only come out of `toState`.
 *
 * ⚠ THE ONE OTHER WRITER OF `plan_assignments` IS `core.terminate_tenant`, and
 * it moves a deleted workspace to the FREE plan in the same statement that
 * marks it dead. Moving somebody down is not granting, and doing it in SQL is
 * what stops the tenant's status and its allowance from ever disagreeing.
 *
 * The narrow `Entitlements` interface below is the mechanism: this module takes
 * the two operations it needs rather than a whole client, so a future caller
 * cannot reach `grantPlan` by way of something that happened to be passed a
 * metering object.
 */

/**
 * The two operations granting needs. `postgresEntitlements` satisfies it
 * structurally, as `AutumnClient` did before it — which is the point of stating
 * the slice rather than naming an implementation.
 */
export interface Entitlements {
  ensureCustomer(input: { tenantId: string }): Promise<void>
  grantPlan(input: {
    tenantId: string
    planId: string
    subscriptionId?: string
  }): Promise<void>
}

export interface Logger {
  info: (o: object, m: string) => void
  warn: (o: object, m: string) => void
  error: (o: object, m: string) => void
}

export interface GrantsDeps {
  subscriptions: SubscriptionOps
  entitlements: Entitlements
  log: Logger
}

export type ApplyOutcome =
  /** The row moved and the entitlement agrees with it. */
  | { status: "applied"; planId: string }
  /** A newer event has already been applied. Normal; not a failure. */
  | { status: "stale" }

export interface SubscriptionGrants {
  /**
   * `reassign` is passed ONLY by the post-checkout path. See
   * `SubscriptionOps.record`: it takes the subscription id back from a tenant
   * that a stale `customer.external_id` bound it to, which is the only thing
   * standing between a re-signed-up customer and the plan they just paid for.
   */
  apply(
    state: SubscriptionState,
    options?: { reassign?: boolean },
  ): Promise<ApplyOutcome>
}

export function subscriptionGrants(deps: GrantsDeps): SubscriptionGrants {
  return {
    async apply(state, options) {
      // ⚠ THE ROW FIRST, ALWAYS. Polar is the state of record and this is our
      // durable copy of it; if the grant below throws, the truth is
      // already written and both the delivery retry and the reconciler can
      // repair the entitlement. The other order loses the fact that a payment
      // happened at all.
      const recorded = await deps.subscriptions.record(state, options)
      if (recorded === "stale") {
        deps.log.info(
          { tenantId: state.tenantId, subscriptionId: state.polarSubscriptionId },
          "ignored an out-of-order subscription event",
        )
        return { status: "stale" }
      }

      // ⚠ BEFORE THE ATTACH, BECAUSE ATTACHING TO A CUSTOMER THE METER HAS NEVER
      // HEARD OF IS A 404. A tenant that signed up before metering was
      // configured has no customer record at all, and its first paid plan would
      // fail on that rather than on anything about the plan.
      await deps.entitlements.ensureCustomer({ tenantId: state.tenantId })

      await deps.entitlements.grantPlan({
        tenantId: state.tenantId,
        planId: state.entitledPlanId,
        // ⚠ ONLY WHEN THE PLAN IS THE ONE THAT SUBSCRIPTION BOUGHT, AND THE
        // DOWNGRADE IS WHY. `subscription_id` says "this attachment IS
        // that Polar subscription", so sending it alongside `free` claims the
        // free plan is a subscription that has just ended — which is both untrue
        // and rejected: a replay answers 409 `duplicate_subscription_id`, because
        // the id is already bound to the paid attachment.
        //
        // Observed on the first real cancellation: every downgrade failed and
        // the customer stayed entitled after revoking. A revocation that leaves
        // Pro switched on is the worst direction for this to fail in.
        ...(state.entitledPlanId === state.planId
          ? { subscriptionId: state.polarSubscriptionId }
          : {}),
      })

      await deps.subscriptions.markGranted(
        state.tenantId,
        state.entitledPlanId,
        state.eventAt,
      )

      deps.log.info(
        {
          tenantId: state.tenantId,
          plan: state.entitledPlanId,
          status: state.status,
          subscriptionId: state.polarSubscriptionId,
        },
        "applied a subscription entitlement",
      )

      return { status: "applied", planId: state.entitledPlanId }
    },
  }
}
