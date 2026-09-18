"use client"

import { useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { useSignIn } from "@clerk/nextjs"
import { Button } from "@repo/ui/components/button"
import { Field, FieldDescription, FieldGroup } from "@repo/ui/components/field"
import { FloatingInput } from "@repo/ui/components/floating-field"
import { OtpField, OTP_LENGTH } from "../_components/otp-field"
import { ResendButton } from "../_components/resend-button"
import { PasswordInput } from "../_components/password-input"
import { messageFor, TRANSPORT_FAILURE } from "../_lib/errors"
import { finalizeAndLeave } from "../_lib/finish"

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
}: {
  afterAuthUrl: string
  signInHref: string
}) {
  const { signIn } = useSignIn()
  const [stage, setStage] = useState<"email" | "reset">("email")
  const [code, setCode] = useState("")
  const [pending, setPending] = useState(false)

  async function onEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!signIn || pending) return

    const form = new FormData(event.currentTarget)
    setPending(true)

    try {
      // ⚠ NO `strategy` HERE. On this API `create` only names the account; the
      // strategy is chosen by which namespace sends the code below. Passing
      // `reset_password_email_code` to `create` does not type-check, and the
      // classic flow that did is a different API.
      const created = await signIn.create({
        identifier: String(form.get("email") ?? ""),
      })

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

    const form = new FormData(event.currentTarget)
    const password = String(form.get("password") ?? "")

    if (password !== String(form.get("confirm-password") ?? "")) {
      toast.error("Those passwords do not match.")
      return
    }

    setPending(true)

    try {
      const verified = await signIn.resetPasswordEmailCode.verifyCode({ code })

      if (verified.error) {
        toast.error(messageFor(verified.error))
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
          <OtpField value={code} onChange={setCode} autoFocus />
          <PasswordInput
            id="password"
            name="password"
            label="New password"
            autoComplete="new-password"
            required
            hint="At least 8 characters."
          />
          <PasswordInput
            id="confirm-password"
            name="confirm-password"
            label="Confirm new password"
            autoComplete="new-password"
            required
          />
          <Field>
            <Button type="submit" disabled={pending || code.length < OTP_LENGTH}>
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
        <FloatingInput
          id="email"
          name="email"
          type="email"
          label="Email address"
          autoComplete="email"
          required
        />
        <Field>
          <Button type="submit" disabled={!signIn || pending}>
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
