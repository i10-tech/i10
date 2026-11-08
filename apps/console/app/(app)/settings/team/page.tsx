import type { Metadata } from "next"
import { TeamPanel } from "@/components/team-panel"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"

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
  /*
   * ⚠ CLERK'S HOOKS THROW OUTSIDE A PROVIDER, AND THE PROVIDER IS ONLY
   * MOUNTED WHEN A KEY EXISTS - see app/layout.tsx. This branch is for local
   * review with no identity provider running; every real deployment takes the
   * other one.
   */
  if (!process.env.CLERK_PUBLISHABLE_KEY) {
    return (
      <div>
        <Section className="pt-0">
          <SectionTitle>Members</SectionTitle>
          <SectionDescription>
            Membership, roles and invitations live in Clerk, which is not configured in
            this environment. Set <code>CLERK_PUBLISHABLE_KEY</code> to see the real
            panel here.
          </SectionDescription>
        </Section>
      </div>
    )
  }

  return (
    <div>
      <Section className="pt-0">
        <SectionTitle>Members</SectionTitle>
        <SectionDescription>
          Everyone here shares this workspace: its domains, its keys, its contacts and
          its bill. Invitations are sent by email.
        </SectionDescription>
        <SectionContent>
          <TeamPanel />
        </SectionContent>
      </Section>
    </div>
  )
}
