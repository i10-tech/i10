import {
  Page,
  PageBody,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/i10/page"

/**
 * The frame for the unlisted Clerk reference pages (2026-10-12).
 *
 * ⚠ IT DID NOT EXIST, AND THE PAGES RENDERED FLUSH AGAINST THE RAIL - no
 * padding, no heading, full width - the same bug account/layout.tsx fixed for
 * /account. It mirrors that layout.
 */
export default function ReferenceLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Reference</PageTitle>
        </PageHeaderRow>
      </PageHeader>
      <PageBody>
        <div className="min-w-0 max-w-3xl">{children}</div>
      </PageBody>
    </Page>
  )
}
