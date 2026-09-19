import { describe, expect, it, mock } from "bun:test"
import { domainStore } from "../src/domains/store.js"
import type { Database } from "../src/db/client.js"
import type { DomainIdentity } from "../src/domains/identity.js"
import type { Zone } from "../src/domains/zone.js"

/**
 * Who is allowed to write the DNS we serve for a delegated domain.
 *
 * ⚠ THIS IS A PRIVILEGE BOUNDARY, NOT A TIDINESS RULE, AND THE REASON IS
 * CIRCULAR. A delegated domain is verified when SES resolves
 * `<selector>._domainkey.<domain>` — a lookup that follows the customer's NS
 * records into a zone WE serve. So writing the zone is not a record of a claim;
 * it is the act that MANUFACTURES the proof the claim is granted on. Whoever
 * can write the zone can verify, and whoever can verify can sign mail as that
 * domain.
 *
 * ⚠ AND BOTH HALVES WERE OPEN. `create` published the zone unverified with
 * `on conflict (name) do update`, so the second tenant to add an
 * already-delegated name silently replaced the first tenant's DKIM selector
 * underneath NS records the real owner had published. `remove` dropped the
 * zones by name with no ownership test, so any tenant holding a pending row for
 * the name could delete the DNS of whoever was actually being served.
 *
 * ⚠ `pslhq.app` IS HELD BY THREE TENANTS IN PRODUCTION TODAY, two of them
 * delegated, sharing one set of zones. Neither of these was hypothetical.
 */

const OWNER = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const STRANGER = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6072"
const ID = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60bb"
const OTHER_ID = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60cc"
const NOW = new Date("2026-09-19T12:00:00.000Z")

const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
  name: "example.com",
  mailFromSubdomain: "send",
  bounceSubdomain: "bounce",
  delegated: true,
  dkimSelector: "i10abc123",
  dkimPublicKey: "MIIBIjANBgkq",
  status: "pending",
  createdAt: NOW,
  ...over,
})

const violation = (constraint: string) =>
  Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    { code: "23505", constraint },
  )

interface Inserted {
  /** Every row handed to `tx.insert(...).values()`, in order. */
  values: Record<string, unknown>[]
}

/**
 * ⚠ THE TWO INSERTS ARE TOLD APART BY HOW THEY ARE CONSUMED, which is how the
 * store itself distinguishes them: the domain row is read back with
 * `.returning(COLUMNS)` and the claim is simply awaited. The claim insert is a
 * thenable so that `await tx.insert(delegations).values(...)` works without a
 * `.returning()` the production code does not call.
 *
 * ⚠ AND THE ROLLBACK IS POSTGRES'S JOB, NOT THIS FAKE'S. When the claim throws,
 * a real transaction discards the domain row with it — that is the whole point
 * of putting them in one transaction, and it is pinned by the migration rather
 * than here. What this file asserts is the outcome the store returns and, above
 * all, that no zone is written on the way out.
 */
function fakeDb(handlers: {
  select?: () => unknown[]
  claim?: () => unknown[]
  onClaimInsert?: (values: Record<string, unknown>) => void
  del?: () => void
}, inserted: Inserted) {
  const tx = {
    execute: async () => [],
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          inserted.values.push(values)
          return [row({ delegated: values.delegated ?? true })]
        },
        then: (ok: (v: unknown) => void, no: (e: unknown) => void) =>
          Promise.resolve()
            .then(() => {
              inserted.values.push(values)
              handlers.onClaimInsert?.(values)
            })
            .then(ok, no),
      }),
    }),
    select: (projection?: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            projection && "domainId" in projection
              ? (handlers.claim?.() ?? [])
              : (handlers.select?.() ?? []),
          orderBy: async () => handlers.select?.() ?? [],
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
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

const base = {
  region: "eu-central-1",
  dns: {
    spfInclude: "_spf.i10.tech",
    bounceHost: "mx.i10.tech",
    nameservers: ["ns1.i10.tech", "ns2.i10.tech"],
  },
  secrets: { seal: (v: string) => `sealed:${v}`, open: (v: string) => v },
  capacity: { check: async () => ({ status: "ok" }) },
}

const spyZones = () => ({
  put: mock<(zone: Zone) => Promise<void>>(async () => {}),
  remove: mock<(zoneName: string) => Promise<void>>(async () => {}),
})

describe("claiming the zones when a delegated domain is added", () => {
  it("records the claim against the domain row and the tenant", async () => {
    const inserted: Inserted = { values: [] }
    const store = domainStore({
      ...base,
      db: fakeDb({}, inserted),
      identity: identity(),
      zones: spyZones(),
    })

    const out = await store.create(OWNER, { name: "example.com", delegated: true })
    expect(out.status).toBe("created")

    const claim = inserted.values.find((v) => "domainId" in v)
    expect(claim).toEqual({ name: "example.com", domainId: ID, tenantId: OWNER })
  })

  /**
   * ⚠ A MANUAL DOMAIN MUST NOT CLAIM THE NAME, and this is the guard against
   * re-creating the squat migration 0039 removed. It publishes no zone, so
   * there is nothing for two tenants to contend over — and a claim taken here
   * would let anybody lock a name out of delegation by typing it.
   */
  it("claims nothing for a domain that publishes its own records", async () => {
    const inserted: Inserted = { values: [] }
    const store = domainStore({
      ...base,
      db: fakeDb({}, inserted),
      identity: identity(),
      zones: spyZones(),
    })

    await store.create(OWNER, { name: "example.com", delegated: false })
    expect(inserted.values.some((v) => "domainId" in v)).toBe(false)
  })
})

describe("a second workspace adding a domain somebody already delegates", () => {
  /**
   * ⚠ THE TAKEOVER THIS WHOLE FILE EXISTS FOR. Before the claim, this create
   * succeeded and `zones.put` overwrote the holder's zone with THIS tenant's
   * DKIM selector — under NS records the real owner had published. The
   * stranger's selector then resolved, SES verified them, and they could sign
   * mail as a domain they do not own, while the owner's signing broke with
   * correct records and no error anywhere.
   */
  it("is refused, and writes no zone at all", async () => {
    const inserted: Inserted = { values: [] }
    const zones = spyZones()
    const store = domainStore({
      ...base,
      db: fakeDb(
        {
          onClaimInsert: () => {
            throw violation("delegations_name_unique")
          },
        },
        inserted,
      ),
      identity: identity(),
      zones,
    })

    const out = await store.create(STRANGER, { name: "example.com", delegated: true })

    expect(out.status).toBe("conflict")
    // ⚠ THE ASSERTION THAT MATTERS. A refusal that still wrote the zone would
    // hand over the domain while apologising for it.
    expect(zones.put).not.toHaveBeenCalled()
  })

  /**
   * ⚠ AND IT SAYS "DELEGATED", NOT "VERIFIED". The holder may have proved
   * nothing — first-come is the whole point of that claim — so borrowing the
   * verified wording would send somebody to support with a question support
   * cannot answer from the row. It also has to offer the way forward that
   * actually exists: the manual path needs nothing from the holder.
   */
  it("explains what is in the way without naming who holds it", async () => {
    const inserted: Inserted = { values: [] }
    const store = domainStore({
      ...base,
      db: fakeDb(
        {
          onClaimInsert: () => {
            throw violation("delegations_name_unique")
          },
        },
        inserted,
      ),
      identity: identity(),
      zones: spyZones(),
    })

    const out = await store.create(STRANGER, { name: "example.com", delegated: true })
    const reason = out.status === "conflict" ? out.reason : ""

    expect(reason).toContain("already delegated to another workspace")
    expect(reason).toContain("without delegation")
    expect(reason).not.toContain("verified")
    // The holder is never identified — that would turn this into a lookup for
    // which domains are customers of ours.
    expect(reason).not.toContain(OWNER)
  })

  /** This tenant's own duplicate still gets the plainer message, not this one. */
  it("does not shadow the tenant's own duplicate", async () => {
    const inserted: Inserted = { values: [] }
    const store = domainStore({
      ...base,
      db: fakeDb(
        {
          onClaimInsert: () => {
            throw violation("domains_tenant_name_unique")
          },
        },
        inserted,
      ),
      identity: identity(),
      zones: spyZones(),
    })

    const out = await store.create(OWNER, { name: "example.com", delegated: true })
    expect(out.status === "conflict" && out.reason).toBe("You have already added example.com.")
  })
})

describe("deleting a delegated domain", () => {
  it("removes the three zones when this row is the one being served", async () => {
    const zones = spyZones()
    const store = domainStore({
      ...base,
      db: fakeDb(
        { select: () => [row()], claim: () => [{ domainId: ID }] },
        { values: [] },
      ),
      identity: identity(),
      zones,
    })

    expect(await store.remove(OWNER, ID)).toBe(true)
    expect(zones.remove.mock.calls.map(([name]) => name).sort()).toEqual([
      "_dmarc.example.com",
      "_domainkey.example.com",
      "mail.example.com",
    ])
  })

  /**
   * ⚠ THE CROSS-TENANT DELETE. A tenant holding a pending row for a name
   * somebody else is actually serving used to remove that name's zones on the
   * way out: their own delete succeeded, and a different customer's mail
   * stopped resolving with nothing in either account to explain it. The row is
   * still deleted — it is theirs — but the DNS is not theirs to take.
   */
  it("removes no zone when a different row holds the claim", async () => {
    let deleted = false
    const zones = spyZones()
    const store = domainStore({
      ...base,
      db: fakeDb(
        {
          select: () => [row()],
          claim: () => [{ domainId: OTHER_ID }],
          del: () => {
            deleted = true
          },
        },
        { values: [] },
      ),
      identity: identity(),
      zones,
    })

    expect(await store.remove(STRANGER, ID)).toBe(true)
    expect(deleted).toBe(true)
    expect(zones.remove).not.toHaveBeenCalled()
  })

  /** A claim that is simply absent is not a licence to delete either. */
  it("removes no zone when there is no claim to read", async () => {
    const zones = spyZones()
    const store = domainStore({
      ...base,
      db: fakeDb({ select: () => [row()], claim: () => [] }, { values: [] }),
      identity: identity(),
      zones,
    })

    expect(await store.remove(STRANGER, ID)).toBe(true)
    expect(zones.remove).not.toHaveBeenCalled()
  })

  /** A manual domain never asks, because it never had zones. */
  it("does not look for a claim for a domain that was never delegated", async () => {
    const claim = mock(() => [])
    const zones = spyZones()
    const store = domainStore({
      ...base,
      db: fakeDb({ select: () => [row({ delegated: false })], claim }, { values: [] }),
      identity: identity(),
      zones,
    })

    expect(await store.remove(OWNER, ID)).toBe(true)
    expect(claim).not.toHaveBeenCalled()
    expect(zones.remove).not.toHaveBeenCalled()
  })
})
