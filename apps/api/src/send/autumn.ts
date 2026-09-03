import type { Metering, QuotaOutcome, SentMessage } from "./metering.js"
import type { UsageBucket } from "./reconcile.js"

/**
 * Autumn over HTTP.
 *
 * ⚠ RAW HTTP RATHER THAN `autumn-js`, AND THE REASON IS THE FAIL-OPEN POLICY.
 * Autumn's own SDK fails open by returning `{ allowed: true }` when it cannot
 * reach the service — which is the same decision this codebase makes, but made
 * somewhere we cannot see and cannot distinguish from a real answer. Here the
 * three outcomes stay separate all the way up: `allowed`, `exceeded`, and
 * `unavailable`, with `shouldSend()` as the single named place that turns the
 * third into "send anyway". Same behaviour, one place to change it, and a log
 * line that says which of the three actually happened.
 *
 * It also keeps the dependency surface at `fetch`, which matters for a service
 * that is self-hosted: the base URL is configuration, not a constant compiled
 * into a vendor client.
 *
 * ⚠ THE CUSTOMER ID IS THE TENANT ID, VERBATIM. `core.tenants.id` is what every
 * `track` and every `check` is keyed on, and send/reconcile.ts's
 * `missingCustomers()` compares the two lists directly. Mapping through a
 * second identifier would give one customer two names and make a mis-billed
 * tenant invisible to that check.
 */

/** Autumn pins its request and response shapes to this. Sent on every call. */
const API_VERSION = "2.3.0"

export interface AutumnOptions {
  /** The Autumn instance. Self-hosted in production; the SaaS by default. */
  baseUrl?: string
  secretKey: string
  /** The metered feature every email is one unit of. */
  featureId: string
  /**
   * The plan a brand-new tenant lands on.
   *
   * ⚠ IT MUST EXIST IN AUTUMN BEFORE THE FIRST SIGNUP. Defined in
   * infra/autumn/autumn.config.ts and pushed with `atmn push`; a tenant
   * auto-enabled onto a plan id that is not there is a customer with no
   * entitlement, which reads as an outage rather than as a misconfiguration.
   */
  freePlanId?: string
  /**
   * ⚠ A BUDGET, NOT A TIMEOUT KNOB. `checkQuota` sits inside `POST /emails`, so
   * this number is added to the latency of every send when Autumn is slow. It
   * has to be short enough that a degraded Autumn costs a customer milliseconds
   * rather than seconds — the request still succeeds either way, because a
   * timeout is `unavailable` and `unavailable` sends.
   */
  timeoutMs?: number
  /** Injected in tests. */
  fetch?: typeof fetch
  log?: Logger
}

export interface Logger {
  warn: (o: object, m: string) => void
  error: (o: object, m: string) => void
}

/** One usage event. One email is one of these, with `value` 1. */
export interface TrackEvent {
  customerId: string
  /** i10's message id, so an event can be traced back to a specific email. */
  messageId: string
  /** ⚠ MILLISECONDS, AND IT MUST BE THE `sent_at` THE DATABASE STORED — see below. */
  at: Date
}

export interface AutumnClient {
  /** Never throws: a failure is `unavailable`, which is a decision, not an error. */
  check(customerId: string, required: number): Promise<QuotaOutcome>
  /** Fire-and-forget bulk recording. Throws on failure; never retried. */
  batchTrack(events: readonly TrackEvent[]): Promise<void>
  /** One event, idempotent on the message id. The reconciler's top-up. */
  track(event: TrackEvent): Promise<"recorded" | "duplicate">
  /** What Autumn believes each tenant used, per day, in a window. */
  aggregateByCustomer(start: Date, end: Date): Promise<UsageBucket[]>

  /**
   * Makes sure the tenant exists as a customer, on the free plan.
   *
   * ⚠ WITHOUT THIS, EVERY `check` FOR THAT TENANT IS A 404. Autumn has no
   * entitlement for a customer it has never heard of, so a tenant that is never
   * registered has no quota at all — which our client reads as `unavailable`
   * and fails open, meaning they send unmetered and unbilled forever with
   * nothing in the logs. `missingCustomers()` in send/reconcile.ts is the sweep
   * that finds the ones this did not reach.
   */
  ensureCustomer(input: EnsureCustomer): Promise<void>

  /**
   * Puts a tenant on a plan WITHOUT taking any money.
   *
   * ⚠ ENTITLEMENTS ONLY — POLAR IS THE PAYMENT RAIL AND THE STATE OF RECORD.
   * See the note on `grantPlan` below for the whole of that argument.
   */
  grantPlan(input: GrantPlan): Promise<void>
}

export interface EnsureCustomer {
  tenantId: string
  name?: string
  email?: string
}

export interface GrantPlan {
  tenantId: string
  /** A plan id from infra/autumn/autumn.config.ts. */
  planId: string
  /**
   * ⚠ POLAR'S SUBSCRIPTION ID, AND IT IS THREE THINGS AT ONCE. It is the
   * idempotency key — a webhook Polar retries targets the same subscription
   * instead of creating a second. It is the correlation key, so a row in Polar
   * and a row in Autumn can be matched without a lookup table. And it is what
   * makes the reconciler between the two about twenty lines rather than a
   * project. Omitting it is not an error, and every one of those properties is
   * silently lost.
   */
  subscriptionId?: string
}

/**
 * ⚠ AUTUMN'S OWN CAP ON DISTINCT GROUPS, AND ITS DEFAULT IS 9. Left unset, an
 * aggregate grouped by customer silently returns the nine busiest tenants and
 * nothing else — every other tenant reads as zero, the reconciler sees a
 * deficit equal to everything they sent, and tops it all up a second time. A
 * silent under-report here is not a missing number, it is a double charge.
 *
 * 250 is the documented maximum, so it is also a ceiling this codebase will
 * eventually hit; `aggregateByCustomer` refuses rather than truncating.
 */
const MAX_GROUPS = 250

/** Autumn accepts at most 1000 events per batch. */
const MAX_BATCH = 1000

export function autumnClient(opts: AutumnOptions): AutumnClient {
  const base = (opts.baseUrl ?? "https://api.useautumn.com").replace(/\/+$/, "")
  const doFetch = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? 2000

  async function post(
    path: string,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<{ status: number; body: unknown }> {
    const response = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.secretKey}`,
        "x-api-version": API_VERSION,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
      // ⚠ EVERY CALL IS BOUNDED. Without this a hung Autumn holds an accept
      // request open until the client gives up, which converts a billing
      // outage into an i10 outage — the exact coupling fail-open exists to
      // avoid.
      signal: AbortSignal.timeout(timeoutMs),
    })

    // A body is not guaranteed on every status, and a proxy returning HTML on a
    // 502 must not surface as a JSON parse error somewhere further up.
    let parsed: unknown = null
    try {
      parsed = await response.json()
    } catch {
      parsed = null
    }
    return { status: response.status, body: parsed }
  }

  const event = (e: TrackEvent) => ({
    customer_id: e.customerId,
    feature_id: opts.featureId,
    value: 1,
    // ⚠ THE DATABASE'S `sent_at`, NOT `Date.now()`. send/reconcile.ts buckets
    // our side by `sent_at` and Autumn's side by event timestamp; a message sent
    // at 23:59:59.9 and recorded at 00:00:00.1 would land in different days on
    // the two sides, and the reconciler would then see a deficit on one day and
    // a surplus on the next — topping the message up a second time, every run,
    // forever. Passing the stored value is what makes the two agree.
    timestamp: e.at.getTime(),
    properties: { i10_message_id: e.messageId },
  })

  return {
    async check(customerId, required) {
      let result: { status: number; body: unknown }
      try {
        result = await post("/v1/balances.check", {
          customer_id: customerId,
          feature_id: opts.featureId,
          // One call for the whole request: a batch of five hundred asks for
          // five hundred, not five hundred times for one.
          required_balance: required,
        })
      } catch (err) {
        // A timeout, a DNS failure, a refused connection. Not an answer.
        opts.log?.warn({ err, customerId }, "autumn check unreachable")
        return { status: "unavailable", message: "Could not reach metering." }
      }

      if (result.status < 200 || result.status >= 300) {
        // ⚠ INCLUDING 404, WHICH MEANS THE TENANT IS NOT A CUSTOMER AT ALL.
        // That is a real and serious problem — every `track` for them has been
        // failing since they signed up — but it is not evidence they are over
        // quota, and refusing their mail would be the wrong repair. The
        // reconciler's `missingCustomers()` is what surfaces it.
        opts.log?.warn(
          { customerId, status: result.status },
          "autumn check refused — treating as unavailable",
        )
        return { status: "unavailable", message: "Could not check the sending quota." }
      }

      const body = result.body as {
        allowed?: boolean
        balance?: { remaining?: number; next_reset_at?: number | null } | null
      } | null

      if (body?.allowed) return { status: "allowed" }

      const resetsAt = body?.balance?.next_reset_at
      return {
        status: "exceeded",
        message: "You have used your sending allowance for this period.",
        ...(typeof resetsAt === "number" ? { resetsAt: new Date(resetsAt) } : {}),
      }
    },

    async batchTrack(events) {
      for (let i = 0; i < events.length; i += MAX_BATCH) {
        const chunk = events.slice(i, i + MAX_BATCH)
        // ⚠ A BARE ARRAY IS THE BODY. Not `{ events: [...] }` — Autumn's schema
        // is `type: array` at the top level.
        const result = await post("/v1/balances.batch_track", chunk.map(event))

        // ⚠ AND IT IS NEVER RETRIED, ON AUTUMN'S OWN INSTRUCTION. The endpoint
        // enqueues and answers 202 before the items are applied; partial
        // failures are logged server-side and not reported back, so a retry
        // re-enqueues everything that already succeeded and double-deducts.
        // Their documentation is explicit that gaps are preferable to
        // duplicates. So a failure here is a gap, and send/reconcile.ts closes
        // it with `track`, which IS idempotent.
        if (result.status < 200 || result.status >= 300) {
          throw new Error(
            `autumn batch_track failed with ${result.status} for ${chunk.length} events`,
          )
        }
      }
    },

    async track(e) {
      // ⚠ THE IDEMPOTENCY KEY IS THE MESSAGE ID, WHICH IS WHAT MAKES THE
      // RECONCILER SAFE TO RUN TWICE. Autumn answers 409 to a replayed key, so
      // submitting the same message a second time — two reconcilers racing, one
      // retried after a timeout — cannot double-bill. Submitting "seventeen
      // more" instead would add thirty-four.
      const result = await post("/v1/balances.track", event(e), e.messageId)
      if (result.status === 409) return "duplicate"
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`autumn track failed with ${result.status} for ${e.messageId}`)
      }
      return "recorded"
    },

    async aggregateByCustomer(start, end) {
      const result = await post("/v1/events.aggregate", {
        feature_id: opts.featureId,
        group_by: "$customer_id",
        bin_size: "day",
        custom_range: { start: start.getTime(), end: end.getTime() },
        max_groups: MAX_GROUPS,
      })

      if (result.status < 200 || result.status >= 300) {
        throw new Error(`autumn events.aggregate failed with ${result.status}`)
      }

      const body = result.body as {
        list?: {
          period?: number
          grouped_values?: Record<string, Record<string, number>>
        }[]
      } | null

      const buckets: UsageBucket[] = []

      for (const bin of body?.list ?? []) {
        const grouped = bin.grouped_values?.[opts.featureId] ?? {}
        for (const [customerId, count] of Object.entries(grouped)) {
          buckets.push({
            tenantId: customerId,
            periodStart: new Date(bin.period ?? 0),
            count,
          })
        }
        // ⚠ REFUSE RATHER THAN RETURN A TRUNCATED ANSWER. At the cap we cannot
        // tell "these are all the tenants" from "these are the busiest 250",
        // and the reconciler cannot either — it would read every omitted tenant
        // as zero and bill their whole day again. When this fires, the fix is
        // to aggregate per customer rather than to raise the cap.
        if (Object.keys(grouped).length >= MAX_GROUPS) {
          throw new Error(
            `autumn returned ${MAX_GROUPS} groups for ${new Date(bin.period ?? 0).toISOString()}; ` +
              "the aggregate is truncated and must not be reconciled against",
          )
        }
      }

      return buckets
    },

    async ensureCustomer(input) {
      const result = await post("/v1/customers.get_or_create", {
        id: input.tenantId,
        ...(input.name ? { name: input.name } : {}),
        ...(input.email ? { email: input.email } : {}),

        // ⚠ THE TWO FLAGS THAT KEEP AUTUMN OUT OF PAYMENTS ENTIRELY.
        //
        // `create_in_stripe: false` stops it minting a Stripe customer for
        // every tenant. We have no Stripe account and want none — Polar is the
        // merchant of record, and it is what takes the tax problem with it.
        // Left at its default, this call fails on a Stripe credential that does
        // not exist, and the failure arrives as "could not create customer"
        // rather than as anything about Stripe.
        create_in_stripe: false,

        // ⚠ AND THIS IS WHAT PUTS A NEW TENANT ON THE FREE PLAN IN THE SAME
        // ROUND TRIP. A separate attach afterwards would be a second call that
        // can fail on its own, leaving a customer who exists with no
        // entitlement — the one state that reads as "unavailable" forever.
        auto_enable_plan_id: opts.freePlanId ?? "free",
      })

      if (result.status < 200 || result.status >= 300) {
        throw new Error(
          `autumn customers.get_or_create failed with ${result.status} for ${input.tenantId}`,
        )
      }
    },

    /**
     * ⚠ `no_billing_changes: true` IS THE WHOLE DESIGN, NOT A FLAG. It is
     * Autumn's own supported path for people who settle payment elsewhere: the
     * plan is attached, entitlements move, and no subscription, invoice or
     * charge is created anywhere. Autumn never learns Polar exists, which is
     * why it stays entirely upstream and updatable — no fork, and plain
     * `attach()` still works the day a payment provider is reachable from here.
     *
     * ⚠ AND IT INVERTS WHO OWNS THE TRUTH. With billing changes off, POLAR is
     * the state of record for subscriptions and Autumn is a downstream copy.
     * Polar's webhooks must be the only thing that moves a customer between
     * paid plans — a webhook lost during a deploy is a customer silently on the
     * wrong plan, and nothing in Autumn will ever notice. That is why the
     * reconcile job is not optional.
     *
     * ⚠ POLAR IS DELIBERATELY NOT NAMED IN THIS FUNCTION. It takes a plan and a
     * subscription id and knows nothing about where they came from, so the day
     * a Stripe webhook calls it instead, it is unchanged.
     */
    async grantPlan(input) {
      const result = await post("/v1/billing.attach", {
        customer_id: input.tenantId,
        plan_id: input.planId,
        no_billing_changes: true,

        // Belt and braces: with no billing changes there is nothing to redirect
        // to, but the default is `if_required` and a checkout URL returned to a
        // caller that has no browser is a silently dropped flow.
        redirect_mode: "never",

        ...(input.subscriptionId ? { subscription_id: input.subscriptionId } : {}),
      })

      if (result.status < 200 || result.status >= 300) {
        throw new Error(
          `autumn billing.attach failed with ${result.status} for ${input.tenantId} -> ${input.planId}`,
        )
      }
    },
  }
}

/**
 * The `Metering` the send path actually uses.
 *
 * ⚠ TWO ENDPOINTS FOR TWO DIFFERENT JOBS, AND THEY ARE NOT INTERCHANGEABLE.
 * `check` is synchronous and on the accept path, so it must be fast and is
 * allowed to be approximate. `batch_track` is asynchronous and off the send
 * path, so it must never fail a send and is allowed to lose events, because the
 * reconciler is what makes the number true.
 *
 * ⚠ WRAP THIS IN `resilient()` BEFORE USING IT. `batchTrack` throws, on
 * purpose — the alternative is a client that silently swallows and a gap nobody
 * ever sees in a log. `resilient` is the one place that decides a billing
 * failure cannot fail a send.
 */
export function autumnMetering(opts: AutumnOptions): Metering {
  const client = autumnClient(opts)
  return {
    checkQuota: (tenantId, count) => client.check(tenantId, count),
    recordSent: (tenantId, sent: readonly SentMessage[]) =>
      client.batchTrack(
        sent.map((m) => ({ customerId: tenantId, messageId: m.id, at: m.sentAt })),
      ),
  }
}
