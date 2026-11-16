import type { Problem } from "@repo/ui/checks"

/**
 * What the Create mailbox dialog needs to decide before and after it asks the
 * API: the local part rule, the storage field, and the words for a refusal.
 *
 * ⚠ THE LOCAL PART RULE IS THE API'S OWN, COPIED. `POST /mailboxes` itself only
 * asks that the address could be one (`mailboxAddressSchema`), but the one rule
 * the API applies to a local part it derives for somebody (`on-join.ts`,
 * `SAFE_LOCAL_PART` and `MAX_LOCAL_PART`) is the safe subset every mail client
 * accepts, so the dialog asks for exactly that. It is the early, friendly half;
 * the API still decides.
 */

/** The longest local part RFC 5321 allows. Same as the API's `MAX_LOCAL_PART`. */
export const MAX_LOCAL_PART = 64

/** Letters and digits, with single dots, hyphens or underscores between them. */
const SAFE_LOCAL_PART = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/

/** What to say about a local part, or `null` when it is fine. Case is ignored. */
export function localPartProblem(value: string): Problem | null {
  const local = value.trim().toLowerCase()
  if (local.length > MAX_LOCAL_PART) {
    return `Keep it to ${MAX_LOCAL_PART} characters or fewer.`
  }
  if (/\s/.test(local)) return "No spaces. Use a dot or a hyphen instead."
  if (local.includes("@")) {
    return "Only the part before the @. The domain is chosen next to it."
  }
  if (!SAFE_LOCAL_PART.test(local)) {
    return "Use letters, numbers, dots, hyphens or underscores, and start and end with a letter or number."
  }
  return null
}

const BYTES_PER_GB = 1024 ** 3

/** Whole bytes for a number of gigabytes typed into the dialog, or `null` when it is not a usable amount. */
export function gigabytesToBytes(text: string): number | null {
  const trimmed = text.trim().replace(",", ".")
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null
  const bytes = Math.round(Number(trimmed) * BYTES_PER_GB)
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null
}

/** The storage pool as `/console/mailboxes` reports it. */
export interface PoolShape {
  kind: "pool" | "uncapped"
  remaining: number | null
}

/**
 * Whether the dialog asks for storage.
 *
 *   - `required`: a prepaid pool the admin splits, so every mailbox needs a share.
 *   - `optional`: pay as you go, where a number is only a cap.
 *   - `none`: a member creating their own. Sizing an inbox is an owner or admin's
 *     act, and the API refuses a member who sends one.
 */
export function storageField(
  pool: PoolShape,
  actor: "admin" | "self",
): "required" | "optional" | "none" {
  if (actor === "self") return "none"
  return pool.kind === "pool" ? "required" : "optional"
}

/** What is wrong with a storage amount typed in gigabytes, or `null`. */
export function storageProblem(
  text: string,
  remaining: number | null,
  format: (bytes: number) => string,
): Problem | null {
  const bytes = gigabytesToBytes(text)
  if (bytes === null) return "Enter a number of gigabytes greater than zero, like 5."
  if (remaining !== null && bytes > remaining) {
    return `That is more than is left in your pool (${format(remaining)}).`
  }
  return null
}

/** The refusal as the console receives it from a server action. */
export interface Refusal {
  error: string
  name: string
  status: number
}

/**
 * A refusal in words for somebody who has never seen an HTTP status.
 *
 * ⚠ KEYED ON `name`, WITH THE STATUS ONLY WHERE IT DISAMBIGUATES. `invalid_access`
 * is a 401 from a signed-out session and a 403 from "you may not create this",
 * and the console's toast table reads it as "please sign in again" for both.
 * Here the 403 is the permission it is.
 *
 * ⚠ THE API'S SENTENCE IS KEPT WHERE IT ALREADY SAYS WHAT TO DO, because it was
 * written for this person (it names the address that is taken or the setting to
 * turn on); what is added is the next step it leaves out.
 */
export function mailboxRefusal(failure: Refusal, actor: "admin" | "self"): string {
  switch (failure.name) {
    case "mailbox_already_exists":
      return `${trim(failure.error)} Choose a different address or person.`
    case "password_required":
      return `${trim(failure.error)} Once that is done, try again.`
    case "mail_signin_off":
      return trim(failure.error)
    case "plan_limit_exceeded":
      return `${trim(failure.error)} Upgrade your plan or delete a mailbox to make room.`
    case "invalid_access":
      return failure.status === 401
        ? "Your session ended. Sign in again, then try again."
        : trim(failure.error)
    case "forbidden":
      return actor === "admin"
        ? "Only an owner or admin can create a mailbox for someone else."
        : trim(failure.error)
    case "not_found":
      return "That person is not a member of this workspace any more. Pick someone else."
    case "validation_error":
      return trim(failure.error)
    default:
      break
  }
  if (failure.status === 401)
    return "Your session ended. Sign in again, then try again."
  if (failure.status === 429) {
    return "You are doing that too fast. Wait a moment, then try again."
  }
  if (failure.status >= 500) {
    return "We could not create the mailbox because of a problem on our side. Nothing was created. Try again in a minute."
  }
  return failure.error.trim()
    ? trim(failure.error)
    : "The mailbox could not be created. Check the details and try again."
}

/** One sentence ends in exactly one full stop. */
function trim(sentence: string): string {
  const text = sentence.trim()
  return /[.!?]$/.test(text) ? text : `${text}.`
}

/** The member's mailbox address by user id, from the list the page already has. */
export function addressesByOwner(
  mailboxes: readonly { address: string; owner: { userId?: string | null } }[],
): Map<string, string> {
  const held = new Map<string, string>()
  for (const mailbox of mailboxes) {
    if (mailbox.owner.userId) held.set(mailbox.owner.userId, mailbox.address)
  }
  return held
}
