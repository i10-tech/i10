import { SkeletonBlock } from "@repo/ui/components/i10/skeleton-block"
import { PageSkeleton } from "@/components/skeletons"
import { PAGE_COPY } from "@/lib/page-copy"

/**
 * The two sections at the loaded page's width: a heading and its line, then the
 * three choices, then the storage card.
 */
export default function Loading() {
  return (
    <PageSkeleton
      title={PAGE_COPY.mailboxSettings.title}
      description={PAGE_COPY.mailboxSettings.description}
    >
      <div className="min-w-0 max-w-3xl space-y-10" aria-hidden>
        <div className="space-y-4">
          <SkeletonBlock className="h-6 w-48 rounded-md" />
          <SkeletonBlock className="h-4 w-72 rounded-full" />
          <SkeletonBlock className="h-16 w-full rounded-2xl" />
          <SkeletonBlock className="h-16 w-full rounded-2xl" />
          <SkeletonBlock className="h-16 w-full rounded-2xl" />
        </div>
        <div className="space-y-4">
          <SkeletonBlock className="h-6 w-24 rounded-md" />
          <SkeletonBlock className="h-4 w-80 rounded-full" />
          <SkeletonBlock className="h-32 w-full rounded-2xl" />
        </div>
      </div>
    </PageSkeleton>
  )
}
