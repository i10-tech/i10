/**
 * The API's "your plan does not include this" refusal, read once (#345).
 *
 * A gated identity route answers 403 with `name: "plan_required"` and the
 * feature it wanted (apps/api/src/identity/features.ts). Every identity screen
 * shows the same upgrade state for it instead of a generic failure.
 *
 * ⚠ PURE AND IMPORT-FREE ON PURPOSE: the remote loader, the toast and the tests
 * all use it, and none of them may pull a server module in.
 */

/** What each feature is called to a person. Unknown features are named by the screen. */
export const FEATURE_LABEL: Record<string, string> = {
  sso_google: "Sign in with Google",
  sso_oidc: "OpenID Connect single sign-on",
  sso_saml: "SAML single sign-on",
  sso_enforcement: "Enforced single sign-on",
  jit_rules: "Just-in-time access rules",
  group_roles: "Roles from identity provider groups",
  scim: "SCIM provisioning",
  google_directory: "Google Workspace directory",
  directory_mailboxes: "Directory mailboxes",
  siem_export: "SIEM export",
  ip_allowlist: "IP allowlist",
  session_policy: "Session policy",
  audit_retention_long: "Long audit log retention",
  staff_setup: "Setup links for your IT staff",
}

/** A feature's name for a person, or null when it is not one we know. */
export function featureLabel(feature: unknown): string | null {
  return typeof feature === "string" ? (FEATURE_LABEL[feature] ?? null) : null
}

interface FailureLike {
  name: string
  body?: Record<string, unknown>
}

/**
 * Whether a failure is the plan refusal. `feature` is the raw id the API named
 * (null when the body did not carry one); the label is `featureLabel(feature)`.
 */
export function planRequiredOf(
  failure: FailureLike,
): { feature: string | null } | null {
  if (failure.name !== "plan_required") return null
  const feature = failure.body?.feature
  return { feature: typeof feature === "string" ? feature : null }
}

/** A failed remote read, as the loading placeholder renders it. */
export interface RemoteFailure {
  message: string
  /** Set when the plan is what stopped it: show the upgrade state. */
  upgrade: { feature: string | null } | null
}

export function remoteFailure(failure: FailureLike & { error: string }): RemoteFailure {
  return { message: failure.error, upgrade: planRequiredOf(failure) }
}

/** The sentence that says what the plan lacks. */
export function upgradeSentence(feature: string | null): string {
  const label = featureLabel(feature)
  return label
    ? `${label} is not included in your plan.`
    : "This is not included in your plan."
}
