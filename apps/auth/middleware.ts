import { clerkMiddleware } from "@clerk/nextjs/server"

/*
 * auth.i10.tech.
 *
 * ⚠ EVERY ROUTE HERE IS PUBLIC, AND THAT IS THE POINT RATHER THAN AN OVERSIGHT.
 * This app exists to be reachable by someone who is not signed in; protecting
 * any of it would be a door that locks from the outside. `clerkMiddleware` is
 * still needed - it is what puts a Clerk context on the request so the sign-in
 * and sign-up flows can run at all - but nothing calls `auth.protect()`.
 *
 * ⚠ THE KEYS ARE UNPREFIXED AND READ AT RUNTIME. Next inlines `NEXT_PUBLIC_*`
 * at BUILD time, server code included, so a prefixed key absent from the CI
 * build is compiled in as `undefined` and cannot be supplied by the pod later.
 * One image, configured per environment by Doppler, means anything the build
 * cannot see must stay unprefixed. Same reasoning as apps/console.
 */
export default clerkMiddleware({
  /**
   * ⚠ `secretKey` IS DELIBERATELY NOT PASSED, AND PASSING IT CRASHES THE APP.
   * Handing `clerkMiddleware` an explicit secret puts it in "dynamic keys"
   * mode, where the key is encrypted and propagated from the middleware to the
   * server runtime - which requires `CLERK_ENCRYPTION_KEY`. Without one it
   * throws `encryption_key_missing` on EVERY request, so the pod starts,
   * answers 500 to everything including its own probe, and never goes ready.
   * The guard is literally `if (requestData.secretKey && !ENCRYPTION_KEY)`.
   *
   * ⚠ AND IT IS NOT NEEDED, BECAUSE THE BUILD-TIME PROBLEM ABOVE IS NOT ITS
   * PROBLEM. `CLERK_SECRET_KEY` carries no `NEXT_PUBLIC_` prefix, so Next never
   * inlines it and Clerk reads it straight from runtime env by default. Only
   * the PUBLISHABLE key needs threading by hand, because Clerk's default name
   * for it is `NEXT_PUBLIC_…`, which a CI build with no Clerk environment would
   * compile in as `undefined` for good.
   */
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  /**
   * ⚠ ONLY WHEN SET, SO PRODUCTION IS EXACTLY AS BEFORE THE GATEWAY.
   * `CLERK_PROXY_URL` points the handshake at the Clerk gateway
   * (services/clerk-gateway); locally that is https://clerk.i10.localhost in
   * front of the dev instance. Production needs no value at all: the gateway
   * answers clerk.i10.tech, the very host the publishable key already names.
   */
  ...(process.env.CLERK_PROXY_URL ? { proxyUrl: process.env.CLERK_PROXY_URL } : {}),
})

/*
 * ⚠ THE SAML ROUTES AN IdP DRIVES AND `/sso/start` ARE OUTSIDE CLERK'S
 * MIDDLEWARE (#339). The ACS and SLO receive cross-site POSTs and redirects
 * from the IdP, and `/sso/start` receives the interstitial's form POST, with
 * neither needing a Clerk context; a Clerk handshake redirect there would turn
 * a POST into a GET and lose the body. `/sso/saml/logout`, `/sso/step-up` and
 * `/sso/test-run` stay inside: they read the session.
 */
export const config = {
  matcher: [
    "/((?!_next|sso/(?:start$|saml/(?:acs|slo|metadata)/)|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
}
