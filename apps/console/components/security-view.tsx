"use client"

import * as React from "react"
import Link from "next/link"
import { ChevronRight } from "lucide-react"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { BoneScope } from "@repo/ui/components/bone/bone"
import { PanelError } from "@/components/panel-error"
import { SettingsGroup, SettingsRow } from "@/components/sso/settings-card"
import { AutoForwardingPanel } from "@/components/sso/auto-forwarding"
import { IpAllowlistPanel } from "@/components/sso/ip-allowlist"
import { OwnerExemptionPanel } from "@/components/sso/owner-exemption"
import { SiemExportPanel } from "@/components/sso/siem-export"
import {
  SecondFactorPanel,
  SessionPolicyPanel,
} from "@/components/sso/workspace-policy"
import { RememberShape, useRememberedShape } from "@/components/list/remembered-shapes"
import {
  securityShape,
  type SecurityData,
  type SecurityShape,
} from "@/lib/shapes/security"
import type { SsoAbilities } from "@/lib/sso-types"

const DEFAULT_ABILITIES: SsoAbilities = {
  manage: true,
  owner: true,
  userId: null,
}

export function SecurityLoading() {
  return <SecurityView shape={useRememberedShape(securityShape)} />
}

export function SecurityView({
  shape,
  data,
}: {
  shape: SecurityShape
  data?: SecurityData
}) {
  const loading = data === undefined
  const abilities = data?.abilities ?? DEFAULT_ABILITIES

  return (
    <BoneScope id="security" loading={loading}>
      {data?.error !== undefined ? (
        <PanelError title="Could not load your workspace" message={data.error} />
      ) : !shape.canManage ? (
        <Section className="pt-0">
          <SectionDescription>
            Only a workspace admin or owner can see and change security settings. Ask
            one of them to change session limits, second-factor rules, or allowlists.
          </SectionDescription>
        </Section>
      ) : !shape.available ? (
        <Section className="pt-0">
          <SectionDescription>
            Security settings are not available on this deployment.
          </SectionDescription>
        </Section>
      ) : (
        <div>
          <Section className="pt-0">
            <SectionTitle>Security policies</SectionTitle>
            <SectionDescription>
              Session limits, second factor, and security logging for this workspace.
            </SectionDescription>
            <SectionContent>
              <SettingsGroup>
                <SessionPolicyPanel abilities={abilities} initial={data?.session} />
                <SecondFactorPanel abilities={abilities} initial={data?.secondFactor} />
                <SiemExportPanel abilities={abilities} initial={data?.siem} />
                <SettingsRow
                  title="Identity audit log"
                  description="Every change to sign-in settings, sessions and directories, with who made it."
                  action={
                    <Link
                      href="/settings/security/audit"
                      className="flex items-center gap-1 text-sm font-medium hover:underline"
                    >
                      Open log
                      <ChevronRight
                        className="size-4 text-muted-foreground"
                        aria-hidden
                      />
                    </Link>
                  }
                />
              </SettingsGroup>
            </SectionContent>
          </Section>

          <Section>
            <SectionTitle>Automatic forwarding</SectionTitle>
            <SectionDescription>
              Control where mail rules and Sieve scripts can automatically forward
              incoming mail.
            </SectionDescription>
            <SectionContent>
              <SettingsGroup>
                <AutoForwardingPanel initial={data?.autoForwarding} />
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
                <OwnerExemptionPanel abilities={abilities} initial={data?.exemption} />
                <IpAllowlistPanel abilities={abilities} initial={data?.allowlist} />
              </SettingsGroup>
            </SectionContent>
          </Section>
        </div>
      )}
      {data && data.error === undefined && (
        <RememberShape def={securityShape} shape={shape} />
      )}
    </BoneScope>
  )
}
