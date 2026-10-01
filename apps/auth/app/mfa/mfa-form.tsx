"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useClerk, useSignIn } from "@clerk/nextjs"
import { Button } from "@repo/ui/components/button"
import { Spinner } from "@repo/ui/components/spinner"
import { Field, FieldDescription, FieldGroup } from "@repo/ui/components/field"
import { ValidatedInput } from "@repo/ui/components/validated-field"
import { OtpField } from "@repo/ui/components/otp-field"
import { ResendButton } from "../_components/resend-button"
import { messageFor, TRANSPORT_FAILURE } from "../_lib/errors"
import { finalizeAndLeave, isLeaving, leaveFor } from "../_lib/finish"
import { useResumable } from "../_lib/resume"

/*
 * The second factor.
 *
 * ⚠ THIS PAGE HOLDS NO STATE OF ITS OWN ABOUT WHO IS SIGNING IN. It resumes the
 * `signIn` that the sign-in form left in Clerk's client state, which is why
 * getting here has to be a CLIENT-SIDE navigation - a full page load starts a
 * fresh Clerk client with no attempt in progress, and the person would be sent
 * back to the beginning. `router.push` from the sign-in form, never
 * `window.location`.
 *
 * ⚠ A RELOAD IS NOT A LOST ATTEMPT - PROBED 2026-09-25. Clerk's client keeps
 * the in-progress attempt server-side and hands it back on load, so this page
 * resumes it after a refresh exactly as after the `router.push`. What IS lost
 * is an attempt that expired or finished elsewhere: if the status is not
 * `needs_second_factor` there is nothing to verify against, and showing the
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
  const clerk = useClerk()
  const router = useRouter()
  /**
   * The method whose code is being checked or was accepted, frozen from the
   * moment it is submitted until it is rejected.
   *
   * ⚠ THIS IS WHAT STOPS "START AGAIN" FLASHING AFTER A CORRECT CODE. `finalize`
   * creates the session and then RESETS Clerk's sign-in attempt, so the next
   * render sees a blank attempt: no status, no second factors, and `ready`
   * false. The page used to read that as an expired sign-in and drew its dead
   * end in the gap before the dashboard arrived. Once a code is accepted, the
   * attempt no longer decides what this screen shows.
   */
  const [doneWith, setDoneWith] = useState<Method | null>(null)
  /**
   * The other methods as they were when the code went out, for the same
   * reason and over the same window as `doneWith`.
   *
   * ⚠ THIS IS WHAT STOPPED THE CARD JUMPING DOWN UNDER "Verifying…". When the
   * code is accepted Clerk empties the attempt's second factors, so the "use
   * another method" links vanished, the card got shorter, and because the
   * page centres it vertically, everything moved down by half that height
   * just before the check animated in.
   */
  const [frozenFactors, setFrozenFactors] = useState<Method[]>([])
  /**
   * The code was accepted but the session could not be made, even after a
   * retry. The page stays (nothing to go back to: the code is spent) and the
   * button finishes the same sign-in again instead of verifying.
   */
  const [stuck, setStuck] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  // ⚠ REMEMBERED ACROSS A RELOAD, so somebody who switched to a backup code
  // is not dropped back on the authenticator app. See _lib/resume.tsx.
  const [method, setMethod] = useResumable<Method | null>("mfa.method", null)
  const [code, setCode] = useState("")
  /** Clerk's own sentence about the last code, shown under the boxes. */
  const [rejected, setRejected] = useState<string | null>(null)
  /** The code was accepted, for the half-second before this screen leaves. */
  const [accepted, setAccepted] = useState(false)
  const [pending, setPending] = useState(false)
  /**
   * Which strategies have already had a code dispatched.
   *
   * ⚠ A REF, NOT STATE, AND THE DIFFERENCE IS CORRECTNESS RATHER THAN STYLE.
   * Nothing renders from it, so making it state would schedule a re-render that
   * re-runs this effect - and setting state inside an effect that depends on it
   * is the loop React lints against. A ref also updates SYNCHRONOUSLY, which is
   * the property that actually matters here: two renders in the same tick both
   * see the write, so a second code is never sent to invalidate the first.
   */
  const sent = useRef<Partial<Record<Method, boolean>>>({})

  // ⚠ TWO STATUSES LAND HERE, AND ONLY ONE OF THEM IS "TWO-FACTOR AUTH".
  // `needs_second_factor` is a factor the ACCOUNT enrolled. `needs_client_trust`
  // is Clerk proving this BROWSER - it fires on a first sign-in from a new
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
  // round trip - the code is already on the person's phone. Defaulting to a
  // code we have to send would put an avoidable email or SMS in front of
  // somebody who did not need one.
  const preferred =
    available.find((m) => m === "totp") ??
    available.find((m) => m !== "backup_code") ??
    available[0] ??
    null

  const active = doneWith ?? method ?? preferred

  /*
   * ⚠ THE "ALREADY SENT" FACT HAS TO SURVIVE A RELOAD, AND A REF DOES NOT. This
   * guard used to be the ref alone, which is per component INSTANCE - so every
   * refresh of this page got a fresh one, the effect below decided no code had
   * been sent, and Clerk sent another. Each new code retires the one before it,
   * so somebody who reloaded while reading the email was then typing a code
   * that had just been invalidated by the reload itself.
   *
   * ⚠ KEYED TO THE ATTEMPT AND THE FACTOR, NOT TO THE PAGE. Switching from the
   * emailed code to the texted one is a different code and must still send;
   * starting a genuinely new sign-in must too, which is what the id does.
   *
   * ⚠ `sessionStorage`, SO IT DIES WITH THE TAB. The attempt it describes does
   * too - this must not still be set tomorrow when somebody signs in again.
   */
  /*
   * ⚠ THE ATTEMPT ID, PULLED OUT SO THE CALLBACKS BELOW CAN DEPEND ON IT.
   * `signIn` itself is a new object on most renders, so a callback keyed on
   * it would be rebuilt every time and take the effect with it; the id is
   * the part that actually decides whether this is the same attempt.
   */
  const attemptId = signIn?.id ?? "attempt"

  /*
   * ⚠ MEMOISED, AND NOT FOR SPEED. The effect below reads both of these, so
   * `react-hooks/exhaustive-deps` wants them in its dependency array - and
   * as plain functions they are new identities on every render, which would
   * re-run the send effect on every render. `useCallback` makes the identity
   * mean what the rule assumes it means: unchanged until the attempt does.
   */
  const sentKey = useCallback(
    (factor: Method) => `i10:mfa-sent:${attemptId}:${factor}`,
    [attemptId],
  )

  const alreadySent = useCallback(
    (factor: Method): boolean => {
      if (sent.current[factor]) return true
      try {
        return window.sessionStorage.getItem(sentKey(factor)) !== null
      } catch {
        // ⚠ BLOCKED STORAGE MEANS THE REF IS ALL THERE IS, which is the
        // behaviour that shipped before this - a resend on reload rather than
        // a screen that cannot send at all. Degrading to the lesser bug is the
        // right direction.
        return false
      }
    },
    [sentKey],
  )

  const markSent = useCallback(
    (factor: Method) => {
      sent.current[factor] = true
      try {
        window.sessionStorage.setItem(sentKey(factor), "1")
      } catch {
        /* see `alreadySent` */
      }
    },
    [sentKey],
  )

  useEffect(() => {
    if (!signIn || !ready || !active) return
    if (active !== "phone_code" && active !== "email_code") return
    if (alreadySent(active)) return

    // Marked before the await, not after: otherwise both renders see `false`.
    markSent(active)

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
  }, [signIn, ready, active, alreadySent, markSent])

  /**
   * Turn the accepted attempt into a session and leave. True when leaving.
   *
   * ⚠ ON FAILURE THE PAGE STAYS, FROZEN, WITH THE REASON UNDER THE BOXES.
   * It used to undo its success state, which made the empty attempt look
   * stranded and sent the person back to sign-in with no session - the
   * flaky "correct code, back at the password" bug.
   */
  async function finish(): Promise<boolean> {
    if (!signIn) return false
    const result = await finalizeAndLeave(
      (params) => signIn.finalize(params),
      afterAuthUrl,
      { holdAccepted: true },
    )
    if (!result.error) return true
    setAccepted(false)
    setStuck(true)
    setRejected(
      "Your code was right, but we could not finish signing you in. Try again.",
    )
    return false
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!signIn || !active || pending) return

    if (stuck) {
      // The code is spent; only the last step is repeated.
      setPending(true)
      setRejected(null)
      setAccepted(true)
      const left = await finish()
      if (!left) setPending(false)
      return
    }

    setPending(true)
    let leaving = false
    // Frozen from the moment the code goes out - see `doneWith`.
    setDoneWith(active)
    setFrozenFactors(available)

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
         * code was still unjudged - so somebody who looked away comes back to a
         * screen that has forgotten it said no. The field now holds the verdict
         * until it is acted on, which is what the red border is for.
         */
        setRejected(messageFor(error))
        setDoneWith(null)
        // ⚠ CLEARED ON FAILURE, for the code strategies only. A wrong six-digit
        // code is never salvaged by editing one box, and leaving it filled
        // means the next attempt starts by deleting six characters. A backup
        // code is long enough to be worth correcting rather than retyping.
        if (active !== "backup_code") setCode("")
        return
      }

      if (signIn.status === "complete") {
        // ⚠ BEFORE THE NAVIGATION, so the green lands while there is still a
        // screen to land on. See `verified` on OtpField.
        setAccepted(true)
        // ⚠ THE LOCK IS KEPT FROM HERE ON. The page is leaving for the
        // dashboard; releasing it in `finally` re-enabled the button for the
        // second the next page takes to load, inviting a second press.
        leaving = await finish()
        return
      }

      setDoneWith(null)
      toast.error("That worked, but the sign-in needs another step we cannot do yet.")
    } catch {
      setDoneWith(null)
      toast.error(TRANSPORT_FAILURE)
    } finally {
      if (!leaving) setPending(false)
    }
  }

  /*
   * ⚠ NO "START AGAIN" SCREEN. With no second-factor attempt in progress -
   * it expired, it finished in another tab, or somebody opened /mfa directly -
   * there is nothing this page can do, and telling them so only adds a click.
   * Straight back to the sign-in box, replacing this entry so Back does not
   * return here. An accepted code never reaches this: `doneWith` keeps the
   * form on screen until the dashboard loads.
   */
  /*
   * ⚠ NEVER WHILE A CODE IS IN FLIGHT OR JUST ACCEPTED. The instant
   * `verifyTOTP` succeeds, Clerk flips the attempt to `complete` and that
   * re-renders this form BEFORE `doneWith` lands - so `ready` read false for
   * one render, this redirect fired, and /sign-in (still holding the password
   * step in session storage) showed for a second, cutting the green check off
   * until `leaveFor` won the race to the dashboard. `pending` covers the
   * request, `doneWith` the hold after it, and `complete` the gap between.
   */
  const finishing = pending || doneWith !== null || signIn?.status === "complete"
  const stranded = !finishing && (!ready || !active)
  useEffect(() => {
    if (!signIn || !stranded || isLeaving()) return
    /*
     * ⚠ SIGNED IN MEANS THE DASHBOARD, NEVER SIGN-IN. An empty attempt with a
     * live session is a sign-in that already finished - in this tab after a
     * remount, or in another one - and the only right place to send it is
     * where it was going.
     */
    if (clerk.user) {
      leaveFor(clerk.buildUrlWithAuth(afterAuthUrl))
      return
    }
    router.replace(signInHref)
  }, [signIn, stranded, router, signInHref, clerk, afterAuthUrl])

  if (!signIn || stranded || !active) return null

  const others = (doneWith ? frozenFactors : available).filter((m) => m !== active)

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
             * shape worth asserting - they are issued, not composed - so the
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
            verified={accepted}
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
          <Button
            type="submit"
            size="xl"
            disabled={pending || (!stuck && code.length === 0)}
          >
            {pending ? (
              <>
                <Spinner aria-hidden="true" aria-label={undefined} />
                Verifying…
              </>
            ) : stuck ? (
              "Try again"
            ) : (
              "Verify"
            )}
          </Button>
        </Field>

        {/*
         * ⚠ NO RESEND FOR TOTP OR A BACKUP CODE, because there is nothing to
         * send. An authenticator generates its own code on the device and a
         * backup code was printed once, months ago - offering "resend" for
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
