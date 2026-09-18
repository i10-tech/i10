import type { Metadata } from "next"
import { ClerkProvider } from "@clerk/nextjs"
import { clerkAppearance } from "@repo/ui/clerk"
import { Toaster } from "@repo/ui/components/sonner"
import { MotionProvider } from "@repo/ui/components/motion-provider"
import { Theme } from "@repo/ui/components/theme"
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
 * redirect is cancelled and the person lands back on /sign-up, /mfa or /passkey
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
            <MotionProvider>{children}</MotionProvider>
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
