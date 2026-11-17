import { SkeletonBlock } from "@repo/ui/components/i10/skeleton-block"
import { PageSkeleton } from "@/components/skeletons"
import { PAGE_COPY } from "@/lib/page-copy"

/** The rows a list is drawn with while its real count is not known. */
const ROWS = [0, 1, 2, 3]

/**
 * Loading the Team inboxes list: the header with room for Create, then a table
 * of the three columns the loaded one has, so nothing moves when it arrives.
 */
export default function Loading() {
  return (
    <PageSkeleton
      title={PAGE_COPY.teamInboxes.title}
      description={PAGE_COPY.teamInboxes.description}
      actions={["w-40"]}
    >
      <div className="space-y-3" aria-hidden>
        <SkeletonBlock className="h-9 w-full rounded-lg opacity-70" />
        {ROWS.map((row) => (
          <SkeletonBlock key={row} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    </PageSkeleton>
  )
}
