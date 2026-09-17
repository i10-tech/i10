import { eq, sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { apiKeys, domains, onboarding } from "../db/core.js"

/**
 * Where a tenant is in onboarding, and whether to send them there.
 *
 * ⚠ THE ROW DECIDES WHERE WE *SEND* SOMEBODY, NEVER WHERE THEY MAY GO.
 * `/onboarding` is a route anyone can open at any time — that is a requirement,
 * not an accident, because the flow re-runs after an upgrade. Anything that
 * treated `completed_at` as a permission would make that impossible and the
 * bug would present as "the upgrade did nothing".
 *
 * ⚠ AND `shouldOnboard` READS THE WORLD, NOT ONLY THE ROW. A tenant with a
 * verified domain and a live API key is onboarded whatever this table says —
 * somebody who set everything up through the API and then opened the console
 * for the first time must not be walked through creating what they already
 * have. The row is a hint that makes the common case one query; the facts
 * override it.
 */

/** The steps, in order. The console renders these; the API only stores one. */
export const STEPS = ["workspace", "domain", "verify", "send", "plan"] as const
export type Step = (typeof STEPS)[number]

export interface OnboardingState {
  step: Step
  completed_at: string | null
  last_onboarded_plan: string | null
  use_case: string | null
  /** Whether the console should redirect on arrival. See `shouldOnboard`. */
  should_onboard: boolean
  /** What the redirect decision was based on — rendered in the console. */
  facts: {
    has_domain: boolean
    has_verified_domain: boolean
    has_api_key: boolean
  }
}

export interface OnboardingStore {
  get(tenantId: string, currentPlan: string | null): Promise<OnboardingState>
  setStep(tenantId: string, step: Step): Promise<void>
  setUseCase(tenantId: string, useCase: string): Promise<void>
  complete(tenantId: string, currentPlan: string | null): Promise<void>
}

export function onboardingStore(db: Database, freePlanId = "free"): OnboardingStore {
  return {
    async get(tenantId, currentPlan) {
      return withTenant(db, tenantId, async (tx) => {
        const [row, domainCounts, keyCount] = await Promise.all([
          tx.select().from(onboarding).where(eq(onboarding.tenantId, tenantId)).limit(1),
          tx
            .select({
              total: sql<number>`count(*)::int`,
              verified: sql<number>`count(*) filter (where ${domains.status} = 'verified')::int`,
            })
            .from(domains),
          tx
            .select({ total: sql<number>`count(*)::int` })
            .from(apiKeys)
            .where(sql`${apiKeys.revokedAt} is null`),
        ])

        const state = row[0]
        const facts = {
          has_domain: (domainCounts[0]?.total ?? 0) > 0,
          has_verified_domain: (domainCounts[0]?.verified ?? 0) > 0,
          has_api_key: (keyCount[0]?.total ?? 0) > 0,
        }

        const should = shouldOnboard({
          completedAt: state?.completedAt ?? null,
          lastOnboardedPlan: state?.lastOnboardedPlan ?? null,
          currentPlan,
          facts,
          freePlanId,
        })

        return {
          /*
           * ⚠ A RE-OPENED FLOW RESTARTS AT `domain`, NOT WHERE IT LEFT OFF.
           * `complete` stamps `step: "plan"`, so a tenant coming back after an
           * upgrade would be dropped on the last screen of a wizard they have
           * already finished — which looks exactly like the upgrade having done
           * nothing. `workspace` would be wrong in the other direction: their
           * workspace exists, and walking them through naming it is theatre.
           *
           * ⚠ AND IT IS DERIVED HERE RATHER THAN WRITTEN BY THE BILLING
           * WEBHOOK, WHICH IS WHY THERE IS NO `reopenOnUpgrade`. A write-path
           * version of this rule is a SECOND implementation of it that only
           * runs if the webhook landed — so a missed delivery left somebody
           * upgraded, correctly told to onboard, and pointed at the wrong step.
           * One rule, evaluated on read, cannot disagree with itself.
           */
          step: should && state?.completedAt ? "domain" : ((state?.step as Step) ?? "workspace"),
          completed_at: state?.completedAt?.toISOString() ?? null,
          last_onboarded_plan: state?.lastOnboardedPlan ?? null,
          use_case: state?.useCase ?? null,
          should_onboard: should,
          facts,
        }
      })
    },

    async setStep(tenantId, step) {
      await withTenant(db, tenantId, async (tx) => {
        await tx
          .insert(onboarding)
          .values({ tenantId, step })
          .onConflictDoUpdate({
            target: onboarding.tenantId,
            set: { step, updatedAt: new Date() },
          })
      })
    },

    async setUseCase(tenantId, useCase) {
      await withTenant(db, tenantId, async (tx) => {
        await tx
          .insert(onboarding)
          .values({ tenantId, useCase })
          .onConflictDoUpdate({
            target: onboarding.tenantId,
            set: { useCase, updatedAt: new Date() },
          })
      })
    },

    async complete(tenantId, currentPlan) {
      const now = new Date()
      await withTenant(db, tenantId, async (tx) => {
        await tx
          .insert(onboarding)
          .values({
            tenantId,
            step: "plan",
            completedAt: now,
            lastOnboardedPlan: currentPlan,
          })
          .onConflictDoUpdate({
            target: onboarding.tenantId,
            set: {
              completedAt: now,
              // ⚠ STAMPED WITH THE PLAN IN FORCE RIGHT NOW, which is what makes
              // the upgrade rule work later. Leaving it null would make the
              // first upgrade look like "we have never onboarded on free" and
              // never re-run the flow.
              lastOnboardedPlan: currentPlan,
              updatedAt: now,
            },
          })
      })
    },

  }
}

/**
 * The redirect decision, as a pure function so it can be reasoned about and
 * tested without a database.
 */
export function shouldOnboard(input: {
  completedAt: Date | null
  lastOnboardedPlan: string | null
  currentPlan: string | null
  facts: { has_domain: boolean; has_verified_domain: boolean; has_api_key: boolean }
  freePlanId: string
}): boolean {
  /*
   * ⚠ THE UPGRADE OUT OF FREE IS CHECKED FIRST, AND THE ORDER IS THE WHOLE
   * BEHAVIOUR. Every other branch below asks "is this workspace set up"; this
   * one asks "did they just buy something", and those are different questions
   * with different answers for the same tenant. Somebody with a verified domain
   * and a live key who upgrades from free is, by every other test here, already
   * onboarded — and is also exactly the person with a new allowance they have
   * not seen, which is the screen the flow ends on. Putting the facts shortcut
   * first meant the most engaged customers were the ones the upgrade flow never
   * ran for.
   *
   * ⚠ ONLY OUT OF FREE, AND THAT SINGLE CONDITION IS THE WHOLE RULE. Free → pro
   * unlocks domains, mailboxes and storage that were previously zero, so there
   * is genuinely something new to set up. Pro → scale moves a number.
   * Interrupting somebody who has just paid us more, to walk them through a
   * domain they configured six months ago, is an insult dressed as a wizard.
   *
   * ⚠ AND IT REQUIRES `completedAt`, so this cannot fire for somebody who has
   * never finished the flow — they are caught by the branch below and start at
   * the beginning rather than at the end.
   */
  if (
    input.completedAt &&
    input.lastOnboardedPlan === input.freePlanId &&
    input.currentPlan !== null &&
    input.currentPlan !== input.freePlanId
  ) {
    return true
  }

  /*
   * ⚠ THE FACTS WIN OVER THE ROW. Somebody who set everything up through the
   * API and has never opened the console has no onboarding row at all — the
   * naive check ("no row means not onboarded") would greet an established
   * customer with a wizard asking them to add their first domain. A verified
   * domain and a live key IS being onboarded, whoever did it and however.
   */
  if (input.facts.has_verified_domain && input.facts.has_api_key) return false

  // Nothing recorded and nothing set up: this is somebody's first minute.
  return !input.completedAt
}
