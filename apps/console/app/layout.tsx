import type { Metadata } from "next"
import { ClerkProvider } from "@clerk/nextjs"
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
     */
    <ClerkProvider publishableKey={process.env.CLERK_PUBLISHABLE_KEY}>
      <html lang="en" suppressHydrationWarning>
        <body>{children}</body>
      </html>
    </ClerkProvider>
  )
}
