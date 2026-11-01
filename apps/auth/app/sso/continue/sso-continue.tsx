"use client"

import { useEffect, useRef, useState } from "react"
import { useSignIn } from "@clerk/nextjs"
import { Button } from "@repo/ui/components/button/button"
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
  const [tested, setTested] = useState<"passed" | "failed" | null>(null)
  /**
   * ⚠ AN IdP-INITIATED SAML SIGN-IN (#339) WAITS FOR A CLICK. Nothing proves
   * this browser asked for it, so the person sees whose account it is before
   * the code is swapped: a colleague's assertion auto-posted from another
   * site would otherwise sign this browser in as them.
   *
   * And when the IdP answered for somebody other than the address typed on
   * our sign-in page (its live session won): `typed` and `connection` offer a
   * fresh login as the typed address instead.
   */
  const [confirm, setConfirm] = useState<{
    code: string
    as: string
    retry: { typed: string; href: string } | null
  } | null>(null)

  useEffect(() => {
    if (!signIn || started.current) return
    started.current = true
    const hash = new URLSearchParams(window.location.hash.slice(1))
    // The code must not survive a reload or a copied address bar.
    history.replaceState(null, "", window.location.pathname)
    // A test run (#338) signs nobody in: its result is all there is to show.
    const test = hash.get("sso_test")
    if (test === "passed" || test === "failed") {
      // Settled like every outcome below, after the effect, not inside it.
      void Promise.resolve<"passed" | "failed">(test).then(setTested)
      return
    }
    const code = hash.get("code")
    const confirmAs = hash.get("confirm")
    if (code && confirmAs !== null) {
      const typed = hash.get("typed")
      const connection = hash.get("connection")
      const retry =
        typed && connection
          ? {
              typed,
              href: `/sso/start?${new URLSearchParams({ connection, login_hint: typed, fresh: "1" })}`,
            }
          : null
      void Promise.resolve({
        code,
        as: confirmAs || "your company account",
        retry,
      }).then(setConfirm)
      return
    }
    const finished = code
      ? finishSso(signIn, code, fallbackUrl)
      : Promise.resolve(hash.get("error") ?? "This sign-in has expired. Start again.")
    void finished.then((message) => {
      if (message) setError(message)
    })
  }, [signIn, fallbackUrl])

  if (confirm)
    return (
      <div className="flex flex-col items-center gap-6">
        <StepHeading title="Continue to i10?">
          {confirm.retry
            ? `You typed ${confirm.retry.typed}. Your company's sign-in answered as ${confirm.as}.`
            : `Your company's sign-in is asking to sign you in as ${confirm.as}. Continue only if you started this.`}
        </StepHeading>
        <Button
          className="w-full"
          onClick={() => {
            const { code } = confirm
            setConfirm(null)
            if (!signIn) return
            void finishSso(signIn, code, fallbackUrl).then((message) => {
              if (message) setError(message)
            })
          }}
        >
          {confirm.retry ? `Continue as ${confirm.as}` : "Continue"}
        </Button>
        {confirm.retry ? (
          // A route handler, not a page: the router must not intercept it.
          <ButtonLink
            native
            href={confirm.retry.href}
            variant="secondary"
            className="w-full"
          >
            {`Sign in as ${confirm.retry.typed}`}
          </ButtonLink>
        ) : (
          <ButtonLink href="/sign-in" variant="secondary" className="w-full">
            Cancel
          </ButtonLink>
        )}
      </div>
    )

  if (tested)
    return (
      <div className="flex flex-col items-center gap-6">
        <StepHeading title={tested === "passed" ? "Test passed" : "Test failed"}>
          {tested === "passed"
            ? "Your identity provider signed you in and i10 accepted it. Nobody was signed in."
            : "i10 did not accept what your identity provider sent. The setup screen shows why."}
        </StepHeading>
      </div>
    )

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
