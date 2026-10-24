import { describe, expect, it } from "bun:test"
import {
  escapeFilterValue,
  passthroughFor,
  renderFilter,
} from "../src/identity/ldap.js"
import { ldapProbe } from "../src/identity/ldap-probe.js"
import { vetHost } from "../src/webhooks/egress.js"
import { CONNECTION, connection, log, memoryStore } from "./identity-fakes.js"

describe("filter escaping (RFC 4515)", () => {
  it("escapes the five characters that change a filter", () => {
    expect(escapeFilterValue("a*b(c)d\\e\0f")).toBe("a\\2ab\\28c\\29d\\5ce\\00f")
    expect(escapeFilterValue("ada@acme.test")).toBe("ada@acme.test")
  })

  it("cannot be talked out of its term by the address", () => {
    expect(renderFilter("(mail={email})", "x)(uid=*")).toBe("(mail=x\\29\\28uid=\\2a)")
    expect(renderFilter("(|(mail={email})(uid={email}))", "*")).toBe(
      "(|(mail=\\2a)(uid=\\2a))",
    )
    // `$&` and friends are text, not replacement patterns.
    expect(renderFilter("(mail={email})", "$&")).toBe("(mail=$&)")
  })
})

describe("the setup test's egress guard", () => {
  const input = {
    host: "ldap.acme.test",
    port: 636 as const,
    tlsMode: "ldaps" as const,
    caPem: null,
    searchBase: "dc=acme,dc=test",
    userFilter: "(mail={email})",
    bindDn: "cn=svc",
    bindSecret: "secret",
    address: "ada@acme.test",
  }
  const vetting = (address: string) => (host: string, signal: AbortSignal) =>
    vetHost(host, { lookup: async () => [{ address, family: 4 }], signal })

  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "192.168.0.9",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
  ])("refuses a name that resolves to %s, before anything is sent", async (address) => {
    const probe = ldapProbe({ vet: vetting(address), log, timeoutMs: 200 })
    expect(await probe.run(input)).toEqual({ result: "unreachable" })
  })

  it("refuses an address literal that is not public", async () => {
    const probe = ldapProbe({
      vet: (host, signal) => vetHost(host, { signal }),
      log,
      timeoutMs: 200,
    })
    expect(await probe.run({ ...input, host: "127.0.0.1" })).toEqual({
      result: "unreachable",
    })
    expect(await probe.run({ ...input, host: "::1" })).toEqual({
      result: "unreachable",
    })
  })

  it("refuses a name that does not resolve", async () => {
    const probe = ldapProbe({
      vet: (host, signal) =>
        vetHost(host, {
          lookup: async () => {
            throw new Error("nxdomain")
          },
          signal,
        }),
      log,
    })
    expect(await probe.run(input)).toEqual({ result: "unreachable" })
  })
})

describe("what authd is told", () => {
  const whole = {
    ldap: {
      host: "ldap.acme.test",
      port: 636,
      tlsMode: "ldaps",
      caPem: null,
      searchBase: "dc=acme,dc=test",
      userFilter: "(mail={email})",
      enabled: true,
      serviceSet: true,
    },
  }
  const sealed = { ldap: { bindDn: "cn=svc", bindSecret: "secret" } }

  const world = (
    config: Record<string, unknown>,
    secrets?: Record<string, unknown>,
  ) => {
    const w = memoryStore({ connections: [connection({ config })] })
    if (secrets) w.secrets.set(CONNECTION, secrets)
    return w.store
  }

  it("answers the decrypted settings for an enabled, whole connection", async () => {
    expect(await passthroughFor(world(whole, sealed), CONNECTION)).toEqual({
      enabled: true,
      host: "ldap.acme.test",
      port: 636,
      tlsMode: "ldaps",
      caPem: null,
      searchBase: "dc=acme,dc=test",
      userFilter: "(mail={email})",
      bindDn: "cn=svc",
      bindSecret: "secret",
    })
  })

  it("answers off for a connection that is not enabled, is half set, or is unknown", async () => {
    expect(
      await passthroughFor(
        world({ ldap: { ...whole.ldap, enabled: false } }, sealed),
        CONNECTION,
      ),
    ).toEqual({ enabled: false })
    expect(await passthroughFor(world(whole), CONNECTION)).toEqual({ enabled: false })
    expect(
      await passthroughFor(
        world({ ldap: { ...whole.ldap, tlsMode: "none" } }, sealed),
        CONNECTION,
      ),
    ).toEqual({ enabled: false })
    expect(
      await passthroughFor(
        world({ ldap: { ...whole.ldap, userFilter: "(mail=*)" } }, sealed),
        CONNECTION,
      ),
    ).toEqual({ enabled: false })
    expect(await passthroughFor(world({}), CONNECTION)).toEqual({ enabled: false })
    expect(
      await passthroughFor(
        world(whole, sealed),
        "44444444-4444-4444-8444-444444444444",
      ),
    ).toEqual({ enabled: false })
  })

  it("does not turn a failure into an answer", async () => {
    const store = world(whole, sealed)
    store.connectionSecrets = async () => {
      throw new Error("could not unseal")
    }
    await expect(passthroughFor(store, CONNECTION)).rejects.toThrow()
  })
})
