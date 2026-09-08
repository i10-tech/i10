import type { Metadata } from "next"
import { ClerkProvider } from "@clerk/nextjs"
import "./globals.css"

export const metadata: Metadata = {
  title: "Sign in · i10",
  description: "Sign in to i10.",
  // ⚠ NOT INDEXABLE. A sign-in page in search results is a phishing target's
  // favourite starting point and has no reason to rank for anything.
  robots: { index: false, follow: false },
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // `publishableKey` passed rather than inferred — see middleware.ts, and
    // apps/console/app/layout.tsx, which carries the same note for the same
    // build-time-inlining reason.
    <ClerkProvider publishableKey={process.env.CLERK_PUBLISHABLE_KEY}>
      <html lang="en" suppressHydrationWarning>
        <body>{children}</body>
      </html>
    </ClerkProvider>
  )
}
