import type { PolarSubscription } from "./events.js"

/**
 * Polar over HTTP.
 *
 * ⚠ RAW `fetch` RATHER THAN `@polar-sh/sdk`, FOR THE SAME REASON AUTUMN IS. The
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
