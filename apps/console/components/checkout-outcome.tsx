"use client"

import * as React from "react"
import { CheckCircle2, Clock, XCircle } from "lucide-react"
import { cn } from "cn"
import { Spinner } from "@repo/ui/components/spinner"

/*
 * ⚠ THIS COMPONENT CANNOT GRANT ANYTHING, AND ITS EXISTENCE IS THE REASON IT
 * MUST NOT LOOK AS THOUGH IT COULD. Polar's success redirect is a browser
 * navigation — anybody can type the URL — so nothing on screen may be decided
 * by having arrived here. Every state below comes from the API reading
 * `core.subscriptions`, a row only the signature-verified Polar webhook moves.
 *
 * ⚠ IT IS A BANNER ON THE PAGE THEY STARTED FROM, NOT A PAGE OF ITS OWN. The
 * old confirmation was a full-screen dark takeover at `/billing` with hardcoded
 * hexes and `text-white/55` — its own visual world, on the reasoning that it
 * was the last frame of Polar's checkout rather than the first of the console.
 * The cost was that it was a DEAD END: somebody who bought a plan during
 * onboarding landed there and the flow they were part-way through was gone. It
 * now renders wherever the checkout began, on the console's own tokens, so
 * paying is a thing that happened on the page rather than a place you are sent.
 */

/** Matches the API's `CheckoutStatus`, plus the client-only transport failure. */
type Status = "granted" | "paid" | "unpaid" | "unknown" | "unavailable"

interface Result {
  status: Status
  plan: string | null
  detail?: string
}

/**
 * ⚠ THE CEILING IS WHAT KEEPS THIS HONEST. Polling forever would leave a
 * spinner on screen for a customer whose grant genuinely failed, and a spinner
 * is a promise that something is still happening. After this we stop and say
 * plainly that it is taking longer than expected — the reconciler runs every
 * thirty minutes and will repair it, which is a true thing we can tell them.
 */
const POLL_MS = 2000
const GIVE_UP_MS = 90_000

const STATUSES = ["granted", "paid", "unpaid", "unknown", "unavailable"] as const

/** ⚠ A REAL CHECK, NOT A CAST. See the poll: the cast is what broke this once. */
const isStatus = (value: unknown): value is Status =>
  typeof value === "string" && (STATUSES as readonly string[]).includes(value)

export function CheckoutOutcome({
  checkoutId,
  className,
}: {
  /** From `?checkout_id=`. Nothing renders without one. */
  checkoutId: string | null
  className?: string
}) {
  const [result, setResult] = React.useState<Result | null>(null)
  const [timedOut, setTimedOut] = React.useState(false)

  React.useEffect(() => {
    if (!checkoutId) return

    let live = true
    let timer: ReturnType<typeof setTimeout>
    const startedAt = Date.now()

    const poll = async () => {
      try {
        const response = await fetch(`/api/checkout-status/${checkoutId}`, {
          cache: "no-store",
        })
        const body = (await response.json()) as Partial<Result>
        if (!live) return

        /*
         * ⚠ AN UNRECOGNISED BODY IS TREATED AS "KEEP WAITING", NOT AS A
         * VERDICT. The proxy answers the API's own error shape verbatim when
         * something upstream fails — `{ statusCode, name, message }`, with no
         * `status` field at all. Casting that to `Result` and comparing it is
         * what once made the poll STOP on a body that said nothing, and render
         * "we could not find that checkout" to somebody who had paid.
         */
        if (!isStatus(body.status)) {
          if (Date.now() - startedAt > GIVE_UP_MS) {
            setTimedOut(true)
            return
          }
          timer = setTimeout(poll, POLL_MS)
          return
        }

        setResult({
          status: body.status,
          plan: body.plan ?? null,
          ...(body.detail ? { detail: body.detail } : {}),
        })

        /*
         * Only `paid` is worth waiting on: it is the second between Polar
         * taking the money and our webhook landing. Everything else is settled.
         *
         * ⚠ EXCEPT THE ONE `paid` THAT IS ALSO SETTLED. `unattributed` now
         * means the API tried to repair the attribution and could not — see
         * routes/checkout-status.ts — so nothing further is coming and polling
         * on is a spinner in front of somebody whose answer has arrived.
         */
        if (body.detail === "unattributed") return
        if (body.status !== "paid" && body.status !== "unavailable") return
      } catch {
        if (!live) return
      }

      if (Date.now() - startedAt > GIVE_UP_MS) {
        if (live) setTimedOut(true)
        return
      }
      timer = setTimeout(poll, POLL_MS)
    }

    void poll()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [checkoutId])

  if (!checkoutId) return null

  const view = present(result, timedOut)

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl border p-4",
        view.tone === "success" && "border-success/30 bg-success/5",
        view.tone === "waiting" && "border-warning/30 bg-warning/5",
        view.tone === "failed" && "border-danger/30 bg-danger/5",
        className,
      )}
    >
      <span aria-hidden className="mt-0.5 shrink-0">
        {view.tone === "success" ? (
          <CheckCircle2 className="size-5 text-success" />
        ) : view.tone === "failed" ? (
          <XCircle className="size-5 text-danger" />
        ) : result === null ? (
          <Spinner className="size-5" />
        ) : (
          <Clock className="size-5 text-warning" />
        )}
      </span>

      <div className="space-y-1">
        {/* aria-live so the heading is announced when polling flips it, rather
            than leaving a screen reader on "Payment received" for ever. */}
        <p aria-live="polite" className="text-sm font-medium">
          {view.title}
        </p>
        <p className="text-sm text-muted-foreground">{view.body}</p>
      </div>
    </div>
  )
}

interface View {
  tone: "success" | "waiting" | "failed"
  title: string
  body: string
}

function present(result: Result | null, timedOut: boolean): View {
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
          body: "If you completed the payment, nothing is lost. We check for stragglers every half hour — email support@i10.tech if your plan has not appeared.",
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
       * ⚠ THE ONE CASE WHERE "we check every half hour" WOULD BE A LIE, AND IT
       * IS THE CASE WHERE THE MONEY HAS ALREADY GONE. The API now tries to
       * repair this itself — writing our tenant id onto Polar's customer — so
       * reaching here means that failed, or the customer carries another
       * workspace's id and must not be overwritten. Neither resolves on its own.
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
            body: "Your payment went through and nothing is lost. We check for stragglers every half hour, so your plan will appear shortly — email support@i10.tech if it has not.",
          }
        : {
            tone: "waiting",
            title: "Payment received",
            body: "Setting up your plan. This usually takes a few seconds.",
          }

    case "unpaid":
      return {
        tone: "failed",
        title:
          result.detail === "expired"
            ? "This checkout expired"
            : "Payment not completed",
        body:
          result.detail === "expired"
            ? "Nothing was charged. Start again whenever you are ready."
            : "Nothing was charged. You can try again below.",
      }

    default:
      return {
        tone: "waiting",
        title: "We could not find that checkout",
        body: "The link may be incomplete. If you have paid, your plan is safe — it will appear here.",
      }
  }
}
