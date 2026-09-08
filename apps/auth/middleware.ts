import { clerkMiddleware } from "@clerk/nextjs/server"

/*
 * auth.i10.tech.
 *
 * ⚠ EVERY ROUTE HERE IS PUBLIC, AND THAT IS THE POINT RATHER THAN AN OVERSIGHT.
 * This app exists to be reachable by someone who is not signed in; protecting
 * any of it would be a door that locks from the outside. `clerkMiddleware` is
 * still needed — it is what puts a Clerk context on the request so the sign-in
 * and sign-up flows can run at all — but nothing calls `auth.protect()`.
 *
 * ⚠ THE KEYS ARE UNPREFIXED AND READ AT RUNTIME. Next inlines `NEXT_PUBLIC_*`
 * at BUILD time, server code included, so a prefixed key absent from the CI
 * build is compiled in as `undefined` and cannot be supplied by the pod later.
 * One image, configured per environment by Doppler, means anything the build
 * cannot see must stay unprefixed. Same reasoning as apps/console.
 */
export default clerkMiddleware({
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  secretKey: process.env.CLERK_SECRET_KEY,
})

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
}
