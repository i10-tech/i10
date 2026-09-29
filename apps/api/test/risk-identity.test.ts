import { describe, expect, it, mock } from "bun:test"
import {
  impossibleTravel,
  isHostingNetwork,
  recordSighting,
  signClientContext,
  subnetOf,
  takeoverResponder,
  verifyClientContext,
  type IdentityStore,
  type RiskRedis,
  type SightingInput,
} from "../src/risk/identity.js"
import { sessionIdOf, sessionObserver } from "../src/risk/session.js"
import { countryDistanceKm } from "../src/risk/geo.js"

/**
 * What we see of people (#170): the signed context, the network, the
 * impossible journey, and the takeover response.
 */
const SECRET = "x".repeat(40)
const T0 = new Date("2026-09-28T12:00:00Z")

function fakeRedis(): RiskRedis & {
  keys: Set<string>
  tor: Set<string>
  sadd: ReturnType<typeof mock>
} {
  const keys = new Set<string>()
  const tor = new Set<string>()
  return {
    keys,
    tor,
    async set(key: string) {
      if (keys.has(key)) return null
      keys.add(key)
      return "OK"
    },
    async sismember(_k: string, m: string) {
      return tor.has(m) ? 1 : 0
    },
    sadd: mock(async () => 1),
  }
}

function fakeStore(last: { country: string; at: Date } | null = null) {
  const rows: SightingInput[] = []
  const store: IdentityStore = {
    record: mock(async (i: SightingInput) => {
      rows.push(i)
    }),
    lastLocated: mock(async () => (last ? { ...last, sessionId: "s0" } : null)),
  }
  return { store, rows }
}

const sighting = (over: Partial<Parameters<typeof recordSighting>[0]> = {}) => ({
  userId: "user_1",
  tenantId: "ten-1",
  sessionId: "s1",
  ip: "81.2.69.160",
  country: "DE",
  userAgent: "Mozilla",
  deviceId: "dev-1",
  timezone: "Europe/Berlin",
  language: "de",
  ...over,
})

describe("the signed client context", () => {
  it("round-trips when signed with the shared secret", () => {
    const header = signClientContext(
      { ip: "1.2.3.4", country: "DE", ts: T0.getTime() },
      SECRET,
    )
    expect(verifyClientContext(header, SECRET, T0.getTime())?.country).toBe("DE")
  })

  it("refuses a tampered payload, a wrong secret, a stale one, or none", () => {
    const header = signClientContext(
      { ip: "1.2.3.4", country: "DE", ts: T0.getTime() },
      SECRET,
    )
    const [payload, sig] = header.split(".")
    const forged = Buffer.from(
      JSON.stringify({ ip: "1.2.3.4", country: "US", ts: T0.getTime() }),
    ).toString("base64url")
    expect(verifyClientContext(`${forged}.${sig}`, SECRET, T0.getTime())).toBeNull()
    expect(verifyClientContext(header, "y".repeat(40), T0.getTime())).toBeNull()
    expect(verifyClientContext(header, SECRET, T0.getTime() + 10 * 60_000)).toBeNull()
    expect(verifyClientContext(`${payload}`, SECRET, T0.getTime())).toBeNull()
    expect(verifyClientContext(header, undefined, T0.getTime())).toBeNull()
    expect(verifyClientContext(null, SECRET, T0.getTime())).toBeNull()
  })

  it("drops an IP that is not an IP", () => {
    const header = signClientContext({ ip: "not-an-ip", ts: T0.getTime() }, SECRET)
    expect(verifyClientContext(header, SECRET, T0.getTime())?.ip).toBeUndefined()
  })
})

describe("networks", () => {
  it("groups IPv4 by /24 and IPv6 by /48", () => {
    expect(subnetOf("81.2.69.160")).toBe("81.2.69")
    expect(subnetOf("2001:db8:abcd:12::1")).toBe("2001:db8:abcd")
    expect(subnetOf("2001:db8::1")).toBe("2001:db8:0")
    expect(subnetOf("garbage")).toBeNull()
    expect(subnetOf(null)).toBeNull()
  })

  it("recognises hosting providers and leaves ISPs alone", () => {
    expect(isHostingNetwork("DIGITALOCEAN-ASN", "digitalocean.com")).toBe(true)
    expect(isHostingNetwork("Hetzner Online GmbH", "hetzner.com")).toBe(true)
    expect(isHostingNetwork("Deutsche Telekom AG", "telekom.de")).toBe(false)
    expect(isHostingNetwork("Comcast Cable", "comcast.net")).toBe(false)
  })
})

describe("impossible travel", () => {
  it("flags Germany then Brazil within an hour", () => {
    const r = impossibleTravel(
      { country: "DE", at: T0, sessionId: "a" },
      { country: "BR", at: new Date(T0.getTime() + 3_600_000), sessionId: "b" },
    )
    expect(r?.km).toBeGreaterThan(8000)
  })

  it("allows a flight's worth of time", () => {
    expect(
      impossibleTravel(
        { country: "DE", at: T0, sessionId: "a" },
        { country: "BR", at: new Date(T0.getTime() + 14 * 3_600_000), sessionId: "b" },
      ),
    ).toBeNull()
  })

  it("ignores neighbours, the same country and unknowns", () => {
    const soon = new Date(T0.getTime() + 60_000)
    expect(
      impossibleTravel(
        { country: "DE", at: T0, sessionId: "a" },
        { country: "AT", at: soon, sessionId: "b" },
      ),
    ).toBeNull()
    expect(
      impossibleTravel(
        { country: "DE", at: T0, sessionId: "a" },
        { country: "DE", at: soon, sessionId: "b" },
      ),
    ).toBeNull()
    expect(
      impossibleTravel(null, { country: "DE", at: soon, sessionId: "b" }),
    ).toBeNull()
    expect(
      impossibleTravel(
        { country: "ZZ", at: T0, sessionId: "a" },
        { country: "BR", at: soon, sessionId: "b" },
      ),
    ).toBeNull()
  })

  it("knows how far apart countries are", () => {
    expect(countryDistanceKm("US", "JP")!).toBeGreaterThan(9000)
    expect(countryDistanceKm("XX", "JP")).toBeNull()
  })
})

describe("recording a sighting", () => {
  it("records once per session, place and device for half an hour", async () => {
    const redis = fakeRedis()
    const { store, rows } = fakeStore()
    expect(await recordSighting(sighting(), { store, redis, now: () => T0 })).toBe(
      "recorded",
    )
    expect(await recordSighting(sighting(), { store, redis, now: () => T0 })).toBe(
      "duplicate",
    )
    expect(
      await recordSighting(sighting({ country: "FR" }), {
        store,
        redis,
        now: () => T0,
      }),
    ).toBe("recorded")
    expect(rows).toHaveLength(2)
  })

  it("marks a Tor exit from the list, or from Cloudflare's T1 hint", async () => {
    const redis = fakeRedis()
    redis.tor.add("81.2.69.160")
    const { store, rows } = fakeStore()
    await recordSighting(sighting(), { store, redis, now: () => T0 })
    await recordSighting(sighting({ ip: "5.5.5.5", sessionId: "s9", torHint: true }), {
      store,
      redis,
      now: () => T0,
    })
    expect(rows.map((r) => r.tor)).toEqual([true, true])
  })

  it("on an impossible journey records the anomaly, responds, and re-scores", async () => {
    const redis = fakeRedis()
    const { store, rows } = fakeStore({
      country: "BR",
      at: new Date(T0.getTime() - 30 * 60_000),
    })
    const respond = mock(async () => {})
    const rescore = mock(() => {})
    const r = await recordSighting(sighting(), {
      store,
      redis,
      takeover: { respond },
      rescore,
      now: () => T0,
    })
    expect(r).toBe("anomaly")
    expect(rows.map((x) => x.kind)).toEqual(["session", "anomaly"])
    expect(respond).toHaveBeenCalledTimes(1)
    expect(rescore).toHaveBeenCalledWith("ten-1", "identity-anomaly")
  })

  it("survives a takeover response that throws", async () => {
    const redis = fakeRedis()
    const { store } = fakeStore({ country: "BR", at: T0 })
    const r = await recordSighting(sighting(), {
      store,
      redis,
      takeover: {
        respond: async () => {
          throw new Error("clerk down")
        },
      },
      now: () => T0,
    })
    expect(r).toBe("anomaly")
  })
})

describe("the takeover response", () => {
  const clerk = () => ({
    sessions: {
      getSessionList: mock(async () => ({
        data: [{ id: "sess_a" }, { id: "sess_b" }],
      })),
      revokeSession: mock(async () => ({})),
    },
  })

  it("revokes every session, records it and emails the person, once a day", async () => {
    const c = clerk()
    const redis = fakeRedis()
    const { store, rows } = fakeStore()
    const notify = mock(async () => {})
    const t = takeoverResponder({ clerk: c, store, redis, notify, enabled: true })
    await t.respond({
      userId: "u",
      tenantId: "ten-1",
      detail: { from: "DE", to: "BR" },
    })
    await t.respond({
      userId: "u",
      tenantId: "ten-1",
      detail: { from: "DE", to: "BR" },
    })
    expect(c.sessions.revokeSession).toHaveBeenCalledTimes(2)
    expect(rows.filter((r) => r.kind === "takeover_response")).toHaveLength(1)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it("does nothing when switched off", async () => {
    const c = clerk()
    const t = takeoverResponder({
      clerk: c,
      store: fakeStore().store,
      redis: fakeRedis(),
      enabled: false,
    })
    await t.respond({ userId: "u", tenantId: null, detail: {} })
    expect(c.sessions.getSessionList).not.toHaveBeenCalled()
  })
})

describe("the console session observer", () => {
  const jwt = (claims: object) =>
    `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`

  it("reads the session id from an already-verified token", () => {
    const req = new Request("http://x", {
      headers: { authorization: `Bearer ${jwt({ sid: "sess_1" })}` },
    })
    expect(sessionIdOf(req)).toBe("sess_1")
    expect(sessionIdOf(new Request("http://x"))).toBeNull()
  })

  it("trusts the signed context, and records nothing without an IP", async () => {
    const redis = fakeRedis()
    const { store, rows } = fakeStore()
    const observe = sessionObserver({ store, redis, secret: SECRET })
    const signed = signClientContext(
      {
        ip: "81.2.69.160",
        country: "DE",
        device: "d",
        tz: "Europe/Berlin",
        ts: Date.now(),
      },
      SECRET,
    )
    observe({
      userId: "u",
      tenantId: "t",
      request: new Request("http://x", { headers: { "x-i10-client": signed } }),
    })
    observe({
      userId: "u2",
      tenantId: "t",
      request: new Request("http://x", { headers: { "x-i10-client": "forged.sig" } }),
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.deviceId).toBe("d")
  })

  it("reads Cloudflare's T1 as Tor and never as a country", async () => {
    const redis = fakeRedis()
    const { store, rows } = fakeStore()
    const observe = sessionObserver({ store, redis })
    observe({
      userId: "u",
      tenantId: "t",
      request: new Request("http://x", {
        headers: { "cf-connecting-ip": "9.9.9.9", "cf-ipcountry": "T1" },
      }),
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(rows[0]!.tor).toBe(true)
    expect(rows[0]!.country).toBeNull()
  })
})
