"use client"

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useClerk, useSignIn, useSignUp } from "@clerk/nextjs"
import { messageFor, TRANSPORT_FAILURE } from "../_lib/errors"

/**
 * Where an OAuth provider drops the browser on its way back.
 *
 * ⚠ IT DOES NOT USE `<AuthenticateWithRedirectCallback />`, AND THAT COMPONENT
 * IS WHY EVERY PROVIDER SILENTLY FAILED HERE ONCE ALREADY. It belongs to the
 * CLASSIC sign-in API; this app is built on the signals API, where a redirect
 * is finished by calling `finalize()` on whichever attempt the handshake
 * produced. The component mounts, finds no classic flow in progress, and does
 * nothing at all — no error, no session, just a page that sits there.
 *
 * ⚠ AND IT HAS TO CHOOSE BETWEEN THREE OUTCOMES, because one round trip
 * resolves into whichever it turns out to be:
 *
 *   - a returning account finished a SIGN-IN      → `signIn.finalize()`
 *   - a new account was transferred into SIGN-UP  → `signUp.finalize()`
 *   - the person was ALREADY signed in            → `setActive()` on that
 *     existing session, which no `finalize()` covers because this attempt
 *     created nothing to finalize
 *
 * Guessing one and ignoring the others is how "sign up with Google" works for
 * new people and hangs for everybody who already has an account.
 */
export function SsoCallback({ afterAuthUrl }: { afterAuthUrl: string }) {
  const router = useRouter()
  const clerk = useClerk()
  const { signIn } = useSignIn()
  const { signUp } = useSignUp()

  // ⚠ ONCE, EVER. This effect re-runs as Clerk's state settles, and `finalize`
  // is not idempotent — a second call races the navigation the first one
  // started.
  const done = useRef(false)

  useEffect(() => {
    if (done.current || !signIn || !signUp || !clerk.loaded) return

    const navigate = ({ decorateUrl }: { decorateUrl: (u: string) => string }) => {
      // ⚠ `decorateUrl` IS NOT COSMETIC. On Safari it carries the handshake
      // that lets the session cookie survive ITP, and the decorated result may
      // be an absolute URL on another origin — which Next's router cannot
      // route to, hence the branch.
      const url = decorateUrl(afterAuthUrl)
      if (url.startsWith("http")) {
        window.location.href = url
      } else {
        router.push(url)
      }
    }

    const finish = async () => {
      done.current = true

      try {
        if (signIn.status === "complete") {
          const { error } = await signIn.finalize({ navigate })
          if (error) toast.error(messageFor(error))
          return
        }

        if (signUp.status === "complete") {
          const { error } = await signUp.finalize({ navigate })
          if (error) toast.error(messageFor(error))
          return
        }

        // Already signed in on this device: the provider handed us back a
        // person who has a session we did not just create.
        const existing =
          signIn.existingSession?.sessionId ?? signUp.existingSession?.sessionId
        if (existing) {
          await clerk.setActive({ session: existing })
          window.location.href = afterAuthUrl
          return
        }

        // ⚠ A SECOND FACTOR CAN FOLLOW AN OAUTH SIGN-IN TOO. The provider
        // proved the identity; the account may still demand a second step.
        if (
          signIn.status === "needs_second_factor" ||
          signIn.status === "needs_client_trust"
        ) {
          router.push("/mfa")
          return
        }

        toast.error("That sign-in did not complete. Try again.")
        router.push("/sign-in")
      } catch {
        toast.error(TRANSPORT_FAILURE)
        router.push("/sign-in")
      }
    }

    void finish()
  }, [signIn, signUp, clerk, afterAuthUrl, router])

  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <p className="text-muted-foreground text-sm">Signing you in…</p>
    </main>
  )
}
