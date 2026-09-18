import {
  Page,
  PageBody,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"

/**
 * The settings shell.
 *
 * ⚠ THE SECOND COLUMN IS GONE, AND THE LEFT RAIL DOES ITS JOB INSTEAD. Settings
 * used to render its own narrow navigation beside the content while the console
 * rail stayed on screen, which put two vertical lists of links within a few
 * pixels of each other and left the content column squeezed into whatever was
 * left. `SidebarNav` now swaps itself for `SETTINGS_NAV` on these routes and
 * carries a way back — one navigation, in the place navigation already lives.
 *
 * ⚠ AND THE HEADING STILL LIVES HERE, NOT IN EACH PAGE. Eight pages each
 * rendering their own "Settings" title is eight chances for one of them to be
 * two pixels out — which nobody can name and everybody feels as they move
 * between tabs.
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

      {/*
       * ⚠ A MAX WIDTH, BECAUSE SETTINGS IS PROSE AND FORMS. Without the second
       * column the content is free to run the full width of a desktop window,
       * where a label and its field end up a hand's width apart.
       */}
      <PageBody>
        <div className="min-w-0 max-w-3xl">{children}</div>
      </PageBody>
    </Page>
  )
}
