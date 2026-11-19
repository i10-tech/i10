import type { Metadata } from "next"
import { SettingsGeneralView } from "@/components/settings-general-view"
import { tryApi } from "@/lib/api"
import { settingsShape, type SettingsData } from "@/lib/shapes/settings"
import type { Me } from "@/lib/types"

export const metadata: Metadata = { title: "General settings" }

/**
 * ⚠ THE WORKSPACE NAME AND THE ORGANIZATION NAME ARE ONE NAME, AND THIS PAGE
 * USED TO EXPLAIN WHY THEY WERE TWO. The explanation was sound and the outcome
 * was not: renaming here left the organization in the switcher on its old name
 * - "Mohamed" months after the workspace became "i10 testing" - with nothing
 * anywhere to reconcile them and no reason a customer could see for there being
 * two names at all.
 *
 * ⚠ AND THE OBJECTION IT WAS BUILT AROUND IS STILL HONOURED. Syncing must not
 * put a write to Clerk inside our rename transaction, or a Clerk outage stops
 * renames. So `PATCH /console/me/tenant` commits ours first and asks Clerk
 * afterwards, best effort; and `organization.updated` follows a rename made in
 * Clerk's own panel back onto the workspace. Two directions, neither of them
 * able to block the other.
 */
export default async function GeneralSettingsPage() {
  const me = await tryApi<Me>("/console/me")
  const clerkEnabled = Boolean(process.env.CLERK_PUBLISHABLE_KEY)

  const data: SettingsData = {
    tenant: me.ok ? me.data.tenant : null,
    billing: me.ok ? me.data.billing : null,
    access: me.ok ? me.data.access : null,
    clerkEnabled,
    ...(me.ok ? {} : { error: me.error.message }),
  }

  return <SettingsGeneralView shape={settingsShape.of(data)} data={data} />
}
