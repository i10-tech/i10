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

/**
 * ⚠ PREVIEW MODE BYPASSES THE GUARD, AND IT CANNOT BE REACHED IN PRODUCTION.
 * `process.env.NODE_ENV` is replaced with the literal `"production"` at build
 * time, so in a production build this folds to `false` and the branch below is
 * removed by the bundler. There is no variable anybody can set in a pod to turn
 * it on. See lib/preview.ts for the full reasoning.
 *
 * ⚠ IT IS HERE AT ALL BECAUSE `clerkMiddleware` THROWS WITHOUT A PUBLISHABLE
 * KEY, so a preview run with no Clerk instance would 500 on every request
 * before reaching a page. Reviewing the interface must not require provisioning
 * an identity provider.
 */
const PREVIEW =
  process.env.NODE_ENV !== "production" && process.env.CONSOLE_PREVIEW === "1"

/**
 * ⚠ IN PREVIEW MODE `clerkMiddleware` IS NEVER CONSTRUCTED, NOT MERELY SHORT-
 * CIRCUITED INSIDE. Clerk throws "Missing publishableKey" from the middleware
 * itself, before the handler body runs — so an early `return` inside the
 * callback was not enough and every request 500'd. A ternary only evaluates the
 * branch it takes, so with no Clerk instance the factory is never called at
 * all.
 *
 * ⚠ AND THE FALLBACK RETURNS `undefined`, WHICH MEANS "CONTINUE". It is not a
 * permissive auth decision — there is no auth to decide. In a production build
 * `PREVIEW` folds to `false` and this whole branch is removed by the bundler.
 */
export default PREVIEW
  ? function previewMiddleware() {
      return undefined
    }
  : clerkMiddleware(
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
   *
   * ⚠ THE `$` ON THE EXTENSION GROUP IS LOAD-BEARING, AND CLERK'S PUBLISHED
   * MATCHER DOES NOT HAVE IT. Without the anchor, `[^?]*\.(?:css|png|…)` matches
   * a PREFIX of the path rather than the whole of it, so the negative lookahead
   * is satisfied by anything that merely CONTAINS an asset-looking segment and
   * the middleware never runs. Tested against both forms:
   *
   *     /logo.png/settings    before: skipped    after: protected
   *     /a.css/api-keys       before: skipped    after: protected
   *     /logo.png             before: skipped    after: skipped
   *     /_next/static/x.js    before: skipped    after: skipped
   *     /data.json            before: protected  after: protected
   *
   * ⚠ IT IS DEFENCE IN DEPTH RATHER THAN A LIVE HOLE TODAY, AND IT IS WORTH
   * HAVING ANYWAY. Neither bypass path currently resolves to a page — the App
   * Router has no route shaped like `/domains/[id]/[rest]` — so today they 404
   * before reaching anything. That is a property of the current route tree, not
   * of this regex: the first catch-all segment anybody adds turns it into an
   * unauthenticated page, and nothing about adding one would suggest checking
   * here. The extension has to be at the END of the path for the request to be
   * a static asset; anything after it is a route wearing an asset's name.
   */
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)$).*)",
    "/(api|trpc)(.*)",
  ],
}
