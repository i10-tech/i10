import { describe, expect, it, mock } from "bun:test"
import { domainStore, normaliseDomainName } from "../src/domains/store.js"
import type { Database } from "../src/db/client.js"
import type { DomainIdentity } from "../src/domains/identity.js"

const TENANT = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const NOW = new Date("2026-09-05T12:00:00.000Z")

const row = (over: Record<string, unknown> = {}) => ({
  id: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60bb",
  name: "example.com",
  mailFromSubdomain: "send",
  bounceSubdomain: "bounce",
  delegated: false,
  dkimSelector: "i10abc123",
  dkimPublicKey: "MIIBIjANBgkq",
  status: "pending",
  createdAt: NOW,
  ...over,
})

/** Enough drizzle to satisfy the store, and nothing more. */
function fakeDb(handlers: {
  insert?: () => unknown[]
  select?: () => unknown[]
  update?: () => unknown[]
  del?: () => void
}) {
  const tx = {
    execute: async () => [],
    insert: () => ({
      values: () => ({ returning: async () => handlers.insert?.() ?? [] }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => handlers.select?.() ?? [],
          orderBy: async () => handlers.select?.() ?? [],
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({ returning: async () => handlers.update?.() ?? [] }),
      }),
    }),
    delete: () => ({
      where: async () => {
        handlers.del?.()
      },
    }),
  }
  return {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as Database
}

const identity = (over: Partial<DomainIdentity> = {}): DomainIdentity => ({
  create: async () => ({ dkimTokens: ["aaa"], status: "pending" }),
  status: async () => ({ dkimTokens: ["aaa"], status: "pending" }),
  remove: async () => {},
  ...over,
})

const roomFor = (status: string) => ({ check: async () => ({ status }) })

const secrets = { seal: (v: string) => `sealed:${v}`, open: (v: string) => v }
const deps = {
  region: "eu-central-1",
  dns: {
    spfInclude: "_spf.i10.tech",
    bounceHost: "mx.i10.tech",
    nameservers: ["ns1.i10.tech", "ns2.i10.tech"],
  },
  secrets,
}

describe("what counts as a domain name", () => {
  /**
   * ⚠ BOTH OF THESE ARE THINGS PEOPLE PASTE, and both would create a domain
   * that can never verify — the record names would be built from the wrong
   * string and nothing would say so.
   */
  it("refuses a URL or an address", () => {
    for (const bad of [
      "https://example.com",
      "me@example.com",
      "example .com",
      "localhost",
      "",
    ]) {
      expect(normaliseDomainName(bad)).toBeNull()
    }
  })

  it("lowercases and drops a trailing dot", () => {
    expect(normaliseDomainName("  EXAMPLE.com. ")).toBe("example.com")
  })

  it("accepts a subdomain", () => {
    expect(normaliseDomainName("mail.example.co.uk")).toBe("mail.example.co.uk")
  })
})

describe("the plan limit", () => {
  /**
   * ⚠ THE ASSERTION THIS WHOLE FEATURE EXISTS TO MAKE. Before this route,
   * nothing in the application wrote `core.domains`, so the entitlement, the
   * level adapter and the meter had no call site and no limit was enforced
   * anywhere.
   */
  it("refuses a domain past the allowance", async () => {
    const create = mock()
    const store = domainStore({
      db: fakeDb({}),
      identity: identity({ create }),
      capacity: roomFor("exceeded"),
      ...deps,
      now: () => NOW,
    })

    const outcome = await store.create(TENANT, { name: "example.com" })
    expect(outcome.status).toBe("limit")
    // ⚠ AND NO IDENTITY WAS CREATED. Creating it first and then refusing leaves
    // a verified identity in AWS that no row points at — invisible, billable,
    // and still able to send.
    expect(create).not.toHaveBeenCalled()
  })

  /**
   * ⚠ `unentitled` IS OUR MISCONFIGURATION, NOT THE CUSTOMER'S. Same policy as
   * the send path: allow, and let the reconciler find it.
   */
  it("allows when the tenant holds no plan", async () => {
    const store = domainStore({
      db: fakeDb({ insert: () => [row()] }),
      identity: identity(),
      capacity: roomFor("unentitled"),
      ...deps,
      now: () => NOW,
    })
    expect((await store.create(TENANT, { name: "example.com" })).status).toBe("created")
  })
})

describe("creating", () => {
  it("returns the records to publish", async () => {
    const store = domainStore({
      db: fakeDb({ insert: () => [row()] }),
      identity: identity(),
      capacity: roomFor("allowed"),
      ...deps,
      now: () => NOW,
    })

    const outcome = await store.create(TENANT, { name: "Example.com" })
    expect(outcome).toMatchObject({ status: "created" })
    if (outcome.status !== "created") return
    expect(outcome.domain.name).toBe("example.com")
    expect(outcome.domain.records.some((r) => r.record === "DKIM")).toBe(true)
    expect(outcome.domain.region).toBe("eu-central-1")
  })

  /**
   * ⚠ THE MESSAGE MUST NOT SAY WHOSE. `core.domains.name` is unique across every
   * tenant, so this fires for somebody else's domain too — and "another
   * customer has example.com" is a way to enumerate our customers.
   */
  it("reports a duplicate without saying whose it is", async () => {
    const store = domainStore({
      db: fakeDb({
        insert: () => {
          throw Object.assign(new Error("duplicate key"), { code: "23505" })
        },
      }),
      identity: identity(),
      capacity: roomFor("allowed"),
      ...deps,
      now: () => NOW,
    })

    const outcome = await store.create(TENANT, { name: "example.com" })
    expect(outcome.status).toBe("conflict")
    if (outcome.status !== "conflict") return
    expect(outcome.reason).not.toMatch(/tenant|customer|another account/i)
  })

  // ⚠ Resend has no concept of hosting mail, so a domain created through its
  // API must never land in Stalwart's recipient table.
  it("never creates a mailbox domain", async () => {
    let written: Record<string, unknown> | undefined
    const db = {
      transaction: async (fn: (t: unknown) => Promise<unknown>) =>
        fn({
          execute: async () => [],
          // ⚠ `create` READS BEFORE IT WRITES NOW. It refuses a duplicate —
          // this tenant's own, or a name verified elsewhere — before calling
          // SES, because that call would overwrite the holder's DKIM key. An
          // empty answer here is "the name is free".
          select: () => ({
            from: () => ({ where: () => ({ limit: async () => [] }) }),
          }),
          insert: () => ({
            values: (v: Record<string, unknown>) => {
              written = v
              return { returning: async () => [row()] }
            },
          }),
        }),
    } as unknown as Database

    await domainStore({
      db,
      identity: identity(),
      capacity: roomFor("allowed"),
      ...deps,
      now: () => NOW,
    }).create(TENANT, { name: "example.com" })

    expect(written).toMatchObject({ sends: true, hostsMailboxes: false })
  })
})

describe("verifying", () => {
  /**
   * ⚠ `verified_at` IS THE MOMENT IT FIRST BECAME USABLE AND IS NEVER MOVED
   * BACKWARDS. A transient `temporary_failure` must not un-verify a working
   * domain — the mailbox projection and the send path both read that column as
   * "has this ever been proven".
   */
  it("does not clear verified_at on a temporary failure", async () => {
    let written: Record<string, unknown> | undefined
    const db = {
      transaction: async (fn: (t: unknown) => Promise<unknown>) =>
        fn({
          execute: async () => [],
          select: () => ({
            from: () => ({
              where: () => ({ limit: async () => [row({ status: "verified" })] }),
            }),
          }),
          update: () => ({
            set: (v: Record<string, unknown>) => {
              written = v
              return { where: () => ({ returning: async () => [row()] }) }
            },
          }),
        }),
    } as unknown as Database

    await domainStore({
      db,
      identity: identity({
        status: async () => ({ dkimTokens: ["aaa"], status: "temporary_failure" }),
      }),
      capacity: roomFor("allowed"),
      ...deps,
      now: () => NOW,
    }).verify(TENANT, row().id)

    expect(written).toMatchObject({ status: "temporary_failure" })
    expect(written).not.toHaveProperty("verifiedAt")
  })

  it("stamps verified_at the first time it passes", async () => {
    let written: Record<string, unknown> | undefined
    const db = {
      transaction: async (fn: (t: unknown) => Promise<unknown>) =>
        fn({
          execute: async () => [],
          select: () => ({
            from: () => ({
              where: () => ({ limit: async () => [row({ status: "pending" })] }),
            }),
          }),
          update: () => ({
            set: (v: Record<string, unknown>) => {
              written = v
              return { where: () => ({ returning: async () => [row()] }) }
            },
          }),
        }),
    } as unknown as Database

    await domainStore({
      db,
      identity: identity({
        status: async () => ({ dkimTokens: ["aaa"], status: "verified" }),
      }),
      capacity: roomFor("allowed"),
      ...deps,
      now: () => NOW,
    }).verify(TENANT, row().id)

    expect(written).toMatchObject({ status: "verified", verifiedAt: NOW })
  })
})
