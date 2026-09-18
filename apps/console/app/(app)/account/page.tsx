import type { Metadata } from "next"
import { UserProfile } from "@clerk/nextjs"
import { CLERK_PANEL } from "@repo/ui/clerk"
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
            Your profile, password, two-factor authentication and active sessions are
            managed by Clerk, which is not configured in this environment. Set{" "}
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
          Your name, sign-in methods, two-factor authentication and the devices you are
          signed in on. This is your account across every workspace you belong to.
        </SectionDescription>
        <SectionContent>
          {/*
           * ⚠ ONLY THE CHROME IS OVERRIDDEN HERE; THE COLOURS COME FROM THE
           * PROVIDER. This used to carry its own copy of the card overrides,
           * which is how four call sites ended up with four slightly different
           * ideas of what "remove Clerk's card" means. See @repo/ui/clerk.
           */}
          <UserProfile routing="hash" appearance={{ elements: CLERK_PANEL }} />
        </SectionContent>
      </Section>
    </div>
  )
}
