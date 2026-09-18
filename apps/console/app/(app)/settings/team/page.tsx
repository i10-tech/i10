import type { Metadata } from "next"
import { TeamPanel } from "@/components/team-panel"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/page"

export const metadata: Metadata = { title: "Team" }

/**
 * Members, roles and invitations.
 *
 * ⚠ THIS IS CLERK'S COMPONENT, NOT OURS, AND REBUILDING IT WOULD BE A MISTAKE
 * WITH A SCHEDULE. Membership, roles, invitations and who may invite are
 * Clerk's to answer; reimplementing them means projecting membership into our
 * database and keeping it fresh, and the one place a stale copy of "who is an
 * admin" matters is authorization. What we own is the tenant the organization
 * maps to — see console/tenant.ts.
 *
 * ⚠ AND `routing="hash"` IS WHAT LETS IT LIVE AT A FIXED PATH. Clerk's default
 * is path-based routing, which expects to own every segment below it and
 * renders nothing at all if the catch-all route is missing — a blank page with
 * no error. Hash routing keeps its internal navigation in the fragment, so this
 * page is a single route.
 *
 * ⚠ THE PANEL IS A CLIENT COMPONENT BECAUSE IT HAS TO ASK WHETHER AN
 * ORGANIZATION IS ACTIVE. Clerk's component renders NOTHING for a personal
 * account, which left this page as a heading over empty space — see
 * components/team-panel.tsx.
 */
export default function TeamSettingsPage() {
  /*
   * ⚠ CLERK'S COMPONENT THROWS OUTSIDE A PROVIDER, AND THE PROVIDER IS ONLY
   * MOUNTED WHEN A KEY EXISTS — see app/layout.tsx. This branch is for local
   * review with no identity provider running; every real deployment takes the
   * other one.
   */
  if (!process.env.CLERK_PUBLISHABLE_KEY) {
    return (
      <div>
        <Section className="pt-0">
          <SectionTitle>Members</SectionTitle>
          <SectionDescription>
            Membership, roles and invitations are managed by Clerk, which is not
            configured in this environment. Set <code>CLERK_PUBLISHABLE_KEY</code> to
            see the real panel here.
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
