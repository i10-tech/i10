import type { Metadata } from "next"
import Link from "next/link"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { PanelError } from "@/components/panel-error"
import { ConnectionsPanel } from "@/components/sso/connections-panel"
import { DirectoriesPanel } from "@/components/sso/directories-panel"
import { DeprovisionedKeysPanel } from "@/components/sso/deprovisioned-keys"
import { IpAllowlistPanel } from "@/components/sso/ip-allowlist"
import { MailboxesPanel } from "@/components/sso/mailboxes-panel"
import { SiemExportPanel } from "@/components/sso/siem-export"
import { OwnerExemptionPanel } from "@/components/sso/owner-exemption"
import {
  SecondFactorPanel,
  SessionPolicyPanel,
} from "@/components/sso/workspace-policy"
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

      <Section>
        <SectionTitle>Mailboxes</SectionTitle>
        <SectionDescription>
          What happens to a person&rsquo;s mailbox when your directory switches them
          off, and the mailboxes your directories gave.
        </SectionDescription>
        <SectionContent>
          <MailboxesPanel
            abilities={who.abilities}
            clerkEnabled={Boolean(process.env.CLERK_PUBLISHABLE_KEY)}
          />
        </SectionContent>
      </Section>

      <Section>
        <SectionTitle>Session policy</SectionTitle>
        <SectionDescription>
          How long anyone can stay signed in to this workspace, and how long they can
          sit idle.
        </SectionDescription>
        <SectionContent>
          <SessionPolicyPanel abilities={who.abilities} />
        </SectionContent>
      </Section>

      <Section>
        <SectionTitle>Second factor</SectionTitle>
        <SectionDescription>
          Require a second step at sign-in from members who do not use SSO.
        </SectionDescription>
        <SectionContent>
          <SecondFactorPanel abilities={who.abilities} />
        </SectionContent>
      </Section>

      <Section>
        <SectionTitle>IP allowlist</SectionTitle>
        <SectionDescription>
          Limit the console and API keys to the networks you list.
        </SectionDescription>
        <SectionContent>
          <IpAllowlistPanel abilities={who.abilities} />
        </SectionContent>
      </Section>

      <Section>
        <SectionTitle>Removed people&rsquo;s API keys</SectionTitle>
        <SectionDescription>
          Keys that people your directory removed created. Nothing is revoked for you,
          since an integration may still depend on one.
        </SectionDescription>
        <SectionContent>
          <DeprovisionedKeysPanel
            abilities={who.abilities}
            clerkEnabled={Boolean(process.env.CLERK_PUBLISHABLE_KEY)}
          />
        </SectionContent>
      </Section>

      <Section>
        <SectionTitle>SIEM export</SectionTitle>
        <SectionDescription>
          Send the identity audit log to a bucket of your own so your security tools can
          read it.
        </SectionDescription>
        <SectionContent>
          <SiemExportPanel abilities={who.abilities} />
        </SectionContent>
      </Section>

      <Section>
        <SectionTitle>Audit log</SectionTitle>
        <SectionDescription>
          Every change to sign-in settings, sessions and directories, with who made it.
        </SectionDescription>
        <SectionContent>
          <Link
            href="/settings/security/audit"
            className="text-sm underline underline-offset-2"
          >
            Open the identity audit log
          </Link>
        </SectionContent>
      </Section>
    </div>
  )
}
