"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Spinner } from "@repo/ui/components/spinner"
import { watchUntilVerified } from "@/lib/domain-activation"

/**
 * Watching a domain finish, so that nobody has to press Verify to find out.
 *
 * ⚠ THE LAST MANUAL STEP IN THE FLOW WAS SOMEBODY REFRESHING A PAGE. Records
 * are published in about a second and the domain is proved immediately after;
 * from there the only thing outstanding is Amazon's own check, which answers
 * on its own schedule and tells nobody. So the product's final state was a page
 * that had gone quiet, a badge that said "pending", and a button whose whole
 * job was to ask the question again — which is a poll with a person in it.
 *
 * ⚠ IT RENDERS ALMOST NOTHING, AND THAT IS DELIBERATE. A progress bar or a
 * countdown would promise a duration we do not control. One line saying we are
 * still looking is the honest version, and it disappears by itself.
 *
 * ⚠ AND IT STOPS. Seven attempts over about a minute — see the schedule in
 * lib/domain-activation.ts — and then it gives up quietly rather than polling
 * an open tab for an afternoon. A domain that has not verified in a minute is
 * in the state the nightly re-check exists for, and the badge is correct on the
 * next page load either way.
 */
export function VerificationWatch({
  id,
  status,
}: {
  id: string
  /** The server's answer at render time. The watch only runs below `verified`. */
  status: string
}) {
  const router = useRouter()
  const [done, setDone] = React.useState(false)

  /*
   * ⚠ `not_started` IS WATCHED TOO, AND IT IS THE CASE THAT MATTERS MOST. It is
   * the state a domain sits in when the records are up but the one verify after
   * publishing arrived before DNS was serving. This used to be watched with
   * `refresh`, which writes nothing for a row with no identity, so the page said
   * "checking your records" while nothing could ever change — until somebody
   * pressed Verify. The watch now re-proves such a row itself; see
   * `watchUntilVerified`.
   */
  const watching = status !== "verified" && !done

  React.useEffect(() => {
    if (!watching) return

    const controller = new AbortController()

    void watchUntilVerified({ domainId: id, signal: controller.signal }).then(
      (result) => {
        if (controller.signal.aborted) return
        setDone(true)
        /*
         * ⚠ REFRESHED RATHER THAN HELD IN STATE, for the same reason the Verify
         * button refreshes: this page renders the badge and every record's
         * status on the server. Keeping the new status here would leave the
         * table showing the old one beside a line saying it had changed.
         */
        if (result.verified) router.refresh()
      },
    )

    return () => controller.abort()
  }, [id, watching, router])

  if (!watching) return null

  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <Spinner className="size-3" />
      Checking your records — this page updates itself.
    </p>
  )
}
