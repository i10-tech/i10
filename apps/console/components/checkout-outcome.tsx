"use client"

import * as React from "react"
import { Reveal } from "@repo/ui/components/reveal"
import { useRouter } from "next/navigation"
import { CheckCircle2, Clock, XCircle } from "lucide-react"
import { cn } from "cn"
import { Spinner } from "@repo/ui/components/spinner"
import { isStatus, keepPolling, present, type Result } from "@/lib/checkout-outcome"

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

/**
 * ⚠ THE CEILING IS WHAT KEEPS THIS HONEST. Polling forever would leave a
 * spinner on screen for a customer whose grant genuinely failed, and a spinner
 * is a promise that something is still happening. After this we stop and say
 * plainly that it is taking longer than expected.
 *
 * ⚠ AND REACHING IT IS NOW RARE RATHER THAN ROUTINE. The status endpoint used
 * to only report, so a lost webhook meant ninety seconds of spinner followed by
 * "we check for stragglers every half hour" — the reconciler's schedule, shown
 * to a customer who had just paid. It now grants from Polar's own answer inside
 * the poll that notices, so getting here means Polar itself could not be
 * reached or could not be acted on, which is worth saying differently.
 */
const POLL_MS = 2000
const GIVE_UP_MS = 90_000

export function CheckoutOutcome({
  checkoutId,
  className,
}: {
  /** From `?checkout_id=`. Nothing renders without one. */
  checkoutId: string | null
  className?: string
}) {
  const router = useRouter()
  const [result, setResult] = React.useState<Result | null>(null)
  const [timedOut, setTimedOut] = React.useState(false)

  /*
   * ⚠ THE PAGE AROUND THIS BANNER IS OLDER THAN THE BANNER, AND ONLY THE BANNER
   * KNOWS IT. Everything below is server-rendered from `/console/me`, fetched
   * at the moment the browser arrived — which is a second BEFORE the grant
   * lands, because the grant is what this component is here to wait for. So the
   * banner said "You're on Pro" while the plan step under it still read "You
   * are on Free" and the free card still said "Current", for somebody who had
   * just paid. Reported from production 2026-09-20.
   *
   * ⚠ A SOFT REFRESH, WHICH IS WHY IT IS SAFE HERE. `router.refresh()` re-runs
   * the server components and reconciles; it does NOT remount the client tree,
   * so onboarding keeps the step it is on. A hard navigation would throw
   * somebody back to whatever step the facts imply — which is the dead end this
   * whole flow was rebuilt to remove.
   *
   * ⚠ AND ONLY ON `granted`, BECAUSE THAT IS THE ONLY OUTCOME THAT MOVES THE
   * DATA. `paid` is still in flight, and a refresh per poll would re-render the
   * page every two seconds under somebody reading it. The effect keys on the
   * status, so it fires once when it flips and never again.
   */
  React.useEffect(() => {
    if (result?.status !== "granted") return

    /*
     * ⚠ NOT WHEN THE CARDS HAVE ALREADY APPLIED IT THEMSELVES. A checkout
     * completed in the embed hands `PlanCards` the plan that was bought, and
     * it updates in place — so this refresh had nothing left to correct and
     * everything to spoil: it fired a second after the modal closed, blanked
     * and re-rendered the tree under a toast about the payment, and undid the
     * point of applying it locally. `reportOutcome` marks the URL when it has
     * done that.
     *
     * ⚠ AND IT STILL RUNS ON THE REDIRECT RETURN, WHICH IS THE CASE IT WAS
     * WRITTEN FOR. Coming back from Polar's own page is a fresh load: no
     * component saw the success, the server render is a second older than
     * the grant, and without this the banner says "You're on Pro" over a card
     * that still says "Upgrade". Reported from production 2026-09-20.
     */
    if (window.location.search.includes("applied=1")) return

    router.refresh()
  }, [result?.status, router])

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

        const next: Result = {
          status: body.status,
          plan: body.plan ?? null,
          ...(body.detail ? { detail: body.detail } : {}),
        }
        setResult(next)

        // ⚠ THE RULE LIVES IN `keepPolling`, WHERE IT CAN BE ASSERTED. Three
        // states are not endings and missing any of them freezes the page on
        // the wrong sentence — see lib/checkout-outcome.ts.
        if (!keepPolling(next)) return
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

  /*
   * ⚠ NOTHING IS SHOWN WHILE THE ANSWER IS STILL BEING FETCHED, AND THAT IS A
   * DELIBERATE REVERSAL. This used to render an amber "Checking your payment"
   * the instant the page loaded, which meant the ordinary happy path — pay,
   * come back, grant lands a second or two later — was a warning-coloured box
   * that turned green. Two states for one event, the first of which says
   * "something may be wrong" about something that is going fine.
   *
   * ⚠ AND THE PAGE UNDERNEATH WAS SAYING THE OPPOSITE AT THE SAME TIME. The
   * plan step is server-rendered from a `/console/me` fetched BEFORE the grant
   * landed, so for those seconds the screen held an amber "checking" banner
   * above a card marked "Current: Free" for somebody who had just paid for Pro.
   * Waiting quietly and then saying one thing once is the honest version.
   *
   * ⚠ THE TIMEOUT STILL SPEAKS, BECAUSE SILENCE IS ONLY HONEST WHILE SOMETHING
   * IS ACTUALLY HAPPENING. Once the ceiling fires there is nothing in flight,
   * and a customer who paid needs to be told that rather than shown nothing.
   */
  /*
   * ⚠ REVEALED RATHER THAN INSERTED, BECAUSE THIS BANNER ARRIVES LATE BY
   * DESIGN. It is not rendered until the poll answers, so it appears a second
   * or two after the checkout closes and shoves the whole page down in one
   * frame — under somebody who is at that moment reading a toast about the
   * payment they just made. Growing into place on the same spring the rest of
   * the console uses turns a jump into the page making room.
   *
   * ⚠ AND IT IS `show`, NOT AN EARLY RETURN, so the exit animates too: the
   * banner that says "waiting" collapses rather than vanishing when the
   * answer lands and replaces it.
   */
  const visible = !(view.tone === "waiting" && !timedOut)

  return (
    <Reveal show={visible} spacing="pb-6">
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
    </Reveal>
  )
}
