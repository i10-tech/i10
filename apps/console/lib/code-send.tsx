"use client"

import * as React from "react"
import { AnimatedCounter } from "@repo/ui/components/animated-counter/animated-counter"
import { Button } from "@repo/ui/components/button/button"
import { reserveCodeSend } from "@/lib/actions"

const COOLDOWN_SECONDS = 60

/**
 * Sending a verification code, at most once a minute (2026-10-12).
 *
 * The API holds the minute (`/console/me/code-sends`), so a reload, a closed
 * dialog or a second tab cannot buy another send; the answer says how long is
 * left, and `remaining` counts down from it.
 *
 * ⚠ A DEADLINE, NOT A TICKING COUNTER, as the auth app's resend button: a
 * background tab throttles intervals, and a wall-clock instant stays right.
 *
 * ⚠ AN API THAT CANNOT ANSWER DOES NOT STOP THE SEND. The code still goes,
 * and this tab keeps its own minute - the cooldown guards our buttons, and a
 * person who cannot get a code at all is worse off than one who got two.
 */
export function useCodeSend(purpose: string | null) {
  // A deadline per purpose: another address starts with no wait of its own.
  const [untils, setUntils] = React.useState<Record<string, number>>({})
  const [now, setNow] = React.useState(() => Date.now())
  const [sending, setSending] = React.useState(false)
  const until = purpose ? (untils[purpose] ?? 0) : 0
  const remaining = Math.max(0, Math.ceil((until - now) / 1000))

  React.useEffect(() => {
    if (until <= Date.now()) return
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [until])

  const hold = (key: string, seconds: number) => {
    const at = Date.now()
    setNow(at)
    setUntils((all) => ({ ...all, [key]: at + seconds * 1000 }))
  }

  /**
   * Runs `deliver` if the minute is free. Returns false when it was not -
   * a code went out a moment ago, and the countdown shows how long is left.
   * `as` names the purpose when it is only known now (a just-added address).
   */
  const send = async (
    deliver: () => Promise<unknown>,
    as: string | null = purpose,
  ): Promise<boolean> => {
    if (!as || sending || (untils[as] ?? 0) > Date.now()) return false
    setSending(true)
    try {
      const reserved = await reserveCodeSend(as)
      if (!reserved.ok && reserved.status === 429) {
        const wait = reserved.body?.retry_after
        hold(as, typeof wait === "number" && wait > 0 ? wait : COOLDOWN_SECONDS)
        return false
      }
      await deliver()
      hold(as, reserved.ok ? reserved.data.retry_after : COOLDOWN_SECONDS)
      return true
    } finally {
      setSending(false)
    }
  }

  return { remaining, sending, send }
}

/**
 * "Send a new code", greyed with the seconds left until it can - and it only
 * becomes pressable when the countdown reaches zero.
 */
export function ResendCode({
  remaining,
  sending,
  onClick,
  className,
}: {
  remaining: number
  sending: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={className}
      disabled={remaining > 0 || sending}
      loading={sending}
      onClick={onClick}
    >
      {remaining > 0 ? (
        <span>
          {/*
           * ⚠ THE SECONDS ROLL, THE LABEL HOLDS (2026-10-12). `Button` keys
           * its label by its text and crossfades the whole thing when that
           * changes, so "52s" ticking re-ran the fade every second - the
           * flash. Arc's counter is a component, not text: the label's key
           * stays put and only the digits turn, rolling up like Arc's
           * counters do.
           */}
          Send a new code in{" "}
          <AnimatedCounter value={remaining} suffix="s" inline roll="up" />
        </span>
      ) : (
        "Send a new code"
      )}
    </Button>
  )
}
