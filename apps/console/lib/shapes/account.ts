import { defineShape } from "@/lib/shapes"
import type { AccountSettings } from "@/lib/clerk-environment"
import type { BillingState } from "@/lib/types"

export interface AccountData {
  settings: AccountSettings
  billing: BillingState | null
  tab?: string
  clerkEnabled: boolean
}

export interface AccountShape {
  /** Active tab: profile or security. */
  tab: "profile" | "security"
  /** Whether the user has an active billing subscription (for deletion warning). */
  billing: boolean
}

export const accountShape = defineShape<AccountShape, AccountData>({
  page: "account",
  fallback: {
    tab: "profile",
    billing: false,
  },
  of: (data) => ({
    tab: data.tab === "security" ? "security" : "profile",
    billing: Boolean(data.billing?.subscription),
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    if (r.tab !== "profile" && r.tab !== "security") return null
    return {
      tab: r.tab,
      billing: r.billing === true,
    }
  },
})
