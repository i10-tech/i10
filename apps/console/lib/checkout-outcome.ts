/**
 * What to say about a checkout, and whether to keep asking.
 *
 * ⚠ SPLIT OUT OF THE COMPONENT BECAUSE IT IS THE PART THAT CAN BE WRONG. The
 * rendering is a spinner and three colours; the decisions are which of six
 * endings a customer is looking at, and whether the page should still be
 * polling — and both used to be buried in a `useEffect` where the only way to
 * check them was to have a Polar account and a declined card. They are pure
 * functions of one JSON body, so they can simply be asserted.
 *
 * ⚠ NOTHING HERE DECIDES ANYTHING ABOUT ENTITLEMENT. Every field comes from
 * `/checkout-status/{id}`, which reads `core.subscriptions` and Polar. Arriving
 * at the page proves nothing; see components/checkout-outcome.tsx.
 */

/** Matches the API's `CheckoutStatus`, plus the client-only transport failure. */
export type Status = "granted" | "paid" | "unpaid" | "unknown" | "unavailable"

export interface Result {
  status: Status
  plan: string | null
  /**
   * Polar's own word for an unpaid checkout — `open`, `failed`, `expired`,
   * `confirmed` — or `unattributed` for the one paid state nothing can repair.
   */
  detail?: string
}

const STATUSES = ["granted", "paid", "unpaid", "unknown", "unavailable"] as const

/**
 * ⚠ A REAL CHECK, NOT A CAST, AND THE CAST IS WHAT BROKE THIS ONCE. The proxy
 * answers the API's own error shape verbatim when something upstream fails —
 * `{ statusCode, name, message }`, with no `status` field at all. Casting that
 * to `Result` and comparing it made the poll STOP on a body that said nothing,
 * and render "we could not find that checkout" to somebody who had paid.
 */
export const isStatus = (value: unknown): value is Status =>
  typeof value === "string" && (STATUSES as readonly string[]).includes(value)

/**
 * Whether this answer is still moving, and therefore worth another poll.
 *
 * ⚠ THERE ARE THREE STATES THAT ARE NOT ENDINGS, AND MISSING ANY OF THEM
 * FREEZES THE PAGE ON THE WRONG SENTENCE.
 *
 *   - `paid` — Polar has the money and the entitlement has not landed yet.
 *   - `unavailable` — our own API could not be reached. It says nothing about
 *     the payment, so it must not become a verdict.
 *   - `unpaid` + `confirmed` — the charge is IN FLIGHT. Polar sets `confirmed`
 *     when the customer has submitted and it is being processed; it becomes
 *     `succeeded` or `failed` within seconds. Stopping here would tell somebody
 *     their payment had not completed while it was going through.
 *
 * ⚠ AND `unattributed` IS AN ENDING DESPITE BEING `paid`. The API has already
 * tried to repair the attribution and could not, so nothing further is coming
 * and polling on is a spinner in front of an answer that has arrived.
 */
export function keepPolling(result: Result): boolean {
  if (result.detail === "unattributed") return false
  if (result.status === "paid" || result.status === "unavailable") return true
  return result.detail === "confirmed"
}

export interface View {
  tone: "success" | "waiting" | "failed"
  title: string
  body: string
}

export function present(result: Result | null, timedOut: boolean): View {
  if (!result) {
    /*
     * ⚠ `timedOut` IS CHECKED HERE TOO, AND ITS ABSENCE WAS A STUCK SPINNER.
     * This branch used to return "Checking your payment" unconditionally, so a
     * status endpoint that never answered usefully left that on screen FOR
     * EVER — the ceiling had already fired and had nowhere to show itself,
     * because `result` was still null.
     */
    return timedOut
      ? {
          tone: "waiting",
          title: "This is taking longer than usual",
          body: "If you completed the payment, nothing is lost. We keep retrying in the background — email support@i10.tech if your plan has not appeared in a few minutes.",
        }
      : { tone: "waiting", title: "Checking your payment", body: "One moment." }
  }

  switch (result.status) {
    case "granted":
      return {
        tone: "success",
        // ⚠ THE PLAN THEY ACTUALLY BOUGHT, NOT THE WORD "Pro". Hardcoding it
        // congratulated every customer on a subscription they may not have
        // purchased; `plan` is null only when the grant landed without one.
        title: result.plan ? `You're on ${result.plan}` : "You're all set",
        body: "Your subscription is active and your new sending allowance is available right away.",
      }

    case "paid":
    case "unavailable":
      /*
       * ⚠ THE ONE CASE WHERE "we will keep trying" WOULD BE A LIE, AND IT IS
       * THE CASE WHERE THE MONEY HAS ALREADY GONE. The API tries to repair this
       * itself — writing our tenant id onto Polar's customer, including
       * reclaiming one left behind by a deleted workspace — so reaching here
       * means that failed, or the customer carries another LIVE workspace's id
       * and must not be overwritten. Neither resolves on its own.
       */
      if (result.detail === "unattributed") {
        return {
          tone: "failed",
          title: "We could not match this payment",
          body: "Your payment went through and you have not lost it — we just cannot tie it to this workspace automatically. Email support@i10.tech and we will put your plan on straight away.",
        }
      }

      return timedOut
        ? {
            tone: "waiting",
            title: "This is taking longer than usual",
            body: "Your payment went through and nothing is lost. We keep retrying in the background — email support@i10.tech if your plan has not appeared in a few minutes.",
          }
        : {
            tone: "waiting",
            title: "Payment received",
            body: "Setting up your plan. This usually takes a few seconds.",
          }

    case "unpaid":
      /*
       * ⚠ FOUR DIFFERENT THINGS ARRIVE AS `unpaid` AND ONLY TWO OF THEM ARE
       * FAILURES. Before the console reported the outcome of a checkout it
       * closed itself, the only way to reach this branch was Polar's redirect —
       * and nobody is redirected for changing their mind, so one message
       * covered everything. Now that closing the modal lands here, `open` is
       * the common case and must not be dressed up in red.
       */
      if (result.detail === "confirmed") {
        return {
          tone: "waiting",
          title: "Processing your payment",
          body: "Your card is being charged. This takes a few seconds.",
        }
      }

      if (result.detail === "open") {
        return {
          tone: "waiting",
          title: "Checkout closed",
          body: "Nothing was charged. Pick a plan below whenever you are ready.",
        }
      }

      return {
        tone: "failed",
        title:
          result.detail === "expired"
            ? "This checkout expired"
            : "Payment not completed",
        body:
          result.detail === "expired"
            ? "Nothing was charged. Start again whenever you are ready."
            : "Your card was not charged — it may have been declined. You can try again below, or use a different card.",
      }

    default:
      return {
        tone: "waiting",
        title: "We could not find that checkout",
        body: "The link may be incomplete. If you have paid, your plan is safe — it will appear here.",
      }
  }
}
