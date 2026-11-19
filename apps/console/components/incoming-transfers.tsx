import { ArrowRight } from "lucide-react"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import type { TransferOffer } from "@/lib/types"
import { seedShape } from "@/components/list/remembered-shapes"
import { transferShape } from "@/lib/shapes/transfers"
import { useExactTime } from "@/components/time"

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
 *
 * ⚠ ONE VIEW FOR BOTH MODES: `count` is the shape (how many cards a skeleton
 * draws); `offers` is the data, and is what a loaded page maps over.
 */
export function IncomingTransfers({
  count,
  offers,
}: {
  count: number
  offers?: TransferOffer[]
}) {
  const exact = useExactTime()
  const cards = offers ?? Array.from({ length: count }, () => undefined)
  if (cards.length === 0) return null

  return (
    <div className="mb-6 space-y-2">
      {cards.map((offer, i) => (
        <BoneScope key={offer?.id ?? i} id={`offer-${i}`} unit>
          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-0.5">
              <Bone id="title" width={280} className="text-sm font-medium">
                {offer && (
                  <p className="text-sm font-medium">
                    {offer.offered_by} wants to transfer{" "}
                    <span className="font-mono">{offer.domain_name}</span> to you
                  </p>
                )}
              </Bone>
              <Bone id="detail" width={420} className="text-sm">
                {offer && (
                  <p className="text-sm text-muted-foreground">
                    From the {offer.from_workspace} workspace, sent to{" "}
                    {offer.recipient_email}. Expires {exact(offer.expires_at)}.
                  </p>
                )}
              </Bone>
            </div>
            <Bone
              id="review"
              shape="box"
              width={84}
              height={32}
              radius={10}
              inline
              className="shrink-0 self-start sm:self-auto"
            >
              {offer && (
                <ButtonLink
                  href={`/transfers/${offer.id}`}
                  size="sm"
                  onMouseEnter={() => seedShape(transferShape, offer.id, { ok: true })}
                  onFocus={() => seedShape(transferShape, offer.id, { ok: true })}
                  onClick={() => seedShape(transferShape, offer.id, { ok: true })}
                >
                  Review
                  <ArrowRight aria-hidden="true" />
                </ButtonLink>
              )}
            </Bone>
          </div>
        </BoneScope>
      ))}
    </div>
  )
}
