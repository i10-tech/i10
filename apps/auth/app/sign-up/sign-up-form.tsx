"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { useSignUp } from "@clerk/nextjs"
import { Button } from "@repo/ui/components/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@repo/ui/components/field"
import { Input } from "@repo/ui/components/input"
import { OtpField, OTP_LENGTH } from "../_components/otp-field"
import { ResendButton } from "../_components/resend-button"
import { PasswordInput } from "../_components/password-input"
import { OAuthButtons } from "../_components/oauth-buttons"
import { messageFor, TRANSPORT_FAILURE } from "../_lib/errors"

/*
 * shadcn's `signup-02`, wired to Clerk, plus the verification step the block
 * has no concept of.
 *
 * ⚠ SIGNING UP IS TWO ROUND TRIPS, NOT ONE, and the block only draws the first.
 * `signUp.create` returns `missing_requirements` because the address is
 * unverified; Clerk emails a code, and the account does not exist as a usable
 * session until that code comes back. Rendering the second step as its own
 * state of the same component — rather than a second route — keeps the
 * half-finished `signUp` object alive, which is what the code is checked
 * against.
 */
export function SignUpForm({
  afterAuthUrl,
  signInHref,
  redirectRaw,
}: {
  afterAuthUrl: string
  signInHref: string
  redirectRaw?: string
}) {
  const { signUp } = useSignUp()
  const [stage, setStage] = useState<"details" | "verify">("details")
  const [code, setCode] = useState("")
  const formRef = useRef<HTMLFormElement>(null)
  const [pending, setPending] = useState(false)

  async function onDetails(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // ⚠ `signUp` IS NULL UNTIL CLERK LOADS — the only readiness signal there is.
    if (!signUp || pending) return

    const form = new FormData(event.currentTarget)
    const password = String(form.get("password") ?? "")

    // ⚠ CHECKED HERE BECAUSE CLERK CANNOT CHECK IT. The confirmation field is
    // never sent — Clerk takes one password and has no idea a second box
    // existed. If this comparison is missing, a typo in both boxes is accepted
    // and the person is locked out of an account they just made.
    if (password !== String(form.get("confirm-password") ?? "")) {
      toast.error("Those passwords do not match.")
      return
    }

    setPending(true)

    try {
      // ⚠ SPLIT ON THE FIRST SPACE ONLY. The block asks for one "Full Name" and
      // Clerk stores two fields. Everything after the first space is the last
      // name, so "Ada King Lovelace" keeps "King Lovelace" together rather than
      // discarding a middle name — and a single-word name simply has no last
      // name, which Clerk accepts.
      const fullName = String(form.get("name") ?? "").trim()
      const gap = fullName.indexOf(" ")

      // ⚠ `password()`, NOT `create()` THEN A SEPARATE VERIFICATION CALL. On
      // this API `signUp.password` both creates the attempt and submits the
      // credential; `create` exists for flows that gather fields across several
      // screens, and using it here would leave a half-built attempt with no
      // password on it.
      const created = await signUp.password({
        emailAddress: String(form.get("email") ?? ""),
        password,
        firstName: gap === -1 ? fullName : fullName.slice(0, gap),
        lastName: gap === -1 ? undefined : fullName.slice(gap + 1),
      })

      if (created.error) {
        toast.error(messageFor(created.error))
        return
      }

      // Already done when the instance does not verify email addresses.
      if (signUp.status === "complete") {
        await signUp.finalize({
          navigate: ({ decorateUrl }) => {
            window.location.href = decorateUrl(afterAuthUrl)
          },
        })
        return
      }

      const sent = await signUp.verifications.sendEmailCode()
      if (sent.error) {
        toast.error(messageFor(sent.error))
        return
      }

      toast.success("We sent a code to your email.")
      setStage("verify")
    } catch {
      toast.error(TRANSPORT_FAILURE)
    } finally {
      setPending(false)
    }
  }

  async function onVerify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!signUp || pending) return

    setPending(true)

    try {
      const { error } = await signUp.verifications.verifyEmailCode({ code })

      if (error) {
        toast.error(messageFor(error))
        // A rejected six-digit code is never salvaged by editing one box.
        setCode("")
        return
      }

      if (signUp.status === "complete") {
        // Cross-origin, and `decorateUrl` carries Safari's cookie refresh —
        // see the sign-in form.
        await signUp.finalize({
          navigate: ({ decorateUrl }) => {
            window.location.href = decorateUrl(afterAuthUrl)
          },
        })
        return
      }

      toast.error(
        "That code was accepted, but the account still needs something we cannot collect yet.",
      )
    } catch {
      toast.error(TRANSPORT_FAILURE)
    } finally {
      setPending(false)
    }
  }

  if (stage === "verify") {
    return (
      // ⚠ `key` SO REACT CANNOT REUSE THE PREVIOUS STAGE'S DOM. Both stages are
      // one component returning a <form>, and React reconciles by position —
      // which is exactly how the name typed a moment earlier ended up sitting
      // inside the code box, waiting to be deleted. `OtpField` already breaks
      // the reuse by being a different component; this makes the guarantee
      // explicit rather than incidental to the markup.
      <form
        key="verify"
        ref={formRef}
        className="flex flex-col gap-6"
        onSubmit={onVerify}
        noValidate
      >
        <FieldGroup>
          <div className="flex flex-col items-center gap-1 text-center">
            <h1 className="text-2xl font-bold">Check your email</h1>
            <p className="text-sm text-balance text-muted-foreground">
              We sent a code to your address. Enter it below to finish.
            </p>
          </div>
          <OtpField
            value={code}
            onChange={setCode}
            // The code is the whole form here, so filling it is the decision.
            onComplete={() => {
              if (!pending) formRef.current?.requestSubmit()
            }}
            autoFocus
          />
          <Field>
            <Button type="submit" disabled={pending || code.length < OTP_LENGTH}>
              {pending ? "Verifying…" : "Verify email"}
            </Button>
          </Field>
          <ResendButton
            onResend={async () => {
              const { error } = await signUp.verifications.sendEmailCode()
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
    <form key="details" className="flex flex-col gap-6" onSubmit={onDetails} noValidate>
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold">Create your account</h1>
          <p className="text-sm text-balance text-muted-foreground">
            Fill in the form below to create your account
          </p>
        </div>
        <Field>
          <FieldLabel htmlFor="name">Full Name</FieldLabel>
          <Input
            id="name"
            name="name"
            type="text"
            placeholder="John Doe"
            autoComplete="name"
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="m@example.com"
            autoComplete="email"
            required
          />
          <FieldDescription>
            We&apos;ll use this to contact you. We will not share your email with anyone
            else.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <PasswordInput
            id="password"
            name="password"

            autoComplete="new-password"
            required
          />
          <FieldDescription>Must be at least 8 characters long.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="confirm-password">Confirm Password</FieldLabel>
          <PasswordInput
            id="confirm-password"
            name="confirm-password"

            autoComplete="new-password"
            required
          />
          <FieldDescription>Please confirm your password.</FieldDescription>
        </Field>
        {/*
         * ⚠ CLERK'S BOT PROTECTION MOUNTS ITSELF INTO THIS EXACT ID, AND ITS
         * ABSENCE IS A SILENT FAILURE. With Smart CAPTCHA enabled on the
         * instance and no `#clerk-captcha` in the DOM, `signUp.create` either
         * falls back to an invisible widget or rejects the attempt outright —
         * and the person sees a sign-up that simply refuses, with nothing on
         * screen to act on. The pre-built <SignUp /> renders this for you;
         * a custom flow has to.
         */}
        <div id="clerk-captcha" />
        <Field>
          <Button type="submit" disabled={!signUp || pending}>
            {pending ? "Creating account…" : "Create Account"}
          </Button>
        </Field>
        <FieldSeparator>Or continue with</FieldSeparator>
        <OAuthButtons
          afterAuthUrl={afterAuthUrl}
          redirectRaw={redirectRaw}
          verb="Sign up"
        />
        <FieldDescription className="px-6 text-center">
          Already have an account?{" "}
          <Link href={signInHref} className="underline underline-offset-4">
            Sign in
          </Link>
        </FieldDescription>
      </FieldGroup>
    </form>
  )
}
