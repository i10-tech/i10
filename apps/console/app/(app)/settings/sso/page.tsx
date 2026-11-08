import type { Metadata } from "next"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { DirectoriesPanel } from "@/components/sso/directories-panel"
import { PanelError } from "@/components/panel-error"
import { SsoHome } from "@/components/sso/sso-home"
import { tryApi } from "@/lib/api"
import { ssoAbilities } from "@/lib/sso-server"
import type { SsoConnections, SsoDirectories } from "@/lib/sso-types"

export const metadata: Metadata = { title: "Single sign-on" }

export default async function SingleSignOnPage() {
  const who = await ssoAbilities()
  if (!who.ok)
    return <PanelError title="Could not load your workspace" message={who.message} />
  if (!who.abilities.manage)
    return (
      <Section className="pt-0">
        <SectionDescription>
          Only a workspace admin or owner can set this up. Ask one of them if your
          company wants to sign in through its identity provider.
        </SectionDescription>
      </Section>
    )

  const [catalog, directories] = await Promise.all([
    tryApi<SsoConnections>("/console/identity/connections"),
    tryApi<SsoDirectories>("/console/identity/directories"),
  ])
  if (!catalog.ok && catalog.error.statusCode === 501)
    return (
      <Section className="pt-0">
        <SectionDescription>
          Single sign-on is not available on this deployment.
        </SectionDescription>
      </Section>
    )
  if (!catalog.ok)
    return (
      <PanelError
        title="Could not load your connections"
        message={catalog.error.message}
      />
    )

  return (
    <div>
      <Section className="pt-0">
        <SectionTitle>Connections</SectionTitle>
        <SectionContent>
          <SsoHome catalog={catalog.data} abilities={who.abilities} />
        </SectionContent>
      </Section>
      <Section>
        <SectionTitle>Directories</SectionTitle>
        <SectionDescription>
          Add and remove people automatically when your company&rsquo;s directory
          changes.
        </SectionDescription>
        <SectionContent>
          <DirectoriesPanel
            abilities={who.abilities}
            initial={directories.ok ? directories.data : undefined}
          />
        </SectionContent>
      </Section>
    </div>
  )
}
