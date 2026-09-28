import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { formatExact } from "@/lib/format"
import type { TransferOffer } from "@/lib/types"

/**
 * Domains somebody has offered to the signed-in person.
 *
 * ⚠ ABOVE THE LIST, NOT IN IT. An offered domain is not in this workspace and
 * cannot send from it; a row among the real domains would read as one that is
 * broken. It is a question waiting for an answer, so it sits where a question
 * is seen first.
 *
 * ⚠ IT SHOWS IN EVERY WORKSPACE THE PERSON OPENS, because the offer is to the
 * PERSON - matched on their verified email - and they choose where it lands
 * when they review it.
 */
export function IncomingTransfers({ offers }: { offers: TransferOffer[] }) {
  if (offers.length === 0) return null

  return (
    <div className="mb-6 space-y-2">
      {offers.map((offer) => (
        <div
          key={offer.id}
          className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium">
              {offer.offered_by} wants to transfer{" "}
              <span className="font-mono">{offer.domain_name}</span> to you
            </p>
            <p className="text-sm text-muted-foreground">
              From the {offer.from_workspace} workspace, sent to {offer.recipient_email}
              . Expires {formatExact(offer.expires_at)}.
            </p>
          </div>
          <Button size="sm" asChild className="shrink-0 self-start sm:self-auto">
            <Link href={`/transfers/${offer.id}`}>
              Review
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </div>
      ))}
    </div>
  )
}
