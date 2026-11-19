import { SettingsShell } from "@/components/section-frame"
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
 * ⚠ THE FRAME ITSELF IS `SettingsShell`, shared with the skeleton drawn when
 * settings is entered from elsewhere (components/section-frame).
 */
export default async function SettingsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const me = await tryApi<Me>("/console/me")
  const tenant = me.ok ? me.data.tenant : null
  const clerkEnabled = Boolean(process.env.CLERK_PUBLISHABLE_KEY)

  return (
    <SettingsShell
      actions={
        <SettingsWorkspace initialWorkspace={tenant} clerkEnabled={clerkEnabled} />
      }
    >
      {children}
    </SettingsShell>
  )
}
