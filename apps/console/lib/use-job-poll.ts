"use client"

import * as React from "react"
import { isActive, nextPollDelay, type MailboxJob } from "@/lib/mailbox-transfer"
import type { ActionResult } from "@/lib/actions"

/**
 * Keeps asking for a job's progress while it runs, and stops when it is over.
 *
 * ⚠ IT ASKS ONLY WHILE THE TAB IS SHOWN (`nextPollDelay` decides, and says null
 * for a hidden one). When the tab comes back it asks at once rather than at the
 * next tick, so a person returning to a finished import sees it finished.
 * ⚠ A FAILED READ IS NOT THE END OF THE JOB: it backs off and tries again, because
 * the run being watched is still going on the server whatever this read said.
 * ⚠ THE READER AND THE CALLBACK ARE HELD IN REFS, so a parent that re-renders on
 * every progress tick does not tear down and restart the timer each time.
 */
export function useJobPoll(options: {
  /** Whether the job being watched is still running. `false` stops everything. */
  active: boolean
  /** The status read: a server action. Null data means there is no such job. */
  read: () => Promise<ActionResult<MailboxJob | null>>
  onJob: (job: MailboxJob) => void
}) {
  const { active } = options
  const read = React.useRef(options.read)
  const onJob = React.useRef(options.onJob)
  React.useEffect(() => {
    read.current = options.read
    onJob.current = options.onJob
  })

  React.useEffect(() => {
    if (!active) return

    let stopped = false
    let inFlight = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = () => {
      const delay = nextPollDelay({
        visible: document.visibilityState === "visible",
        failures,
      })
      // Hidden: nothing is scheduled, and `visibilitychange` below starts it again.
      if (delay !== null) timer = setTimeout(tick, delay)
    }

    async function tick() {
      if (stopped || inFlight) return
      inFlight = true
      let job: MailboxJob | null = null
      try {
        const result = await read.current()
        job = result.ok ? result.data : null
      } catch {
        job = null
      }
      inFlight = false
      if (stopped) return

      if (job) {
        failures = 0
        onJob.current(job)
        // Over: the parent's `active` goes false and this effect ends. Not
        // scheduling here as well keeps one more read from being sent.
        if (!isActive(job)) return
      } else {
        failures += 1
      }
      schedule()
    }

    const onVisibility = () => {
      if (document.visibilityState !== "visible" || inFlight) return
      clearTimeout(timer)
      void tick()
    }

    document.addEventListener("visibilitychange", onVisibility)
    schedule()

    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [active])
}
