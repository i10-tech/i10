import type { Metadata, Viewport } from "next"
import { ClerkProvider } from "@clerk/nextjs"
import { GeistMono } from "geist/font/mono"
import { GeistSans } from "geist/font/sans"
import { Theme } from "@repo/ui/components/theme"
import { Toaster } from "@repo/ui/components/sonner"
import { TooltipProvider } from "@repo/ui/components/tooltip"
import "./globals.css"

export const metadata: Metadata = {
  // ⚠ A TEMPLATE, SO EVERY PAGE GETS "Domains · i10" WITHOUT REPEATING THE
  // SUFFIX. A browser with twenty tabs open shows about fifteen characters of
  // a title; putting the product name first would make every tab identical.
  title: { default: "i10", template: "%s · i10" },
  description: "Transactional and human email.",
}

export const viewport: Viewport = {
  /*
   * ⚠ THE THEME COLOUR IS TRUE BLACK IN DARK MODE BECAUSE THE CANVAS IS. On iOS
   * this paints the area behind the status bar and the home indicator; leaving
   * it unset gives a white band above a black page, which is the single most
   * obvious way a web app announces itself as a web app.
   */
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
}

/**
 * ⚠ CLERK IS MOUNTED ONLY WHEN IT IS CONFIGURED, AND THE FALLBACK IS FOR LOCAL
 * REVIEW ONLY. `<ClerkProvider>` throws without a publishable key, so a
 * checkout with no Clerk instance would render nothing at all — and the point
 * of preview mode is that somebody can look at the interface before the stack
 * behind it exists. In every real deployment the key is present and this
 * branch is not taken.
 *
 * ⚠ IT IS DELIBERATELY NOT AN AUTHENTICATION BYPASS. The middleware is what
 * protects these pages, and its own preview guard folds to `false` in a
 * production build — see middleware.ts. A production image with a missing
 * Clerk key renders an unauthenticated shell here and is refused by the API on
 * every request, which is a loud failure rather than a quiet one.
 */
function Providers({ children }: { children: React.ReactNode }) {
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY
  if (!publishableKey) return children

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      signInUrl={process.env.CLERK_SIGN_IN_URL}
      signUpUrl={process.env.CLERK_SIGN_UP_URL}
      appearance={{
        variables: {
          colorPrimary: "#fafafa",
          colorBackground: "#0a0a0a",
          colorForeground: "#fafafa",
          colorInput: "#141414",
          colorInputForeground: "#fafafa",
          colorMutedForeground: "#a1a1a1",
          colorBorder: "#262626",
          borderRadius: "0.5rem",
          fontFamily: "var(--font-geist-sans)",
        },
      }}
    >
      {children}
    </ClerkProvider>
  )
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    /*
     * ⚠ `publishableKey`, `signInUrl` AND `signUpUrl` ARE PASSED EXPLICITLY IN
     * `Providers` ABOVE, NOT INFERRED, and middleware.ts explains why at length:
     * Clerk's default is to read `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, which Next
     * inlines at BUILD time. The console image is built once in CI with no
     * access to any environment's Clerk instance, so the key has to arrive at
     * runtime — which only an unprefixed variable, read in a server component,
     * actually does.
     *
     * ⚠ AND OMITTING THE TWO URLs FROM THE PROVIDER IS WHY SIGNING IN VISIBLY
     * BOUNCED THROUGH clerk.i10.tech. The middleware and the browser SDK resolve
     * them independently: middleware had them, the provider did not, so anything
     * Clerk redirected from the client — a protected page hydrating without a
     * session, `<UserButton />` signing out — fell back to the hosted Account
     * Portal at the instance's own domain, which then forwarded to auth.i10.tech.
     * The extra hop was not a network hiccup; it was two halves of one SDK
     * configured differently.
     *
     * ⚠ THE FONT VARIABLES GO ON <html>, NOT ON <body>, BECAUSE PORTALS ESCAPE
     * <body>'s SUBTREE. Radix renders dialogs, popovers and the command menu
     * into a portal appended to `document.body` — a sibling of our tree, not a
     * descendant of anything we rendered. Declaring them on <html> makes them
     * reach those portals however a library chooses to mount.
     */
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="min-h-dvh antialiased">
        {/*
         * ⚠ THE CONSOLE HAD NO THEME PROVIDER AT ALL, WHICH IS WHY IT WAS WHITE.
         * See @repo/ui/components/theme: the dark palette is a `.dark` class in
         * the token sheet and nothing was applying it.
         */}
        <Theme>
          {/*
           * ⚠ ONE TOOLTIP PROVIDER AT THE ROOT RATHER THAN ONE PER TOOLTIP.
           * Radix's provider is what makes the SECOND tooltip open instantly
           * after the first — the "skip delay" behaviour. Wrapping each tooltip
           * in its own provider gives every one of them the full delay, which in
           * a table of copy buttons feels broken.
           */}
          <TooltipProvider delayDuration={300} skipDelayDuration={500}>
            <Providers>{children}</Providers>
          </TooltipProvider>
          <Toaster />
        </Theme>
      </body>
    </html>
  )
}
