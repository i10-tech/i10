"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { useClerk, useSignIn } from "@clerk/nextjs"
import { Button } from "@repo/ui/components/button"
import { Field, FieldDescription, FieldGroup } from "@repo/ui/components/field"
import { ValidatedInput } from "@repo/ui/components/validated-field"
import { emailProblem } from "@repo/ui/checks"
import { OtpField, OTP_LENGTH } from "../_components/otp-field"
import { ResendButton } from "../_components/resend-button"
import { PasswordInput } from "../_components/password-input"
import { messageFor, TRANSPORT_FAILURE } from "../_lib/errors"
import { describeRules, passwordProblem } from "../_lib/validate"
import type { PasswordRules } from "../_lib/environment"
import { finalizeAndLeave } from "../_lib/finish"
import { useResumable, useResumeLive } from "../_lib/resume"

/*
 * Forgotten password, in Clerk's stable three-call shape.
 *
 *   1. `signIn.create({ identifier })`                     — names the account
 *   2. `signIn.resetPasswordEmailCode.sendCode()`          — emails a code
 *   3. `resetPasswordEmailCode.verifyCode({ code })`       — accepts it
 *   4. `resetPasswordEmailCode.submitPassword({ password })` — sets the password
 *
 * ⚠ STEPS 3 AND 4 ARE ONE SCREEN BUT TWO CALLS, and they cannot be collapsed.
 * The code has to be accepted before Clerk will take a new password — sending
 * both at once fails — so the form gathers them together and the handler makes
 * the calls in order. Splitting them across two screens would be honest to the
 * API and worse for the person, who would be asked to prove themselves twice.
 *
 * ⚠ THIS PAGE IS NOT REACHED WITH THE PERSON'S MAILBOX. The code goes to the
 * address they signed up with — a Gmail, a work address — which is exactly why
 * a mailbox customer who forgets their password is not locked out of their own
 * recovery. The i10 mailbox is never the recovery channel for the account that
 * owns it.
 */
export function ResetPasswordForm({
  afterAuthUrl,
  signInHref,
  passwordPolicy,
}: {
  afterAuthUrl: string
  signInHref: string
  /** Read from the Clerk instance by the page. See _lib/environment.ts. */
  passwordPolicy: PasswordRules
}) {
  const { signIn } = useSignIn()
  const clerk = useClerk()
  // ⚠ THE STEP AND THE ADDRESS SURVIVE A RELOAD; THE CODE AND THE NEW PASSWORD
  // DO NOT. See _lib/resume.tsx.
  const [stage, setStage] = useResumable<"email" | "reset">("reset.stage", "email")
  const [code, setCode] = useState("")
  /*
   * ⚠ CONTROLLED NOW, BECAUSE A FIELD CANNOT JUDGE A VALUE IT CANNOT SEE. This
   * form read everything out of `FormData` at submit time, which is why it was
   * the one auth form with no validation at all: nothing on screen knew what
   * had been typed until the button was pressed.
   */
  const [email, setEmail] = useResumable("reset.email", "")

  /*
   * ⚠ A RESTORED CODE STEP IS CHECKED AGAINST CLERK ONCE IT HAS LOADED. The
   * code box only means something while Clerk still holds a reset attempt for
   * this address; an expired one goes back to the address, which is where
   * "send me a code" lives. A listener rather than a check in the effect body,
   * because the answer arrives after this mounts.
   */
  const live = useResumeLive()
  useEffect(() => {
    if (!live || stage !== "reset") return
    let done = false
    const unsubscribe = clerk.addListener(() => {
      if (done || !clerk.loaded) return
      done = true
      const attempt = clerk.client?.signIn
      const resetting =
        attempt?.id != null &&
        attempt.status === "needs_first_factor" &&
        attempt.identifier === email.trim() &&
        attempt.firstFactorVerification?.strategy === "reset_password_email_code"
      if (!resetting) setStage("email")
    })
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount, see above
  }, [live, clerk])
  const [password, setPassword] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const secretProblem = passwordProblem(passwordPolicy)
  /** Why the last code was refused, shown under the boxes until it is retyped. */
  const [rejected, setRejected] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!signIn || pending) return

    setPending(true)

    try {
      // ⚠ NO `strategy` HERE. On this API `create` only names the account; the
      // strategy is chosen by which namespace sends the code below. Passing
      // `reset_password_email_code` to `create` does not type-check, and the
      // classic flow that did is a different API.
      const created = await signIn.create({ identifier: email.trim() })

      if (created.error) {
        toast.error(messageFor(created.error))
        return
      }

      const sent = await signIn.resetPasswordEmailCode.sendCode()
      if (sent.error) {
        toast.error(messageFor(sent.error))
        return
      }

      toast.success("We sent you a code.")
      setStage("reset")
    } catch {
      toast.error(TRANSPORT_FAILURE)
    } finally {
      setPending(false)
    }
  }

  async function onReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!signIn || pending) return

    /*
     * ⚠ THE MISMATCH IS THE CONFIRMATION FIELD'S OWN BUSINESS NOW. It used to
     * be a toast fired after the button was pressed — a message that slides
     * away, about two boxes it does not point at, for a mistake you can only
     * see by comparing two rows of dots. The field says it under itself, in
     * red, the moment the caret leaves.
     */
    setPending(true)

    try {
      const verified = await signIn.resetPasswordEmailCode.verifyCode({ code })

      if (verified.error) {
        /*
         * ⚠ UNDER THE BOXES RATHER THAN IN A TOAST. See mfa-form: a toast slides
         * away and leaves the field looking exactly as it did before the code
         * was judged, which is the state somebody is in when they retype the
         * same wrong code.
         */
        setRejected(messageFor(verified.error))
        setCode("")
        return
      }

      const done = await signIn.resetPasswordEmailCode.submitPassword({
        password,
        // ⚠ TRUE, AND IT IS A SECURITY DEFAULT RATHER THAN A PREFERENCE. The
        // common reason to reset a password is that somebody else may know the
        // old one. Leaving their other sessions alive would change the lock and
        // let the intruder keep walking through the open door.
        signOutOfOtherSessions: true,
      })

      if (done.error) {
        toast.error(messageFor(done.error))
        return
      }

      if (signIn.status === "complete") {
        // Cross-origin, and `decorateUrl` carries Safari's cookie refresh —
        // see the sign-in form. `finalizeAndLeave` also replaces rather than
        // assigns, and navigates itself if Clerk's callback never runs: see
        // _lib/finish.ts for the phone-shaped bug both of those close.
        const result = await finalizeAndLeave(
          (params) => signIn.finalize(params),
          afterAuthUrl,
        )
        if (result.error) toast.error(messageFor(result.error))
        return
      }

      toast.error(
        signIn.status === "needs_second_factor"
          ? "Your password was changed. Signing in needs a second factor, which this page cannot do yet."
          : "Your password was changed, but signing in needs another step.",
      )
    } catch {
      toast.error(TRANSPORT_FAILURE)
    } finally {
      setPending(false)
    }
  }

  if (stage === "reset") {
    return (
      <form key="reset" className="flex flex-col gap-6" onSubmit={onReset} noValidate>
        <FieldGroup>
          <div className="flex flex-col items-center gap-1 text-center">
            <h1 className="text-2xl font-bold">Choose a new password</h1>
            <p className="text-sm text-balance text-muted-foreground">
              Enter the code we emailed you, and the password you want instead.
            </p>
          </div>
          {/*
           * ⚠ NO `onComplete` HERE, UNLIKE THE OTHER TWO SCREENS. The boxes sit
           * above two password fields, so auto-submitting the instant the sixth
           * digit lands would send an empty password and burn the code.
           */}
          <OtpField
            value={code}
            onChange={(next) => {
              setRejected(null)
              setCode(next)
            }}
            state={rejected ? "invalid" : "idle"}
            hint={rejected}
            autoFocus
          />
          <PasswordInput
            id="password"
            name="password"
            label="New password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            check={secretProblem}
            required="Choose a password."
            // ⚠ THE INSTANCE'S OWN RULE. This said "At least 8 characters."
            // while Clerk required fifteen. See the page, which reads it.
            hint={describeRules(passwordPolicy)}
            autoComplete="new-password"
          />
          <PasswordInput
            id="confirm-password"
            name="confirm-password"
            label="Confirm new password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            /*
             * ⚠ THE RULE IS ABOUT ANOTHER FIELD, AND THAT IS FINE — a `Check`
             * is an ordinary closure, so "matches the box above" is expressed
             * the same way "is an email address" is. It does not repeat the
             * policy: a confirmation that does not match is the only thing
             * this box can be wrong about.
             */
            check={(value) =>
              value === password ? null : "Those passwords do not match."
            }
            required="Type the password again."
            autoComplete="new-password"
          />
          <Field>
            <Button
              type="submit"
              size="xl"
              disabled={pending || code.length < OTP_LENGTH}
            >
              {pending ? "Saving…" : "Set new password"}
            </Button>
          </Field>
          <ResendButton
            onResend={async () => {
              const { error } = await signIn.resetPasswordEmailCode.sendCode()
              if (error) {
                toast.error(messageFor(error))
                return
              }
              toast.success("We sent another code.")
            }}
          />
        </FieldGroup>
      </form>
    )
  }

  return (
    <form key="email" className="flex flex-col gap-6" onSubmit={onEmail} noValidate>
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold">Reset your password</h1>
          <p className="text-sm text-balance text-muted-foreground">
            Enter your email and we&apos;ll send you a code.
          </p>
        </div>
        <ValidatedInput
          id="email"
          name="email"
          type="email"
          label="Email address"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          check={emailProblem}
          required="Enter your email address."
          autoComplete="email"
        />
        <Field>
          {/*
           * ⚠ `xl`, THE SAME AS THE "Continue" IT SITS ONE CLICK FROM. See the
           * size in @repo/ui/components/button: 56px is the field height, so
           * the button under a field reads as the same object continuing. This
           * page was the default 36px, which is a different product.
           */}
          <Button type="submit" size="xl" disabled={!signIn || pending}>
            {pending ? "Sending…" : "Send code"}
          </Button>
        </Field>
        <FieldDescription className="text-center">
          Remembered it?{" "}
          <Link href={signInHref} className="underline underline-offset-4">
            Sign in
          </Link>
        </FieldDescription>
      </FieldGroup>
    </form>
  )
}
