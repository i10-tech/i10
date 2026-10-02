"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useAuth, useSignIn } from "@clerk/nextjs"
import { Button } from "@repo/ui/components/button"
import { Field, FieldGroup, FieldSeparator } from "@repo/ui/components/field"
import { EmailInput } from "@repo/ui/components/email-input"
import { emailProblem } from "@repo/ui/checks"
import { Spinner } from "@repo/ui/components/spinner"
import { StepStage } from "@repo/ui/components/step-stage"
import { PasswordInput } from "../_components/password-input"
import { OAuthButtons, useSsoStart } from "../_components/oauth-buttons"
import { isUnknownIdentifier, messageFor, TRANSPORT_FAILURE } from "../_lib/errors"
import { passkeyFailure, passkeyReference } from "../_lib/passkey"
import { finalizeAndLeave } from "../_lib/finish"
import { stepBack, useStepHistory } from "../_lib/step-history"
import { RememberedAccounts } from "../_components/remembered-accounts"
import { useRememberedAccounts, type RememberedAccount } from "../_lib/remembered"
import { resumeDevice } from "../_lib/devices"
import { markSignInAttempt, useLastSignInMethod } from "../_lib/last-used"
import { installAbortableWebAuthn } from "../_lib/webauthn"
import { useResumable } from "../_lib/resume"
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
 * was restyled - a block edited for taste on arrival is a block that can no
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
  savedAccounts = 0,
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
  /** Saved-account cards to hold room for while they load. */
  savedAccounts?: number
}) {
  const router = useRouter()
  const { signIn } = useSignIn()

  /*
   * ⚠ ASKED ONLY SO THE PASSKEY OVERRIDE CAN WIN A RACE, AND `useSignIn` COULD
   * NOT ANSWER IT. `signIn` arrives from a signals wrapper that exists before
   * clerk-js does and carries no readiness of its own, so a truthy `signIn`
   * does NOT mean `window.Clerk` is there to install onto. `useAuth` is the
   * hook that re-renders when it is - see the autofill effect below, which must
   * not arm until that install has actually landed.
   */
  const { isLoaded } = useAuth()
  const [busy, setBusy] = useState<string | null>(null)

  /**
   * Email first, password second.
   *
   * ⚠ THE SPLIT IS NOT COSMETIC - IT IS WHAT LETS THE SECOND SCREEN BE
   * CORRECT. `signIn.create({ identifier })` answers with the factors this
   * particular account actually supports, so somebody who has only ever used a
   * passkey is not shown a password box they have never filled in, and an SSO
   * domain can be redirected before being asked for a credential it does not
   * have. Asking for both at once means guessing.
   *
   * ⚠ AND IT DOES DISCLOSE WHETHER AN ADDRESS HAS AN ACCOUNT, which is the
   * honest cost of this pattern and worth writing down rather than discovering.
   * Clerk answers `form_identifier_not_found` for an unknown identifier, so the
   * first step is an enumeration oracle - the same one Google, Apple and Clerk's
   * own hosted pages accept. It is a deliberate trade for a flow that can route
   * to the right factor, not an oversight.
   */
  /*
   * ⚠ BOTH SURVIVE A RELOAD, SO A REFRESH ON THE PASSWORD STEP STAYS THERE.
   * Nothing else needs to: the password call passes the identifier again (see
   * `onSubmit`), so it lands whether or not Clerk still holds the attempt.
   */
  const [stage, setStage] = useResumable<"identifier" | "password">(
    "signin.stage",
    "identifier",
  )
  const [identifier, setIdentifier] = useResumable("signin.identifier", "")
  const [direction, setDirection] = useState<"forward" | "back">("forward")
  // Browser Back from the password step returns to the email box - see
  // _lib/step-history.ts for why it did nothing before.
  useStepHistory("signin", stage, "identifier", (to) => {
    setDirection(to === "identifier" ? "back" : "forward")
    setStage(to)
  })

  /*
   * ⚠ READ IN AN EFFECT, NOT DURING RENDER. It comes from `localStorage`, which
   * the server does not have - reading it inline renders one thing on the
   * server and another in the browser, which React reports as a hydration
   * mismatch and resolves by discarding the markup.
   */
  const lastMethod = useLastSignInMethod()
  const remembered = useRememberedAccounts()
  /*
   * ⚠ ONE "LAST USED" ON THE PAGE, AND ONLY WHERE IT IS TRUE. When we know the
   * account that last signed in here, its saved card carries the chip and
   * nothing else does. Otherwise the method gets it - the provider or passkey
   * button, or the email box for a password. Not knowing either, nothing.
   * Two chips meant one of them was wrong.
   */
  const lastAccount = remembered.some((account) => account.last)
  const lastUsed = lastAccount ? null : lastMethod

  // The account the email step identified can sign in with a passkey.
  const accountHasPasskey = Boolean(
    signIn?.supportedFirstFactors?.some((factor) => factor.strategy === "passkey"),
  )

  // Pressing a saved SSO account goes to that provider, the way it signed in.
  const { start: startSso } = useSsoStart({
    afterAuthUrl,
    redirectRaw,
    intent: "sign-in",
    busy,
    onBusyChange: setBusy,
  })

  /**
   * Offer a saved passkey without anybody asking.
   *
   * ⚠ `autofill`, NOT `discoverable` - the opposite of `provePasskey` below. This
   * is WebAuthn conditional mediation: the browser quietly checks whether it
   * holds a passkey for this site and, if it does, offers it inside the email
   * field's own autofill menu. It must be armed BEFORE the person touches
   * anything, which is why it runs in an effect rather than behind a button,
   * and it pairs with `autoComplete="username webauthn"` on that input - drop
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
    if (!isLoaded || !signIn || armed.current) return

    /*
     * ⚠ INSTALLED BEFORE THE REQUEST IT HAS TO BE ABLE TO CANCEL, AND THE ORDER
     * IS THE WHOLE FIX. The call below stays pending for the life of the
     * document, and an unknown address turns this page into a sign-up WITHOUT
     * navigating - so four steps later `createPasskey()` meets Chromium's
     * "A request is already pending." Whoever owns the controller when the
     * request is armed owns it for good, so arming first would leave it
     * un-abortable. See _lib/webauthn.
     *
     * ⚠ AND THE ARM IS SKIPPED IF THE INSTALL DID NOT LAND, rather than done
     * anyway. Autofill is a convenience nobody asked for; a passkey somebody
     * pressed a button for is not, and trading the second for the first is the
     * wrong way round.
     */
    if (!installAbortableWebAuthn()) return
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
  }, [isLoaded, signIn, afterAuthUrl])

  /**
   * ⚠ THE FIRST STEP CREATES THE SIGN-IN RATHER THAN JUST REMEMBERING THE
   * EMAIL. That call is what makes Clerk resolve the identifier and populate
   * `supportedFirstFactors`; skipping it and carrying the string forward would
   * turn this into two screens with one screen's worth of information.
   */
  async function onIdentifier(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!signIn || busy) return

    /*
     * ⚠ NOTHING CHECKS THE SHAPE HERE ANY MORE, AND THAT IS NOT A REGRESSION.
     * `ValidatedInput` refuses its own form's submit before React's handler is
     * reached, so this runs only for an address that is worth a round trip -
     * see @repo/ui/components/validated-field. It used to be four lines here,
     * four more in the sign-up form, and none at all anywhere else.
     *
     * ⚠ VALIDATING THE IDENTIFIER AT ALL IS ONLY SAFE BECAUSE AN EMAIL IS THE
     * ONLY ONE THIS INSTANCE HAS. `signIn.create({ identifier })` accepts a
     * username or a phone number on instances configured for them, and a red
     * border under somebody's username would be the form refusing a credential
     * that works. Checked against the instance: `email_address` is the sole
     * attribute with `used_for_first_factor`. If a username is ever switched
     * on, the `check` on the field has to go or learn about it - see
     * _lib/environment.ts.
     */
    await lookUp(identifier.trim())
  }

  /**
   * Ask Clerk which account an address is, and move to its next step.
   *
   * ⚠ SPLIT OUT OF THE SUBMIT SO A REMEMBERED-ACCOUNT CARD TAKES THE SAME
   * PATH as the email box, unknown-address branch included. A card for an
   * account deleted since is just an address with no account behind it, and
   * it should do exactly what typing that address would.
   */
  async function lookUp(value: string) {
    if (!signIn || busy) return

    setBusy("identifier")
    try {
      const { error } = await signIn.create({ identifier: value })
      if (error) {
        /*
         * ⚠ "NO SUCH ACCOUNT" IS THE OTHER ANSWER, NOT AN ERROR. On a page with
         * one box serving both doors, an unknown address is how somebody says
         * they are new - and a red toast telling them so, on a form that then
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

      /*
       * ⚠ A PASSKEY FIRST, WHEN THE ACCOUNT HAS ONE. It is one tap where the
       * password is typing plus, for an account with 2FA, a code as well -
       * Clerk takes a passkey as both factors. Declining it, or a browser
       * that cannot offer it, lands on the password step as before, which
       * keeps its own "Use your passkey" button.
       */
      if (await passkeyFirst()) return

      setDirection("forward")
      setStage("password")
      setBusy(null)
    } catch {
      toast.error(TRANSPORT_FAILURE)
      setBusy(null)
    }
  }

  /**
   * Prompt for the passkey of the account `signIn.create` just identified.
   * True when it signed in and the page is leaving; false to carry on.
   *
   * ⚠ NO FLOW ARGUMENT, so it is THIS account's passkey - Clerk prepares the
   * challenge for the identified user. `discoverable` would offer every
   * passkey on the device and could sign in as somebody else.
   *
   * ⚠ EVERY FAILURE IS SILENT. Nobody pressed a passkey button; the prompt
   * was our suggestion. Safari also refuses it outright when the click that
   * started this is too long ago, which is not worth a toast either.
   */
  async function passkeyFirst(loud = false): Promise<boolean> {
    // ⚠ READ LIVE, NOT FROM `accountHasPasskey`. Called straight after
    // `signIn.create`, before any re-render: the render-time value still
    // describes the attempt from before the lookup.
    if (
      !signIn?.supportedFirstFactors?.some((factor) => factor.strategy === "passkey")
    ) {
      return false
    }
    setBusy("passkey")
    try {
      const { error } = await signIn.passkey()
      if (error || signIn.status !== "complete") {
        // Pressed on purpose (the password step's button): say why, unless
        // they cancelled - see _lib/passkey.ts.
        const reason = loud && error ? passkeyFailure(error, "use") : null
        if (reason) toast.error(reason, { description: passkeyReference(error) })
        setBusy(null)
        return false
      }
      markSignInAttempt("passkey")
      const result = await finalizeAndLeave(
        (params) => signIn.finalize(params),
        afterAuthUrl,
      )
      if (result.error) setBusy(null)
      return !result.error
    } catch (error) {
      const reason = loud ? passkeyFailure(error, "use") : null
      if (reason) toast.error(reason, { description: passkeyReference(error) })
      setBusy(null)
      return false
    }
  }

  /**
   * A saved account's card (#192).
   *
   * ⚠ THE SERVER DECIDES, FROM A COOKIE THIS SCRIPT CANNOT READ. An expired
   * session comes back as a single-use ticket: straight in, whatever way the
   * account first signed in - Google and GitHub included, without the trip.
   * A signed-out one comes back as "passkey" or as the ordinary flow. See
   * apps/api/src/devices/resume.ts for the rules.
   */
  async function pickAccount(account: RememberedAccount) {
    if (!signIn || busy) return
    setBusy("identifier")

    const answer = await resumeDevice(account.email)

    if (answer.outcome === "ticket") {
      try {
        const { error } = await signIn.ticket({ ticket: answer.ticket })
        if (!error && signIn.status === "complete") {
          const result = await finalizeAndLeave(
            (params) => signIn.finalize(params),
            afterAuthUrl,
          )
          if (!result.error) return
        } else if (
          !error &&
          (signIn.status === "needs_second_factor" ||
            signIn.status === "needs_client_trust")
        ) {
          // ⚠ 2FA WITH NO PASSKEY: the code is the one thing still asked for.
          router.push(mfaHref)
          return
        }
      } catch {
        // Fall through to the ordinary flow.
      }
    }

    setBusy(null)

    if (answer.outcome !== "passkey") {
      const viaSso = providers.find((p) => p.strategy === account.method)
      if (viaSso) {
        void startSso(viaSso.strategy)
        return
      }
    }
    setIdentifier(account.email)
    await lookUp(account.email)
  }

  /**
   * The passkey button, which used to be a page.
   *
   * ⚠ `/passkey` WAS A WHOLE SCREEN WHOSE ONLY CONTENT WAS A BUTTON THAT CALLED
   * THIS. A navigation, a render and a second decision in front of something
   * that is one tap - and the heading it showed ("Your device will ask for your
   * fingerprint") was describing a dialog the person could not see yet, because
   * it does not open until they press the thing on the next screen down. The
   * button belongs where the choice is made.
   *
   * ⚠ `discoverable`, NOT `autofill`. Autofill is the other flow - the browser
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
        /*
         * ⚠ NOT `messageFor`, WHICH SHOWED CLERK'S DEVELOPER STRING VERBATIM.
         * A passkey failure is a `ClerkWebAuthnError`, so there is no `errors`
         * array to read and `message` is what came back - including the
         * `(code="…")` brackets `ClerkError` appends. Somebody who pressed
         * Cancel on their own Touch ID sheet was shown a link to the WebAuthn
         * spec and two error codes.
         *
         * ⚠ AND `null` IS THE ANSWER FOR "THEY SAID NO". See _lib/passkey.ts:
         * dismissing the prompt is a decision, not a fault, and the interface
         * has nothing to add to it.
         */
        const reason = passkeyFailure(error, "use")
        // The code, for the report that would otherwise arrive as "it did not
        // work". See _lib/passkey.ts.
        if (reason) toast.error(reason, { description: passkeyReference(error) })
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
    } catch (error) {
      /*
       * ⚠ THE CATCH IS LOAD-BEARING HERE, UNLIKE ON THE PASSWORD FORM. A passkey
       * prompt is WebAuthn: dismissing the sheet, or a browser with no
       * authenticator at all, rejects at the platform level rather than coming
       * back as a Clerk error - and an unhandled rejection would leave this
       * stuck on "Waiting for your device…" for the rest of the session.
       *
       * ⚠ AND IT IS CLASSIFIED RATHER THAN CALLED A NETWORK PROBLEM. It used to
       * say "We could not reach the server", which is the one thing this almost
       * never is: the rejection happened in the browser, before any request.
       */
      const reason = passkeyFailure(error, "use")
      if (reason) toast.error(reason, { description: passkeyReference(error) })
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

    // ⚠ AN ATTEMPT, NOT A RESULT - promoted only once a session exists. A wrong
    // password must not teach the badge that a password is what works here.
    markSignInAttempt("password")

    try {
      const { error } = await signIn.password({
        // ⚠ PASSED AGAIN RATHER THAN RELYING ON THE SIGN-IN CREATED ABOVE.
        // Clerk will use the in-progress attempt's identifier when this is
        // omitted, which works - until the attempt is garbage-collected by a
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
         * the browser out of here - see _lib/finish.ts for why the destination
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
      // Treating it as unsupported - which this did - makes correct
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
        // The lock stays on for the same reason as above - this page is going
        // away.
        router.push(mfaHref)
        return
      }

      // ⚠ ANYTHING ELSE IS A DEAD END *TODAY*, AND IT SAYS SO RATHER THAN
      // FAILING QUIETLY. `needs_new_password` - an admin forcing a change - is
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
    stepBack("signin", stage, () => {
      setDirection("back")
      setStage("identifier")
    })
  }

  return (
    <div className="flex flex-col gap-6">
      {/*
       * ⚠ THE STAGE IS KEYED ON `stage`, AND THE HEADING IS INSIDE IT. Keeping
       * a fixed heading above the swap would leave one line of the card
       * stationary while everything under it moved, which reads as the page
       * partially failing to update. The whole panel is one object changing
       * state - see @repo/ui/components/step-stage.
       */}
      {/*
       * ⚠ OUTSIDE THE STAGE, so the step swap cannot unmount it mid-prompt. It
       * covers the page while the operating system's own dialog is open - see
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
               * they are in the wrong place - which, on a page that was about
               * to sign them up, is the one sentence that sends them away.
               *
               * ⚠ AND THE BOTH-DOORS HEADING CARRIES NO SUBTITLE, BECAUSE THE
               * SUBTITLE WAS EXPLAINING THE MECHANISM. "We will sign you in, or
               * start a new account" describes what WE do with the address; the
               * person already knows what an email box is for, and a field
               * labelled "Email address" under "Log in or sign up" leaves nothing
               * ambiguous. It also meant the two halves of this page were
               * different heights, so the header moved when the lookup did.
               */}
              <div className="flex flex-col items-center gap-1 text-center">
                <h1 className="text-2xl font-bold">
                  {onUnknownIdentifier ? "Log in or sign up" : "Login to your account"}
                </h1>
                {!onUnknownIdentifier && (
                  <p className="text-sm text-balance text-muted-foreground">
                    Enter your email to continue
                  </p>
                )}
              </div>

              {/*
               * Accounts this device has signed in to before - see
               * _components/remembered-accounts.tsx. Nothing at all on a first
               * visit, so the page is unchanged for most people.
               */}
              <RememberedAccounts
                expected={savedAccounts}
                disabled={!signIn || locked}
                onPick={(account) => void pickAccount(account)}
              />

              {/*
               * ⚠ "LAST USED" IS DRAWN INSIDE THE FIELD (as its trailing
               * adornment) when a password was the last way in and no saved
               * account already says so. On the email box rather than only on
               * the button two steps later: this is where somebody decides
               * between typing and the provider buttons below.
               */}
              <div className="relative">
                <EmailInput
                  id="email"
                  name="email"
                  label="Email address"
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  check={emailProblem}
                  required="Enter your email address."
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
                  // The chip sits INSIDE the field at its trailing end; the
                  // padding keeps a long address from running under it.
                  className={lastUsed === "password" ? "pe-28" : undefined}
                  adornment={lastUsed === "password" ? <LastUsedBadge /> : undefined}
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
                  lastUsed={lastUsed}
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
                  // The positioning context for the chip below - see
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
                       * `markSignInAttempt("passkey")` on success - without
                       * that this button was the one way in that never became
                       * "last used", which is the worst one to forget: somebody
                       * who signs in with a passkey has no password to fall
                       * back on and most needs reminding which button it was.
                       */}
                      {lastUsed === "passkey" && (
                        <LastUsedBadge className="absolute end-4 top-1/2 -translate-y-1/2" />
                      )}
                    </>
                  )}
                </Button>
              </Field>
              {/*
               * ⚠ "DON'T HAVE AN ACCOUNT? SIGN UP" IS GONE, AND ITS ABSENCE IS
               * THE POINT OF THE PAGE. It asked somebody to answer a question
               * the box below is about to answer for them - and answering it
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
                 * back - the browser's back button leaves Clerk's sign-in
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
                /*
                 * ⚠ NO `check`, DELIBERATELY. Signing IN, the only thing wrong
                 * with a password is that it is not the right one, and only
                 * Clerk knows that - a policy check here would redden a
                 * correct password chosen before the rules were tightened.
                 */
                required="Enter your password."
                disabled={locked}
                autoFocus
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

              {/*
               * ⚠ NO "Last used" CHIP HERE, AND ITS ABSENCE IS THE POINT. The
               * email box two steps back already carries it - see the note
               * there - and by this screen the choice is made: the address is
               * typed, the provider buttons are gone, and this is the only
               * control on the page. A hint about which method to pick, shown
               * after the method has been picked, annotates nothing.
               *
               * ⚠ AND SHOWING IT IN BOTH PLACES WAS WORSE THAN SHOWING IT IN
               * THE WRONG ONE. One fact, announced twice on the way through a
               * single flow, reads as two different facts - the second one
               * arriving next to a password field invites "last used… what,
               * this password?", which is not what it records.
               */}
              <Button type="submit" size="xl" disabled={!signIn || locked}>
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
                  "Login"
                )}
              </Button>

              {/*
               * ⚠ THE PASSKEY STAYS ONE PRESS AWAY ON THIS STEP. The email step
               * already offered it once; somebody who dismissed that, or whose
               * browser refused it, should not have to type a password they
               * set up a passkey to avoid.
               */}
              {accountHasPasskey && (
                <Button
                  type="button"
                  variant="outline"
                  size="xl"
                  onClick={() => void passkeyFirst(true)}
                  disabled={!signIn || locked}
                >
                  <PasskeyIcon aria-hidden="true" />
                  Use your passkey
                </Button>
              )}
            </FieldGroup>
          </form>
        )}
      </StepStage>

      {/*
       * ⚠ OUTSIDE THE STAGE, SO IT IS NEVER UNMOUNTED. Clerk's bot protection
       * mounts itself into this exact id and its absence is a silent failure:
       * with Smart CAPTCHA on and no `#clerk-captcha` in the DOM, Clerk rejects
       * the attempt rather than challenging it - which is what
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
