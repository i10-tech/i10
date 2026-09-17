"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Check } from "lucide-react"
import { Status } from "@/components/status"
import { AddDomainForm } from "@/components/add-domain-form"
import { Button } from "@repo/ui/components/button"
import type { DomainSummary } from "@/lib/types"

/**
 * ⚠ IT REUSES THE REAL ADD-DOMAIN FORM RATHER THAN A SIMPLIFIED COPY. A
 * "wizard version" would be a second implementation of live DNS detection, the
 * delegate-or-manual decision and the plan-limit handling — and the two would
 * drift, with the onboarding one always being the stale half. The form takes an
 * `onCreated` callback precisely so the flow can stay on this page instead of
 * navigating away.
 */
export function StepDomain({
  domains,
  onDone,
}: {
  domains: DomainSummary[]
  onDone: () => void
}) {
  const router = useRouter()
  const [adding, setAdding] = React.useState(domains.length === 0)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Add your domain</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Mail leaves from a domain you control. We will detect who hosts its DNS
          and show you the shortest path from here.
        </p>
      </div>

      {domains.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {domains.map((domain) => (
            <li
              key={domain.id}
              className="flex items-center justify-between gap-3 px-4 py-2.5"
            >
              <span className="min-w-0 truncate font-mono text-sm">{domain.name}</span>
              <Status status={domain.status} />
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <AddDomainForm
          onCreated={() => {
            setAdding(false)
            // ⚠ REFRESHED SO THE LIST ABOVE INCLUDES THE NEW DOMAIN BEFORE THE
            // VERIFY STEP READS IT. Without this, "Next" lands on a verify step
            // that says there is nothing to verify.
            router.refresh()
            onDone()
          }}
        />
      ) : (
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setAdding(true)}>
            Add another domain
          </Button>
          <Button onClick={onDone}>
            <Check />
            Continue
          </Button>
        </div>
      )}
    </div>
  )
}
