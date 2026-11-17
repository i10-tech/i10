import { ApiRequestError, type ApiError } from "./api-error"
import type { TeamInbox } from "./team-inbox"

/**
 * Preview fixtures for the Team inboxes screens. See lib/preview.ts.
 *
 * ⚠ ONE INBOX FOR EACH SHAPE THE SCREENS HAVE TO HANDLE: nine members (a long
 * list, with one whose mailbox is on payment hold), a single member, no display
 * name, a member whose mailbox was never set up (so a save is refused by name),
 * and one that was deleted elsewhere. A preview where every inbox is tidy shows
 * none of the wording worth reading.
 *
 * ⚠ WHAT EACH REFUSAL IS REACHED BY, so every sentence can be read:
 *
 *   - create, by the local part typed: `taken` (409), `unverified` (422, a
 *     domain this workspace has not verified), `forbidden` (403, the role
 *     changed since the page loaded) and `down` (503);
 *   - members, by saving `legal@acme.com`, whose member `dan@acme.dev` has a
 *     mailbox that was never set up: the save is refused naming him until he is
 *     removed;
 *   - delete, by `legal@acme.com` again (503, the mail server did not answer);
 *   - `hello@mail.acme.dev` answers 404 to a save or a delete, as an inbox
 *     somebody else deleted since this page loaded would.
 *
 * `?empty=1` on /team-inboxes shows the workspace with none.
 */

type Query = Record<string, string | number | undefined | null> | undefined
type Route = [
  RegExp,
  (match: RegExpMatchArray, query: Query, method: string, body?: unknown) => unknown,
]

const apiError = (statusCode: number, name: string, message: string) =>
  new ApiRequestError(statusCode, { statusCode, name, message } as ApiError)

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()

/** The domains this preview workspace has verified for mail. */
const VERIFIED = ["acme.com", "mail.acme.dev", "sending.acme.io"]

/**
 * Mailboxes the directory has but marks not active: `dan` was never set up and
 * the other two are being deleted. A save naming one is refused. A suspended or
 * payment-held mailbox is active to the directory, so it is accepted, as in the API.
 */
const NOT_ACTIVE = new Set(["dan", "hank", "lena"])

const inbox = (
  address: string,
  displayName: string | null,
  members: string[],
  days: number,
): TeamInbox => ({
  object: "team_inbox",
  address,
  display_name: displayName,
  members: members.map((member) => ({ address: member })),
  created_at: ago(days),
})

const localOf = (address: string) => address.split("@")[0] ?? ""

export function teamInboxRoutes(): Route[] {
  const data: TeamInbox[] = [
    inbox(
      "support@acme.com",
      "Support Team",
      [
        "alice@acme.dev",
        "bob@acme.dev",
        "noah@acme.dev",
        "priya@acme.dev",
        "marco@acme.dev",
        "sofia@acme.dev",
        "tomas@acme.dev",
        "yuki@acme.dev",
        "zara@acme.dev",
      ],
      40,
    ),
    inbox("sales@acme.com", "Sales", ["alice@acme.dev"], 12),
    inbox("billing@acme.com", "Billing", ["alice@acme.dev"], 50),
    inbox("hello@mail.acme.dev", null, ["alice@acme.dev", "noah@acme.dev"], 3),
    inbox("legal@acme.com", "Legal", ["alice@acme.dev", "dan@acme.dev"], 90),
  ]

  const find = (address: string): TeamInbox => {
    const found = data.find((i) => i.address === address)
    if (!found || address === "hello@mail.acme.dev") {
      throw apiError(404, "not_found", "No such team inbox.")
    }
    return found
  }

  /** The refusals a member list can meet, by who is in it. */
  function checkMembers(members: string[]) {
    if (members.length === 0) {
      throw apiError(422, "validation_error", "Too small: expected at least 1 member.")
    }
    for (const address of members) {
      if (NOT_ACTIVE.has(localOf(address))) {
        throw apiError(422, "validation_error", `${address} is not an active mailbox.`)
      }
    }
  }

  function create(body: unknown) {
    const input = (body ?? {}) as {
      address?: string
      display_name?: string
      members?: string[]
    }
    const address = (input.address ?? "").toLowerCase()
    const [local = "", domain = ""] = address.split("@")
    switch (local) {
      case "forbidden":
        throw apiError(403, "forbidden", "Only an admin can manage team inboxes.")
      case "down":
        throw apiError(503, "service_unavailable", "The mail server did not answer.")
      case "taken":
        throw apiError(
          409,
          "team_inbox_already_exists",
          "That address is already taken.",
        )
    }
    if (!VERIFIED.includes(domain) || local === "unverified") {
      throw apiError(
        422,
        "validation_error",
        `This workspace has not verified ${domain}.`,
      )
    }
    if (data.some((i) => i.address === address)) {
      throw apiError(409, "team_inbox_already_exists", "That address is already taken.")
    }
    checkMembers(input.members ?? [])

    const created = inbox(address, input.display_name ?? null, input.members ?? [], 0)
    data.push(created)
    return created
  }

  return [
    [
      /^\/console\/team-inboxes$/,
      (_m, query, method, body) => {
        if (method === "POST") return create(body)
        const empty = query?.empty === "1" || query?.empty === 1
        return { data: empty ? [] : data }
      },
    ],
    // ⚠ ONLY AN ADDRESS (it has an `@`, encoded or not), as the mailbox routes do.
    [
      /^\/console\/team-inboxes\/([^/]*(?:%40|@)[^/]*)\/members$/,
      (match, _query, _method, body) => {
        const found = find(decodeURIComponent(match[1]!))
        const members = ((body ?? {}) as { members?: string[] }).members ?? []
        checkMembers(members)
        found.members = members.map((address) => ({ address }))
        return found
      },
    ],
    [
      /^\/console\/team-inboxes\/([^/]*(?:%40|@)[^/]*)$/,
      (match, _query, method) => {
        const address = decodeURIComponent(match[1]!)
        if (method !== "DELETE") return find(address)
        const found = find(address)
        if (address === "legal@acme.com") {
          throw apiError(503, "service_unavailable", "The mail server did not answer.")
        }
        data.splice(data.indexOf(found), 1)
        return undefined
      },
    ],
  ]
}
