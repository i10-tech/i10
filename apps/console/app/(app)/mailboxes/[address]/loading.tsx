import { Section, SectionContent } from "@repo/ui/components/i10/page"
import { SkeletonBlock } from "@repo/ui/components/i10/skeleton-block"
import { DetailSkeleton } from "@/components/skeletons"

/** The rows the aliases card is drawn with: a few, since the real count is not known yet. */
const ALIAS_ROWS = [0, 1, 2]

/**
 * Loading a mailbox: its address, the six facts, the storage section and the
 * aliases section.
 *
 * ⚠ THE FACTS ARE THE PAGE'S SIX (display name, owner, domain, status, sign-in,
 * created) in the same grid, and the two blocks under them are the real `Section`s
 * with the heading, line and card each one has, so the rules between them and the
 * gaps are the loaded page's and nothing moves when it arrives. The aliases card
 * is drawn as a list of two-line rows, as the loaded one is, at three of them; the
 * Add alias and Change storage buttons, the transfer section and the danger zone
 * are not drawn: they are an admin's, and the skeleton cannot know the role.
 */
export default function Loading() {
  return (
    <DetailSkeleton facts={6}>
      <div>
        <Section className="pt-0">
          <div className="space-y-2">
            <SkeletonBlock className="h-5 w-20 rounded-lg" />
            <SkeletonBlock className="h-4 w-72 rounded-lg opacity-70" />
          </div>
          <SectionContent>
            <SkeletonBlock className="h-24 w-full rounded-2xl" />
          </SectionContent>
        </Section>
        <Section>
          <div className="space-y-2">
            <SkeletonBlock className="h-5 w-16 rounded-lg" />
            <SkeletonBlock className="h-4 w-80 rounded-lg opacity-70" />
          </div>
          <SectionContent>
            <div className="divide-y rounded-2xl border bg-card">
              {ALIAS_ROWS.map((row) => (
                // ⚠ 20px AND 16PX LINES WITH A 2PX GAP: the address and its source line.
                <div key={row} className="space-y-0.5 px-4 py-3">
                  <SkeletonBlock className="h-5 w-56 rounded-lg" />
                  <SkeletonBlock className="h-4 w-32 rounded-lg opacity-70" />
                </div>
              ))}
            </div>
          </SectionContent>
        </Section>
      </div>
    </DetailSkeleton>
  )
}
