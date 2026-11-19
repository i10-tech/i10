import type { Metadata } from "next"
import { SecurityView } from "@/components/security-view"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { securityShape, type SecurityData } from "@/lib/shapes/security"
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

  if (!who.abilities.manage) {
    const unauthorizedData: SecurityData = {
      abilities: who.abilities,
      available: true,
    }
    return (
      <SecurityView
        shape={securityShape.of(unauthorizedData)}
        data={unauthorizedData}
      />
    )
  }

  const [session, secondFactor, siem, exemption, allowlist] = await Promise.all([
    tryApi<SessionPolicy>("/console/identity/session-policy"),
    tryApi<{ required: boolean }>("/console/identity/second-factor-policy"),
    tryApi<SiemSettingsAnswer>("/console/identity/siem"),
    tryApi<OwnerExemption>("/console/identity/owner-exemption"),
    tryApi<IpAllowlist>("/console/identity/ip-allowlist"),
  ])

  if (!session.ok && session.error.statusCode === 501) {
    const unavailableData: SecurityData = {
      abilities: who.abilities,
      available: false,
    }
    return (
      <SecurityView shape={securityShape.of(unavailableData)} data={unavailableData} />
    )
  }

  const data: SecurityData = {
    abilities: who.abilities,
    available: true,
    session: session.ok ? session.data : undefined,
    secondFactor: secondFactor.ok ? secondFactor.data : undefined,
    siem: siem.ok ? siem.data : undefined,
    exemption: exemption.ok ? exemption.data : undefined,
    allowlist: allowlist.ok ? allowlist.data : undefined,
  }

  return <SecurityView shape={securityShape.of(data)} data={data} />
}
