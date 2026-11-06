import { describe, expect, it } from "bun:test"
import { JmapAsError, MailboxIdCache, jmapAs } from "../src/mail/jmap-as.js"

/**
 * Acting as a team inbox's Group account: the same guarantees as for a mailbox
 * (the id comes from a verified registry answer, the caller never names one), and
 * the two that are new - the kind must match, and a cross-account copy carries
 * both ids.
 */

const ADMIN = "admin-registry-token"
const IMPERSONATE = "impersonate-key"

interface Account {
  id: string
  /** What the registry calls it: the local part, for groups too (probed on 1.0.3). */
  name: string
  email: string
  type: "User" | "Group"
}

function server(accounts: Account[]) {
  const seen: {
    token: string
    methodCalls: [string, Record<string, unknown>, string][]
  }[] = []
  const destroyed: string[] = []

  const fetcher = (async (_url: string, init: RequestInit) => {
    const token = String(
      (init.headers as Record<string, string>).authorization,
    ).replace("Bearer ", "")
    const body = JSON.parse(String(init.body)) as (typeof seen)[number]
    seen.push({ token, methodCalls: body.methodCalls })
    const [name, args, callId] = body.methodCalls[0]!

    let reply: unknown
    if (name === "x:Account/query") {
      const ids = accounts
        .filter((a) => a.name === (args.filter as { name: string }).name)
        .map((a) => a.id)
      reply = [[name, { ids }, callId]]
    } else if (name === "x:Account/get") {
      const list = accounts
        .filter((a) => (args.ids as string[]).includes(a.id))
        .map((a) => ({ id: a.id, emailAddress: a.email, "@type": a.type }))
      reply = [[name, { list }, callId]]
    } else if (name === "x:Account/set") {
      destroyed.push(...(args.destroy as string[]))
      reply = [[name, { destroyed: args.destroy }, callId]]
    } else {
      reply = body.methodCalls.map(([n, , c]) => [n, { list: [] }, c])
    }
    return new Response(JSON.stringify({ methodResponses: reply }))
  }) as unknown as typeof fetch

  return { fetcher, seen, destroyed }
}

const client = (fetcher: typeof fetch) =>
  jmapAs({
    baseUrl: "http://i10-stalwart:8080",
    registryToken: ADMIN,
    impersonationToken: IMPERSONATE,
    fetch: fetcher,
    cache: new MailboxIdCache(),
  })

const SUPPORT = { address: "support@acme.test", name: "support@acme.test" }
const accounts: Account[] = [
  { id: "g1", name: "support", email: "support@acme.test", type: "Group" },
  { id: "u1", name: "bob", email: "bob@acme.test", type: "User" },
  { id: "g3", name: "help", email: "help@acme.test", type: "Group" },
  // The same local part on another domain, in another workspace.
  {
    id: "g2",
    name: "support",
    email: "support@globex.test",
    type: "Group",
  },
]

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof JmapAsError ? e.code : "other"),
  )

describe("acting as a team inbox", () => {
  it("sends the group's own account id, found by its local part and exact address", async () => {
    const s = server(accounts)
    await client(s.fetcher).callAsGroup(SUPPORT, [["Mailbox/get", {}, "c0"]])

    const call = s.seen.find((r) => r.token === IMPERSONATE)!
    expect(call.methodCalls[0]![1].accountId).toBe("g1")
  })

  it("keeps two workspaces' support@ apart", async () => {
    const s = server(accounts)
    await client(s.fetcher).callAsGroup(
      { address: "support@globex.test", name: "support@globex.test" },
      [["Mailbox/get", {}, "c0"]],
    )
    expect(
      s.seen.find((r) => r.token === IMPERSONATE)!.methodCalls[0]![1].accountId,
    ).toBe("g2")
  })

  it("will not act on a user's account as a group, or on a group as a mailbox", async () => {
    const s = server(accounts)
    const c = client(s.fetcher)

    expect(
      await code(
        c.callAsGroup({ address: "bob@acme.test", name: "bob" }, [
          ["Mailbox/get", {}, "c0"],
        ]),
      ),
    ).toBe("ambiguous_account")
    // A group whose name happens to be a local part: a mailbox call is refused.
    expect(
      await code(c.call({ address: "help@acme.test" }, [["Mailbox/get", {}, "c0"]])),
    ).toBe("ambiguous_account")
    expect(s.seen.some((r) => r.token === IMPERSONATE)).toBe(false)
  })

  it("fails closed when the group carries a different address than we expect", async () => {
    const s = server([
      { id: "g1", name: "support", email: "other@acme.test", type: "Group" },
    ])
    expect(
      await code(client(s.fetcher).callAsGroup(SUPPORT, [["Mailbox/get", {}, "c0"]])),
    ).toBe("address_mismatch")
    expect(s.seen.some((r) => r.token === IMPERSONATE)).toBe(false)
  })

  it("errors on a group the registry does not have yet, and never calls the mailbox", async () => {
    const s = server([])
    expect(
      await code(client(s.fetcher).callAsGroup(SUPPORT, [["Mailbox/get", {}, "c0"]])),
    ).toBe("no_account")
    expect(s.seen.some((r) => r.token === IMPERSONATE)).toBe(false)
  })

  it("refuses an account id from the caller, either one", async () => {
    const s = server(accounts)
    for (const args of [{ accountId: "u1" }, { fromAccountId: "u1" }]) {
      const result = await client(s.fetcher)
        .callAsGroup(SUPPORT, [["Email/copy", args, "c0"]])
        .then(
          () => "ok",
          (e: Error) => e.message,
        )
      expect(result).toContain("accountId is supplied by the client")
    }
    expect(s.seen).toHaveLength(0)
  })

  it("sends both accounts on a copy: the team's as the target, the member's as the source", async () => {
    const s = server(accounts)
    await client(s.fetcher).callAsGroup(
      SUPPORT,
      [["Email/copy", { create: {} }, "c0"]],
      {
        from: { address: "bob@acme.test" },
      },
    )

    const copy = s.seen.find((r) => r.token === IMPERSONATE)!.methodCalls[0]!
    expect(copy[1]).toMatchObject({ accountId: "g1", fromAccountId: "u1" })
  })

  it("sends the source account only on a copy", async () => {
    const s = server(accounts)
    await client(s.fetcher).callAsGroup(SUPPORT, [["Mailbox/get", {}, "c0"]], {
      from: { address: "bob@acme.test" },
    })

    expect(
      s.seen.find((r) => r.token === IMPERSONATE)!.methodCalls[0]![1],
    ).not.toHaveProperty("fromAccountId")
  })
})

describe("destroying a team inbox's account", () => {
  it("destroys the account the registry confirmed, with the admin token", async () => {
    const s = server(accounts)
    expect(await client(s.fetcher).destroyGroup(SUPPORT)).toBe(true)
    expect(s.destroyed).toEqual(["g1"])
    expect(s.seen.every((r) => r.token === ADMIN)).toBe(true)
  })

  it("is a no-op, not an error, for a group nobody has signed in to", async () => {
    const s = server([])
    expect(await client(s.fetcher).destroyGroup(SUPPORT)).toBe(false)
    expect(s.destroyed).toEqual([])
  })

  it("will not destroy a user's account", async () => {
    const s = server(accounts)
    expect(
      await code(
        client(s.fetcher).destroyGroup({ address: "bob@acme.test", name: "bob" }),
      ),
    ).toBe("ambiguous_account")
    expect(s.destroyed).toEqual([])
  })

  it("forgets the cached id so a deleted group stops resolving", async () => {
    const s = server(accounts)
    const cache = new MailboxIdCache()
    const c = jmapAs({
      baseUrl: "http://i10-stalwart:8080",
      registryToken: ADMIN,
      impersonationToken: IMPERSONATE,
      fetch: s.fetcher,
      cache,
    })

    await c.callAsGroup(SUPPORT, [["Mailbox/get", {}, "c0"]])
    expect(cache.get("support@acme.test", "Group")).not.toBeNull()
    await c.destroyGroup(SUPPORT)
    expect(cache.get("support@acme.test", "Group")).toBeNull()
  })
})
