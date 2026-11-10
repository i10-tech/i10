import { describe, expect, it } from "bun:test"
import { createStalwartCaller, type StalwartCaller } from "../src/mail/stalwart.js"
import {
  MANAGED_MARKER,
  destroyDomain,
  disableDomain,
  ensureDomain,
  listDomains,
  reconcileDomains,
} from "../src/mail/stalwart-domains.js"

interface FakeDomain {
  id: string
  name: string
  enable?: boolean
  description?: string | null
  catchAllAddress?: string | null
  [key: string]: unknown
}

/**
 * A Stalwart registry that answers the Domain calls, records every method it
 * was asked and applies `x:Domain/set` to its objects.
 */
function fakeRegistry(
  initial: FakeDomain[],
  opts: { refuse?: ReadonlySet<string> } = {},
) {
  const domains = initial.map((d) => ({ ...d }))
  const methods: { name: string; args: Record<string, unknown> }[] = []
  let next = 1

  const call: StalwartCaller = async (methodCalls) => {
    const [name, args] = methodCalls[0] as [string, Record<string, unknown>, string]
    methods.push({ name, args })

    if (name === "x:Domain/query") {
      return [name, { ids: domains.map((d) => d.id) }]
    }

    if (name === "x:Domain/get") {
      const ids = args.ids as string[]
      return [name, { list: domains.filter((d) => ids.includes(d.id)) }]
    }

    if (name === "x:Domain/set") {
      const refused = { type: "forbidden", description: "missing permission" }
      const created: Record<string, { id: string }> = {}
      const notCreated: Record<string, unknown> = {}
      const notUpdated: Record<string, unknown> = {}
      const notDestroyed: Record<string, unknown> = {}

      for (const [key, value] of Object.entries(
        (args.create ?? {}) as Record<string, Record<string, unknown>>,
      )) {
        if (opts.refuse?.has(String(value.name))) {
          notCreated[key] = refused
          continue
        }
        const id = `d${next++}`
        domains.push({ id, ...value } as FakeDomain)
        created[key] = { id }
      }

      for (const [id, patch] of Object.entries(
        (args.update ?? {}) as Record<string, Record<string, unknown>>,
      )) {
        const domain = domains.find((d) => d.id === id)
        if (!domain || opts.refuse?.has(domain.name)) {
          notUpdated[id] = refused
          continue
        }
        Object.assign(domain, patch)
      }

      for (const id of (args.destroy ?? []) as string[]) {
        const at = domains.findIndex((d) => d.id === id)
        if (at < 0) notDestroyed[id] = refused
        else domains.splice(at, 1)
      }

      return [name, { created, notCreated, updated: {}, notUpdated, notDestroyed }]
    }

    throw new Error(`unexpected method ${name}`)
  }

  return {
    call,
    domains,
    byName: (name: string) => domains.find((d) => d.name === name),
    /** The `x:Domain/set` calls, which are the only writes. */
    writes: () => methods.filter((m) => m.name === "x:Domain/set"),
  }
}

const I10: FakeDomain = {
  id: "plan-1",
  name: "i10.tech",
  description: "i10's own domain",
  enable: true,
}

const ours = (name: string, over: Partial<FakeDomain> = {}): FakeDomain => ({
  id: `own-${name}`,
  name,
  description: MANAGED_MARKER,
  enable: true,
  ...over,
})

const want = (...names: string[]) => new Set(names)

describe("reconcileDomains", () => {
  it("creates a wanted domain with the marker and the customer settings", async () => {
    const registry = fakeRegistry([I10])

    const plan = await reconcileDomains(registry.call, want("i10.tech", "acme.com"), {
      apply: true,
    })

    expect(plan.create).toEqual(["acme.com"])
    expect(plan.failed).toEqual([])
    expect(registry.byName("acme.com")).toMatchObject({
      description: MANAGED_MARKER,
      enable: true,
      certificateManagement: { "@type": "Manual" },
      dnsManagement: { "@type": "Manual" },
      dkimManagement: { "@type": "Manual" },
      subAddressing: { "@type": "Enabled" },
    })
  })

  it("re-enables a disabled domain of ours that is wanted again", async () => {
    const registry = fakeRegistry([I10, ours("acme.com", { enable: false })])

    const plan = await reconcileDomains(registry.call, want("acme.com"), {
      apply: true,
    })

    expect(plan.enable).toEqual(["acme.com"])
    expect(registry.byName("acme.com")?.enable).toBe(true)
  })

  it("disables, and never destroys, a domain of ours that is no longer wanted", async () => {
    const registry = fakeRegistry([I10, ours("gone.com")])

    const plan = await reconcileDomains(registry.call, want(), { apply: true })

    expect(plan.disable).toEqual(["gone.com"])
    expect(registry.byName("gone.com")?.enable).toBe(false)
    expect(registry.domains).toHaveLength(2)
  })

  it("never touches i10.tech, wanted or not", async () => {
    for (const desired of [want(), want("i10.tech")]) {
      const registry = fakeRegistry([I10])

      const plan = await reconcileDomains(registry.call, desired, {
        apply: true,
        adopt: true,
      })

      expect(plan.adopt).toEqual([])
      expect(plan.disable).toEqual([])
      expect(registry.writes()).toHaveLength(0)
      expect(registry.byName("i10.tech")).toEqual(I10)
    }
  })

  it("leaves a protected name alone even when it carries the marker", async () => {
    const registry = fakeRegistry([ours("own-brand.com")])

    await reconcileDomains(registry.call, want(), {
      apply: true,
      protect: ["own-brand.com"],
    })

    expect(registry.writes()).toHaveLength(0)
  })

  it("leaves an unmarked domain alone when nobody wants it", async () => {
    const registry = fakeRegistry([
      { id: "h1", name: "by-hand.example", description: "added by hand", enable: true },
    ])

    const plan = await reconcileDomains(registry.call, want(), { apply: true })

    expect(plan.untouched).toEqual(["by-hand.example"])
    expect(registry.writes()).toHaveLength(0)
  })

  describe("a wanted domain somebody added by hand", () => {
    const probe: FakeDomain = {
      id: "h1",
      name: "okta-probe.pslhq.app",
      description: "i10 okta probe, delete me",
      enable: true,
    }

    it("is reported to adopt, and not written, without the adopt option", async () => {
      const registry = fakeRegistry([I10, probe])

      const plan = await reconcileDomains(registry.call, want("okta-probe.pslhq.app"), {
        apply: true,
      })

      expect(plan.adopt).toEqual(["okta-probe.pslhq.app"])
      expect(registry.writes()).toHaveLength(0)
      expect(registry.byName(probe.name)).toEqual(probe)
    })

    it("takes the marker with the adopt option, and is ours from then on", async () => {
      const registry = fakeRegistry([I10, probe])
      const options = { apply: true, adopt: true }

      await reconcileDomains(registry.call, want("okta-probe.pslhq.app"), options)
      expect(registry.byName(probe.name)?.description).toBe(MANAGED_MARKER)

      const second = await reconcileDomains(
        registry.call,
        want("okta-probe.pslhq.app"),
        options,
      )
      expect(second.adopt).toEqual([])
    })
  })

  it("makes no writes on a second run", async () => {
    const registry = fakeRegistry([
      I10,
      ours("stale.com"),
      ours("back.com", { enable: false }),
    ])
    const desired = want("i10.tech", "new.com", "back.com")

    await reconcileDomains(registry.call, desired, { apply: true })
    const writesAfterFirst = registry.writes().length
    expect(writesAfterFirst).toBeGreaterThan(0)

    const second = await reconcileDomains(registry.call, desired, { apply: true })

    expect(second).toMatchObject({ create: [], enable: [], disable: [], adopt: [] })
    expect(registry.writes()).toHaveLength(writesAfterFirst)
  })

  it("reports the plan and writes nothing in a dry run", async () => {
    const registry = fakeRegistry([
      I10,
      ours("stale.com"),
      ours("back.com", { enable: false }),
    ])
    const before = structuredClone(registry.domains)

    const plan = await reconcileDomains(registry.call, want("new.com", "back.com"))

    expect(plan).toMatchObject({
      create: ["new.com"],
      enable: ["back.com"],
      disable: ["stale.com"],
    })
    expect(registry.writes()).toHaveLength(0)
    expect(registry.domains).toEqual(before)
  })

  it("matches names regardless of case", async () => {
    const registry = fakeRegistry([ours("acme.com")])

    const plan = await reconcileDomains(registry.call, want("ACME.com"), {
      apply: true,
    })

    expect(plan).toMatchObject({ create: [], enable: [], disable: [] })
    expect(registry.writes()).toHaveLength(0)
  })

  it("keeps going when one domain is refused, and says which", async () => {
    const registry = fakeRegistry([], { refuse: new Set(["bad.com"]) })

    const plan = await reconcileDomains(registry.call, want("bad.com", "good.com"), {
      apply: true,
    })

    expect(registry.byName("good.com")).toBeDefined()
    expect(registry.byName("bad.com")).toBeUndefined()
    expect(plan.failed).toEqual([
      { name: "bad.com", error: expect.stringContaining("forbidden") },
    ])
  })
})

describe("a Stalwart error", () => {
  it("becomes a throw rather than an empty registry", async () => {
    const fetchError = (async () =>
      Response.json({
        methodResponses: [
          ["error", { type: "unknownMethod", description: "no such method" }, "q"],
        ],
      })) as unknown as typeof fetch
    const call = createStalwartCaller({
      baseUrl: "http://stalwart.test",
      token: "t",
      fetch: fetchError,
    })

    const failure = await reconcileDomains(call, want("acme.com"), {
      apply: true,
    }).then(
      () => null,
      (error: Error) => error,
    )

    expect(failure?.message).toContain("unknownMethod")
  })

  it("becomes a throw when a write is refused", async () => {
    const registry = fakeRegistry([], { refuse: new Set(["acme.com"]) })

    const failure = await ensureDomain(registry.call, "acme.com").then(
      () => null,
      (error: Error) => error,
    )

    expect(failure?.message).toContain("forbidden")
  })
})

describe("ensureDomain", () => {
  it("creates a domain with a catch-all, and sets one on an existing domain", async () => {
    const registry = fakeRegistry([])

    expect(
      await ensureDomain(registry.call, "acme.com", {
        catchAllAddress: "all@acme.com",
      }),
    ).toBe("created")
    expect(registry.byName("acme.com")?.catchAllAddress).toBe("all@acme.com")

    expect(
      await ensureDomain(registry.call, "acme.com", {
        catchAllAddress: "boss@acme.com",
      }),
    ).toBe("updated")
    expect(registry.byName("acme.com")?.catchAllAddress).toBe("boss@acme.com")
  })

  it("clears the catch-all with null, and leaves it alone when omitted", async () => {
    const registry = fakeRegistry([
      ours("acme.com", { catchAllAddress: "all@acme.com" }),
    ])

    expect(await ensureDomain(registry.call, "acme.com")).toBe("unchanged")
    expect(registry.byName("acme.com")?.catchAllAddress).toBe("all@acme.com")

    expect(
      await ensureDomain(registry.call, "acme.com", { catchAllAddress: null }),
    ).toBe("updated")
    expect(registry.byName("acme.com")?.catchAllAddress).toBeNull()
    expect(
      await ensureDomain(registry.call, "acme.com", { catchAllAddress: null }),
    ).toBe("unchanged")
  })

  it("re-enables a disabled domain of ours", async () => {
    const registry = fakeRegistry([ours("acme.com", { enable: false })])

    expect(await ensureDomain(registry.call, "acme.com")).toBe("updated")
    expect(registry.byName("acme.com")?.enable).toBe(true)
  })

  it("leaves a domain without the marker strictly alone", async () => {
    const registry = fakeRegistry([I10])

    expect(
      await ensureDomain(registry.call, "i10.tech", { catchAllAddress: "x@i10.tech" }),
    ).toBe("unmanaged")
    expect(registry.writes()).toHaveLength(0)
  })

  it("matches the exact name, not a longer one that contains it", async () => {
    const registry = fakeRegistry([ours("notacme.com")])

    expect(await ensureDomain(registry.call, "acme.com")).toBe("created")
    expect(registry.byName("notacme.com")?.enable).toBe(true)
    expect(registry.domains).toHaveLength(2)
  })
})

describe("disableDomain and destroyDomain", () => {
  it("disables one of ours, once", async () => {
    const registry = fakeRegistry([ours("acme.com")])

    expect(await disableDomain(registry.call, "acme.com")).toBe(true)
    expect(registry.byName("acme.com")?.enable).toBe(false)
    expect(await disableDomain(registry.call, "acme.com")).toBe(false)
    expect(registry.writes()).toHaveLength(1)
  })

  it("will not disable or destroy a domain without the marker", async () => {
    const registry = fakeRegistry([I10])

    expect(await disableDomain(registry.call, "i10.tech")).toBe(false)
    expect(await destroyDomain(registry.call, "i10.tech")).toBe(false)
    expect(registry.domains).toEqual([I10])
  })

  it("destroys one of ours only when asked", async () => {
    const registry = fakeRegistry([I10, ours("acme.com")])

    expect(await destroyDomain(registry.call, "acme.com")).toBe(true)
    expect((await listDomains(registry.call)).map((d) => d.name)).toEqual(["i10.tech"])
  })
})
