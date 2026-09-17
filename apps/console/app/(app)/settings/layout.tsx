import {
  Page,
  PageBody,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { SettingsNav } from "@/components/settings-nav"

/**
 * The settings shell.
 *
 * ⚠ A SECOND COLUMN RATHER THAN A SECOND TOP-LEVEL NAVIGATION. Settings is
 * eight pages that somebody visits once a quarter; promoting them into the main
 * rail would push the ten things used daily below the fold. Keeping the main
 * rail visible also means leaving settings is one click rather than a back
 * button.
 *
 * ⚠ AND THE HEADING LIVES HERE, NOT IN EACH PAGE. Eight pages each rendering
 * their own "Settings" title is eight chances for one of them to be two pixels
 * out — which nobody can name and everybody feels as they move between tabs.
 */
export default function SettingsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Settings</PageTitle>
        </PageHeaderRow>
      </PageHeader>

      <PageBody className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
        <SettingsNav />
        <div className="min-w-0">{children}</div>
      </PageBody>
    </Page>
  )
}
