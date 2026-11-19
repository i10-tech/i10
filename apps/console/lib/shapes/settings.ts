import { defineShape } from "@/lib/shapes"
import type { BillingState, Me, TenantProfile } from "@/lib/types"

export interface SettingsData {
  tenant: TenantProfile | null
  billing: BillingState | null
  access: Me["access"]
  clerkEnabled: boolean
  error?: string
}

export interface SettingsShape {
  /** "workspace" when Clerk is active (avatar/profile blocks); "general" for the no-Clerk fallback sections. */
  variant: "general" | "workspace"
}

export const settingsShape = defineShape<SettingsShape, SettingsData>({
  page: "settings",
  fallback: { variant: "workspace" },
  of: (data) => ({
    variant: data.clerkEnabled ? "workspace" : "general",
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    if (r.variant !== "general" && r.variant !== "workspace") return null
    return { variant: r.variant }
  },
})
