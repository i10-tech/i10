"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Check } from "lucide-react"
import { Spinner } from "@repo/ui/components/spinner"
import { acceptTransfer } from "@/lib/actions"
import { Status } from "@/components/status"
import { DomainSetup } from "@/components/onboarding/domain-setup"
import { AutoHeight } from "@repo/ui/components/auto-height"
import { Button } from "@repo/ui/components/button"
import { StepStage } from "@repo/ui/components/step-stage"
import type { DomainSummary, TransferOffer } from "@/lib/types"
import { toastDone, toastError } from "@/lib/toast"

/**
 * ⚠ THIS USED TO MOUNT THE FULL ADD-DOMAIN FORM, and the comment here defended
 * that on drift grounds: a wizard version would be a second implementation of
 * detection, the delegate-or-manual decision and the plan limit. The argument
 * was right about the risk and wrong about the cost - what it bought was
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
  offers = [],
  onDone,
}: {
  domains: DomainSummary[]
  /** Domains offered to this person by email. See `OfferedDomains`. */
  offers?: TransferOffer[]
  onDone: () => void
}) {
  const router = useRouter()
  // ⚠ AN OFFER WAITING IS THE ANSWER TO "WHICH DOMAIN", so the set-up form
  // does not open over it. It is one button away if they want another.
  const [adding, setAdding] = React.useState(
    domains.length === 0 && offers.length === 0,
  )

  return (
    <div className="space-y-6">
      <OfferedDomains offers={offers} onAccepted={() => router.refresh()} />

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

      {/* The form and the button row swap in place and the step's height
          follows - see `AutoHeight`. */}
      <AutoHeight grow="animate">
        <StepStage morph={false} step={adding ? "adding" : "added"}>
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
        </StepStage>
      </AutoHeight>
    </div>
  )
}

/**
 * Domains somebody has offered to this person, accepted into the workspace
 * being set up.
 *
 * ⚠ THIS IS WHERE SOMEBODY WHO SIGNED UP FROM A TRANSFER EMAIL LANDS. The
 * domain they came for is the obvious first domain, and it arrives already
 * verified - so accepting it here is the whole of this step for them.
 *
 * ⚠ INTO THIS WORKSPACE, WITH NO PICKER. A new account has one; somebody with
 * several can answer from the domains page, which offers the choice.
 */
function OfferedDomains({
  offers,
  onAccepted,
}: {
  offers: TransferOffer[]
  onAccepted: () => void
}) {
  const [busy, setBusy] = React.useState<string | null>(null)

  if (offers.length === 0) return null

  async function accept(offer: TransferOffer) {
    setBusy(offer.id)
    const result = await acceptTransfer(offer.id)
    setBusy(null)
    if (!result.ok) {
      toastError("Could not accept the domain", { description: result.error })
      return
    }
    toastDone(`${offer.domain_name} is yours`, {
      description: "It arrived with its records and verification.",
    })
    onAccepted()
  }

  return (
    <ul className="divide-y overflow-hidden rounded-lg border">
      {offers.map((offer) => (
        <li
          key={offer.id}
          className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0 space-y-0.5">
            <p className="truncate font-mono text-sm">{offer.domain_name}</p>
            <p className="text-xs text-muted-foreground">
              Offered by {offer.offered_by} from the {offer.from_workspace} workspace
            </p>
          </div>
          <Button
            size="sm"
            className="shrink-0 self-start sm:self-auto"
            onClick={() => accept(offer)}
            disabled={busy !== null}
          >
            {busy === offer.id && <Spinner />}
            Accept
          </Button>
        </li>
      ))}
    </ul>
  )
}
