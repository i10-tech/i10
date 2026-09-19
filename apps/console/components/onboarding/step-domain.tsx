"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Check } from "lucide-react"
import { Status } from "@/components/status"
import { DomainSetup } from "@/components/onboarding/domain-setup"
import { Button } from "@repo/ui/components/button"
import type { DomainSummary } from "@/lib/types"

/**
 * ⚠ THIS USED TO MOUNT THE FULL ADD-DOMAIN FORM, and the comment here defended
 * that on drift grounds: a wizard version would be a second implementation of
 * detection, the delegate-or-manual decision and the plan limit. The argument
 * was right about the risk and wrong about the cost — what it bought was
 * somebody's first five minutes spent on a page carrying a name field, a
 * detection panel, two fieldsets and an advanced section, which is four
 * decisions presented as one wall.
 *
 * ⚠ SO `DomainSetup` ASKS THEM ONE AT A TIME AND SHARES THE PARTS THAT COULD
 * ACTUALLY DRIFT. Detection, creation, publishing and the plan limit are the
 * same server actions the form calls; what differs is only how many questions
 * are on screen at once, and whether the automatic path is offered or simply
 * attempted. `/domains/new` keeps the full form, which is the right shape for
 * somebody adding their fourth domain.
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
        <DomainSetup
          onDone={() => {
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
