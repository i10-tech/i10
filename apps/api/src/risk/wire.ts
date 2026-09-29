import { SESv2Client } from "@aws-sdk/client-sesv2"
import { sql } from "drizzle-orm"
import type { Redis } from "ioredis"
import type { AuthEmailSender } from "../auth-email/deliver.js"
import type { Database } from "../db/client.js"
import type { Env } from "../env.js"
import { sendingTierStore } from "../metering/tiers.js"
import { sesReputationPolicy } from "./act.js"
import type { OwnerInfo } from "./facts.js"
import { holdStore } from "./holds.js"
import { identityStore, takeoverResponder } from "./identity.js"
import { labelStore } from "./labels.js"
import { riskNotices } from "./notice.js"
import type { RiskDeps } from "./runner.js"
import { embedderModelName } from "../content/embed.js"
import { objectStoreFrom } from "../content/object-store.js"
import { assessmentStore } from "./store.js"
import { boilerplateStore, trustSource, trustedTemplateStore } from "./trusted.js"
import { asVerdict, webRiskChecker } from "./webrisk.js"

/**
 * Building the risk engine (#170), once, the same way in every process that
 * runs it: the API (event-driven re-scores and sightings), the hourly job, and
 * the staff script.
 *
 * ⚠ ONE CONSTRUCTION, SO THE THREE CANNOT DRIFT. The API holding a different
 * idea of which actions are switched on than the hourly job would mean a hold
 * placed by one and refused by the other; the doors, the switches and the
 * notices are wired here and nowhere else.
 */
export interface ClerkForRisk {
  users: {
    getUser(id: string): Promise<{
      primaryEmailAddress?: { emailAddress: string } | null
      twoFactorEnabled?: boolean
    }>
  }
  sessions: {
    getSessionList(p: {
      userId: string
      status: "active"
    }): Promise<{ data: { id: string }[] }>
    revokeSession(id: string): Promise<unknown>
  }
}

export interface RiskSystemInput {
  db: Database
  env: Pick<
    Env,
    | "RISK_ENABLED"
    | "RISK_ACT_TIERS"
    | "RISK_ACT_HOLDS"
    | "RISK_ACT_SES_POLICY"
    | "RISK_ACT_TAKEOVER"
    | "METERING_FREE_PLAN_ID"
    | "SES_ENABLED"
    | "AWS_REGION"
    | "LAYA_URL"
    | "LAYA_API_KEY"
    | "RISK_EMBEDDER"
    | "WEBRISK_API_KEY"
    | "WEBRISK_DAILY_LIMIT"
    | "CONTENT_STORE_ENDPOINT"
    | "CONTENT_STORE_BUCKET"
    | "CONTENT_STORE_ACCESS_KEY_ID"
    | "CONTENT_STORE_SECRET_ACCESS_KEY"
  >
  clerk: ClerkForRisk
  redis?: Redis
  sender?: AuthEmailSender | null
  consoleUrl?: string
  exempt?: ReadonlySet<string>
  alert?: (
    message: string,
    level: "warning" | "error",
    context: Record<string, unknown>,
  ) => void
  log?: RiskDeps["log"]
}

/**
 * Clerk's view of a workspace owner, cached for a day.
 *
 * ⚠ CACHED BECAUSE THE HOURLY RUN WOULD OTHERWISE CALL CLERK ONCE PER
 * WORKSPACE PER HOUR, and a Clerk outage must not stop scoring: a failure is a
 * null, which every rule reads as "unknown".
 */
export function clerkOwnerInfo(clerk: ClerkForRisk, redis?: Redis) {
  return async (userId: string): Promise<OwnerInfo | null> => {
    const key = `risk:owner:${userId}`
    const cached = await redis?.get(key).catch(() => null)
    if (cached) return JSON.parse(cached) as OwnerInfo
    const user = await clerk.users.getUser(userId)
    const info: OwnerInfo = {
      mfa: user.twoFactorEnabled ?? null,
      email: user.primaryEmailAddress?.emailAddress ?? null,
    }
    await redis?.setex(key, 86_400, JSON.stringify(info)).catch(() => {})
    return info
  }
}

/** Our own workspace's id, which the score must never touch. */
export async function systemTenantIds(
  db: Database,
  slug: string | undefined,
): Promise<Set<string>> {
  if (!slug) return new Set()
  try {
    const rows = (await db.execute(
      sql`select core.tenant_id_by_slug(${slug})::text as id`,
    )) as unknown as { id: string | null }[]
    return new Set(rows[0]?.id ? [rows[0].id] : [])
  } catch {
    return new Set()
  }
}

export function riskSystem(input: RiskSystemInput) {
  const { db, env, clerk, redis, log } = input
  const tiers = sendingTierStore(db)
  const holds = holdStore(db)
  const assessments = assessmentStore(db)
  const labels = labelStore(db)
  const identity = identityStore(db)
  const notices =
    input.sender && input.consoleUrl
      ? riskNotices({ db, clerk, sender: input.sender, consoleUrl: input.consoleUrl })
      : undefined
  const webRisk = webRiskChecker({
    ...(env.WEBRISK_API_KEY ? { key: env.WEBRISK_API_KEY } : {}),
    dailyLimit: env.WEBRISK_DAILY_LIMIT,
    ...(redis ? { redis } : {}),
    ...(log ? { log } : {}),
  })
  const trustedTemplates = trustedTemplateStore(db)
  const boilerplate = boilerplateStore(db)
  /*
   * ⚠ TWO SOURCES, ONE DIFFERENCE: WHO MAY SPEND THE WEB RISK BUDGET. The
   * five-minute fingerprint pass (content-store job) reads cached verdicts
   * only - it runs twelve times an hour over every workspace, and a hole's link
   * it cannot vouch for yet simply earns no credit until the hourly job, which
   * may look the host up, has seen it.
   */
  const cachedTrust = trustSource(db, {
    templates: trustedTemplates,
    boilerplate,
    verdict: async (host) => asVerdict(await webRisk.cached(host)),
  })
  const jobTrust = trustSource(db, {
    templates: trustedTemplates,
    boilerplate,
    verdict: async (host) => asVerdict(await webRisk.lookup(host)),
  })

  const deps: RiskDeps = {
    db,
    freePlanId: env.METERING_FREE_PLAN_ID,
    ownerInfo: clerkOwnerInfo(clerk, redis),
    act: {
      tiers,
      holds,
      assessments,
      ...(env.SES_ENABLED
        ? {
            sesPolicy: sesReputationPolicy(
              new SESv2Client({ region: env.AWS_REGION }),
              { region: env.AWS_REGION },
            ),
          }
        : {}),
      ...(notices ? { notice: notices, keySpread: notices.keySpread } : {}),
      ...(input.alert ? { alert: input.alert } : {}),
      ...(log ? { log } : {}),
    },
    labels,
    webRisk,
    trust: jobTrust,
    trustedTemplates,
    ...(notices
      ? {
          templateNotice: (tenantId, r) =>
            notices.templateDecision({
              tenantId,
              templateId: r.template.id,
              template: r.template.name,
              decision: "revoked",
              reason: r.template.decisionReason,
            }),
        }
      : {}),
    contentModel: embedderModelName(env.RISK_EMBEDDER),
    objects: objectStoreFrom(env),
    switches: {
      enabled: env.RISK_ENABLED,
      tiers: env.RISK_ACT_TIERS,
      holds: env.RISK_ACT_HOLDS,
      sesPolicy: env.RISK_ACT_SES_POLICY,
    },
    ...(redis ? { redis } : {}),
    ...(input.exempt ? { exempt: input.exempt } : {}),
    ...(env.LAYA_URL
      ? {
          laya: {
            url: env.LAYA_URL,
            ...(env.LAYA_API_KEY ? { apiKey: env.LAYA_API_KEY } : {}),
          },
        }
      : {}),
    ...(log ? { log } : {}),
  }

  const takeover = redis
    ? takeoverResponder({
        clerk,
        store: identity,
        redis,
        enabled: env.RISK_ACT_TAKEOVER,
        ...(notices ? { notify: notices.security } : {}),
        ...(log ? { log } : {}),
      })
    : undefined

  return {
    deps,
    tiers,
    holds,
    assessments,
    labels,
    identity,
    takeover,
    notices,
    webRisk,
    trustedTemplates,
    boilerplate,
    cachedTrust,
  }
}
