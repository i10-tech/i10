"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowLeftIcon } from "lucide-react"
import { toast } from "sonner"
import { useClerk, useSignUp } from "@clerk/nextjs"
import { Button } from "@repo/ui/components/button"
import { FieldDescription, FieldGroup } from "@repo/ui/components/field"
import { FloatingInput } from "@repo/ui/components/floating-field"
import { ValidatedInput } from "@repo/ui/components/validated-field"
import { emailProblem } from "@repo/ui/checks"
import { Spinner } from "@repo/ui/components/spinner"
import { StepProgress } from "@repo/ui/components/step-progress"
import { StepStage } from "@repo/ui/components/step-stage"
import { OtpField, OTP_LENGTH } from "../_components/otp-field"
import { ResendButton } from "../_components/resend-button"
import { PasswordInput } from "../_components/password-input"
import { StepHeading } from "../_components/step-heading"
import { messageFor, TRANSPORT_FAILURE } from "../_lib/errors"
import { finalizeWithoutLeaving, leaveFor } from "../_lib/finish"
import { markSignInAttempt } from "../_lib/last-used"
import { useResumable, useResumeLive } from "../_lib/resume"
import type { PasswordRules, SignUpAbilities } from "../_lib/environment"
import { describeRules, passwordProblem } from "../_lib/validate"
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
  onSignIn,
  redirectRaw,
  providers,
  abilities,
  password: passwordPolicy,
  initialEmail,
}: {
  afterAuthUrl: string
  /** "Already have an account? Sign in" — back to the email box, in place. */
  onSignIn: () => void
  redirectRaw?: string
  providers: SsoProvider[]
  /** What this Clerk instance can actually finish. See _lib/environment.ts. */
  abilities: SignUpAbilities
  /**
   * What this instance will accept as a password.
   *
   * ⚠ A PROP RATHER THAN A CONSTANT, BECAUSE THE CONSTANT WAS WRONG. The hint
   * under the box said "At least 8 characters" against an instance configured
   * for fifteen, so the form stated a rule, accepted input that met it, spent a
   * round trip, and returned a toast contradicting its own hint. See
   * `passwordRules` in _lib/environment.ts.
   */
  password: PasswordRules
  /**
   * The address the identifier step already collected.
   *
   * ⚠ THE SIGN-UP FLOW IS ENTERED FROM ONE SHARED BOX NOW, so by the time this
   * form renders the person has already typed their email once. Asking for it
   * again at the credentials step would be the single most obvious thing wrong
   * with a merged page — it is still editable there, because arriving in
   * sign-up is itself a decent hint that the address might have a typo in it.
   */
  initialEmail?: string
}) {
  const { signUp } = useSignUp()
  const clerk = useClerk()

  /*
   * ⚠ THE STEP AND WHAT WAS TYPED SURVIVE A RELOAD; THE PASSWORD AND THE CODE DO
   * NOT. See _lib/resume.tsx for why nothing secret is stored — and the check
   * below for what happens when the step stored no longer matches what Clerk
   * holds.
   */
  const [stage, setStage] = useResumable<Stage>("signup.stage", "name")
  const [direction, setDirection] = useState<"forward" | "back">("forward")
  const [busy, setBusy] = useState<string | null>(null)

  const [firstName, setFirstName] = useResumable("signup.first-name", "")
  const [lastName, setLastName] = useResumable("signup.last-name", "")
  const [email, setEmail] = useResumable("signup.email", initialEmail ?? "")
  const [code, setCode] = useState("")
  /** Why the last code was refused, shown under the boxes until it is retyped. */
  const [rejected, setRejected] = useState<string | null>(null)
  /** The emailed code was accepted, for the moment before the next step. */
  const [accepted, setAccepted] = useState(false)

  /*
   * ⚠ THE PASSWORD IS CONTROLLED NOW, WHICH IT DELIBERATELY WAS NOT BEFORE. The
   * old form read it out of `FormData` at submit time precisely so that React
   * never held it — a reasonable instinct, and the wrong trade here. Nothing can
   * tell somebody their password is eleven characters of a required fifteen
   * without knowing what they have typed, and the alternative is what this
   * replaced: a round trip to Clerk to be told.
   *
   * It lives in this component's state for the length of one step and is passed
   * to `signUp.password`. It is never logged, never put in a ref that outlives
   * the step, and the component unmounts on navigation like any other.
   */
  const [secret, setSecret] = useState("")

  /*
   * ⚠ "IS THIS FIELD WRONG **AND** NOT BEING EDITED", which is a stricter test
   * than "has it been blurred once". Red has to mean "you stopped, and it is
   * still wrong" — a field that stays red through the keystrokes of its own
   * correction is reporting on a value that no longer exists. See
   * @repo/ui/hooks/field-focus, which owns the two booleans and why there are two.
   *
   * ⚠ GREEN DOES NOT WAIT FOR ANY OF IT, WHICH IS THE ASYMMETRY THE WHOLE THING
   * TURNS ON. There is no moment at which "this is fine" is premature. See
   * _lib/validate.ts.
   */
  /*
   * ⚠ THE POLICY IS CLOSED OVER ONCE, NOT READ AT EVERY CALL SITE. It comes
   * from the Clerk instance at runtime, so the field, its hint and the guard
   * below all have to be looking at the same numbers — see `passwordProblem`.
   */
  const secretProblem = passwordProblem(passwordPolicy)
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
   * A restored step, checked against what Clerk actually holds.
   *
   * ⚠ THE STEP IS OURS BUT THE STATE BEHIND IT IS CLERK'S, AND THEY CAN
   * DISAGREE. A code box whose sign-up attempt has expired would collect six
   * digits and then fail with something unrelated; a passkey step with nobody
   * signed in would fail on the button. So once Clerk has loaded, a restored
   * step that has nothing behind it moves to the nearest one that does —
   * never forward past something the person has not done.
   *
   * ⚠ ONCE, ON THE FIRST LIVE RENDER. After that every step change is one the
   * person made in this page load, and Clerk agrees with it by construction.
   */
  const live = useResumeLive()

  function reconcile() {
    const signedIn = clerk.user != null
    const attempt = clerk.client?.signUp
    const accountStage = (ACCOUNT_STAGES as readonly Stage[]).includes(stage)

    if (!accountStage && !signedIn) {
      // The account steps are behind them, but the session is not: nothing
      // after this point can act. Start again rather than fail on a button.
      setDirection("back")
      setStage("name")
      return
    }

    if (stage === "verify") {
      if (signedIn) {
        // The code was accepted and the reload beat the step change.
        const next = optional[0]
        if (next) setStage(next)
        else finish()
        return
      }
      const waitingForCode =
        attempt?.id != null &&
        attempt.unverifiedFields.includes("email_address") &&
        attempt.emailAddress === email.trim()
      if (!waitingForCode) {
        setDirection("back")
        setStage("credentials")
      }
      return
    }

    /*
     * ⚠ THE TOTP SECRET IS NOT STORED, SO THE SCAN STEP CANNOT COME BACK. It
     * goes back to the offer, which enrols afresh — a new secret, and the old
     * unverified one is simply never confirmed.
     */
    if (stage === "totp-scan") setStage("totp-offer")
  }

  /*
   * ⚠ A LISTENER, NOT A CHECK IN THE EFFECT BODY, because the answer arrives
   * when Clerk has loaded — which is after this mounts. It fires once with the
   * loaded client and is then dropped.
   */
  useEffect(() => {
    if (!live) return
    let done = false
    const unsubscribe = clerk.addListener(() => {
      if (done || !clerk.loaded) return
      done = true
      reconcile()
    })
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount, see above
  }, [live, clerk])

  /*
   * ⚠ BACKUP CODES ARE NOT STORED EITHER, SO A RELOAD ON THAT STEP ISSUES A NEW
   * SET. Clerk replaces the old ones when it does, which is the right outcome:
   * the codes on screen are always the codes that work.
   */
  const reissuing = useRef(false)
  useEffect(() => {
    if (stage !== "totp-codes" || backupCodes.length > 0 || reissuing.current) return
    const user = clerk.user
    if (!clerk.loaded || !user) return
    reissuing.current = true
    user
      .createBackupCode()
      .then((created) => setBackupCodes(created.codes))
      .catch(() => {
        toast.error(
          "We could not show your backup codes again. You can make new ones in settings.",
        )
        advance("totp-offer")
      })
      .finally(() => {
        reissuing.current = false
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `advance` is recreated every render
  }, [stage, backupCodes.length, clerk.loaded, clerk.user])

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
    // Resumed after a reload or a provider round trip: no finalize happened on
    // this page load, so there is no decorated URL to reuse.
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

    /*
     * ⚠ THE CHECK HAPPENS HERE AND THE BUTTON STAYS ENABLED, WHICH IS THE
     * DELIBERATE HALF OF THIS. Pressing Create account with both boxes empty
     * used to show a spinner, spend a round trip on Clerk, and return a toast —
     * for two questions this page can answer without asking anybody. Disabling
     * the button until both are valid would also stop the round trip, and it
     * would replace a wasted two seconds with a control that is dead for no
     * stated reason, which is the worse of the two failures.
     *
     * Pressing it while something is wrong is instead what MARKS the fields as
     * touched: the borders go red, the hints name what is missing, and the
     * answer arrives in the same frame as the click.
     */
    /*
     * ⚠ THE TWO FIELDS REFUSE THIS SUBMIT THEMSELVES, so there is nothing to
     * check here. Each one blurs the caret so its red can be seen, reddens
     * only if it is the field actually at fault — revealing a valid field
     * would arm green on it for nothing — and blocks the submit before this
     * handler is reached. Both were written out by hand in this file; see
     * @repo/ui/components/validated-field.
     */
    const password = secret

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
        // ⚠ BEFORE `createSession`, which advances past this screen. See
        // `verified` on OtpField for why the confirmation is worth the frame.
        setAccepted(true)
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
        /*
         * ⚠ UNDER THE BOXES RATHER THAN IN A TOAST. See mfa-form: a toast slides
         * away and leaves the field looking exactly as it did before the code
         * was judged, which is the state somebody is in when they retype the
         * same wrong code.
         */
        setRejected(messageFor(error))
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

    /*
     * ⚠ SIGNING UP IS EVIDENCE OF HOW SOMEBODY WILL SIGN IN, AND ONLY THE SSO
     * BUTTONS WERE RECORDING IT. `OAuthButtons` marks the attempt on both pages,
     * so a Google sign-up already earned its badge; an email-and-password
     * sign-up recorded nothing, so the very first time that person came back
     * — the moment the badge exists for — there was nothing to show them. They
     * had used exactly one method in their life and we knew which.
     *
     * ⚠ IT IS THE PENDING MARKER RATHER THAN THE CONFIRMED ONE, on the same
     * rule as everywhere else: `leaveFor` promotes it once a session actually
     * exists. The account is real by this line, but the person is about to be
     * offered a passkey and two-factor and may still close the tab.
     */
    markSignInAttempt("password")

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
   * Which box the caret lands in on the credentials step.
   *
   * ⚠ THE FIRST EMPTY BOX, NOT THE FIRST BOX, AND THE DIFFERENCE IS THE WHOLE
   * POINT OF ARRIVING HERE WITH AN ADDRESS ALREADY IN HAND. Almost everybody
   * reaching this step came through the one shared box on the sign-in page, so
   * their email is filled in before the step renders — and focusing it put the
   * caret at the end of a correct value and left the only thing still being
   * asked for one tab key away. Coming BACK from the last-name step is the same
   * situation and was the same waste: the address survives the round trip, so
   * the field that needs typing is the password.
   *
   * ⚠ IT IS READ AT MOUNT AND NEVER AGAIN, which is what `autoFocus` means in
   * React — the attribute focuses the element as it is created and does nothing
   * on a later render. So this is not a rule about where focus should live; it
   * is a decision made once, each time the step is entered.
   */
  const startOnPassword = email.trim() !== ""

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
  /*
   * ⚠ BACK FROM THE FIRST STEP LEAVES SIGN-UP, AND LEAVING IS DESTRUCTIVE.
   * Stepping back inside sign-up keeps what was typed — last name to first name
   * loses nothing. Stepping back out of it to the email box forgets the lot:
   * names, address, the stored steps. Whoever continues from there may be a
   * different person, or the same person with a different address, and a
   * half-filled sign-up waiting behind the box would be answering for them.
   */
  const leaving = stage === "name"

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
          onClick={() => (leaving ? onSignIn() : back && goBack(back))}
          disabled={(!back && !leaving) || locked}
          // ⚠ `invisible`, NOT UNMOUNTED. Removing the button would let the
          // progress bar jump left by 32px between step one and step two, which
          // is the one element on the page whose job is to not move.
          className={back || leaving ? undefined : "invisible"}
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
                <button
                  type="button"
                  onClick={onSignIn}
                  disabled={locked}
                  className="cursor-pointer underline underline-offset-4 disabled:pointer-events-none disabled:opacity-50"
                >
                  Sign in
                </button>
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
              <ValidatedInput
                id="email"
                name="email"
                /*
                 * ⚠ STILL `type="email"` THOUGH THE FORM IS `noValidate` AND WE
                 * CHECK IT OURSELVES. The type is what gives a phone keyboard an
                 * @ key and a dot, and what tells a password manager which field
                 * this is. Only the browser's own bubble is being suppressed.
                 */
                type="email"
                label="Email address"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                check={emailProblem}
                required="Enter your email address."
                // ⚠ NO RESERVED ROW: this hint is a validation message rather than a
                // description, so it is drawn into the gap FieldGroup already
                // leaves rather than making every field permanently taller.
                reserveHint={false}
                autoComplete="email"
                disabled={locked}
                // ⚠ ONLY WHEN THERE IS NOTHING IN IT. See `startOnPassword`.
                autoFocus={!startOnPassword}
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
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                check={secretProblem}
                required="Choose a password."
                /*
                 * ⚠ THE HINT IS THE INSTANCE'S OWN RULE, AND THAT REPLACED A
                 * SENTENCE THAT WAS SIMPLY UNTRUE. It said "At least 8
                 * characters" while Clerk was configured to require fifteen —
                 * so the form invited a password it would then refuse, and the
                 * refusal arrived from a server two seconds later. Now the
                 * count ticks up as you type and the border only turns red
                 * once you have left the box.
                 */
                hint={describeRules(passwordPolicy)}
                reserveHint={false}
                autoComplete="new-password"
                disabled={locked}
                autoFocus={startOnPassword}
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
                // ⚠ THE VERDICT GOES ON THE FIRST KEYSTROKE OF THE NEXT
                // ATTEMPT: a red border outliving the digits it was about is
                // marking the wrong code.
                onChange={(next) => {
                  setRejected(null)
                  setCode(next)
                }}
                // The code is the whole form here, so filling it is the decision.
                onComplete={() => {
                  if (!locked) formRef.current?.requestSubmit()
                }}
                state={rejected ? "invalid" : "idle"}
                hint={rejected}
                verified={accepted}
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
