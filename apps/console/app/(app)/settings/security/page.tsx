import type { Metadata } from "next"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { PanelError } from "@/components/panel-error"
import { ConnectionsPanel } from "@/components/sso/connections-panel"
import { DirectoriesPanel } from "@/components/sso/directories-panel"
import { OwnerExemptionPanel } from "@/components/sso/owner-exemption"
import { tryApi } from "@/lib/api"
import { ssoAbilities } from "@/lib/sso-server"
import type { SsoConnections } from "@/lib/sso-types"

export const metadata: Metadata = { title: "Security" }

/**
 * Single sign-on for the workspace (#340): the connections, the owner
 * exemption, and the directories that keep members in step.
 *
 * ⚠ AN ADMIN'S PAGE. A member gets the API's 403 as a sentence, not a broken
 * panel; the API checks `sso:manage` on every route this page reads.
 */
export default async function SecuritySettingsPage() {
  const who = await ssoAbilities()
  if (!who.ok)
    return <PanelError title="Could not load your workspace" message={who.message} />
  if (!who.abilities.manage)
    return (
      <Section className="pt-0">
        <SectionTitle>Single sign-on</SectionTitle>
        <SectionDescription>
          Only a workspace admin or owner can see and change SSO settings. Ask one of
          them if your company wants to sign in through its identity provider.
        </SectionDescription>
      </Section>
    )

  const connections = await tryApi<SsoConnections>("/console/identity/connections")
  if (!connections.ok && connections.error.statusCode === 501)
    return (
      <Section className="pt-0">
        <SectionTitle>Single sign-on</SectionTitle>
        <SectionDescription>
          Single sign-on is not available on this deployment.
        </SectionDescription>
      </Section>
    )

  return (
    <div>
      <Section className="pt-0">
        <SectionTitle>Single sign-on</SectionTitle>
        <SectionDescription>
          Let your team sign in with your company&rsquo;s identity provider: Okta,
          Microsoft Entra, Google Workspace, or any OpenID Connect or SAML provider.
        </SectionDescription>
        <SectionContent>
          <ConnectionsPanel
            initial={connections.ok ? connections.data : null}
            abilities={who.abilities}
          />
        </SectionContent>
      </Section>

      <Section>
        <SectionTitle>Owner exemption</SectionTitle>
        <SectionDescription>
          Keeps your owners and admins able to sign in, and fix things, if your identity
          provider is down.
        </SectionDescription>
        <SectionContent>
          <OwnerExemptionPanel abilities={who.abilities} />
        </SectionContent>
      </Section>

      <Section>
        <SectionTitle>Directories</SectionTitle>
        <SectionDescription>
          Keep members in step with your company&rsquo;s directory with SCIM, or pull
          them from Google Workspace.
        </SectionDescription>
        <SectionContent>
          <DirectoriesPanel abilities={who.abilities} />
        </SectionContent>
      </Section>
    </div>
  )
}
