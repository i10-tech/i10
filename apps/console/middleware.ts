import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server"

/*
 * Signing in to dash.i10.tech.
 *
 * ⚠ THE CONSOLE HOSTS NO SIGN-IN PAGE. `apps/auth`, served at auth.i10.tech,
 * does — custom flows on Clerk's SDK rather than Clerk's hosted Account Portal.
 * This middleware only sends people there. Rendering a sign-in form here as
 * well would give one Clerk instance two sign-in surfaces that can drift, and
 * would put the "set your password" step inside the app that shows a tenant's
 * billing — which the invited mailbox holder has no business seeing.
 *
 * ⚠ EVERY SECRET IS READ FROM RUNTIME ENV AND PASSED EXPLICITLY, and the names
 * deliberately have NO `NEXT_PUBLIC_` PREFIX. Next replaces `NEXT_PUBLIC_*`
 * textually at BUILD time — even in server code — so a prefixed variable that
 * is absent when `docker build` runs is compiled in as `undefined` and no
 * amount of setting it in the pod will bring it back. The image is built once
 * in CI and configured per environment by Doppler, so anything the build cannot
 * see must stay unprefixed and be read at request time.
 */

/**
 * ⚠ `/billing` IS POLAR'S RETURN URL AND MUST NOT REQUIRE A SESSION. It is the
 * last frame of a checkout: the customer has just paid, and if their session
 * lapsed while they were on Polar's site, gating it would answer their payment
 * with a login wall. It is safe to leave open because the page decides nothing
 * — it renders a verdict read from `core.subscriptions`, which only the
 * signature-verified webhook can move, and the `checkout_id` it carries is a
 * lookup key rather than evidence of anything.
 *
 * ⚠ AND ITS PROXY ROUTE GOES WITH IT. `/api/checkout-status/*` is deliberately
 * unauthenticated upstream — see the route's own note on why it attaches no
 * credential — so protecting the page's data source while leaving the page open
 * would just make the page permanently say "still setting up".
 */
/**
 * ⚠ `/healthz` IS PUBLIC SO KUBELET NEVER NEEDS CLERK. See the route itself:
 * a probe that authenticates makes a Clerk outage look like a dead pod, and
 * kubelet answers that by restarting every replica.
 */
const isPublic = createRouteMatcher([
  "/healthz",
  "/billing(.*)",
  "/api/checkout-status(.*)",
])

export default clerkMiddleware(
  async (auth, request) => {
    if (isPublic(request)) return

    // Everything else. ⚠ A DENY-BY-DEFAULT LIST, NOT AN ALLOW ONE: a page added
    // to the console tomorrow is protected because nobody remembered to protect
    // it, which is the only version of this that stays correct.
    await auth.protect()
  },
  {
    /**
     * ⚠ `secretKey` IS DELIBERATELY NOT PASSED, AND PASSING IT CRASHES THE APP.
     * Handing `clerkMiddleware` an explicit secret puts it in "dynamic keys"
     * mode, where the key is encrypted and propagated from the middleware to
     * the server runtime — which requires `CLERK_ENCRYPTION_KEY`. Without one
     * it throws `encryption_key_missing` on EVERY request, so the pod starts,
     * answers 500 to everything including its own probe, and never goes ready.
     * The guard is literally `if (requestData.secretKey && !ENCRYPTION_KEY)`.
     *
     * ⚠ AND IT IS NOT NEEDED, BECAUSE THE BUILD-TIME PROBLEM BELOW IS NOT ITS
     * PROBLEM. `CLERK_SECRET_KEY` carries no `NEXT_PUBLIC_` prefix, so Next
     * never inlines it and Clerk reads it straight from runtime env by default.
     * Only the PUBLISHABLE key needs threading by hand, because Clerk's default
     * name for it is `NEXT_PUBLIC_…`, which a CI build with no Clerk
     * environment would compile in as `undefined` for good.
     */
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
    /**
     * ⚠ THESE MUST BE SET IN PRODUCTION, and pointed at auth.i10.tech. Left
     * unset, Clerk falls back to inferring its own hosted Account Portal — so
     * forgetting them does not fail loudly, it quietly sends customers to a
     * sign-in page we did not build and cannot change. Clerk appends
     * `?redirect_url=` when it bounces someone, which apps/auth validates
     * against an allowlist before honouring.
     */
    signInUrl: process.env.CLERK_SIGN_IN_URL,
    signUpUrl: process.env.CLERK_SIGN_UP_URL,
  },
)

export const config = {
  /**
   * Clerk's own matcher: everything except Next's internals and static files,
   * plus API routes explicitly.
   *
   * ⚠ THE `js(?!on)` IS NOT A TYPO. It excludes `.js` while still matching
   * `.json`, so a route serving JSON keeps its session and a bundle does not
   * pay for one.
   */
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
}
