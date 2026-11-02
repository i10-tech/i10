import type { SsoConnection, TestRun } from "@/lib/sso-types"

/**
 * Reading a test run (#340): what a real sign-in would have done, and whether a
 * run still counts towards "required". Pure, so it is tested without a browser.
 */

export const DAY_MS = 24 * 60 * 60 * 1000

const REASONS: Record<string, string> = {
  email_unverified: "The provider did not vouch for the email address.",
  no_email: "The provider sent no email address.",
  domain_not_verified:
    "The address is not on one of this connection's verified domains.",
  no_account:
    "No account exists for this person and JIT is off. Turn on JIT, or create them through SCIM.",
  ambiguous_account: "More than one account matches this person.",
  already_linked: "This person is already linked to a different identity.",
  subject_changed:
    "The provider sent a new login for someone already linked here. The connection asks an owner to approve it, so the person is refused until one does.",
  managed_elsewhere: "This person is managed by another workspace's connection.",
  deprovisioned: "This person was removed and is not allowed back by this connection.",
  blocked: "This address is on the workspace's block list.",
  account_banned: "Their i10 account is banned.",
  profile_incomplete:
    "The provider did not send the person's name, which i10 requires.",
  mfa_required:
    "The connection requires MFA and the provider did not prove it. Check the authentication context values.",
  role_exempt:
    "Owners and admins who are not managed are never signed in through SSO; they use their passkey or password.",
  workspace_full: "The workspace has no free seats.",
  waiting_list: "The workspace is full; the person would join the waiting list.",
  hosted_domain: "The Google account is not on a verified domain of this workspace.",
}

/** Group state note for a test run when the provider sent no groups or an overage link. */
export function groupsNote(run: TestRun): string | null {
  const state =
    typeof run.claims.groupsState === "string"
      ? run.claims.groupsState
      : typeof run.resolution.groupsUnavailable === "string"
        ? run.resolution.groupsUnavailable
        : null
  if (state === "overage") {
    const suffix =
      run.resolution.roleKept === true
        ? " Their current workspace role would be kept."
        : run.resolution.groupsUnavailable === "overage"
          ? " A new account would join with the default member role."
          : ""
    return `Too many groups (overage): the provider sent a group overage link instead of the group list.${suffix}`
  }
  if (state === "absent") {
    const suffix =
      run.resolution.roleKept === true
        ? " Their current workspace role would be kept."
        : run.resolution.groupsUnavailable === "absent"
          ? " A new account would join with the default member role."
          : ""
    return `No groups received: the provider sent no group claim or attribute.${suffix}`
  }
  return null
}

/** What a real sign-in would do, in a sentence. */
export function wouldDo(run: TestRun): string {
  const r = run.resolution
  if (typeof r.refused === "string")
    return `It would refuse the sign-in. ${REASONS[r.refused] ?? "The provider's answer was not accepted."}`
  const email = typeof r.email === "string" ? r.email : "this person"
  const role = typeof r.role === "string" ? r.role : "member"
  const unavailableLabel =
    r.groupsUnavailable === "overage"
      ? "too many groups (overage)"
      : r.groupsUnavailable === "absent"
        ? "no groups received"
        : null
  if (r.wouldRelink === true)
    return `It would sign in ${email} and move their link to this new provider login, because the connection relinks automatically.`
  if (r.wouldCreate === true) {
    const names = r.names as { given?: boolean; family?: boolean } | undefined
    const missing =
      names && (names.given === false || names.family === false)
        ? " The provider did not send a first and last name, and a new account needs both."
        : ""
    const groupsMissing = unavailableLabel
      ? ` Group rules could not run (${unavailableLabel}), so the default member role applies.`
      : ""
    return `It would create an account for ${email} as ${role} (JIT).${missing}${groupsMissing}`
  }
  const how: Record<string, string> = {
    linked: "the account already linked to this identity",
    scim: "the account its directory provisioned",
    claimed: "the existing account with this address, linking it",
  }
  if (r.roleKept === true && unavailableLabel)
    return `It would sign in ${email} to ${how[String(r.path)] ?? "their account"} and keep their current role (${unavailableLabel}).`
  return `It would sign in ${email} to ${how[String(r.path)] ?? "their account"} as ${role}.`
}

/** What to show next to the Require MFA toggle for a connection's provider capability. */
export function mfaCapabilityNote(
  connection: Pick<SsoConnection, "mfaRequired" | "capabilities">,
): { tone: "warning" | "muted"; text: string } | null {
  const caps = connection.capabilities
  if (!caps) return null
  if (caps.canProveMfa === "no") {
    const reason =
      caps.mfaUnprovableReason ?? `${caps.label} does not send MFA proof to i10.`
    if (connection.mfaRequired)
      return {
        tone: "warning",
        text: `Warning: ${reason} Sign-ins through this connection will be refused while this stays on.`,
      }
    return { tone: "muted", text: reason }
  }
  if (caps.canProveMfa === "with_setting" && caps.mfaSetting)
    return { tone: "muted", text: `Provider setting required: ${caps.mfaSetting}` }
  return null
}

/** The newest passed run within the day, if any. */
export function latestPass(runs: TestRun[], now: number): TestRun | null {
  return (
    runs.find(
      (r) => r.outcome === "passed" && now - new Date(r.createdAt).getTime() < DAY_MS,
    ) ?? null
  )
}
