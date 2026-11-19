import { defineShape } from "@/lib/shapes"
import type { BillingState, FeatureUsage, SendingLimit } from "@/lib/types"

export interface UsageData {
  usage: FeatureUsage[]
  limits: SendingLimit[]
  billing: BillingState
  members: {
    members: number
    invitations: number
    limit: number
    free: number
  } | null
  error?: string
}

/** What a workspace feature draws: the meter block, one line, or a line and a note. */
export type FeatureKind = "meter" | "line" | "note"

export interface UsageShape {
  /** How many sending limit rows to draw, capped. */
  limits: number
  /** Whether the workspace has a members meter. */
  members: boolean
  /** One entry per workspace feature row to draw, capped; its layout decides its height. */
  featureKinds: FeatureKind[]
}

/**
 * A feature row's layout, as FeatureRow in components/usage-view.tsx branches.
 *
 * ⚠ THE SAME BRANCHES AS FeatureRow, IN THE SAME ORDER. An unreadable or
 * unentitled feature is a line and a note; no allowance, or a zero one, is a
 * single line; anything else is the meter.
 */
export function featureKind(f: FeatureUsage): FeatureKind {
  if (f.status === "unreadable" || f.status === "unentitled") return "note"
  if (f.allowance === 0 || f.allowance === null) return "line"
  return "meter"
}

/**
 * ⚠ THE MEASURED HEIGHT OF EACH LAYOUT (2026-11-09), at the page's 672px column.
 * A flat 44px per row drew a 193px meter 149px short; the page jumped by the
 * difference when the data arrived.
 */
export const FEATURE_PX: Record<FeatureKind, number> = {
  meter: 193,
  line: 20,
  note: 40,
}

const MAX_LIMITS = 5
const MAX_FEATURES = 10
const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

// What a workspace most often has: the sending domains meter, then the mailbox
// features as single lines. Only a remembered shape knows better.
const GUESS: FeatureKind[] = ["meter", "line", "line", "line"]

const isKind = (v: unknown): v is FeatureKind =>
  v === "meter" || v === "line" || v === "note"

export const usageShape = defineShape<UsageShape, UsageData>({
  page: "usage",
  fallback: {
    limits: 2,
    members: true,
    featureKinds: GUESS,
  },
  of: (data) => ({
    limits: Math.min(data.limits.length, MAX_LIMITS),
    // ⚠ `!= null`, NOT `!== null`: the view reads `members ?? null`, so an
    // absent key draws no meter, and the shape must not promise one.
    members: data.members != null,
    featureKinds: data.usage
      .filter((f) => f.feature_id !== "emails")
      .slice(0, MAX_FEATURES)
      .map(featureKind),
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const limits = count(r.limits, MAX_LIMITS)
    if (limits === null) return null
    let featureKinds: FeatureKind[]
    if (Array.isArray(r.featureKinds)) {
      if (r.featureKinds.length > MAX_FEATURES || !r.featureKinds.every(isKind))
        return null
      featureKinds = r.featureKinds
    } else {
      // A shape remembered before layouts were kept holds only a count.
      const features = count(r.features, MAX_FEATURES)
      if (features === null) return null
      featureKinds = Array.from({ length: features }, (_, i) => GUESS[i] ?? "line")
    }
    return {
      limits,
      members: r.members === true,
      featureKinds,
    }
  },
})
