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
import { Spinner } from "@repo/ui/components/spinner"
import { OtpField, OTP_LENGTH } from "../_components/otp-field"
import { ResendButton } from "../_components/resend-button"
import { PasswordInput } from "../_components/password-input"
import { OAuthButtons } from "../_components/oauth-buttons"
import { messageFor, TRANSPORT_FAILURE } from "../_lib/errors"
import { finalizeAndLeave } from "../_lib/finish"

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
 *
 * ⚠ ONE `busy` FOR THE WHOLE PAGE — see the sign-in form for the race it
 * closes. It matters more here, because a half-built `signUp` is real state on
 * the client: starting Google while an email attempt is mid-verification leaves
 * two attempts on one client and the second one wins.
 */
export function SignUpForm({
  afterAuthUrl,
  signInHref,
  redirectRaw,
  showApple,
}: {
  afterAuthUrl: string
  signInHref: string
  redirectRaw?: string
  showApple: boolean
}) {
  const { signUp } = useSignUp()
  const [stage, setStage] = useState<"details" | "verify">("details")
  const [code, setCode] = useState("")
  const formRef = useRef<HTMLFormElement>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function onDetails(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // ⚠ `signUp` IS NULL UNTIL CLERK LOADS — the only readiness signal there is.
    if (!signUp || busy) return

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

    setBusy("details")

    try {
      /*
       * ⚠ TWO FIELDS, NOT ONE "Full Name" SPLIT ON THE FIRST SPACE. The block
       * ships a single name box and Clerk stores `firstName` and `lastName`, so
       * this used to guess at the boundary — which is only ever right for
       * people whose names happen to be shaped like the guess. "Ana María
       * García" became a first name of "Ana", and anyone with one word for a
       * name got no surname at all. Asking is both correct and shorter than the
       * comment explaining why splitting was not.
       *
       * ⚠ `lastName` GOES UNDEFINED RATHER THAN EMPTY when it is blank. Clerk
       * accepts a missing last name; an empty string is a value, and it is the
       * value that shows up later as a trailing space in every greeting.
       */
      const firstName = String(form.get("first-name") ?? "").trim()
      const lastName = String(form.get("last-name") ?? "").trim()

      // ⚠ `password()`, NOT `create()` THEN A SEPARATE VERIFICATION CALL. On
      // this API `signUp.password` both creates the attempt and submits the
      // credential; `create` exists for flows that gather fields across several
      // screens, and using it here would leave a half-built attempt with no
      // password on it.
      const created = await signUp.password({
        emailAddress: String(form.get("email") ?? ""),
        password,
        firstName,
        lastName: lastName || undefined,
      })

      if (created.error) {
        toast.error(messageFor(created.error))
        setBusy(null)
        return
      }

      // Already done when the instance does not verify email addresses.
      if (signUp.status === "complete") {
        /*
         * ⚠ NO `finally` RELEASING THE LOCK ON THIS PATH, WHICH IS WHY THE
         * RELEASES ARE WRITTEN OUT ONE BY ONE ABOVE AND BELOW. A `finally`
         * cannot tell "this failed, give the form back" from "this succeeded
         * and the browser is leaving" — and re-enabling a Create Account button
         * during the redirect that follows a successful sign-up is how somebody
         * presses it a second time and gets told the address is taken.
         */
        const result = await finalizeAndLeave(
          (params) => signUp.finalize(params),
          afterAuthUrl,
        )
        if (result.error) {
          toast.error(messageFor(result.error))
          setBusy(null)
        }
        return
      }

      const sent = await signUp.verifications.sendEmailCode()
      if (sent.error) {
        toast.error(messageFor(sent.error))
        setBusy(null)
        return
      }

      toast.success("We sent a code to your email.")
      setStage("verify")
      setBusy(null)
    } catch {
      toast.error(TRANSPORT_FAILURE)
      setBusy(null)
    }
  }

  async function onVerify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!signUp || busy) return

    setBusy("verify")

    try {
      const { error } = await signUp.verifications.verifyEmailCode({ code })

      if (error) {
        toast.error(messageFor(error))
        // A rejected six-digit code is never salvaged by editing one box.
        setCode("")
        setBusy(null)
        return
      }

      if (signUp.status === "complete") {
        /*
         * ⚠ THE LOCK IS HELD THROUGH THE REDIRECT, AND THAT IS WHY THE BUTTON
         * NOW SAYS "Taking you in…". This step is where sign-up on a phone
         * appeared to hang: the code was accepted, the session was created, and
         * the page went back to looking like a sign-up form. See _lib/finish.ts
         * — the destination is `replace`d rather than assigned so the finished
         * page is not one back-swipe away, and the helper navigates itself if
         * Clerk's callback never runs. Releasing `busy` here would additionally
         * re-render the whole form underneath a navigation already in progress.
         */
        const result = await finalizeAndLeave(
          (params) => signUp.finalize(params),
          afterAuthUrl,
        )
        if (result.error) {
          toast.error(messageFor(result.error))
          setBusy(null)
        }
        return
      }

      toast.error(
        "That code was accepted, but the account still needs something we cannot collect yet.",
      )
      setBusy(null)
    } catch {
      toast.error(TRANSPORT_FAILURE)
      setBusy(null)
    }
  }

  const locked = busy !== null

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
              if (!locked) formRef.current?.requestSubmit()
            }}
            autoFocus
          />
          <Field>
            <Button type="submit" disabled={locked || code.length < OTP_LENGTH}>
              {busy === "verify" ? (
                <>
                  <Spinner aria-hidden="true" aria-label={undefined} />
                  {/*
                   * ⚠ THE COPY DESCRIBES THE WHOLE WAIT, NOT JUST THE CALL.
                   * Verification and the redirect that follows it are one
                   * uninterrupted pause from where the person is sitting;
                   * "Verifying…" that stays on screen while a page loads reads
                   * as stuck, which is precisely the complaint this step drew.
                   */}
                  Taking you in…
                </>
              ) : (
                "Verify email"
              )}
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
        {/*
         * ⚠ SIDE BY SIDE ONLY ONCE THERE IS ROOM. Two 40px-tall boxes sharing a
         * 360px phone screen leaves each one narrower than the name it holds,
         * and a field you have to scroll horizontally to read back is worse
         * than a field on its own row. `sm:` is the same breakpoint the rest of
         * this page's max-width is pitched at.
         */}
        <div className="grid gap-7 sm:grid-cols-2 sm:gap-4">
          <Field>
            <FieldLabel htmlFor="first-name">First name</FieldLabel>
            <Input
              id="first-name"
              name="first-name"
              type="text"
              placeholder="Ada"
              autoComplete="given-name"
              disabled={locked}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="last-name">Last name</FieldLabel>
            <Input
              id="last-name"
              name="last-name"
              type="text"
              placeholder="Lovelace"
              autoComplete="family-name"
              disabled={locked}
              // ⚠ NOT `required`, DELIBERATELY. Plenty of people have one legal
              // name, and Clerk stores a sign-up with no last name without
              // complaint. A required surname is a form that cannot be
              // completed truthfully by someone who has none.
            />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="m@example.com"
            autoComplete="email"
            disabled={locked}
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
            disabled={locked}
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
            disabled={locked}
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
          <Button type="submit" disabled={!signUp || locked}>
            {busy === "details" ? (
              <>
                <Spinner aria-hidden="true" aria-label={undefined} />
                Creating account…
              </>
            ) : (
              "Create Account"
            )}
          </Button>
        </Field>
        <FieldSeparator>Or continue with</FieldSeparator>
        <OAuthButtons
          afterAuthUrl={afterAuthUrl}
          redirectRaw={redirectRaw}
          verb="Sign up"
          showApple={showApple}
          busy={busy}
          onBusyChange={setBusy}
        />
        <FieldDescription className="px-6 text-center">
          Already have an account?{" "}
          <Link
            href={signInHref}
            aria-disabled={locked}
            tabIndex={locked ? -1 : undefined}
            className={`underline underline-offset-4 ${
              locked ? "pointer-events-none opacity-50" : ""
            }`}
          >
            Sign in
          </Link>
        </FieldDescription>
      </FieldGroup>
    </form>
  )
}
