"use client"

import Link from "next/link"
import { useEffect, useState } from "react"

/*
 * ⚠ THIS COMPONENT CANNOT GRANT ANYTHING, AND ITS EXISTENCE IS THE REASON IT
 * MUST NOT LOOK AS THOUGH IT COULD. Polar's success redirect is a browser
 * navigation — anybody can type this URL — so nothing on screen may be decided
 * by having arrived here. Every state below comes from the API reading
 * `core.subscriptions`, a row only the signature-verified Polar webhook moves.
 * See the note at the top of apps/api/src/billing/grants.ts.
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

/** ⚠ A REAL CHECK, NOT A CAST. See the poll: the cast is what broke this page. */
const isStatus = (value: unknown): value is Status =>
  typeof value === "string" && (STATUSES as readonly string[]).includes(value)

export function CheckoutResult({ checkoutId }: { checkoutId: string | null }) {
  const [result, setResult] = useState<Result | null>(
    checkoutId ? null : { status: "unknown", plan: null },
  )
  const [timedOut, setTimedOut] = useState(false)

  useEffect(() => {
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
         * `status` field at all. That used to be cast to `Result`, stored, and
         * then compared: `undefined` is neither `paid` nor `unavailable`, so
         * the poll STOPPED, having just written a result that `present` renders
         * as "We could not find that checkout" — to somebody who had paid.
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
         * ⚠ EXCEPT THE ONE `paid` THAT IS ALSO SETTLED. `unattributed` means
         * the API has already established that nothing will ever grant this —
         * Polar's customer record does not carry our tenant id, so the webhook
         * and the reconciler both discard its events by the same rule. Polling
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

  const view = present(result, timedOut)

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-7 px-6 py-16 text-center">
      <span
        aria-hidden
        className="flex size-24 items-center justify-center rounded-full"
        style={{ backgroundColor: view.halo }}
      >
        <span
          className="flex size-16 items-center justify-center rounded-full"
          style={{ backgroundColor: view.circle }}
        >
          <Glyph kind={view.glyph} />
        </span>
      </span>

      <div className="flex max-w-sm flex-col gap-2">
        {/* aria-live so the heading is announced when polling flips it, rather
            than leaving a screen reader on "Payment received" forever. */}
        <h1 aria-live="polite" className="text-[1.75rem] leading-tight font-semibold">
          {view.title}
        </h1>
        <p className="text-[0.9375rem] leading-relaxed text-white/55">{view.body}</p>
      </div>

      <Link
        href="/"
        className="rounded-lg bg-white/10 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none"
      >
        Back to the dashboard
      </Link>
    </main>
  )
}

/*
 * ⚠ SEMANTIC STATUS COLOURS, NOT A BRAND ACCENT. packages/ui/src/styles
 * /tokens.css says plainly that `--brand` is unset and must not be invented
 * here, and this does not invent one: green/amber/red mean succeeded, waiting
 * and failed, and mean it on every product that has ever shown this page. They
 * are local rather than tokens because there is no success/warning token yet —
 * when one lands, this is the call site to delete.
 */
const GREEN = "#00d47e"
const AMBER = "#f5a524"
const RED = "#f4364c"
const GREY = "#8b8b93"

/** `rgb(... / 0.14)` haloes, so each circle sits in its own colour. */
const halo = (hex: string) => `${hex}24`

interface View {
  glyph: "check" | "clock" | "cross" | "question"
  circle: string
  halo: string
  title: string
  body: string
}

function present(result: Result | null, timedOut: boolean): View {
  if (!result) {
    /*
     * ⚠ `timedOut` IS CHECKED HERE TOO, AND ITS ABSENCE WAS THE STUCK SPINNER.
     * This branch used to return "Checking your payment / One moment"
     * unconditionally, so a status endpoint that never answered usefully left
     * that on screen FOR EVER — the ceiling below it had already fired and had
     * nowhere to show itself, because `result` was still null. Somebody who had
     * just paid watched a spinner until they gave up and reloaded.
     */
    return timedOut
      ? {
          glyph: "clock",
          circle: AMBER,
          halo: halo(AMBER),
          title: "This is taking longer than usual",
          body: "If you completed the payment, nothing is lost — open the dashboard to see your plan. We also check for stragglers every half hour. Email support@i10.tech if it has not appeared.",
        }
      : {
          glyph: "clock",
          circle: AMBER,
          halo: halo(AMBER),
          title: "Checking your payment",
          body: "One moment.",
        }
  }

  switch (result.status) {
    case "granted":
      return {
        glyph: "check",
        circle: GREEN,
        halo: halo(GREEN),
        // ⚠ THE PLAN THEY ACTUALLY BOUGHT, NOT THE WORD "Pro". This was
        // hardcoded, so every future plan — and every bespoke one — congratulated
        // the customer on a subscription they had not purchased. The API already
        // returns the name; `plan` is null only when the grant landed without
        // one, where a generic sentence is the honest fallback.
        title: result.plan ? `You're on ${result.plan}` : "You're all set",
        body: "Thank you — your subscription is active and your new sending allowance is available right away.",
      }

    case "paid":
    case "unavailable":
      /*
       * ⚠ THE ONE CASE WHERE "we check every half hour" WOULD BE A LIE, AND
       * IT IS THE CASE WHERE THE MONEY HAS ALREADY GONE. The reconciler repairs
       * a lost webhook by re-reading Polar — but it attributes subscriptions by
       * `customer.external_id` exactly as the webhook does, so a customer
       * record without ours is invisible to both, permanently. Telling somebody
       * to wait is telling them to wait for something that is not coming.
       */
      if (result.detail === "unattributed") {
        return {
          glyph: "cross",
          circle: RED,
          halo: halo(RED),
          title: "We could not match this payment",
          body: "Your payment went through and you have not lost it — we just cannot tie it to this workspace automatically. Email support@i10.tech and we will put your plan on straight away.",
        }
      }

      return timedOut
        ? {
            glyph: "clock",
            circle: AMBER,
            halo: halo(AMBER),
            title: "This is taking longer than usual",
            body: "Your payment went through and nothing is lost. We check for stragglers every half hour, so your plan will appear shortly — email support@i10.tech if it has not.",
          }
        : {
            glyph: "clock",
            circle: AMBER,
            halo: halo(AMBER),
            title: "Payment received",
            body: "Setting up your plan. This usually takes a few seconds.",
          }

    case "unpaid":
      return {
        glyph: "cross",
        circle: RED,
        halo: halo(RED),
        title:
          result.detail === "expired"
            ? "This checkout expired"
            : "Payment not completed",
        body:
          result.detail === "expired"
            ? "Nothing was charged. Start again from the dashboard when you are ready."
            : "Nothing was charged. You can try again from the dashboard.",
      }

    default:
      return {
        glyph: "question",
        circle: GREY,
        halo: halo(GREY),
        title: "We could not find that checkout",
        body: "The link may be incomplete. If you have paid, your plan is safe — open the dashboard to see it.",
      }
  }
}

function Glyph({ kind }: { kind: View["glyph"] }) {
  const common = {
    width: 30,
    height: 30,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "#0a0a0c",
    strokeWidth: 2.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  }

  if (kind === "check") {
    return (
      <svg {...common}>
        <path d="M20 6 9 17l-5-5" />
      </svg>
    )
  }
  if (kind === "cross") {
    return (
      <svg {...common}>
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    )
  }
  if (kind === "question") {
    return (
      <svg {...common}>
        <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
        <path d="M12 17h.01" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}
