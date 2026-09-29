import {
  GetTenantCommand,
  UpdateReputationEntityPolicyCommand,
  type SESv2Client,
} from "@aws-sdk/client-sesv2"
import { sesTenantName } from "../domains/identity.js"
import type { SendingTierStore } from "../metering/tiers.js"
import type { Action } from "./decide.js"
import type { HoldStore } from "./holds.js"
import type { AssessmentStore } from "./store.js"
import { CATEGORY_TEXT, type Category } from "./types.js"

/**
 * Carrying out what `decide` returned (#170), each through its one door.
 *
 * ⚠ EVERY ACTION IS INDEPENDENT AND REPORTED ON ITS OWN. A failed SES call
 * must not stop the hold that protects us, and a failed email must not undo
 * the hold it announces - the email is a courtesy, the hold is the protection.
 * The return value lists what actually happened, which is what the event row
 * records; an action that failed is recorded as failed, never as done.
 */
export interface HoldNotice {
  held(input: { tenantId: string; category: Category; canceled: number }): Promise<void>
}

export interface ActDeps {
  tiers: SendingTierStore
  holds: HoldStore
  assessments: AssessmentStore
  /** Sets a tenant's SES reputation policy. Absent with SES off. */
  sesPolicy?: (tenantId: string, policy: "strict" | "standard") => Promise<void>
  notice?: HoldNotice
  /** Emails the owner that a key may have leaked. Idempotent per day. */
  keySpread?: (tenantId: string) => Promise<void>
  alert?: (
    message: string,
    level: "warning" | "error",
    context: Record<string, unknown>,
  ) => void
  log?: {
    error?: (o: object, m: string) => void
    warn?: (o: object, m: string) => void
  }
}

export async function act(
  tenantId: string,
  actions: readonly Action[],
  deps: ActDeps,
  now: Date,
  context: Record<string, unknown> = {},
): Promise<string[]> {
  const done: string[] = []
  for (const a of actions) {
    try {
      switch (a.kind) {
        case "tier": {
          const r = await deps.tiers.set({
            tenantId,
            tier: a.tier,
            source: "score",
            setBy: "risk-score",
            reason: a.reason,
            respectStaff: true,
          })
          done.push(
            r.refused
              ? `tier:${a.tier}:refused-staff`
              : r.changed
                ? `tier:${a.tier}`
                : `tier:${a.tier}:unchanged`,
          )
          break
        }
        case "hold": {
          const r = await deps.holds.hold({
            tenantId,
            source: "score",
            setBy: "risk-score",
            reason: a.reason,
            category: a.category,
          })
          if (!r) {
            done.push("hold:already")
            break
          }
          done.push(`hold:canceled=${r.canceled}`)
          deps.alert?.(
            `Workspace held by the risk score: ${CATEGORY_TEXT[a.category]}`,
            "error",
            {
              tenantId,
              reason: a.reason,
              canceled: r.canceled,
              ...context,
            },
          )
          try {
            await deps.notice?.held({
              tenantId,
              category: a.category,
              canceled: r.canceled,
            })
            if (deps.notice) await deps.holds.markNotified(tenantId)
          } catch (error) {
            deps.log?.error?.(
              { err: error, tenantId },
              "could not email the owner about a hold",
            )
          }
          break
        }
        case "ses_policy": {
          if (!deps.sesPolicy) {
            done.push(`ses:${a.policy}:unavailable`)
            break
          }
          await deps.sesPolicy(tenantId, a.policy)
          await deps.assessments.setSesPolicy(tenantId, a.policy, now)
          done.push(`ses:${a.policy}`)
          break
        }
        case "alert":
          deps.alert?.(a.message, a.level, { tenantId, ...context })
          await deps.assessments.markAlerted(tenantId, now)
          done.push(`alert:${a.level}`)
          break
        case "review_overdue":
          deps.alert?.(
            "A risk hold is past its 24-hour review (GDPR Article 22)",
            "error",
            {
              tenantId,
              ...context,
            },
          )
          await deps.holds.markReviewAlerted(tenantId)
          done.push("review-overdue")
          break
        case "key_spread_notice":
          if (deps.keySpread) {
            await deps.keySpread(tenantId)
            done.push("notice:key-spread")
          }
          break
        case "suppressed":
          done.push(`suppressed:${a.wanted}:${a.why}`)
          break
      }
    } catch (error) {
      deps.log?.error?.({ err: error, tenantId, action: a.kind }, "risk action failed")
      done.push(`failed:${a.kind}`)
    }
  }
  return done
}

/**
 * The SES side of the paid-workspace lever: the tenant's reputation policy.
 *
 * ⚠ THE IAM GRANT IS `ses:UpdateReputationEntityPolicy`, and without it this
 * throws AccessDenied - reported by `act` as `failed:ses_policy`, never
 * silently skipped. SES itself recommends Strict for high-risk tenants.
 */
export function sesReputationPolicy(
  client: SESv2Client,
  { region }: { region: string },
) {
  return async (tenantId: string, policy: "strict" | "standard") => {
    const out = await client.send(
      new GetTenantCommand({ TenantName: sesTenantName(tenantId) }),
    )
    const arn = out.Tenant?.TenantArn
    if (!arn) throw new Error(`workspace ${tenantId} has no SES tenant yet`)
    await client.send(
      new UpdateReputationEntityPolicyCommand({
        ReputationEntityType: "RESOURCE",
        ReputationEntityReference: arn,
        ReputationEntityPolicy: `arn:aws:ses:${region}:aws:reputation-policy/${policy}`,
      }),
    )
  }
}
