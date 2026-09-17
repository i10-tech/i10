import type { Metadata } from "next"
import { UserProfile } from "@clerk/nextjs"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/page"

export const metadata: Metadata = { title: "Profile" }

/**
 * Your own account: name, email, password, MFA, passkeys and active sessions.
 *
 * ⚠ ALL OF IT IS CLERK'S, AND THAT IS THE CORRECT DIVISION. Identity is Clerk's
 * job in this product — the API verifies Clerk sessions and `authd` delegates
 * LDAP binds to Clerk. Building our own password form would mean a second place
 * credentials are handled, which is one more place to get wrong than zero.
 *
 * ⚠ AND IT IS PER-PERSON, NOT PER-WORKSPACE. Somebody in three workspaces has
 * one account and one password; this page does not change when they switch
 * organization, which is why it sits under Account rather than under Settings.
 */
export default function AccountPage() {
  // See settings/team: Clerk's components need their provider, and the provider
  // is only mounted when a publishable key exists.
  if (!process.env.CLERK_PUBLISHABLE_KEY) {
    return (
      <div>
        <Section className="pt-0">
          <SectionTitle>Your account</SectionTitle>
          <SectionDescription>
            Your profile, password, two-factor authentication and active sessions
            are managed by Clerk, which is not configured in this environment. Set{" "}
            <code>CLERK_PUBLISHABLE_KEY</code> to see the real panel here.
          </SectionDescription>
        </Section>
      </div>
    )
  }

  return (
    <div>
      <Section className="pt-0">
        <SectionTitle>Your account</SectionTitle>
        <SectionDescription>
          Your name, sign-in methods, two-factor authentication and the devices
          you are signed in on. This is your account across every workspace you
          belong to.
        </SectionDescription>
        <SectionContent>
          <UserProfile
            routing="hash"
            appearance={{
              elements: {
                rootBox: "w-full",
                cardBox: "w-full max-w-none shadow-none border-0",
                card: "w-full max-w-none shadow-none border-0 bg-transparent p-0",
                pageScrollBox: "p-0",
              },
            }}
          />
        </SectionContent>
      </Section>
    </div>
  )
}
