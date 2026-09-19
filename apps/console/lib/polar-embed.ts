/**
 * Opening Polar's embedded checkout so that it can also be closed again.
 *
 * ⚠ EVERY MESSAGE THEIR CHECKOUT SENDS IS GATED ON `embed_origin`, AND WE WERE
 * NOT SETTING IT. That one missing field on the Checkout Session is the whole
 * of what looked like three separate bugs in somebody else's product. From
 * their own page's source:
 *
 *   // CheckoutEmbedClose.tsx        // CheckoutEmbedLoaded.tsx
 *   if (!checkout.embed_origin) {    if (!embedOrigin) {
 *     return                           return
 *   }                                }
 *
 * `confirmed` and `success` carry the identical guard. So their ✕ was not
 * broken, it was returning early; the `success` event did not go missing, it
 * was never sent; and `PolarEmbedCheckout.create()` — which resolves only when
 * the `loaded` message arrives — never resolved at all. That last one is why
 * the modal was a trap rather than merely a nuisance: everything this module
 * does ran AFTER that `await`, so the close button was never drawn, Escape was
 * never bound, and the status poll never started. A payment form covering the
 * whole viewport with nothing listening behind it. The field is now sent — see
 * `embed_origin` in apps/api/src/billing/polar.ts.
 *
 * ⚠ AND NOTHING HERE WAITS FOR THEM ANY MORE, WHICH IS THE PART THAT SURVIVES
 * THE NEXT REGRESSION. Escape and the status poll are live before the iframe is
 * asked to announce itself, so a checkout that never says `loaded` — a future
 * change on their side, an origin that stops matching, a blocked third-party
 * frame — is a modal somebody can still close and a payment we still notice.
 * Correct configuration should not be what stands between a customer and the
 * Escape key.
 *
 * ⚠ THE ✕ IS THE HALF THAT HAD TO BECOME CONDITIONAL, BECAUSE THE FIX WORKED.
 * With `embed_origin` sent, Polar's page renders its own close button and
 * announces itself — so an unconditional one of ours is simply a second ✕ in
 * the same corner of somebody's payment form. It is now built up front and
 * shown only if `loaded` has not arrived; see `THEIRS_SHOULD_HAVE_LOADED_MS`.
 * The recovery is kept, the duplicate is not.
 *
 * ⚠ IT SHARES THE IFRAME'S z-index RATHER THAN EXCEEDING IT. The SDK uses
 * 2147483647, which is the largest value CSS accepts; nothing can be layered
 * above it by number. Equal z-index resolves in DOM order, so appending after
 * the iframe is the only thing that puts our button in front.
 *
 * ⚠ AND IT REFUSES TO CLOSE WHILE A CHARGE IS IN FLIGHT, which is the one part
 * of Polar's behaviour that was always right. They lock the modal on
 * `confirmed` and unlock on `success`; tearing the iframe out between those two
 * would abandon a payment that has already been submitted. Escape is bound for
 * the same reason and under the same rule.
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
 * ⚠ THE POLL IS NO LONGER THE ONLY THING STANDING BETWEEN A CUSTOMER AND A
 * DEAD MODAL, BUT IT IS STILL WORTH KEEPING. Polar's page waits for actual
 * fulfilment before posting `success` — `listenFulfillment` in their
 * `useCheckoutConfirmedRedirect` — and on timeout it deliberately posts
 * NOTHING and navigates its own iframe to a confirmation page instead. That is
 * a correct decision on their side and an invisible one on ours, so
 * `/api/checkout-status/{id}` reads the row our own webhook writes and
 * whichever answers first closes the modal.
 *
 * ⚠ AND IT IS BOUNDED. A checkout somebody abandons would otherwise poll for
 * as long as the tab is open; five minutes is longer than any card takes and
 * short enough that a forgotten tab is not making a request every two seconds
 * until it is closed.
 */
const POLL_EVERY_MS = 2_000
const POLL_FOR_MS = 5 * 60_000

/** How long to let Polar's own close button turn up before drawing one. */
const THEIRS_SHOULD_HAVE_LOADED_MS = 6_000

export async function openPolarCheckout(
  url: string,
  { theme, onSuccess, checkoutId }: OpenCheckoutOptions,
): Promise<CheckoutHandle> {
  const { PolarEmbedCheckout } = await import("@polar-sh/checkout/embed")

  /*
   * ⚠ STARTED, NOT AWAITED. `create()` appends the iframe synchronously and
   * returns a promise that settles on their `loaded` message — so the frame is
   * on screen either way, and awaiting it here is what used to make every
   * escape route conditional on their page being correctly configured.
   */
  const opening = PolarEmbedCheckout.create(url, { theme })

  /*
   * ⚠ EVERY TEARDOWN PATH GOES THROUGH ONE FUNCTION, AND IT IS IDEMPOTENT.
   * There are four ways out of here — our button, Escape, Polar's `success`,
   * and the caller — and three of them can happen in any order. Removing a
   * listener twice is free; leaving one attached keeps a key handler alive for
   * the rest of the session, listening for Escape over a page that no longer
   * has a modal on it.
   */
  let checkout: Awaited<typeof opening> | null = null
  let dismissable = true
  let done = false
  let poll: ReturnType<typeof setInterval> | undefined
  let reveal: ReturnType<typeof setTimeout> | undefined

  /**
   * Stop waiting to find out whether Polar drew its own close button.
   *
   * ⚠ IT FORGETS THE HANDLE AS WELL AS CLEARING IT, because both ways out of
   * the wait can happen and either can happen first: `loaded` arrives, or the
   * modal is closed before it does. A cleared-but-remembered timer is a handle
   * that reads as live.
   */
  const stopWaiting = () => {
    if (!reveal) return
    clearTimeout(reveal)
    reveal = undefined
  }

  const teardown = () => {
    if (done) return
    done = true
    if (poll) clearInterval(poll)
    stopWaiting()
    document.removeEventListener("keydown", onKey)
    button.remove()
  }

  /**
   * Take the frame off the screen, with or without their instance.
   *
   * ⚠ THE FALLBACK REACHES INTO THEIR DOM, AND IT IS THE POINT OF THIS MODULE.
   * `close()` lives on the instance we only get once `loaded` arrives; if that
   * message never comes, the alternative to removing the iframe by hand is
   * telling somebody to reload the page mid-checkout. It matches on the
   * checkout's own origin rather than on a class, because the SDK gives the
   * iframe no class and the origin is a fact we already hold.
   */
  const remove = () => {
    if (checkout) {
      checkout.close()
      return
    }

    const origin = new URL(url).origin
    for (const frame of document.querySelectorAll("iframe")) {
      if (frame.src.startsWith(origin)) frame.remove()
    }
    // Their loader is an unclassed wrapper around a classed spinner.
    document.querySelector(".polar-loader-spinner")?.parentElement?.remove()
    document.body.classList.remove("polar-no-scroll")
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
    remove()
    onSuccess()
  }

  const dismiss = () => {
    if (!dismissable) return
    teardown()
    remove()
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

  document.addEventListener("keydown", onKey)

  /*
   * ⚠ IT IS BUILT NOW AND SHOWN ONLY IF THEIRS NEVER ARRIVES, WHICH IS THE
   * WHOLE OF THE DIFFERENCE BETWEEN THIS AND TWO CLOSE BUTTONS. Polar draws its
   * own ✕ inside the checkout page, so it exists from the moment that page
   * renders — and `loaded` is the page announcing exactly that. Ours was
   * appended unconditionally while `embed_origin` was missing and `loaded`
   * therefore never came; now that the field is sent, both appear and the
   * modal has two identical buttons in the same corner.
   *
   * ⚠ SO THE ESCAPE HATCH STAYS, AND ONLY THE DUPLICATE GOES. A checkout
   * that never says `loaded` — a blocked third-party frame, an origin that
   * stops matching, the next regression on their side — is still a payment form
   * covering the viewport, and the reason this module exists is that there was
   * no way out of one. Deleting the button because it is currently redundant
   * would delete the recovery along with it.
   *
   * ⚠ THE DELAY IS A CEILING ON A LOAD, NOT A GUESS AT ONE. Before the page
   * renders there is nothing to duplicate — their ✕ is not there either — so
   * showing ours early on a slow connection costs nothing and is removed the
   * moment `loaded` lands. Escape is bound throughout and never duplicates
   * anything.
   */
  reveal = setTimeout(() => {
    if (!done && !checkout) document.body.appendChild(button)
  }, THEIRS_SHOULD_HAVE_LOADED_MS)

  /*
   * ⚠ THEIR EVENTS ARE WIRED WHEN THE INSTANCE ARRIVES, AND EVERYTHING ABOVE
   * WORKS WITHOUT IT. `loaded` always precedes `confirmed` and `success`, so
   * nothing can be missed by attaching here — and if it never arrives, the
   * button, the key handler and the poll are already live.
   *
   * ⚠ AND THE REJECTION IS SWALLOWED DELIBERATELY. `create()` does not reject
   * today; an unhandled one from a future version would surface in the console
   * as a page error over a working checkout.
   */
  void opening
    .then((instance) => {
      checkout = instance

      // Their page has rendered, so their own ✕ is on screen. See the note on
      // `reveal` above: ours exists for the case where this never happens.
      stopWaiting()
      button.remove()

      if (done) {
        // Closed before it finished loading. Their `close()` also removes the
        // window message listener, which our by-hand teardown cannot.
        instance.close()
        return
      }

      instance.addEventListener("confirmed", () => {
        dismissable = false
        button.style.display = "none"
      })

      /*
       * ⚠ THE OVERLAY IS CLOSED HERE RATHER THAN LEFT FOR THE CUSTOMER TO
       * DISMISS. Polar's default `success` handler only re-enables closing and
       * redirects when the checkout carries an EXTERNAL success URL, so
       * without this the modal sits over an already-upgraded console.
       *
       * ⚠ OURS IS EXTERNAL, SO THEIR DEFAULT ALSO NAVIGATES THE PARENT to
       * `/billing?checkout_id=…` — the confirmation page, which polls the same
       * row with a ceiling and names the plan. We do not `preventDefault()`
       * that: landing there is the better ending, and `onSuccess` covers the
       * case where the poll got there first and the navigation never happens.
       */
      instance.addEventListener("success", succeed)

      // Their own `close` is real again now that `embed_origin` is sent, so
      // ours would otherwise be a stray button over a removed iframe.
      instance.addEventListener("close", teardown)
    })
    .catch(() => {})

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
      remove()
    },
  }
}
