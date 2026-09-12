"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useSignIn } from "@clerk/nextjs"
import { Button } from "@repo/ui/components/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@repo/ui/components/field"
import { Input } from "@repo/ui/components/input"
import { Spinner } from "@repo/ui/components/spinner"
import { PasswordInput } from "../_components/password-input"
import { OAuthButtons } from "../_components/oauth-buttons"
import { messageFor, TRANSPORT_FAILURE } from "../_lib/errors"
import { finalizeAndLeave } from "../_lib/finish"
import type { SsoProvider } from "../_lib/providers"

/*
 * shadcn's `login-02`, wired to Clerk.
 *
 * ⚠ THE MARKUP IS THE BLOCK'S, UNCHANGED. Only three things differ, and each is
 * behaviour rather than taste: the two placeholder `<a href="#">` links now go
 * somewhere, the single hard-coded GitHub button became the providers we
 * actually enabled, and the form submits instead of reloading the page. Nothing
 * was restyled — a block edited for taste on arrival is a block that can no
 * longer be diffed against upstream.
 *
 * ⚠ THERE IS ONE `busy` FOR THE WHOLE PAGE, NOT ONE PER BUTTON, AND THAT IS THE
 * FIX FOR A REAL RACE. The password form and the SSO buttons each used to track
 * their own pending flag, so pressing "Continue with Google" and then "Login"
 * started two flows against the same Clerk client: the SSO redirect was already
 * in flight when `signIn.password` overwrote the attempt it depended on.
 * Holding the id of the one running action in a single piece of state makes
 * every other control disabled by construction rather than by remembering to
 * disable it.
 */
export function SignInForm({
  afterAuthUrl,
  signUpHref,
  resetHref,
  mfaHref,
  passkeyHref,
  redirectRaw,
  providers,
}: {
  afterAuthUrl: string
  signUpHref: string
  resetHref: string
  mfaHref: string
  passkeyHref: string
  redirectRaw?: string
  providers: SsoProvider[]
}) {
  const router = useRouter()
  const { signIn } = useSignIn()
  const [busy, setBusy] = useState<string | null>(null)

  /**
   * Offer a saved passkey without anybody asking.
   *
   * ⚠ `autofill`, NOT `discoverable` — the opposite of what /passkey does. This
   * is WebAuthn conditional mediation: the browser quietly checks whether it
   * holds a passkey for this site and, if it does, offers it inside the email
   * field's own autofill menu. It must be armed BEFORE the person touches
   * anything, which is why it runs in an effect rather than behind a button,
   * and it pairs with `autoComplete="username webauthn"` on that input — drop
   * either half and the prompt never appears.
   *
   * ⚠ AND EVERY FAILURE HERE IS SILENT ON PURPOSE. Nobody asked for this: a
   * browser with no passkey, no platform authenticator, or no support for
   * conditional mediation rejects immediately, and a toast would be an error
   * message for something the person never requested. The password form
   * underneath is unaffected either way.
   *
   * ⚠ IT TAKES THE LOCK ONLY ONCE IT HAS ACTUALLY SUCCEEDED. Claiming `busy` at
   * arm time would grey the whole page out for the many people whose browser
   * holds no passkey at all; claiming it before navigating stops them pressing
   * "Login" during the redirect that is already happening.
   */
  const armed = useRef(false)

  useEffect(() => {
    if (!signIn || armed.current) return
    armed.current = true

    void signIn
      .passkey({ flow: "autofill" })
      .then(async ({ error }) => {
        if (error || signIn.status !== "complete") return
        setBusy("passkey")

        // ⚠ RELEASED IF THE FINALIZE FAILS, or the page stays greyed out for
        // something the person never asked for. Everything before this point
        // fails silently by design; a lock is the one failure they can see, so
        // it is the one that has to be undone.
        const result = await finalizeAndLeave(
          (params) => signIn.finalize(params),
          afterAuthUrl,
        )
        if (result.error) setBusy(null)
      })
      .catch(() => setBusy(null))
  }, [signIn, afterAuthUrl])

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // ⚠ `signIn` IS NULL UNTIL CLERK LOADS. It is the only readiness signal the
    // hook gives; there is no `isLoaded` on this API.
    if (!signIn || busy) return

    const form = new FormData(event.currentTarget)
    setBusy("password")

    try {
      const { error } = await signIn.password({
        identifier: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
      })

      if (error) {
        toast.error(messageFor(error))
        setBusy(null)
        return
      }

      if (signIn.status === "complete") {
        /*
         * ⚠ `finalize` IS WHAT CREATES THE SESSION, and the helper is what gets
         * the browser out of here — see _lib/finish.ts for why the destination
         * is `replace`d and why the navigation is not left entirely to Clerk's
         * callback. The lock is deliberately NOT released on this path: the
         * page is leaving, and re-enabling a "Login" button for the second or
         * two that takes is an invitation to press it again.
         */
        const result = await finalizeAndLeave(
          (params) => signIn.finalize(params),
          afterAuthUrl,
        )
        if (result.error) {
          toast.error(messageFor(result.error))
          setBusy(null)
        }
        return
      }

      // ⚠ `needs_client_trust` IS NOT AN ERROR AND IS NOT RARE. It is Clerk's
      // device-trust step: the password was right, and the instance wants this
      // BROWSER proved with an emailed code before it hands over a session.
      // Treating it as unsupported — which this did — makes correct
      // credentials answer "contact support" on a fresh device, which is every
      // first sign-in.
      if (
        signIn.status === "needs_second_factor" ||
        signIn.status === "needs_client_trust"
      ) {
        // ⚠ `router.push`, NEVER `window.location`. The second-factor page
        // resumes THIS `signIn` out of Clerk's client state; a full page load
        // would start a fresh client with no attempt in progress and bounce the
        // person back to the beginning, having already given their password.
        // The lock stays on for the same reason as above — this page is going
        // away.
        router.push(mfaHref)
        return
      }

      // ⚠ ANYTHING ELSE IS A DEAD END *TODAY*, AND IT SAYS SO RATHER THAN
      // FAILING QUIETLY. `needs_new_password` — an admin forcing a change — is
      // the notable one still unhandled. Leaving the button spinning would be
      // the worst option; naming the state at least tells support what
      // happened.
      toast.error("This sign-in needs a step we do not support yet. Contact support.")
      setBusy(null)
    } catch {
      toast.error(TRANSPORT_FAILURE)
      setBusy(null)
    }
  }

  const locked = busy !== null

  return (
    <form className="flex flex-col gap-6" onSubmit={onSubmit} noValidate>
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold">Login to your account</h1>
          <p className="text-sm text-balance text-muted-foreground">
            Enter your email below to login to your account
          </p>
        </div>
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="m@example.com"
            // ⚠ `webauthn` ALONGSIDE `email`, AND BOTH TOKENS ARE REQUIRED.
            // This is the hook the conditional-mediation call above attaches
            // to: without it the browser has nowhere to surface a saved
            // passkey, and the effect silently does nothing.
            autoComplete="email webauthn"
            disabled={locked}
            required
          />
        </Field>
        <Field>
          <div className="flex items-center">
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Link
              href={resetHref}
              // ⚠ THE LINKS GO DEAD WITH THE BUTTONS, and they are the half
              // that is easy to forget. Navigating to "Forgot your password?"
              // mid-redirect abandons a flow that is already creating a session
              // — the person lands on a reset page for an account they were one
              // second from being signed in to.
              aria-disabled={locked}
              tabIndex={locked ? -1 : undefined}
              className={`ml-auto text-sm underline-offset-4 hover:underline ${
                locked ? "pointer-events-none opacity-50" : ""
              }`}
            >
              Forgot your password?
            </Link>
          </div>
          <PasswordInput
            id="password"
            name="password"
            // ⚠ `current-password`, NOT `password`. It is what tells a password
            // manager to offer the saved credential rather than to propose a
            // new one, and getting it wrong is how people end up with a second
            // entry for the same site.
            autoComplete="current-password"
            disabled={locked}
            required
          />
        </Field>
        {/*
         * ⚠ CLERK'S BOT PROTECTION MOUNTS ITSELF INTO THIS EXACT ID, AND ITS
         * ABSENCE IS A SILENT FAILURE — the same note as the sign-up form, and
         * it belongs here for a reason that is easy to miss. This page carries
         * no sign-up, but its SSO buttons pass `signUpIfMissing`, so a
         * "Continue with Google" from somebody who has never been here before
         * IS a sign-up, and bot protection applies to it. With no mount point
         * Clerk rejects the attempt rather than challenging it, which is what
         * `authorization_invalid` from FAPI turned out to be.
         */}
        <div id="clerk-captcha" />
        <Field>
          <Button type="submit" disabled={!signIn || locked}>
            {busy === "password" ? (
              <>
                {/*
                 * ⚠ `aria-hidden`, AND THE LABEL CARRIES THE STATE. The Spinner
                 * ships with `role="status"`; leaving that on next to text that
                 * already says "Signing in…" makes a screen reader announce the
                 * same thing twice.
                 */}
                <Spinner aria-hidden="true" aria-label={undefined} />
                Signing in…
              </>
            ) : (
              "Login"
            )}
          </Button>
        </Field>
        <FieldSeparator>Or continue with</FieldSeparator>
        <OAuthButtons
          afterAuthUrl={afterAuthUrl}
          redirectRaw={redirectRaw}
          providers={providers}
          busy={busy}
          onBusyChange={setBusy}
        />
        <FieldDescription className="text-center">
          <Link
            href={passkeyHref}
            aria-disabled={locked}
            tabIndex={locked ? -1 : undefined}
            className={`underline underline-offset-4 ${
              locked ? "pointer-events-none opacity-50" : ""
            }`}
          >
            Use a passkey instead
          </Link>
        </FieldDescription>
        <FieldDescription className="text-center">
          Don&apos;t have an account?{" "}
          <Link
            href={signUpHref}
            aria-disabled={locked}
            tabIndex={locked ? -1 : undefined}
            className={`underline underline-offset-4 ${
              locked ? "pointer-events-none opacity-50" : ""
            }`}
          >
            Sign up
          </Link>
        </FieldDescription>
      </FieldGroup>
    </form>
  )
}
