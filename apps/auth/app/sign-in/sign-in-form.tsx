"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useSignIn } from "@clerk/nextjs"
import { Button } from "@repo/ui/components/button"
import { Field, FieldGroup, FieldSeparator } from "@repo/ui/components/field"
import { FloatingInput } from "@repo/ui/components/floating-field"
import { Spinner } from "@repo/ui/components/spinner"
import { StepStage } from "@repo/ui/components/step-stage"
import { PasswordInput } from "../_components/password-input"
import { OAuthButtons } from "../_components/oauth-buttons"
import { isUnknownIdentifier, messageFor, TRANSPORT_FAILURE } from "../_lib/errors"
import { finalizeAndLeave } from "../_lib/finish"
import { markSignInAttempt, useLastSignInMethod } from "../_lib/last-used"
import { emailVerdict, isEmailUsable } from "../_lib/validate"
import { releaseFocus, useFieldFocus } from "@repo/ui/hooks/field-focus"
import { LastUsedBadge } from "../_components/last-used-badge"
import { PasskeyCue } from "../_components/passkey-cue"
import { PasskeyIcon } from "../_components/provider-icons"
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
  resetHref,
  mfaHref,
  redirectRaw,
  providers,
  onUnknownIdentifier,
}: {
  afterAuthUrl: string
  resetHref: string
  mfaHref: string
  redirectRaw?: string
  providers: SsoProvider[]
  /**
   * The address has no account, so this is a sign-up.
   *
   * ⚠ REPORTED UPWARDS RATHER THAN HANDLED HERE, so this form never has to know
   * the sign-up flow exists. The wrapper above owns the branch; without that
   * seam the two 600-line forms would import each other to render each other,
   * for a decision neither of them makes.
   *
   * ⚠ AND ITS ABSENCE LEAVES THE OLD BEHAVIOUR INTACT. Without a handler an
   * unknown address is still a toast, which is what `/sign-in` did before there
   * was one box for both doors.
   */
  onUnknownIdentifier?: (identifier: string) => void
}) {
  const router = useRouter()
  const { signIn } = useSignIn()
  const [busy, setBusy] = useState<string | null>(null)

  /**
   * Email first, password second.
   *
   * ⚠ THE SPLIT IS NOT COSMETIC — IT IS WHAT LETS THE SECOND SCREEN BE
   * CORRECT. `signIn.create({ identifier })` answers with the factors this
   * particular account actually supports, so somebody who has only ever used a
   * passkey is not shown a password box they have never filled in, and an SSO
   * domain can be redirected before being asked for a credential it does not
   * have. Asking for both at once means guessing.
   *
   * ⚠ AND IT DOES DISCLOSE WHETHER AN ADDRESS HAS AN ACCOUNT, which is the
   * honest cost of this pattern and worth writing down rather than discovering.
   * Clerk answers `form_identifier_not_found` for an unknown identifier, so the
   * first step is an enumeration oracle — the same one Google, Apple and Clerk's
   * own hosted pages accept. It is a deliberate trade for a flow that can route
   * to the right factor, not an oversight.
   */
  const [stage, setStage] = useState<"identifier" | "password">("identifier")
  const [identifier, setIdentifier] = useState("")
  /*
   * ⚠ VALIDATING THE IDENTIFIER IS ONLY SAFE BECAUSE AN EMAIL IS THE ONLY ONE
   * THIS INSTANCE HAS. `signIn.create({ identifier })` accepts a username or a
   * phone number on instances configured for them, and a red border under
   * somebody's username would be the form refusing a credential that works.
   * Checked against the instance: `email_address` is the sole attribute with
   * `used_for_first_factor`. If a username is ever switched on, this check has
   * to go or learn about it — see _lib/environment.ts.
   *
   * ⚠ AND IT ONLY GOES RED WHILE THE CARET IS ELSEWHERE. See
   * @repo/ui/hooks/field-focus: red means "you stopped and it is still wrong", not
   * "you are part-way through typing it".
   */
  const identifierField = useFieldFocus(
    (value) => value.trim() !== "" && !isEmailUsable(value),
  )
  const [direction, setDirection] = useState<"forward" | "back">("forward")

  /*
   * ⚠ READ IN AN EFFECT, NOT DURING RENDER. It comes from `localStorage`, which
   * the server does not have — reading it inline renders one thing on the
   * server and another in the browser, which React reports as a hydration
   * mismatch and resolves by discarding the markup.
   */
  const lastUsed = useLastSignInMethod()
  const identifierState = emailVerdict(identifier, identifierField)

  /**
   * Offer a saved passkey without anybody asking.
   *
   * ⚠ `autofill`, NOT `discoverable` — the opposite of `provePasskey` below. This
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

  /**
   * ⚠ THE FIRST STEP CREATES THE SIGN-IN RATHER THAN JUST REMEMBERING THE
   * EMAIL. That call is what makes Clerk resolve the identifier and populate
   * `supportedFirstFactors`; skipping it and carrying the string forward would
   * turn this into two screens with one screen's worth of information.
   */
  async function onIdentifier(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!signIn || busy) return

    const value = identifier.trim()
    if (!value) return

    /*
     * ⚠ THE SHAPE IS CHECKED HERE RATHER THAN BY CLERK, for the same reason as
     * the sign-up form: `mido@` cannot be anybody's address, and finding that
     * out took a spinner and a round trip. Pressing the button on a malformed
     * address is what reveals the error rather than a dead control.
     */
    if (!isEmailUsable(value)) {
      // See the sign-up form: Enter from inside the box leaves it focused, and
      // a focused field is never painted red.
      releaseFocus()
      identifierField.reveal(true)
      return
    }

    setBusy("identifier")
    try {
      const { error } = await signIn.create({ identifier: value })
      if (error) {
        /*
         * ⚠ "NO SUCH ACCOUNT" IS THE OTHER ANSWER, NOT AN ERROR. On a page with
         * one box serving both doors, an unknown address is how somebody says
         * they are new — and a red toast telling them so, on a form that then
         * sits there unchanged, is the interface refusing to do the obvious
         * next thing.
         */
        if (onUnknownIdentifier && isUnknownIdentifier(error)) {
          onUnknownIdentifier(value)
          setBusy(null)
          return
        }
        toast.error(messageFor(error))
        setBusy(null)
        return
      }

      setDirection("forward")
      setStage("password")
      setBusy(null)
    } catch {
      toast.error(TRANSPORT_FAILURE)
      setBusy(null)
    }
  }

  /**
   * The passkey button, which used to be a page.
   *
   * ⚠ `/passkey` WAS A WHOLE SCREEN WHOSE ONLY CONTENT WAS A BUTTON THAT CALLED
   * THIS. A navigation, a render and a second decision in front of something
   * that is one tap — and the heading it showed ("Your device will ask for your
   * fingerprint") was describing a dialog the person could not see yet, because
   * it does not open until they press the thing on the next screen down. The
   * button belongs where the choice is made.
   *
   * ⚠ `discoverable`, NOT `autofill`. Autofill is the other flow — the browser
   * quietly offering a passkey inside the email box the moment the page loads,
   * which is armed in the effect above and needs an input to attach to. This one
   * opens on demand because somebody pressed a button, and the two must not be
   * confused: `autofill` from a click does nothing at all.
   */
  async function provePasskey() {
    if (!signIn || busy) return
    setBusy("passkey")

    try {
      const { error } = await signIn.passkey({ flow: "discoverable" })

      if (error) {
        toast.error(messageFor(error))
        setBusy(null)
        return
      }

      if (signIn.status === "complete") {
        // ⚠ THE LOCK IS NOT RELEASED ON SUCCESS. The page is navigating to
        // another origin; re-enabling the buttons for the second that takes is
        // an invitation to start a second sign-in on top of the first.
        markSignInAttempt("passkey")
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

      toast.error("That passkey worked, but the sign-in needs another step.")
      setBusy(null)
    } catch {
      /*
       * ⚠ THE CATCH IS LOAD-BEARING HERE, UNLIKE ON THE PASSWORD FORM. A passkey
       * prompt is WebAuthn: dismissing the sheet, or a browser with no
       * authenticator at all, rejects at the platform level rather than coming
       * back as a Clerk error — and an unhandled rejection would leave this
       * stuck on "Waiting for your device…" for the rest of the session.
       */
      toast.error(TRANSPORT_FAILURE)
      setBusy(null)
    }
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // ⚠ `signIn` IS NULL UNTIL CLERK LOADS. It is the only readiness signal the
    // hook gives; there is no `isLoaded` on this API.
    if (!signIn || busy) return

    const form = new FormData(event.currentTarget)
    setBusy("password")

    // ⚠ AN ATTEMPT, NOT A RESULT — promoted only once a session exists. A wrong
    // password must not teach the badge that a password is what works here.
    markSignInAttempt("password")

    try {
      const { error } = await signIn.password({
        // ⚠ PASSED AGAIN RATHER THAN RELYING ON THE SIGN-IN CREATED ABOVE.
        // Clerk will use the in-progress attempt's identifier when this is
        // omitted, which works — until the attempt is garbage-collected by a
        // reload or a second tab, and then the password lands on nothing with
        // an error that reads like a wrong password.
        identifier: identifier.trim(),
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

  /** Back to the email step, keeping what was typed. */
  function changeIdentifier() {
    setDirection("back")
    setStage("identifier")
  }

  return (
    <div className="flex flex-col gap-6">
      {/*
       * ⚠ THE STAGE IS KEYED ON `stage`, AND THE HEADING IS INSIDE IT. Keeping
       * a fixed heading above the swap would leave one line of the card
       * stationary while everything under it moved, which reads as the page
       * partially failing to update. The whole panel is one object changing
       * state — see @repo/ui/components/step-stage.
       */}
      {/*
       * ⚠ OUTSIDE THE STAGE, so the step swap cannot unmount it mid-prompt. It
       * covers the page while the operating system's own dialog is open — see
       * _components/passkey-cue.tsx, which came off the deleted `/passkey` page.
       */}
      {busy === "passkey" ? <PasskeyCue /> : null}

      <StepStage step={stage} direction={direction}>
        {stage === "identifier" ? (
          <form className="flex flex-col gap-6" onSubmit={onIdentifier} noValidate>
            <FieldGroup>
              {/*
               * ⚠ THE COPY FOLLOWS WHETHER THIS PAGE IS BOTH DOORS. With a
               * handler for an unknown address the box serves people who have
               * no account yet, and "Login to your account" tells half of them
               * they are in the wrong place — which, on a page that was about
               * to sign them up, is the one sentence that sends them away.
               *
               * ⚠ AND THE BOTH-DOORS HEADING CARRIES NO SUBTITLE, BECAUSE THE
               * SUBTITLE WAS EXPLAINING THE MECHANISM. "We will sign you in, or
               * start a new account" describes what WE do with the address; the
               * person already knows what an email box is for, and a field
               * labelled "Email address" under "Continue to i10" leaves nothing
               * ambiguous. It also meant the two halves of this page were
               * different heights, so the header moved when the lookup did.
               */}
              <div className="flex flex-col items-center gap-1 text-center">
                <h1 className="text-2xl font-bold">
                  {onUnknownIdentifier ? "Continue to i10" : "Login to your account"}
                </h1>
                {!onUnknownIdentifier && (
                  <p className="text-sm text-balance text-muted-foreground">
                    Enter your email to continue
                  </p>
                )}
              </div>

              {/*
               * ⚠ THE FIELD IS WRAPPED SO THE CHIP HAS SOMETHING TO ANCHOR TO,
               * rather than `FloatingInput` growing a `badge` prop. This is the
               * only field in the product that carries one, and a prop on the
               * shared component would be an API every other call site has to
               * ignore — see @repo/ui/components/floating-field, which is
               * already carrying more geometry than it wants to.
               *
               * ⚠ AND IT IS ON THE EMAIL BOX, NOT ONLY ON THE BUTTON TWO STEPS
               * LATER. Somebody who signed in with a password last time is
               * looking at this field, deciding between it and the provider
               * buttons above — which is the moment the hint is worth anything.
               * By the password step they have already chosen.
               */}
              <div className="relative">
                {lastUsed === "password" && <LastUsedBadge placement="field" />}
                <FloatingInput
                  id="email"
                  name="email"
                  type="email"
                  label="Email address"
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  {...identifierField.props}
                  state={identifierState.state}
                  hint={identifierState.hint}
                  // See the sign-up form: a validation message is drawn into the
                  // gap FieldGroup already leaves, not given a row of its own.
                  reserveHint={false}
                  // ⚠ `webauthn` ALONGSIDE `email`, AND BOTH TOKENS ARE REQUIRED.
                  // This is the hook the conditional-mediation call above attaches
                  // to: without it the browser has nowhere to surface a saved
                  // passkey, and the effect silently does nothing.
                  autoComplete="email webauthn"
                  disabled={locked}
                  autoFocus
                  required
                />
              </div>

              <Button
                type="submit"
                size="xl"
                disabled={!signIn || locked || identifier.trim().length === 0}
              >
                {busy === "identifier" ? (
                  <>
                    <Spinner aria-hidden="true" aria-label={undefined} />
                    Checking…
                  </>
                ) : (
                  "Continue"
                )}
              </Button>

              <FieldSeparator>Or continue with</FieldSeparator>
              {/*
               * ⚠ ONE `Field` AROUND ALL OF THEM, so the passkey button is the
               * same 12px from "Continue with Google" as the providers are from
               * each other. It was in a Field of its own and sat 28px away,
               * which read as a separate section rather than one more way in.
               */}
              <Field>
                <OAuthButtons
                  afterAuthUrl={afterAuthUrl}
                  redirectRaw={redirectRaw}
                  intent="sign-in"
                  providers={providers}
                  busy={busy}
                  onBusyChange={setBusy}
                />

                {/*
                 * ⚠ IT SITS WITH THE PROVIDER BUTTONS RATHER THAN UNDER THEM AS A
                 * LINK, BECAUSE IT IS THE SAME KIND OF THING. "Continue with
                 * Google" and "Continue with Passkey" are both "sign in without
                 * typing a password"; one of them being a sentence in small grey
                 * text made it look like a footnote about the other three.
                 *
                 * ⚠ AND IT IS LAST ON PURPOSE. A passkey only works for somebody
                 * who has already set one up on this device, so it is the one
                 * button on the page that does nothing for a first-time visitor.
                 */}
                <Button
                  type="button"
                  variant="outline"
                  size="xl"
                  // The positioning context for the chip below — see
                  // oauth-buttons, which carries the same class for the same
                  // reason.
                  className="relative"
                  onClick={provePasskey}
                  disabled={!signIn || locked}
                >
                  {busy === "passkey" ? (
                    <>
                      <Spinner aria-hidden="true" aria-label={undefined} />
                      Waiting for your device…
                    </>
                  ) : (
                    <>
                      <PasskeyIcon aria-hidden="true" />
                      Continue with Passkey
                      {/*
                       * ⚠ THE PASSKEY PATH RECORDS ITSELF NOW, so it can carry
                       * the badge like every other method. `provePasskey` calls
                       * `markSignInAttempt("passkey")` on success — without
                       * that this button was the one way in that never became
                       * "last used", which is the worst one to forget: somebody
                       * who signs in with a passkey has no password to fall
                       * back on and most needs reminding which button it was.
                       */}
                      {lastUsed === "passkey" && <LastUsedBadge />}
                    </>
                  )}
                </Button>
              </Field>
              {/*
               * ⚠ "DON'T HAVE AN ACCOUNT? SIGN UP" IS GONE, AND ITS ABSENCE IS
               * THE POINT OF THE PAGE. It asked somebody to answer a question
               * the box below is about to answer for them — and answering it
               * wrong was the whole failure mode: a returning customer who
               * clicked it got "that address is taken", a new one who did not
               * got "no such account". Typing the address is the answer.
               */}
            </FieldGroup>
          </form>
        ) : (
          <form className="flex flex-col gap-6" onSubmit={onSubmit} noValidate>
            <FieldGroup>
              <div className="flex flex-col items-center gap-2 text-center">
                <h1 className="text-2xl font-bold">Enter your password</h1>
                {/*
                 * ⚠ THE ADDRESS IS A BUTTON, NOT A LINE OF TEXT. Somebody who
                 * mistyped their email on the previous step has no other way
                 * back — the browser's back button leaves Clerk's sign-in
                 * attempt behind and produces a confusing half-state. Making the
                 * thing they want to change the thing they can click is the
                 * shortest route, and it is where they are already looking.
                 */}
                <button
                  type="button"
                  onClick={changeIdentifier}
                  disabled={locked}
                  className="max-w-full truncate rounded-pill border px-3 py-1 text-xs text-muted-foreground transition-colors duration-(--duration-instant) hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  {identifier} · Change
                </button>
              </div>

              <PasswordInput
                id="password"
                name="password"
                label="Password"
                // ⚠ `current-password`, NOT `password`. It is what tells a
                // password manager to offer the saved credential rather than to
                // propose a new one, and getting it wrong is how people end up
                // with a second entry for the same site.
                autoComplete="current-password"
                disabled={locked}
                autoFocus
                required
              />

              <div className="-mt-4 flex justify-end">
                <Link
                  href={resetHref}
                  // ⚠ THE LINKS GO DEAD WITH THE BUTTONS, and they are the half
                  // that is easy to forget. Navigating to "Forgot your
                  // password?" mid-redirect abandons a flow that is already
                  // creating a session.
                  aria-disabled={locked}
                  tabIndex={locked ? -1 : undefined}
                  className={`text-xs underline-offset-4 hover:underline ${
                    locked ? "pointer-events-none opacity-50" : ""
                  }`}
                >
                  Forgot your password?
                </Link>
              </div>

              <Button
                type="submit"
                size="xl"
                // See oauth-buttons: the chip below is positioned against this.
                className="relative"
                disabled={!signIn || locked}
              >
                {busy === "password" ? (
                  <>
                    {/*
                     * ⚠ `aria-hidden`, AND THE LABEL CARRIES THE STATE. The
                     * Spinner ships with `role="status"`; leaving that on next to
                     * text that already says "Signing in…" makes a screen reader
                     * announce the same thing twice.
                     */}
                    <Spinner aria-hidden="true" aria-label={undefined} />
                    Signing in…
                  </>
                ) : (
                  <>
                    Login
                    {lastUsed === "password" && <LastUsedBadge />}
                  </>
                )}
              </Button>
            </FieldGroup>
          </form>
        )}
      </StepStage>

      {/*
       * ⚠ OUTSIDE THE STAGE, SO IT IS NEVER UNMOUNTED. Clerk's bot protection
       * mounts itself into this exact id and its absence is a silent failure:
       * with Smart CAPTCHA on and no `#clerk-captcha` in the DOM, Clerk rejects
       * the attempt rather than challenging it — which is what
       * `authorization_invalid` from FAPI turned out to be. Inside the step
       * swap it would be torn out from under Clerk halfway through the flow.
       *
       * ⚠ AND THIS PAGE NEEDS IT DESPITE CARRYING NO SIGN-UP. The SSO buttons
       * pass `signUpIfMissing`, so "Continue with Google" from somebody who has
       * never been here before IS a sign-up, and bot protection applies to it.
       */}
      <div id="clerk-captcha" />
    </div>
  )
}
