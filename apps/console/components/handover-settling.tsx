"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Clock } from "lucide-react"
import { Note } from "@/components/delegation-note"

/**
 * How long a silent delegation may be the ordinary tail of a handover before
 * it is called a fault.
 *
 * ⚠ SILENCE RIGHT AFTER VERIFY IS THE NORMAL CASE, AND IT WAS SHOWN IN RED. We
 * publish a delegated domain's zones inside `verify`; for the first seconds
 * after that our nameservers are still picking them up, and the page - which
 * the verification watch re-renders every few seconds through exactly that
 * window - said "we are not serving it, contact support". Two minutes is far
 * longer than a healthy handover takes and far shorter than anyone would wait
 * on a real outage before writing to us.
 */
const GRACE_MS = 2 * 60_000
const RECHECK_MS = 15_000

/**
 * A note that only turns into a problem once it has stayed true long enough to
 * be one - used for every delegation state that is ALSO the ordinary first
 * minute of a healthy handover.
 *
 * ⚠ THE CLOCK IS THIS TAB'S, NOT THE DOMAIN'S. Nothing we store says when the
 * zones were published - `updated_at` moves on every status check - and
 * `created_at` is wrong for a domain added an hour ago and verified now. So the
 * question asked is the one the customer is actually asking: has this tab
 * watched it stay this way for two minutes? A reload keeps the count; see
 * `firstSeen`.
 *
 * ⚠ IT RE-ASKS WHILE IT WAITS. The delegation report is server-rendered, and
 * the verification watch stops once SES has the domain - so without this the
 * waiting note could be looking at a report from the first second after verify
 * for the whole grace window, and escalate over a handover that finished long
 * ago. When the state clears, the server renders the next note and this one is
 * gone.
 */
export function HandoverSettling({
  domainId,
  state,
  title,
  body,
  failure,
}: {
  domainId: string
  /** Which waiting state this is; each has its own clock. */
  state: string
  title: string
  body: React.ReactNode
  /** What to say once the grace is spent, rendered by the caller so its copy stays in one file. */
  failure: React.ReactNode
}) {
  const router = useRouter()
  const [expired, setExpired] = React.useState(false)

  React.useEffect(() => {
    if (expired) return

    const since = firstSeen(`${domainId}:${state}`)
    // ⚠ A GRACE ALREADY SPENT BEFORE A RELOAD STILL GOES THROUGH THE TIMER, at
    // zero, rather than a `setExpired` here - state is set from a callback, never
    // in the effect body, which would render twice for one mount.
    const left = Math.max(0, GRACE_MS - (Date.now() - since))

    const recheck = setInterval(() => {
      firstSeen(`${domainId}:${state}`)
      router.refresh()
    }, RECHECK_MS)
    const grace = setTimeout(() => setExpired(true), left)
    return () => {
      clearInterval(recheck)
      clearTimeout(grace)
    }
  }, [domainId, state, expired, router])

  if (expired) return <>{failure}</>

  return (
    <Note
      tone="muted"
      icon={<Clock className="size-4 text-muted-foreground" />}
      title={title}
      body={body}
    />
  )
}

/**
 * When this tab first saw this domain in this state, carried across reloads.
 *
 * ⚠ WITHOUT IT A RELOAD RESTARTED THE GRACE, so pressing refresh during the two
 * minutes bought another two, and somebody refreshing out of impatience would
 * never be told about a real fault. `sessionStorage` is per tab and survives a
 * reload, which is exactly the span "this page has been watching" means.
 *
 * ⚠ AND A GAP RESTARTS IT. The stamp is refreshed every time the state is seen;
 * if it has not been seen for `FORGET_MS`, whatever was stored is about an
 * earlier episode - the state cleared and came back - and must not turn a new
 * wait red on arrival.
 *
 * ⚠ STORAGE CAN THROW (a private window, blocked site data), and then this is
 * simply the page's own clock again - the behaviour before, not a failure.
 */
const FORGET_MS = 5 * 60_000

function firstSeen(key: string): number {
  const now = Date.now()
  const storageKey = `i10:settling:${key}`
  try {
    const raw = window.sessionStorage.getItem(storageKey)
    const stored = raw ? (JSON.parse(raw) as { since?: unknown; seen?: unknown }) : null
    const since =
      stored &&
      typeof stored.since === "number" &&
      typeof stored.seen === "number" &&
      now - stored.seen < FORGET_MS
        ? stored.since
        : now
    window.sessionStorage.setItem(storageKey, JSON.stringify({ since, seen: now }))
    return since
  } catch {
    return now
  }
}
