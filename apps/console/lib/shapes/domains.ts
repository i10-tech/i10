import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import type { DomainSummary, TransferOffer } from "@/lib/types"

/** What the domains page loads. `error` replaces the list, not the page. */
export interface DomainsData {
  domains: DomainSummary[]
  /** Per domain name, the live keys that can ONLY send from it. */
  scopedKeys: Record<string, { id: string; name: string }[]>
  offers: TransferOffer[]
  error?: string
}

export interface DomainsShape {
  /** Rows to draw, capped; 0 is the empty state. */
  rows: number
  /** Transfer offers waiting, capped. */
  transfers: number
  /** More than one status among the domains, so the filter shows. */
  statusFilter: boolean
  /** More than one region, so the filter shows. */
  regionFilter: boolean
}

const MAX_TRANSFERS = 3
const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

export const domainsShape = defineShape<DomainsShape, DomainsData>({
  page: "domains",
  fallback: { rows: 3, transfers: 0, statusFilter: false, regionFilter: false },
  of: ({ domains, offers }) => ({
    rows: Math.min(domains.length, MAX_SKELETON_ROWS),
    transfers: Math.min(offers.length, MAX_TRANSFERS),
    statusFilter: new Set(domains.map(statusOf)).size > 1,
    regionFilter: new Set(domains.map((d) => d.region)).size > 1,
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const rows = count(r.rows, MAX_SKELETON_ROWS)
    const transfers = count(r.transfers, MAX_TRANSFERS)
    if (rows === null || transfers === null) return null
    return {
      rows,
      transfers,
      statusFilter: r.statusFilter === true,
      regionFilter: r.regionFilter === true,
    }
  },
  fromCount: (n) => {
    const rows = count(n, MAX_SKELETON_ROWS)
    if (rows === null) return null
    return {
      rows,
      transfers: 0,
      statusFilter: false,
      regionFilter: false,
    }
  },
  fromCounts: (counts) => {
    const rows = count(counts.domains, MAX_SKELETON_ROWS)
    if (rows === null) return null
    const transfers = count(counts.transfers, MAX_TRANSFERS) ?? 0
    return {
      rows,
      transfers,
      // Distinct statuses, displaced apart (statusOf); absent reads as no filter.
      statusFilter: (counts.domainStatuses ?? 0) > 1,
      regionFilter: false,
    }
  },
})

export const statusOf = (d: DomainSummary) => (d.displaced_at ? "displaced" : d.status)
