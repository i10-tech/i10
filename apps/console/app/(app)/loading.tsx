import { SkeletonBlock } from "@repo/ui/components/i10/skeleton-block"
import { Page, PageBody, PageHeader, PageHeaderRow } from "@repo/ui/components/i10/page"

/**
 * The fallback for a page without a loading state of its own (each list,
 * record and settings page has one, shaped like it; see components/skeletons).
 * A page's frame only: the header where the title will be, and a panel.
 */
export default function Loading() {
  return (
    <Page aria-busy="true">
      <PageHeader>
        <PageHeaderRow>
          <SkeletonBlock className="h-8 w-48 rounded-lg" />
        </PageHeaderRow>
        <SkeletonBlock className="mt-2 h-4 w-full max-w-md rounded-full opacity-70" />
      </PageHeader>
      <PageBody>
        <SkeletonBlock className="h-80 w-full rounded-[var(--radius-panel)] opacity-60" />
      </PageBody>
    </Page>
  )
}
