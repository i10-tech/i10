import { describe, expect, it, mock } from "bun:test"
import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import { domainStore } from "../src/domains/store.js"
import type { Database } from "../src/db/client.js"
import type { DomainIdentity } from "../src/domains/identity.js"

/**
 * Who may hold a domain name, and what happens when a delete half-fails.
 *
 * ⚠ THE FIRST HALF OF THIS FILE PINS A DELIBERATE REVERSAL. `core.domains.name`
 * used to be unique across every tenant, which meant the first account to TYPE a
 * name held it for ever — publishing nothing, proving nothing. Anybody could
 * register for free and take `spotify.com` away from Spotify, and the real owner
 * hit "That domain is already registered" with no route past it and no way to
 * see what was in the way. Migration 0039 moved the exclusivity onto
 * verification, which is the only thing we have that constitutes proof.
 *
 * ⚠ THE SECOND HALF PINS A BUG THAT TRAINED PEOPLE TO IGNORE OUR ERRORS. The
 * row was deleted and then two other systems were tidied up; a failure in the
 * tidy threw, the route answered 500, and the console said "Could not delete
 * the domain" about a domain that was already gone. Reload and it had worked.
 */

const TENANT = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const ID = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60bb"
const NOW = new Date("2026-09-05T12:00:00.000Z")

const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
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

/** A Postgres unique violation, as the driver reports one. */
const violation = (constraint: string) =>
  Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    {
      code: "23505",
      constraint,
    },
  )

/**
 * ⚠ `claim` IS A SEPARATE HANDLER BECAUSE `remove` NOW ASKS TWO QUESTIONS. It
 * reads the domain row, and then reads `core.delegations` to find out whether
 * this row is the one actually being served — answering both from one handler
 * fed the claim lookup a domain row, whose `domainId` is undefined, so every
 * delegated delete looked like a tenant that held nothing.
 *
 * Dispatching on the PROJECTION rather than on call order keeps it honest if
 * the two reads are ever reordered.
 */
function fakeDb(handlers: {
  insert?: () => unknown[]
  select?: () => unknown[]
  claim?: () => unknown[]
  update?: () => unknown[]
  del?: () => void
  /** `core.domain_verified_elsewhere`, which is reached through raw SQL. */
  taken?: boolean
  /** `core.verified_holder` — the workspace a challenger has to displace. */
  holder?: () => unknown[]
}) {
  const tx = {
    execute: async (q: unknown) =>
      queryText(q).includes("_holder")
        ? (handlers.holder?.() ?? [])
        : [{ taken: handlers.taken ?? false }],
    insert: () => ({
      values: () => ({ returning: async () => handlers.insert?.() ?? [] }),
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
    execute: tx.execute,
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
  /**
   * ⚠ WITHOUT THIS THESE TESTS RESOLVE `example.com` ON THE REAL INTERNET.
   * `verify` proves ownership before it registers an SES identity, and the
   * store's default lookup is a live resolver — so the result would depend on
   * the test runner's network. It answers with the fixture's own DKIM key,
   * which is exactly what a manual domain proves ownership with.
   */
  txt: async () => ["v=DKIM1; k=rsa; p=MIIBIjANBgkq"],
}

describe("claiming a name somebody else has not proved", () => {
  /**
   * ⚠ THE CASE THAT WAS REPORTED FROM PRODUCTION. Somebody had already added
   * the domain and never verified it; the owner could not add it at all.
   */
  it("tells the two violations apart", async () => {
    const own = domainStore({
      ...base,
      db: fakeDb({
        insert: () => {
          throw violation("domains_tenant_name_unique")
        },
      }),
      identity: identity(),
    })

    const theirs = domainStore({
      ...base,
      db: fakeDb({
        insert: () => {
          throw violation("domains_verified_name_unique")
        },
      }),
      identity: identity(),
    })

    const mine = await own.create(TENANT, { name: "example.com" })
    const other = await theirs.create(TENANT, { name: "example.com" })

    expect(mine.status).toBe("conflict")
    expect(other.status).toBe("conflict")

    // ⚠ THE MESSAGES MUST DIFFER, because the remedies are opposite: one is
    // "look in your own list", the other is "the name is spoken for".
    const mineReason = mine.status === "conflict" ? mine.reason : ""
    const otherReason = other.status === "conflict" ? other.reason : ""
    expect(mineReason).toContain("already added")
    expect(otherReason).toContain("another workspace")

    /*
     * ⚠ AND NEITHER NAMES THE OTHER TENANT. The rule in contracts/errors.ts has
     * been relaxed about WHETHER we refuse, not about who we say is in the way
     * — "Acme Ltd has example.com" would make this endpoint a way to ask which
     * companies are customers.
     */
    expect(otherReason).not.toContain(TENANT)
  })
})

describe("losing the race to verify", () => {
  /**
   * ⚠ TWO TENANTS MAY BOTH HOLD A NAME AS PENDING; ONLY ONE MAY VERIFY IT. The
   * loser's UPDATE hits the partial unique index. Before this was handled the
   * exception escaped as a 500, so the console's Verify button answered "500"
   * for ever with nothing anywhere saying why — which is indistinguishable from
   * the button being broken.
   */
  it("reports a conflict instead of throwing, and does not mark it verified", async () => {
    let attempt = 0
    const store = domainStore({
      ...base,
      db: fakeDb({
        select: () => [row({ status: "pending" })],
        /*
         * ⚠ AND THE HOLDER STILL PROVES IT, which is what makes this a genuine
         * tie rather than a domain that has changed hands. A challenger who has
         * proved the name now causes the incumbent to be re-checked; with no
         * incumbent described here the retry would simply succeed, and the test
         * would be asserting the opposite of its own name.
         */
        holder: () => [
          {
            domain_id: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60cc",
            delegation_token: "not-this-tenants-token",
            dkim_selector: "i10abc123",
            dkim_public_key: "MIIBIjANBgkq",
            delegated: false,
          },
        ],
        update: () => {
          attempt += 1
          // The first write tries `verified` and is refused; the second writes
          // the row back unchanged so the check is still stamped.
          if (attempt === 1) throw violation("domains_verified_name_unique")
          return [row({ status: "pending" })]
        },
      }),
      identity: identity({
        status: async () => ({ dkimTokens: ["aaa"], status: "verified" }),
      }),
    })

    const outcome = await store.verify(TENANT, ID)

    expect(outcome.status).toBe("claimed")
    // ⚠ STILL PENDING, NOT `failed`. Their records may be perfect; telling them
    // verification FAILED sends somebody to break DNS that is correct.
    expect(outcome.status === "claimed" && outcome.domain.status).toBe("pending")
    expect(attempt).toBe(2)
  })

  it("still reports a missing domain as missing", async () => {
    const store = domainStore({
      ...base,
      db: fakeDb({ select: () => [] }),
      identity: identity(),
    })
    expect((await store.verify(TENANT, ID)).status).toBe("missing")
  })
})

describe("deleting a domain whose cleanup fails", () => {
  /**
   * ⚠ THE ROW IS GONE BEFORE EITHER TIDY RUNS, SO NEITHER MAY FAIL THE DELETE.
   * SES answers NotFoundException for an identity that was never successfully
   * created, which is every domain added while that call was failing — so this
   * is not a hypothetical path.
   */
  it("reports success when SES refuses, and still deletes the row", async () => {
    let deleted = false
    const warn = mock(() => {})

    const store = domainStore({
      ...base,
      db: fakeDb({
        select: () => [row()],
        del: () => {
          deleted = true
        },
      }),
      identity: identity({
        remove: async () => {
          throw new Error("NotFoundException: identity does not exist")
        },
      }),
      log: { warn },
    })

    expect(await store.remove(TENANT, ID)).toBe(true)
    expect(deleted).toBe(true)

    // ⚠ AND IT IS WRITTEN DOWN. Nothing is broken for the customer, but an
    // identity we failed to remove is a real leak that somebody has to
    // reconcile — and it is invisible unless it is logged.
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("reports success when the zone delete fails", async () => {
    const warn = mock(() => {})
    const store = domainStore({
      ...base,
      // ⚠ AND THIS TENANT HOLDS THE CLAIM, which is now what decides whether
      // the zones are theirs to remove at all — see `delegations_name_unique`.
      db: fakeDb({
        select: () => [row({ delegated: true })],
        claim: () => [{ domainId: ID }],
      }),
      identity: identity(),
      zones: {
        put: async () => {},
        remove: async () => {
          throw new Error("pdns unreachable")
        },
      },
      log: { warn },
    })

    expect(await store.remove(TENANT, ID)).toBe(true)
    // Three delegated zones, three failed removals, three lines.
    expect(warn).toHaveBeenCalledTimes(3)
  })

  /** ⚠ THE LOGGER IS OPTIONAL AND ITS ABSENCE MUST NOT THROW ON THE FAILURE PATH. */
  it("does not require a logger", async () => {
    const store = domainStore({
      ...base,
      db: fakeDb({ select: () => [row()] }),
      identity: identity({
        remove: async () => {
          throw new Error("boom")
        },
      }),
    })
    expect(await store.remove(TENANT, ID)).toBe(true)
  })
})

describe("refusing a duplicate without touching SES", () => {
  /**
   * ⚠ THE REFUSAL USED TO COST THE OTHER TENANT THEIR DKIM KEY, which is a far
   * worse bug than the orphaned identity it looked like. SES keys identities on
   * the domain name inside one AWS account, so `CreateEmailIdentity` for a name
   * somebody else holds raises `AlreadyExistsException` — and the adapter's
   * recovery is `PutEmailIdentityDkimSigningAttributes`, which REPLACES their
   * signing key with ours. The verified tenant then signs with a key their DNS
   * does not publish and their working domain breaks, because a stranger typed
   * its name into a form and was told no.
   *
   * ⚠ SO THE ASSERTION IS THAT AWS IS NEVER REACHED, not that we tidied up
   * afterwards. There is nothing to tidy: the identity is not an orphan, it is
   * somebody else's, and deleting it would be the same bug pointing the other
   * way.
   */
  it("does not call SES when this workspace already has the name", async () => {
    const create = mock(async () => ({
      dkimTokens: ["aaa"],
      status: "pending" as const,
    }))
    const store = domainStore({
      ...base,
      db: fakeDb({ select: () => [row()] }),
      identity: identity({ create }),
    })

    const out = await store.create(TENANT, { name: "example.com" })

    expect(out.status).toBe("conflict")
    expect(out.status === "conflict" && out.reason).toBe(
      "You have already added example.com.",
    )
    expect(create).not.toHaveBeenCalled()
  })

  it("does not call SES when another workspace has verified the name", async () => {
    const create = mock(async () => ({
      dkimTokens: ["aaa"],
      status: "pending" as const,
    }))
    const store = domainStore({
      ...base,
      // No row of our own, but `core.domain_verified_elsewhere` says yes.
      db: fakeDb({ select: () => [], taken: true }),
      identity: identity({ create }),
    })

    const out = await store.create(TENANT, { name: "example.com" })

    expect(out.status).toBe("conflict")
    expect(create).not.toHaveBeenCalled()
    // ⚠ STILL DOES NOT NAME THE HOLDER. The function it asked returns a boolean
    // precisely so that this message cannot start naming customers.
    expect(out.status === "conflict" && out.reason).not.toMatch(
      /tenant|customer|workspace ".*"/i,
    )
  })
})
