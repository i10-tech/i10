"use client"

import { WorkspaceSwitcher } from "@/components/workspace-switcher"
import type { TenantProfile } from "@/lib/types"

/**
 * Which workspace you are in.
 *
 * ⚠ IT NO LONGER CARRIES THE USER BUTTON, AND THE SPLIT IS THE POINT. This row
 * says whose data is on screen - switching it changes every number on every
 * page - and the person signed in is a different question, asked far less
 * often. They shared a row, and sharing it gave a monthly control the same
 * prominence as the one that reframes the entire console while squeezing both
 * into half the width. See `AccountBar`, at the foot of the rail.
 *
 * ⚠ THE SWITCHER IS OURS SINCE 2026-10-12, OVER CLERK'S DATA. It was Clerk's
 * `<OrganizationSwitcher />`; membership and who may switch to what are still
 * Clerk's to answer - the switcher reads and switches through Clerk - so no
 * copy of "who belongs where" lives in our database. See workspace-switcher.
 *
 * ⚠ NO PLAN BADGE HERE ANY MORE. It moved to the account row at the foot of
 * the rail, beside the usage ring it explains (decided 2026-09-29) - one place
 * for the plan, not two.
 *
 * ⚠ AND SWITCHING ORGANIZATION CHANGES THE TENANT UNDERNEATH EVERY PAGE.
 * `tenant_for_principal` resolves the active org first - see migration 0038 -
 * so a switch means every number on screen now belongs to a different account.
 * The switcher sends them to the overview rather than leaving them on
 * `/domains/<an id the new tenant does not own>`, which would 404 and read as
 * the switch having broken something.
 */
export function WorkspaceBar({
  tenant,
  clerkEnabled,
}: {
  tenant: TenantProfile | null
  /**
   * ⚠ PASSED FROM THE SERVER RATHER THAN DETECTED HERE. Clerk's hooks throw
   * outside a `<ClerkProvider>`, and the provider is only mounted when a
   * publishable key exists - so this component has to know, and only the server
   * can read the unprefixed variable that says.
   */
  clerkEnabled: boolean
}) {
  /*
   * ⚠ THE FALLBACK IS FOR LOCAL REVIEW, NOT A DEGRADED PRODUCTION STATE. Every
   * real deployment has Clerk configured; this renders the workspace name as
   * text so the rail is not a hole while somebody is looking at the interface
   * with no identity provider running. See lib/preview.ts.
   */
  if (!clerkEnabled) {
    return (
      <div className="flex h-9 items-center justify-between gap-2 rounded-md px-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {tenant?.name ?? "Workspace"}
        </span>
      </div>
    )
  }

  return (
    /*
     * ⚠ A FIXED 36px ROW, AND A SKELETON IN IT UNTIL CLERK HAS LOADED (the
     * switcher draws its own). It was Clerk's and drew nothing until clerk-js arrived, so the
     * row used to be 0px tall on first paint: the navigation rendered in its
     * place and was shoved down by the height of the switcher a moment later,
     * on every full load. The account bar at the foot already reserves its row
     * the same way. The height is fixed rather than a min-height so whatever
     * Clerk's trigger measures, nothing below it can move.
     */
    <div className="relative flex h-9 items-center justify-between gap-2 rounded-md px-1">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <WorkspaceSwitcher />
      </div>
    </div>
  )
}
