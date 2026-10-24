import type { TestRun } from "@/lib/sso-types"

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

/** What a real sign-in would do, in a sentence. */
export function wouldDo(run: TestRun): string {
  const r = run.resolution
  if (typeof r.refused === "string")
    return `It would refuse the sign-in. ${REASONS[r.refused] ?? "The provider's answer was not accepted."}`
  const email = typeof r.email === "string" ? r.email : "this person"
  const role = typeof r.role === "string" ? r.role : "member"
  if (r.wouldCreate === true) {
    const names = r.names as { given?: boolean; family?: boolean } | undefined
    const missing =
      names && (names.given === false || names.family === false)
        ? " The provider did not send a first and last name, and a new account needs both."
        : ""
    return `It would create an account for ${email} as ${role} (JIT).${missing}`
  }
  const how: Record<string, string> = {
    linked: "the account already linked to this identity",
    scim: "the account its directory provisioned",
    claimed: "the existing account with this address, linking it",
  }
  return `It would sign in ${email} to ${how[String(r.path)] ?? "their account"} as ${role}.`
}

/** The newest passed run within the day, if any. */
export function latestPass(runs: TestRun[], now: number): TestRun | null {
  return (
    runs.find(
      (r) => r.outcome === "passed" && now - new Date(r.createdAt).getTime() < DAY_MS,
    ) ?? null
  )
}
