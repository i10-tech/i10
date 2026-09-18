import {
  Page,
  PageBody,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"

/**
 * The account shell.
 *
 * ⚠ THIS FILE DID NOT EXIST, AND ITS ABSENCE IS THE BUG IT FIXES. `/account`
 * and `/account/appearance` are listed in `SETTINGS_NAV` and look like settings
 * pages, but they sit outside the `settings` segment — so they inherited no
 * `Page` wrapper at all and rendered flush against the left edge of the
 * viewport, with no padding and no heading, while every neighbouring page had
 * both. It read as a broken stylesheet rather than a missing layout.
 *
 * ⚠ IT MIRRORS `settings/layout.tsx` RATHER THAN SHARING A COMPONENT WITH IT.
 * The two are six lines of chrome and one word of copy apart; a shared
 * `<SettingsShell>` taking a title prop is indirection that makes both harder
 * to read to save nothing. If a third one appears, that is the time.
 */
export default function AccountLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Account</PageTitle>
        </PageHeaderRow>
      </PageHeader>

      <PageBody>
        <div className="min-w-0 max-w-3xl">{children}</div>
      </PageBody>
    </Page>
  )
}
