import type { Context, Hono, Next } from "hono"
import type { ConsoleDeps } from "./deps.js"
import { planRequired, type IdentityFeature } from "../../identity/features.js"

/**
 * The plan flags (#345, identity/features.ts) as the console routes check them.
 *
 * ⚠ CHECKED ON THE SERVER, AT THE ROUTE THAT USES THE FEATURE. A console that
 * hides a button enforces nothing; the refusal is a 403 `plan_required` naming
 * the feature.
 *
 * ⚠ NO GATE WIRED MEANS NO PLAN LIMIT, not a refusal: a deployment without the
 * plan table (a test, a dev run) behaves as every flag on, which is also what
 * production does until the split is set.
 */

/** The refusal for a feature the plan lacks, or null to go on. */
export async function refuseFeature(
  d: ConsoleDeps,
  c: Context,
  feature: IdentityFeature,
): Promise<Response | null> {
  const gate = d.identity?.features
  if (!gate) return null
  const { tenantId } = c.get("auth")
  return (await gate.allows(tenantId, feature))
    ? null
    : c.json(planRequired(feature), 403)
}

/**
 * Gates whole route groups. Registered BEFORE the routes it covers (Hono runs
 * middleware in registration order), which is why `mountIdentity` calls this
 * first.
 *
 * ⚠ THE FEATURES ARE PER GROUP, NOT PER VERB: reading a screen the plan does
 * not include answers `plan_required` too, so the console can show the upgrade
 * prompt instead of an empty form.
 */
export function mountIdentityFeatureGates(app: Hono, d: ConsoleDeps): void {
  /** Any one of `features` is enough: the directory routes serve SCIM and Google. */
  const gate =
    (...features: [IdentityFeature, ...IdentityFeature[]]) =>
    async (c: Context, next: Next) => {
      const plan = d.identity?.features
      if (!plan) return next()
      const { tenantId } = c.get("auth")
      for (const feature of features)
        if (await plan.allows(tenantId, feature)) return next()
      return c.json(planRequired(features[0]), 403)
    }

  app.use("/identity/connections/:id/oidc", gate("sso_oidc"))
  app.use("/identity/connections/:id/oidc/*", gate("sso_oidc"))
  app.use("/identity/connections/:id/saml", gate("sso_saml"))
  app.use("/identity/connections/:id/saml/*", gate("sso_saml"))
  app.use("/identity/connections/:id/group-rules", gate("group_roles"))
  app.use("/identity/connections/:id/group-rules/*", gate("group_roles"))
  app.use("/identity/connections/:id/bypass", gate("sso_enforcement"))
  app.use("/identity/connections/:id/bypass/*", gate("sso_enforcement"))
  app.use("/identity/owner-exemption", gate("sso_enforcement"))
  app.use("/identity/owner-exemption/*", gate("sso_enforcement"))
  app.use("/identity/connections/:id/setup-links", gate("staff_setup"))
  app.use("/identity/connections/:id/setup-links/*", gate("staff_setup"))
  app.use("/identity/directories", gate("scim", "google_directory"))
  app.use("/identity/directories/*", gate("scim", "google_directory"))
  app.use("/identity/directories/:id/groups/*", gate("directory_mailboxes"))
  app.use("/identity/mail/*", gate("directory_mailboxes"))
  app.use("/identity/mailboxes", gate("directory_mailboxes"))
  app.use("/identity/mailboxes/*", gate("directory_mailboxes"))
  app.use("/identity/session-policy", gate("session_policy"))
  app.use("/identity/second-factor-policy", gate("session_policy"))
  app.use("/identity/ip-allowlist", gate("ip_allowlist"))
  app.use("/identity/siem", gate("siem_export"))
  app.use("/identity/siem/*", gate("siem_export"))
}
