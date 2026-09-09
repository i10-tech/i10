import type { Metadata } from "next"
import { ClerkProvider } from "@clerk/nextjs"
import { Theme } from "@repo/ui/components/theme"
import "./globals.css"

export const metadata: Metadata = {
  title: "i10",
  description: "Transactional and human email.",
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    /**
     * ⚠ `publishableKey` IS PASSED, NOT INFERRED, and middleware.ts explains
     * why at length: Clerk's default is to read `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`,
     * which Next inlines at build time. The console image is built once in CI
     * with no access to any environment's Clerk instance, so the key has to
     * arrive at runtime — which only an unprefixed variable, read in a server
     * component, actually does.
     *
     * ⚠ `signInUrl` AND `signUpUrl` ARE PASSED HERE AS WELL AS IN MIDDLEWARE,
     * AND OMITTING THEM HERE IS WHY SIGNING IN VISIBLY BOUNCED THROUGH
     * clerk.i10.tech. The middleware and the browser SDK resolve these
     * independently: middleware had them, the provider did not, so anything
     * Clerk redirected from the client — a protected page hydrating without a
     * session, `<UserButton />` signing out — fell back to the hosted Account
     * Portal at the instance's own domain, which then forwarded to auth.i10.tech.
     * The extra hop was not a network hiccup; it was two halves of one SDK
     * configured differently.
     *
     * ⚠ THEY ARE READ AT RUNTIME AND MAY BE UNDEFINED IN DEVELOPMENT, which is
     * the same fallback and is fine there. In production Doppler supplies both,
     * pointed at auth.i10.tech.
     */
    <ClerkProvider
      publishableKey={process.env.CLERK_PUBLISHABLE_KEY}
      signInUrl={process.env.CLERK_SIGN_IN_URL}
      signUpUrl={process.env.CLERK_SIGN_UP_URL}
    >
      <html lang="en" suppressHydrationWarning>
        <body>
          {/*
           * ⚠ THE CONSOLE HAD NO THEME PROVIDER AT ALL, WHICH IS WHY IT WAS
           * WHITE. See @repo/ui/components/theme: the dark palette is a `.dark`
           * class in the token sheet and nothing was applying it.
           */}
          <Theme>{children}</Theme>
        </body>
      </html>
    </ClerkProvider>
  )
}
