import { defineShape } from "@/lib/shapes"
import { broadcastJourney } from "@/lib/journey"
import type { BroadcastDetail, DomainSummary, SegmentRow, TopicRow } from "@/lib/types"

export type BroadcastStatus = "draft" | "scheduled" | "sending" | "sent" | "canceled"

export interface BroadcastData {
  broadcast: BroadcastDetail
  segments: SegmentRow[]
  topics: TopicRow[]
  domains: DomainSummary[]
}

export interface BroadcastShape {
  status: BroadcastStatus
  /** Events in the journey strip: a scheduled time adds one, a cancel ends it early. */
  steps: number
  /** Whether it has a subject, which the hero shows under the name. */
  subject: boolean
}

/** The journey a status usually has, for a seed that knows nothing but the status. */
const STEPS: Record<BroadcastStatus, number> = {
  draft: 3,
  scheduled: 4,
  sending: 3,
  sent: 3,
  canceled: 2,
}

/** What a list row knows about a broadcast, as the shape its page will have. */
export function broadcastSeed(status: BroadcastStatus): BroadcastShape {
  return { status, steps: STEPS[status], subject: true }
}

const VALID_STATUSES: readonly string[] = [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "canceled",
]

export const broadcastShape = defineShape<BroadcastShape, BroadcastData>({
  page: "broadcast",
  fallback: broadcastSeed("draft"),
  of: ({ broadcast }) => ({
    status: broadcast.status as BroadcastStatus,
    steps: broadcastJourney(broadcast).length,
    subject: Boolean(broadcast.subject),
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    if (typeof r.status === "string" && VALID_STATUSES.includes(r.status)) {
      const status = r.status as BroadcastStatus
      const steps =
        typeof r.steps === "number" && Number.isInteger(r.steps) && r.steps >= 1
          ? Math.min(r.steps, 6)
          : STEPS[status]
      // Cookies written before these fields existed read as the status's usual.
      return { status, steps, subject: r.subject !== false }
    }
    return null
  },
})
