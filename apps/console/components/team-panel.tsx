"use client"

import { CreateOrganization, OrganizationProfile, useOrganization } from "@clerk/nextjs"
import { Skeleton } from "@repo/ui/components/skeleton"

/**
 * Members, roles and invitations — or an explanation of why there are none.
 *
 * ⚠ THIS EXISTS BECAUSE THE PAGE RENDERED A HEADING AND NOTHING ELSE.
 * `<OrganizationProfile />` returns null when no organization is active, which
 * is the state of anybody signed in to a personal account — and Clerk does not
 * say so, it simply renders nothing. The result was a Team page consisting of a
 * title, one sentence about sharing a workspace, and empty space below it: no
 * error, no explanation, and nothing to click. It reads as a page that failed
 * to load, and the actual situation — "you have no team yet, here is how to
 * start one" — was invisible.
 *
 * ⚠ THE EMPTY STATE IS `CreateOrganization`, NOT A SENTENCE. The reason there
 * are no members is that there is no organization, and the whole remedy is one
 * form. Explaining the problem and then making somebody find the workspace
 * switcher in the corner to fix it is two steps where there is naturally one.
 *
 * ⚠ AND `isLoaded` IS HANDLED SEPARATELY FROM "NO ORGANIZATION". Clerk reports
 * `organization: null` while it is still resolving, so treating the two as one
 * flashes "create a workspace" at every member of an existing one for as long
 * as the session takes to load.
 */
export function TeamPanel() {
  const { isLoaded, organization } = useOrganization()

  if (!isLoaded) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-9 w-full max-w-sm" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (!organization) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          You are signed in to a personal account, so there is no team to show yet.
          Create a workspace to invite people and share domains, keys and billing.
        </p>
        <CreateOrganization
          skipInvitationScreen={false}
          // ⚠ BACK TO THIS PAGE, NOT TO THE OVERVIEW. Somebody creating a
          // workspace from the Team page came here to add people; landing them
          // on the dashboard makes them navigate back to finish the thing they
          // started.
          afterCreateOrganizationUrl="/settings/team"
          appearance={CHROMELESS}
        />
      </div>
    )
  }

  return <OrganizationProfile routing="hash" appearance={CHROMELESS} />
}

/**
 * ⚠ CLERK'S CARD CHROME IS REMOVED, NOT RESTYLED. Its default is a bordered,
 * shadowed card — on a settings page that is already a list of sections, that
 * renders as a box inside a box, and the shadow is the only one in the whole
 * console.
 */
const CHROMELESS = {
  elements: {
    rootBox: "w-full",
    cardBox: "w-full max-w-none shadow-none border-0",
    card: "w-full max-w-none shadow-none border-0 bg-transparent p-0",
    navbar: "hidden",
    navbarMobileMenuRow: "hidden",
    pageScrollBox: "p-0",
  },
} as const
