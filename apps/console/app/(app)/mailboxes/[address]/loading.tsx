import { SkeletonBlock } from "@repo/ui/components/i10/skeleton-block"
import { DetailSkeleton } from "@/components/skeletons"

/**
 * Loading a mailbox: its address, the six facts, and the storage section.
 *
 * ⚠ THE FACTS ARE THE PAGE'S SIX (display name, owner, domain, status, sign-in,
 * created) in the same grid, and the block under them is the storage section's
 * heading and card, so nothing moves when the page arrives. The danger zone
 * below it is not drawn: it is an admin's, and the skeleton cannot know the role.
 */
export default function Loading() {
  return (
    <DetailSkeleton facts={6}>
      <div className="space-y-4">
        <div className="space-y-2">
          <SkeletonBlock className="h-5 w-20 rounded-lg" />
          <SkeletonBlock className="h-4 w-72 rounded-lg opacity-70" />
        </div>
        <SkeletonBlock className="h-24 w-full rounded-2xl" />
      </div>
    </DetailSkeleton>
  )
}
