/**
 * SES tenant sending-status events, as EventBridge delivers them (#157).
 *
 * ⚠ THEY ARRIVE ON THE SAME SNS TOPIC AS DELIVERY EVENTS, AND LOOK NOTHING LIKE
 * THEM. An EventBridge rule on the default bus forwards SES's `Sending Status
 * Enabled` / `Sending Status Disabled` events to `i10-ses-events`, so they reach
 * the same signature-verified endpoint - but the payload is an EventBridge
 * envelope (`source`, `detail-type`, `resources`, `detail`), not an SES event
 * publishing record. This is the one place that tells them apart.
 *
 * Shape, from docs.aws.amazon.com/ses/latest/dg/tenants.html:
 *
 *   { "source": "aws.ses", "detail-type": "Sending Status Disabled",
 *     "resources": ["arn:aws:ses:<region>:<account>:tenant/<name>/<id>"],
 *     "detail": { "data": { "origin": "CUSTOMER_MANAGED",
 *       "record": { "status": "DISABLED", "cause": "...",
 *                   "lastUpdatedTimestamp": [2025, 7, 24, 12, 44, 28, 995000000] } } } }
 */

export type SesSendingStatus = "enabled" | "disabled" | "reinstated"

export interface TenantStatusEvent {
  /** The SES tenant's name, from the ARN in `resources`. */
  sesTenant: string
  status: SesSendingStatus
  cause: string | null
  /** `aws_managed` or `customer_managed`. */
  origin: string | null
  changedAt: Date
}

const STATUSES: Readonly<Record<string, SesSendingStatus>> = {
  ENABLED: "enabled",
  DISABLED: "disabled",
  REINSTATED: "reinstated",
}

export const toSendingStatus = (value: string | undefined): SesSendingStatus | null =>
  (value && STATUSES[value.toUpperCase()]) || null

/** Whether a parsed SNS payload is an EventBridge event from SES at all. */
export function isSesEventBridgeEvent(
  payload: unknown,
): payload is Record<string, unknown> {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as Record<string, unknown>).source === "aws.ses" &&
    typeof (payload as Record<string, unknown>)["detail-type"] === "string"
  )
}

/**
 * ⚠ SES WRITES THIS TIMESTAMP AS AN ARRAY - `[year, month, day, hour, minute,
 * second, nanoseconds]`, Java's LocalDateTime serialised as-is - not as a
 * string. Month is 1-based. Anything else falls back to the envelope's `time`.
 */
function timestampOf(value: unknown, fallback: unknown): Date {
  if (
    Array.isArray(value) &&
    value.length >= 6 &&
    value.every((n) => typeof n === "number")
  ) {
    const [y, mo, d, h, mi, s, ns = 0] = value as number[]
    return new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!, s!, Math.floor(ns / 1_000_000)))
  }
  if (typeof value === "string" && !Number.isNaN(Date.parse(value)))
    return new Date(value)
  if (typeof fallback === "string" && !Number.isNaN(Date.parse(fallback))) {
    return new Date(fallback)
  }
  return new Date()
}

/**
 * The status change in an EventBridge event, or null for anything else - a
 * reputation finding (#158), another SES event type, or a malformed one.
 */
export function parseTenantStatusEvent(payload: unknown): TenantStatusEvent | null {
  if (!isSesEventBridgeEvent(payload)) return null
  const kind = payload["detail-type"] as string
  if (!kind.startsWith("Sending Status ")) return null

  const arn = Array.isArray(payload.resources) ? payload.resources[0] : undefined
  const match = typeof arn === "string" ? /:tenant\/([^/]+)/.exec(arn) : null
  if (!match) return null

  const detail = (payload.detail ?? {}) as { data?: Record<string, unknown> }
  const data = detail.data ?? {}
  const record = (data.record ?? {}) as Record<string, unknown>
  const status = toSendingStatus(
    typeof record.status === "string"
      ? record.status
      : // ⚠ THE DETAIL-TYPE AS A LAST RESORT. It says Enabled or Disabled and
        // cannot say Reinstated, so it only ever fills in a missing record.
        kind.slice("Sending Status ".length),
  )
  if (!status) return null

  return {
    sesTenant: match[1]!,
    status,
    cause: typeof record.cause === "string" ? record.cause : null,
    origin: typeof data.origin === "string" ? data.origin.toLowerCase() : null,
    changedAt: timestampOf(record.lastUpdatedTimestamp, payload.time),
  }
}

export type FindingImpact = "high" | "low"

/** A reputation finding opened or resolved (#158). */
export interface FindingEvent {
  sesTenant: string
  /** SES's type, lowercased: `bounce`, `complaint`, `feedback_3p`, ... */
  type: string
  /**
   * Null only on a resolve that did not say - which then closes every open
   * finding of the type rather than guessing one.
   */
  impact: FindingImpact | null
  status: "open" | "resolved"
  description: string | null
  at: Date
}

export const toImpact = (value: unknown): FindingImpact | null =>
  value === "HIGH" || value === "high"
    ? "high"
    : value === "LOW" || value === "low"
      ? "low"
      : null

/**
 * An `Advisor Recommendation Status Open` / `Resolved` event, or null.
 *
 * Shape, from the SES tenants guide:
 *
 *   { "detail-type": "Advisor Recommendation Status Open", "source": "aws.ses",
 *     "time": "2023-11-15T17:00:59Z",
 *     "resources": ["arn:aws:ses:<region>:<account>:tenant/<name>/<id>"],
 *     "detail": { "version": "1.0.0",
 *       "data": "The bounce rate exceeded 15.0% based on ...",
 *       "metadata": { "impact": "HIGH", "type": "BOUNCE" } } }
 *
 * ⚠ THE ONLY CLOCK IS THE ENVELOPE'S `time`. The finding's own
 * `CreatedTimestamp` is not in the event, which is why a finding is identified
 * by what it is (tenant, type, impact) and never by when - see
 * `sesReputationFindings`.
 *
 * ⚠ `Resolved` HERE IS `FIXED` IN THE API. Both mean closed; the poll maps the
 * other spelling.
 */
export function parseFindingEvent(payload: unknown): FindingEvent | null {
  if (!isSesEventBridgeEvent(payload)) return null
  const kind = payload["detail-type"] as string
  const prefix = "Advisor Recommendation Status "
  if (!kind.startsWith(prefix)) return null
  const word = kind.slice(prefix.length).toLowerCase()
  const status = word === "open" ? "open" : word === "resolved" ? "resolved" : null
  if (!status) return null

  const arn = Array.isArray(payload.resources) ? payload.resources[0] : undefined
  const match = typeof arn === "string" ? /:tenant\/([^/]+)/.exec(arn) : null
  if (!match) return null

  const detail = (payload.detail ?? {}) as {
    data?: unknown
    metadata?: Record<string, unknown>
  }
  const type =
    typeof detail.metadata?.type === "string"
      ? detail.metadata.type.toLowerCase()
      : null
  if (!type) return null
  const impact = toImpact(detail.metadata?.impact)
  // An open finding with no impact cannot be keyed or shown; drop it and let
  // the poll, which always has one, record it.
  if (status === "open" && !impact) return null

  return {
    sesTenant: match[1]!,
    type,
    impact,
    status,
    description: typeof detail.data === "string" ? detail.data : null,
    at: timestampOf(undefined, payload.time),
  }
}
