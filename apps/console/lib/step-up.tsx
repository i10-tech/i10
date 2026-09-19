"use client"

import * as React from "react"
import { useReverification } from "@clerk/nextjs"
import { isReverificationCancelledError } from "@clerk/nextjs/errors"
import { isReverificationHint } from "@clerk/shared/authorization-errors"
import { stepUp } from "@/lib/actions"

/**
 * "Prove it is you" in front of something that cannot be undone.
 *
 * ⚠ A SESSION COOKIE LIVES FOR DAYS AND AN UNLOCKED LAPTOP IS INDISTINGUISHABLE
 * FROM ITS OWNER. Almost everything in this console is recoverable; deleting a
 * verified domain or revoking the key production sends with is not, and those
 * are the two things worth one more question.
 *
 * ⚠ THE DIALOG IS CLERK'S, DELIBERATELY. It offers the strongest factor the
 * person actually has — a passkey where one is enrolled, otherwise TOTP, an
 * emailed code or a password — and handles every failure state of each. Ours
 * would be a worse copy of it, against the same API, and it would go stale the
 * first time somebody enrolled a factor we had not thought about.
 *
 * ⚠ WHAT MAKES IT OPEN AT ALL IS THE SHAPE OF THE VALUE WE RETURN. Clerk
 * inspects the fetcher's RESULT for `clerk_error.reason === "reverification-error"`
 * — it is not reading a status code and it cannot see a thrown error. Our
 * server actions never throw across the boundary; they return
 * `{ ok: false, body }`, so the hint arrives nested and has to be handed back
 * up before Clerk will act on it. That unwrapping is the whole of this file.
 *
 * ⚠ AND IT IS A CONTEXT RATHER THAN A BARE HOOK, BECAUSE CLERK IS NOT ALWAYS
 * MOUNTED. `<ClerkProvider>` is conditional in the root layout — see the note
 * there on `/_not-found` being prerendered without a publishable key — and
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
 * ⚠ WITH NO CLERK THERE IS NO WAY TO ASK, SO THIS ASKS THE API AND BELIEVES IT.
 * It cannot open a prompt, so a stale session simply fails the action with the
 * API's own refusal — which is the fail-CLOSED direction. Returning `true` here
 * would be the one mistake that matters: the console would go straight to the
 * delete, and only the API would stand in the way.
 */
const withoutClerk: StepUp = async () => (await stepUp()).ok

export function StepUpProvider({ children }: { children: React.ReactNode }) {
  const prove = useReverification(async () => {
    const result = await stepUp()

    /*
     * ⚠ THE HINT IS RETURNED, NOT THROWN, AND NOT FLATTENED TO A BOOLEAN.
     * Returning it is what hands control to Clerk: it opens the dialog, waits
     * for the person, and then calls this function again from the top. The
     * second call finds a fresh session and falls through.
     */
    if (!result.ok && isReverificationHint(result.body)) return result.body

    return result
  })

  const value = React.useCallback<StepUp>(async () => {
    try {
      return (await prove()).ok
    } catch (error) {
      /*
       * ⚠ DISMISSING THE PROMPT IS AN ANSWER, NOT A FAULT. Somebody who closes
       * the verification dialog has decided not to do the thing; an error toast
       * on top of that is the interface arguing with a decision it just asked
       * them to make.
       */
      if (isReverificationCancelledError(error)) return false
      throw error
    }
  }, [prove])

  return <StepUpContext.Provider value={value}>{children}</StepUpContext.Provider>
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
