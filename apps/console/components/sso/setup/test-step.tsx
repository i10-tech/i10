"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { Spinner } from "@repo/ui/components/i10/spinner"
import { previewPassTest, ssoTestRuns } from "@/lib/sso-actions"
import { providerFailure, wouldDo } from "@/lib/sso-runs"
import type { TestRun } from "@/lib/sso-types"

const LOOK_EVERY_MS = 2000

function RunFailure({ run }: { run: TestRun }) {
  const failure = providerFailure(run)
  return (
    <div className="space-y-1 rounded-2xl border border-destructive/40 p-4">
      <p className="text-sm font-medium">The test did not pass</p>
      <p className="text-sm text-muted-foreground">
        {failure?.adminNextStep ?? wouldDo(run)}
      </p>
    </div>
  )
}

export function TestStep({
  open,
  connectionId,
  providerLabel,
  authOrigin,
  previewTest,
  runs,
  onRuns,
}: {
  open: boolean
  connectionId: string
  providerLabel: string
  authOrigin: string | null
  /** Preview has no provider to visit, so the button records a pass instead. */
  previewTest: boolean
  runs: TestRun[]
  onRuns: (runs: TestRun[]) => void
}) {
  const [waiting, setWaiting] = React.useState(false)
  const seen = runs.length

  React.useEffect(() => {
    if (!open || !waiting) return
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return
      void ssoTestRuns(connectionId).then((result) => {
        if (!result.ok || result.data.data.length === seen) return
        setWaiting(false)
        onRuns(result.data.data)
      })
    }, LOOK_EVERY_MS)
    return () => clearInterval(timer)
  }, [open, waiting, seen, connectionId, onRuns])

  function start() {
    setWaiting(true)
    if (previewTest) {
      setTimeout(() => void previewPassTest(connectionId), 1500)
      return
    }
    const back = window.location.href.split("#")[0]!
    const href = `${authOrigin}/sso/test-run?${new URLSearchParams({
      connection: connectionId,
      redirect_url: back,
    })}`
    window.open(href, "sso-test")
  }

  const latest = runs[0]
  const failed = latest?.outcome === "failed" && !waiting ? latest : null
  const [displayFailure, setDisplayFailure] = React.useState<TestRun | null>(failed)
  if (failed && failed !== displayFailure) setDisplayFailure(failed)

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Sign in at {providerLabel} as yourself. Nobody is created or changed, and we
        show you exactly what would have happened.
      </p>
      <Reveal show={failed !== null} spacing="pb-1">
        {displayFailure && <RunFailure run={displayFailure} />}
      </Reveal>
      <div className="flex items-center gap-3">
        <Button
          onClick={start}
          disabled={waiting || (!authOrigin && !previewTest)}
          variant={failed ? "secondary" : undefined}
        >
          {failed ? "Test again" : "Test sign-in"}
        </Button>
        <Reveal show={waiting} spacing="">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Waiting for your sign-in
          </p>
        </Reveal>
      </div>
    </div>
  )
}
