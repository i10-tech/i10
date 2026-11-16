import { ApiRequestError, type ApiError } from "./api-error"

type Query = Record<string, string | number | undefined | null> | undefined
type Route = [
  RegExp,
  (match: RegExpMatchArray, query: Query, method: string, body?: unknown) => unknown,
]

/**
 * The workspace's people for the Create mailbox picker, where there is no Clerk
 * to list them. Four hold a mailbox below, two do not.
 */
export const PREVIEW_MEMBERS = [
  { id: "user_alice", name: "Alice Admin", email: "alice@acme.dev" },
  { id: "user_bob", name: "Bob Builder", email: "bob@acme.dev" },
  { id: "user_carol", name: "Carol Chen", email: "carol@acme.dev" },
  { id: "user_dan", name: "dan@acme.dev", email: "dan@acme.dev" },
  { id: "user_erin", name: "Erin Okafor", email: "erin@gmail.com" },
  { id: "user_frank", name: "Frank Moreau", email: "frank@outlook.com" },
]

/**
 * The refusals a create can meet, reached by the local part typed, so each
 * message can be reviewed: `taken`, `nopass`, `nosso`, `full`, `pool`, `gone`
 * and `role` (the member route's role-address refusal).
 */
function refusalFor(local: string, self: boolean): ApiRequestError | null {
  const refuse = (statusCode: number, name: string, message: string) =>
    new ApiRequestError(statusCode, { statusCode, name, message } as ApiError)
  switch (local) {
    case "taken":
      return refuse(409, "mailbox_already_exists", "That address is already taken.")
    case "nopass":
      return refuse(
        409,
        "password_required",
        self
          ? "Set a password on your account before creating a mailbox. Mail clients sign in with it, and accounts without one cannot."
          : "This person has no password on their account. Mail clients sign in with one, so they need to set a password first.",
      )
    case "nosso":
      return refuse(
        409,
        "mail_signin_off",
        'This person signs in with single sign-on, and mail sign-in is not turned on for their connection yet. Turn it on on the SSO connection page (Settings, Single sign-on, the connection, "Mail sign-in").',
      )
    case "full":
      return refuse(
        403,
        "plan_limit_exceeded",
        "You have used every mailbox your plan includes.",
      )
    case "pool":
      return refuse(
        403,
        "plan_limit_exceeded",
        "That is more storage than is left in your pool.",
      )
    case "gone":
      return refuse(404, "not_found", "No such member in this workspace.")
    case "role":
      return refuse(
        403,
        "invalid_access",
        "role@acme.dev is a role address. Ask an owner or admin to create it.",
      )
    case "members":
      return refuse(
        403,
        "invalid_access",
        "Only an owner or admin of this workspace creates mailboxes. Ask one to create yours.",
      )
    default:
      return null
  }
}

interface PreviewMailbox {
  address: string
  displayName: string | null
  owner: { userId: string; clerkUserId: string; name: string | null; email: string }
  domain: string
  status: string
  signIn: string
  aliases: string[]
  storage: {
    allocatedBytes: number | null
    usedBytes: number | null
    usedAt: string | null
  }
  createdAt: string
  updatedAt: string
}

export function mailboxRoutes(_notFound: unknown): Route[] {
  void _notFound
  const data: PreviewMailbox[] = [
    {
      address: "alice@acme.dev",
      displayName: "Alice Admin",
      owner: {
        userId: "user_alice",
        clerkUserId: "user_alice",
        name: "Alice Admin",
        email: "alice@acme.dev",
      },
      domain: "acme.dev",
      status: "active",
      signIn: "password",
      aliases: [],
      storage: {
        allocatedBytes: 5368709120,
        usedBytes: 1234567890,
        usedAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      address: "bob@acme.dev",
      displayName: "Bob Builder",
      owner: {
        userId: "user_bob",
        clerkUserId: "user_bob",
        name: "Bob Builder",
        email: "bob@acme.dev",
      },
      domain: "acme.dev",
      status: "payment_hold",
      signIn: "oidc",
      aliases: [],
      storage: {
        allocatedBytes: 2147483648,
        usedBytes: 2000000000,
        usedAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      address: "carol@acme.dev",
      displayName: "Carol Chen",
      owner: {
        userId: "user_carol",
        clerkUserId: "user_carol",
        name: "Carol Chen",
        email: "carol@acme.dev",
      },
      domain: "acme.dev",
      status: "sso_required",
      signIn: "off",
      aliases: [],
      storage: { allocatedBytes: null, usedBytes: 0, usedAt: null },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      address: "dan@acme.dev",
      displayName: null,
      owner: {
        userId: "user_dan",
        clerkUserId: "user_dan",
        name: null,
        email: "dan@acme.dev",
      },
      domain: "acme.dev",
      status: "inactive",
      signIn: "off",
      aliases: [],
      storage: { allocatedBytes: 1073741824, usedBytes: null, usedAt: null },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ]

  /** A create that works adds the row, so the list can be seen to change. */
  function createdFrom(body: unknown, self: boolean) {
    const input = (body ?? {}) as {
      user_id?: string
      address?: string
      display_name?: string
      storage_allocation?: number
    }
    const address = input.address ?? ""
    const refused = refusalFor(address.split("@")[0] ?? "", self)
    if (refused) throw refused
    const person = PREVIEW_MEMBERS.find((m) => m.id === input.user_id)
    const now = new Date().toISOString()
    data.push({
      address,
      displayName: input.display_name ?? person?.name ?? null,
      owner: {
        userId: person?.id ?? "user_you",
        clerkUserId: person?.id ?? "user_you",
        name: person?.name ?? "You",
        email: person?.email ?? "you@acme.dev",
      },
      domain: address.split("@")[1] ?? "",
      status: "active",
      signIn: "password",
      aliases: [],
      storage: {
        allocatedBytes: input.storage_allocation ?? null,
        usedBytes: null,
        usedAt: null,
      },
      createdAt: now,
      updatedAt: now,
    })
    return {
      object: "mailbox",
      address,
      display_name: input.display_name ?? null,
      active: true,
      created_at: now,
      storage_allocated: input.storage_allocation ?? null,
    }
  }

  return [
    [
      /^\/mailboxes$/,
      (_m, _query, method, body) =>
        method === "POST" ? createdFrom(body, true) : { data: [] },
    ],
    [
      /^\/console\/mailboxes$/,
      (_m, query, method, body) => {
        if (method === "POST") return createdFrom(body, false)
        const empty = query?.empty === "1" || query?.empty === 1
        return {
          data: empty ? [] : data,
          pool: {
            kind: "pool",
            total: 10737418240,
            allocated: data.reduce((s, m) => s + (m.storage.allocatedBytes ?? 0), 0),
            used: 3234567890,
            remaining: 5368709120,
            unallocated: 1,
          },
          nextCursor: null,
        }
      },
    ],
  ]
}
