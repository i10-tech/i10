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
}

export interface PolarClient {
  createCheckout(input: CheckoutInput): Promise<Checkout>
  /**
   * One checkout, by id. `null` when Polar does not know it — which is the
   * answer for a made-up id, and must not be confused with "not paid".
   */
  getCheckout(checkoutId: string): Promise<CheckoutState | null>
  /** Every subscription Polar holds for this organisation. The reconciler's view. */
  listSubscriptions(): Promise<PolarSubscription[]>
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

  return {
    async createCheckout(input) {
      const response = await call("/v1/checkouts/", {
        method: "POST",
        body: JSON.stringify({
          products: [input.productId],
          external_customer_id: input.tenantId,
          ...(input.email ? { customer_email: input.email } : {}),
          ...(input.successUrl ? { success_url: input.successUrl } : {}),
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
      if (response.status === 404) return null
      if (!response.ok) {
        throw new Error(`polar checkouts.get failed with ${response.status}`)
      }

      const body = (await response.json()) as {
        id: string
        status: string
        metadata?: Record<string, unknown> | null
      }
      const tenantId = body.metadata?.tenant_id

      return {
        id: body.id,
        status: body.status,
        tenantId: typeof tenantId === "string" && tenantId ? tenantId : null,
      }
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
        throw new Error(
          `polar subscription update failed: ${response.status} ${await response.text()}`,
        )
      }
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

    async listSubscriptions() {
      const all: PolarSubscription[] = []
      let page = 1

      // ⚠ EVERY SUBSCRIPTION, NOT ONLY THE ACTIVE ONES. `?active=true` would
      // make the reconciler blind to exactly the case it exists for: a
      // subscription that ended while a `revoked` webhook was lost, where our
      // row still says the customer is entitled. What is absent from an
      // active-only list is indistinguishable from what never existed.
      for (;;) {
        const response = await call(`/v1/subscriptions/?page=${page}&limit=100`)
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
