"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"
import { toast } from "sonner"
import { useClerk, useSignUp } from "@clerk/nextjs"
import { Button } from "@repo/ui/components/button"
import { FieldDescription, FieldGroup } from "@repo/ui/components/field"
import { FloatingInput } from "@repo/ui/components/floating-field"
import { Spinner } from "@repo/ui/components/spinner"
import { StepProgress } from "@repo/ui/components/step-progress"
import { StepStage } from "@repo/ui/components/step-stage"
import { OtpField, OTP_LENGTH } from "../_components/otp-field"
import { ResendButton } from "../_components/resend-button"
import { PasswordInput } from "../_components/password-input"
import { StepHeading } from "../_components/step-heading"
import { messageFor, TRANSPORT_FAILURE } from "../_lib/errors"
import { finalizeWithoutLeaving, leaveFor } from "../_lib/finish"
import type { SignUpAbilities } from "../_lib/environment"
import type { SsoProvider } from "../_lib/providers"
import {
  BackupCodesStep,
  ConnectStep,
  PasskeyStep,
  TwoFactorOfferStep,
  TwoFactorScanStep,
  type TotpEnrolment,
} from "./secure-steps"

/*
 * Signing up, one question at a time.
 *
 * ⚠ THE FLOW HAS A SEAM IN THE MIDDLE OF IT, AND EVERYTHING ELSE FOLLOWS FROM
 * THAT. The first four steps BUILD an account: name, surname, credentials, and
 * the emailed code Clerk will not skip. The last three ENRICH one that already
 * exists — a passkey, an authenticator app, a linked provider — and every one of
 * those is a method on `UserResource`, which does not exist until a session
 * does. So `finalize()` is called in the middle of the flow rather than at the
 * end of it, and the browser is only sent onward once the person is finished
 * being offered things. See `finalizeWithoutLeaving` in _lib/finish.ts.
 *
 * ⚠ THE EMAIL CODE SITS WHERE IT DOES BECAUSE IT CANNOT SIT ANYWHERE ELSE. It
 * is not part of the requested order — that was "first name, last name, email
 * and password, passkey, two-factor, providers" — but the three steps after it
 * need a session, the session needs a complete sign-up, and the sign-up is not
 * complete until the address is verified. Putting it later would mean offering
 * a passkey to somebody who does not yet have an account to attach it to.
 *
 * ⚠ HOW MANY STEPS THERE ARE IS DECIDED BY CLERK, NOT BY THIS FILE. An instance
 * with passkeys off simply has no passkey step and a shorter progress bar — see
 * _lib/environment.ts. The alternative is a step that opens a WebAuthn prompt
 * and then fails, which is how a "Continue with Apple" button once shipped for
 * a provider the instance had never had.
 *
 * ⚠ AND THERE IS STILL ONE `busy` FOR THE WHOLE PAGE. A half-built `signUp` is
 * real state on the client; two flows against one Clerk client means the second
 * wins and the first fails with something unrelated to what anybody did.
 */

/**
 * ⚠ THE SUB-STAGES OF TWO-FACTOR ARE STAGES, NOT STATE INSIDE A COMPONENT.
 * Offering it, scanning the code and saving the recovery codes are three full
 * screens, and they have to animate and morph like every other step — which
 * means they have to be keys the one `StepStage` can see. A nested stage would
 * be a second `layout` animation inside the first, both measuring the same box.
 */
type Stage =
  | "name"
  | "surname"
  | "credentials"
  | "verify"
  | "passkey"
  | "totp-offer"
  | "totp-scan"
  | "totp-codes"
  | "connect"

/** The four that build the account. Always present, always in this order. */
const ACCOUNT_STAGES = ["name", "surname", "credentials", "verify"] as const

/**
 * ⚠ THE THREE TWO-FACTOR SCREENS COUNT AS ONE SEGMENT. The progress bar
 * measures how much of the FLOW is left, and "turn on two-factor" is one
 * decision — a bar that grew two extra segments the moment somebody said yes
 * would punish them for it.
 */
const SEGMENT: Record<Stage, Stage> = {
  name: "name",
  surname: "surname",
  credentials: "credentials",
  verify: "verify",
  passkey: "passkey",
  "totp-offer": "totp-offer",
  "totp-scan": "totp-offer",
  "totp-codes": "totp-offer",
  connect: "connect",
}

export function SignUpForm({
  afterAuthUrl,
  signInHref,
  redirectRaw,
  providers,
  abilities,
  startAt,
  alreadySignedIn,
}: {
  afterAuthUrl: string
  signInHref: string
  redirectRaw?: string
  providers: SsoProvider[]
  /** What this Clerk instance can actually finish. See _lib/environment.ts. */
  abilities: SignUpAbilities
  /**
   * The step to open on, when the browser is coming back from a provider.
   *
   * ⚠ RESOLVED ON THE SERVER RATHER THAN IN AN EFFECT HERE, AND THE REASON IS
   * VISIBLE RATHER THAN THEORETICAL. Clerk does not know whether there is a
   * session until it has loaded in the browser, so a client-side resume renders
   * "What is your name?" first and corrects itself a frame later — meaning
   * everybody returning from Google sees step one of a sign-up they have
   * already completed. The server knows before it sends any markup.
   */
  startAt?: Stage
  /** There is already a session, and no step to resume onto. */
  alreadySignedIn: boolean
}) {
  const { signUp } = useSignUp()
  const clerk = useClerk()

  const [stage, setStage] = useState<Stage>(startAt ?? "name")
  const [direction, setDirection] = useState<"forward" | "back">("forward")
  const [busy, setBusy] = useState<string | null>(null)

  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [email, setEmail] = useState("")
  const [code, setCode] = useState("")
  const [totp, setTotp] = useState<TotpEnrolment | null>(null)
  const [backupCodes, setBackupCodes] = useState<string[]>([])

  const formRef = useRef<HTMLFormElement>(null)

  /**
   * How to get out of here once the optional steps are done.
   *
   * ⚠ A REF HOLDING A CLOSURE, BECAUSE THE DESTINATION IS DECORATED BY CLERK AT
   * FINALIZE TIME AND CANNOT BE ASKED FOR AGAIN. `decorateUrl` is offered only
   * inside `finalize`'s navigate callback; `clerk.buildUrlWithAuth` is not an
   * equivalent — its own type says "for development instances" and it does not
   * produce the production ITP hop. See _lib/finish.ts.
   */
  const leaveRef = useRef<(() => void) | null>(null)

  /** The steps this instance can offer, in the order they were asked for. */
  const optional: Stage[] = [
    abilities.passkey ? ("passkey" as const) : null,
    abilities.totp ? ("totp-offer" as const) : null,
    providers.length > 0 ? ("connect" as const) : null,
  ].filter((step) => step !== null)

  const order: Stage[] = [...ACCOUNT_STAGES, ...optional]
  const segment = SEGMENT[stage]
  const isLastStep = order.indexOf(segment) === order.length - 1

  /**
   * Somebody who is already signed in, with no step to resume onto.
   *
   * ⚠ AN EFFECT THAT ONLY NAVIGATES, AND SETS NO STATE. Which step to open on
   * is decided by the server — see `startAt` above — so all that is left here
   * is the side effect proper. That also covers a reload in the middle of the
   * optional steps: the account is already made, they are already in, and the
   * honest answer is to take them where they were going rather than to re-offer
   * a passkey.
   *
   * ⚠ IT CANNOT BE A SERVER REDIRECT, WHICH IS WHY IT SURVIVED THE MOVE ABOVE.
   * The destination is a different subdomain, and in development Clerk carries
   * the session across one by decorating the URL with `__clerk_db_jwt` — which
   * only `clerk.buildUrlWithAuth` can add, in the browser. A server-side
   * `redirect()` would land on the console with no session and bounce straight
   * back here.
   */
  /*
   * ⚠ LATCHED AT FIRST RENDER, AND WITHOUT THIS THE WHOLE FLOW ENDS AT THE
   * PASSKEY STEP. `alreadySignedIn` is a PROP computed from `auth()` on the
   * server, and this page re-renders on the server DURING the flow: `finalize`
   * calls `setActive`, and `@clerk/nextjs` installs
   * `window.__internal_onAfterSetActive = () => router.refresh()`. That refresh
   * re-runs the server component with the session this form just created, so
   * the prop flips from false to true the instant the account exists — and the
   * effect below reads that as "somebody wandered in already signed in" and
   * leaves for the dashboard, skipping passkey, two-factor and the providers.
   *
   * ⚠ IT PRESENTS AS A PHONE BUG, WHICH IS THE TELL. Whether the refresh lands
   * before or after the person presses the next button is a race, and the same
   * race is already written up in _lib/finish.ts — on a laptop the flow usually
   * wins, on a phone the refresh does. Same code, opposite outcome, entirely
   * down to which finished first.
   *
   * `useState` with an initialiser captures the value from the FIRST render and
   * ignores every later prop, which is exactly the question being asked: was
   * there a session before this form did anything?
   */
  const [arrivedSignedIn] = useState(alreadySignedIn)

  useEffect(() => {
    if (!arrivedSignedIn || !clerk.loaded) return
    leaveFor(clerk.buildUrlWithAuth(afterAuthUrl))
  }, [arrivedSignedIn, clerk, afterAuthUrl])

  /** The next step, or out. */
  function advance(from: Stage = stage) {
    const next = order[order.indexOf(SEGMENT[from]) + 1]
    setDirection("forward")
    if (next) {
      setStage(next)
      return
    }
    finish()
  }

  function goBack(to: Stage) {
    setDirection("back")
    setStage(to)
  }

  function finish() {
    const leave = leaveRef.current
    if (leave) {
      leave()
      return
    }
    // Resumed after a provider round trip: no finalize happened on this page
    // load, so there is no decorated URL to reuse.
    leaveFor(clerk.buildUrlWithAuth(afterAuthUrl))
  }

  /**
   * Create the account, and ask for the emailed code.
   *
   * ⚠ `password()`, NOT `create()` THEN A SEPARATE VERIFICATION CALL. On this
   * API `signUp.password` both creates the attempt and submits the credential;
   * `create` exists for flows that gather fields across several screens, and
   * using it here would leave a half-built attempt with no password on it.
   *
   * ⚠ THE NAMES COLLECTED TWO STEPS AGO ARE SENT HERE, NOT EARLIER. There is no
   * attempt to attach them to until this call, which is the honest reason the
   * first two steps do nothing but hold a string: they are asking, not saving.
   */
  async function onCredentials(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!signUp || busy) return

    const form = new FormData(event.currentTarget)
    const password = String(form.get("password") ?? "")

    setBusy("credentials")

    try {
      const created = await signUp.password({
        emailAddress: email.trim(),
        password,
        firstName: firstName.trim(),
        // ⚠ UNDEFINED RATHER THAN EMPTY when it is blank. Clerk accepts a
        // missing last name; an empty string is a value, and it is the value
        // that shows up later as a trailing space in every greeting.
        lastName: lastName.trim() || undefined,
      })

      if (created.error) {
        toast.error(messageFor(created.error))
        setBusy(null)
        return
      }

      // Already done when the instance does not verify email addresses.
      if (signUp.status === "complete") {
        await createSession()
        return
      }

      const sent = await signUp.verifications.sendEmailCode()
      if (sent.error) {
        toast.error(messageFor(sent.error))
        setBusy(null)
        return
      }

      toast.success("We sent a code to your email.")
      setDirection("forward")
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
        await createSession()
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

  /**
   * ⚠ THE LOCK IS RELEASED HERE, WHICH IS THE OPPOSITE OF EVERY OTHER FLOW IN
   * THIS APP AND IS CORRECT FOR THIS ONE. Elsewhere `finalize` is immediately
   * followed by leaving, so re-enabling a button during the redirect is an
   * invitation to press it twice. Here the page is STAYING — there are steps
   * after this one — so holding the lock would grey out the passkey button the
   * person is about to be shown.
   */
  async function createSession() {
    if (!signUp) return

    const { result, leave } = await finalizeWithoutLeaving(
      (params) => signUp.finalize(params),
      afterAuthUrl,
    )

    if (result.error) {
      toast.error(messageFor(result.error))
      setBusy(null)
      return
    }

    leaveRef.current = leave
    setBusy(null)

    const next = optional[0]
    setDirection("forward")
    if (next) {
      setStage(next)
      return
    }
    leave()
  }

  const locked = busy !== null

  /**
   * ⚠ BACK IS OFFERED ONLY WHERE GOING BACK IS HARMLESS. The first three steps
   * hold nothing but strings, so returning to one is free. From `verify`
   * onwards there is an attempt on Clerk's servers and then a real account, and
   * a back arrow that appeared to undo those would be lying — the address is
   * changed from the verify step's own "Change" control instead, which re-runs
   * the call rather than pretending it never happened.
   */
  const backTo: Partial<Record<Stage, Stage>> = {
    surname: "name",
    credentials: "surname",
  }
  const back = backTo[stage]

  return (
    <div className="flex flex-col gap-6">
      {/*
       * ⚠ THE CHROME SITS OUTSIDE THE STAGE SO IT DOES NOT MOVE WITH IT. A
       * progress bar that slid sideways with each pane would be measuring
       * itself; the point of it is to be the one thing that stays still while
       * the content changes.
       */}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => back && goBack(back)}
          disabled={!back || locked}
          // ⚠ `invisible`, NOT UNMOUNTED. Removing the button would let the
          // progress bar jump left by 32px between step one and step two, which
          // is the one element on the page whose job is to not move.
          className={back ? undefined : "invisible"}
          aria-label="Back"
        >
          <ArrowLeftIcon aria-hidden="true" />
        </Button>
        <StepProgress
          total={order.length}
          current={order.indexOf(segment) + 1}
          label="Sign-up progress"
        />
        {/*
         * ⚠ AN EMPTY BOX THE WIDTH OF THE BACK BUTTON, AND IT IS NOT A HACK.
         * The bar is the one element on this page whose job is to sit still and
         * be measured by eye; with a 32px control on its left and nothing on
         * its right it is centred on neither the card nor itself, and every
         * step makes it look 16px too far right. Matching the arrow on the
         * other side costs nothing and makes the bar concentric with the field
         * below it.
         */}
        <div aria-hidden className="size-8 shrink-0" />
      </div>

      <StepStage step={stage} direction={direction}>
        {stage === "name" ? (
          <form
            className="flex flex-col gap-6"
            onSubmit={(event) => {
              event.preventDefault()
              if (firstName.trim()) advance()
            }}
            noValidate
          >
            <FieldGroup>
              <StepHeading title="What is your name?">
                We will use it to address you. Nothing else.
              </StepHeading>
              <FloatingInput
                id="first-name"
                name="first-name"
                type="text"
                label="First name"
                value={firstName}
                onChange={(event) => setFirstName(event.target.value)}
                autoComplete="given-name"
                disabled={locked}
                autoFocus
                required
              />
              <Button type="submit" size="xl" disabled={locked || !firstName.trim()}>
                Continue
              </Button>
              <FieldDescription className="text-center">
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
        ) : stage === "surname" ? (
          <form
            className="flex flex-col gap-6"
            onSubmit={(event) => {
              event.preventDefault()
              advance()
            }}
            noValidate
          >
            <FieldGroup>
              <StepHeading title={`Hello, ${firstName.trim()}.`}>
                And your last name, if you have one.
              </StepHeading>
              <FloatingInput
                id="last-name"
                name="last-name"
                type="text"
                label="Last name"
                value={lastName}
                onChange={(event) => setLastName(event.target.value)}
                autoComplete="family-name"
                disabled={locked}
                autoFocus
                // ⚠ NOT `required`, DELIBERATELY. Plenty of people have one
                // legal name, and Clerk stores a sign-up with no last name
                // without complaint. A required surname is a form that cannot be
                // completed truthfully by someone who has none — which is also
                // why the button below says Continue rather than Skip.
              />
              <Button type="submit" size="xl" disabled={locked}>
                Continue
              </Button>
            </FieldGroup>
          </form>
        ) : stage === "credentials" ? (
          <form className="flex flex-col gap-6" onSubmit={onCredentials} noValidate>
            <FieldGroup>
              <StepHeading title="Your sign-in details">
                The address is where account and delivery notices go.
              </StepHeading>
              <FloatingInput
                id="email"
                name="email"
                type="email"
                label="Email address"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                disabled={locked}
                autoFocus
                required
              />
              {/*
               * ⚠ ONE PASSWORD BOX, NOT TWO, AND THE REVEAL IS WHY. The form
               * this replaced had a confirmation field because it had no way to
               * show what had been typed; `PasswordInput` has an eye, so the
               * check is available without asking anybody to type a long string
               * twice. The address above it is verified one step later, so a
               * typo here is recoverable by password reset rather than fatal.
               */}
              <PasswordInput
                id="password"
                name="password"
                label="Password"
                autoComplete="new-password"
                disabled={locked}
                required
                hint="At least 8 characters."
              />
              <Button type="submit" size="xl" disabled={!signUp || locked}>
                {busy === "credentials" ? (
                  <>
                    <Spinner aria-hidden="true" aria-label={undefined} />
                    Creating your account…
                  </>
                ) : (
                  "Create account"
                )}
              </Button>
            </FieldGroup>
          </form>
        ) : stage === "verify" ? (
          <form
            ref={formRef}
            className="flex flex-col gap-6"
            onSubmit={onVerify}
            noValidate
          >
            <FieldGroup>
              <StepHeading title="Check your email">
                We sent a six-digit code. Enter it to finish creating the account.
              </StepHeading>

              {/*
               * ⚠ THE ADDRESS IS A BUTTON, FOR THE SAME REASON IT IS ONE ON THE
               * SIGN-IN PASSWORD STEP. Somebody who mistyped their email has no
               * other way back — the browser's back button abandons Clerk's
               * attempt and produces a confusing half-state — and this is
               * exactly where they are already looking for it.
               */}
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => goBack("credentials")}
                  disabled={locked}
                  className="max-w-full truncate rounded-pill border px-3 py-1 text-xs text-muted-foreground transition-colors duration-(--duration-instant) hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  {email} · Change
                </button>
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
              <Button
                type="submit"
                size="xl"
                disabled={locked || code.length < OTP_LENGTH}
              >
                {busy === "verify" ? (
                  <>
                    <Spinner aria-hidden="true" aria-label={undefined} />
                    Verifying…
                  </>
                ) : (
                  "Verify email"
                )}
              </Button>
              <ResendButton
                onResend={async () => {
                  if (!signUp) return
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
        ) : stage === "passkey" ? (
          <PasskeyStep
            locked={locked}
            busy={busy}
            onBusy={setBusy}
            onNext={() => advance("passkey")}
            skipLabel={isLastStep ? "Skip and finish" : undefined}
          />
        ) : stage === "totp-offer" ? (
          <TwoFactorOfferStep
            locked={locked}
            busy={busy}
            onBusy={setBusy}
            onNext={() => advance("totp-offer")}
            skipLabel={isLastStep ? "Skip and finish" : undefined}
            onEnrolled={(enrolment) => {
              setTotp(enrolment)
              setDirection("forward")
              setStage("totp-scan")
            }}
          />
        ) : stage === "totp-scan" && totp ? (
          <TwoFactorScanStep
            totp={totp}
            locked={locked}
            busy={busy}
            onBusy={setBusy}
            onVerified={(codes) => {
              setBackupCodes(codes)
              setDirection("forward")
              // ⚠ AN INSTANCE THAT ISSUES NO RECOVERY CODES SKIPS THE SCREEN
              // FOR THEM, rather than showing an empty box under "save these
              // somewhere".
              if (codes.length > 0) {
                setStage("totp-codes")
                return
              }
              toast.success("Two-factor is on.")
              advance("totp-offer")
            }}
            onCancel={() => advance("totp-offer")}
          />
        ) : stage === "totp-codes" ? (
          <BackupCodesStep
            codes={backupCodes}
            locked={locked}
            onNext={() => advance("totp-offer")}
          />
        ) : (
          <ConnectStep
            providers={providers}
            redirectRaw={redirectRaw}
            locked={locked}
            busy={busy}
            onBusy={setBusy}
            onNext={() => advance("connect")}
            finishLabel="Take me in"
          />
        )}
      </StepStage>

      {/*
       * ⚠ OUTSIDE THE STAGE, SO CLERK'S BOT PROTECTION IS NEVER UNMOUNTED. With
       * Smart CAPTCHA on and no `#clerk-captcha` in the DOM, `signUp.password`
       * either falls back to an invisible widget or rejects the attempt
       * outright — and the person sees a sign-up that simply refuses, with
       * nothing on screen to act on. Inside the step swap it would be torn out
       * from under Clerk halfway through the flow.
       */}
      <div id="clerk-captcha" />
    </div>
  )
}
