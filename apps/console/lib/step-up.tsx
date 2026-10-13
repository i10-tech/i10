"use client"

import * as React from "react"
import { isClerkAPIResponseError } from "@clerk/nextjs/errors"
import { isReverificationHint } from "@clerk/shared/authorization-errors"
import type { SessionVerificationLevel } from "@clerk/shared/types"
import { PasskeyCue } from "@repo/ui/components/i10/passkey-cue"
import {
  StepUpDialog,
  type StepUpRequest,
} from "@repo/ui/components/i10/step-up-dialog"
import { CodeReservationContext } from "@repo/ui/components/i10/code-send"
import { reserveCodeSend, stepUp } from "@/lib/actions"
import { toastError } from "@/lib/toast"

/**
 * "Prove it is you" in front of something that cannot be undone.
 *
 * ⚠ A SESSION COOKIE LIVES FOR DAYS AND AN UNLOCKED LAPTOP IS INDISTINGUISHABLE
 * FROM ITS OWNER. Almost everything in this console is recoverable; deleting a
 * verified domain or revoking the key production sends with is not, and those
 * are the two things worth one more question.
 *
 * ⚠ THE DIALOG IS OURS SINCE 2026-10-12, NOT CLERK'S. It was Clerk's modal,
 * through `useReverification`, chosen because it covered every factor - and it
 * failed more often than it worked. See components/step-up-dialog.tsx, which
 * walks the same session-verification API with our own fields.
 *
 * ⚠ WHAT OPENS IT IS STILL CLERK'S HINT. The API refuses a stale session with
 * `clerk_error.reason === "reverification-error"` (see `requireFreshAuth`);
 * our server actions return `{ ok: false, body }`, so the hint arrives nested
 * and is read here.
 *
 * ⚠ AND IT IS A CONTEXT RATHER THAN A BARE HOOK, BECAUSE CLERK IS NOT ALWAYS
 * MOUNTED. `<ClerkProvider>` is conditional in the root layout - see the note
 * there on `/_not-found` being prerendered without a publishable key - and
 * `useReverification` calls `useClerk`, which THROWS outside it. A bare hook
 * took the whole API keys page down with "useClerk can only be used within
 * <ClerkProvider>" in exactly the deployment shape the layout was written to
 * survive. The provider is mounted inside Clerk's; `useStepUp` falls back when
 * it is absent.
 */

/** @returns `true` once the session is fresh, `false` if the person declined. */
type StepUp = () => Promise<boolean>

const StepUpContext = React.createContext<StepUp | null>(null)

/**
 * Open the dialog by itself - for Clerk's own account actions, which refuse
 * with "re-verify first" from Clerk's API rather than from ours.
 */
type Ask = (level: SessionVerificationLevel) => Promise<boolean>
const AskContext = React.createContext<Ask | null>(null)

/**
 * ⚠ WITH NO CLERK THERE IS NO WAY TO ASK, SO THIS ASKS THE API AND BELIEVES IT.
 * It cannot open a prompt, so a stale session simply fails the action with the
 * API's own refusal - which is the fail-CLOSED direction. Returning `true` here
 * would be the one mistake that matters: the console would go straight to the
 * delete, and only the API would stand in the way.
 */
const withoutClerk: StepUp = async () => (await stepUp()).ok

export function StepUpProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = React.useState<StepUpRequest | null>(null)
  const [passkey, setPasskey] = React.useState(false)
  const pending = React.useRef<((proved: boolean) => void) | null>(null)
  const asked = React.useRef(0)

  const ask = React.useCallback<Ask>(
    (level) =>
      new Promise<boolean>((resolve) => {
        pending.current?.(false)
        pending.current = resolve
        asked.current += 1
        setRequest({ id: asked.current, level })
      }),
    [],
  )

  const value = React.useCallback<StepUp>(async () => {
    const first = await stepUp()
    if (first.ok) return true
    // Not "prove it again" but some other refusal: the action says why.
    if (!isReverificationHint(first.body)) return false

    /*
     * ⚠ THE DIALOG IS OURS NOW, AND THE API'S HINT IS WHAT OPENS IT - the same
     * hint `useReverification` read for Clerk's modal. It says what level to
     * ask for; the dialog asks, and resolves once Clerk calls it complete.
     */
    const proved = await ask(levelOf(first.body))
    if (!proved) return false

    /*
     * ⚠ AND THE API IS ASKED AGAIN, BECAUSE IT IS THE ONE THAT DECIDES. Clerk
     * saying "complete" is the browser's view; the refusal lives server-side
     * (see `requireFreshAuth`), and a session that still reads stale there -
     * a saved-account resume moments ago, say - must not be waved through.
     */
    const again = await stepUp()
    if (again.ok) return true
    toastError(
      "Could not confirm it is you",
      "The check went through, but it was not accepted yet. Try again in a minute.",
    )
    return false
  }, [ask])

  return (
    <CodeReservationContext.Provider value={reserveCodeSend}>
      <AskContext.Provider value={ask}>
        <StepUpContext.Provider value={value}>
          {children}
          <StepUpDialog
            request={request}
            onDone={(proved) => {
              pending.current?.(proved)
              pending.current = null
              setRequest(null)
            }}
            onPasskey={setPasskey}
          />
          {/* The sign-in page's passkey screen, over everything - see the dialog. */}
          <PasskeyCue open={passkey} mode="verify" />
        </StepUpContext.Provider>
      </AskContext.Provider>
    </CodeReservationContext.Provider>
  )
}

/** Whether Clerk refused a user action until the session is verified again. */
function needsReverification(error: unknown): boolean {
  if (isReverificationHint(error)) return true
  return (
    isClerkAPIResponseError(error) &&
    error.errors.some((entry) => entry.code === "session_reverification_required")
  )
}

/**
 * Run one of Clerk's sensitive account actions - changing the password, adding
 * a passkey, deleting the account - and prove it is you first if Clerk asks.
 *
 * ⚠ WHAT `useReverification` DID INSIDE CLERK'S `<UserProfile />`, WITH OUR
 * DIALOG. Clerk's API refuses such an action with
 * `session_reverification_required`; this opens the dialog, and on success
 * runs the action again once. Closing the dialog is an answer, not a fault:
 * it resolves `null` and the caller leaves things as they were.
 */
export function useReverify() {
  const ask = React.useContext(AskContext)
  return React.useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | null> => {
      try {
        return await action()
      } catch (error) {
        if (!ask || !needsReverification(error)) throw error
        if (!(await ask("second_factor"))) return null
        return await action()
      }
    },
    [ask],
  )
}

/**
 * The level the API's hint asks for. Clerk's presets, spelled out: `strict`,
 * `moderate` and `lax` all want a second factor (falling back to the first
 * for accounts without one); `strict_mfa` wants both.
 */
function levelOf(hint: unknown): SessionVerificationLevel {
  const config = (hint as { clerk_error?: { metadata?: { reverification?: unknown } } })
    ?.clerk_error?.metadata?.reverification
  if (config && typeof config === "object" && "level" in config) {
    const level = (config as { level?: unknown }).level
    if (
      level === "first_factor" ||
      level === "second_factor" ||
      level === "multi_factor"
    )
      return level
  }
  return config === "strict_mfa" ? "multi_factor" : "second_factor"
}

/**
 * ⚠ IT ANSWERS A BOOLEAN RATHER THAN THROWING, because every caller is inside a
 * confirmation dialog whose `onConfirm` already speaks that language: `false`
 * leaves the dialog open with nothing destroyed, which is the correct outcome
 * of "actually, no".
 */
export function useStepUp(): StepUp {
  return React.useContext(StepUpContext) ?? withoutClerk
}

/**
 * Open the dialog unconditionally, whatever the session's freshness - for the
 * reference page, which walks every method on purpose. Resolves whether the
 * person finished it.
 */
export function useOpenStepUp() {
  return React.useContext(AskContext)
}
