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

/**
 * Proving it is you again, in OUR dialog (2026-10-13) - what `useReverification`
 * did with Clerk's modal. The console has the same dialog; this is the auth
 * app's copy of the small part around it.
 *
 * ⚠ ON SIGN-UP IT SHOULD NEVER OPEN. The account is seconds old and the
 * sign-up itself is the proof, so the steps are ordered to stay inside that
 * window: passkey and providers come BEFORE two-factor, because once a second
 * factor exists Clerk asks for it (`fva` reads [0,-1] after a sign-up) and the
 * person would be asked for the code they set up a minute ago. The dialog is
 * the fallback for somebody who leaves the tab for longer than the window.
 */
type Ask = (level: SessionVerificationLevel) => Promise<boolean>

const AskContext = React.createContext<Ask | null>(null)

export function ReverifyProvider({ children }: { children: React.ReactNode }) {
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

  return (
    <AskContext.Provider value={ask}>
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
      <PasskeyCue open={passkey} mode="verify" />
    </AskContext.Provider>
  )
}

/** Thrown when the person closed the dialog instead of proving it. */
export class ReverifyCancelled extends Error {
  constructor() {
    super("Reverification cancelled")
    this.name = "ReverifyCancelled"
  }
}

function needsReverification(error: unknown): boolean {
  if (isReverificationHint(error)) return true
  return (
    isClerkAPIResponseError(error) &&
    error.errors.some((entry) => entry.code === "session_reverification_required")
  )
}

/**
 * Runs `action`; if Clerk refuses it for a stale session, asks in our dialog
 * and runs it once more. A closed dialog throws `ReverifyCancelled`.
 */
export function useReverify() {
  const ask = React.useContext(AskContext)
  return React.useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action()
      } catch (error) {
        if (!ask || !needsReverification(error)) throw error
        if (!(await ask("second_factor"))) throw new ReverifyCancelled()
        return await action()
      }
    },
    [ask],
  )
}
