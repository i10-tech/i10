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
 * after that our nameservers are still picking them up, and the page — which
 * the verification watch re-renders every few seconds through exactly that
 * window — said "we are not serving it, contact support". Two minutes is far
 * longer than a healthy handover takes and far shorter than anyone would wait
 * on a real outage before writing to us.
 */
const GRACE_MS = 2 * 60_000
const RECHECK_MS = 15_000

/**
 * "Delegated to us, and we are not serving it" — but only once it has stayed
 * true for long enough to mean something.
 *
 * ⚠ THE CLOCK IS THIS PAGE'S, NOT THE DOMAIN'S. Nothing we store says when the
 * zones were published — `updated_at` moves on every status check — and
 * `created_at` is wrong for a domain added an hour ago and verified now. So the
 * question asked is the one the customer is actually asking: has this page
 * watched it stay broken for two minutes?
 *
 * ⚠ IT RE-ASKS WHILE IT WAITS. The delegation report is server-rendered, and
 * the verification watch stops once SES has the domain — so without this the
 * neutral note could be looking at a report from the first second after verify
 * for the whole grace window, and turn red over a handover that finished long
 * ago. When the zones answer, the server renders "Delegation is working" and
 * this component is gone.
 */
export function HandoverSettling({
  zones,
  plural,
  failure,
}: {
  zones: React.ReactNode
  plural: boolean
  /** The red note, rendered by the caller so its copy stays in one file. */
  failure: React.ReactNode
}) {
  const router = useRouter()
  const [expired, setExpired] = React.useState(false)

  React.useEffect(() => {
    if (expired) return
    const recheck = setInterval(() => router.refresh(), RECHECK_MS)
    const grace = setTimeout(() => setExpired(true), GRACE_MS)
    return () => {
      clearInterval(recheck)
      clearTimeout(grace)
    }
  }, [expired, router])

  if (expired) return <>{failure}</>

  return (
    <Note
      tone="muted"
      icon={<Clock className="size-4 text-muted-foreground" />}
      title="Finishing the handover"
      body={
        <>
          {zones} {plural ? "point" : "points"} at us and we are starting to answer for{" "}
          {plural ? "them" : "it"}. This usually takes a few seconds — this note updates
          itself.
        </>
      }
    />
  )
}
