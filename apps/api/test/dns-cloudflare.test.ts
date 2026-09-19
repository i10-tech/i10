import { afterEach, describe, expect, it } from "bun:test"
import { cloudflareWriter } from "../src/dns/providers/cloudflare.js"
import { DnsWriteError, type DesiredRecord, type RemoteZone } from "../src/dns/port.js"

/**
 * Writing into a customer's Cloudflare zone.
 *
 * ⚠ THIS IS THE MOST DESTRUCTIVE CODE IN THE PRODUCT AND IT SHIPPED WITH NO
 * TESTS AT ALL. A credential that can add a TXT record can rewrite an MX
 * record, and an adapter that gets `publish` slightly wrong does not fail
 * loudly — it produces a customer whose mail silently stops arriving, days
 * later, for a reason nobody connects to us.
 *
 * ⚠ THE CASES BELOW ARE THE ONES WHERE THAT ACTUALLY HAPPENS: the refusal that
 * must write NOTHING, the quoting rule that would otherwise duplicate a record
 * on every run, and the blast radius of a delegation, which must never extend
 * past the exact names being taken over.
 */

const ZONE: RemoteZone = { id: "zone-1", name: "example.com" }

interface Seen {
  url: string
  method: string
  body: Record<string, unknown> | undefined
}

/** A record as Cloudflare returns one. */
const cf = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "rec-1",
  type: "TXT",
  name: "_dmarc.example.com",
  content: "v=DMARC1; p=none;",
  ttl: 300,
  ...over,
})

const want = (over: Partial<DesiredRecord> = {}): DesiredRecord => ({
  name: "_dmarc.example.com",
  type: "NS",
  value: "ns1.i10.tech",
  ttl: 300,
  ...over,
})

const real = globalThis.fetch

/**
 * ⚠ ROUTED BY URL RATHER THAN BY CALL ORDER, because `publish` interleaves
 * reads, deletes and creates and a positional stub would pass while asserting
 * the wrong thing.
 */
function stub(
  handler: (url: string, method: string) => { status?: number; body: unknown },
) {
  const seen: Seen[] = []
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const method = init.method ?? "GET"
    seen.push({
      url,
      method,
      body: init.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined,
    })
    const { status = 200, body } = handler(url, method)
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
  return seen
}

const ok = (result: unknown) => ({ body: { success: true, result } })

afterEach(() => {
  globalThis.fetch = real
})

const writer = cloudflareWriter()
const token = { accessToken: "stub-not-a-real-token" }

describe("listing the zones a credential can reach", () => {
  /**
   * ⚠ PAGINATED, AND CLOUDFLARE'S DEFAULT PAGE IS 20. An agency account with
   * sixty zones would silently not find the customer's domain past the first
   * page, and the failure reads as "we cannot see your zone" rather than "we
   * did not look".
   */
  it("walks every page until one comes back short", async () => {
    const page = (n: number) =>
      Array.from({ length: 50 }, (_, i) => ({
        id: `z${n}-${i}`,
        name: `p${n}-${i}.com`,
      }))
    const seen = stub((url) => {
      if (url.includes("page=1")) return ok(page(1))
      if (url.includes("page=2")) return ok(page(2))
      return ok([{ id: "last", name: "final.com" }])
    })

    const zones = await writer.zones(token)

    expect(zones).toHaveLength(101)
    expect(zones.at(-1)).toEqual({ id: "last", name: "final.com" })
    expect(seen.filter((s) => s.url.includes("/zones?")).length).toBe(3)
  })

  it("stops after one page when the account is small", async () => {
    const seen = stub(() => ok([{ id: "z1", name: "Example.COM" }]))
    const zones = await writer.zones(token)
    expect(zones).toEqual([{ id: "z1", name: "example.com" }])
    expect(seen).toHaveLength(1)
  })
})

describe("refusing before destroying", () => {
  /**
   * ⚠ THE SAFETY PROPERTY OF THE WHOLE FEATURE. Delegating `_dmarc.example.com`
   * shadows any DMARC record the customer already has — which, for anybody who
   * has ever configured DMARC, is all of them. The first call must report and
   * change NOTHING, or a customer loses a record they never agreed to lose.
   */
  it("writes nothing at all when a record stands in the way", async () => {
    const seen = stub((url) => (url.includes("dns_records?") ? ok([cf()]) : ok({})))

    const outcome = await writer.publish(token, ZONE, [want()])

    expect(outcome.created).toEqual([])
    expect(outcome.removed).toEqual([
      {
        name: "_dmarc.example.com",
        type: "TXT",
        value: "v=DMARC1; p=none;",
        reason: "A TXT record already exists at _dmarc.example.com.",
      },
    ])
    // ⚠ THE ASSERTION THAT MATTERS: no DELETE and no POST were issued.
    expect(seen.every((s) => s.method === "GET")).toBe(true)
  })

  /**
   * ⚠ AND IT COLLECTS EVERY CONFLICT BEFORE WRITING ANY RECORD. Discovering the
   * third conflict after creating the first two leaves a half-published
   * delegation, which resolves inconsistently and is worse than either outcome
   * on its own.
   */
  it("does not part-publish when only the last name conflicts", async () => {
    const seen = stub((url) =>
      url.includes("dns_records?") ? ok([cf({ name: "_dmarc.example.com" })]) : ok({}),
    )

    const outcome = await writer.publish(token, ZONE, [
      want({ name: "mail.example.com" }),
      want({ name: "_domainkey.example.com" }),
      want({ name: "_dmarc.example.com" }),
    ])

    expect(outcome.created).toEqual([])
    expect(seen.some((s) => s.method === "POST")).toBe(false)
  })

  it("removes them only once the customer has agreed", async () => {
    const seen = stub((url) => (url.includes("dns_records?") ? ok([cf()]) : ok({})))

    const outcome = await writer.publish(token, ZONE, [want()], {
      replaceConflicts: true,
    })

    expect(outcome.removed).toHaveLength(1)
    expect(outcome.created).toHaveLength(1)
    expect(seen.find((s) => s.method === "DELETE")?.url).toContain("/dns_records/rec-1")
  })
})

describe("the blast radius of a delegation", () => {
  /**
   * ⚠ ONLY THE EXACT NAMES BEING DELEGATED. Not the apex, not a parent, not a
   * record of a different name — a delegation that swept the zone would take
   * out the customer's website and their inbound MX along with their DMARC.
   */
  it("leaves every other record in the zone alone", async () => {
    stub((url) =>
      url.includes("dns_records?")
        ? ok([
            cf({
              id: "apex-a",
              type: "A",
              name: "example.com",
              content: "203.0.113.1",
            }),
            cf({ id: "mx", type: "MX", name: "example.com", content: "mx.other.com" }),
            cf({
              id: "www",
              type: "CNAME",
              name: "www.example.com",
              content: "x.cdn.com",
            }),
            cf({ id: "spf", type: "TXT", name: "example.com", content: "v=spf1 -all" }),
          ])
        : ok({}),
    )

    const outcome = await writer.publish(token, ZONE, [want()], {
      replaceConflicts: true,
    })

    expect(outcome.removed).toEqual([])
  })

  /** An NS record already at the delegated name is the delegation, not a conflict. */
  it("does not treat an existing NS record as something to remove", async () => {
    stub((url) =>
      url.includes("dns_records?")
        ? ok([
            cf({
              id: "ns",
              type: "NS",
              name: "_dmarc.example.com",
              content: "ns1.i10.tech",
            }),
          ])
        : ok({}),
    )

    const outcome = await writer.publish(token, ZONE, [want()])
    expect(outcome.removed).toEqual([])
    expect(outcome.unchanged).toHaveLength(1)
  })

  /** Nothing is ever removed for a manual domain, which publishes no NS at all. */
  it("removes nothing when publishing ordinary records", async () => {
    stub((url) =>
      url.includes("dns_records?")
        ? ok([
            cf({
              id: "old",
              type: "TXT",
              name: "send.example.com",
              content: "v=spf1 old",
            }),
          ])
        : ok({}),
    )

    const outcome = await writer.publish(
      token,
      ZONE,
      [
        want({
          name: "send.example.com",
          type: "TXT",
          value: "v=spf1 include:amazonses.com ~all",
        }),
      ],
      { replaceConflicts: true },
    )

    expect(outcome.removed).toEqual([])
    expect(outcome.created).toHaveLength(1)
  })
})

describe("running it twice", () => {
  /**
   * ⚠ TXT VALUES ARE COMPARED UNQUOTED, and getting this wrong is invisible in
   * the happy path. Cloudflare stores TXT content without the surrounding
   * quotes a zone file carries, so a quoted comparison never matches and every
   * single run creates another duplicate — none of which ever match the next.
   */
  it("matches a TXT record whatever the quoting", async () => {
    stub((url) =>
      url.includes("dns_records?")
        ? ok([cf({ type: "TXT", name: "send.example.com", content: '"v=spf1 -all"' })])
        : ok({}),
    )

    const outcome = await writer.publish(token, ZONE, [
      want({ name: "send.example.com", type: "TXT", value: "v=spf1 -all" }),
    ])

    expect(outcome.unchanged).toHaveLength(1)
    expect(outcome.created).toEqual([])
  })

  it("matches a hostname regardless of case or trailing dot", async () => {
    stub((url) =>
      url.includes("dns_records?")
        ? ok([cf({ type: "NS", name: "mail.example.com", content: "NS1.I10.TECH." })])
        : ok({}),
    )

    const outcome = await writer.publish(token, ZONE, [
      want({ name: "mail.example.com", type: "NS", value: "ns1.i10.tech" }),
    ])

    expect(outcome.unchanged).toHaveLength(1)
  })

  it("creates what is genuinely missing and says so", async () => {
    const seen = stub((url) => (url.includes("dns_records?") ? ok([]) : ok({})))

    const outcome = await writer.publish(token, ZONE, [
      want({ name: "mail.example.com", type: "NS", value: "ns1.i10.tech" }),
      want({ name: "mail.example.com", type: "NS", value: "ns2.i10.tech" }),
    ])

    expect(outcome.created).toHaveLength(2)
    expect(outcome.unchanged).toEqual([])
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(2)
  })
})

describe("what gets sent to Cloudflare", () => {
  /**
   * ⚠ NEVER PROXIED. An orange-clouded record answers with Cloudflare's own
   * HTTP addresses instead of the value — which is exactly how `ns1.i10.tech`
   * came to resolve to a Cloudflare address and serve no DNS at all.
   */
  it("never proxies a record", async () => {
    const seen = stub((url) => (url.includes("dns_records?") ? ok([]) : ok({})))
    await writer.publish(token, ZONE, [want()])
    expect(seen.find((s) => s.method === "POST")?.body).toMatchObject({
      proxied: false,
    })
  })

  it("sends the fully qualified name, not a relative one", async () => {
    const seen = stub((url) => (url.includes("dns_records?") ? ok([]) : ok({})))
    await writer.publish(token, ZONE, [want({ name: "send.mail.example.com" })])
    // ⚠ A RELATIVE NAME HERE IS HOW `mail.example.com.example.com` GETS CREATED.
    expect(seen.find((s) => s.method === "POST")?.body).toMatchObject({
      name: "send.mail.example.com",
    })
  })

  it("carries a priority for MX and omits it otherwise", async () => {
    const seen = stub((url) => (url.includes("dns_records?") ? ok([]) : ok({})))
    await writer.publish(token, ZONE, [
      want({
        name: "send.example.com",
        type: "MX",
        value: "mx.i10.tech",
        priority: 10,
      }),
      want({ name: "t.example.com", type: "TXT", value: "hello" }),
    ])
    const posts = seen.filter((s) => s.method === "POST")
    expect(posts[0]?.body).toMatchObject({ priority: 10 })
    expect(posts[1]?.body).not.toHaveProperty("priority")
  })
})

describe("when Cloudflare refuses", () => {
  it("maps the status onto whose problem it is", async () => {
    for (const [status, kind] of [
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not_found"],
      [500, "unavailable"],
    ] as const) {
      stub(() => ({ status, body: { success: false, result: null, errors: [] } }))
      const failed = writer.zones(token)
      await expect(failed).rejects.toBeInstanceOf(DnsWriteError)
      await expect(failed).rejects.toMatchObject({ kind })
    }
  })

  /**
   * ⚠ CLOUDFLARE'S OWN TEXT IS CARRIED THROUGH, because it is better than
   * anything we would write. "Zone → DNS → Edit permission required" is a
   * sentence the customer can act on inside a UI we do not control.
   */
  it("keeps their error text, which is better than ours", async () => {
    stub(() => ({
      status: 403,
      body: {
        success: false,
        result: null,
        errors: [{ code: 10000, message: "Authentication error" }],
      },
    }))
    await expect(writer.zones(token)).rejects.toMatchObject({
      detail: "10000: Authentication error",
    })
  })

  /** ⚠ A 200 WITH `success: false` IS STILL A REFUSAL. Cloudflare sends them. */
  it("treats a 200 with success:false as a refusal", async () => {
    stub(() => ({ status: 200, body: { success: false, result: null, errors: [] } }))
    await expect(writer.zones(token)).rejects.toBeInstanceOf(DnsWriteError)
  })

  it("reports an unreachable API as retryable, not as a bad credential", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNRESET")
    }) as unknown as typeof fetch
    await expect(writer.zones(token)).rejects.toMatchObject({ kind: "unavailable" })
  })

  /** A connection whose credential lost its token must say so, not throw a TypeError. */
  it("reports a credential with no token as needing a reconnect", async () => {
    stub(() => ok([]))
    await expect(writer.zones({})).rejects.toMatchObject({ kind: "unauthorized" })
    await expect(writer.zones({ accessToken: "" })).rejects.toMatchObject({
      kind: "unauthorized",
    })
  })

  /** OAuth and pasted API tokens are both bearer tokens; one adapter serves both. */
  it("accepts either an OAuth access token or a pasted API token", async () => {
    const seen = stub(() => ok([]))
    await writer.zones({ token: "stub-pasted" })
    expect(seen[0]).toBeDefined()
  })
})
