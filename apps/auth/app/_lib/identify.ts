import type { FlowError } from "./clerk-types"
import { isUnknownIdentifier } from "./errors"

/**
 * Where the email step goes once Clerk has been asked about an address.
 *
 * ⚠ SPLIT OUT OF THE FORM SO THE ORDER OF THE QUESTIONS IS TESTABLE, because
 * the order is the fix. An address with its own account signs in, whatever it
 * looks like - Clerk lets an existing subaddress account keep signing in. Only
 * an address with NO account is checked against the inbox rule below, and that
 * check comes before both ways into a sign-up (the SSO screen's "Create an
 * account with a password" and the wizard itself), so neither leads to a
 * refusal four screens later.
 */
export type Identified =
  | { to: "account" }
  | { to: "sso" }
  | { to: "sign-up"; error: FlowError }
  | { to: "refused"; reason: string }
  | { to: "error"; error: FlowError }

export async function identify(
  address: string,
  {
    find,
    ssoAvailable,
    blockSubaddresses,
  }: {
    /** Clerk's lookup: `null` when the address has an account, else its error. */
    find: (address: string) => Promise<FlowError | null>
    /** Home realm discovery offered company SSO beside the usual ways in. */
    ssoAvailable: boolean
    /** `block_email_subaddresses` on the Clerk instance. */
    blockSubaddresses: boolean
  },
): Promise<Identified> {
  const error = await find(address)
  if (!error) return { to: "account" }
  if (!isUnknownIdentifier(error)) return { to: "error", error }

  if (blockSubaddresses) {
    const base = inboxBase(address)
    // ⚠ ONLY A CLEAN "FOUND" REFUSES. A failed second lookup lets the sign-up
    // go ahead: Clerk still checks at "Create account", and the wizard sends a
    // refusal from there back to this step.
    if (base && (await find(base)) === null) {
      return {
        to: "refused",
        reason: `That inbox already has an account as ${base}. Use that address.`,
      }
    }
  }

  return ssoAvailable ? { to: "sso" } : { to: "sign-up", error }
}

/**
 * The address Clerk's "Block email subaddresses" protection compares against,
 * or `null` when the address is already its own base.
 *
 * ⚠ THE RULE IS NOT "NO + IN THE ADDRESS". Clerk's docs
 * (clerk.com/docs/guides/protect/protections/block-email-subaddresses, updated
 * 2026-11-18): "Clerk removes the subaddress and checks whether the resulting
 * base address is already registered. If it is, the new address is blocked."
 * And: "The first sign-up for a base address is allowed, even if it uses a
 * subaddress." Probed on the dev instance on 2026-11-20: `zq7probe+tag@example.com`
 * was accepted; `alice+x@` and `alice=x@` were refused (`not_allowed_access`)
 * because `alice@` has an account.
 *
 * The separators, from the same page:
 *   Gmail (`gmail.com`, `googlemail.com`): `+`, `=`, `#`, and dots in the
 *     local part are ignored.
 *   Yahoo's own domains: `+`, `=`, `#`, `-`. Not "domains that merely begin
 *     with a `yahoo` label, such as `yahoo.dev`".
 *   Every other domain: `+`, `=`, `#`.
 *
 * ⚠ A GMAIL ACCOUNT STORED WITH DOTS IS NOT FOUND THIS WAY. The base drops the
 * dots, and Clerk's lookup matches the stored address. That case still reaches
 * "Create account", where Clerk refuses it and the person is sent back here.
 */
export function inboxBase(address: string): string | null {
  const at = address.lastIndexOf("@")
  if (at <= 0) return null

  const domain = address.slice(at + 1).toLowerCase()
  const local = address.slice(0, at).toLowerCase()

  const gmail = domain === "gmail.com" || domain === "googlemail.com"
  const separators = isYahoo(domain) ? /[+=#-]/ : /[+=#]/
  const cut = local.search(separators)
  let base = cut === -1 ? local : local.slice(0, cut)
  if (gmail) base = base.replaceAll(".", "")

  if (base === "" || base === local) return null
  return `${base}@${domain}`
}

const YAHOO = new Set(["yahoo.com", "ymail.com", "rocketmail.com", "y7mail.com"])

/** Yahoo's own domains and its country domains (`yahoo.fr`, `yahoo.co.uk`, `yahoo.com.br`). */
function isYahoo(domain: string): boolean {
  return YAHOO.has(domain) || /^yahoo\.(?:(?:co|com)\.)?[a-z]{2}$/.test(domain)
}
