"use client"

import { useRef, useState } from "react"
import { ShieldCheckIcon } from "lucide-react"
import { toast } from "sonner"
import { useReverification, useUser } from "@clerk/nextjs"
import {
  isClerkAPIResponseError,
  isReverificationCancelledError,
} from "@clerk/nextjs/errors"
import { Button } from "@repo/ui/components/button"
import { CopyButton } from "@repo/ui/components/copy"
import { Field, FieldGroup } from "@repo/ui/components/field"
import { QrCode } from "@repo/ui/components/qr-code"
import { Spinner } from "@repo/ui/components/spinner"
import { OtpField, OTP_LENGTH } from "../_components/otp-field"
import { StepHeading } from "../_components/step-heading"
import { TRANSPORT_FAILURE } from "../_lib/errors"
import { passkeyFailure, passkeyReference } from "../_lib/passkey"
import { abortPendingWebAuthn } from "../_lib/webauthn"
import type { SsoProvider } from "../_lib/providers"
import {
  AppleIcon,
  GitHubIcon,
  GoogleIcon,
  PasskeyIcon,
} from "../_components/provider-icons"

/*
 * The three steps that come AFTER the account exists.
 *
 * ⚠ EVERY ONE OF THEM NEEDS A SESSION, WHICH IS WHY THEY CANNOT BE PART OF THE
 * SIGN-UP ATTEMPT. `createPasskey`, `createTOTP` and `createExternalAccount` are
 * methods on `UserResource`, and there is no user until `signUp.finalize()` has
 * run. So the flow finalizes in the MIDDLE — see `finalizeWithoutLeaving` in
 * _lib/finish.ts — and these steps operate on a person who is, as far as the
 * backend is concerned, already signed up.
 *
 * ⚠ AND THAT MAKES "SKIP" A REAL GUARANTEE RATHER THAN A POLITENESS. The
 * account is safe before any of this is offered. Somebody who closes the tab on
 * the passkey step has a working account and can sign in with their password;
 * nothing here is load-bearing, and none of it may be allowed to become so.
 *
 * ⚠ THE STEPS THAT APPEAR AT ALL ARE DECIDED BY CLERK, NOT BY THIS FILE. See
 * _lib/environment.ts: an instance with passkeys switched off never renders the
 * passkey step, because a button that opens a WebAuthn prompt and then fails is
 * worse than no button.
 */

const PROVIDER_ICONS: Record<
  string,
  (props: React.ComponentProps<"svg">) => React.ReactNode
> = {
  oauth_google: GoogleIcon,
  oauth_github: GitHubIcon,
  oauth_apple: AppleIcon,
}

/** What every one of these steps needs from the flow around it. */
interface StepProps {
  /** Something else on the page is running; every control here goes dead. */
  locked: boolean
  /** Claim or release the page-wide lock. */
  onBusy: (busy: string | null) => void
  /** Which action is running, if any. */
  busy: string | null
  /** Move to the next step. */
  onNext: () => void
  /** The label for the control that moves on without doing anything. */
  skipLabel?: string
}

/* ────────────────────────────── passkey ────────────────────────────── */

export function PasskeyStep({ locked, onBusy, busy, onNext, skipLabel }: StepProps) {
  const { user } = useUser()

  /*
   * ⚠ WRAPPED, BECAUSE THIS INSTANCE HAS REVERIFICATION ON AND THIS IS ONE OF
   * THE OPERATIONS IT GUARDS. `auth_config.reverification` is `true` on the
   * production instance, so Clerk refuses `createPasskey` on a session it does
   * not consider recently verified and answers with a hint rather than a
   * result. Unwrapped, that hint fell into the catch below and was reported as
   * "we could not add a passkey on this device" — which blamed the device for a
   * policy decision, and left the person with no way to satisfy it.
   *
   * ⚠ THE HOOK IS THE WHOLE FIX: it shows the reverification prompt and REPLAYS
   * the original call once it is satisfied. Doing it by hand would mean
   * detecting the hint, driving the prompt and remembering what to retry — in
   * three places, because `createExternalAccount` below needs exactly the same
   * treatment.
   */
  const addPasskey = useReverification(() => user?.createPasskey())

  async function add() {
    if (!user || locked) return
    onBusy("passkey")

    /*
     * ⚠ THE BROWSER ALLOWS ONE WEBAUTHN REQUEST PER DOCUMENT, AND THE PAGE
     * UNDERNEATH THIS ONE ALREADY TOOK IT. The sign-in form arms conditional
     * mediation — the passkey offered inside the email field's autofill menu —
     * on mount, and it stays pending for the life of the document because it is
     * waiting for a choice nobody may ever make. Since an unknown address turns
     * that page into this flow WITHOUT navigating, the request is still open
     * here, and Chromium answers `create()` with `OperationError: A request is
     * already pending.` — which clerk-js does not translate, so it surfaced as
     * "we could not add a passkey on this device" with no prompt ever shown.
     *
     * ⚠ AND IT IS CALLED UNCONDITIONALLY, because this step is reachable two
     * ways. A reload or a provider round trip lands here in a FRESH document
     * where nothing is pending; asking which route brought somebody here would
     * be a second, forgettable copy of a fact `_lib/webauthn` already holds.
     */
    abortPendingWebAuthn()

    try {
      await addPasskey()
      toast.success("Passkey added. You can use it to sign in from now on.")
      onBusy(null)
      onNext()
    } catch (error) {
      /*
       * ⚠ THE CATCH IS LOAD-BEARING, AND DISMISSING THE SHEET IS NOT AN ERROR.
       * WebAuthn rejects at the PLATFORM level — a person who closes the Touch
       * ID dialog, a browser with no authenticator, a cross-origin iframe — and
       * "something went wrong" to somebody who deliberately pressed Cancel is
       * the interface arguing with them.
       *
       * ⚠ IT USED TO CHECK `error.name`, WHICH COULD NOT WORK. Clerk maps the
       * browser's `NotAllowedError` onto a `ClerkWebAuthnError` before we ever
       * see it, so the name is always `"ClerkWebAuthnError"` and the branch
       * below never ran — every cancelled sign-up prompt ended in "We could not
       * add a passkey on this device", blaming the device for a decision the
       * person had just made. See _lib/passkey.ts, which reads the code.
       */
      // ⚠ CANCELLING THE REVERIFICATION PROMPT IS THE SAME KIND OF ANSWER AS
      // dismissing the platform's own sheet: the person said no, and saying
      // anything back is the interface arguing with them.
      if (isReverificationCancelledError(error)) {
        onBusy(null)
        return
      }

      const reason = passkeyFailure(error, "add")
      if (reason) {
        /*
         * ⚠ THE CODE GOES UNDER THE SENTENCE, because "we could not add a
         * passkey on this device" is answerable by nobody. Clerk has nine
         * passkey codes and answers with API codes besides, and a report that
         * arrives without one costs a round trip through a person, a browser
         * and a device we do not have. See _lib/passkey.ts — the same trade
         * as printing Cloudflare's ray id.
         */
        toast.error(reason, { description: passkeyReference(error) })
      }
      onBusy(null)
    }
  }

  return (
    <FieldGroup>
      <StepHeading title="Add a passkey">
        Sign in with your fingerprint, face or screen lock instead of typing a password.
        It stays on this device and is never sent to us.
      </StepHeading>

      <Field>
        <Button type="button" size="xl" onClick={add} disabled={!user || locked}>
          {busy === "passkey" ? (
            <>
              <Spinner aria-hidden="true" aria-label={undefined} />
              Waiting for your device…
            </>
          ) : (
            <>
              {/* ⚠ THE SAME MARK THE SIGN-IN BUTTON USES. One glyph for one
                  concept: see PasskeyIcon on why it is not a plain key. */}
              <PasskeyIcon aria-hidden="true" />
              Add a passkey
            </>
          )}
        </Button>
        <SkipButton locked={locked} onNext={onNext} label={skipLabel} />
      </Field>
    </FieldGroup>
  )
}

/* ───────────────────────────── two-factor ──────────────────────────── */

/** What `createTOTP` hands back, narrowed to the parts this step shows. */
export interface TotpEnrolment {
  uri: string
  secret: string
}

export function TwoFactorOfferStep({
  locked,
  onBusy,
  busy,
  onNext,
  skipLabel,
  onEnrolled,
}: StepProps & { onEnrolled: (totp: TotpEnrolment) => void }) {
  const { user } = useUser()

  async function begin() {
    if (!user || locked) return
    onBusy("totp")

    try {
      const totp = await user.createTOTP()

      // ⚠ BOTH FIELDS ARE OPTIONAL ON THE RESOURCE AND THE STEP IS USELESS
      // WITHOUT THEM. Clerk types `secret` and `uri` as `string | undefined`
      // because the same resource shape is returned by reads that do not
      // include them. Advancing to a screen with an empty QR code and an empty
      // box to copy would look like a rendering failure.
      if (!totp.uri || !totp.secret) {
        toast.error("We could not start two-factor setup. Try again from settings.")
        onBusy(null)
        return
      }

      onEnrolled({ uri: totp.uri, secret: totp.secret })
      onBusy(null)
    } catch {
      toast.error(TRANSPORT_FAILURE)
      onBusy(null)
    }
  }

  return (
    <FieldGroup>
      <StepHeading title="Turn on two-factor">
        Ask for a code from your phone as well as your password. It is the single
        biggest thing you can do to keep the account yours.
      </StepHeading>

      <Field>
        <Button type="button" size="xl" onClick={begin} disabled={!user || locked}>
          {busy === "totp" ? (
            <>
              <Spinner aria-hidden="true" aria-label={undefined} />
              Setting up…
            </>
          ) : (
            <>
              <ShieldCheckIcon aria-hidden="true" />
              Turn on two-factor
            </>
          )}
        </Button>
        <SkipButton locked={locked} onNext={onNext} label={skipLabel} />
      </Field>
    </FieldGroup>
  )
}

export function TwoFactorScanStep({
  totp,
  locked,
  onBusy,
  busy,
  onVerified,
  onCancel,
}: {
  totp: TotpEnrolment
  locked: boolean
  onBusy: (busy: string | null) => void
  busy: string | null
  /** Backup codes, if the instance issues them. */
  onVerified: (backupCodes: string[]) => void
  onCancel: () => void
}) {
  const { user } = useUser()
  const [code, setCode] = useState("")
  /** Why the last code was refused, shown under the boxes until it is retyped. */
  const [rejected, setRejected] = useState<string | null>(null)
  /**
   * ⚠ HELD FOR THE MOMENT BETWEEN ACCEPTANCE AND LEAVING. Two-factor is on by
   * the time `onVerified` fires and this screen is replaced — so without this
   * the six boxes simply vanish, which is the one outcome that looks identical
   * to a page glitching.
   */
  const [accepted, setAccepted] = useState(false)

  /*
   * ⚠ THE SAME AUTO-SUBMIT THE EMAILED-CODE STEP HAS, AND ITS ABSENCE HERE WAS
   * THE INCONSISTENCY SOMEBODY NOTICED. Typing or pasting six digits into the
   * verification email's boxes submits by itself; doing the identical thing on
   * this screen did nothing, so the same gesture worked on one OTP and not the
   * one immediately after it.
   */
  const formRef = useRef<HTMLFormElement>(null)

  async function verify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!user || locked) return
    onBusy("totp-verify")

    try {
      await user.verifyTOTP({ code })

      /*
       * ⚠ HERE, NOT AFTER THE BACKUP CODES, AND THE ORDER IS THE WHOLE
       * DIFFERENCE BETWEEN A CONFIRMATION AND A DEAD PROP. Set after the fetch
       * below it would land in the same tick as `onVerified`, which replaces
       * this screen — the state would be true for no frames anybody sees.
       * Here, the green is on screen for exactly as long as the round trip
       * that follows it, which is the moment worth filling.
       */
      setAccepted(true)

      /*
       * ⚠ THE BACKUP CODES ARE FETCHED HERE AND THEIR FAILURE IS NOT FATAL.
       * Recovery codes are a separate Clerk resource and a separate instance
       * setting, so `createBackupCode` throws on an instance that does not
       * issue them — and two-factor is already ON by this point. Refusing to
       * advance would strand somebody whose account is now MORE secure than it
       * was, on a screen telling them something failed.
       */
      let codes: string[] = []
      try {
        codes = (await user.createBackupCode()).codes
      } catch {
        codes = []
      }

      onBusy(null)
      onVerified(codes)
    } catch {
      // ⚠ THE BOXES ARE CLEARED, because a rejected six-digit code is never
      // salvaged by editing one of them — and a TOTP code that was right
      // thirty seconds ago is now wrong for a reason nobody can see.
      //
      // ⚠ AND THE REASON STAYS ON SCREEN. See mfa-form: this one especially,
      // because "try the current one" is advice about a code that changes every
      // thirty seconds and a toast is gone before the next one appears.
      setRejected("That code was not accepted. Try the current one.")
      setCode("")
      onBusy(null)
    }
  }

  return (
    <form ref={formRef} className="flex flex-col gap-6" onSubmit={verify} noValidate>
      <FieldGroup>
        <StepHeading title="Scan this">
          Open your authenticator app, add an account, and scan the code. Then type the
          six digits it shows.
        </StepHeading>

        <div className="flex flex-col items-center gap-3">
          <QrCode value={totp.uri} title="Two-factor setup code" />
          {/*
           * ⚠ THE SECRET IS SHOWN AS WELL AS ENCODED, AND THAT IS NOT
           * REDUNDANT. Somebody setting this up ON the phone that is showing
           * this page cannot scan their own screen; somebody using a desktop
           * password manager pastes rather than scans. Without the text, both
           * of them are stuck looking at a picture.
           */}
          <div className="flex items-center gap-1">
            <code className="rounded-pill bg-muted px-3 py-1 font-mono text-xs tracking-wider break-all select-all">
              {totp.secret}
            </code>
            <CopyButton value={totp.secret} label="Copy setup key" />
          </div>
        </div>

        <OtpField
          value={code}
          onChange={(next) => {
            setRejected(null)
            setCode(next)
          }}
          onComplete={() => {
            if (!locked) formRef.current?.requestSubmit()
          }}
          label="Code from your app"
          state={rejected ? "invalid" : "idle"}
          hint={rejected}
          verified={accepted}
          autoFocus
        />

        <Field>
          <Button
            type="submit"
            size="xl"
            disabled={!user || locked || code.length < OTP_LENGTH}
          >
            {busy === "totp-verify" ? (
              <>
                <Spinner aria-hidden="true" aria-label={undefined} />
                Checking…
              </>
            ) : (
              "Turn on two-factor"
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="lg"
            onClick={onCancel}
            disabled={locked}
          >
            Do this later
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}

export function BackupCodesStep({
  codes,
  locked,
  onNext,
}: {
  codes: string[]
  locked: boolean
  onNext: () => void
}) {
  return (
    <FieldGroup>
      <StepHeading title="Save these somewhere">
        Each code signs you in once if you lose your phone. This is the only time we can
        show them.
      </StepHeading>

      <div className="grid grid-cols-2 gap-1.5 rounded-xl border p-3">
        {codes.map((code) => (
          <code
            key={code}
            className="rounded-md bg-muted px-2 py-1 text-center font-mono text-xs select-all"
          >
            {code}
          </code>
        ))}
      </div>

      <Field>
        {/*
         * ⚠ COPYING ALL OF THEM IS THE PRIMARY ACTION, NOT A CONVENIENCE. The
         * instruction is "save these", and the only way to obey it from this
         * screen without a clipboard is to write ten codes out by hand. Making
         * the useful thing the big button is the difference between codes that
         * are saved and codes that are agreed to.
         */}
        <CopyButton
          value={codes.join("\n")}
          label="Copy all codes"
          variant="outline"
          size="xl"
          className="w-full text-foreground"
        />
        <Button type="button" size="xl" onClick={onNext} disabled={locked}>
          I have saved them
        </Button>
      </Field>
    </FieldGroup>
  )
}

/* ───────────────────────────── connect SSO ─────────────────────────── */

export function ConnectStep({
  providers,
  redirectRaw,
  locked,
  onBusy,
  busy,
  onNext,
  finishLabel,
}: StepProps & {
  providers: SsoProvider[]
  /**
   * The original `?redirect_url=` the person arrived with, carried through the
   * provider round trip so they still land where they were going.
   */
  redirectRaw?: string
  finishLabel: string
}) {
  const { user } = useUser()

  /*
   * ⚠ ALREADY-LINKED PROVIDERS ARE SHOWN AS LINKED RATHER THAN HIDDEN. Somebody
   * arrives back here FROM Google, having just connected it — a button that
   * simply vanished would read as the thing not having worked. And anyone who
   * signed up with Google in the first place has one linked before they get
   * here at all.
   */
  const linked = new Set(
    (user?.externalAccounts ?? [])
      .filter((account) => account.verification?.status === "verified")
      .map((account) => `oauth_${account.provider}`),
  )

  /*
   * ⚠ THE SAME GUARD AS THE PASSKEY STEP, FOR THE SAME REASON. Connecting an
   * external account is a protected operation on an instance with
   * reverification enabled, and without this Clerk's hint arrived here as an
   * ordinary rejection — reported as "we could not start that connection",
   * which is both untrue and unactionable.
   */
  const startConnection = useReverification(
    (params: Parameters<NonNullable<typeof user>["createExternalAccount"]>[0]) =>
      user?.createExternalAccount(params),
  )

  async function connect(strategy: string) {
    if (!user || locked) return
    onBusy(strategy)

    try {
      const account = await startConnection({
        strategy: strategy as Parameters<
          typeof user.createExternalAccount
        >[0]["strategy"],
        /*
         * ⚠ BUILT HERE, AT CLICK TIME, RATHER THAN PASSED IN AS A PROP. It
         * needs `window.location.origin`, which does not exist while this
         * component is being server-rendered — and a prop computed in the
         * parent would have the same problem one level up. A click is by
         * definition in the browser.
         *
         * ⚠ AND IT COMES BACK TO PLAIN `/sign-in`, WITH NO STEP IN THE URL. The
         * provider's redirect is a full page load, so every piece of React
         * state is gone by the time the person returns — but this tab's
         * `sessionStorage` is not, and the flow resumes from it exactly as it
         * does after a reload. See _lib/resume.tsx.
         */
        redirectUrl: returnUrl(redirectRaw),
      })

      // ⚠ OPTIONAL BECAUSE THE WRAPPED CALL CAN RESOLVE TO NOTHING. The
      // reverification fetcher returns `undefined` when there is no user to act
      // on, and the guard below already says the right thing for that.
      const target = account?.verification?.externalVerificationRedirectURL
      if (!target) {
        toast.error("We could not start that connection. Try again.")
        onBusy(null)
        return
      }

      /*
       * ⚠ `assign`, NOT `replace`, AND THIS IS THE ONE PLACE THAT IS RIGHT.
       * Everywhere else in this app leaves nothing to go back to, because the
       * page being left is finished. Here the person is going OUT to a provider
       * and expected back — the browser's back button during an OAuth consent
       * screen has to return them to this step, not to whatever preceded the
       * whole sign-up.
       *
       * ⚠ AND THE LOCK IS NOT RELEASED. The page is navigating; re-enabling
       * three provider buttons for the second that takes invites a second
       * redirect on top of the first.
       */
      window.location.assign(target.toString())
    } catch (error) {
      /*
       * ⚠ THE ERROR USED TO BE DISCARDED ENTIRELY — `catch {}` with no binding
       * — and every failure here became "check your connection". That is the
       * wrong story for all of the likely ones: a session Clerk refuses on
       * policy grounds, a redirect origin the instance does not allow, a
       * provider that is enabled for sign-in but not for linking. None of them
       * are the network, and none of them improve by trying again.
       */
      if (isReverificationCancelledError(error)) {
        onBusy(null)
        return
      }
      toast.error(clerkReason(error) ?? TRANSPORT_FAILURE)
      onBusy(null)
    }
  }

  return (
    <FieldGroup>
      <StepHeading title="Connect an account">
        Link a provider and you can sign in with one tap. You can add or remove these at
        any time.
      </StepHeading>

      <Field>
        {providers.map(({ strategy, name }) => {
          const Icon = PROVIDER_ICONS[strategy]
          const isLinked = linked.has(strategy)

          return (
            <Button
              key={strategy}
              type="button"
              variant="outline"
              size="xl"
              disabled={!user || locked || isLinked}
              onClick={() => void connect(strategy)}
            >
              {busy === strategy ? (
                <Spinner aria-hidden="true" aria-label={undefined} />
              ) : Icon ? (
                <Icon aria-hidden="true" />
              ) : null}
              {isLinked ? `${name} connected` : `Connect ${name}`}
            </Button>
          )
        })}
        <Button type="button" size="xl" onClick={onNext} disabled={locked}>
          {finishLabel}
        </Button>
      </Field>
    </FieldGroup>
  )
}

/* ───────────────────────────── shared bits ─────────────────────────── */

function SkipButton({
  locked,
  onNext,
  label = "Not now",
}: {
  locked: boolean
  onNext: () => void
  label?: string
}) {
  return (
    /*
     * ⚠ `ghost` AND FULL WIDTH, NOT A SMALL LINK IN A CORNER. Skipping is a
     * legitimate answer to every one of these questions, and a flow that makes
     * declining harder to find than accepting is a dark pattern whether or not
     * it was meant as one. It is visually quieter than the primary action
     * because it is the second-best outcome, not because it is discouraged.
     */
    <Button type="button" variant="ghost" size="lg" onClick={onNext} disabled={locked}>
      {label}
    </Button>
  )
}

/** Back to the connect step, carrying the destination the person arrived with. */
function returnUrl(redirectRaw: string | undefined): string {
  /*
   * ⚠ `/sign-in`, WHICH IS THE ONLY PAGE NOW. `/sign-up` still resolves — it
   * redirects here carrying every parameter — but pointing a provider's return
   * URL at a redirect costs an extra round trip on the one journey that has
   * already been out to a third party and back.
   */
  const url = new URL("/sign-in", window.location.origin)
  if (redirectRaw) url.searchParams.set("redirect_url", redirectRaw)
  return url.toString()
}

/** Clerk's own explanation of a failure, if this is a Clerk API error. */
function clerkReason(error: unknown): string | null {
  if (!isClerkAPIResponseError(error)) return null
  const first = error.errors[0]
  return first?.longMessage ?? first?.message ?? null
}
