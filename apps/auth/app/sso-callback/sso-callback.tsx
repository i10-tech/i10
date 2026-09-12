"use client"

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useClerk, useSignIn, useSignUp } from "@clerk/nextjs"
import { Spinner } from "@repo/ui/components/spinner"
import { messageFor, ssoFailureMessage, TRANSPORT_FAILURE } from "../_lib/errors"
import { leaveFor, setActiveAndLeave } from "../_lib/finish"

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
        // ⚠ `replace`, NOT `href` — see _lib/finish.ts. This page is a machine
        // step nobody should be able to go back to: restoring it re-runs a
        // hand-off whose one-time code has already been spent, which fails and
        // dumps the person on /sign-in.
        leaveFor(url)
      } else {
        router.replace(url)
      }
    }

    /**
     * Whichever half of the handshake recorded why it failed.
     *
     * ⚠ BOTH ARE CHECKED BECAUSE EITHER CAN BE THE ONE THAT KNOWS. A sign-in
     * that found no user records it on its first-factor verification; a sign-up
     * that found an existing account records it on the external-account
     * verification. Reading only one is how a perfectly well-explained failure
     * still comes out as "did not complete".
     */
    const failureCode = () =>
      clerk.client?.signIn?.firstFactorVerification?.error?.code ??
      clerk.client?.signUp?.verifications?.externalAccount?.error?.code ??
      null

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

        /*
         * ⚠ NO ACCOUNT FOR THIS PROVIDER IDENTITY YET — MAKE ONE. This is the
         * whole of "sign up with GitHub does not work". An SSO round trip that
         * finds no matching user comes back `transferable` rather than
         * complete, and Clerk expects the callback to turn it into a sign-up.
         * Without this branch it fell through to the catch-all below and told
         * a brand-new customer their sign-in "did not complete", which is both
         * wrong and unactionable — there was nothing to complete, they had
         * never signed up.
         *
         * ⚠ `transfer: true` IS WHAT CARRIES THE VERIFIED IDENTITY ACROSS. The
         * provider has already proved who they are; this reuses that proof
         * rather than starting a second round trip. Creating a bare sign-up
         * here instead would ask somebody who just authorised Google for an
         * email and password.
         */
        if (signIn.isTransferable) {
          const { error } = await signUp.create({ transfer: true })
          if (error) {
            // Clerk's own sentence when it has one, ours when the code is all
            // we get.
            toast.error(messageFor(error) || ssoFailureMessage(failureCode()))
            router.replace("/sign-up")
            return
          }

          /*
           * ⚠ RE-READ FROM `clerk.client`, NOT FROM THE HOOK'S OBJECT. `create`
           * replaces the resource on the client, so the value captured when the
           * hook handed it to us is stale the moment the transfer lands — the
           * same trap that made the SSO buttons silently do nothing. It also
           * happens to be the only reading TypeScript will not have narrowed to
           * "not complete" from the guard at the top of this function.
           */
          const transferred = clerk.client.signUp
          if (transferred.status === "complete" && transferred.createdSessionId) {
            await setActiveAndLeave(
              (params) => clerk.setActive(params),
              transferred.createdSessionId,
              afterAuthUrl,
            )
            return
          }

          // ⚠ `missing_requirements` IS REACHABLE AND IS NOT AN ERROR: the
          // instance asks for something the provider did not supply. We cannot
          // collect it on this page, so hand back to the form that can.
          toast.error("We need a little more before your account is ready.")
          router.replace("/sign-up")
          return
        }

        /*
         * ⚠ AND THE OPPOSITE DIRECTION, which is the same bug seen from the
         * sign-up page: somebody pressed "Sign up with Google" with an account
         * that already exists. Clerk answers `transferable` on the SIGN-UP, and
         * the right response is to sign them in rather than to tell them the
         * address is taken.
         */
        if (signUp.isTransferable) {
          const { error } = await signIn.create({ transfer: true })
          if (error) {
            toast.error(messageFor(error) || ssoFailureMessage(failureCode()))
            router.replace("/sign-in")
            return
          }

          // Re-read from the client for the same reason as above.
          const transferred = clerk.client.signIn
          if (transferred.status === "complete" && transferred.createdSessionId) {
            await setActiveAndLeave(
              (params) => clerk.setActive(params),
              transferred.createdSessionId,
              afterAuthUrl,
            )
            return
          }

          // Same pair as the non-transfer path above: an OAuth sign-in can
          // still owe a second factor, and `needs_client_trust` is Clerk's
          // device-trust step rather than an error.
          if (
            transferred.status === "needs_second_factor" ||
            transferred.status === "needs_client_trust"
          ) {
            router.replace("/mfa")
            return
          }

          toast.error(ssoFailureMessage(failureCode()))
          router.replace("/sign-in")
          return
        }

        // Already signed in on this device: the provider handed us back a
        // person who has a session we did not just create.
        const existing =
          signIn.existingSession?.sessionId ?? signUp.existingSession?.sessionId
        if (existing) {
          await clerk.setActive({ session: existing })
          leaveFor(afterAuthUrl)
          return
        }

        // ⚠ A SECOND FACTOR CAN FOLLOW AN OAUTH SIGN-IN TOO. The provider
        // proved the identity; the account may still demand a second step.
        if (
          signIn.status === "needs_second_factor" ||
          signIn.status === "needs_client_trust"
        ) {
          router.replace("/mfa")
          return
        }

        toast.error(ssoFailureMessage(failureCode()))
        router.replace("/sign-in")
      } catch {
        toast.error(TRANSPORT_FAILURE)
        router.replace("/sign-in")
      }
    }

    void finish()
  }, [signIn, signUp, clerk, afterAuthUrl, router])

  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      {/*
       * ⚠ A SPINNER RATHER THAN A BARE SENTENCE, because this page is a pause
       * of unknown length in the middle of a redirect chain. Static text on an
       * empty page is indistinguishable from a page that has stopped, which is
       * how a hand-off that is merely slow gets reported as broken.
       */}
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner aria-hidden="true" aria-label={undefined} />
        Signing you in…
      </p>
    </main>
  )
}
