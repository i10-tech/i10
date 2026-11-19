import type { Problem } from "@repo/ui/checks"
import type { ActionRefusal, ConsoleMailbox } from "@/lib/mailbox-view"

/**
 * What the aliases section of a mailbox's page says and decides: the shape the
 * API sends, where each alias came from in plain words, whether adding is open
 * and why not, and the words for a refusal.
 *
 * ⚠ MIRRORED, NOT IMPORTED, for the reason `lib/mailbox-view.ts` gives. The
 * source is `MailboxAlias` and `MAILBOX_ALIAS_LIMIT` in packages/contracts/src/
 * mailbox.ts; the one value copied by hand is the limit below, and the list
 * response carries it too, which is the number the page actually uses.
 */

/** The most aliases one mailbox may be given in the console. `MAILBOX_ALIAS_LIMIT` in @repo/contracts. */
export const ALIAS_LIMIT = 30

/** From this many console aliases on, the page says how many are left. */
export const ALIAS_COUNT_SHOWN_FROM = ALIAS_LIMIT - 5

export type AliasSource = "console" | "clerk" | "directory"

export interface MailboxAlias {
  address: string
  source: AliasSource
  /** Whether the API removes it: only one an owner or admin added here. */
  removable?: boolean
}

export interface MailboxAliasList {
  data: MailboxAlias[]
  /** The most console aliases one mailbox may have. */
  limit: number
}

/** What a list that could not be read, or has nothing in it, shares. One value, not a new array per render. */
export const NO_ALIASES: readonly MailboxAlias[] = []

/** Where an alias came from, in the words an admin knows the places by. */
export function aliasSourceNote(source: AliasSource): string {
  switch (source) {
    case "console":
      return "Added here"
    case "clerk":
      return "From the person's account. They remove it there."
    case "directory":
      return "From your directory. Remove it there."
  }
}

/** How many of the aliases an owner or admin added here, which is what the limit counts. */
export function consoleAliasCount(aliases: readonly MailboxAlias[]): number {
  return aliases.filter((alias) => alias.source === "console").length
}

/** The line about the limit, or `null` while there is plenty of room. */
export function aliasCountLine(added: number, limit: number): string | null {
  if (added < Math.min(ALIAS_COUNT_SHOWN_FROM, limit)) return null
  return `${added} of ${limit} aliases added here.`
}

/**
 * Why Add alias is not available right now, or `null` when it is.
 *
 * ⚠ A DELETING MAILBOX FIRST: the API refuses an add to one (`mailbox_deleting`)
 * because the purge would give the alias back within days, and that is the reason
 * worth hearing even when a domain is also missing. Removing is not affected, and
 * the sentence says so.
 */
export function addAliasBlock(input: {
  status: ConsoleMailbox["status"]
  added: number
  limit: number
  domains: readonly string[]
}): string | null {
  if (input.status === "deleting") {
    return "This mailbox is being deleted, so nothing can be added to it. Restore it first. Removing an alias still works."
  }
  if (input.added >= input.limit) {
    return `A mailbox can have ${input.limit} aliases added here, and this one has them all. Remove one to add another.`
  }
  if (input.domains.length === 0) {
    return "No domain in this workspace hosts mailboxes right now. Turn it on for a domain first, then add the alias."
  }
  return null
}

/**
 * The note under the aliases list, for whoever may add: why Add alias is closed,
 * or how near the limit the mailbox is. At most one of the two; both null for a
 * member and where the list could not be read.
 */
export function aliasNotes(input: {
  mailbox: Pick<ConsoleMailbox, "status">
  list: MailboxAliasList | null
  domains: readonly string[]
  isAdmin: boolean
}): { block: string | null; countLine: string | null } {
  const { list } = input
  if (!input.isAdmin || !list) return { block: null, countLine: null }
  const added = consoleAliasCount(list.data)
  const block = addAliasBlock({
    status: input.mailbox.status,
    added,
    limit: list.limit,
    domains: input.domains,
  })
  // ⚠ NOT WHILE THE REASON IS SHOWN: at the limit the reason already says it.
  return { block, countLine: block ? null : aliasCountLine(added, list.limit) }
}

/** The longest local part RFC 5321 allows. Same as the API's. */
export const MAX_ALIAS_LOCAL_PART = 64

/**
 * The API's own rule for the part before the @ (`mailboxAliasAddressSchema`):
 * letters, digits, dots, hyphens and underscores; it starts and ends with a letter
 * or digit; never two dots in a row; at most 64. Case is ignored, as the API
 * lowercases.
 *
 * ⚠ NOT THE CREATE DIALOG'S RULE (`localPartProblem`), WHICH IS STRICTER: that one
 * also refuses `a__b`, which an alias may be. Using it here would turn away
 * addresses the API accepts, so this is the API's rule, said in words.
 *
 * ⚠ A `+` GETS ITS OWN SENTENCE. The mail server strips everything from a `+` on
 * before it looks an address up, so such an alias would be accepted and then never
 * receive anything; an admin who types one is told why it is not offered rather
 * than that a character is "not allowed".
 */
export function aliasLocalProblem(value: string): Problem | null {
  const local = value.trim().toLowerCase()
  if (local.length > MAX_ALIAS_LOCAL_PART) {
    return `Keep it to ${MAX_ALIAS_LOCAL_PART} characters or fewer.`
  }
  if (/\s/.test(local)) return "No spaces. Use a dot or a hyphen instead."
  if (local.includes("@")) {
    return "Only the part before the @. The domain is chosen next to it."
  }
  if (local.includes("+")) {
    return "A plus sign cannot be used. Mail servers ignore everything after it, so mail to that address would never arrive."
  }
  if (local.includes("..")) return "No two dots in a row."
  if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(local)) {
    return "Use letters, numbers, dots, hyphens or underscores, and start and end with a letter or number."
  }
  return null
}

/** The address a typed part and a domain make. Case is ignored. */
export function aliasAddress(local: string, domain: string): string {
  return `${local.trim().toLowerCase()}@${domain}`
}

/**
 * The domain the Add dialog starts on: the mailbox's own when this workspace
 * hosts mail on it, since most aliases are another spelling of the same name,
 * otherwise the first it does host. Empty when there is none.
 */
export function defaultAliasDomain(hosted: readonly string[], own: string): string {
  return hosted.includes(own) ? own : (hosted[0] ?? "")
}

export type AliasAction = "add" | "remove"

const DOING: Record<AliasAction, string> = {
  add: "add the alias",
  remove: "remove the alias",
}

/** The heading of the alert a refused add or remove puts in its dialog. */
export function aliasRefusalTitle(action: AliasAction): string {
  return `Could not ${DOING[action]}`
}

/** One sentence ends in exactly one full stop. */
function sentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/**
 * A refusal in words for an admin who has never seen an HTTP status.
 *
 * ⚠ KEYED ON `name`, as `mailboxActionRefusal` is, and the two 404s are told apart
 * by the action: an add that finds no mailbox and a remove that finds no such alias
 * share `not_found`.
 *
 * ⚠ THE API'S SENTENCE IS KEPT WHERE IT ALREADY SAYS WHAT TO DO (the domain one
 * names the setting to turn on); what is replaced is the 422 that carries a schema
 * message, and the removal refusal, which says who removes it but not that this is
 * not a failure.
 */
export function aliasRefusal(failure: ActionRefusal, action: AliasAction): string {
  switch (failure.name) {
    case "alias_taken":
      return "That address is already in use by a mailbox, an alias or a list. Choose a different one."
    case "alias_limit_reached":
      return `A mailbox can have ${ALIAS_LIMIT} aliases added here, and this one has them all. Remove one to add another.`
    case "alias_not_removable":
      return "That address comes from the person's account or from your directory, so it is removed there, not here."
    case "mailbox_deleting":
      return "This mailbox is being deleted, so nothing can be added to it. Restore it first, or add the alias to another mailbox."
    case "validation_error":
      return sentence(failure.error)
    case "forbidden":
      return "Only an owner or admin can change aliases."
    case "invalid_access":
      return failure.status === 401
        ? "Your session ended. Sign in again, then try again."
        : sentence(failure.error)
    case "not_found":
      return action === "remove"
        ? "That address is no longer an alias of this mailbox. It may already have been removed."
        : "This mailbox no longer exists in this workspace."
    default:
      break
  }

  if (failure.status === 401)
    return "Your session ended. Sign in again, then try again."
  if (failure.status === 429) {
    return "You are doing that too fast. Wait a moment, then try again."
  }
  if (failure.status >= 500) {
    return `We could not ${DOING[action]} because of a problem on our side. Nothing was changed. Try again in a minute.`
  }
  return failure.error.trim()
    ? sentence(failure.error)
    : `We could not ${DOING[action]}. Try again.`
}
