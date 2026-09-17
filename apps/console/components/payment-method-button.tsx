"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { CreditCard } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import { Spinner } from "@repo/ui/components/spinner"
import { paymentMethodSession } from "@/lib/actions"

/**
 * Adding or replacing the card on file.
 *
 * ⚠ THE FIELDS ARE POLAR'S, IN POLAR'S IFRAME, ON POLAR'S ORIGIN — and that is
 * the entire reason this is an embed rather than a form. A card number typed
 * into a field this application rendered would put i10 in scope for the long
 * version of the PCI questionnaire, and would mean a single XSS anywhere in the
 * console could read a card. Nothing here ever touches the digits; the only
 * thing that crosses this boundary is a session token in and a payment-method
 * id out.
 *
 * ⚠ THE TOKEN IS FETCHED ON CLICK, NOT RENDERED INTO THE PAGE. It authorises one
 * customer's portal for an hour. Minting it during server render would put it in
 * the HTML of every billing page view, including the ones where nobody ever
 * presses this — see `paymentMethodSession`.
 *
 * ⚠ AND THE FAILURE PATH IS A TOAST, NOT A BROKEN MODAL. Polar's script is
 * loaded on demand; a blocked CDN, an expired token or an outage all end here
 * rather than as an empty rectangle over the page, which is what an embed
 * failing silently looks like.
 *
 * ⚠ IT IS NOT RENDERED WITHOUT A SUBSCRIPTION, AND THAT IS A REAL CONSTRAINT
 * RATHER THAN A TIDINESS RULE. Polar creates the customer at the FIRST
 * CHECKOUT, not at our sign-up, so `POST /v1/customer-sessions` for a workspace
 * that has never subscribed answers `422 Customer does not exist` — verified
 * against the sandbox. A button that is always visible would therefore fail for
 * every free workspace, which is most of them, with an error about a customer
 * record they have never heard of. The card is collected during checkout; there
 * is nothing to manage before that.
 *
 * ⚠ AND THIS EMBED CANNOT BE EXERCISED AGAINST POLAR'S SANDBOX AT ALL. Read the
 * SDK: it resolves the iframe host as `window.location.origin` when the PAGE is
 * itself served from polar.sh or sandbox.polar.sh, and otherwise hard-defaults
 * to `https://polar.sh` — production. There is no option to change it. A
 * sandbox session token framed against production answers "Session expired",
 * which is exactly what it did when tested. The checkout embed above does not
 * have this problem, because its URL comes from the checkout object and already
 * points at the right host. So this path is correct for production and
 * unverifiable before it gets there; it is the first thing to check on the
 * first real deployment. See docs/decisions/console.md §7.
 */
export function PaymentMethodButton({ hasSubscription }: { hasSubscription: boolean }) {
  const router = useRouter()
  const { resolvedTheme } = useTheme()
  const [pending, setPending] = React.useState(false)

  async function open() {
    if (pending) return
    setPending(true)

    const session = await paymentMethodSession()
    if (!session.ok) {
      setPending(false)
      toast.error("Could not open the card form", { description: session.error })
      return
    }

    try {
      const { PolarEmbedPaymentMethod } = await import("@polar-sh/checkout/payment-method")

      const embed = await PolarEmbedPaymentMethod.create({
        sessionToken: session.data.token,
        theme: resolvedTheme === "light" ? "light" : "dark",
        // ⚠ THE NEW CARD BECOMES THE DEFAULT, WHICH IS WHAT SOMEBODY ADDING ONE
        // MEANS. The common reason to be on this screen at all is that the card
        // on file is about to expire or has just been declined; adding a second
        // one that nothing charges would leave the subscription failing for the
        // same reason it was already failing.
        setAsDefault: true,
      })

      setPending(false)

      embed.addEventListener("success", () => {
        toast.success("Card saved")
        router.refresh()
      })
    } catch {
      setPending(false)
      toast.error("Could not open the card form", {
        description: "Check your connection and try again.",
      })
    }
  }

  // ⚠ RENDERED AS NOTHING, NOT AS A DISABLED BUTTON — and the early return is
  // AFTER the hooks, because React requires every hook to run on every render.
  // A greyed-out control would imply the feature is coming for this workspace;
  // the sentence beside it on the billing page says what actually applies.
  if (!hasSubscription) return null

  return (
    <Button variant="outline" size="sm" onClick={open} disabled={pending}>
      {pending ? <Spinner /> : <CreditCard />}
      Update payment method
    </Button>
  )
}
