import { SkeletonBlock } from "@repo/ui/components/i10/skeleton-block"
import { PageSkeleton } from "@/components/skeletons"
import { PAGE_COPY } from "@/lib/page-copy"

/** Loading mailboxes: the page is a single panel today, so is its placeholder. */
export default function Loading() {
  return (
    <PageSkeleton
      title={PAGE_COPY.mailboxes.title}
      description={PAGE_COPY.mailboxes.description}
    >
      <div className="flex flex-col items-center gap-3 py-16" aria-hidden>
        <SkeletonBlock className="size-12 rounded-full" />
        <SkeletonBlock className="h-4 w-48 rounded-full" />
        <SkeletonBlock className="h-3 w-72 rounded-full opacity-70" />
      </div>
    </PageSkeleton>
  )
}
