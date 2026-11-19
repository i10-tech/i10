import { defineShape } from "@/lib/shapes"
import type { RestoredDraft } from "@/components/add-domain-form"

export interface NewDomainData {
  tenantId: string
  restored: RestoredDraft | null
}

export type AddDomainStepName = "domain" | "records" | "publish"

export interface NewDomainShape {
  restored: boolean
  step: AddDomainStepName
}

export const newDomainShape = defineShape<NewDomainShape, NewDomainData>({
  page: "domains-new",
  fallback: {
    restored: false,
    step: "domain",
  },
  of: ({ restored }) => ({
    restored: restored !== null,
    step: (restored?.step as AddDomainStepName) ?? "domain",
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    if (typeof r.restored !== "boolean") return null
    const step = r.step
    if (step !== "domain" && step !== "records" && step !== "publish") return null
    return {
      restored: r.restored,
      step,
    }
  },
})
