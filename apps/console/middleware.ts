import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server"

/*
 * Signing in to dash.i10.tech.
 *
 * ⚠ THE CONSOLE HOSTS NO SIGN-IN PAGE. Clerk's Account Portal at
 * accounts.i10.tech does, and this middleware only sends people there. That is
 * the whole integration: `accounts` CNAMEs to accounts.clerk.services and
 * `clerk` to frontend-api.clerk.services, so the pages and the Frontend API are
 * both Clerk's to serve. Rendering `<SignIn />` here as well would give the
 * same instance two sign-in surfaces that can drift.
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
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
    secretKey: process.env.CLERK_SECRET_KEY,
    /**
     * ⚠ UNSET MEANS "LET CLERK DECIDE", WHICH IS RIGHT FOR EVERY INSTANCE BUT
     * PRODUCTION. A development instance has no custom Account Portal domain
     * and Clerk infers its own; production has accounts.i10.tech and is told so
     * explicitly, because inference there depends on instance configuration we
     * would rather not have silently change where our customers type passwords.
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
