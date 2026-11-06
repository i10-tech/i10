import { describe, expect, it } from "bun:test"
import { JmapAsError, MailboxIdCache, jmapAs } from "../src/mail/jmap-as.js"

const ADMIN = "admin-registry-token"
const IMPERSONATE = "impersonate-key"

interface Seen {
  token: string
  using: string[]
  methodCalls: [string, Record<string, unknown>, string][]
}

/**
 * A Stalwart that knows exactly these accounts, keyed by address. It answers the
 * registry the way the running 1.0.3 server does: `x:Account/query` filters on
 * `name` only (the key's local part, exact), then `get` returns the accounts. It
 * answers ANY mailbox call for any well-formed id, the phantom-account trap.
 */
function server(
  accounts: Record<string, { id: string; email?: string; type?: string }>,
) {
  const seen: Seen[] = []

  const fetcher = (async (_url: string, init: RequestInit) => {
    const token = String(
      (init.headers as Record<string, string>).authorization,
    ).replace("Bearer ", "")
    const body = JSON.parse(String(init.body)) as Omit<Seen, "token">
    seen.push({ token, ...body })

    const [name, args, callId] = body.methodCalls[0]!
    let reply: unknown

    if (name === "x:Account/query") {
      const filter = args.filter as Record<string, unknown>
      if (Object.keys(filter).some((k) => k !== "name")) {
        reply = [["error", { type: "unsupportedFilter" }, callId]]
      } else {
        const ids = Object.entries(accounts)
          .filter(([key]) => key.slice(0, key.lastIndexOf("@")) === filter.name)
          .map(([, a]) => a.id)
        reply = [[name, { ids }, callId]]
      }
    } else if (name === "x:Account/get") {
      const ids = args.ids as string[]
      const list = Object.entries(accounts)
        .filter(([, a]) => ids.includes(a.id))
        .map(([address, a]) => ({
          id: a.id,
          emailAddress: a.email ?? address,
          "@type": a.type ?? "User",
        }))
      reply = [[name, { list }, callId]]
    } else {
      reply = body.methodCalls.map(([n, , c]) => [n, { list: [] }, c])
    }

    return new Response(JSON.stringify({ methodResponses: reply }))
  }) as unknown as typeof fetch

  const registry = () => seen.filter((s) => s.methodCalls[0]![0].startsWith("x:"))
  const mailbox = () => seen.filter((s) => !s.methodCalls[0]![0].startsWith("x:"))
  return { fetcher, seen, registry, mailbox }
}

function client(fetcher: typeof fetch, cache = new MailboxIdCache()) {
  return jmapAs({
    baseUrl: "http://i10-stalwart:8080/",
    registryToken: ADMIN,
    impersonationToken: IMPERSONATE,
    fetch: fetcher,
    cache,
  })
}

const list = ["Mailbox/get", {}, "c0"] as const

describe("which account a call is made as", () => {
  // Cross-workspace: the id on the wire is the registry's answer for THAT
  // address, so one workspace's request cannot carry another's account.
  it("sends each mailbox's own account id, never another's", async () => {
    const s = server({ "a@acme.test": { id: "idA" }, "b@globex.test": { id: "idB" } })
    const c = client(s.fetcher)

    await c.call({ address: "a@acme.test" }, [list])
    await c.call({ address: "b@globex.test" }, [list])

    const ids = s.mailbox().map((m) => m.methodCalls[0]![1].accountId)
    expect(ids).toEqual(["idA", "idB"])
  })

  it("lowercases the address it looks up", async () => {
    const s = server({ "a@acme.test": { id: "idA" } })
    await client(s.fetcher).call({ address: " A@Acme.test " }, [list])
    expect(s.mailbox()[0]!.methodCalls[0]![1].accountId).toBe("idA")
  })

  it("refuses an accountId supplied by the caller, before asking anyone", async () => {
    const s = server({ "a@acme.test": { id: "idA" } })
    const result = await client(s.fetcher)
      .call({ address: "a@acme.test" }, [["Mailbox/get", { accountId: "idB" }, "c0"]])
      .then(
        () => "ok",
        (e: Error) => e.message,
      )

    expect(result).toContain("accountId is supplied by the client")
    expect(s.seen).toHaveLength(0)
  })

  it("sends the impersonation key for mail and the admin token for the registry", async () => {
    const s = server({ "a@acme.test": { id: "idA" } })
    await client(s.fetcher).call({ address: "a@acme.test" }, [list])

    expect(s.registry().map((r) => r.token)).toEqual([ADMIN, ADMIN])
    expect(s.mailbox().map((m) => m.token)).toEqual([IMPERSONATE])
    expect(s.mailbox()[0]!.using).toContain("urn:ietf:params:jmap:mail")
  })
})

describe("when the id cannot be trusted", () => {
  const code = (p: Promise<unknown>) =>
    p.then(
      () => "ok",
      (e: unknown) => (e instanceof JmapAsError ? e.code : "other"),
    )

  // The probe's trap: Stalwart would happily answer for the phantom.
  it("errors on an empty lookup and never calls the mailbox", async () => {
    const s = server({})
    expect(
      await code(client(s.fetcher).call({ address: "ghost@acme.test" }, [list])),
    ).toBe("no_account")
    expect(s.mailbox()).toHaveLength(0)
  })

  it("errors when the account found carries a different address", async () => {
    const s = server({ "a@acme.test": { id: "idA", email: "someone-else@acme.test" } })
    expect(await code(client(s.fetcher).call({ address: "a@acme.test" }, [list]))).toBe(
      "address_mismatch",
    )
    expect(s.mailbox()).toHaveLength(0)
  })

  it("picks the one account carrying the address when two domains share a local part", async () => {
    const s = server({ "a@acme.test": { id: "idA" }, "a@globex.test": { id: "idG" } })
    await client(s.fetcher).call({ address: "a@globex.test" }, [list])
    expect(s.mailbox()[0]!.methodCalls[0]![1].accountId).toBe("idG")
  })

  it("errors when two accounts carry the same address", async () => {
    const s = server({
      "a@acme.test": { id: "a1" },
      "a@acme.test ": { id: "a2", email: "a@acme.test" },
    })
    expect(await code(client(s.fetcher).call({ address: "a@acme.test" }, [list]))).toBe(
      "ambiguous_account",
    )
    expect(s.mailbox()).toHaveLength(0)
  })

  it("errors on a group", async () => {
    const s = server({ "team@acme.test": { id: "g1", type: "Group" } })
    expect(
      await code(client(s.fetcher).call({ address: "team@acme.test" }, [list])),
    ).toBe("ambiguous_account")
  })

  it("errors on a malformed address without asking the registry", async () => {
    const s = server({})
    expect(
      await code(client(s.fetcher).call({ address: "not-an-address" }, [list])),
    ).toBe("invalid_address")
    expect(s.seen).toHaveLength(0)
  })

  it("surfaces a JMAP error instead of reading it as empty", async () => {
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          methodResponses: [["error", { type: "unknownMethod" }, "q"]],
        }),
      )) as unknown as typeof fetch
    expect(await code(client(fetcher).call({ address: "a@acme.test" }, [list]))).toBe(
      "stalwart",
    )
  })
})

describe("the id cache", () => {
  it("asks the registry once per mailbox", async () => {
    const s = server({ "a@acme.test": { id: "idA" } })
    const c = client(s.fetcher)

    await c.call({ address: "a@acme.test" }, [list])
    await c.call({ address: "a@acme.test" }, [list])

    expect(s.registry()).toHaveLength(2) // one query + one get
    expect(s.mailbox()).toHaveLength(2)
  })

  it("looks again once the entry expires", async () => {
    const s = server({ "a@acme.test": { id: "idA" } })
    let now = 0
    const c = client(s.fetcher, new MailboxIdCache(1_000, () => now))

    await c.call({ address: "a@acme.test" }, [list])
    now = 1_001
    await c.call({ address: "a@acme.test" }, [list])

    expect(s.registry()).toHaveLength(4)
  })

  // The delete path: a cached id must not outlive its account.
  it("does not reuse an id after the mailbox is forgotten", async () => {
    const accounts: Record<string, { id: string }> = { "a@acme.test": { id: "idA" } }
    const s = server(accounts)
    const cache = new MailboxIdCache()
    const c = client(s.fetcher, cache)

    await c.call({ address: "a@acme.test" }, [list])

    delete accounts["a@acme.test"]
    cache.forget("A@acme.test")

    const outcome = await c.call({ address: "a@acme.test" }, [list]).then(
      () => "ok",
      (e: unknown) => (e instanceof JmapAsError ? e.code : "other"),
    )
    expect(outcome).toBe("no_account")
    expect(s.mailbox()).toHaveLength(1)
  })

  it("drops an answer whose lookup began before the mailbox was forgotten", () => {
    const cache = new MailboxIdCache()
    const began = cache.begin()
    cache.forget("a@acme.test")
    cache.set("a@acme.test", "idA" as never, began)
    expect(cache.get("a@acme.test")).toBeNull()
  })
})
