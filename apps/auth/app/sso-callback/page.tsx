"use client"

import { AuthenticateWithRedirectCallback } from "@clerk/nextjs"

/**
 * Where an OAuth provider drops the browser on its way back.
 *
 * ⚠ IT RENDERS ALMOST NOTHING ON PURPOSE. The component's whole job is to read
 * the parameters the provider appended, finish the handshake with Clerk, and
 * navigate on — anything else drawn here is a frame the person sees for a few
 * hundred milliseconds and then loses. The one line of text exists so a slow
 * handshake is not a blank white page.
 */
export default function Page() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <p className="text-muted-foreground text-sm">Signing you in…</p>
      <AuthenticateWithRedirectCallback />
    </main>
  )
}
