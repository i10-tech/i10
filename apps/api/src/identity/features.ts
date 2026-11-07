import { eq } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { planAssignments } from "../db/core.js"

/**
 * Plan flags for the enterprise identity set (#345, sso.md 2.21, decision 4).
 *
 * Every feature #319 groups under "enterprise identity" is a flag a plan
 * grants or does not, checked on the server at the route or job that uses it
 * (`requireFeature` in routes/console/identity-features.ts; the SIEM export job).
 *
 * ⚠ THE SPLIT IS DEFERRED ON PURPOSE (decision 4, 2026-10-19), SO EVERY FLAG
 * IS ON FOR EVERY PLAN, and this file is the one place that says so. The split
 * is set before launch by editing `PLAN_FEATURES` below: a plan id mapped to
 * the features it grants. Until someone does, `DEFAULT_FEATURES` applies to
 * every plan, including a workspace with no plan row at all.
 *
 * ⚠ A FLAG IS NOT AN ENTITLEMENT IN `packages/metering`. Entitlements there
 * are allowances that are drawn down or held (emails, domains); a feature that
 * is simply on or off for a plan has no allowance, interval or overage, and
 * modelling it as `allowance: 1` would invite the meter to count it. Flags
 * live beside the plan id (`core.plan_assignments.plan_id`) and are resolved
 * from it, so they follow a plan change with no ledger involved.
 *
 * ⚠ A REFUSED FEATURE IS A 403 `plan_required`, NEVER A 404 OR A QUIET NO-OP,
 * because the console shows an upgrade prompt for exactly that name.
 */
export const IDENTITY_FEATURES = [
  "sso_google",
  "sso_oidc",
  "sso_saml",
  "sso_enforcement",
  "jit_rules",
  "group_roles",
  "scim",
  "google_directory",
  "directory_mailboxes",
  "siem_export",
  "ip_allowlist",
  "session_policy",
  "audit_retention_long",
  "staff_setup",
] as const

export type IdentityFeature = (typeof IDENTITY_FEATURES)[number]

/** Every flag, for every plan, until the split is set before launch. */
export const DEFAULT_FEATURES: readonly IdentityFeature[] = IDENTITY_FEATURES

/**
 * The features a plan grants, by plan id. Empty: every plan gets
 * `DEFAULT_FEATURES`. Proposed split on record (sso.md decision 4): Google
 * one-click for everyone; OIDC and SAML, enforcement, JIT and group roles on
 * Pro; SCIM, Google directory, mailbox provisioning, SIEM, IP allowlist, long
 * audit retention and staff setup on custom.
 */
export const PLAN_FEATURES: Readonly<Record<string, readonly IdentityFeature[]>> = {}

export function featuresOf(
  planId: string | null | undefined,
): ReadonlySet<IdentityFeature> {
  return new Set((planId ? PLAN_FEATURES[planId] : undefined) ?? DEFAULT_FEATURES)
}

/** Whether a workspace's plan grants a feature. */
export interface FeatureGate {
  allows(tenantId: string, feature: IdentityFeature): Promise<boolean>
}

/** The gate over the plan a workspace holds (`core.plan_assignments`). */
export function featureGate(db: Database): FeatureGate {
  return {
    async allows(tenantId, feature) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ planId: planAssignments.planId })
          .from(planAssignments)
          .where(eq(planAssignments.tenantId, tenantId))
          .limit(1),
      )
      return featuresOf(row?.planId).has(feature)
    },
  }
}

/** The body of a refused feature: the console shows an upgrade prompt for it. */
export const planRequired = (feature: IdentityFeature) =>
  ({
    statusCode: 403,
    name: "plan_required",
    message: "Your plan does not include this feature.",
    feature,
  }) as const
