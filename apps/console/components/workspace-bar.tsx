"use client"

import { OrganizationSwitcher, UserButton } from "@clerk/nextjs"
import { Badge } from "@repo/ui/components/badge"
import type { PlanSummary, TenantProfile } from "@/lib/types"

/**
 * Which workspace you are in, and who you are.
 *
 * ⚠ THE SWITCHER IS CLERK'S, NOT OURS, AND THAT IS THE POINT. Membership,
 * roles, invitations and who may switch to what are Clerk's to answer;
 * rebuilding the switcher would mean projecting membership into our database
 * and keeping it fresh, and the one place a stale copy of "who is an admin"
 * matters is authorization. We render the plan badge beside it, because that
 * part IS ours.
 *
 * ⚠ AND SWITCHING ORGANIZATION CHANGES THE TENANT UNDERNEATH EVERY PAGE.
 * `tenant_for_principal` resolves the active org first — see migration 0038 —
 * so a switch means every number on screen now belongs to a different account.
 * `afterSelectOrganizationUrl="/"` sends them to the overview rather than
 * leaving them on `/domains/<an id the new tenant does not own>`, which would
 * 404 and read as the switch having broken something.
 */
export function WorkspaceBar({
  tenant,
  plan,
  clerkEnabled,
}: {
  tenant: TenantProfile | null
  plan: PlanSummary | null
  /**
   * ⚠ PASSED FROM THE SERVER RATHER THAN DETECTED HERE. Clerk's hooks throw
   * outside a `<ClerkProvider>`, and the provider is only mounted when a
   * publishable key exists — so this component has to know, and only the server
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
        {plan && (
          <Badge variant="outline" className="shrink-0 font-mono text-2xs uppercase">
            {plan.id}
          </Badge>
        )}
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
              // ⚠ THE TRIGGER IS RESTYLED TO SIT IN OUR RAIL RATHER THAN LEFT
              // AS A CARD. Clerk's default trigger carries its own padding,
              // border and shadow, which on a true-black sidebar renders as a
              // pale box floating inside the navigation.
              rootBox: "w-full min-w-0",
              organizationSwitcherTrigger:
                "w-full min-w-0 justify-start gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-sidebar-accent",
            },
          }}
          /*
           * ⚠ A FALLBACK NAME FROM *OUR* TENANT ROW, BECAUSE THE TWO NAMES ARE
           * GENUINELY DIFFERENT THINGS. Clerk's is the identity surface;
           * `core.tenants.name` is the billing entity, and it is what appears
           * on an invoice. They are kept separately on purpose — see
           * console/tenant.ts — so this is a fallback for the moment before
           * Clerk's client has loaded, not a second source of truth.
           */
        />
        {!tenant && (
          <span className="truncate text-sm text-muted-foreground">Workspace</span>
        )}
      </div>

      {plan && (
        <Badge
          variant="outline"
          className="shrink-0 font-mono text-2xs uppercase"
          title={`${plan.name} plan`}
        >
          {plan.id}
        </Badge>
      )}

      <UserButton
        appearance={{ elements: { userButtonAvatarBox: "size-6" } }}
        userProfileMode="navigation"
        /*
         * ⚠ PROFILE GOES TO OUR PAGE, NOT CLERK'S MODAL. `/account` wraps
         * Clerk's `<UserProfile />` inside the console's own chrome, so somebody
         * editing their password does not lose the sidebar and reappear on a
         * page that looks like a different product.
         */
        userProfileUrl="/account"
      />
    </div>
  )
}
