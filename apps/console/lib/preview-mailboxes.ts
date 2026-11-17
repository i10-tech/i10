import { ApiRequestError, type ApiError } from "./api-error"
import { ALIAS_LIMIT, type AliasSource } from "./mailbox-aliases"

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
  deletion: {
    outcome: "delete" | "export_then_delete" | "forward"
    deletedAt: string
    purgeAt: string
    forwardTo: string | null
  } | null
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

const DAY = 86_400_000

/** `count` aliases the console added, `<local>.1@acme.dev` and on. */
function consoleAliases(local: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    address: `${local}.${i + 1}@acme.dev`,
    source: "console" as const,
  }))
}

/** A mailbox at `<first name>@acme.dev` for somebody who is not in `PREVIEW_MEMBERS`. */
function fixture(
  local: string,
  name: string,
  fields: {
    status: string
    allocatedBytes: number
    usedBytes: number
    deletion?: PreviewMailbox["deletion"]
  },
): PreviewMailbox {
  const now = new Date().toISOString()
  return {
    address: `${local}@acme.dev`,
    displayName: name,
    owner: {
      userId: `user_${local}`,
      clerkUserId: `user_${local}`,
      name,
      email: `${local}@acme.dev`,
    },
    domain: "acme.dev",
    status: fields.status,
    deletion: fields.deletion ?? null,
    signIn: "password",
    aliases: [],
    storage: {
      allocatedBytes: fields.allocatedBytes,
      usedBytes: fields.usedBytes,
      usedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  }
}

const apiError = (
  statusCode: number,
  name: string,
  message: string,
  extra: Record<string, unknown> = {},
) =>
  new ApiRequestError(statusCode, { statusCode, name, message, ...extra } as ApiError)

/**
 * Which workspace a page is shown as, from `?scenario=` on the page (see
 * app/(app)/mailboxes). Preview only: the pages pass it on solely when `PREVIEW`
 * is on, and it changes what `/console/me`, `/console/domains` and
 * `/console/mailboxes` answer so each state of the setup can be reviewed from
 * the keyboard.
 *
 *   - `setup`: an owner, a domain proven and hosting on, its mail not pointed at
 *     us yet, no mailbox.
 *   - `done`: an owner of a finished workspace (the default fixtures).
 *   - `member`: somebody who is not an admin, with one mailbox.
 *   - `member-empty`: the same member with no mailbox.
 *   - `payg`: the finished workspace on pay as you go storage.
 */
export type PreviewScenario = "setup" | "done" | "member" | "member-empty" | "payg"

const SCENARIOS: readonly PreviewScenario[] = [
  "setup",
  "done",
  "member",
  "member-empty",
  "payg",
]

export function previewScenario(query: Query): PreviewScenario | undefined {
  return SCENARIOS.find((name) => name === query?.scenario)
}

/** The mailbox the member scenarios give the reader. */
const MEMBER_ADDRESS = "noah@acme.dev"

/** The pool: 20 GB, of which the mailboxes below hold what they hold. */
const POOL_TOTAL = 21474836480

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
      deletion: null,
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
      deletion: null,
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
      deletion: null,
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
      deletion: null,
      signIn: "off",
      aliases: [],
      storage: { allocatedBytes: 1073741824, usedBytes: null, usedAt: null },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    // ⚠ THE LIFECYCLE STATES, so the page and the menu can be reviewed in each:
    // suspended and resumes cleanly, suspended and still held for payment,
    // deleting with a forward, and deleting with its restore window over.
    // A second live mailbox, so the delete dialog's forward picker has a choice.
    fixture("noah", "Noah Kim", {
      status: "active",
      allocatedBytes: 1073741824,
      usedBytes: 104857600,
    }),
    // More people who can be picked for a team inbox (see lib/preview-team-inboxes.ts).
    ...(
      [
        ["priya", "Priya Nair"],
        ["marco", "Marco Rossi"],
        ["sofia", "Sofia Lind"],
        ["tomas", "Tomas Novak"],
        ["yuki", "Yuki Tanaka"],
        ["zara", "Zara Haddad"],
      ] as const
    ).map(([local, name]) =>
      fixture(local, name, {
        status: "active",
        allocatedBytes: 536870912,
        usedBytes: 20971520,
      }),
    ),
    fixture("gwen", "Gwen Park", {
      status: "suspended",
      allocatedBytes: 1073741824,
      usedBytes: 314572800,
    }),
    fixture("ivan", "Ivan Petrov", {
      status: "suspended",
      allocatedBytes: 2147483648,
      usedBytes: 52428800,
    }),
    fixture("hank", "Hank Aaron", {
      status: "deleting",
      allocatedBytes: 1073741824,
      usedBytes: 734003200,
      deletion: {
        outcome: "forward",
        deletedAt: new Date(Date.now() - 8 * DAY).toISOString(),
        purgeAt: new Date(Date.now() + 22 * DAY).toISOString(),
        forwardTo: "alice@acme.dev",
      },
    }),
    fixture("lena", "Lena Fischer", {
      status: "deleting",
      allocatedBytes: 1073741824,
      usedBytes: 209715200,
      deletion: {
        outcome: "export_then_delete",
        deletedAt: new Date(Date.now() - 31 * DAY).toISOString(),
        purgeAt: new Date(Date.now() - DAY).toISOString(),
        forwardTo: null,
      },
    }),
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
      deletion: null,
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

  const allocated = (except?: string) =>
    data
      .filter((m) => m.address !== except)
      .reduce((sum, m) => sum + (m.storage.allocatedBytes ?? 0), 0)

  const pool = () => ({
    kind: "pool",
    total: POOL_TOTAL,
    allocated: allocated(),
    used: 3234567890,
    remaining: POOL_TOTAL - allocated(),
    unallocated: data.filter((m) => m.storage.allocatedBytes === null).length,
  })

  /** Who may create mailboxes. Held for the life of the dev server, like nothing else here. */
  let creationMode: "admins" | "members" | "on_join" = "admins"

  function find(address: string): PreviewMailbox {
    const mailbox = data.find((m) => m.address === address)
    if (!mailbox) throw apiError(404, "not_found", "No such mailbox in this workspace.")
    return mailbox
  }

  /**
   * The lifecycle routes. What each can be refused for is reached from the
   * keyboard, so every sentence can be reviewed:
   *
   *   - storage: more than the pool has left, or none on a prepaid pool;
   *   - resume: `ivan` is still held for payment after it, any other that is
   *     not suspended is refused;
   *   - delete: `bob` is a forward target (409), `dan` cannot export (501) and
   *     `carol`'s export fails to start (503), and a forward needs a live mailbox.
   */
  function lifecycle(address: string, action: string, body: unknown) {
    const mailbox = find(address)
    const now = new Date()
    const touch = () => {
      mailbox.updatedAt = now.toISOString()
      return { mailbox }
    }

    switch (action) {
      case "storage": {
        const bytes = (body as { storage_allocation?: number | null } | null)
          ?.storage_allocation
        if (bytes === null || bytes === undefined) {
          throw apiError(
            422,
            "validation_error",
            "Your plan's storage is a pool you split across inboxes, so every inbox needs an amount.",
          )
        }
        const remaining = POOL_TOTAL - allocated(address)
        if (bytes > remaining) {
          throw apiError(
            403,
            "plan_limit_exceeded",
            `That is more than is left in the pool: ${remaining} of ${POOL_TOTAL} bytes.`,
            { remaining, total: POOL_TOTAL },
          )
        }
        mailbox.storage.allocatedBytes = bytes
        return {
          mailbox: {
            address,
            display_name: mailbox.displayName,
            storage_allocated: bytes,
          },
          quota: "synced",
        }
      }

      case "suspend":
        if (mailbox.status === "deleting") {
          throw apiError(
            409,
            "mailbox_deleting",
            "That mailbox is being deleted already.",
          )
        }
        mailbox.status = "suspended"
        return touch()

      case "resume": {
        if (mailbox.status === "deleting") {
          throw apiError(
            409,
            "deleting",
            "That mailbox is being deleted. Restore it instead.",
          )
        }
        if (mailbox.status !== "suspended") {
          throw apiError(409, "not_suspended", "That mailbox is not suspended.")
        }
        const held = address.startsWith("ivan@")
        mailbox.status = held ? "payment_hold" : "active"
        return { ok: true, still_blocked: held ? ["payment_hold"] : [], ...touch() }
      }

      case "delete": {
        const choice = (body ?? {}) as { outcome?: string; forward_to?: string }
        if (mailbox.status === "deleting") {
          throw apiError(
            409,
            "already_deleting",
            "That mailbox is already being deleted.",
          )
        }
        if (address.startsWith("bob@")) {
          throw apiError(
            409,
            "forward_target_in_use",
            "Other addresses are forwarded to this mailbox. Move them first.",
          )
        }
        if (choice.outcome === "export_then_delete" && address.startsWith("dan@")) {
          throw apiError(
            501,
            "internal_server_error",
            "Mailbox export is not configured on this deployment.",
          )
        }
        if (choice.outcome === "export_then_delete" && address.startsWith("carol@")) {
          throw apiError(
            503,
            "application_error",
            "The export could not be started, so nothing was deleted. Try again.",
          )
        }
        if (choice.outcome === "forward") {
          const target = data.find((m) => m.address === choice.forward_to)
          if (!target || target.status !== "active" || target.address === address) {
            throw apiError(
              422,
              "validation_error",
              "forward_to must be another mailbox of this workspace that can sign in and receive mail.",
            )
          }
        }
        mailbox.status = "deleting"
        mailbox.deletion = {
          outcome: (choice.outcome ?? "delete") as "delete",
          deletedAt: now.toISOString(),
          purgeAt: new Date(now.getTime() + 30 * DAY).toISOString(),
          forwardTo: choice.outcome === "forward" ? (choice.forward_to ?? null) : null,
        }
        return touch()
      }

      case "restore":
        if (mailbox.status !== "deleting") {
          throw apiError(409, "not_deleting", "That mailbox is not being deleted.")
        }
        if (mailbox.deletion && Date.parse(mailbox.deletion.purgeAt) <= now.getTime()) {
          throw apiError(
            409,
            "restore_window_closed",
            "The 30 days to restore this mailbox are over, and it is being removed.",
          )
        }
        mailbox.status = "active"
        mailbox.deletion = null
        return touch()
    }
    return undefined
  }

  /**
   * The aliases of each mailbox, by address. `alice` has one of every kind, `noah`
   * is five short of the limit so the count line shows, `gwen` is at it so Add is
   * disabled with its reason, and `hank` (deleting) shows Add disabled while Remove
   * still works. Every other mailbox has none.
   */
  const aliasesOf = new Map<string, { address: string; source: AliasSource }[]>([
    [
      "alice@acme.dev",
      [
        { address: "admin@acme.dev", source: "console" },
        { address: "alice.admin@acme.dev", source: "clerk" },
        { address: "alice.a@acme.dev", source: "directory" },
        { address: "billing@acme.dev", source: "console" },
        { address: "hello@acme.com", source: "console" },
      ],
    ],
    ["noah@acme.dev", consoleAliases("noah", 25)],
    ["gwen@acme.dev", consoleAliases("gwen", ALIAS_LIMIT)],
    ["hank@acme.dev", [{ address: "hank.aaron@acme.dev", source: "console" }]],
  ])

  const sorted = (rows: { address: string; source: AliasSource }[]) =>
    [...rows].sort((a, b) => a.address.localeCompare(b.address))

  /**
   * The alias routes, and what each can be refused for, reached from the keyboard
   * by the local part typed so every sentence can be reviewed:
   *
   *   - add: `taken` (409), `elsewhere` (422, a domain the workspace does not host),
   *     `full` (409, the limit), and any mailbox in its deletion grace (409);
   *   - remove: a directory's or Clerk's is refused (409), and one that is not there
   *     is a 404.
   */
  function aliasRoute(
    address: string,
    alias: string | undefined,
    method: string,
    body: unknown,
  ) {
    const mailbox = find(address)
    const rows = aliasesOf.get(address) ?? []
    aliasesOf.set(address, rows)
    const answer = () => ({ data: sorted(rows), limit: ALIAS_LIMIT })

    if (method === "GET") return answer()

    if (method === "POST") {
      const wanted = (body as { address?: string } | null)?.address ?? ""
      const local = wanted.split("@")[0] ?? ""
      if (mailbox.status === "deleting") {
        throw apiError(
          409,
          "mailbox_deleting",
          "That mailbox is being deleted. Restore it first, or add the alias to another mailbox.",
        )
      }
      if (local === "elsewhere") {
        throw apiError(
          422,
          "validation_error",
          "This workspace does not host mailboxes on that domain. Turn on mailboxes for the domain first.",
        )
      }
      if (local === "full") {
        throw apiError(
          409,
          "alias_limit_reached",
          `A mailbox can have ${ALIAS_LIMIT} aliases added here.`,
        )
      }
      const held =
        local === "taken" ||
        data.some((m) => m.address === wanted) ||
        [...aliasesOf.values()].some((list) => list.some((a) => a.address === wanted))
      if (held) throw apiError(409, "alias_taken", "That address is already taken.")
      rows.push({ address: wanted, source: "console" })
      return answer()
    }

    const index = rows.findIndex((a) => a.address === alias)
    if (index === -1) {
      throw apiError(404, "not_found", "That address is not an alias of this mailbox.")
    }
    if (rows[index]!.source !== "console") {
      throw apiError(
        409,
        "alias_not_removable",
        "That address comes from the person's account or a directory, and is removed there.",
      )
    }
    rows.splice(index, 1)
    return answer()
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
        const scenario = previewScenario(query)
        const empty =
          query?.empty === "1" ||
          query?.empty === 1 ||
          scenario === "setup" ||
          scenario === "member-empty"
        const rows =
          scenario === "member"
            ? data.filter((m) => m.address === MEMBER_ADDRESS)
            : data
        const live = pool()
        return {
          data: empty ? [] : rows,
          pool:
            scenario === "payg"
              ? { ...live, kind: "uncapped", total: null, remaining: null }
              : live,
          nextCursor: null,
        }
      },
    ],
    [
      /^\/console\/mailboxes\/creation-mode$/,
      (_m, _query, method, body) => {
        if (method !== "PUT") return { mode: creationMode }
        const mode = (body as { mode?: string } | null)?.mode
        if (mode === "admins" || mode === "members" || mode === "on_join") {
          creationMode = mode
        }
        return { mode: creationMode }
      },
    ],
    // ⚠ ONLY AN ADDRESS (it has an `@`, encoded or not), so the static
    // `/console/mailboxes/creation-mode` and `/storage` never reach these.
    [
      /^\/console\/mailboxes\/([^/]*(?:%40|@)[^/]*)\/aliases(?:\/([^/]+))?$/,
      (match, _query, method, body) =>
        aliasRoute(
          decodeURIComponent(match[1]!),
          match[2] ? decodeURIComponent(match[2]) : undefined,
          method,
          body,
        ),
    ],
    [
      /^\/console\/mailboxes\/([^/]*(?:%40|@)[^/]*)\/(storage|suspend|resume|delete|restore)$/,
      (match, _query, _method, body) =>
        lifecycle(decodeURIComponent(match[1]!), match[2]!, body),
    ],
    [
      /^\/console\/mailboxes\/([^/]*(?:%40|@)[^/]*)$/,
      (match) => find(decodeURIComponent(match[1]!)),
    ],
  ]
}
