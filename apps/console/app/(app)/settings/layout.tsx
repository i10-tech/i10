import {
  Page,
  PageBody,
  PageHeader,
  PageActions,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/i10/page"
import { SectionContent } from "@/components/page-frame"
import { SettingsWorkspace } from "@/components/settings-workspace"
import { tryApi } from "@/lib/api"
import type { Me } from "@/lib/types"

/**
 * The settings shell.
 *
 * ⚠ THE SECOND COLUMN IS GONE, AND THE LEFT RAIL DOES ITS JOB INSTEAD. Settings
 * used to render its own narrow navigation beside the content while the console
 * rail stayed on screen, which put two vertical lists of links within a few
 * pixels of each other and left the content column squeezed into whatever was
 * left. `SidebarNav` now swaps itself for `SETTINGS_NAV` on these routes and
 * carries a way back - one navigation, in the place navigation already lives.
 *
 * ⚠ AND THE HEADING STILL LIVES HERE, NOT IN EACH PAGE. Eight pages each
 * rendering their own "Settings" title is eight chances for one of them to be
 * two pixels out - which nobody can name and everybody feels as they move
 * between tabs.
 */
export default async function SettingsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const me = await tryApi<Me>("/console/me")
  const tenant = me.ok ? me.data.tenant : null
  const clerkEnabled = Boolean(process.env.CLERK_PUBLISHABLE_KEY)

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Settings</PageTitle>
          {/*
           * Which workspace these are the settings of, for people in more than
           * one. It fades in once Clerk has the list, into the 36px the row
           * already reserves, so nothing beside it moves.
           */}
          <PageActions>
            <SettingsWorkspace initialWorkspace={tenant} clerkEnabled={clerkEnabled} />
          </PageActions>
        </PageHeaderRow>
      </PageHeader>

      {/*
       * ⚠ A MAX WIDTH, BECAUSE SETTINGS IS PROSE AND FORMS. Without the second
       * column the content is free to run the full width of a desktop window,
       * where a label and its field end up a hand's width apart.
       */}
      <PageBody>
        <div className="min-w-0 max-w-3xl">
          <SectionContent>{children}</SectionContent>
        </div>
      </PageBody>
    </Page>
  )
}
