import type { Metadata } from "next"
import { ClerkProvider } from "@clerk/nextjs"
import { clerkAppearance } from "@repo/ui/clerk"
import { Toaster } from "@repo/ui/components/sonner"
import { MotionProvider } from "@repo/ui/components/motion-provider"
import { Theme } from "@repo/ui/components/theme"
import { TooltipProvider } from "@repo/ui/components/tooltip"
import "./globals.css"

export const metadata: Metadata = {
  title: "Sign in · i10",
  description: "Sign in to i10.",
  // ⚠ NOT INDEXABLE. A sign-in page in search results is a phishing target's
  // favourite starting point and has no reason to rank for anything.
  robots: { index: false, follow: false },
}

/**
 * Stop Clerk re-running the middleware every time the auth state changes.
 *
 * ⚠ THIS IS WHY SIGNING IN ON A PHONE LEFT PEOPLE SITTING ON THE AUTH PAGE WITH
 * A PERFECTLY GOOD SESSION. `@clerk/nextjs` installs two hooks that clerk-js
 * calls around `setActive`:
 *
 *     window.__internal_onBeforeSetActive = () => invalidateCacheAction()
 *     window.__internal_onAfterSetActive  = () => router.refresh()
 *
 * and `setActive` awaits the second. That `router.refresh()` races the redirect
 * we are trying to perform: its RSC fetch is cut off by the navigation in
 * flight, Next answers "Failed to fetch RSC payload, falling back to browser
 * navigation", and the fallback reloads the page we were leaving. The pending
 * redirect is cancelled and the person lands back on /sign-in, /sign-up or /mfa
 * — signed in, and apparently ignored. On a laptop the redirect commits first
 * and `setActive` returns before ever calling it, which is the whole of why
 * this looked like a phone-only bug.
 *
 * ⚠ AND THE REFRESH BUYS THIS APP NOTHING. It exists so server components pick
 * up a new auth state; every page here is a form that immediately navigates to
 * another origin once the session exists. There is nothing left to re-render.
 * apps/console is the opposite case and must keep the default.
 *
 * ⚠ THE CAST IS NEEDED BECAUSE THE SERVER PROVIDER'S TYPES REMOVE THE PROP —
 * it is declared `Without<NextClerkProviderProps, '__internal_invokeMiddlewareOnAuthStateChange'>`
 * — WHILE THE RUNTIME FORWARDS IT. Verified in this version: the server
 * provider destructures `{ children, dynamic, ...rest }`, `mergeNextClerkPropsWithEnv`
 * returns `{ ...props }`, and the result is spread into `ClientClerkProvider`,
 * which reads the flag. It is an `__internal_` name, so a Clerk upgrade may
 * move it; if sign-in starts hanging again after one, look here first.
 */
const NO_AUTH_STATE_REFRESH = {
  __internal_invokeMiddlewareOnAuthStateChange: false,
} as unknown as Partial<React.ComponentProps<typeof ClerkProvider>>

/**
 * ⚠ THE WHOLE APP RENDERS AT REQUEST TIME, AND THIS LINE IS LOAD-BEARING RATHER
 * THAN CAUTIOUS. Every PAGE here is already `force-dynamic`, but Next generates
 * one route nobody declares — `/_not-found` — and with no config it is
 * PRERENDERED AT BUILD TIME. The image is built in CI with no access to any
 * environment's Clerk instance, so `process.env.CLERK_PUBLISHABLE_KEY` is
 * undefined at that moment, and the 404's copy of this layout was baked with no
 * `<ClerkProvider>` in it at all.
 *
 * ⚠ AND A ROOT LAYOUT IS SHARED ACROSS CLIENT NAVIGATIONS, WHICH IS WHAT TURNED
 * THAT INTO A CRASH. Landing on a 404 and pressing "Go to the dashboard" is a
 * soft navigation: Next keeps the layout it already has — the provider-less one
 * from the static build — and mounts the dashboard shell inside it. The shell
 * contains `<OrganizationSwitcher>`, which throws "can only be used within
 * <ClerkProvider>". Reloading the same URL re-rendered the layout on the server,
 * with the key, and everything worked, which is exactly the signature of a
 * build-time value baked into one route.
 *
 * ⚠ AND ON THIS APP IT IS ALSO WHAT KEEPS THE BUILD HONEST. Every other route
 * here declares `force-dynamic` already, so `/_not-found` was the only page Next
 * would have tried to prerender — through a `<ClerkProvider>` given
 * `publishableKey={undefined}`, which is the one argument it refuses outright.
 * The 404 page could not have been added without this line.
 */
export const dynamic = "force-dynamic"

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // `publishableKey` passed rather than inferred — see middleware.ts, and
    // apps/console/app/layout.tsx, which carries the same note for the same
    // build-time-inlining reason.
    <ClerkProvider
      {...NO_AUTH_STATE_REFRESH}
      publishableKey={process.env.CLERK_PUBLISHABLE_KEY}
      /*
       * ⚠ THE SAME APPEARANCE THE CONSOLE USES, AND THIS APP HAD NONE AT ALL.
       * Most of the auth flow is our own markup — see the forms under `app/` —
       * but the pieces that are Clerk's (the CAPTCHA widget, anything rendered
       * by a prebuilt component) were drawing themselves in Clerk's palette in
       * the middle of ours. Sign-in is the first screen anybody sees of this
       * product; it is the worst place to look like two products.
       */
      appearance={clerkAppearance}
    >
      <html lang="en" suppressHydrationWarning>
        <body>
          {/*
           * ⚠ `preconnect` FOR THE FONT ORIGIN, AND `crossOrigin` IS NOT OPTIONAL
           * ON IT. Fonts are fetched in CORS mode whatever the stylesheet says, so
           * a preconnect without the attribute opens a SECOND, non-CORS connection
           * that the font request cannot reuse — it costs an extra DNS lookup and
           * TLS handshake rather than saving one, which is the exact opposite of
           * the point and is invisible in every tool except a waterfall.
           *
           * ⚠ AND IT IS `preconnect`, NOT `preload`. Preloading a font the page
           * may not use — this one is only on headings and the wordmark — makes it
           * a render-blocking download on every route. Warming the connection is
           * the half that is free.
           */}
          <link rel="preconnect" href="https://cdn.i10.tech" crossOrigin="anonymous" />
          <Theme>
            {/*
             * ⚠ THIS IS NOT DECORATION, AND ITS ABSENCE CRASHED THE SIGN-UP
             * FLOW. Radix's `Tooltip.Root`, `Trigger` and `Content` all call
             * `useTooltipProviderContext`, and a Radix context consumer with no
             * provider above it THROWS rather than falling back — so any
             * component that happens to contain a tooltip is a component that
             * takes this app down. `@repo/ui`'s `CopyButton` contains one.
             *
             * ⚠ WHICH IS WHY THE FAILURE LOOKED LIKE A TWO-FACTOR BUG. The only
             * two screens in this app that mount a `CopyButton` are the TOTP
             * scan step (copy the setup key) and the recovery codes step — so
             * everything worked until somebody answered "yes" to two-factor,
             * and then the whole page was replaced by Next's built-in error
             * screen: "This page couldn't load", a Reload button and a Back
             * button, with the half-finished sign-up thrown away.
             *
             * ⚠ THE DELAYS DIFFER FROM THE CONSOLE'S ON PURPOSE. There are
             * three tooltips in the entire app and they are all "what does this
             * button do"; opening on hover with no delay is right for a copy
             * icon somebody is already pointing at. The console sets 300ms
             * because its tooltips sit in dense tables where a delay is what
             * stops the screen flickering as the pointer crosses it.
             */}
            <TooltipProvider>
              <MotionProvider>{children}</MotionProvider>
            </TooltipProvider>
            {/*
             * ⚠ ONE TOASTER FOR THE WHOLE APP, MOUNTED HERE. `toast()` is a
             * module-level call that pushes onto whichever Toaster is mounted;
             * two of them render every message twice, and none at all makes every
             * `toast()` a silent no-op — no error, no warning, just messages that
             * never appear.
             */}
            <Toaster />
          </Theme>
        </body>
      </html>
    </ClerkProvider>
  )
}
