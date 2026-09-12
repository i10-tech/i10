"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useClerk, useSignIn, useSignUp } from "@clerk/nextjs"
import { Button } from "@repo/ui/components/button"
import { FieldGroup } from "@repo/ui/components/field"
import { Spinner } from "@repo/ui/components/spinner"
import { messageFor, ssoFailureMessage, TRANSPORT_FAILURE } from "../_lib/errors"
import { finalizeAndLeave, leaveFor, setActiveAndLeave } from "../_lib/finish"

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
 * ⚠ AND IT HAS TO CHOOSE BETWEEN FOUR OUTCOMES, because one round trip resolves
 * into whichever it turns out to be:
 *
 *   - a returning account finished a SIGN-IN     → `signIn.finalize()`
 *   - the person was ALREADY signed in           → `setActive()` on that session
 *   - they pressed sign-up but already exist     → transfer to a sign-in, silently
 *   - they have NO account yet                   → ASK FIRST. See below.
 */

/** Marks we can name in the copy. Anything else is described generically. */
const PROVIDER_LABELS: Record<string, string> = {
  oauth_google: "Google",
  oauth_github: "GitHub",
  oauth_apple: "Apple",
}

export function SsoCallback({ afterAuthUrl }: { afterAuthUrl: string }) {
  const router = useRouter()
  const clerk = useClerk()
  const { signIn } = useSignIn()
  const { signUp } = useSignUp()

  // ⚠ ONCE, EVER. This effect re-runs as Clerk's state settles, and `finalize`
  // is not idempotent — a second call races the navigation the first one
  // started.
  const done = useRef(false)

  /**
   * ⚠ `offer` IS A STOPPING POINT, NOT A STEP THAT RUNS ITSELF. Reaching it
   * means no account exists and NONE HAS BEEN CREATED — the decision is the
   * person's, and `signUp.create({ transfer: true })` is what makes it real, so
   * it must not be called until they press the button. An earlier version
   * transferred immediately and told them afterwards, which created accounts
   * for people who had only meant to sign in.
   */
  const [offer, setOffer] = useState<{ provider: string | null } | null>(null)
  const [pending, setPending] = useState(false)

  /**
   * Whichever half of the handshake recorded why it failed.
   *
   * ⚠ BOTH ARE CHECKED BECAUSE EITHER CAN BE THE ONE THAT KNOWS. A sign-in that
   * found no user records it on its first-factor verification; a sign-up that
   * found an existing account records it on the external-account verification.
   * Reading only one is how a well-explained failure still comes out generic.
   */
  const failureCode = useCallback(
    () =>
      clerk.client?.signIn?.firstFactorVerification?.error?.code ??
      clerk.client?.signUp?.verifications?.externalAccount?.error?.code ??
      null,
    [clerk],
  )

  /**
   * Take whatever session a transfer produced and leave.
   *
   * ⚠ IT KEYS OFF `createdSessionId` RATHER THAN `status === "complete"`, AND
   * THAT IS A BUG FIX RATHER THAN A PREFERENCE. A transfer that had already
   * created the session was reported as "we need a little more" — the account
   * existed, the person was signed in, and the page said otherwise — because
   * the status read back as something other than complete. The session id is
   * the fact; the status is a description of it.
   *
   * ⚠ AND `clerk.session` IS THE SECOND CHANCE. If Clerk activated the session
   * itself there is no id left for us to activate, and the only thing left to
   * do is go.
   */
  const leaveWithSession = useCallback(
    async (sessionId: string | null | undefined) => {
      if (sessionId) {
        await setActiveAndLeave(
          (params) => clerk.setActive(params),
          sessionId,
          afterAuthUrl,
        )
        return true
      }
      if (clerk.session) {
        leaveFor(afterAuthUrl)
        return true
      }
      return false
    },
    [clerk, afterAuthUrl],
  )

  useEffect(() => {
    if (done.current || !signIn || !signUp || !clerk.loaded) return

    const navigate = ({ decorateUrl }: { decorateUrl: (u: string) => string }) => {
      // ⚠ `decorateUrl` IS NOT COSMETIC. On Safari it carries the handshake
      // that lets the session cookie survive ITP, and the decorated result may
      // be an absolute URL on another origin — which Next's router cannot route
      // to, hence the branch.
      const url = decorateUrl(afterAuthUrl)
      if (url.startsWith("http")) {
        // ⚠ `replace`, NOT `href` — see _lib/finish.ts. This page is a machine
        // step nobody should be able to go back to: restoring it re-runs a
        // hand-off whose one-time code has already been spent.
        leaveFor(url)
      } else {
        router.replace(url)
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

        /*
         * ⚠ NO ACCOUNT FOR THIS PROVIDER IDENTITY — STOP AND ASK. Clerk answers
         * `transferable` here, and the transfer that would create the account
         * is deliberately NOT performed. Signing in and signing up are the same
         * button by design, which is convenient right up until it silently
         * registers somebody who mistyped which provider they use. Everything
         * needed to finish is already on the client, so the decision costs
         * nothing to defer and nothing is created if they walk away.
         */
        if (signIn.isTransferable) {
          const strategy = clerk.client?.signIn?.firstFactorVerification?.strategy
          setOffer({ provider: PROVIDER_LABELS[strategy ?? ""] ?? null })
          return
        }

        /*
         * ⚠ THE OPPOSITE DIRECTION NEEDS NO PERMISSION, AND THAT ASYMMETRY IS
         * THE POINT. Somebody pressed "Sign up with Google" holding an account
         * that already exists: signing them in creates nothing they do not
         * already have, and it is plainly what they were trying to do.
         */
        if (signUp.isTransferable) {
          const { error } = await signIn.create({ transfer: true })
          if (error) {
            toast.error(messageFor(error) || ssoFailureMessage(failureCode()))
            router.replace("/sign-in")
            return
          }

          // ⚠ RE-READ FROM `clerk.client`: `create` replaces the resource, so
          // the object the hook handed us is stale — the same trap that made
          // the SSO buttons silently do nothing.
          const transferred = clerk.client.signIn
          if (
            await leaveWithSession(
              signIn.createdSessionId ?? transferred.createdSessionId,
            )
          )
            return

          // An OAuth sign-in can still owe a second factor, and
          // `needs_client_trust` is Clerk's device-trust step, not an error.
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
    /*
     * ⚠ `failureCode` AND `leaveWithSession` ARE `useCallback`s SO THEY CAN BE
     * HONEST DEPENDENCIES. Written as plain functions they change identity on
     * every render, which would either re-run this effect — a hand-off that
     * must happen exactly once — or force a suppression comment to hide the
     * fact. The `done` ref is still the real guard; this just keeps the
     * dependency list true.
     */
  }, [signIn, signUp, clerk, afterAuthUrl, router, failureCode, leaveWithSession])

  /**
   * They said yes. This is the call that actually creates the account.
   *
   * ⚠ THE SESSION IS READ OFF THE OBJECT `create()` JUST WROTE TO, WHICH IS THE
   * HOOK'S `signUp` AND NOT `clerk.client.signUp`. Reading the client resource
   * instead is how pressing "Create my account" made the account, created the
   * session, and then dumped the person on /sign-up anyway: the id was sitting
   * on the future object the whole time, and the fallback path fired because we
   * looked in the wrong place.
   *
   * ⚠ AND `createdSessionId` IS THE GATE RATHER THAN `status`, because it is
   * also exactly what `finalize()` requires — it throws "Cannot finalize
   * sign-up without a created session" without one. Gating on the same field
   * the call needs means the check and the call cannot disagree.
   */
  async function createAccount() {
    if (!signUp || pending) return
    setPending(true)

    try {
      const { error } = await signUp.create({ transfer: true })
      if (error) {
        toast.error(messageFor(error) || ssoFailureMessage(failureCode()))
        setPending(false)
        return
      }

      if (signUp.createdSessionId) {
        const result = await finalizeAndLeave(
          (params) => signUp.finalize(params),
          afterAuthUrl,
        )
        if (result.error) {
          toast.error(messageFor(result.error))
          setPending(false)
        }
        return
      }

      // Belt and braces: the classic resource, or a session Clerk activated for
      // us. `leaveWithSession` covers both and returns false only if there is
      // genuinely no session anywhere.
      if (await leaveWithSession(clerk.client?.signUp?.createdSessionId)) return

      // ⚠ `missing_requirements` IS REACHABLE AND IS NOT AN ERROR: the instance
      // asks for something the provider did not supply. We cannot collect it
      // here, so hand back to the form that can. Reaching this now means no
      // session exists anywhere, so it is honest rather than the mis-read it
      // used to be.
      toast.error("We need a little more before your account is ready.")
      router.replace("/sign-up")
    } catch {
      toast.error(TRANSPORT_FAILURE)
      setPending(false)
    }
  }

  /**
   * They said no.
   *
   * ⚠ `reset()` MATTERS MORE THAN THE NAVIGATION. It clears the transferable
   * attempt off the Clerk client; leaving it there means the next thing they
   * try starts against a half-finished sign-in that has already been declined.
   * It touches no API — it is local state only — so declining really does leave
   * nothing behind.
   */
  async function decline() {
    if (pending) return
    setPending(true)
    try {
      await signIn?.reset()
    } catch {
      // Nothing to report: they are leaving either way.
    }
    router.replace("/sign-in")
  }

  if (offer) {
    const named = offer.provider ? `your ${offer.provider} account` : "that account"

    return (
      <main className="flex min-h-dvh items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <FieldGroup>
            <div className="flex flex-col items-center gap-2 text-center">
              <h1 className="text-2xl font-bold text-balance">
                Create an i10 account?
              </h1>
              <p className="text-muted-foreground text-sm text-balance">
                There is no i10 account for {named} yet. We have not created anything —
                say the word and we will set one up and sign you in.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={decline}
                disabled={pending}
              >
                Not now
              </Button>
              <Button type="button" onClick={createAccount} disabled={pending}>
                {pending ? (
                  <>
                    <Spinner aria-hidden="true" aria-label={undefined} />
                    Creating…
                  </>
                ) : (
                  "Create my account"
                )}
              </Button>
            </div>
          </FieldGroup>
        </div>
      </main>
    )
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      {/*
       * ⚠ A SPINNER RATHER THAN A BARE SENTENCE, because this page is a pause of
       * unknown length in the middle of a redirect chain. Static text on an
       * empty page is indistinguishable from a page that has stopped.
       */}
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner aria-hidden="true" aria-label={undefined} />
        Signing you in…
      </p>
    </main>
  )
}
