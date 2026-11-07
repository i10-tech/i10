import type { SubscriptionState } from "./events.js"
import type { SubscriptionOps } from "./db.js"

/**
 * THE ONLY PLACE IN THIS REPOSITORY THAT PUTS A TENANT ON A PAID PLAN.
 *
 * ⚠ AND THAT IS A STRUCTURAL PROPERTY, NOT A CONVENTION. Plans are attached
 * with `no_billing_changes: true`, which means it takes no money and cannot
 * know whether any was taken - it does what it is told. So the question "has
 * this customer actually paid" is answered here and nowhere else, and the
 * answer comes from exactly one source: a signature-verified Polar event, or
 * the reconciler re-reading Polar's own list.
 *
 * ⚠ WHAT MUST NEVER CALL THIS: the checkout endpoint. It creates a session and
 * knows only what the browser asked for.
 *
 * ⚠ AND THE POST-CHECKOUT STATUS ROUTE CALLS IT, WHICH IS NOT THE EXCEPTION IT
 * LOOKS LIKE. Polar's success redirect is a browser navigation - anybody can
 * type that URL - so ARRIVING there still proves nothing and grants nothing.
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
 * structurally, as `AutumnClient` did before it - which is the point of stating
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

/**
 * What a lapsed or restored subscription does to the workspace's mail logins.
 *
 * ⚠ BOTH ARE IDEMPOTENT AND NEITHER TOUCHES DELIVERY: a held mailbox keeps
 * receiving, and paying again lifts the hold and nothing else (a person who was
 * removed or suspended stays so). See `mailAccess` in mailboxes/store.ts.
 */
export interface MailPaymentHold {
  hold(tenantId: string): Promise<void>
  release(tenantId: string): Promise<void>
}

export interface GrantsDeps {
  subscriptions: SubscriptionOps
  entitlements: Entitlements
  /**
   * Optional so a test without mailboxes needs none; index.ts always passes it.
   * ⚠ ITS ABSENCE LEAVES AN UNPAID WORKSPACE'S LOGINS OPEN.
   */
  mail?: MailPaymentHold
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
      /*
       * ⚠ THE TENANT THAT ALREADY HOLDS THE SUBSCRIPTION ID WINS OVER THE ONE
       * POLAR NAMES, AND WITHOUT THIS EVERY EVENT FOR A RETURNING CUSTOMER IS A
       * 500 FOR EVER. `customer.external_id` is stamped once, when Polar
       * CREATES a customer, and Polar deduplicates customers by EMAIL - so
       * somebody who deletes their workspace and signs up again keeps a
       * customer naming the tenant they had LAST time. The post-checkout path
       * corrects that for the purchase itself, with `reassign`; nothing
       * corrected it for the cancellation that arrives weeks later.
       *
       * What happened instead: `record` tried to insert the subscription
       * against the dead tenant, `polar_subscription_id` is UNIQUE and the live
       * tenant already held it, and the insert died on the constraint. The
       * route turned that into a 500, Polar retried until it gave up, and the
       * customer stayed on Pro after revoking. Observed in production
       * 2026-09-21.
       *
       * ⚠ AND IT IS NOT A GUESS ABOUT WHO PAID - IT IS A REFUSAL TO MOVE
       * ANYTHING. The row stays exactly where the checkout put it; all this
       * decides is whose entitlement this event updates, and the only tenant
       * that can hold the id is the one that bought under it. The stronger
       * claim - taking the id OFF a tenant - still requires `reassign`, still
       * comes only from a succeeded checkout, and is untouched below.
       *
       * ⚠ SO IT IS DELIBERATELY SKIPPED WHEN `reassign` IS SET. That path is
       * asserting the opposite direction on better evidence, and asking this
       * question first would answer it with the very binding it is there to
       * correct.
       */
      if (!options?.reassign) {
        const owner = await deps.subscriptions.ownerOf(state.polarSubscriptionId)
        if (owner && owner !== state.tenantId) {
          deps.log.warn(
            {
              subscriptionId: state.polarSubscriptionId,
              polarSaysTenant: state.tenantId,
              heldBy: owner,
            },
            "Polar's customer names a different tenant than the one holding " +
              "this subscription - applying to the holder, because external_id " +
              "is stamped once and never maintained",
          )
          state = { ...state, tenantId: owner }
        }
      }

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
        // free plan is a subscription that has just ended - which is both untrue
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

      /*
       * ⚠ THE MAIL LOGINS FOLLOW THE ENTITLEMENT, AND THEY MOVE BEFORE
       * `markGranted`. `entitledPlanId` is the plan only while the subscription
       * entitles anything - `past_due` still does, so a failed card is not a lockout
       * (billing/events.ts) - and once Polar has revoked it, or a cancellation has
       * run out, it is the free plan and the logins are held; a subscription that
       * entitles again lifts them. A hold that failed must leave the grant looking
       * undone, because the retry and the reconciler find it by `granted_plan_id`:
       * marking it first would leave the logins open with nothing to repair them.
       */
      if (deps.mail) {
        if (state.entitledPlanId === state.planId)
          await deps.mail.release(state.tenantId)
        else await deps.mail.hold(state.tenantId)
      } else if (state.entitledPlanId !== state.planId) {
        // ⚠ `error`, NOT `warn`, ON THE SAME RULE AS A MISSING POLAR CLIENT: this is
        // not an absent feature, it is an unpaid workspace whose people still sign in.
        deps.log.error(
          { tenantId: state.tenantId, subscriptionId: state.polarSubscriptionId },
          "a subscription lapsed but mailbox sign-in cannot be held - the " +
            "workspace's people can STILL SIGN IN to their mailboxes",
        )
      }

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
