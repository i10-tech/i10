import { SkeletonBlock } from "@repo/ui/components/i10/skeleton-block"
import { PageSkeleton } from "@/components/skeletons"
import { PAGE_COPY } from "@/lib/page-copy"

export default function Loading() {
  return (
    <PageSkeleton
      title={PAGE_COPY.mailboxes.title}
      description={PAGE_COPY.mailboxes.description}
    >
      <div className="space-y-3" aria-hidden>
        <SkeletonBlock className="h-24 w-full rounded-2xl" />
        <SkeletonBlock className="h-10 w-full rounded-lg" />
        <SkeletonBlock className="h-10 w-full rounded-lg" />
        <SkeletonBlock className="h-10 w-full rounded-lg" />
      </div>
    </PageSkeleton>
  )
}
