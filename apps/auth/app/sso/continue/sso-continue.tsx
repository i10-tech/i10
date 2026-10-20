"use client"

import { useEffect, useRef, useState } from "react"
import { useSignIn } from "@clerk/nextjs"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { TextShimmer } from "@repo/ui/components/text-shimmer/text-shimmer"
import { StepHeading } from "../../_components/step-heading"
import { finishSso } from "../../_lib/sso"

/**
 * Swaps the code for a ticket, signs in, binds, leaves. See _lib/sso.ts.
 *
 * ⚠ ONCE, EVER: the code works once, and this effect re-runs as Clerk's
 * state settles.
 */
export function SsoContinue({ fallbackUrl }: { fallbackUrl: string }) {
  const { signIn } = useSignIn()
  const started = useRef(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!signIn || started.current) return
    started.current = true
    const hash = new URLSearchParams(window.location.hash.slice(1))
    // The code must not survive a reload or a copied address bar.
    history.replaceState(null, "", window.location.pathname)
    const code = hash.get("code")
    const finished = code
      ? finishSso(signIn, code, fallbackUrl)
      : Promise.resolve(hash.get("error") ?? "This sign-in has expired. Start again.")
    void finished.then((message) => {
      if (message) setError(message)
    })
  }, [signIn, fallbackUrl])

  if (error)
    return (
      <div className="flex flex-col items-center gap-6">
        <StepHeading title="Could not sign you in">{error}</StepHeading>
        <ButtonLink href="/sign-in" variant="secondary" className="w-full">
          Back to sign in
        </ButtonLink>
      </div>
    )

  return (
    <div className="flex flex-col items-center">
      <TextShimmer className="text-sm">Signing you in</TextShimmer>
    </div>
  )
}
