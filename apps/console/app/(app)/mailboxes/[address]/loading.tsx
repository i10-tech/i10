import { Section, SectionContent } from "@repo/ui/components/i10/page"
import { SkeletonBlock } from "@repo/ui/components/i10/skeleton-block"
import { DetailSkeleton } from "@/components/skeletons"

/** The rows the aliases card is drawn with: a few, since the real count is not known yet. */
const ALIAS_ROWS = [0, 1, 2]

/** Export and import: the two cards. */
const TRANSFER_CARDS = ["export", "import"]

/**
 * Loading a mailbox: its address, the six facts, the storage section, the
 * aliases section and the export and import section.
 *
 * ⚠ THE FACTS ARE THE PAGE'S SIX (display name, owner, domain, status, sign-in,
 * created) in the same grid, and the three blocks under them are the real `Section`s
 * with the heading, line and card each one has, so the rules between them and the
 * gaps are the loaded page's and nothing moves when it arrives. The aliases card
 * is drawn as a list of two-line rows, as the loaded one is, at three of them. The
 * export and import section is two cards of a title and a two-line description
 * each, which is what they are before anything has been run; one that is running
 * or finished is taller, and the page grows downward into it. A person the API
 * hides it from (a 403) is the one case the skeleton cannot know, and the section
 * simply is not there.
 * The Add alias and Change storage buttons and the danger zone are not drawn:
 * they are an admin's, and the skeleton cannot know the role.
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
        <Section>
          <div className="space-y-2">
            <SkeletonBlock className="h-5 w-32 rounded-lg" />
            <SkeletonBlock className="h-4 w-80 rounded-lg opacity-70" />
          </div>
          <SectionContent className="space-y-3">
            {TRANSFER_CARDS.map((card) => (
              // ⚠ THE CARD'S OWN BORDER AND PADDING, with a 20px title and a description that runs to two 20px lines at this width.
              <div key={card} className="space-y-1 rounded-2xl border bg-card p-4">
                <SkeletonBlock className="h-5 w-28 rounded-lg" />
                <SkeletonBlock className="h-10 w-full max-w-xl rounded-lg opacity-70" />
              </div>
            ))}
          </SectionContent>
        </Section>
      </div>
    </DetailSkeleton>
  )
}
