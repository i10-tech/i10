import { Section, SectionContent } from "@repo/ui/components/i10/page"
import { SkeletonBlock } from "@repo/ui/components/i10/skeleton-block"
import { DetailSkeleton } from "@/components/skeletons"

/** The rows the members list is drawn with: a few, since the real count is not known yet. */
const MEMBER_ROWS = [0, 1, 2]

/**
 * Loading a team inbox: its address, the two facts, and the members section.
 *
 * ⚠ THE FACTS ARE THE PAGE'S TWO (display name and created) and the block
 * under them is the real `Section`, with the heading, line and list the loaded
 * one has, so the rules and gaps are the loaded page's and nothing moves when it
 * arrives. The picker, the Save button and the danger zone are not drawn: they
 * are an admin's, and the skeleton cannot know the role.
 */
export default function Loading() {
  return (
    <DetailSkeleton facts={2}>
      <Section className="pt-0">
        <div className="space-y-2">
          <SkeletonBlock className="h-5 w-20 rounded-lg" />
          <SkeletonBlock className="h-4 w-96 max-w-full rounded-lg opacity-70" />
        </div>
        <SectionContent>
          <div className="divide-y rounded-xl border bg-card">
            {MEMBER_ROWS.map((row) => (
              <div key={row} className="px-4 py-2.5">
                <SkeletonBlock className="h-5 w-56 rounded-lg" />
              </div>
            ))}
          </div>
        </SectionContent>
      </Section>
    </DetailSkeleton>
  )
}
