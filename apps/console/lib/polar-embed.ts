/**
 * Opening Polar's embedded checkout so that it can also be closed again.
 *
 * ⚠ POLAR'S OWN ✕ DOES NOT WORK, AND THAT IS MEASURED RATHER THAN ASSUMED.
 * Their hosted checkout renders a close button at `top-2 right-2` when loaded
 * with `embed=true`, and clicking it posts NOTHING to the parent window. Probed
 * against a real sandbox checkout inside a real cross-origin iframe with a
 * correct `embed_origin`: a `message` listener on the parent recorded zero
 * events, and the iframe stayed where it was. `@polar-sh/checkout` is listening
 * — `handleWindowMessage` switches on a `close` event and calls `close()` — but
 * that event never arrives. So the modal is, from the customer's side, a trap:
 * a payment form covering the whole viewport with no way out but a reload.
 *
 * ⚠ SO WE DRAW OUR OWN, ON TOP OF THEIRS. The alternative is waiting for a fix
 * in somebody else's product while our upgrade flow is a dead end. It is
 * positioned to cover Polar's dead button rather than to sit beside it, because
 * two ✕ marks eight pixels apart — one working, one not — is worse than either
 * one alone.
 *
 * ⚠ IT SHARES THE IFRAME'S z-index RATHER THAN EXCEEDING IT. The SDK uses
 * 2147483647, which is the largest value CSS accepts; nothing can be layered
 * above it by number. Equal z-index resolves in DOM order, so appending after
 * the iframe is the only thing that puts this in front — and it is why the
 * element is created after `create()` resolves.
 *
 * ⚠ AND IT REFUSES TO CLOSE WHILE A CHARGE IS IN FLIGHT, which is the one part
 * of Polar's behaviour that is right. They lock the modal on `confirmed` and
 * unlock on `success`; tearing the iframe out between those two would abandon a
 * payment that has already been submitted. Escape is bound for the same reason
 * and under the same rule.
 */

export interface CheckoutHandle {
  close(): void
}

export interface OpenCheckoutOptions {
  theme: "light" | "dark"
  /** Fired once Polar reports the payment succeeded. */
  onSuccess(): void
}

export async function openPolarCheckout(
  url: string,
  { theme, onSuccess }: OpenCheckoutOptions,
): Promise<CheckoutHandle> {
  const { PolarEmbedCheckout } = await import("@polar-sh/checkout/embed")
  const checkout = await PolarEmbedCheckout.create(url, { theme })

  /*
   * ⚠ EVERY TEARDOWN PATH GOES THROUGH ONE FUNCTION, AND IT IS IDEMPOTENT.
   * There are four ways out of here — our button, Escape, Polar's `success`,
   * and the caller — and three of them can happen in any order. Removing a
   * listener twice is free; leaving one attached keeps a key handler alive for
   * the rest of the session, listening for Escape over a page that no longer
   * has a modal on it.
   */
  let dismissable = true
  let done = false

  const teardown = () => {
    if (done) return
    done = true
    document.removeEventListener("keydown", onKey)
    button.remove()
  }

  const dismiss = () => {
    if (!dismissable) return
    teardown()
    checkout.close()
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") dismiss()
  }

  const button = document.createElement("button")
  button.type = "button"
  button.setAttribute("aria-label", "Close checkout")
  // ⚠ INLINE STYLES, NOT A CLASS. This element is appended to `document.body`
  // from outside React and outside the stylesheet's component layer; a utility
  // class here would depend on Tailwind having emitted it for some other call
  // site, which is exactly the kind of coupling that breaks in a production
  // build and not in development.
  button.style.cssText = [
    "position:fixed",
    "top:8px",
    "right:8px",
    "z-index:2147483647",
    "width:32px",
    "height:32px",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "border:none",
    "border-radius:9999px",
    "cursor:pointer",
    "background:rgba(0,0,0,0.55)",
    "color:#fff",
    "font:16px/1 system-ui,sans-serif",
    "padding:0",
  ].join(";")
  button.textContent = "✕"
  button.addEventListener("click", dismiss)

  checkout.addEventListener("confirmed", () => {
    dismissable = false
    button.style.display = "none"
  })

  checkout.addEventListener("success", () => {
    dismissable = true
    /*
     * ⚠ THE OVERLAY IS CLOSED HERE RATHER THAN LEFT FOR THE CUSTOMER TO
     * DISMISS. Polar's default `success` handler only re-enables closing and
     * redirects when the checkout carries a success URL, so without this the
     * modal sits over an already-upgraded console saying it is waiting for
     * confirmation — which is exactly what it did.
     */
    teardown()
    checkout.close()
    onSuccess()
  })

  // ⚠ POLAR'S OWN `close` STILL RUNS IF IT EVER STARTS WORKING. Ours would then
  // be a stray button over a removed iframe, so it cleans up on their event too.
  checkout.addEventListener("close", teardown)

  document.addEventListener("keydown", onKey)
  document.body.appendChild(button)

  return {
    close() {
      teardown()
      checkout.close()
    },
  }
}
