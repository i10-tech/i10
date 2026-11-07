import { describe, expect, it } from "bun:test"
import { createInternalAuthdRoutes } from "../src/routes/authd.js"
import type { PassthroughAnswer } from "../src/identity/ldap.js"

/**
 * authd's pass-through lookup (#344): the answer carries a company's service
 * secret, so the caller is checked first, in constant time, and an outage is a
 * 503 - never "off".
 */

const SECRET = "authd-shared-secret-0123456789abcdef"
const ID = "33333333-3333-4333-8333-333333333333"
const ENABLED: PassthroughAnswer = {
  enabled: true,
  lane: "ldap",
  host: "ldap.acme.test",
  port: 636,
  tlsMode: "ldaps",
  caPem: null,
  searchBase: "dc=acme,dc=test",
  userFilter: "(mail={email})",
  bindDn: "cn=svc",
  bindSecret: "service-secret",
}

function app(
  over: { secret?: string | undefined; answer?: () => Promise<PassthroughAnswer> } = {},
) {
  const calls: string[] = []
  const errors: object[] = []
  const routes = createInternalAuthdRoutes({
    secret: "secret" in over ? over.secret : SECRET,
    passthrough: async (id) => {
      calls.push(id)
      return (over.answer ?? (async () => ENABLED))()
    },
    log: { error: (o) => errors.push(o) },
  })
  const post = (headers: Record<string, string>, body: unknown) =>
    routes.request("/passthrough", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  return { post, calls, errors }
}

describe("POST /internal/authd/passthrough", () => {
  it("refuses a caller without the secret, and reads nothing for them", async () => {
    const w = app()
    expect((await w.post({}, { connectionId: ID })).status).toBe(401)
    expect(
      (await w.post({ Authorization: "Bearer " }, { connectionId: ID })).status,
    ).toBe(401)
    expect((await w.post({ Authorization: SECRET }, { connectionId: ID })).status).toBe(
      401,
    )
    expect(
      (await w.post({ Authorization: "Basic " + SECRET }, { connectionId: ID })).status,
    ).toBe(401)
    expect(
      (await w.post({ Authorization: "Bearer wrong" }, { connectionId: ID })).status,
    ).toBe(401)
    // The same length, one character off: the comparison is the whole check.
    const near = SECRET.slice(0, -1) + "X"
    expect(near.length).toBe(SECRET.length)
    const res = await w.post({ Authorization: `Bearer ${near}` }, { connectionId: ID })
    expect(res.status).toBe(401)
    expect(JSON.stringify(await res.json())).not.toContain("service-secret")
    expect(w.calls).toEqual([])
  })

  it("is unavailable, not open, when no secret is configured", async () => {
    const w = app({ secret: undefined })
    const res = await w.post({ Authorization: "Bearer anything" }, { connectionId: ID })
    expect(res.status).toBe(503)
    expect(w.calls).toEqual([])
  })

  it("answers the settings to the one caller, uncached", async () => {
    const w = app()
    const res = await w.post(
      { Authorization: `Bearer ${SECRET}` },
      { connectionId: ID },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual(ENABLED)
    expect(w.calls).toEqual([ID])
  })

  it("answers an Okta connection with the issuer and the client id, and nothing secret", async () => {
    const okta: PassthroughAnswer = {
      enabled: true,
      lane: "okta",
      issuer: "https://acme.okta.com/oauth2/default",
      clientId: "0oa1b2c3d4e5f6g7h8i9",
    }
    const w = app({ answer: async () => okta })
    const res = await w.post(
      { Authorization: `Bearer ${SECRET}` },
      { connectionId: ID },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(okta)
  })

  it("passes 'off' on as off", async () => {
    const w = app({ answer: async () => ({ enabled: false }) })
    const res = await w.post(
      { Authorization: `Bearer ${SECRET}` },
      { connectionId: ID },
    )
    expect(await res.json()).toEqual({ enabled: false })
  })

  it("validates the body strictly", async () => {
    const w = app()
    const auth = { Authorization: `Bearer ${SECRET}` }
    for (const body of [
      {},
      { connectionId: "nope" },
      { connectionId: ID, extra: 1 },
      "not json",
      "[]",
    ])
      expect((await w.post(auth, body)).status).toBe(422)
    expect((await w.post(auth, "x".repeat(2000))).status).toBe(413)
    expect(w.calls).toEqual([])
  })

  it("is a 503 when it cannot find out, never 'off'", async () => {
    const w = app({
      answer: async () => {
        throw new Error("database down: password=hunter2")
      },
    })
    const res = await w.post(
      { Authorization: `Bearer ${SECRET}` },
      { connectionId: ID },
    )
    expect(res.status).toBe(503)
    expect(JSON.stringify(await res.json())).not.toContain("enabled")
    // The error's name, never its message.
    expect(JSON.stringify(w.errors)).not.toContain("hunter2")
  })
})
