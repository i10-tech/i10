import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import type { IdentityEvent } from "@/lib/sso-types"

export interface SecurityAuditData {
  canManage: boolean
  available: boolean
  events: IdentityEvent[]
  user: string | null
  limit: number
  nextLimit: number | null
  clerkEnabled: boolean
  error?: string
}

export interface SecurityAuditShape {
  /** Whether the user can view the audit log. */
  canManage: boolean
  /** Whether the audit log is available on this deployment. */
  available: boolean
  /** Number of event rows to draw while loading. */
  rows: number
  /** Whether the list is filtered by person. */
  filtered: boolean
}

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

export const securityAuditShape = defineShape<SecurityAuditShape, SecurityAuditData>({
  page: "security-audit",
  fallback: {
    canManage: true,
    available: true,
    rows: 5,
    filtered: false,
  },
  of: (data) => ({
    canManage: data.canManage,
    available: data.available,
    rows: Math.min(data.events.length, MAX_SKELETON_ROWS),
    filtered: data.user !== null && data.user !== undefined && data.user !== "",
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const rows = count(r.rows, MAX_SKELETON_ROWS)
    if (rows === null) return null
    return {
      canManage: r.canManage === true,
      available: r.available === true,
      rows,
      filtered: r.filtered === true,
    }
  },
})
