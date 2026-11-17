import type { ConsoleMailbox } from "@/lib/mailbox-view"
import type { DomainSummary } from "@/lib/types"

/**
 * What the Team inboxes pages decide before and after they ask the API: the
 * shape it sends, who can be picked, and the words for every refusal.
 *
 * ⚠ MIRRORED, NOT IMPORTED, like `ConsoleMailbox`: the console never depends on
 * `@repo/contracts`, whose schemas would put zod in the browser bundle. The
 * source is `teamInboxSchema` in packages/contracts/src/team-inbox.ts.
 *
 * ⚠ A MEMBER IS A MAILBOX ADDRESS, NEVER A USER ID. That is the API's rule: the
 * server turns an address into a person and checks both that the mailbox is
 * live and that its owner is in this workspace. So the picker offers mailboxes,
 * and the people it lists are the ones who already hold one.
 */

/** A team inbox as `GET /console/team-inboxes` sends it. */
export interface TeamInbox {
  object: "team_inbox"
  address: string
  display_name: string | null
  members: { address: string }[]
  created_at: string
}

/** The most members one team inbox holds. `setTeamInboxMembersSchema` in @repo/contracts. */
export const MEMBER_LIMIT = 100

/** One line on how people use a team inbox, said wherever its members are shown. */
export const HOW_MEMBERS_USE_IT =
  "Members read it in their own mail app, next to their personal mailbox, and reply as it by choosing this address as the sender. What they send also lands in the team's Sent folder shortly after."

/** What deleting one does to the mail, said in the dialog and on the page. */
export const DELETE_EFFECT =
  "This destroys the team's shared mailbox and everything in it: the mail it received and its Sent folder. The address stops accepting mail right away, and people who write to it get a bounce. Members' own mailboxes are not touched. This cannot be undone."

/** The name to show for an inbox: the one it was given, else its address. */
export function inboxName(inbox: Pick<TeamInbox, "address" | "display_name">): string {
  return inbox.display_name?.trim() || inbox.address
}

/** "1 member", "12 members". */
export function memberCount(count: number): string {
  return count === 1 ? "1 member" : `${count} members`
}

/** A person who can be put in a team inbox: somebody with a live mailbox. */
export interface Candidate {
  address: string
  name: string
}

const NO_CANDIDATES: Candidate[] = []

/**
 * The people the picker offers, from the workspace's mailboxes.
 *
 * ⚠ EVERYONE BUT THE TWO THE API WOULD REFUSE OR THAT HAVE NO FUTURE. The API's
 * check is the directory's `active` flag (`people` in
 * apps/api/src/team-inboxes/service.ts), which fails only for a mailbox that was
 * never set up (`inactive`). A suspended or payment-held mailbox passes it, so it
 * is offered: the person is a member who cannot sign in yet, which is the same
 * thing the Mailboxes page already says about them. A mailbox being deleted is
 * left out as well, since adding somebody who is about to go is never wanted.
 *
 * ⚠ SORTED BY NAME, because the list arrives in creation order and a person
 * looks for a name, not for who was added first.
 */
export function candidatesFrom(mailboxes: readonly ConsoleMailbox[]): Candidate[] {
  if (mailboxes.length === 0) return NO_CANDIDATES
  return mailboxes
    .filter((mailbox) => mailbox.status !== "inactive" && mailbox.status !== "deleting")
    .map((mailbox) => ({
      address: mailbox.address,
      name: mailbox.owner.name ?? mailbox.displayName ?? mailbox.address,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address))
}

/** The hosted domains: mailbox hosting on, and this workspace the one that proved it. Same rule as Mailboxes. */
export function hostedDomainNames(domains: readonly DomainSummary[]): string[] {
  return domains
    .filter((domain) => domain.mailboxes?.enabled && domain.mailboxes.owned)
    .map((domain) => domain.name)
}

/** Whether two member lists hold the same addresses, in any order. */
export function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((address) => set.has(address))
}

/** What is wrong with a member list, or `null`. */
export function membersProblem(members: readonly string[]): string | null {
  if (members.length === 0) return "A team inbox needs at least one member."
  if (members.length > MEMBER_LIMIT) {
    return `A team inbox can have up to ${MEMBER_LIMIT} members.`
  }
  return null
}

/** The members a save would take out, for the line that says they lose access at once. */
export function removedMembers(
  before: readonly string[],
  after: readonly string[],
): string[] {
  const keep = new Set(after)
  return before.filter((address) => !keep.has(address))
}

/** Adds an address once, at the end. */
export function withMember(members: readonly string[], address: string): string[] {
  return members.includes(address) ? [...members] : [...members, address]
}

/** Takes an address out. */
export function withoutMember(members: readonly string[], address: string): string[] {
  return members.filter((member) => member !== address)
}

/** The refusal as the console receives it from a server action. */
export interface TeamInboxFailure {
  error: string
  name: string
  status: number
}

export type TeamInboxAction = "create" | "members" | "delete"

/** One sentence ends in exactly one full stop. */
function sentence(text: string): string {
  const value = text.trim()
  return /[.!?]$/.test(value) ? value : `${value}.`
}

const DOING: Record<TeamInboxAction, string> = {
  create: "create the team inbox",
  members: "save the members",
  delete: "delete the team inbox",
}

/** What the failed attempt left behind, which is the first thing somebody wants to know. */
const LEFT: Record<TeamInboxAction, string> = {
  create: "Nothing was created.",
  members: "Your changes were not saved.",
  delete: "Nothing was deleted.",
}

/** The title of the alert a refusal sits in. */
export function refusalTitle(action: TeamInboxAction): string {
  switch (action) {
    case "create":
      return "Could not create the team inbox"
    case "members":
      return "Could not save the members"
    case "delete":
      return "Could not delete the team inbox"
  }
}

/**
 * The API's 422 sentences name an address and what is wrong with it. Each is
 * given its next step here, because the person reading is an admin who has
 * never seen the directory behind it.
 *
 * ⚠ MATCHED ON THE SENTENCE'S TAIL, AS THE API WRITES IT (`people` and `create`
 * in apps/api/src/team-inboxes/service.ts), and anything that does not match is
 * shown as the API said it. A reworded API sentence therefore degrades to the
 * API's own words, never to a blank or to a code.
 */
function rejected(message: string): string {
  const inactive = /^(.+) is not an active mailbox\.?$/.exec(message.trim())
  if (inactive) {
    return `${inactive[1]} cannot be a member yet because their mailbox is not active. It may still be getting set up, or it may have been deleted. Remove them from the list, or try again once the mailbox is active.`
  }
  const outside = /^(.+) is not a member of this workspace\.?$/.exec(message.trim())
  if (outside) {
    return `${outside[1]} is not a member of this workspace, so they cannot be in a team inbox. Remove them from the list.`
  }
  const unverified = /^This workspace has not verified (.+?)\.?$/.exec(message.trim())
  if (unverified) {
    return `${unverified[1]} is not verified for this workspace, so a team inbox cannot use it. Check the domain on the Domains page.`
  }
  if (/^Team inboxes need a team workspace\.?$/.test(message.trim())) {
    return "Team inboxes are only available in a team workspace. Switch to one, or create a team workspace first."
  }
  return sentence(message)
}

/**
 * A refusal in words for somebody who has never seen an HTTP status.
 *
 * ⚠ KEYED ON `name`, WITH THE STATUS ONLY WHERE IT DISAMBIGUATES. `invalid_access`
 * is a 401 from a signed-out session and a 403 from "you may not", and the
 * console's toast table reads both as "sign in again". A 403 here is the
 * permission it is: only an owner or admin manages a team inbox, and the API
 * never asks a member to step up, it just says no.
 */
export function teamInboxRefusal(
  failure: TeamInboxFailure,
  action: TeamInboxAction,
): string {
  switch (failure.name) {
    case "team_inbox_already_exists":
      return "That address is already taken by a mailbox, an alias or another team inbox. Choose a different address."
    case "validation_error":
      return rejected(failure.error)
    case "forbidden":
      return "Only an owner or admin can create, change or delete a team inbox."
    case "not_found":
      return action === "create"
        ? "That domain is not available for team inboxes in this workspace."
        : "This team inbox no longer exists. Someone may have deleted it."
    case "invalid_access":
      return failure.status === 401
        ? "Your session ended. Sign in again, then try again."
        : "Only an owner or admin can create, change or delete a team inbox."
    default:
      break
  }

  if (failure.status === 401)
    return "Your session ended. Sign in again, then try again."
  if (failure.status === 403) {
    return "Only an owner or admin can create, change or delete a team inbox."
  }
  if (failure.status === 429) {
    return "You are doing that too fast. Wait a moment, then try again."
  }
  if (failure.status === 501) {
    return "Team inboxes are not available on this deployment yet."
  }
  if (failure.status >= 500) {
    return `We could not ${DOING[action]} because of a problem on our side. ${LEFT[action]} Try again in a minute.`
  }
  return failure.error.trim()
    ? sentence(failure.error)
    : `We could not ${DOING[action]}. Check the details and try again.`
}
