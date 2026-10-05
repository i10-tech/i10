import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"
import {
  deliverWebhook,
  type DeliveryRecord,
  type FailureDecision,
} from "../src/webhooks/deliver.js"
import {
  isPermittedAddress,
  parseAllowList,
  pinnedRequest,
  vetHost,
  type Lookup,
} from "../src/webhooks/egress.js"
import { webhookEndpointStore } from "../src/webhooks/store.js"
import { secretBox } from "../src/webhooks/signing.js"

describe("which addresses a webhook may connect to", () => {
  // ⚠ EVERY ONE OF THESE IS AN ADDRESS A CUSTOMER'S DNS CAN POINT AT, AND
  // EVERY ONE IS SOMEWHERE INSIDE OR NEXT TO OUR NETWORK. The list mirrors the
  // probes the Svix lab ran (2026-10-05) plus the ranges in egress.ts.
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "the far end of loopback"],
    ["0.0.0.0", "this network"],
    ["10.43.0.1", "RFC 1918 (a cluster service address)"],
    ["172.16.5.4", "RFC 1918"],
    ["192.168.1.1", "RFC 1918"],
    ["169.254.169.254", "cloud metadata"],
    ["100.64.0.1", "CGNAT"],
    ["192.0.0.8", "IETF protocol assignments"],
    ["192.0.2.1", "documentation"],
    ["198.18.0.1", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["240.0.0.1", "reserved"],
    ["::1", "IPv6 loopback"],
    ["::", "unspecified"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:7f00:1", "IPv4-mapped loopback, hex form"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["::127.0.0.1", "IPv4-compatible loopback"],
    ["fe80::1", "link-local"],
    ["fe80::1%eth0", "link-local with a zone"],
    ["fd00::1", "unique local"],
    ["ff02::1", "IPv6 multicast"],
    ["64:ff9b::7f00:1", "NAT64 of loopback"],
    ["2002:7f00:1::", "6to4 of loopback"],
    ["2001:0:4136:e378::1", "Teredo"],
    ["2001:db8::1", "documentation"],
    ["not-an-address", "not an address at all"],
  ])("refuses %s (%s)", (ip) => {
    expect(isPermittedAddress(ip)).toBe(false)
  })

  it.each([
    ["93.184.215.14"],
    ["8.8.8.8"],
    ["172.66.147.243"],
    ["2606:4700::6812:1"],
    ["::ffff:8.8.8.8"],
  ])("allows the public address %s", (ip) => {
    expect(isPermittedAddress(ip)).toBe(true)
  })

  it("lets an allow list open a private range, and only that range", () => {
    const allow = parseAllowList("192.168.65.254/32, fd00::/8")
    expect(isPermittedAddress("192.168.65.254", allow)).toBe(true)
    expect(isPermittedAddress("192.168.65.253", allow)).toBe(false)
    expect(isPermittedAddress("fd00::5", allow)).toBe(true)
    expect(isPermittedAddress("127.0.0.1", allow)).toBe(false)
  })

  it("refuses a malformed allow list rather than ignoring it", () => {
    expect(() => parseAllowList("10.0.0.0/33")).toThrow()
    expect(() => parseAllowList("nonsense")).toThrow()
    expect(parseAllowList(undefined)).toEqual([])
  })
})

const lookupOf =
  (answers: Record<string, Array<[string, 4 | 6]>>): Lookup =>
  async (host) => {
    const a = answers[host]
    if (!a) throw new Error("ENOTFOUND")
    return a.map(([address, family]) => ({ address, family }))
  }

describe("resolving a hostname before connecting", () => {
  it("connects to a public answer, preferring IPv4", async () => {
    const v = await vetHost("hooks.example.com", {
      lookup: lookupOf({
        "hooks.example.com": [
          ["2606:4700::6812:1", 6],
          ["93.184.215.14", 4],
        ],
      }),
    })
    expect(v).toEqual({ ok: true, address: "93.184.215.14", family: 4 })
  })

  // ⚠ STRICTER THAN SVIX ON PURPOSE. Svix drops the private address and
  // connects to the public one; a mixed answer is how a rebinding attack
  // looks, so the whole host is refused.
  it("refuses the whole host when any one address is private", async () => {
    const v = await vetHost("rebind.example.com", {
      lookup: lookupOf({
        "rebind.example.com": [
          ["93.184.215.14", 4],
          ["10.0.0.1", 4],
        ],
      }),
    })
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.kind).toBe("blocked")
      expect(v.reason).toContain("10.0.0.1")
    }
  })

  it("refuses a public name that resolves to loopback (the nip.io case)", async () => {
    const v = await vetHost("127.0.0.1.nip.io", {
      lookup: lookupOf({ "127.0.0.1.nip.io": [["127.0.0.1", 4]] }),
    })
    expect(v).toMatchObject({ ok: false, kind: "blocked" })
  })

  it("judges an IP literal directly, brackets and all", async () => {
    expect(await vetHost("[::1]")).toMatchObject({ ok: false, kind: "blocked" })
    expect(await vetHost("169.254.169.254")).toMatchObject({
      ok: false,
      kind: "blocked",
    })
    expect(await vetHost("8.8.8.8")).toEqual({
      ok: true,
      address: "8.8.8.8",
      family: 4,
    })
  })

  it("calls a name that does not resolve unresolved, not blocked", async () => {
    expect(await vetHost("nope.example.com", { lookup: lookupOf({}) })).toMatchObject({
      ok: false,
      kind: "unresolved",
    })
    expect(
      await vetHost("empty.example.com", {
        lookup: lookupOf({ "empty.example.com": [] }),
      }),
    ).toMatchObject({ ok: false, kind: "unresolved" })
  })

  it("gives up on a resolver that never answers when the deadline fires", async () => {
    const started = Date.now()
    const v = await vetHost("slow.example.com", {
      lookup: () => new Promise(() => {}),
      signal: AbortSignal.timeout(50),
    })
    expect(v).toMatchObject({ ok: false, kind: "unresolved" })
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe("the pinned request", () => {
  it("puts the address in the URL and keeps the name for Host and SNI", () => {
    const p = pinnedRequest(new URL("https://hooks.example.com/i10?x=1"), {
      address: "93.184.215.14",
      family: 4,
    })
    expect(p).toEqual({
      url: "https://93.184.215.14/i10?x=1",
      host: "hooks.example.com",
      serverName: "hooks.example.com",
    })
  })

  it("brackets an IPv6 address and keeps a non-default port in Host", () => {
    const p = pinnedRequest(new URL("https://hooks.example.com:8443/i10"), {
      address: "2606:4700::6812:1",
      family: 6,
    })
    expect(p.url).toBe("https://[2606:4700::6812:1]:8443/i10")
    expect(p.host).toBe("hooks.example.com:8443")
  })

  it("sends no SNI over plain http", () => {
    const p = pinnedRequest(new URL("http://hooks.test:9/x"), {
      address: "8.8.8.8",
      family: 4,
    })
    expect(p.serverName).toBeUndefined()
  })
})

const record = (url: string): DeliveryRecord => ({
  id: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60aa",
  tenantId: "ten-1",
  endpointId: "ep-1",
  url,
  // Built, not pasted: a literal `whsec_` string reads as a leaked key to scanners.
  keys: [
    {
      scheme: "hmac_sha256",
      secret: `whsec_${Buffer.from("0123456789abcdef01234567").toString("base64")}`,
    },
  ],
  eventType: "email.bounced",
  occurredAt: new Date("2026-09-03T10:00:00Z"),
  payload: { email_id: "msg-1" },
  attempts: 0,
  retryPolicy: "pro",
})
const job = { deliveryId: record("x").id, endpointId: "ep-1", tenantId: "ten-1" }
const log = { info: mock(), warn: mock(), error: mock() }

/**
 * ⚠ END TO END, WITH A REAL SOCKET AND NO DNS. `hooks.test` resolves nowhere,
 * so the only way a request can reach this server is through the address the
 * vetting step chose - which is the pin working, not a mock agreeing with
 * itself.
 */
describe("delivery through a real socket", () => {
  let server: ReturnType<typeof Bun.serve>
  const seen: Array<{ host: string | null; path: string }> = []

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        seen.push({ host: req.headers.get("host"), path: new URL(req.url).pathname })
        return new Response("ok")
      },
    })
  })
  afterAll(() => server.stop(true))

  const lookup = lookupOf({ "hooks.test": [["127.0.0.1", 4]] })

  it("reaches the vetted address with the customer's Host header", async () => {
    seen.length = 0
    const url = `http://hooks.test:${server.port}/i10`
    const markDelivered = mock(async () => {})
    const outcome = await deliverWebhook(job, {
      load: async () => record(url),
      markDelivered,
      markFailed: mock(async () => {}),
      vet: (host, signal) =>
        vetHost(host, { lookup, allow: parseAllowList("127.0.0.1/32"), signal }),
      log,
    })
    expect(outcome).toEqual({ status: "delivered", responseStatus: 200 })
    expect(seen).toEqual([{ host: `hooks.test:${server.port}`, path: "/i10" }])
  })

  it("never opens the socket when the address is refused", async () => {
    seen.length = 0
    const markFailed = mock<
      (
        d: DeliveryRecord,
        o: { reason: string },
        decision: FailureDecision,
      ) => Promise<void>
    >(async () => {})
    const doFetch = mock(async () => new Response("", { status: 200 }))
    const outcome = await deliverWebhook(job, {
      load: async () => record(`http://hooks.test:${server.port}/i10`),
      markDelivered: mock(async () => {}),
      markFailed,
      fetch: doFetch as unknown as typeof fetch,
      vet: (host, signal) => vetHost(host, { lookup, signal }),
      log,
    })
    expect(outcome).toMatchObject({ status: "failed" })
    expect(doFetch).not.toHaveBeenCalled()
    expect(seen).toEqual([])
    expect(markFailed.mock.calls[0]![1].reason).toBe(
      "hooks.test resolves to 127.0.0.1, which is not a public address",
    )
  })

  it("vets by default when the caller passes no vet at all", async () => {
    seen.length = 0
    const outcome = await deliverWebhook(job, {
      load: async () => record(`http://127.0.0.1:${server.port}/i10`),
      markDelivered: mock(async () => {}),
      markFailed: mock(async () => {}),
      log,
    })
    expect(outcome).toMatchObject({ status: "failed" })
    expect(seen).toEqual([])
  })
})

describe("registering an endpoint", () => {
  const secrets = secretBox("ab".repeat(32))
  // The refusal happens before any query, so no database is needed to prove it.
  const store = (vet: (host: string) => ReturnType<typeof vetHost>) =>
    webhookEndpointStore({} as never, secrets, { vet })

  it("refuses a hostname that already resolves somewhere private", async () => {
    const r = await store((h) =>
      vetHost(h, { lookup: lookupOf({ "hooks.evil.com": [["10.0.0.1", 4]] }) }),
    ).create("ten-1", { url: "https://hooks.evil.com/x", events: ["email.sent"] })
    expect(r.status).toBe("rejected")
    if (r.status === "rejected") expect(r.reason).toContain("10.0.0.1")
  })
})
