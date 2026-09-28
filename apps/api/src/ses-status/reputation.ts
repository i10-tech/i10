import { workspaceOfSesTenant } from "../domains/identity.js"
import { SYSTEM_SES_TENANT } from "../system-mail.js"
import type { FindingEvent, FindingImpact } from "./event.js"
import type { ReputationStore } from "./reputation-store.js"

/**
 * What happens when SES opens or resolves a reputation finding (#158).
 *
 * ⚠ ONE ENTRY POINT FOR BOTH SOURCES, as in service.ts. The EventBridge event
 * is the fast path; the daily poll reconciles against `ListRecommendations`
 * and is the net under it.
 *
 * ⚠ A HIGH FINDING IS THE WARNING BEFORE THE PAUSE. Under SES's Standard
 * policy a HIGH finding is what pauses a tenant, so the owner is emailed on
 * the first one of each episode - the one chance they get to fix a list before
 * the API starts refusing their mail. LOW findings are shown, never emailed.
 */
export type FindingOutcome =
  | "opened"
  | "seen"
  | "resolved"
  /** Open arrived after the Resolved that followed it. */
  | "stale"
  | "system"
  | "ignored"

export interface FindingNotice {
  sendFinding(input: {
    tenantId: string
    type: string
    description: string | null
    /** Makes the email idempotent across the event and the poll. */
    key: string
  }): Promise<void>
}

export interface ReputationServiceDeps {
  store: ReputationStore
  notice?: FindingNotice
  log?: {
    info?: (o: object, m: string) => void
    warn?: (o: object, m: string) => void
    error?: (o: object, m: string) => void
  }
  /**
   * Sentry, as a message rather than an exception. ⚠ THE INTERNAL VIEW UNTIL
   * THERE IS AN ADMIN UI: every HIGH finding reaches a human here.
   */
  alert?: (
    message: string,
    level: "warning" | "error",
    context: Record<string, unknown>,
  ) => void
}

/** A finding as `ListRecommendations` reports it. */
export interface SesFinding {
  type: string
  impact: FindingImpact
  description: string | null
  createdAt: Date
}

export interface ReputationService {
  apply(event: FindingEvent, source: "event" | "poll"): Promise<FindingOutcome>
  /**
   * Makes our open findings for a tenant match SES's open list: opens what SES
   * has and we do not, resolves what we have and SES no longer lists.
   */
  reconcile(
    sesTenant: string,
    open: SesFinding[],
    now: Date,
  ): Promise<{ opened: number; resolved: number }>
}

export function reputationService({
  store,
  notice,
  log,
  alert,
}: ReputationServiceDeps): ReputationService {
  const apply: ReputationService["apply"] = async (event, source) => {
    /*
     * ⚠ OUR OWN TENANT'S HIGH FINDING IS A SIGN-IN OUTAGE ON ITS WAY. There is
     * no workspace to store it against or owner to email, so it goes straight
     * to Sentry at error level.
     */
    if (event.sesTenant === SYSTEM_SES_TENANT) {
      const message = `our own SES tenant ${SYSTEM_SES_TENANT} has a ${event.impact ?? ""} ${event.type} finding ${event.status}`
      if (event.status === "open" && event.impact === "high") {
        log?.error?.({ ...event, source }, message)
        alert?.(message, "error", { description: event.description })
      } else {
        log?.warn?.({ ...event, source }, message)
      }
      return "system"
    }

    const tenantId = workspaceOfSesTenant(event.sesTenant)
    if (!tenantId) {
      log?.warn?.(
        { sesTenant: event.sesTenant },
        "finding for a tenant that is not ours",
      )
      return "ignored"
    }

    if (event.status === "resolved") {
      const closed = await store.resolve(tenantId, event.type, event.impact, event.at)
      if (closed > 0) {
        log?.info?.({ tenantId, type: event.type, source }, "SES finding resolved")
      }
      return closed > 0 ? "resolved" : "seen"
    }

    let result: Awaited<ReturnType<ReputationStore["open"]>>
    try {
      result = await store.open({
        tenantId,
        type: event.type,
        impact: event.impact!,
        description: event.description,
        at: event.at,
        source,
      })
    } catch (error) {
      // ⚠ A WORKSPACE DELETED SINCE ITS TENANT WAS MADE - the foreign key
      // refuses the row, as in service.ts.
      if ((error as { code?: string }).code === "23503") {
        log?.warn?.({ sesTenant: event.sesTenant }, "finding for a deleted workspace")
        return "ignored"
      }
      throw error
    }
    if (result.outcome === "stale") return "stale"

    if (result.outcome === "opened") {
      log?.warn?.(
        {
          tenantId,
          type: event.type,
          impact: event.impact,
          description: event.description,
          source,
        },
        "SES reputation finding opened",
      )
      if (event.impact === "high") {
        alert?.(`SES ${event.type} finding (HIGH) for a workspace`, "warning", {
          tenantId,
          description: event.description,
        })
      }
    }

    // ⚠ KEYED ON `notified_at`, NOT ON "JUST OPENED". An email that failed
    // last time is retried by the next redelivery or the next poll, and one
    // that succeeded is never sent twice.
    if (notice && event.impact === "high" && !result.notifiedAt) {
      try {
        await notice.sendFinding({
          tenantId,
          type: event.type,
          description: event.description,
          key: `ses-finding:${result.id}`,
        })
        await store.markNotified(tenantId, result.id)
      } catch (error) {
        // ⚠ THE FINDING STANDS WITHOUT THE EMAIL. Failing the webhook would
        // make SNS redeliver something we have already recorded.
        log?.error?.({ err: error, tenantId }, "could not email the owner a finding")
      }
    }
    return result.outcome
  }

  return {
    apply,

    async reconcile(sesTenant, open, now) {
      const summary = { opened: 0, resolved: 0 }
      for (const finding of open) {
        const outcome = await apply(
          {
            sesTenant,
            type: finding.type,
            impact: finding.impact,
            status: "open",
            description: finding.description,
            at: finding.createdAt,
          },
          "poll",
        )
        if (outcome === "opened") summary.opened += 1
      }

      const tenantId = workspaceOfSesTenant(sesTenant)
      if (!tenantId) return summary
      const still = new Set(open.map((f) => `${f.type}:${f.impact}`))
      for (const ours of await store.openFindings(tenantId)) {
        if (still.has(`${ours.type}:${ours.impact}`)) continue
        // ⚠ STAMPED WITH WHEN WE FOUND OUT. Only a lost Resolved event lands
        // here - a delivered one closed the row already, with its own time.
        summary.resolved += await store.resolve(tenantId, ours.type, ours.impact, now)
      }
      return summary
    },
  }
}
