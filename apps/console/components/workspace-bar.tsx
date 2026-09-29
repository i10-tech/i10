"use client"

import { OrganizationSwitcher } from "@clerk/nextjs"
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
 * ⚠ THE SWITCHER IS CLERK'S, NOT OURS, AND THAT IS THE POINT. Membership,
 * roles, invitations and who may switch to what are Clerk's to answer;
 * rebuilding the switcher would mean projecting membership into our database
 * and keeping it fresh, and the one place a stale copy of "who is an admin"
 * matters is authorization.
 *
 * ⚠ NO PLAN BADGE HERE ANY MORE. It moved to the account row at the foot of
 * the rail, beside the usage ring it explains (decided 2026-09-29) - one place
 * for the plan, not two.
 *
 * ⚠ AND SWITCHING ORGANIZATION CHANGES THE TENANT UNDERNEATH EVERY PAGE.
 * `tenant_for_principal` resolves the active org first - see migration 0038 -
 * so a switch means every number on screen now belongs to a different account.
 * `afterSelectOrganizationUrl="/"` sends them to the overview rather than
 * leaving them on `/domains/<an id the new tenant does not own>`, which would
 * 404 and read as the switch having broken something.
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
      <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {tenant?.name ?? "Workspace"}
        </span>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between gap-2 rounded-md px-1 py-0.5">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <OrganizationSwitcher
          hidePersonal
          afterSelectOrganizationUrl="/"
          afterCreateOrganizationUrl="/onboarding"
          appearance={{
            elements: {
              // ⚠ LAYOUT ONLY. Clerk's default trigger carries its own padding,
              // border and shadow, which on a true-black sidebar renders as a
              // pale box floating inside the navigation - but the COLOURS come
              // from the provider now, so there is nothing to restate here.
              // See @repo/ui/clerk.
              rootBox: "w-full min-w-0",
              /*
               * ⚠ ICON LEFT, NAME BESIDE IT, CHEVRON AT THE FAR RIGHT. Clerk
               * packs all three together on the left, which leaves the chevron
               * floating mid-row with no edge to belong to; the preview takes
               * the free width so the chevron lands on the rail's edge, where
               * a select's arrow is expected to be.
               */
              organizationSwitcherTrigger:
                "w-full min-w-0 justify-between gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-sidebar-accent",
              organizationPreview: "min-w-0 flex-1 gap-2",
              organizationPreviewTextContainer: "min-w-0",
              organizationPreviewMainIdentifier: "truncate",
              organizationSwitcherTriggerIcon: "ms-auto shrink-0",
            },
          }}
          /*
           * ⚠ A FALLBACK NAME FROM *OUR* TENANT ROW, BECAUSE THE TWO NAMES ARE
           * GENUINELY DIFFERENT THINGS. Clerk's is the identity surface;
           * `core.tenants.name` is the billing entity, and it is what appears
           * on an invoice. They are kept separately on purpose - see
           * console/tenant.ts - so this is a fallback for the moment before
           * Clerk's client has loaded, not a second source of truth.
           */
        />
        {!tenant && (
          <span className="truncate text-sm text-muted-foreground">Workspace</span>
        )}
      </div>
    </div>
  )
}
