"use client"

import { useEffect } from "react"
import { useClerk } from "@clerk/nextjs"
import { isLeaving, leaveFor } from "../_lib/finish"
import { PREFIX, TOUCHED } from "../_lib/resume-keys"

const FORWARDED = "i10:auth-forwarded-at"
/** A second bounce inside this window means the destination keeps refusing. */
const LOOP_MS = 15_000

/**
 * Somebody who opens the sign-in page already signed in goes straight on.
 *
 * ⚠ WHY IT EXISTS: a signed-in session landing here (the dashboard bounced a
 * request it should not have, or a second tab) was shown the email box and
 * asked to sign in again with a perfectly good session in hand.
 *
 * ⚠ ONLY ON THE FIRST LOAD, AND NEVER WITH A FLOW IN PROGRESS. Sign-up holds
 * a real session during its passkey and two-factor steps, and a reload
 * resumes them; forwarding then would skip the steps. A stored flow (the same
 * check the resume script makes) means stay.
 *
 * ⚠ AND NOT TWICE IN 15 SECONDS. If the destination sends them straight back,
 * forwarding again would bounce for ever; the second time, the form shows.
 */
export function SignedInForward({ afterAuthUrl }: { afterAuthUrl: string }) {
  const clerk = useClerk()

  useEffect(() => {
    let done = false
    const check = () => {
      if (done || !clerk.loaded) return
      done = true
      if (!clerk.user || isLeaving() || flowStored()) return
      try {
        const last = Number(window.sessionStorage.getItem(FORWARDED) ?? 0)
        if (Date.now() - last < LOOP_MS) return
        window.sessionStorage.setItem(FORWARDED, String(Date.now()))
      } catch {
        // No storage, no loop guard: do not risk a loop.
        return
      }
      leaveFor(clerk.buildUrlWithAuth(afterAuthUrl))
    }
    check()
    return clerk.addListener(check)
  }, [clerk, afterAuthUrl])

  return null
}

function flowStored(): boolean {
  try {
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i) ?? ""
      if (key.startsWith(PREFIX) && key !== TOUCHED) return true
    }
  } catch {
    return true
  }
  return false
}
