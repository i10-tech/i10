"use client"

import * as React from "react"
import { useSession, useUser } from "@clerk/nextjs"
import { isClerkAPIResponseError } from "@clerk/nextjs/errors"
import type {
  SessionVerificationFirstFactor,
  SessionVerificationLevel,
  SessionVerificationResource,
  SessionVerificationSecondFactor,
} from "@clerk/shared/types"
import {
  ArrowLeft,
  KeyRound,
  Mail,
  MessageSquare,
  ShieldCheck,
  Smartphone,
} from "lucide-react"
import { Button } from "@repo/ui/components/button/button"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { OtpField, OTP_LENGTH } from "@repo/ui/components/i10/otp-field"
import { PasskeyIcon } from "@repo/ui/components/i10/passkey-icons"
import { PasswordInput } from "@repo/ui/components/i10/password-input"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { StepStage } from "@repo/ui/components/i10/step-stage"
import { ValidatedInput } from "@repo/ui/components/i10/validated-field"
import { TextShimmer } from "@repo/ui/components/text-shimmer/text-shimmer"
import { ResendCode, useCodeSend } from "@/lib/code-send"

/**
 * "Prove it is you", ours (2026-10-12) - the replacement for Clerk's
 * `<UserVerification />`, the modal `useReverification` opened.
 *
 * ⚠ CLERK'S DIALOG WAS THE ONE PIECE OF ITS UI THAT DID NOT EARN ITS PLACE.
 * It worked less often than it failed: it read freshness on the client and
 * sometimes decided there was nothing to ask, it could not be styled into the
 * product, and it had no passkey screen of its own. This walks the same
 * session-verification API Clerk's modal walks - `startVerification`, then a
 * first factor and/or a second - with our own fields.
 *
 * ⚠ THE ORDER IS THE PERSON'S STRONGEST FACTOR FIRST, as Clerk's modal did:
 * a passkey where Clerk offers one, then the second factor (authenticator app,
 * SMS code, backup code), then the password or an emailed code. "Use another
 * method" lists the rest, as Clerk's "Use another method" did.
 *
 * ⚠ THE PASSKEY IS A BUTTON, NOT AN AUTOMATIC PROMPT. Clerk's modal fired the
 * browser's prompt the moment it opened, which landed an OS dialog on top of
 * one somebody had not read yet. Pressing "Continue with passkey" raises our
 * passkey screen (the one sign-in shows) over everything, and when the
 * passkey answers, this dialog closes underneath it - so the screen fades
 * straight back to the dashboard, never back to a dialog that is leaving.
 *
 * ⚠ WHETHER A PASSKEY SATISFIES A SECOND-FACTOR LEVEL IS CLERK'S CALL, NOT
 * OURS. Clerk's reverification docs list no passkey factor; the API offers one
 * in `supportedFirstFactors` when it will take one. So it is offered only when
 * listed, and if Clerk still wants a second factor after it, the passkey drops
 * off this attempt's list and the authenticator takes its place.
 */

type Method =
  | "passkey"
  | "password"
  | "email_code"
  | "phone_code"
  | "totp"
  | "phone_code_2fa"
  | "backup_code"

type Screen = Method | "loading" | "methods" | "failed" | "verified"

export interface StepUpRequest {
  /** New per ask, so a second ask starts from the top. */
  id: number
  level: SessionVerificationLevel
}

const SECOND_ORDER: Method[] = ["totp", "phone_code_2fa", "backup_code"]
const FIRST_ORDER: Method[] = ["password", "email_code", "phone_code"]

/**
 * The methods to offer, strongest first.
 *
 * ⚠ THE PASSKEY IS FIRST WHENEVER THE ACCOUNT HAS ONE, WHATEVER CLERK'S
 * VERIFICATION LISTS. Clerk treats a passkey as a first factor and, for an
 * account with a second factor, asks for the code instead; we own the rule
 * as well as the dialog, and the API accepts a passkey this session has just
 * used (see `clerkFreshAuth`). So it leads, and the rest follow Clerk's list.
 */
function methodsFor(
  verification: SessionVerificationResource | null,
  hasPasskey: boolean,
  hasEmail = false,
): Method[] {
  const first = verification?.supportedFirstFactors ?? []
  const second = verification?.supportedSecondFactors ?? []
  const passkey =
    hasPasskey || first.some((factor) => factor.strategy === "passkey")
      ? (["passkey"] as Method[])
      : []
  // Before Clerk answers: what needs nothing from it - so the dialog opens
  // complete, "Use another method" included, rather than growing a moment later.
  if (!verification)
    return [...passkey, ...(hasEmail ? (["email_code"] as Method[]) : [])]
  if (verification.status === "needs_second_factor") {
    const offered = new Set<Method>(
      second.map((factor) =>
        factor.strategy === "phone_code"
          ? "phone_code_2fa"
          : (factor.strategy as Method),
      ),
    )
    /*
     * ⚠ AN EMAILED CODE IS OFFERED HERE TOO, LAST (2026-10-12). It is a first
     * factor, so for an account with a second factor it is followed by that
     * factor - the API's `strict` check needs one - rather than replacing it.
     */
    return [
      ...passkey,
      ...SECOND_ORDER.filter((method) => offered.has(method)),
      ...(hasEmail ? (["email_code"] as Method[]) : []),
    ]
  }
  const offered = new Set(first.map((factor) => factor.strategy as string))
  if (hasEmail) offered.add("email_code")
  return [...passkey, ...FIRST_ORDER.filter((method) => offered.has(method))]
}

/** Clerk's own wording for a refusal, or ours when it gives none. */
function reasonOf(error: unknown): string {
  if (isClerkAPIResponseError(error)) {
    const first = error.errors[0]
    return first?.longMessage ?? first?.message ?? "That did not work. Try again."
  }
  return "That did not work. Try again."
}

/** The browser's passkey prompt closed without an answer: not an error to shout about. */
function cancelled(error: unknown): boolean {
  const text = `${(error as { name?: string })?.name ?? ""} ${(error as { code?: string })?.code ?? ""} ${(error as { message?: string })?.message ?? ""}`
  return /NotAllowed|cancel|abort/i.test(text)
}

const COPY: Record<Screen, string> = {
  loading: "Checking what this account can confirm with.",
  passkey: "Use your passkey to confirm it is you.",
  password: "Enter your password to continue.",
  email_code: "Enter the code we just emailed you.",
  phone_code: "Enter the code we just texted you.",
  totp: "Enter the six-digit code from your authenticator app.",
  phone_code_2fa: "Enter the code we just texted you.",
  backup_code: "Enter one of the backup codes you saved.",
  methods: "Choose how to confirm it is you.",
  failed: "We could not start the check.",
  verified: "Verified.",
}

const LABEL: Record<Method, { text: string; icon: React.ReactNode }> = {
  passkey: { text: "Use your passkey", icon: <PasskeyIcon /> },
  password: { text: "Use your password", icon: <KeyRound /> },
  email_code: { text: "Email a code to your primary address", icon: <Mail /> },
  phone_code: { text: "Text me a code", icon: <MessageSquare /> },
  totp: { text: "Use your authenticator app", icon: <Smartphone /> },
  phone_code_2fa: { text: "Text me a code", icon: <MessageSquare /> },
  backup_code: { text: "Use a backup code", icon: <ShieldCheck /> },
}

export function StepUpDialog({
  request,
  onDone,
  onPasskey,
}: {
  request: StepUpRequest | null
  /** `true` once Clerk says complete; `false` if the person closed it. */
  onDone: (proved: boolean) => void
  /** Raise or lower the full-screen passkey screen, which lives above this. */
  onPasskey: (up: boolean) => void
}) {
  const { session } = useSession()
  const { user } = useUser()
  const hasPasskey = (user?.passkeys?.length ?? 0) > 0
  const [verification, setVerification] =
    React.useState<SessionVerificationResource | null>(null)
  const [screen, setScreen] = React.useState<Screen>("loading")
  const [direction, setDirection] = React.useState<"forward" | "back">("forward")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [code, setCode] = React.useState("")
  const [secret, setSecret] = React.useState("")
  const [accepted, setAccepted] = React.useState(false)
  const settled = React.useRef(false)
  /**
   * Whether Clerk's current verification is the one at the API's level. The
   * passkey replaces it with a first-factor one of its own; every other
   * method needs it back, so `levelled()` restarts it before they run.
   */
  const atLevel = React.useRef(false)
  /** After an emailed code, the second factor is "one more step", not a new ask. */
  const [then, setThen] = React.useState(false)

  const primaryEmail = user?.primaryEmailAddress ?? null
  const methods = methodsFor(verification, hasPasskey, primaryEmail !== null)

  const go = React.useCallback((next: Screen, way: "forward" | "back" = "forward") => {
    setDirection(way)
    setError(null)
    setCode("")
    setSecret("")
    setAccepted(false)
    setScreen(next)
  }, [])

  /*
   * ⚠ EVERY ASK STARTS A NEW VERIFICATION, as Clerk's modal did on open. A
   * verification is single-use on Clerk's side; reusing one from an earlier
   * ask would answer a question nobody is asking any more.
   */
  const id = request?.id
  const level = request?.level
  // A new ask resets the screen in the render that brings it, not after it.
  const [askId, setAskId] = React.useState(id)
  if (id !== undefined && id !== askId) {
    setAskId(id)
    setVerification(null)
    setDirection("forward")
    setError(null)
    setCode("")
    setSecret("")
    setAccepted(false)
    setThen(false)
    // A passkey needs nothing from Clerk to be offered: show it at once.
    setScreen(hasPasskey ? "passkey" : "loading")
  }
  React.useEffect(() => {
    if (id === undefined || !level || !session) return
    let alive = true
    settled.current = false
    atLevel.current = false
    session
      .startVerification({ level })
      .then((started) => {
        if (!alive) return
        if (started.status === "complete") return finish(false)
        atLevel.current = true
        setVerification(started)
        if (!hasPasskey) go(methodsFor(started, false)[0] ?? "failed")
      })
      .catch((cause: unknown) => {
        if (!alive || hasPasskey) return
        setError(reasonOf(cause))
        go("failed")
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per ask
  }, [id])

  function finish(viaPasskey: boolean) {
    if (settled.current) return
    settled.current = true
    if (viaPasskey) {
      /*
       * ⚠ CLOSE UNDER THE PASSKEY SCREEN, THEN LIFT IT. The dialog leaves
       * while it is covered, so when the screen fades out what is behind it
       * is the page the person was on - not a dialog on its way out.
       */
      onDone(true)
      window.setTimeout(() => onPasskey(false), 160)
      return
    }
    setAccepted(true)
    // Long enough to see the code turn green and the tick draw, as on sign-in.
    window.setTimeout(() => onDone(true), 650)
  }

  /** Clerk answered an attempt: done, or on to the factor it wants next. */
  function after(next: SessionVerificationResource) {
    if (next.status === "complete") return finish(false)
    setVerification(next)
    go(methodsFor(next, false).filter((method) => method !== "passkey")[0] ?? "failed")
  }

  /** Clerk's verification at the API's level, restarted if the passkey replaced it. */
  async function levelled() {
    if (atLevel.current || !session || !level) return
    const started = await session.startVerification({ level })
    atLevel.current = true
    setVerification(started)
  }

  async function attempt(run: () => Promise<SessionVerificationResource>) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await levelled()
      after(await run())
    } catch (cause) {
      setError(reasonOf(cause))
    } finally {
      setBusy(false)
    }
  }

  async function provePasskey() {
    if (!session || busy) return
    setBusy(true)
    setError(null)
    onPasskey(true)
    try {
      /*
       * ⚠ A FIRST-FACTOR VERIFICATION OF ITS OWN, THEN THE PASSKEY. Clerk's
       * level-matched one may be waiting on a code and refuse a passkey; this
       * one wants exactly a first factor, and the passkey is one. Whether it
       * was enough is the API's call, asked as soon as this closes.
       */
      atLevel.current = false
      await session.startVerification({ level: "first_factor" })
      const next = await session.verifyWithPasskey()
      if (
        next.firstFactorVerification?.status !== "verified" &&
        next.status !== "complete"
      )
        throw new Error("The passkey was not accepted.")
      finish(true)
    } catch (cause) {
      onPasskey(false)
      setError(
        cancelled(cause)
          ? "The passkey did not answer. Try again, or use another method."
          : reasonOf(cause),
      )
    } finally {
      setBusy(false)
    }
  }

  /*
   * ⚠ A CODE IS SENT WHEN ITS SCREEN OPENS, NOT WHEN THE DIALOG DOES - as
   * Clerk's modal prepared a factor only once it was chosen. Nobody gets an
   * email for a method they never picked.
   */
  const firstFactor = (strategy: string) =>
    verification?.supportedFirstFactors?.find(
      (factor) => factor.strategy === strategy,
    ) as
      | (SessionVerificationFirstFactor & {
          emailAddressId?: string
          phoneNumberId?: string
          safeIdentifier?: string
        })
      | undefined
  const secondFactor = (strategy: string) =>
    verification?.supportedSecondFactors?.find(
      (factor) => factor.strategy === strategy,
    ) as
      | (SessionVerificationSecondFactor & {
          phoneNumberId?: string
          safeIdentifier?: string
        })
      | undefined

  /*
   * ⚠ ONE CODE A MINUTE, HELD BY THE API (2026-10-12). Opening the screen
   * sends the first; "Send a new code" stays greyed with the seconds left
   * until the minute is up, and coming back to the screen inside it sends
   * nothing - the countdown picks up where it was. See lib/code-send.tsx.
   */
  const codes = useCodeSend(
    screen === "email_code" || screen === "phone_code" || screen === "phone_code_2fa"
      ? `step-up:${screen}`
      : null,
  )

  async function deliver() {
    if (!session) return
    if (screen === "email_code") {
      /*
       * ⚠ ITS OWN FIRST-FACTOR VERIFICATION, TO THE PRIMARY ADDRESS. The
       * level-matched one may be waiting on a second factor and refuse an
       * emailed code; this one asks for exactly a first factor.
       */
      if (!primaryEmail) return
      atLevel.current = false
      await session.startVerification({ level: "first_factor" })
      await session.prepareFirstFactorVerification({
        strategy: "email_code",
        emailAddressId: primaryEmail.id,
      })
      return
    }
    await levelled()
    if (screen === "phone_code") {
      const factor = firstFactor("phone_code")
      if (factor?.phoneNumberId)
        await session.prepareFirstFactorVerification({
          strategy: "phone_code",
          phoneNumberId: factor.phoneNumberId,
        })
    } else if (screen === "phone_code_2fa") {
      const factor = secondFactor("phone_code")
      await session.prepareSecondFactorVerification({
        strategy: "phone_code",
        ...(factor?.phoneNumberId ? { phoneNumberId: factor.phoneNumberId } : {}),
      })
    }
  }

  async function send() {
    try {
      await codes.send(deliver)
    } catch (cause) {
      setError(reasonOf(cause))
    }
  }

  // The latest `send`, so the effect below runs once per screen, not per render.
  const sendRef = React.useRef(send)
  React.useEffect(() => {
    sendRef.current = send
  })

  React.useEffect(() => {
    if (
      screen !== "email_code" &&
      screen !== "phone_code" &&
      screen !== "phone_code_2fa"
    )
      return
    // After the screen has moved in, so a refusal lands on the screen it is about.
    const timer = window.setTimeout(() => void sendRef.current(), 0)
    return () => window.clearTimeout(timer)
  }, [screen])

  async function submitEmailCode() {
    if (!session || busy) return
    setBusy(true)
    setError(null)
    try {
      await session.attemptFirstFactorVerification({ strategy: "email_code", code })
      /*
       * ⚠ AN ACCOUNT WITH A SECOND FACTOR GOES ON TO IT. The email code is a
       * first factor; `strict` wants the second. Back to the API's level,
       * which now asks only for that.
       */
      if (user?.twoFactorEnabled && level !== "first_factor") {
        const next = await session.startVerification({
          level: level ?? "second_factor",
        })
        atLevel.current = true
        setVerification(next)
        if (next.status === "complete") return finish(false)
        setThen(true)
        go(
          methodsFor(next, false).filter(
            (m) => m !== "passkey" && m !== "email_code",
          )[0] ?? "failed",
        )
        return
      }
      finish(false)
    } catch (cause) {
      setError(reasonOf(cause))
    } finally {
      setBusy(false)
    }
  }

  function submitCode() {
    if (!session || code.length < OTP_LENGTH) return
    if (screen === "email_code") return void submitEmailCode()
    void attempt(() => {
      if (screen === "phone_code")
        return session.attemptFirstFactorVerification({ strategy: "phone_code", code })
      if (screen === "phone_code_2fa")
        return session.attemptSecondFactorVerification({ strategy: "phone_code", code })
      return session.attemptSecondFactorVerification({ strategy: "totp", code })
    })
  }

  const others = methods.filter((method) => method !== screen)
  const where =
    screen === "email_code"
      ? primaryEmail?.emailAddress
      : screen === "phone_code"
        ? firstFactor("phone_code")?.safeIdentifier
        : screen === "phone_code_2fa"
          ? secondFactor("phone_code")?.safeIdentifier
          : undefined

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !settled.current) {
          settled.current = true
          onDone(false)
        }
      }}
    >
      <DialogContent
        // Clerk's modal said "Verification required"; so does ours.
        title="Verification required"
        description={`${then && screen !== "methods" ? "One more step. " : ""}${
          where ? `${COPY[screen].replace(/\.$/, "")} at ${where}.` : COPY[screen]
        }`}
        className="max-w-sm"
        // The passkey screen covers this; a stray click outside must not end it.
        onPointerDownOutside={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <StepStage step={screen} direction={direction}>
          <div className="flex flex-col gap-3 pt-1">
            {screen === "loading" && (
              <div className="flex justify-center py-6">
                <TextShimmer as="p" className="text-sm text-muted-foreground">
                  Checking your session
                </TextShimmer>
              </div>
            )}

            {screen === "failed" && (
              <p className="text-sm text-danger">
                {error ??
                  "This account has no way to confirm it here. Sign in again instead."}
              </p>
            )}

            {screen === "passkey" && (
              <div>
                <div className="flex flex-col gap-7 pt-2">
                  <PasskeyTile />
                  {/*
                   * ⚠ THE ONE BUTTON THAT RAISES THE PASSKEY SCREEN. See the
                   * note at the top: Clerk fired the prompt on open; we wait
                   * for the press.
                   */}
                  <Button size="lg" loading={busy} onClick={() => void provePasskey()}>
                    <PasskeyIcon aria-hidden />
                    Continue with passkey
                  </Button>
                </div>
                <ErrorLine text={error} />
              </div>
            )}

            {screen === "password" && (
              <form
                className="flex flex-col gap-5"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!session || !secret) return
                  void attempt(() =>
                    session.attemptFirstFactorVerification({
                      strategy: "password",
                      password: secret,
                    }),
                  )
                }}
              >
                <PasswordInput
                  id="step-up-password"
                  label="Password"
                  autoComplete="current-password"
                  autoFocus
                  value={secret}
                  onChange={(event) => {
                    setError(null)
                    setSecret(event.target.value)
                  }}
                  required="Enter your password."
                  refused={error ?? undefined}
                />
                <Button
                  type="submit"
                  size="lg"
                  loading={busy || accepted}
                  disabled={!secret}
                >
                  Continue
                </Button>
              </form>
            )}

            {(screen === "email_code" ||
              screen === "phone_code" ||
              screen === "phone_code_2fa" ||
              screen === "totp") && (
              <form
                className="flex flex-col gap-5"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault()
                  submitCode()
                }}
              >
                <OtpField
                  value={code}
                  onChange={(next) => {
                    setError(null)
                    setCode(next)
                  }}
                  onComplete={submitCode}
                  label={screen === "totp" ? "Code from your app" : "Verification code"}
                  state={error ? "invalid" : "idle"}
                  hint={error}
                  verified={accepted}
                  autoFocus
                />
                <Button
                  type="submit"
                  size="lg"
                  loading={busy}
                  disabled={code.length < OTP_LENGTH || accepted}
                >
                  Continue
                </Button>
                {screen !== "totp" && (
                  <ResendCode
                    className="self-center"
                    remaining={codes.remaining}
                    sending={codes.sending}
                    onClick={() => void send()}
                  />
                )}
              </form>
            )}

            {screen === "backup_code" && (
              <form
                className="flex flex-col gap-5"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!session || !code.trim()) return
                  void attempt(() =>
                    session.attemptSecondFactorVerification({
                      strategy: "backup_code",
                      code: code.trim(),
                    }),
                  )
                }}
              >
                <ValidatedInput
                  id="step-up-backup"
                  label="Backup code"
                  autoComplete="one-time-code"
                  autoFocus
                  value={code}
                  onChange={(event) => {
                    setError(null)
                    setCode(event.target.value)
                  }}
                  required="Enter one of your backup codes."
                  refused={error ?? undefined}
                />
                <Button
                  type="submit"
                  size="lg"
                  loading={busy || accepted}
                  disabled={!code.trim()}
                >
                  Continue
                </Button>
              </form>
            )}

            {screen === "methods" && (
              <div className="flex flex-col gap-2">
                {methods.map((method) => (
                  <Button
                    key={method}
                    variant="secondary"
                    size="lg"
                    className="justify-start"
                    onClick={() => go(method)}
                  >
                    {LABEL[method].icon}
                    {LABEL[method].text}
                  </Button>
                ))}
              </div>
            )}

            {/*
             * ⚠ CLERK'S "USE ANOTHER METHOD", SMALL AND UNDER EVERYTHING. It is
             * the way out of a factor somebody cannot use right now - their
             * phone is in the other room - not a choice to make every time.
             */}
            {screen === "methods" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-center text-muted-foreground"
                onClick={() => go(methods[0] ?? "failed", "back")}
              >
                <ArrowLeft aria-hidden />
                Back
              </Button>
            ) : others.length > 0 && screen !== "loading" && screen !== "failed" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-center text-muted-foreground"
                disabled={busy || accepted}
                onClick={() => go("methods")}
              >
                Use another method
              </Button>
            ) : null}
          </div>
        </StepStage>
      </DialogContent>
    </Dialog>
  )
}

/** The passkey screen's tile, small, so the dialog and the screen it raises read as one thing. */
function PasskeyTile() {
  return (
    <div className="flex justify-center py-2">
      <span className="grid size-14 place-items-center rounded-2xl bg-linear-to-b from-foreground/[0.11] to-foreground/[0.03] ring-1 ring-foreground/10 ring-inset">
        <PasskeyIcon className="size-7 text-foreground/90" aria-hidden />
      </span>
    </div>
  )
}

/**
 * A refusal under the passkey button: takes no room until there is one, then
 * opens on Arc's panel motion - so the button sits right above "Use another
 * method" the rest of the time.
 */
function ErrorLine({ text }: { text: string | null }) {
  // The last thing said, kept while the line closes so it does not empty first.
  const [shown, setShown] = React.useState(text)
  if (text && text !== shown) setShown(text)
  return (
    <Reveal show={text !== null} spacing="pt-3">
      <p aria-live="polite" className="text-center text-xs text-danger">
        {shown}
      </p>
    </Reveal>
  )
}
