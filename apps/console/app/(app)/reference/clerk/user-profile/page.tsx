import { UserProfile } from "@clerk/nextjs"
import { CLERK_PANEL } from "@repo/ui/clerk"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"

/**
 * Clerk's `<UserProfile />`, as /account rendered it before it became ours -
 * profile, email addresses, connected accounts, password, passkeys,
 * two-factor, active devices and "Delete account". See ../layout.tsx.
 */
export default function ClerkUserProfileReference() {
  return (
    <Section className="pt-0">
      <SectionTitle>Clerk reference: UserProfile</SectionTitle>
      <SectionDescription>
        Clerk&apos;s account panel, unchanged - for comparing ours against it. Actions
        here are real.
      </SectionDescription>
      <SectionContent>
        <UserProfile routing="hash" appearance={{ elements: CLERK_PANEL }} />
      </SectionContent>
    </Section>
  )
}
