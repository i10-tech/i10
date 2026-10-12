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
 * ⚠ OURS SINCE 2026-10-12, DRAWN OVER CLERK'S DATA. This was Clerk's
 * `<OrganizationProfile />`, kept deliberately - membership, roles and who may
 * invite are Clerk's to answer, and projecting them into our database would
 * put a stale "who is an admin" exactly where authorization reads it. That
 * still holds: the panel (components/team-panel.tsx) reads and writes through
 * Clerk's organization API and checks Clerk's permissions; only the drawing is
 * ours. Clerk's original is at /reference/clerk/organization-profile.
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
