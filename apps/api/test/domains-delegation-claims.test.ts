import { describe, expect, it, mock } from "bun:test"
import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import { domainStore } from "../src/domains/store.js"
import type { Database } from "../src/db/client.js"
import type { DomainIdentity } from "../src/domains/identity.js"
import type { Zone } from "../src/domains/zone.js"
import type { DelegationProbe } from "../src/domains/ownership.js"

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
 * ⚠ ARRIVAL ORDER IS NOT EVIDENCE, AND FOR ONE TURN IT WAS STANDING IN FOR IT.
 * Every delegating customer publishes the same two nameservers, so nothing that
 * reaches DNS says which workspace produced it. That left the scenario below
 * wide open, and it is the one this file is really about:
 *
 *   1. a stranger adds `example.com`, picks delegation, publishes nothing;
 *   2. the real owner adds `example.com` and publishes the NS records;
 *   3. the owner's delegation resolves to the STRANGER'S zone, carrying the
 *      stranger's DKIM selector, and SES verifies the stranger.
 *
 * The owner did everything correctly and handed over their domain by doing it.
 * The challenge record is what makes step 3 impossible.
 */

const OWNER = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const STRANGER = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6072"
const ID = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60bb"
const OTHER_ID = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60cc"
const NOW = new Date("2026-09-19T12:00:00.000Z")

const OWNER_TOKEN = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"
const STRANGER_TOKEN = "ffffffffffffffffffffffffffffffff"

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
  delegationToken: OWNER_TOKEN,
  ...over,
})

const dialect = new PgDialect()

/**
 * ⚠ THE RAW-SQL CALLS ARE TOLD APART BY THEIR TEXT, because `store.ts` reaches
 * two different SECURITY DEFINER functions through `db.execute` and they mean
 * opposite things. `domain_verified_elsewhere` answers "may this workspace even
 * try"; `delegation_holder` / `verified_holder` answer "who is in the way, so we
 * can re-check whether they still own it". One handler for both would make a
 * test that means to describe an incumbent silently answer the other question.
 */
const queryText = (q: unknown) => dialect.sqlToQuery(q as SQL).sql

const violation = (constraint: string) =>
  Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    { code: "23505", constraint },
  )

/**
 * ⚠ THE CLAIM READ IS TOLD APART BY ITS PROJECTION, not by call order, so it
 * stays correct if `verify` ever reorders its two reads. Everything else here
 * is the smallest shape the store actually touches.
 */
function fakeDb(handlers: {
  select?: () => unknown[]
  claim?: () => unknown[]
  onClaimInsert?: () => void
  del?: () => void
  /** `core.delegation_holder` — who a challenger must displace, if anybody. */
  holder?: () => unknown[]
  /**
   * `core.zone_owner` — who a delegated domain's zones belong to on delete.
   *
   * ⚠ IT IS SEPARATE FROM `claim` BECAUSE THE QUESTION SPANS TENANTS AND THE
   * DRIZZLE READ DOES NOT. `claim` models this tenant's own row in
   * `core.delegations`, which is what `settleDelegation` reads; this models the
   * definer function `remove` asks, which also has to know how many OTHER
   * workspaces hold the same name. Answering the second with the first is what
   * made a claimless zone look unowned.
   */
  zoneOwner?: () => unknown[]
  /** Every raw statement the store issued, so displacement can be observed. */
  onExecute?: (text: string) => void
}) {
  const tx = {
    execute: async (q: unknown) => {
      const text = queryText(q)
      handlers.onExecute?.(text)
      if (text.includes("zone_owner")) return handlers.zoneOwner?.() ?? []
      return text.includes("_holder") ? (handlers.holder?.() ?? []) : [{ taken: false }]
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => [row(values)],
        then: (ok: (v: unknown) => void, no: (e: unknown) => void) =>
          Promise.resolve()
            .then(() => handlers.onClaimInsert?.())
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
      set: () => ({
        where: () => ({ returning: async () => handlers.select?.() ?? [] }),
      }),
    }),
    delete: () => ({
      where: async () => {
        handlers.del?.()
      },
    }),
  }
  return {
    execute: tx.execute,
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

const base = {
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
  secrets: { seal: (v: string) => `sealed:${v}`, open: (v: string) => v },
  capacity: { check: async () => ({ status: "ok" }) },
}

const spyZones = () => ({
  put: mock<(zone: Zone) => Promise<void>>(async () => {}),
  remove: mock<(zoneName: string) => Promise<void>>(async () => {}),
})

/**
 * A parent zone that delegates to the given claims' nameservers.
 *
 * ⚠ THE CLAIM IS IN THE NAMESERVER NAME, WHICH IS THE WHOLE DESIGN. There is no
 * challenge record any more: `<claim>.ns1.i10.tech` can only be published by
 * whoever holds the domain's DNS, and the label says whose claim it is. Passing
 * several claims is a domain whose parent lists more than one — a customer
 * mid-migration, or two workspaces that both hold the DNS.
 */
const delegating = (...claims: string[]): DelegationProbe =>
  mock(async () =>
    claims.length === 0
      ? ({ kind: "undelegated" } as const)
      : {
          kind: "delegated" as const,
          nameservers: claims.flatMap((c) => [
            `${c}.ns1.i10.tech`,
            `${c}.ns2.i10.tech`,
          ]),
        },
  )

describe("adding a delegated domain", () => {
  /**
   * ⚠ ADDING A DOMAIN ASSERTS NOTHING, SO IT MAY NOT PUBLISH DNS. This is the
   * half of the takeover that `create` was responsible for: the zone went out
   * with `on conflict (name) do update`, so the second workspace to type an
   * already-delegated name silently replaced the first one's DKIM selector.
   */
  it("publishes no zone, because nothing has been proved yet", async () => {
    const zones = spyZones()
    const store = domainStore({
      ...base,
      db: fakeDb({}),
      identity: identity(),
      zones,
      delegation: delegating(),
    })

    const out = await store.create(OWNER, { name: "example.com", delegated: true })
    expect(out.status).toBe("created")
    expect(zones.put).not.toHaveBeenCalled()
  })

  /**
   * ⚠ AND IT NO LONGER REFUSES A NAME SOMEBODY ELSE TYPED FIRST, which is
   * migration 0039's rule restored. Exclusivity on arrival meant a free signup
   * could lock any domain in the world out of delegation; exclusivity on proof
   * cannot be mounted by anyone who does not hold the DNS.
   */
  it("lets a second workspace add the same name", async () => {
    const store = domainStore({
      ...base,
      db: fakeDb({}),
      identity: identity(),
      zones: spyZones(),
      delegation: delegating(),
    })

    const out = await store.create(STRANGER, { name: "example.com", delegated: true })
    expect(out.status).toBe("created")
  })

  /**
   * ⚠ NO CHALLENGE RECORD, AND ITS ABSENCE IS THE FEATURE. One used to be
   * necessary because every customer published the same two nameservers, so the
   * delegation established that SOMEBODY had delegated the name and nothing
   * about who. The claim now lives in the nameserver names themselves, which
   * only the holder of the domain's DNS can publish — so the seventh record,
   * and the explaining that went with it, are gone.
   */
  it("asks for six NS records carrying this row's claim, and nothing else", async () => {
    const store = domainStore({
      ...base,
      db: fakeDb({}),
      identity: identity(),
      zones: spyZones(),
      delegation: delegating(),
    })

    const out = await store.create(OWNER, { name: "example.com", delegated: true })
    const records = out.status === "created" ? out.domain.records : []

    expect(records).toHaveLength(6)
    expect(records.every((r) => r.type === "NS")).toBe(true)
    expect(records.map((r) => r.value)).toContain(`${OWNER_TOKEN}.ns1.i10.tech`)

    // ⚠ AND NEVER A BARE NAMESERVER NAME, which would prove only that somebody
    // delegated to i10 — precisely the hole this design closes.
    expect(records.some((r) => r.value === "ns1.i10.tech")).toBe(false)
    expect(records.some((r) => r.type === "TXT")).toBe(false)
  })
})

describe("the squatter, verifying a domain they do not own", () => {
  /**
   * ⚠ THE WHOLE POINT. The stranger holds a row for `example.com` and the REAL
   * OWNER has published a challenge — theirs, carrying the owner's token. The
   * stranger's verify finds a challenge record at the right name and must still
   * refuse it, because the token is not the one issued to their row.
   */
  it("is refused even though a challenge record exists, because the token is not theirs", async () => {
    const zones = spyZones()
    let claimed = false
    const store = domainStore({
      ...base,
      db: fakeDb({
        select: () => [row({ delegationToken: STRANGER_TOKEN })],
        claim: () => [],
        onClaimInsert: () => {
          claimed = true
        },
      }),
      identity: identity(),
      zones,
      // the owner's record, published by the owner, in the owner's zone
      delegation: delegating(OWNER_TOKEN),
    })

    const out = await store.verify(STRANGER, ID)

    expect(out.status).toBe("unproven")
    /*
     * ⚠ `superseded`, AND THE SQUATTER GETS THE SAME WORD THE REAL OWNER WOULD.
     * From DNS alone the two situations are IDENTICAL: the parent delegates to
     * our nameservers under a claim that is not this row's. That is true of a
     * customer who deleted their domain and added it again, and equally true of
     * a stranger looking at somebody else's delegation. Nothing in a referral
     * says which, so the check reports what it saw rather than guessing at
     * intent.
     *
     * ⚠ AND IT DISCLOSES NOTHING, which is the only reason this is acceptable.
     * The message tells them these nameservers are i10's — a fact anybody can
     * read with `dig NS mail.example.com` — and never names the workspace
     * holding it, the same restraint `create`'s conflict wording keeps. Acting
     * on the advice requires control of the domain's DNS, which a squatter by
     * definition does not have.
     *
     * ⚠ THE REFUSAL IS WHAT MATTERS AND IT IS UNCHANGED: no claim taken, no
     * zone served. Those two assertions below are the security property; this
     * one is only the wording.
     */
    expect(out.status === "unproven" && out.reason).toBe("superseded")
    expect(claimed).toBe(false)
    // ⚠ AND NOTHING WAS SERVED. A refusal that still published the zone would
    // hand over the domain while apologising for it.
    expect(zones.put).not.toHaveBeenCalled()
  })

  it("is refused when nothing is published at all", async () => {
    const zones = spyZones()
    const store = domainStore({
      ...base,
      db: fakeDb({
        select: () => [row({ delegationToken: STRANGER_TOKEN })],
        claim: () => [],
      }),
      identity: identity(),
      zones,
      delegation: delegating(),
    })

    expect((await store.verify(STRANGER, ID)).status).toBe("unproven")
    expect(zones.put).not.toHaveBeenCalled()
  })
})

describe("the owner, verifying a domain they do own", () => {
  it("claims the name and publishes all three zones", async () => {
    const zones = spyZones()
    let claimed = false
    const store = domainStore({
      ...base,
      db: fakeDb({
        select: () => [row()],
        claim: () => [],
        onClaimInsert: () => {
          claimed = true
        },
      }),
      identity: identity(),
      zones,
      delegation: delegating(OWNER_TOKEN),
    })

    const out = await store.verify(OWNER, ID)

    expect(claimed).toBe(true)
    expect(out.status).toBe("ok")
    expect(zones.put.mock.calls.map(([z]) => z.name).sort()).toEqual([
      "_dmarc.example.com",
      "_domainkey.example.com",
      "mail.example.com",
    ])
  })

  /**
   * ⚠ TWO WORKSPACES OF THE SAME COMPANY BOTH PROVE IT, AND BOTH ARE HONEST.
   * A domain can carry several TXT records at one name, so the owner can
   * publish a challenge for each — and only one of them can be the zone we
   * serve. The constraint decides; nothing is granted on a tie.
   */
  it("reports a conflict when somebody else proved it first", async () => {
    const zones = spyZones()
    const store = domainStore({
      ...base,
      db: fakeDb({
        select: () => [row()],
        claim: () => [],
        onClaimInsert: () => {
          throw violation("delegations_name_unique")
        },
      }),
      identity: identity(),
      zones,
      delegation: delegating(OWNER_TOKEN, STRANGER_TOKEN),
    })

    expect((await store.verify(OWNER, ID)).status).toBe("claimed")
    expect(zones.put).not.toHaveBeenCalled()
  })

  /**
   * ⚠ THE REPAIR PATH, AND IT COSTS THE CUSTOMER A BUTTON THEY WERE PRESSING
   * ANYWAY. A zone lost to a failed write or an operator is republished on the
   * next verify without re-proving, because the claim is already ours.
   */
  it("republishes without re-proving when the claim is already ours", async () => {
    const zones = spyZones()
    const delegation = delegating()
    const store = domainStore({
      ...base,
      db: fakeDb({ select: () => [row()], claim: () => [{ domainId: ID }] }),
      identity: identity(),
      zones,
      delegation,
    })

    expect((await store.verify(OWNER, ID)).status).toBe("ok")
    expect(zones.put).toHaveBeenCalledTimes(3)
    expect(delegation).not.toHaveBeenCalled()
  })

  /**
   * ⚠ A RESOLVER THAT TIMED OUT IS NOT A CUSTOMER WHO PUBLISHED NOTHING. Same
   * distinction SES draws between TEMPORARY_FAILURE and FAILED, and flattening
   * it sends somebody to re-check records that are already correct.
   */
  it("separates an unreachable nameserver from an absent record", async () => {
    const store = domainStore({
      ...base,
      db: fakeDb({ select: () => [row()], claim: () => [] }),
      identity: identity(),
      zones: spyZones(),
      delegation: async () => ({ kind: "unreachable", detail: "timed out" }),
    })

    const out = await store.verify(OWNER, ID)
    expect(out.status === "unproven" && out.reason).toBe("unreachable")
  })
})

describe("deleting a delegated domain", () => {
  it("removes the three zones when this row is the one being served", async () => {
    const zones = spyZones()
    const store = domainStore({
      ...base,
      db: fakeDb({
        select: () => [row()],
        claim: () => [{ domainId: ID }],
        zoneOwner: () => [{ claim_domain_id: ID, holders: 1 }],
      }),
      identity: identity(),
      zones,
      delegation: delegating(),
    })

    expect(await store.remove(OWNER, ID)).toBe(true)
    expect(zones.remove.mock.calls.map(([name]) => name).sort()).toEqual([
      "_dmarc.example.com",
      "_domainkey.example.com",
      "mail.example.com",
    ])
  })

  /**
   * ⚠ THE CROSS-TENANT DELETE. A tenant holding an unproven row for a name
   * somebody else is actually serving used to remove that name's zones on the
   * way out: their own delete succeeded, and a different customer's mail
   * stopped resolving with nothing in either account to explain it.
   */
  it("removes no zone when a different row holds the claim", async () => {
    const zones = spyZones()
    const store = domainStore({
      ...base,
      db: fakeDb({
        select: () => [row()],
        claim: () => [{ domainId: OTHER_ID }],
        zoneOwner: () => [{ claim_domain_id: OTHER_ID, holders: 2 }],
      }),
      identity: identity(),
      zones,
      delegation: delegating(),
    })

    expect(await store.remove(STRANGER, ID)).toBe(true)
    expect(zones.remove).not.toHaveBeenCalled()
  })

  /**
   * ⚠ NO CLAIM IS NOT THE SAME QUESTION AS NO OWNER, and treating it as one is
   * what leaked every zone published before claims existed. Zones used to be
   * written by `create`; a delegated domain from before that change has three
   * live zones and no row in `core.delegations` at all. This deployment is
   * entirely in that state — `core.delegations` is empty while `pdns` holds six
   * zones — so the old rule left all of them behind on delete, answering for
   * ever with a DKIM key and a return path for a domain nobody owns.
   */
  it("removes the zones when there is no claim and nobody else holds the name", async () => {
    const zones = spyZones()
    const store = domainStore({
      ...base,
      db: fakeDb({
        select: () => [row()],
        claim: () => [],
        zoneOwner: () => [{ claim_domain_id: null, holders: 1 }],
      }),
      identity: identity(),
      zones,
      delegation: delegating(),
    })

    expect(await store.remove(OWNER, ID)).toBe(true)
    expect(zones.remove.mock.calls.map(([name]) => name).sort()).toEqual([
      "_dmarc.example.com",
      "_domainkey.example.com",
      "mail.example.com",
    ])
  })

  /**
   * ⚠ AND THE CROSS-TENANT GUARD SURVIVES THAT CHANGE, which is the only reason
   * it is safe to make. The hole the claim was invented to close needs TWO rows
   * holding one name — a stranger with an unproven row deleting the zones of
   * whoever is actually being served. Two holders is exactly what the fallback
   * refuses, claim or no claim.
   */
  it("removes no zone when there is no claim but somebody else holds the name", async () => {
    const zones = spyZones()
    const store = domainStore({
      ...base,
      db: fakeDb({
        select: () => [row()],
        claim: () => [],
        zoneOwner: () => [{ claim_domain_id: null, holders: 3 }],
      }),
      identity: identity(),
      zones,
      delegation: delegating(),
    })

    expect(await store.remove(STRANGER, ID)).toBe(true)
    expect(zones.remove).not.toHaveBeenCalled()
  })

  /**
   * ⚠ A FUNCTION THAT ANSWERED NOTHING MUST NOT READ AS "MINE". If the definer
   * call returns no row at all — a migration not yet applied, a permission lost
   * — the count falls back to zero, and zero must not satisfy "I am the only
   * holder". Failing in the cheap direction means leaving the zone.
   */
  it("removes no zone when the owner lookup answers nothing", async () => {
    const zones = spyZones()
    const store = domainStore({
      ...base,
      db: fakeDb({ select: () => [row()], claim: () => [], zoneOwner: () => [] }),
      identity: identity(),
      zones,
      delegation: delegating(),
    })

    expect(await store.remove(OWNER, ID)).toBe(true)
    expect(zones.remove).not.toHaveBeenCalled()
  })
})

/**
 * A domain changing hands.
 *
 * ⚠ PROOF WAS ONE-SHOT, AND THAT IS NOT HOW DOMAINS WORK. A workspace that
 * proved `example.com` once keeps the claim and the verified badge for ever.
 * The registration lapses, somebody else buys it, and the new owner publishes
 * every record correctly and is told the name belongs to another workspace —
 * while the previous owner keeps a verified sending identity for a domain that
 * is no longer theirs, which is the half that actually matters.
 */
const incumbent = (over: Record<string, unknown> = {}) => [
  {
    domain_id: OTHER_ID,
    delegation_token: STRANGER_TOKEN,
    dkim_selector: "i10old000",
    dkim_public_key: "OLDKEY",
    delegated: true,
    ...over,
  },
]

describe("a domain that has changed hands", () => {
  it("moves to the workspace that can prove it when the holder no longer can", async () => {
    const statements: string[] = []
    const zones = spyZones()
    let claims = 0

    const store = domainStore({
      ...base,
      db: fakeDb({
        select: () => [row()],
        claim: () => [],
        holder: () => incumbent(),
        onExecute: (text) => statements.push(text),
        onClaimInsert: () => {
          claims += 1
          // ⚠ ONLY THE FIRST ATTEMPT COLLIDES. Once the previous owner has been
          // stood down, their claim is gone and the retry succeeds — which is
          // the transfer.
          if (claims === 1) throw violation("delegations_name_unique")
        },
      }),
      identity: identity(),
      zones,
      // The new owner's token resolves. The old owner's does not: their records
      // are gone, because the domain is not theirs any more.
      delegation: delegating(OWNER_TOKEN),
    })

    const out = await store.verify(OWNER, ID)

    expect(out.status).toBe("ok")
    expect(claims).toBe(2)
    expect(statements.some((s) => s.includes("displace_domain"))).toBe(true)
    expect(zones.put).toHaveBeenCalledTimes(3)
  })

  /**
   * ⚠ A TIE GRANTS NOTHING, and this is the case that stops the contest being a
   * way to steal a domain. Two workspaces of one company can both hold the DNS
   * and both publish a challenge; the incumbent re-proves it, and the
   * challenger is told the name is taken exactly as before.
   */
  it("leaves it alone when the holder still proves it", async () => {
    const statements: string[] = []
    const zones = spyZones()

    const store = domainStore({
      ...base,
      db: fakeDb({
        select: () => [row()],
        claim: () => [],
        holder: () => incumbent(),
        onExecute: (text) => statements.push(text),
        onClaimInsert: () => {
          throw violation("delegations_name_unique")
        },
      }),
      identity: identity(),
      zones,
      // Both are published: the challenger owns it too, or thinks they do.
      delegation: delegating(OWNER_TOKEN, STRANGER_TOKEN),
    })

    const out = await store.verify(OWNER, ID)

    expect(out.status).toBe("claimed")
    expect(statements.some((s) => s.includes("displace_domain"))).toBe(false)
    expect(zones.put).not.toHaveBeenCalled()
  })

  /**
   * ⚠ THE MOST DANGEROUS THING IN THIS FILE, AND THE REASON `unreachable` IS A
   * SEPARATE ANSWER FROM `absent`. A nameserver that times out is not a
   * customer who has lost their domain. If a failure to ASK counted as an
   * answer, a bad afternoon at one DNS provider would transfer live domains
   * between customers wholesale — and every transfer would look deliberate.
   */
  it("never displaces anybody on a DNS failure", async () => {
    const statements: string[] = []
    let asked = 0

    const store = domainStore({
      ...base,
      db: fakeDb({
        select: () => [row()],
        claim: () => [],
        holder: () => incumbent(),
        onExecute: (text) => statements.push(text),
        onClaimInsert: () => {
          throw violation("delegations_name_unique")
        },
      }),
      identity: identity(),
      zones: spyZones(),
      delegation: async () => {
        asked += 1
        // ⚠ THE CHALLENGER'S OWN DELEGATION RESOLVES; RE-CHECKING THE
        // INCUMBENT'S TIMES OUT. A question we failed to ask is never an
        // answer, so the incumbent must survive it.
        return asked === 1
          ? { kind: "delegated", nameservers: [`${OWNER_TOKEN}.ns1.i10.tech`] }
          : { kind: "unreachable", detail: "timed out" }
      },
    })

    const out = await store.verify(OWNER, ID)

    expect(out.status).toBe("claimed")
    expect(statements.some((s) => s.includes("displace_domain"))).toBe(false)
  })

  /**
   * ⚠ THE INCUMBENT IS RE-PROVED BY THEIR OWN ROUTE, NOT THE CHALLENGER'S. A
   * manual holder proves ownership with their DKIM record and a delegated one
   * with a challenge record; checking the wrong one would report `absent` for a
   * domain that is perfectly well proved, and hand somebody else's live domain
   * away on a category error.
   */
  it("re-proves a manual holder with their DKIM record, not a challenge", async () => {
    const asked: string[] = []
    const statements: string[] = []

    const store = domainStore({
      ...base,
      db: fakeDb({
        select: () => [row()],
        claim: () => [],
        holder: () =>
          incumbent({
            delegated: false,
            dkim_selector: "i10old000",
            dkim_public_key: "OLDKEY",
          }),
        onExecute: (text) => statements.push(text),
        onClaimInsert: () => {
          throw violation("delegations_name_unique")
        },
      }),
      identity: identity(),
      zones: spyZones(),
      // ⚠ TWO DIFFERENT PROBES, WHICH IS THE POINT OF THE TEST. The challenger
      // is delegated and proves itself through the parent's referral; the
      // incumbent is manual and proves itself through its DKIM record.
      delegation: delegating(OWNER_TOKEN),
      txt: async (name: string) => {
        asked.push(name)
        // Their DKIM record is still published, so they still own it.
        return name === "i10old000._domainkey.example.com"
          ? ["v=DKIM1; k=rsa; p=OLDKEY"]
          : []
      },
    })

    const out = await store.verify(OWNER, ID)

    expect(asked).toContain("i10old000._domainkey.example.com")
    expect(out.status).toBe("claimed")
    expect(statements.some((s) => s.includes("displace_domain"))).toBe(false)
  })
})
