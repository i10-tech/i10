"use client"

import { CreateOrganization, OrganizationProfile, useOrganization } from "@clerk/nextjs"
import { CLERK_PANEL } from "@repo/ui/clerk"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"

/**
 * Clerk's `<OrganizationProfile />` - general settings, members, invitations,
 * roles and "Delete organization" - and `<CreateOrganization />` for a
 * personal account, as the Team page rendered them. See ../layout.tsx.
 */
export default function ClerkOrganizationProfileReference() {
  const { isLoaded, organization } = useOrganization()
  return (
    <Section className="pt-0">
      <SectionTitle>Clerk reference: OrganizationProfile</SectionTitle>
      <SectionDescription>
        Clerk&apos;s team panel, unchanged - for comparing ours against it. Actions here
        are real.
      </SectionDescription>
      <SectionContent>
        {!isLoaded ? null : organization ? (
          <OrganizationProfile routing="hash" appearance={{ elements: CLERK_PANEL }} />
        ) : (
          <CreateOrganization
            skipInvitationScreen={false}
            afterCreateOrganizationUrl="/reference/clerk/organization-profile"
            appearance={{ elements: CLERK_PANEL }}
          />
        )}
      </SectionContent>
    </Section>
  )
}
