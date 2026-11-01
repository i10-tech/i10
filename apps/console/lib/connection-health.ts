import type { ConnectionHealth, SsoStatus } from "@/lib/sso-types"

/**
 * A connection's sign-in health as the list shows it (#345).
 *
 * The API derives `health` from the audit log and answers null when it cannot
 * read it (apps/api/src/identity/health.ts). Only an active connection can be
 * healthy or failing: a draft, testing or disabled one signs nobody in.
 *
 * ⚠ NULL, A MISSING FIELD AND A CONNECTION THAT IS NOT LIVE ALL SHOW NOTHING.
 * Never an error: the list is how an admin fixes a connection.
 */

export type HealthState = "failing" | "degraded" | "healthy"

export interface HealthLabel {
  state: HealthState
  label: string
  /** The short reason, for the row's second line and the badge's tooltip. */
  reason: string
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

export function healthLabel(
  health: ConnectionHealth | null | undefined,
  status: SsoStatus,
): HealthLabel | null {
  if (!health || status !== "active") return null
  if (health.failing) {
    return {
      state: "failing",
      label: "Failing",
      reason:
        health.reason === "no_success"
          ? "Nobody has signed in through it for a day, and sign-ins have failed."
          : "Sign-ins are failing much more than usual.",
    }
  }
  if (health.failuresLastHour > 0) {
    return {
      state: "degraded",
      label: "Degraded",
      reason: `${plural(health.failuresLastHour, "sign-in")} failed in the last hour.`,
    }
  }
  return {
    state: "healthy",
    label: "Healthy",
    reason:
      health.failuresLast24Hours > 0
        ? `${plural(health.failuresLast24Hours, "sign-in")} failed in the last day.`
        : health.lastSuccessAt
          ? "Sign-ins are working."
          : "No sign-ins yet.",
  }
}
