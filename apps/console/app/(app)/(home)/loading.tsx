import { SkeletonBlock } from "@repo/ui/components/i10/skeleton-block"
import { PageSkeleton } from "@/components/skeletons"

/**
 * Loading the overview: six trend cards, the sending health line, the
 * delivery chart, and recent sends beside the shortcuts, where each will land.
 */
export default function Loading() {
  return (
    <PageSkeleton title="Overview" actions={["w-[19rem]", "w-16"]}>
      <div className="space-y-6" aria-hidden>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 2xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => (
            <div
              key={i}
              className="flex flex-col gap-3 rounded-[var(--radius-panel)] border p-4"
            >
              <div className="flex items-baseline justify-between">
                <SkeletonBlock className="h-3.5 w-16 rounded-full" />
                <SkeletonBlock className="h-5 w-12 rounded-full" />
              </div>
              <SkeletonBlock className="h-12 w-full rounded-md opacity-60" />
              <SkeletonBlock className="h-3 w-20 rounded-full opacity-70" />
            </div>
          ))}
        </div>
        <SkeletonBlock className="h-16 w-full rounded-2xl" />
        <div className="space-y-3 rounded-2xl border p-4">
          <SkeletonBlock className="h-4 w-20 rounded-full" />
          <SkeletonBlock className="h-64 w-full rounded-xl opacity-60" />
        </div>
        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <div className="rounded-2xl border">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <SkeletonBlock className="h-4 w-28 rounded-full" />
              <SkeletonBlock className="h-7 w-20 rounded-[var(--radius-control)]" />
            </div>
            <div className="divide-y">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="flex items-center gap-4 px-4 py-3.5">
                  <SkeletonBlock className="size-2 rounded-full" />
                  <SkeletonBlock className="h-3.5 flex-1 rounded-full" />
                  <SkeletonBlock className="h-3 w-16 rounded-full opacity-70" />
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-3 rounded-2xl border p-4">
            {Array.from({ length: 4 }, (_, i) => (
              <SkeletonBlock key={i} className="h-10 w-full rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    </PageSkeleton>
  )
}
