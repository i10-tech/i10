"use client"

import { useCallback, useEffect, useState } from "react"
import { FieldDescription } from "@repo/ui/components/field"

/** How long somebody has to wait before asking for another code. */
const COOLDOWN_SECONDS = 60

/**
 * "Didn't get it? Resend" — but not for a minute.
 *
 * ⚠ THE COOLDOWN STARTS ON MOUNT, NOT ON THE FIRST CLICK. This renders
 * immediately after a code has ALREADY been sent, so a button that was live on
 * arrival would let somebody fire a second mail before the first one landed —
 * and each new code invalidates the one before it, so the impatient person ends
 * up typing a code that has just been retired. Starting the clock at mount
 * matches the mail that is already in flight.
 *
 * ⚠ AND IT IS NOT THE RATE LIMIT. Clerk enforces its own, server side, and that
 * is the one that actually protects anything — this is here so the UI stops
 * somebody hammering a button and being told off by an API. Deleting it would
 * be rude rather than dangerous; deleting Clerk's would be the other way round.
 */
export function ResendButton({
  onResend,
  label = "Didn't get the code?",
}: {
  /** Resolves when the send finished; rejects or resolves either way. */
  onResend: () => Promise<void>
  label?: string
}) {
  // ⚠ A DEADLINE, NOT A COUNTER THAT TICKS DOWN. `setInterval` is throttled to
  // roughly once a minute in a background tab and stops entirely on a sleeping
  // phone, so a decrementing counter would still read "Resend in 47s" long
  // after a minute of real time had passed. Comparing against a wall-clock
  // instant is correct no matter how badly the timer is starved; the interval
  // exists only to re-render.
  const [until, setUntil] = useState(() => Date.now() + COOLDOWN_SECONDS * 1000)
  const [now, setNow] = useState(() => Date.now())
  const [sending, setSending] = useState(false)

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [])

  const remaining = Math.max(0, Math.ceil((until - now) / 1000))

  const resend = useCallback(async () => {
    if (remaining > 0 || sending) return
    setSending(true)
    try {
      await onResend()
      // Restarted only after the send resolves. Restarting first would lock the
      // button for a minute on a request that failed.
      setUntil(Date.now() + COOLDOWN_SECONDS * 1000)
    } finally {
      setSending(false)
    }
  }, [remaining, sending, onResend])

  const waiting = remaining > 0

  return (
    <FieldDescription className="text-center">
      {label}{" "}
      <button
        type="button"
        onClick={resend}
        disabled={waiting || sending}
        className="underline underline-offset-4 disabled:no-underline disabled:opacity-60"
      >
        {sending ? "Sending…" : waiting ? `Resend in ${remaining}s` : "Resend"}
      </button>
    </FieldDescription>
  )
}
