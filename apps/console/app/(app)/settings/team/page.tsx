import type { Metadata } from "next"
import { TeamView } from "@/components/team-view"
import type { TeamData } from "@/lib/shapes/team"

export const metadata: Metadata = { title: "Team" }

/**
 * Members, roles and invitations.
 *
 * ⚠ OURS SINCE 2026-10-12, DRAWN OVER CLERK'S MEMBERSHIPS. This was Clerk's
 * `<OrganizationProfile />`. Who is in is still Clerk's answer; since #335
 * roles and who may invite are OURS - Clerk gives every member the same
 * powerless role, because a Clerk admin could change memberships around
 * every check we make - and the panel (components/team-panel.tsx) reads them
 * from our API, which is where every change goes. Clerk's original is at
 * /reference/clerk/organization-profile.
 */
export default async function TeamSettingsPage() {
  const clerkEnabled = Boolean(process.env.CLERK_PUBLISHABLE_KEY)
  const data: TeamData = { clerkEnabled }

  return <TeamView data={data} />
}
