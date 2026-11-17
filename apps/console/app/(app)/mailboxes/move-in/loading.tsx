import { SkeletonBlock } from "@repo/ui/components/i10/skeleton-block"
import { PageSkeleton } from "@/components/skeletons"
import { PAGE_COPY } from "@/lib/page-copy"

/**
 * The page's three sections: the steps, the files that work and the mailbox
 * list, each with its heading, at the widths the loaded page uses.
 */
export default function Loading() {
  return (
    <PageSkeleton
      title={PAGE_COPY.mailboxMoveIn.title}
      description={PAGE_COPY.mailboxMoveIn.description}
    >
      <div className="space-y-8" aria-hidden>
        <div className="max-w-2xl space-y-4">
          <SkeletonBlock className="h-7 w-36 rounded-md" />
          <SkeletonBlock className="h-4 w-full rounded-full" />
          <SkeletonBlock className="h-4 w-[92%] rounded-full" />
          <SkeletonBlock className="h-4 w-[80%] rounded-full" />
        </div>
        <div className="max-w-2xl space-y-4">
          <SkeletonBlock className="h-7 w-40 rounded-md" />
          <SkeletonBlock className="h-4 w-[85%] rounded-full" />
          <SkeletonBlock className="h-40 w-full rounded-2xl" />
        </div>
        <div className="max-w-2xl space-y-4">
          <SkeletonBlock className="h-7 w-44 rounded-md" />
          <SkeletonBlock className="h-36 w-full rounded-2xl" />
        </div>
      </div>
    </PageSkeleton>
  )
}
