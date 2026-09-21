import type { PolarSubscription } from "./events.js"

/**
 * Polar over HTTP.
 *
 * ⚠ RAW `fetch` RATHER THAN `@polar-sh/sdk`, AND THE RETIRED AUTUMN CLIENT WAS
 * WRITTEN THE SAME WAY. The
 * SDK is a generated client for the whole API — checkouts, benefits, orders,
 * seats, discounts — and this uses two endpoints of it. What it would buy is
 * types we can write in twenty lines; what it costs is a large dependency on
 * the path that grants paid plans, and a version bump that can change the wire
 * format underneath us.
 *
 * The one thing worth taking from the SDK is its signature verification, and
 * that is not here: see billing/signature.ts, which reimplements it precisely
 * because Polar's key derivation is not the one the specification describes.
 *
 * ⚠ SANDBOX IS A DIFFERENT HOST, NOT A FLAG ON A REQUEST. Separate database,
 * separate tokens, separate webhook secrets, separate product ids. A production
 * token against the sandbox host is a 401, which is the good failure; the bad
 * one is a sandbox token in production, where checkouts succeed and no money
 * ever moves.
 */

/**
 * A call Polar refused, with the status it refused it with.
 *
 * ⚠ IT EXISTS BECAUSE ONE SENTENCE WAS BEING SHOWN FOR EVERY FAILURE. A plan
 * change reported "Polar could not apply the change. Check the payment
 * method." for a 401 on a token from the wrong environment, a 404 on a
 * subscription belonging to another organisation, and a 422 on a product id
 * that is not ours — none of which a customer can fix by looking at their
 * card, and all of which sent somebody to their bank instead of to the log
 * line that says what happened. The status is the one fact that separates
 * them, so it travels with the error.
 */
export class PolarCallError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    message: string,
  ) {
    super(message)
    this.name = "PolarCallError"
  }
}

const HOSTS = {
  sandbox: "https://sandbox-api.polar.sh",
  production: "https://api.polar.sh",
} as const

export type PolarServer = keyof typeof HOSTS

export interface PolarOptions {
  accessToken: string
  server: PolarServer
  /** Bounds a checkout request. This one sits in front of a waiting customer. */
  timeoutMs?: number
  fetch?: typeof fetch
}

export interface CheckoutInput {
  /** The Polar product being bought. From POLAR_PRODUCTS. */
  productId: string
  /**
   * ⚠ OUR TENANT ID, AND THIS IS THE JOIN THAT MAKES THE WEBHOOK USABLE. Polar
   * echoes it back as `customer.external_id` on every subscription event, so
   * the receiver knows who paid without a lookup table and without matching on
   * an email address the customer can change on the checkout page.
   */
  tenantId: string
  /** Where Polar sends the browser afterwards. NOT where the plan is granted. */
  successUrl?: string
  /** Prefills the form. Cosmetic; never used to identify the tenant. */
  email?: string
}

export interface Checkout {
  id: string
  url: string
  expiresAt: string
}

/**
 * A checkout read back by id, reduced to the two things the status page needs.
 *
 * ⚠ `tenantId` COMES FROM `metadata`, NOT FROM THE CALLER. That is the whole
 * point: the browser presents only a checkout id, and Polar is what says whose
 * checkout it is. A tenant taken from the query string would let anybody read
 * anybody's plan.
 */
export interface CheckoutState {
  id: string
  /** Polar's own: `open`, `expired`, `confirmed`, `succeeded`, `failed`. */
  status: string
  /** From `metadata.tenant_id`, or null on a checkout we did not create. */
  tenantId: string | null
  /**
   * The Polar customer this checkout resolved to, once it has one.
   *
   * ⚠ IT IS HERE SO SOMEBODY CAN ASK WHETHER THAT CUSTOMER CARRIES OUR TENANT
   * ID, WHICH IS THE ONE THING THAT DECIDES WHETHER A PAYMENT EVER REACHES US.
   * See `getCustomer` and routes/checkout-status.ts.
   */
  customerId: string | null
  /**
   * The product this checkout bought, and when it was created.
   *
   * ⚠ TOGETHER THEY IDENTIFY THE SUBSCRIPTION IT PRODUCED, which is the only
   * way to grant for a customer whose `external_id` names somebody else. A
   * customer can hold many subscriptions to many products; the one bought HERE
   * is the one for this product that did not exist before this checkout did.
   * Requiring both is what stops a reclaim reaching for a subscription that
   * belongs to another workspace sharing the same Polar customer.
   */
  productId: string | null
  createdAt: string | null
}

/** Just enough of a Polar customer to answer "will its events reach us". */
export interface CustomerState {
  id: string
  /**
   * ⚠ OURS TO SET AND POLAR'S TO KEEP, AND IT IS NULLABLE FOR A REASON THAT
   * COSTS MONEY. `external_customer_id` on a checkout sets this only when Polar
   * CREATES the customer; their own field documentation says so — "a new
   * customer will be created with this external ID set". A checkout that
   * resolves to a customer Polar already had leaves whatever that record
   * already carried, which for a customer created any other way is nothing.
   */
  externalId: string | null
}

export interface PolarClient {
  createCheckout(input: CheckoutInput): Promise<Checkout>
  /**
   * One checkout, by id. `null` when Polar does not know it — which is the
   * answer for a made-up id, and must not be confused with "not paid".
   */
  getCheckout(checkoutId: string): Promise<CheckoutState | null>
  /**
   * One customer, by Polar's id. `null` when Polar does not know it.
   *
   * ⚠ IT EXISTS FOR EXACTLY ONE QUESTION: does this customer carry our tenant
   * id. Every subscription event is attributed by `customer.external_id` and
   * nothing else, so a customer without one is a paying customer whose events
   * are discarded by `toState` — silently, in the webhook AND in the
   * reconciler, for ever. This is how that becomes something we can say out
   * loud rather than something nobody can see.
   */
  getCustomer(customerId: string): Promise<CustomerState | null>
  /**
   * Stamps our tenant id onto a Polar customer that has none.
   *
   * ⚠ THIS IS THE REPAIR FOR THE ONE FAILURE NOTHING ELSE CAN REACH. Polar sets
   * `external_id` only on a customer it CREATES from a checkout's
   * `external_customer_id`; a customer that already existed — bought something
   * before, or was made by hand in their dashboard — keeps a null one. Every
   * subscription event for that customer is then dropped by `toState`, in the
   * webhook and in the reconciler alike, so the payment succeeds and no plan is
   * ever granted. Writing the id back is the only thing that unblocks it.
   *
   * ⚠ IT RESOLVES `false` RATHER THAN THROWING. It runs inside a status poll a
   * customer is watching; a repair that did not work must not turn a page that
   * was about to say "your plan is active" into an error.
   */
  setCustomerExternalId(customerId: string, externalId: string): Promise<boolean>
  /**
   * Deletes the Polar customer carrying this tenant id, when the workspace is
   * deleted.
   *
   * ⚠ THIS IS THE ROOT FIX FOR STALE ATTRIBUTION, AND IT IS THE ONLY ONE THERE
   * CAN BE. Polar deduplicates customers by EMAIL and stamps `external_id` only
   * when it CREATES one — and that field is IMMUTABLE, verified against the API
   * (`422 Customer external ID cannot be updated`). So a customer left standing
   * after a workspace is deleted will be reused on the person's next signup,
   * carrying the dead tenant's id for the rest of the account's life, and no
   * edit can ever correct it. Deleting it means the next signup gets a FRESH
   * customer whose `external_id` is stamped, correctly, at creation.
   *
   * ⚠ BY EXTERNAL ID, NOT BY CUSTOMER ID, WHICH IS ALSO A SAFETY PROPERTY. We
   * need no stored customer id — so this works for a workspace whose
   * subscription row we lost — and it can only ever match a customer carrying
   * OUR tenant id. A customer whose `external_id` names somebody else is not
   * found and not touched.
   *
   * ⚠ WHAT IT DOES AND DOES NOT DESTROY, read out of Polar's own source
   * (`server/polar/customer/service.py`) because the answer decides whether
   * this is safe at all:
   *   - the customer row is SOFT deleted (`deleted_at = now()`), not removed;
   *   - orders, payments and invoices are UNTOUCHED — `OrderRepository`'s
   *     soft-deletion filter applies to `Order.deleted_at`, and its join to
   *     `Customer` carries no deleted predicate, so they stay listed;
   *   - `anonymize` defaults to FALSE on the endpoint, so no PII is scrubbed
   *     unless asked, and even that path preserves the payment-processor id,
   *     `external_id` and `tax_id`, keeping invoices intact;
   *   - every billable subscription IS cancelled immediately, `past_due`
   *     included, and pending orders are voided.
   *
   * ⚠ SO IT MUST NEVER RUN BEFORE THE REVOKE IT FOLLOWS. That cancellation is
   * Polar's, on its own schedule; ours is the one we report on. And afterwards
   * `GET /v1/customers/{id}` answers 404 for that customer, so anything holding
   * its id can no longer read it back.
   *
   * `not_found` is an ordinary answer — no customer ever carried this tenant —
   * and not a failure.
   */
  deleteCustomerByExternalId(externalId: string): Promise<"deleted" | "not_found">
  /**
   * Every subscription Polar holds for this organisation. The reconciler's view.
   *
   * ⚠ `customerId` NARROWS IT FOR THE REPAIR PATH AND MUST NOT BE USED BY THE
   * RECONCILER. That job compares Polar's whole picture against ours, and a
   * filtered list would make it blind to the subscriptions it exists to find.
   */
  listSubscriptions(filter?: { customerId?: string }): Promise<PolarSubscription[]>
  /**
   * Usage, into Polar's meter.
   *
   * ⚠ SAFE TO RETRY, BECAUSE `external_id` IS THE MESSAGE ID. Polar's ingest
   * answers with `inserted` and `duplicates` and skips anything it has already
   * seen, so a flush that timed out after Polar committed costs a re-send and
   * nothing else. That property is the reason the whole pipeline can be
   * at-least-once.
   */
  ingestEvents(events: readonly UsageIngestEvent[]): Promise<IngestResult>

  /**
   * Moves a live subscription to another product.
   *
   * ⚠ THIS IS THE ONLY WAY PRORATION HAPPENS THE WAY ANYONE EXPECTS. Polar's
   * `update.py` has no upgrade/downgrade branch — it acts on
   * `proration_behavior` alone — so "charge an upgrade now, defer a downgrade"
   * exists only because WE choose the behaviour per direction. An organisation
   * default cannot be right for both, and the customer portal only ever uses
   * the default.
   */
  updateSubscription(input: UpdateSubscription): Promise<void>

  /**
   * Ends a live subscription at the end of the period it has been paid for.
   *
   * ⚠ THIS IS HOW SOMEBODY GETS BACK TO THE FREE PLAN, and without it there was
   * no way down at all. `updateSubscription` moves between Polar PRODUCTS, and
   * the free plan deliberately has none — nothing is charged for it, so there
   * is nothing to sell. A customer on Pro could therefore upgrade, and could
   * move sideways, and could not leave: the console showed a "Downgrade" button
   * for free that answered `No such plan: free`.
   *
   * ⚠ AT THE PERIOD END, NOT IMMEDIATELY, WHICH IS THE SAME RULE EVERY OTHER
   * DOWNGRADE FOLLOWS. They have paid for the month; taking the allowance away
   * the moment they click is both a refund question and a nasty surprise for
   * whatever is sending through it. `prorationFor("downgrade")` defers for
   * exactly this reason, and cancelling is the largest downgrade there is.
   */
  cancelSubscription(subscriptionId: string): Promise<void>

  /**
   * Calls off a cancellation that has not happened yet.
   *
   * ⚠ THE MISSING HALF OF `cancelSubscription`, AND ITS ABSENCE WAS A TRAP
   * SOMEBODY COULD WALK INTO AND NOT WALK OUT OF. Cancelling is deferred to
   * the period boundary — deliberately, they have paid for the rest of the
   * month — so for up to a month the subscription is alive, billed for, and
   * marked to end. Every control in the console read that state as "already
   * decided": the free card said "Ending", the paid card said "Current plan",
   * and there was no way to say "actually, keep it" short of waiting for the
   * subscription to lapse and buying it again.
   *
   * ⚠ IT IS A `PATCH`, NOT A NEW SUBSCRIPTION. Nothing is bought and nothing
   * is charged — the same subscription simply stops being marked, which is
   * why this is safe to offer as an ordinary button rather than a checkout.
   */
  resumeSubscription(subscriptionId: string): Promise<void>

  /**
   * Ends a live subscription NOW — benefits revoked, billing stopped, no
   * remainder of the period.
   *
   * ⚠ THE OPPOSITE OF `cancelSubscription`, AND THE DIFFERENCE IS WHO ASKED.
   * Everything else in this file defers, because a customer who downgrades has
   * paid for the rest of the month and taking it away would be both a refund
   * question and a nasty surprise. Deleting a workspace is not that: the
   * account is gone, the mailboxes are gone, nobody is left to use what the
   * remainder of the period would buy — and leaving the subscription running to
   * the boundary means charging somebody who has deleted their account, which
   * is the one billing failure a customer will never accept an explanation for.
   * The console says immediately, so this has to mean immediately.
   *
   * ⚠ `already_ended` IS A SUCCESS, NOT AN ERROR. Polar answers 403 for a
   * subscription it has already revoked and 404 for one it does not know, and
   * this runs from a webhook Svix redelivers — turning either into a throw
   * would make every retry of a completed deletion a 500, retried until the
   * budget runs out, against a subscription that is already off.
   *
   * ⚠ A 409 DOES THROW, THOUGH, AND THAT IS DELIBERATE. Polar locks a
   * subscription while an update is pending; the answer is to try again in a
   * moment, which is exactly what a non-2xx from the webhook buys us.
   */
  revokeSubscription(subscriptionId: string): Promise<"revoked" | "already_ended">

  /**
   * A short-lived token for the embedded payment-method form.
   *
   * ⚠ MINTED SERVER-SIDE, WHICH IS WHY THIS EXISTS AT ALL. The embed needs a
   * credential and the only alternative is putting our Polar access token in a
   * browser. The session lasts an hour and is scoped to one customer.
   */
  createCustomerSession(tenantId: string): Promise<{ token: string }>
}

/** Polar's four behaviours. We use two; see `prorationFor`. */
export type ProrationBehavior = "invoice" | "prorate" | "next_period" | "reset"

export interface UpdateSubscription {
  subscriptionId: string
  /** The Polar product to move to. From POLAR_PRODUCTS, never from a request. */
  productId: string
  prorationBehavior: ProrationBehavior
}

export interface UsageIngestEvent {
  /** The meter's event name. Must match what the meter filters on. */
  name: string
  /** ⚠ Our message id. The dedup key, the same one the ledger is keyed on. */
  externalId: string
  /** ⚠ Our tenant id, which Polar already holds as `customer.external_id`. */
  tenantId: string
  /**
   * ⚠ WHEN IT HAPPENED, NOT WHEN WE SENT IT — and Polar rejects a timestamp in
   * the future outright. Their billing period attributes by RECEIPT time, so a
   * flush that straddles a period boundary moves revenue between months
   * whatever this says; the timestamp is what makes the meter's own reporting
   * line up with ours.
   */
  at: Date
  /** Units. One email is 1. */
  units: number
}

export interface IngestResult {
  inserted: number
  duplicates: number
}

export function polarClient(opts: PolarOptions): PolarClient {
  const base = HOSTS[opts.server]
  const doFetch = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? 5000

  async function call(path: string, init?: RequestInit): Promise<Response> {
    return doFetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${opts.accessToken}`,
        "content-type": "application/json",
        ...init?.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  /**
   * The return URL, guaranteed to carry the checkout id.
   *
   * ⚠ THE LANDING PAGE IS INERT WITHOUT IT, AND NOTHING ENFORCED IT. Polar
   * substitutes the literal `{CHECKOUT_ID}` into `success_url` before
   * redirecting, and `/billing` reads `?checkout_id=` to know what to poll for.
   * `POLAR_SUCCESS_URL` is a free-text environment variable: set to
   * `https://dash.i10.tech/billing` — which is the obvious thing to type — the
   * customer lands on a page that immediately answers "we could not find that
   * checkout" for a payment that went through. An operator should not be able
   * to break the confirmation page by leaving a placeholder off a URL.
   *
   * ⚠ APPENDED AS TEXT RATHER THAN THROUGH `URLSearchParams`, which would
   * percent-encode the braces into `%7BCHECKOUT_ID%7D` and leave Polar nothing
   * to substitute — a URL that looks right in the dashboard and interpolates
   * nothing.
   */
  function withCheckoutId(successUrl: string): string {
    if (successUrl.includes("{CHECKOUT_ID}")) return successUrl
    return `${successUrl}${successUrl.includes("?") ? "&" : "?"}checkout_id={CHECKOUT_ID}`
  }

  return {
    async createCheckout(input) {
      const response = await call("/v1/checkouts/", {
        method: "POST",
        body: JSON.stringify({
          products: [input.productId],
          external_customer_id: input.tenantId,
          ...(input.email ? { customer_email: input.email } : {}),
          ...(input.successUrl
            ? {
                success_url: withCheckoutId(input.successUrl),
                /*
                 * ⚠ THE FIELD THE EMBEDDED CHECKOUT CANNOT WORK WITHOUT, AND
                 * WE WERE DELIBERATELY NOT SENDING IT. Read Polar's own
                 * checkout page: every message it posts to the parent window
                 * is gated on this value.
                 *
                 *   // CheckoutEmbedClose.tsx
                 *   if (!checkout.embed_origin) { return }
                 *   PolarEmbedCheckout.postMessage({ event: 'close' }, …)
                 *
                 * `loaded`, `confirmed` and `success` carry the identical
                 * guard. Unset, the iframe still renders and still takes the
                 * money — and says nothing to the page it is sitting on, for
                 * ever. That is the whole of the bug we spent two rounds
                 * working around: their ✕ "not working" is their ✕ returning
                 * early, and the `success` event that "never arrived" was
                 * never sent.
                 *
                 * ⚠ AN EARLIER PROBE CONCLUDED THIS FIELD WAS UNNECESSARY, AND
                 * IT MEASURED THE WRONG THING. It checked whether the checkout
                 * would FRAME without it — it does, `frame-ancestors` is
                 * governed separately by the organisation's embedding host
                 * list — and generalised that to messaging. Two mechanisms,
                 * one of them load-bearing.
                 *
                 * ⚠ IT IS THE ORIGIN OF `success_url` RATHER THAN A SETTING OF
                 * ITS OWN. Both name the console, and a second environment
                 * variable is a second thing that can disagree with the first
                 * — silently, because the only symptom is a modal that stops
                 * talking. Polar does not validate it against anything at
                 * creation time, so a wrong value fails exactly as an absent
                 * one does, which is the argument for deriving it.
                 */
                embed_origin: new URL(input.successUrl).origin,
              }
            : {}),
          // ⚠ THE TENANT IS SENT TWICE ON PURPOSE. `external_customer_id` is
          // what Polar promotes onto the customer and echoes on subscription
          // events; `metadata` is what survives on the checkout object itself
          // if we ever need to answer "who started this and never finished".
          metadata: { tenant_id: input.tenantId },
        }),
      })

      if (!response.ok) {
        throw new Error(
          `polar checkouts.create failed with ${response.status} for tenant ${input.tenantId}`,
        )
      }

      const body = (await response.json()) as {
        id: string
        url: string
        expires_at: string
      }
      return { id: body.id, url: body.url, expiresAt: body.expires_at }
    },

    async getCheckout(checkoutId) {
      const response = await call(`/v1/checkouts/${encodeURIComponent(checkoutId)}`)

      // ⚠ 404 IS AN ANSWER, NOT A FAILURE. The id arrives from a query string,
      // so "Polar has never heard of this" is the ordinary case for a typo or a
      // probe — and it is emphatically NOT "the payment failed". The caller
      // renders those two differently.
      //
      // ⚠ AND 422 IS THE SAME ANSWER, WHICH IT WAS NOT BEING TREATED AS. Polar
      // validates the id before looking it up, so a well-formed UUID that is
      // not one of theirs comes back 422 rather than 404 — measured against the
      // sandbox with an all-zeros UUID. That fell through to the throw below and
      // surfaced to the browser as 503 "Could not reach the payment provider",
      // which says a payment system is down when in fact it answered
      // immediately and correctly. Both mean "no such checkout".
      if (response.status === 404 || response.status === 422) return null
      if (!response.ok) {
        throw new Error(`polar checkouts.get failed with ${response.status}`)
      }

      const body = (await response.json()) as {
        id: string
        status: string
        customer_id?: string | null
        product_id?: string | null
        created_at?: string | null
        metadata?: Record<string, unknown> | null
      }
      const tenantId = body.metadata?.tenant_id

      return {
        id: body.id,
        status: body.status,
        tenantId: typeof tenantId === "string" && tenantId ? tenantId : null,
        customerId: body.customer_id ?? null,
        productId: body.product_id ?? null,
        createdAt: body.created_at ?? null,
      }
    },

    async getCustomer(customerId) {
      const response = await call(`/v1/customers/${encodeURIComponent(customerId)}`)

      // Same rule as `getCheckout`: both statuses mean "no such customer", and
      // neither is a failure worth failing a page over.
      if (response.status === 404 || response.status === 422) return null

      /*
       * ⚠ A 403 HERE IS A MISSING SCOPE ON OUR OWN TOKEN, AND IT NEVER CLEARS.
       * `customers:read` is NOT in the set a Polar organisation access token is
       * created with by default — the same trap `createCustomerSession`
       * already documents for `customer_sessions:write`. Measured against
       * production 2026-09-20: every call to this endpoint answered
       * `403 insufficient_scope`, which the caller caught and treated as "Polar
       * is briefly unreachable, assume attribution is fine". So the whole
       * attribution repair — detect AND fix — was dead on that deployment, and
       * nothing said so. It is named here so the message points at the token
       * rather than at the customer.
       */
      if (response.status === 403) {
        throw new Error(
          "polar customers.get refused: the access token is missing the " +
            "`customers:read` scope. Add `customers:read` and `customers:write` " +
            "to the organisation access token in Polar's dashboard and redeploy.",
        )
      }

      if (!response.ok) {
        throw new Error(`polar customers.get failed with ${response.status}`)
      }

      const body = (await response.json()) as {
        id: string
        external_id?: string | null
      }

      return { id: body.id, externalId: body.external_id ?? null }
    },

    async ingestEvents(events) {
      if (events.length === 0) return { inserted: 0, duplicates: 0 }

      const response = await call("/v1/events/ingest", {
        method: "POST",
        body: JSON.stringify({
          events: events.map((event) => ({
            name: event.name,
            external_id: event.externalId,
            // ⚠ `external_customer_id`, NOT `customer_id`. Polar echoes our
            // tenant id back on every subscription webhook as
            // `customer.external_id` precisely so neither side needs a lookup
            // table; using their uuid here would reintroduce one.
            external_customer_id: event.tenantId,
            timestamp: event.at.toISOString(),
            metadata: { units: event.units },
          })),
        }),
      })

      if (!response.ok) {
        throw new Error(
          `polar ingest failed: ${response.status} ${await response.text()}`,
        )
      }

      const body = (await response.json()) as {
        inserted?: number
        duplicates?: number
      }
      return { inserted: body.inserted ?? 0, duplicates: body.duplicates ?? 0 }
    },

    async updateSubscription({ subscriptionId, productId, prorationBehavior }) {
      const response = await call(
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            product_id: productId,
            proration_behavior: prorationBehavior,
          }),
        },
      )

      // ⚠ POLAR APPLIES THE CHANGE ONLY IF THE PAYMENT SUCCEEDS, for `invoice`
      // and `prorate`. A failed card is an error here and the subscription is
      // untouched — which is why this throws rather than reporting a partial
      // success the caller would have to reconcile.
      if (!response.ok) {
        const detail = await response.text()
        throw new PolarCallError(
          response.status,
          detail,
          `polar subscription update failed: ${response.status} ${detail}`,
        )
      }
    },

    async resumeSubscription(subscriptionId) {
      const response = await call(
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ cancel_at_period_end: false }),
        },
      )

      if (!response.ok) {
        const detail = await response.text()
        throw new PolarCallError(
          response.status,
          detail,
          `polar subscription resume failed: ${response.status} ${detail}`,
        )
      }
    },

    async cancelSubscription(subscriptionId) {
      /*
       * ⚠ `PATCH` WITH `cancel_at_period_end`, NEVER `DELETE`. Polar's DELETE on
       * a subscription revokes it there and then — benefits gone, mail stops —
       * for a customer who has paid through to the end of the month. This marks
       * it to end when the period does, which is what every other downgrade in
       * this file already does and what the console's copy already promises.
       */
      const response = await call(
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ cancel_at_period_end: true }),
        },
      )

      if (!response.ok) {
        const detail = await response.text()
        throw new PolarCallError(
          response.status,
          detail,
          `polar subscription cancel failed: ${response.status} ${detail}`,
        )
      }
    },

    async revokeSubscription(subscriptionId) {
      const response = await call(
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { method: "DELETE" },
      )

      if (response.status === 404) return "already_ended"

      /*
       * ⚠ 403 IS TWO DIFFERENT ANSWERS AND ONLY ONE OF THEM IS SUCCESS. Polar
       * documents it as "subscription already revoked", which is exactly what
       * this call wanted — but a token missing `subscriptions:write` answers
       * 403 too, and reading that as "already done" would mean every deletion
       * in the deployment silently leaves the subscription billing while the
       * log says it was revoked. The body is what tells them apart.
       */
      if (response.status === 403) {
        const detail = await response.text()
        if (detail.includes("insufficient_scope")) {
          throw new Error(
            "polar subscription revoke refused: the access token is missing the " +
              "`subscriptions:write` scope. Add it to the organisation access " +
              "token in Polar's dashboard and redeploy.",
          )
        }
        return "already_ended"
      }

      if (!response.ok) {
        throw new Error(
          `polar subscription revoke failed: ${response.status} ${await response.text()}`,
        )
      }

      return "revoked"
    },

    async createCustomerSession(tenantId) {
      const response = await call("/v1/customer-sessions", {
        method: "POST",
        // ⚠ `external_customer_id`, so neither side needs a lookup table — the
        // same id Polar already echoes on every subscription webhook.
        body: JSON.stringify({ external_customer_id: tenantId }),
      })

      if (!response.ok) {
        const detail = await response.text()

        /*
         * ⚠ A 403 HERE IS ALMOST ALWAYS A MISSING SCOPE ON OUR OWN TOKEN, NOT
         * ANYTHING ABOUT THE CUSTOMER — and the generic message sent somebody
         * looking at the customer record instead. `/v1/customer-sessions`
         * requires `customer_sessions:write`, which is NOT included in the
         * scope set a Polar organisation access token is created with by
         * default. Verified against the sandbox: with the default scopes this
         * endpoint answers `403 insufficient_scope` for every customer, so the
         * card form never opens for anybody and nothing about the failure
         * points at the token.
         */
        if (response.status === 403 && detail.includes("insufficient_scope")) {
          throw new Error(
            "polar customer session refused: the access token is missing the " +
              "`customer_sessions:write` scope. Add it to the organisation " +
              "access token in Polar's dashboard and redeploy.",
          )
        }

        /*
         * ⚠ A 422 HERE MEANS POLAR HAS NEVER HEARD OF THIS TENANT, which is the
         * normal state of anybody who has not been through checkout — Polar
         * creates the customer at the first payment, not at our sign-up. The
         * caller has to be able to tell that apart from a real failure, because
         * the answer is "you have nothing to pay with yet", not "try again".
         */
        if (response.status === 422 && detail.includes("Customer does not exist")) {
          throw new Error(
            `polar customer session refused: no Polar customer for tenant ${tenantId}. ` +
              "Polar creates a customer at the first checkout, so this is expected " +
              "for a tenant that has never subscribed.",
          )
        }

        throw new Error(`polar customer session failed: ${response.status} ${detail}`)
      }

      const body = (await response.json()) as { token?: string }
      if (!body.token) throw new Error("polar customer session returned no token")
      return { token: body.token }
    },

    async setCustomerExternalId(customerId, externalId) {
      const response = await call(`/v1/customers/${encodeURIComponent(customerId)}`, {
        method: "PATCH",
        body: JSON.stringify({ external_id: externalId }),
      }).catch(() => null)

      return response?.ok === true
    },

    async deleteCustomerByExternalId(externalId) {
      const response = await call(
        `/v1/customers/external/${encodeURIComponent(externalId)}`,
        { method: "DELETE" },
      )

      // ⚠ 404 IS SUCCESS, NOT AN ERROR TO REPORT. A workspace that never
      // reached a checkout has no Polar customer, and that is the commonest
      // deletion of all — treating it as a failure would put an error in the
      // log for every free account that ever leaves.
      if (response.status === 404) return "not_found"

      if (!response.ok) {
        throw new Error(`polar customers.delete failed with ${response.status}`)
      }

      return "deleted"
    },

    async listSubscriptions(filter) {
      const all: PolarSubscription[] = []
      let page = 1
      const scope = filter?.customerId
        ? `&customer_id=${encodeURIComponent(filter.customerId)}`
        : ""

      // ⚠ EVERY SUBSCRIPTION, NOT ONLY THE ACTIVE ONES. `?active=true` would
      // make the reconciler blind to exactly the case it exists for: a
      // subscription that ended while a `revoked` webhook was lost, where our
      // row still says the customer is entitled. What is absent from an
      // active-only list is indistinguishable from what never existed.
      for (;;) {
        const response = await call(`/v1/subscriptions/?page=${page}&limit=100${scope}`)
        if (!response.ok) {
          throw new Error(`polar subscriptions.list failed with ${response.status}`)
        }

        const body = (await response.json()) as {
          items: PolarSubscription[]
          pagination: { max_page: number }
        }
        all.push(...body.items)

        if (page >= (body.pagination?.max_page ?? page)) return all
        page += 1
      }
    },
  }
}
