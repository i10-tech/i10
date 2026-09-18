"use client"

import { useEffect, useRef } from "react"
import { useAuth, useOrganizationList } from "@clerk/nextjs"

/**
 * Selecting the workspace somebody already belongs to.
 *
 * ⚠ AN ORGANIZATION EXISTING IS NOT THE SAME AS IT BEING ACTIVE, AND THAT GAP
 * IS THE WHOLE BUG. A new account gets an organization provisioned for it by
 * the API, from Clerk's `user.created` webhook — see apps/api/src/tenants/
 * provision.ts. That is a BACKEND call, made against Clerk while the person is
 * still on the sign-up page, and it cannot reach into the session they are
 * holding: `org_id` on the session token stays empty until something in a
 * browser calls `setActive`. So they arrive in the console as a member of
 * exactly one workspace with none of them selected, and the switcher in the
 * sidebar shows nothing.
 *
 * ⚠ AND CLERK WILL NOT DO IT FOR US ON THIS INSTANCE. `force_organization_selection`
 * is off, so Clerk never raises its `choose-organization` task and `/sign-in/tasks`
 * has nothing to render — which is also why "I can't choose an org" had no screen
 * to go and look at. Turning that setting on would make EVERY sign-in stop at a
 * chooser, including for the single-workspace case this is, which is a question
 * with one answer.
 *
 * ⚠ IT MATTERS MORE THAN THE SWITCHER LOOKING EMPTY. `core.tenant_for_principal`
 * reads a null organization as "the personal tenant" — a real tenant with real
 * data — so a session with no active org does not fail, it silently resolves
 * somewhere else. Today those two happen to be the same row, because provisioning
 * sets the organization's owner to the same user. They stop being the same row
 * the moment anybody is invited into somebody else's workspace, and nothing on
 * screen would say so. See the note in apps/api/src/middleware/tenant.ts.
 *
 * ⚠ IT RENDERS NOTHING AND IS MOUNTED AT THE ROOT, NOT IN THE DASHBOARD SHELL.
 * `/onboarding` lives OUTSIDE `(app)/layout.tsx` precisely so the shell's
 * redirect cannot loop — and onboarding is the first screen a new account sees,
 * which makes it the first screen that needs a workspace. Mounting this beside
 * the sidebar would fix the switcher and leave the flow that comes before it
 * running against a guess.
 */
export function ActivateWorkspace() {
  const { isLoaded: sessionLoaded, orgId } = useAuth()
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    /*
     * ⚠ `infinite` IS WHAT MAKES `data` POPULATE AT ALL. Without a parameter
     * object `useOrganizationList` returns the hook's other members and leaves
     * `userMemberships.data` undefined — the list is opt-in, and asking for it
     * is what triggers the fetch.
     */
    userMemberships: { infinite: true },
  })

  /*
   * ⚠ ONE ATTEMPT PER MOUNT, GUARDED BY A REF RATHER THAN BY STATE. `setActive`
   * is what makes `orgId` non-null, and `@clerk/nextjs` follows it with a
   * `router.refresh()` of its own — so between the call and the new session
   * landing there is a window in which this effect can run again and issue a
   * second one. A ref does not re-render, and a failed attempt must not be
   * retried in a loop against a Clerk that is refusing.
   */
  const attempted = useRef(false)

  useEffect(() => {
    if (!sessionLoaded || !isLoaded) return
    // Already chosen — by this component on an earlier page, by the switcher, or
    // by an invite link. Nothing to do, and re-selecting would fight the person.
    if (orgId) return
    if (attempted.current) return

    /*
     * ⚠ THE FIRST MEMBERSHIP, WHICH IS THE OLDEST. Clerk returns these in
     * creation order, so for the case this exists for — one organization,
     * provisioned at sign-up — "first" and "the only one" are the same thing.
     * For somebody who has since been invited elsewhere it picks the workspace
     * that has been theirs longest, which is the least surprising default and
     * is one click away from any other.
     */
    const first = userMemberships.data?.[0]
    if (!first) return

    attempted.current = true

    /*
     * ⚠ NO `router.refresh()` HERE, AND ITS ABSENCE IS DELIBERATE.
     * `@clerk/nextjs` installs `window.__internal_onAfterSetActive = () =>
     * router.refresh()` and `setActive` awaits it — see the note in
     * apps/auth/app/layout.tsx, which switches that behaviour OFF for the auth
     * origin and says in so many words that the console is the opposite case
     * and must keep it. Calling refresh again here would re-run every server
     * component twice for one change.
     */
    void setActive({ organization: first.organization.id }).catch(() => {
      /*
       * ⚠ SILENT, AND NOT A TOAST. Nobody asked for this to happen; it is the
       * interface catching up with a decision that was made for them at
       * sign-up. A failure means the switcher stays empty and the personal
       * tenant is used, which is what happened before this file existed — a
       * degradation, not an error anybody can act on.
       */
    })
  }, [sessionLoaded, isLoaded, orgId, setActive, userMemberships.data])

  return null
}
