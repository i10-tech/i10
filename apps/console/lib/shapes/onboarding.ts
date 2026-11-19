import { defineShape } from "@/lib/shapes"
import type {
  BillingState,
  Domain,
  DomainSummary,
  Me,
  PlanSummary,
  TenantProfile,
  TransferOffer,
} from "@/lib/types"

export interface OnboardingData {
  me: Me | null
  tenantOf: TenantProfile | null
  billing: BillingState
  domains: DomainSummary[]
  focus: Domain | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  domainDraft: any
  offers: TransferOffer[]
  userEmail: string | null
  firstName: string | null
  plans: PlanSummary[]
  checkoutId: string | null
  resumeStep: string
  justPublished: number
  creating: boolean
  noWorkspace: boolean
  clerkOn: boolean
}

export interface OnboardingShape {
  /** The onboarding step to display. */
  step: string
  /** Whether the workspace is being created fresh. */
  creating: boolean
  /** Whether a focus domain exists for verify and send steps. */
  focus: boolean
}

export const onboardingShape = defineShape<OnboardingShape, OnboardingData>({
  page: "onboarding",
  fallback: {
    step: "workspace",
    creating: false,
    focus: false,
  },
  of: (data) => ({
    step: data.resumeStep || "workspace",
    creating: data.creating,
    focus: data.focus !== null,
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    if (typeof r.step !== "string") return null
    return {
      step: r.step,
      creating: r.creating === true,
      focus: r.focus === true,
    }
  },
})
