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
  /** Fired once the payment is known to have succeeded, however we learn it. */
  onSuccess(): void
  /**
   * Polar's checkout id, for the status poll that backstops their event.
   *
   * ⚠ OPTIONAL SO AN OLDER API BUILD STILL WORKS. Without it the modal depends
   * entirely on Polar posting `success`, which is the behaviour that failed.
   */
  checkoutId?: string | null
}

/**
 * ⚠ THE POLL EXISTS BECAUSE POLAR'S `success` EVENT DOES NOT ALWAYS ARRIVE,
 * AND THAT IS MEASURED RATHER THAN DEFENSIVE. On 2026-09-18 a real checkout on
 * dash.i10.tech completed — Polar's own API reported `status: "succeeded"` with
 * a customer attached, and the plan was granted — while the browser recorded
 * ZERO messages from any polar.sh origin. Their page had answered
 * `PATCH /v1/checkouts/client/… 403` after Stripe confirmed, and its state
 * machine stopped at "waiting for confirmation" without ever posting to us.
 *
 * The customer is left looking at a payment form for a payment that already
 * went through, and the only way out is a reload. So the event is now the FAST
 * path rather than the only one: `/api/checkout-status/{id}` reads the row our
 * own webhook writes, and whichever answers first closes the modal.
 *
 * ⚠ AND IT IS BOUNDED. A checkout somebody abandons would otherwise poll for
 * as long as the tab is open; five minutes is longer than any card takes and
 * short enough that a forgotten tab is not making a request every two seconds
 * until it is closed.
 */
const POLL_EVERY_MS = 2_000
const POLL_FOR_MS = 5 * 60_000

export async function openPolarCheckout(
  url: string,
  { theme, onSuccess, checkoutId }: OpenCheckoutOptions,
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
  let poll: ReturnType<typeof setInterval> | undefined

  const teardown = () => {
    if (done) return
    done = true
    if (poll) clearInterval(poll)
    document.removeEventListener("keydown", onKey)
    button.remove()
  }

  /**
   * One way out, whether Polar told us or we found out ourselves.
   *
   * ⚠ IDEMPOTENT, BECAUSE BOTH PATHS CAN FIRE. If the event arrives and the
   * poll also comes back `paid`, `onSuccess` would otherwise run twice — two
   * toasts and two router refreshes for one payment. `teardown` already guards
   * on `done`; this reads the same flag before doing anything else.
   */
  const succeed = () => {
    if (done) return
    dismissable = true
    teardown()
    checkout.close()
    onSuccess()
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

  /*
   * ⚠ THE OVERLAY IS CLOSED HERE RATHER THAN LEFT FOR THE CUSTOMER TO DISMISS.
   * Polar's default `success` handler only re-enables closing and redirects
   * when the checkout carries a success URL, so without this the modal sits
   * over an already-upgraded console saying it is waiting for confirmation —
   * which is exactly what it did.
   */
  checkout.addEventListener("success", succeed)

  // ⚠ POLAR'S OWN `close` STILL RUNS IF IT EVER STARTS WORKING. Ours would then
  // be a stray button over a removed iframe, so it cleans up on their event too.
  checkout.addEventListener("close", teardown)

  document.addEventListener("keydown", onKey)
  document.body.appendChild(button)

  if (checkoutId) {
    const startedAt = Date.now()

    poll = setInterval(() => {
      if (Date.now() - startedAt > POLL_FOR_MS) {
        if (poll) clearInterval(poll)
        return
      }

      void fetch(`/api/checkout-status/${encodeURIComponent(checkoutId)}`, {
        cache: "no-store",
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { status?: string } | null) => {
          // ⚠ BOTH WORDS MEAN THE MONEY LANDED. `paid` is the checkout having
          // succeeded; `granted` is that plus the entitlement being live. The
          // modal has no business staying open for either — the difference
          // belongs to the page underneath, which says "allowances appear as
          // soon as it clears".
          if (body?.status === "paid" || body?.status === "granted") succeed()
        })
        // ⚠ A FAILED POLL IS NOT A FAILED PAYMENT. The API being briefly
        // unreachable says nothing; keep asking until the window closes.
        .catch(() => {})
    }, POLL_EVERY_MS)
  }

  return {
    close() {
      teardown()
      checkout.close()
    },
  }
}
