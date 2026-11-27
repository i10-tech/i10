import { defineShape } from "@/lib/shapes"
import type {
  AutoForwardingSettings,
  IpAllowlist,
  OwnerExemption,
  SessionPolicy,
  SiemSettingsAnswer,
  SsoAbilities,
} from "@/lib/sso-types"

export interface SecurityData {
  abilities: SsoAbilities
  available: boolean
  session?: SessionPolicy
  secondFactor?: { required: boolean }
  siem?: SiemSettingsAnswer
  exemption?: OwnerExemption
  allowlist?: IpAllowlist
  autoForwarding?: AutoForwardingSettings
  error?: string
}

export interface SecurityShape {
  /** Whether the user can view and manage security policies. */
  canManage: boolean
  /** Whether security policies are supported on this deployment (not 501). */
  available: boolean
}

export const securityShape = defineShape<SecurityShape, SecurityData>({
  page: "security",
  fallback: {
    canManage: true,
    available: true,
  },
  of: (data) => ({
    canManage: data.abilities.manage,
    available: data.available,
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    return {
      canManage: r.canManage === true,
      available: r.available === true,
    }
  },
})
