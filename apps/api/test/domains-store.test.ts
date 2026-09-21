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
  list: async () => [],
  signature: async () => ({ origin: null, tokens: [] }),
  remove: async () => {},
  ...over,
})

const roomFor = (status: string) => ({ check: async () => ({ status }) })

const secrets = { seal: (v: string) => `sealed:${v}`, open: (v: string) => v }
const deps = {
  region: "eu-central-1",
  /**
   * ⚠ OUR OWN SENDING DOMAINS, WHICH THE STORE REFUSES. Not decoration: the
   * guard runs on every create, so a fixture without it would be testing a
   * store configured differently from the one that ships.
   */
  ownDomains: ["i10.tech"],
  dns: {
    spfInclude: "_spf.i10.tech",
    bounceHost: "mx.i10.tech",
    nameservers: ["ns1.i10.tech", "ns2.i10.tech"],
  },
  secrets,
  /**
   * ⚠ NO TEST MAY TOUCH REAL DNS, AND WITHOUT THIS EVERY ONE OF THEM WOULD.
   * `verify` proves ownership before it registers an SES identity, and the
   * store's default lookup is a real resolver — so a store built without a
   * `txt` resolves `example.com` against whatever network the test runner
   * happens to be on. That is slow, non-deterministic, and passes or fails on
   * somebody else's DNS.
   *
   * ⚠ IT ANSWERS WITH THE FIXTURE'S OWN DKIM KEY, which is what a manual domain
   * proves ownership with: the selector is per row, so the record is already an
   * account-specific fact only the domain's controller can publish.
   */
  txt: async () => ["v=DKIM1; k=rsa; p=MIIBIjANBgkq"],
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

  /**
   * ⚠ `not_started` CANNOT BE TRUE OF AN IDENTITY WE JUST CREATED, AND WRITING
   * IT ANYWAY MADE THE ROW INVISIBLE TO EVERYTHING THAT MATTERS. Two things
   * produce it from the status read: SES's own `NOT_STARTED`, and a
   * `NotFoundException` from reading back an identity a moment after creating
   * it — the adapter maps both to the same word, deliberately, because for a
   * row that was never registered they mean the same thing.
   *
   * ⚠ STORED, THOUGH, IT MEANS SOMETHING ELSE ENTIRELY TO THE REST OF THE
   * SYSTEM. `core.domains_awaiting_provider` excludes it, so the catch-up sweep
   * never asks about the row again and the domain stays `not_started` for ever
   * while SES quietly verifies it. And `ownsIdentity` in `remove` skips it, so
   * deleting the domain leaves a live identity behind in AWS. One wrong word,
   * two silent leaks.
   */
  it("never writes not_started for an identity it has just registered", async () => {
    let written: Record<string, unknown> | undefined
    const db = {
      transaction: async (fn: (t: unknown) => Promise<unknown>) =>
        fn({
          execute: async () => [],
          select: () => ({
            from: () => ({
              where: () => ({
                /*
                 * ⚠ BOTH SHAPES AT ONCE, because one fake select serves two
                 * different reads. `verify` reads the ROW, and
                 * `registerIdentity` reads the sealed private key on its own —
                 * projected as `{ sealed }`, deliberately kept out of `COLUMNS`
                 * so the only secret in this feature never travels inside the
                 * shape `present()` turns into an API response. A fixture with
                 * only the row shape makes `registerIdentity` return false, and
                 * the test then silently measures the unregistered path.
                 */
                limit: async () => [{ ...row({ status: "not_started" }), sealed: "k" }],
              }),
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
        // What SES answers for an identity it has only just been told about.
        status: async () => ({ dkimTokens: ["aaa"], status: "not_started" }),
      }),
      capacity: roomFor("allowed"),
      ...deps,
      now: () => NOW,
    }).verify(TENANT, row().id)

    expect(written).toMatchObject({ status: "pending" })
  })

  /**
   * ⚠ THE STALENESS CLOCK ONLY TICKS IF AN UNPROVEN VERIFY STAMPS IT. Every
   * unproven exit used to return without touching the row, so `dns_checked_at`
   * stayed NULL for exactly the rows the proof sweep selects — and an
   * oldest-first sweep would take the same head of the table on every run for
   * ever, while the rows behind it were never reached. Stamping it asserts only
   * that we asked.
   */
  it("stamps the check even when ownership does not prove", async () => {
    let written: Record<string, unknown> | undefined
    const db = {
      transaction: async (fn: (t: unknown) => Promise<unknown>) =>
        fn({
          execute: async () => [],
          select: () => ({
            from: () => ({
              where: () => ({ limit: async () => [row({ status: "not_started" })] }),
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

    const outcome = await domainStore({
      db,
      identity: identity(),
      capacity: roomFor("allowed"),
      ...deps,
      // ⚠ NOTHING PUBLISHED, which is the ordinary state of a domain whose
      // records have not gone up yet.
      txt: async () => [],
      now: () => NOW,
    }).verify(TENANT, row().id)

    expect(outcome.status).toBe("unproven")
    expect(written).toMatchObject({ dnsCheckedAt: NOW })
    // ⚠ AND IT ASSERTS NOTHING ELSE. Not the status, not `verified_at`.
    expect(written).not.toHaveProperty("status")
    expect(written).not.toHaveProperty("verifiedAt")
  })
})

/**
 * Somebody adding i10's own domain.
 *
 * ⚠ REFUSED RATHER THAN ALLOWED-AND-BROKEN, and the reason is not tidiness.
 * Every path after `create` assumes the customer controls the name: it would
 * generate a DKIM keypair for a zone this server is already authoritative for,
 * register a second SES identity against our own sending domain, and — on the
 * delegated path — hand a customer's claim the zone carrying OUR SPF and return
 * paths. The first mail to break would be ours.
 */
describe("adding a domain that belongs to us", () => {
  const store = () =>
    domainStore({
      // ⚠ AN INSERT HANDLER, BECAUSE THE PASSING CASES ACTUALLY CREATE. The
      // refusals never reach the database, but the suffix test below exists to
      // prove a near-miss name gets all the way through.
      db: fakeDb({ insert: () => [row()] }),
      identity: identity(),
      capacity: roomFor("allowed"),
      ...deps,
      now: () => NOW,
    })

  it("refuses our own sending domain", async () => {
    const outcome = await store().create(TENANT, { name: "i10.tech" })
    expect(outcome.status).toBe("rejected")
  })

  /**
   * ⚠ AND A SUBDOMAIN OF IT. `mail.i10.tech` is the zone our own return paths
   * live in — delegating that to a tenant is the same failure with a longer
   * name, and it is the one somebody would actually try.
   */
  it("refuses a subdomain of it too", async () => {
    for (const name of ["mail.i10.tech", "_dmarc.i10.tech", "anything.i10.tech"]) {
      expect((await store().create(TENANT, { name })).status).toBe("rejected")
    }
  })

  /** ⚠ AND IT IS A SUFFIX ON A LABEL BOUNDARY, NOT A SUBSTRING. */
  it("does not refuse a domain that merely ends with our name", async () => {
    expect((await store().create(TENANT, { name: "noti10.tech" })).status).toBe(
      "created",
    )
    expect(
      (await store().create(TENANT, { name: "i10.tech.example.com" })).status,
    ).toBe("created")
  })

  /**
   * ⚠ THE JOKE HAS TO CARRY THE NEXT STEP. A refusal that is only funny is a
   * dead end with a smile on it, and this lands in somebody's first minute.
   */
  it("says what to do instead, not just that it is ours", async () => {
    const outcome = await store().create(TENANT, { name: "i10.tech" })
    const reason = outcome.status === "rejected" ? outcome.reason : ""

    expect(reason).toContain("flattered")
    expect(reason).toContain("your own mail comes from")
  })
})
