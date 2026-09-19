"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { useSignIn } from "@clerk/nextjs"
import { Button } from "@repo/ui/components/button"
import { Field, FieldDescription, FieldGroup } from "@repo/ui/components/field"
import { ValidatedInput } from "@repo/ui/components/validated-field"
import { OtpField } from "../_components/otp-field"
import { ResendButton } from "../_components/resend-button"
import { messageFor, TRANSPORT_FAILURE } from "../_lib/errors"
import { finalizeAndLeave } from "../_lib/finish"

/*
 * The second factor.
 *
 * ⚠ THIS PAGE HOLDS NO STATE OF ITS OWN ABOUT WHO IS SIGNING IN. It resumes the
 * `signIn` that the sign-in form left in Clerk's client state, which is why
 * getting here has to be a CLIENT-SIDE navigation — a full page load starts a
 * fresh Clerk client with no attempt in progress, and the person would be sent
 * back to the beginning. `router.push` from the sign-in form, never
 * `window.location`.
 *
 * ⚠ AND A RELOAD IS TREATED AS A LOST ATTEMPT, DELIBERATELY. If the status is
 * not `needs_second_factor` there is nothing to verify against; showing the
 * code boxes anyway would collect six digits and then fail with something
 * unrelated to what the person did.
 */

/** The strategies this page can actually finish. `email_link` is not one. */
type Method = "totp" | "phone_code" | "email_code" | "backup_code"

const LABELS: Record<Method, string> = {
  totp: "Authenticator app",
  phone_code: "Text message",
  email_code: "Email",
  backup_code: "Backup code",
}

const BLURB: Record<Method, string> = {
  totp: "Enter the code from your authenticator app.",
  phone_code: "We sent a code to your phone.",
  email_code: "We sent a code to your email.",
  backup_code: "Enter one of the backup codes you saved when you set this up.",
}

export function MfaForm({
  afterAuthUrl,
  signInHref,
}: {
  afterAuthUrl: string
  signInHref: string
}) {
  const { signIn } = useSignIn()
  const formRef = useRef<HTMLFormElement>(null)
  const [method, setMethod] = useState<Method | null>(null)
  const [code, setCode] = useState("")
  /** Clerk's own sentence about the last code, shown under the boxes. */
  const [rejected, setRejected] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  /**
   * Which strategies have already had a code dispatched.
   *
   * ⚠ A REF, NOT STATE, AND THE DIFFERENCE IS CORRECTNESS RATHER THAN STYLE.
   * Nothing renders from it, so making it state would schedule a re-render that
   * re-runs this effect — and setting state inside an effect that depends on it
   * is the loop React lints against. A ref also updates SYNCHRONOUSLY, which is
   * the property that actually matters here: two renders in the same tick both
   * see the write, so a second code is never sent to invalidate the first.
   */
  const sent = useRef<Partial<Record<Method, boolean>>>({})

  // ⚠ TWO STATUSES LAND HERE, AND ONLY ONE OF THEM IS "TWO-FACTOR AUTH".
  // `needs_second_factor` is a factor the ACCOUNT enrolled. `needs_client_trust`
  // is Clerk proving this BROWSER — it fires on a first sign-in from a new
  // device whether or not anyone turned MFA on, and it is answered through the
  // same `mfa` namespace. Gating on the first alone left the common case
  // stranded on a page that told people to start again.
  const ready =
    signIn?.status === "needs_second_factor" || signIn?.status === "needs_client_trust"

  // What this account actually has enrolled, narrowed to what we can finish.
  const available: Method[] = (signIn?.supportedSecondFactors ?? [])
    .map((factor) => factor.strategy)
    .filter((s): s is Method => s in LABELS)

  // ⚠ TOTP FIRST WHERE IT EXISTS, because it is the only one that needs no
  // round trip — the code is already on the person's phone. Defaulting to a
  // code we have to send would put an avoidable email or SMS in front of
  // somebody who did not need one.
  const preferred =
    available.find((m) => m === "totp") ??
    available.find((m) => m !== "backup_code") ??
    available[0] ??
    null

  const active = method ?? preferred

  useEffect(() => {
    if (!signIn || !ready || !active) return
    if (active !== "phone_code" && active !== "email_code") return
    if (sent.current[active]) return

    // Marked before the await, not after: otherwise both renders see `false`.
    sent.current[active] = true

    const send =
      active === "phone_code" ? signIn.mfa.sendPhoneCode() : signIn.mfa.sendEmailCode()

    void send
      .then(({ error }) => {
        if (error) {
          toast.error(messageFor(error))
          return
        }
        toast.success(
          active === "phone_code"
            ? "We sent a code to your phone."
            : "We sent a code to your email.",
        )
      })
      .catch(() => toast.error(TRANSPORT_FAILURE))
  }, [signIn, ready, active])

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!signIn || !active || pending) return

    setPending(true)

    try {
      const { error } =
        active === "totp"
          ? await signIn.mfa.verifyTOTP({ code })
          : active === "backup_code"
            ? await signIn.mfa.verifyBackupCode({ code })
            : active === "phone_code"
              ? await signIn.mfa.verifyPhoneCode({ code })
              : await signIn.mfa.verifyEmailCode({ code })

      if (error) {
        /*
         * ⚠ UNDER THE BOXES, NOT IN A TOAST. A rejected code is the single most
         * common failure on this screen, and a toast that slides away after
         * four seconds leaves six boxes looking exactly as they did when the
         * code was still unjudged — so somebody who looked away comes back to a
         * screen that has forgotten it said no. The field now holds the verdict
         * until it is acted on, which is what the red border is for.
         */
        setRejected(messageFor(error))
        // ⚠ CLEARED ON FAILURE, for the code strategies only. A wrong six-digit
        // code is never salvaged by editing one box, and leaving it filled
        // means the next attempt starts by deleting six characters. A backup
        // code is long enough to be worth correcting rather than retyping.
        if (active !== "backup_code") setCode("")
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

      toast.error("That worked, but the sign-in needs another step we cannot do yet.")
    } catch {
      toast.error(TRANSPORT_FAILURE)
    } finally {
      setPending(false)
    }
  }

  if (!signIn) {
    return <p className="text-muted-foreground text-sm">Loading…</p>
  }

  if (!ready || !active) {
    return (
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold">Start again</h1>
          <p className="text-sm text-balance text-muted-foreground">
            This sign-in is no longer in progress. Reloading this page ends it.
          </p>
        </div>
        <Link
          href={signInHref}
          className="text-center text-sm underline underline-offset-4"
        >
          Back to sign in
        </Link>
      </FieldGroup>
    )
  }

  const others = available.filter((m) => m !== active)

  return (
    <form ref={formRef} className="flex flex-col gap-6" onSubmit={onSubmit} noValidate>
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold">Two-step verification</h1>
          <p className="text-sm text-balance text-muted-foreground">{BLURB[active]}</p>
        </div>

        {active === "backup_code" ? (
          <ValidatedInput
            id="code"
            name="code"
            label="Backup code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            autoFocus
            /*
             * ⚠ NO `check`, BECAUSE ONLY CLERK KNOWS. A backup code has no
             * shape worth asserting — they are issued, not composed — so the
             * only thing this field can say for itself is that it is empty.
             */
            required="Enter one of your backup codes."
          />
        ) : (
          <OtpField
            value={code}
            /*
             * ⚠ THE VERDICT IS DROPPED ON THE FIRST KEYSTROKE OF THE NEXT
             * ATTEMPT. A red border that survives into the code being typed to
             * replace it is marking the wrong six digits.
             */
            onChange={(next) => {
              setRejected(null)
              setCode(next)
            }}
            onComplete={() => {
              if (!pending) formRef.current?.requestSubmit()
            }}
            state={rejected ? "invalid" : "idle"}
            hint={rejected}
            autoFocus
          />
        )}

        <Field>
          {/*
           * ⚠ `xl` LIKE EVERY OTHER PRIMARY ACTION IN THIS APP. See the size in
           * @repo/ui/components/button: 56px is the field height, so a button
           * under a field reads as the same object continuing. At the default
           * 36px this page showed a visibly smaller button than the sign-in
           * page it arrives from, one click apart.
           */}
          <Button type="submit" size="xl" disabled={pending || code.length === 0}>
            {pending ? "Verifying…" : "Verify"}
          </Button>
        </Field>

        {/*
         * ⚠ NO RESEND FOR TOTP OR A BACKUP CODE, because there is nothing to
         * send. An authenticator generates its own code on the device and a
         * backup code was printed once, months ago — offering "resend" for
         * either would promise a mail that never arrives.
         */}
        {active === "phone_code" || active === "email_code" ? (
          <ResendButton
            onResend={async () => {
              const { error } =
                active === "phone_code"
                  ? await signIn.mfa.sendPhoneCode()
                  : await signIn.mfa.sendEmailCode()
              if (error) {
                toast.error(messageFor(error))
                return
              }
              toast.success("We sent another code.")
            }}
          />
        ) : null}

        {others.length > 0 ? (
          <FieldDescription className="text-center">
            Or verify another way:{" "}
            {others.map((m, i) => (
              <span key={m}>
                {i > 0 ? ", " : ""}
                <button
                  type="button"
                  className="underline underline-offset-4"
                  onClick={() => {
                    setMethod(m)
                    setCode("")
                  }}
                >
                  {LABELS[m]}
                </button>
              </span>
            ))}
          </FieldDescription>
        ) : null}
      </FieldGroup>
    </form>
  )
}
