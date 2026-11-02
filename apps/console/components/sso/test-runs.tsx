"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"
import { Badge } from "@repo/ui/components/badge/badge"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { Time } from "@/components/time"
import { useMounted } from "@/lib/react"
import { ssoTestRuns } from "@/lib/sso-actions"
import { toastDone, toastError } from "@/lib/toast"
import type { SsoConnection, TestRun } from "@/lib/sso-types"
import { DAY_MS, groupsNote, latestPass, wouldDo } from "@/lib/sso-runs"
import { Block, Loading, useRemote } from "./shared"

/**
 * Test runs (sso.md 2.10): a real sign-in at the identity provider that signs
 * nobody in. The page shows what the provider said, and what a real sign-in
 * would have done, so a mistake shows here and not on a colleague's first day.
 *
 * ⚠ THE RAW CLAIMS ARE THE PROVIDER'S ANSWER ABOUT A REAL PERSON and are shown
 * to admins only; the API route behind them is `sso:manage`.
 */

export function TestRuns({
  connection,
  authOrigin,
}: {
  connection: SsoConnection
  authOrigin: string | null
}) {
  const { data, failed, reload } = useRemote(() => ssoTestRuns(connection.id))
  const [now] = React.useState(() => Date.now())

  // A finished test run comes back here with `#sso_test=passed|failed`; say so, then clean the address.
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
  const testable = connection.status === "testing"
  // ⚠ BUILT ONCE MOUNTED: it names this page's own address, which the server render does not know.
  const mounted = useMounted()
  const href =
    mounted && authOrigin
      ? `${authOrigin}/sso/test-run?${new URLSearchParams({
          connection: connection.id,
          redirect_url: `${window.location.origin}${window.location.pathname}?tab=test`,
        })}`
      : null

  return (
    <>
      <Block
        title="Test sign-in"
        description="Sign in at your identity provider as yourself. Nobody is signed in or created: you only see what would have happened."
        action={
          testable && href ? (
            <ButtonLink href={href} size="sm" native>
              Start a test
            </ButtonLink>
          ) : undefined
        }
      >
        {!testable && (
          <p className="text-sm text-muted-foreground">
            {connection.status === "draft"
              ? "Finish the settings, then move the connection to testing to run a test."
              : "A test runs while the connection is in testing. Move it back to setup to test again."}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {pass ? (
            <>
              A test passed <Time iso={pass.createdAt} />. Requiring SSO needs a passed
              test from the last 24 hours, so this one counts until{" "}
              <Time
                iso={new Date(
                  new Date(pass.createdAt).getTime() + DAY_MS,
                ).toISOString()}
                mode="exact"
              />
              .
            </>
          ) : (
            "No test has passed in the last 24 hours. Requiring SSO needs one, and the API refuses without it."
          )}
        </p>
      </Block>

      <Block title="History">
        {!runs ? (
          <Loading failed={failed} />
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No test run yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {runs.map((run) => (
              <Run key={run.id} run={run} />
            ))}
          </ul>
        )}
      </Block>
    </>
  )
}

function Run({ run }: { run: TestRun }) {
  const [open, setOpen] = React.useState(false)
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm"
      >
        <Badge tone={run.outcome === "passed" ? "success" : "danger"} size="sm">
          {run.outcome === "passed" ? "Passed" : "Failed"}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {wouldDo(run)}
        </span>
        <Time iso={run.createdAt} className="text-xs text-muted-foreground" />
        <ChevronDown
          className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {open && (
        <div className="space-y-3 border-t bg-muted/30 px-3 py-3 text-sm">
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
          <div>
            <p className="text-xs font-medium">What your provider said</p>
            <pre className="mt-1 max-h-72 overflow-auto rounded-md border bg-background p-3 font-mono text-xs">
              {JSON.stringify(run.claims, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </li>
  )
}
