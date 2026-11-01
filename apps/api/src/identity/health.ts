/**
 * Connection health (#345, sso.md 2.21): is a connection's sign-in working,
 * read from the identity audit log it already writes.
 *
 * ⚠ DERIVED, NEVER STORED. A health row would be a second record of what the
 * events table says, and would drift from it; the numbers are counted from the
 * events (index-backed, db/identity.ts `events_connection_type_idx`) each time
 * somebody asks, which is a handful of times a day per workspace.
 *
 * ⚠ ONLY A CONNECTION'S OWN FAULTS COUNT AS ITS FAILURES. `wrong_browser` and
 * `attempt_used` are a person with two tabs or a replayed callback: they say
 * nothing about whether the IdP and the connection work, and anybody who can
 * reach the callback URL can make as many as they like, so counting them would
 * let a stranger paint a healthy connection red.
 */

/** Audit event types that are a sign-in through a connection going wrong. */
export const FAILURE_TYPES = ["sign_in.failed", "sign_in.idp_unavailable"] as const

/** The audit event type of a finished sign-in. */
export const SUCCESS_TYPE = "sign_in.succeeded"

/**
 * Failure reasons that are not the connection's fault (see above).
 *
 * ⚠ AND NONE OF THE WORKSPACE'S OWN RULES. After these the IdP has vouched for
 * the person and the connection did its job; the workspace said no (full, a
 * block, a deprovisioned or banned account, an owner or admin who signs in
 * another way). Counted, a full workspace turned its connection "Degraded"
 * and sent `sso.connection.failed` for every waiting-list sign-in (2026-11-01).
 */
export const NOT_THE_CONNECTIONS_FAULT: readonly string[] = [
  "wrong_browser",
  "attempt_used",
  "waiting_list",
  "workspace_full",
  "role_exempt",
  "blocked",
  "deprovisioned",
  "account_banned",
]

/** The window a spike is measured over, and the least failures that is one. */
export const SPIKE_WINDOW_MINUTES = 15
export const SPIKE_FLOOR = 10
export const SPIKE_FACTOR = 3
/** No success for this long, with failures in it, is a connection that is down. */
export const NO_SUCCESS_AFTER_MS = 24 * 3_600_000

/** What the audit log says about one connection, as counts. */
export interface HealthCounts {
  lastSuccessAt: Date | null
  failuresLast15Minutes: number
  failuresLastHour: number
  failuresLast24Hours: number
}

export type FailingReason = "failure_spike" | "no_success"

export interface ConnectionHealth {
  lastSuccessAt: string | null
  failuresLastHour: number
  failuresLast24Hours: number
  failing: boolean
  /** Why it is failing, when it is. */
  reason: FailingReason | null
}

/**
 * Whether a connection is failing, pure.
 *
 * ⚠ SPIKE: failures in the last 15 minutes exceed max(10, 3 x the trailing
 * hourly average). The average is the 23 hours before the last one, so a spike
 * does not raise the bar it is measured against.
 *
 * ⚠ OR DOWN: no success for 24 hours while failures happened in them. A
 * connection nobody has tried to use is quiet, not failing.
 *
 * ⚠ ONLY AN `active` CONNECTION CAN FAIL. A draft or disabled one signs
 * nobody in, so failures against it are a setup in progress or a switch that
 * is off on purpose.
 */
export function healthOf(
  counts: HealthCounts,
  status: string,
  now: Date,
): ConnectionHealth {
  const view = {
    lastSuccessAt: counts.lastSuccessAt?.toISOString() ?? null,
    failuresLastHour: counts.failuresLastHour,
    failuresLast24Hours: counts.failuresLast24Hours,
  }
  if (status !== "active") return { ...view, failing: false, reason: null }
  const trailing = (counts.failuresLast24Hours - counts.failuresLastHour) / 23
  const threshold = Math.max(SPIKE_FLOOR, SPIKE_FACTOR * trailing)
  if (counts.failuresLast15Minutes > threshold)
    return { ...view, failing: true, reason: "failure_spike" }
  const quietFor = counts.lastSuccessAt
    ? now.getTime() - counts.lastSuccessAt.getTime()
    : Infinity
  if (quietFor >= NO_SUCCESS_AFTER_MS && counts.failuresLast24Hours > 0)
    return { ...view, failing: true, reason: "no_success" }
  return { ...view, failing: false, reason: null }
}

/** How often one connection may tell the workspace it is failing. */
export const FAILURE_ALERT_EVERY_MS = 15 * 60_000

/** The audit event type that records a failure alert having gone out. */
export const FAILURE_ALERT_TYPE = "sso.connection.failure_alerted"

export interface ConnectionHealthStore {
  counts(tenantId: string, connectionId: string): Promise<HealthCounts>
  /**
   * Records that a failure alert is going out for this connection, unless one
   * did within `everyMs`. True: this caller owns the alert.
   *
   * ⚠ THE CHECK AND THE RECORD ARE ONE STEP UNDER A LOCK ON THE CONNECTION,
   * so two replicas seeing the same failure at once send one alert.
   */
  claimAlert(
    tenantId: string,
    connectionId: string,
    snapshot: Record<string, unknown>,
    everyMs: number,
  ): Promise<boolean>
}
