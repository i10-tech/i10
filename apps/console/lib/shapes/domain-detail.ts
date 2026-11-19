import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import type {
  ConnectableProvider,
  DelegationReport,
  DnsConnection,
  DnsInspection,
  Domain,
  DomainSummary,
  TransferOffer,
} from "@/lib/types"
import type { KeyImpact } from "@/components/transfer-domain-dialog"

export interface DomainDetailData {
  domain: Domain
  delegation: DelegationReport | null
  inspection: DnsInspection | null
  connectable: ConnectableProvider | null
  connection: DnsConnection | null
  scopedKeys: { id: string; name: string }[]
  keyImpact: KeyImpact[]
  transfer: TransferOffer | null
  ownEmails: string[]
}

export interface DomainDetailShape {
  status: string
  delegated: boolean
  displaced: boolean
  records: number
  provider: boolean
  connectable: boolean
  delegation: boolean
  keys: number
  /** The customer said the records are published: the "waiting" notice reads differently. */
  added: boolean
}

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

export const domainDetailShape = defineShape<DomainDetailShape, DomainDetailData>({
  page: "domain-detail",
  fallback: {
    status: "pending",
    delegated: false,
    displaced: false,
    records: 4,
    provider: false,
    connectable: false,
    delegation: false,
    keys: 0,
    added: false,
  },
  of: ({ domain, delegation, inspection, connectable, keyImpact }) => ({
    status: domain.status,
    delegated: domain.delegated,
    displaced: Boolean(domain.displaced_at),
    records: Math.min(domain.records.length, MAX_SKELETON_ROWS),
    provider: Boolean(inspection?.provider),
    connectable: Boolean(connectable),
    delegation: Boolean(delegation),
    keys: Math.min(keyImpact.length, MAX_SKELETON_ROWS),
    added: Boolean(domain.records_added_at),
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    if (typeof r.status !== "string") return null
    if (typeof r.delegated !== "boolean") return null
    if (typeof r.displaced !== "boolean") return null
    const records = count(r.records, MAX_SKELETON_ROWS)
    if (records === null) return null
    if (typeof r.provider !== "boolean") return null
    if (typeof r.connectable !== "boolean") return null
    if (typeof r.delegation !== "boolean") return null
    const keys = count(r.keys, MAX_SKELETON_ROWS)
    if (keys === null) return null
    return {
      status: r.status,
      delegated: r.delegated,
      displaced: r.displaced,
      records,
      provider: r.provider,
      connectable: r.connectable,
      delegation: r.delegation,
      keys,
      // Cookies written before this field existed read as "not added".
      added: r.added === true,
    }
  },
})

/**
 * Plausible shape stashed before navigating from a domain list row to its record page.
 */
export function seedDomainShape(d: DomainSummary): DomainDetailShape {
  return {
    status: d.status,
    delegated: d.delegated,
    displaced: Boolean(d.displaced_at),
    records: d.delegated ? 6 : 4,
    provider: false,
    connectable: false,
    delegation: false,
    keys: 0,
    added: false,
  }
}
