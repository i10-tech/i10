import { SkeletonBlock } from "@repo/ui/components/i10/skeleton-block"
import { DetailSkeleton } from "@/components/skeletons"

/** Loading a record: its name, the facts row, its tabs and the first panel. */
export default function Loading() {
  return (
    <DetailSkeleton tabs={[]}>
      <SkeletonBlock className="h-72 w-full rounded-[var(--radius-panel)] opacity-70" />
    </DetailSkeleton>
  )
}
