"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { Badge, type BadgeTone } from "@repo/ui/components/badge/badge"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"
import { Time } from "@/components/time"
import { useMounted } from "@/lib/react"
import { ssoTestRuns } from "@/lib/sso-actions"
import {
  groupsNote,
  latestPass,
  providerFailure,
  wouldDo,
} from "@/lib/sso-runs"
import { toastDone, toastError } from "@/lib/toast"
import type { SsoConnection, TestRun } from "@/lib/sso-types"
import { Advanced, StatusLine } from "../settings-card"
import { Loading, useRemote } from "../shared"

export function TestSection({
  connection,
  authOrigin,
}: {
  connection: SsoConnection
  authOrigin: string | null
}) {
  const { data, failed, reload } = useRemote(() => ssoTestRuns(connection.id))
  const [now] = React.useState(() => Date.now())
  const mounted = useMounted()

  React.useEffect(() => {
    const result = new URLSearchParams(window.location.hash.slice(1)).get("sso_test")
    if (!result) return
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    )
    if (result === "passed") toastDone("Test sign-in passed")
    else toastError("Test sign-in failed", "Open the run below to see why.")
    void reload()
  }, [reload])

  const runs = data?.data ?? null
  const pass = runs ? latestPass(runs, now) : null
  const latest = runs && runs.length > 0 ? runs[0] : null

  const href =
    mounted && authOrigin
      ? `${authOrigin}/sso/test-run?${new URLSearchParams({
          connection: connection.id,
          redirect_url: `${window.location.origin}${window.location.pathname}?tab=test`,
        })}`
      : null

  let chipLabel = "Not tested"
  let chipTone: BadgeTone = "neutral"
  let sentence: React.ReactNode = "No test has passed in the last 24 hours. Requiring SSO needs one."

  if (pass) {
    chipLabel = "Passed"
    chipTone = "success"
    sentence = (
      <>
        A test passed <Time iso={pass.createdAt} />. Requiring SSO needs a passed test
        from the last 24 hours.
      </>
    )
  } else if (latest && latest.outcome === "failed") {
    chipLabel = "Failed"
    chipTone = "danger"
    sentence = <>Latest test failed: {wouldDo(latest)}</>
  }

  return (
    <div className="space-y-4">
      <StatusLine
        label={chipLabel}
        tone={chipTone}
        sentence={sentence}
        action={
          href ? (
            <ButtonLink href={href} size="sm" native>
              Start a test
            </ButtonLink>
          ) : undefined
        }
      />

      <Advanced
        label="Test history"
        summary={
          runs && runs.length > 0
            ? `${runs.length} test run${runs.length === 1 ? "" : "s"}`
            : undefined
        }
      >
        {!runs ? (
          <Loading failed={failed} />
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No test run yet.</p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {runs.map((run) => (
              <RunItem key={run.id} run={run} />
            ))}
          </ul>
        )}
      </Advanced>
    </div>
  )
}

function RunItem({ run }: { run: TestRun }) {
  const [open, setOpen] = React.useState(false)
  const reduced = useReducedMotion()

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted/40 transition-colors"
      >
        <Badge tone={run.outcome === "passed" ? "success" : "danger"} size="sm">
          {run.outcome === "passed" ? "Passed" : "Failed"}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {wouldDo(run)}
        </span>
        <Time iso={run.createdAt} className="text-xs text-muted-foreground" />
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={reduced ? { duration: 0 } : motionTokens.spring.snappy}
        >
          <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
        </motion.span>
      </button>

      <Reveal show={open} keepMounted>
        <div className="space-y-3 border-t border-border bg-muted/20 px-3 py-3 text-sm">
          <div>
            <p className="text-xs font-medium">What we would do</p>
            <p className="mt-1 text-muted-foreground">{wouldDo(run)}</p>
          </div>
          {groupsNote(run) && (
            <div>
              <p className="text-xs font-medium">Groups</p>
              <p className="mt-1 text-muted-foreground">{groupsNote(run)}</p>
            </div>
          )}
          {providerFailure(run) && (
            <div>
              <p className="text-xs font-medium">What to fix</p>
              <p className="mt-1 text-muted-foreground">
                {providerFailure(run)!.adminNextStep}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Provider code: {providerFailure(run)!.code}
              </p>
            </div>
          )}
          <div>
            <p className="text-xs font-medium">What your provider said</p>
            <pre className="mt-1 max-h-72 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs">
              {JSON.stringify(run.claims, null, 2)}
            </pre>
          </div>
        </div>
      </Reveal>
    </li>
  )
}
