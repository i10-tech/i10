import type { Metadata } from "next"
import Link from "next/link"
import { ChevronRight } from "lucide-react"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { PanelError } from "@/components/panel-error"
import { SettingsGroup, SettingsRow } from "@/components/sso/settings-card"
import { IpAllowlistPanel } from "@/components/sso/ip-allowlist"
import { OwnerExemptionPanel } from "@/components/sso/owner-exemption"
import { SiemExportPanel } from "@/components/sso/siem-export"
import {
  SecondFactorPanel,
  SessionPolicyPanel,
} from "@/components/sso/workspace-policy"
import { tryApi } from "@/lib/api"
import { ssoAbilities } from "@/lib/sso-server"
import type {
  IpAllowlist,
  OwnerExemption,
  SessionPolicy,
  SiemSettingsAnswer,
} from "@/lib/sso-types"

export const metadata: Metadata = { title: "Security" }

/**
 * Workspace security policies: sessions, second factor, IP allowlist,
 * owner exemption, SIEM export, and the identity audit log.
 */
export default async function SecuritySettingsPage() {
  const who = await ssoAbilities()
  if (!who.ok)
    return <PanelError title="Could not load your workspace" message={who.message} />
  if (!who.abilities.manage)
    return (
      <Section className="pt-0">
        <SectionTitle>Security</SectionTitle>
        <SectionDescription>
          Only a workspace admin or owner can see and change security settings. Ask one
          of them to change session limits, second-factor rules, or allowlists.
        </SectionDescription>
      </Section>
    )

  const [session, secondFactor, siem, exemption, allowlist] = await Promise.all([
    tryApi<SessionPolicy>("/console/identity/session-policy"),
    tryApi<{ required: boolean }>("/console/identity/second-factor-policy"),
    tryApi<SiemSettingsAnswer>("/console/identity/siem"),
    tryApi<OwnerExemption>("/console/identity/owner-exemption"),
    tryApi<IpAllowlist>("/console/identity/ip-allowlist"),
  ])
  if (!session.ok && session.error.statusCode === 501)
    return (
      <Section className="pt-0">
        <SectionTitle>Security</SectionTitle>
        <SectionDescription>
          Security settings are not available on this deployment.
        </SectionDescription>
      </Section>
    )

  return (
    <div>
      <Section className="pt-0">
        <SectionTitle>Security policies</SectionTitle>
        <SectionDescription>
          Session limits, second factor, and security logging for this workspace.
        </SectionDescription>
        <SectionContent>
          <SettingsGroup>
            <SessionPolicyPanel
              abilities={who.abilities}
              initial={session.ok ? session.data : undefined}
            />
            <SecondFactorPanel
              abilities={who.abilities}
              initial={secondFactor.ok ? secondFactor.data : undefined}
            />
            <SiemExportPanel
              abilities={who.abilities}
              initial={siem.ok ? siem.data : undefined}
            />
            <SettingsRow
              title="Identity audit log"
              description="Every change to sign-in settings, sessions and directories, with who made it."
              action={
                <Link
                  href="/settings/security/audit"
                  className="flex items-center gap-1 text-sm font-medium hover:underline"
                >
                  Open log
                  <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                </Link>
              }
            />
          </SettingsGroup>
        </SectionContent>
      </Section>

      <Section>
        <SectionTitle>Lockout protection</SectionTitle>
        <SectionDescription>
          Who can still reach this workspace, and from where.
        </SectionDescription>
        <SectionContent>
          <SettingsGroup>
            <OwnerExemptionPanel
              abilities={who.abilities}
              initial={exemption.ok ? exemption.data : undefined}
            />
            <IpAllowlistPanel
              abilities={who.abilities}
              initial={allowlist.ok ? allowlist.data : undefined}
            />
          </SettingsGroup>
        </SectionContent>
      </Section>
    </div>
  )
}
