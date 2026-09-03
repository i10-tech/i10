import type { Metadata } from "next"
import { CheckoutResult } from "./checkout-result"

/*
 * Where Polar returns the browser after a checkout.
 *
 * ⚠ THE PAGE REPORTS; IT DOES NOT DECIDE. `POLAR_SUCCESS_URL` carries
 * `checkout_id={CHECKOUT_ID}`, which Polar substitutes at redirect time, and
 * that id is the only thing this page is trusted with. It is not evidence of
 * payment — it is a lookup key. The verdict comes from `core.subscriptions`,
 * which nothing but the signature-verified webhook can move.
 *
 * ⚠ ITS OWN VISUAL WORLD, ON PURPOSE. The console is a light shadcn surface;
 * this is a dark one, because it is the last frame of Polar's checkout rather
 * than the first of the console, and a customer should not feel handed between
 * two products mid-transaction. It is also the one page here seen exactly once.
 */

export const metadata: Metadata = {
  title: "Your subscription · i10",
}

/**
 * ⚠ NEVER PRERENDERED. The answer depends on a row that changes seconds after
 * the redirect; a static shell served from the edge would show a stale verdict.
 */
export const dynamic = "force-dynamic"

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout_id?: string }>
}) {
  const { checkout_id: checkoutId } = await searchParams

  return (
    // Polar's checkout ground, so the redirect does not flash white between two
    // dark pages. `text-white` is set here rather than on <body> so the rest of
    // the console keeps its own tokens.
    <div className="min-h-dvh bg-[#0a0a0c] text-white">
      <CheckoutResult checkoutId={checkoutId ?? null} />
    </div>
  )
}
