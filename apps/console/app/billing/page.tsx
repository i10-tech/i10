import { redirect } from "next/navigation"

/**
 * Where Polar used to return the browser, kept only to forward it.
 *
 * ⚠ THIS WAS A FULL-SCREEN DARK CONFIRMATION AND IT IS NOW A REDIRECT. The
 * page had its own visual world — hardcoded hexes, `text-white/55`, no console
 * chrome — on the reasoning that it was the last frame of Polar's checkout
 * rather than the first of the console. What that actually produced was a dead
 * end: somebody who bought a plan part-way through onboarding landed here and
 * the flow they were in the middle of was gone, with nothing on screen but
 * "back to the dashboard". The outcome is now reported by `CheckoutOutcome` on
 * whichever page started the checkout.
 *
 * ⚠ IT SURVIVES BECAUSE `POLAR_SUCCESS_URL` STILL NAMES IT, and that is
 * configuration rather than code. Any checkout begun before this shipped, and
 * any caller that does not send `return_to`, still comes back here — so this
 * forwards them, carrying the id, instead of 404ing somebody who has just paid.
 * It can be deleted once that variable points at `/settings/billing`.
 */
export const dynamic = "force-dynamic"

export default async function BillingReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout_id?: string }>
}) {
  const { checkout_id: checkoutId } = await searchParams

  redirect(
    checkoutId
      ? `/settings/billing?checkout_id=${encodeURIComponent(checkoutId)}`
      : "/settings/billing",
  )
}
