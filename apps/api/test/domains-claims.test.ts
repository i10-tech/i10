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
/** A second domain on the same workspace, for the bulk teardown. */
const OTHER_ID = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60cc"
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
  /**
   * ⚠ `list` READS THROUGH `orderBy` AND `get` THROUGH `limit`, WHICH IS THE
   * ONLY THING THAT TELLS THEM APART HERE. `releaseDomains` calls both — the
   * list to find the domains, then one `get` per domain inside `remove` — and
   * a fake that answered them from one handler could not express "this tenant
   * holds two domains", which is the whole case worth testing.
   */
  many?: () => unknown[]
}) {
  const tx = {
    execute: async (q: unknown) => {
      const text = queryText(q)
      /*
       * ⚠ `core.zone_owner` IS DERIVED FROM THE SAME `claim` HANDLER THESE
       * TESTS ALREADY SET, so each one keeps the intent it was written with.
       * `remove` used to read the claim through drizzle and now asks a definer
       * function instead — because the honest question spans tenants and a
       * row-level-security read cannot see the other workspaces holding a name.
       * Modelling it as a separate fixture would have meant every existing test
       * silently exercising the "nobody owns this" branch.
       */
      if (text.includes("zone_owner")) {
        const claimed = (handlers.claim?.() ?? []) as { domainId?: string }[]
        return [{ claim_domain_id: claimed[0]?.domainId ?? null, holders: 1 }]
      }
      return text.includes("_holder")
        ? (handlers.holder?.() ?? [])
        : [{ taken: handlers.taken ?? false }]
    },
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
          orderBy: async () => handlers.many?.() ?? handlers.select?.() ?? [],
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
  /**
   * ⚠ AT `error`, NOT `warn`, AND THAT IS THE HALF THAT WAS MISSING. This line
   * fired in production twice, saying precisely what had happened, while the
   * leak was being reported as "deleting the domain does not remove it from
   * SES" — because `warn` reaches the pod log and nothing else. An identity
   * left behind is live, billable and still able to send for a domain nobody
   * owns, which is not the same class of leak as a zone that stops answering
   * when the delegation lapses.
   */
  it("shouts at error level when the SES identity is left behind", async () => {
    const error = mock(() => {})
    const warn = mock(() => {})

    const store = domainStore({
      ...base,
      db: fakeDb({ select: () => [row()] }),
      identity: identity({
        remove: async () => {
          throw new Error("AccessDeniedException: ses:DeleteEmailIdentity")
        },
      }),
      log: { warn, error },
    })

    expect(await store.remove(TENANT, ID)).toBe(true)
    expect(error).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

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

  /**
   * ⚠ THE SES IDENTITY IS KEYED BY NAME ACROSS THE WHOLE AWS ACCOUNT, AND THIS
   * IS THE HOLE THAT MADE A DELETE CROSS-TENANT. Several workspaces may hold
   * one name as pending — migration 0039 exists to allow it — so a workspace
   * that never verified anything could delete its own pending row and take out
   * the identity another workspace is SENDING from. Their mail stops, their
   * console says nothing, and the cause is a delete in an account they have
   * never heard of. It is the same hole `holdsZones` closes for the zones,
   * left open on the other half of the same teardown.
   */
  it("leaves the SES identity alone when another workspace holds the name", async () => {
    const removed: string[] = []

    const store = domainStore({
      ...base,
      db: fakeDb({
        select: () => [row()],
        // ⚠ A DIFFERENT `domain_id`: somebody else is verified on this name.
        holder: () => [{ domain_id: "99999999-9999-4999-8999-999999999999" }],
      }),
      identity: identity({
        remove: async (name) => {
          removed.push(name)
        },
      }),
    })

    expect(await store.remove(TENANT, ID)).toBe(true)
    expect(removed).toEqual([])
  })

  /**
   * ⚠ `not_started` MEANS NO IDENTITY WAS EVER REGISTERED FOR THIS ROW, so
   * there is nothing of ours under that name to delete and anything that IS
   * there belongs to somebody else. `verify` is the only thing that registers
   * one, and it does so only after proving ownership.
   */
  it("leaves the SES identity alone for a row that never registered one", async () => {
    const removed: string[] = []

    const store = domainStore({
      ...base,
      db: fakeDb({ select: () => [row({ status: "not_started" })] }),
      identity: identity({
        remove: async (name) => {
          removed.push(name)
        },
      }),
    })

    expect(await store.remove(TENANT, ID)).toBe(true)
    expect(removed).toEqual([])
  })

  /**
   * ⚠ AND THE GUARD MUST NOT BECOME A LEAK. Failing closed on every delete
   * would leave an identity in AWS for every domain anybody ever removed —
   * inert, billable, and enough to block the name being re-added cleanly. The
   * holder being THIS row is the ordinary case and has to still go.
   */
  it("removes the identity when this row is the one holding the name", async () => {
    const removed: string[] = []

    const store = domainStore({
      ...base,
      db: fakeDb({
        select: () => [row({ status: "verified" })],
        holder: () => [{ domain_id: ID }],
      }),
      identity: identity({
        remove: async (name) => {
          removed.push(name)
        },
      }),
    })

    expect(await store.remove(TENANT, ID)).toBe(true)
    expect(removed).toEqual(["example.com"])
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

/**
 * Handing everything back when the workspace is deleted.
 *
 * ⚠ NOTHING DID THIS, AND WHAT SURVIVED WAS LIVE. Termination marks the tenant
 * `deleted` rather than deleting the row, so the `on delete cascade` on
 * `domains.tenant_id` never fires — leaving a verified SES identity per domain
 * and our own nameservers still answering for every delegated one, serving
 * DKIM keys and return paths for an account that no longer exists.
 */
describe("releasing a terminated workspace's domains", () => {
  it("tears down every domain the workspace holds", async () => {
    const deleted: number[] = []
    const removed: string[] = []
    const zonesGone: string[] = []

    const store = domainStore({
      ...base,
      db: fakeDb({
        many: () => [row({ id: ID }), row({ id: OTHER_ID, name: "second.com" })],
        select: () => [row({ status: "verified", delegated: true })],
        claim: () => [{ domainId: ID }],
        del: () => {
          deleted.push(1)
        },
      }),
      identity: identity({
        remove: async (name) => {
          removed.push(name)
        },
      }),
      zones: {
        put: async () => {},
        remove: async (zone) => {
          zonesGone.push(zone)
        },
      },
    })

    expect(await store.releaseDomains(TENANT)).toEqual({ released: 2, failed: 0 })
    expect(deleted).toHaveLength(2)
    // ⚠ THE SES IDENTITY GOES FOR EACH. (The fake answers every `get` with the
    // same row, so both report one name; what is being asserted is that the
    // teardown ran twice rather than once.)
    expect(removed).toHaveLength(2)

    /*
     * ⚠ THREE ZONES, NOT SIX, AND THAT IS THE GUARD WORKING RATHER THAN A
     * MISCOUNT. Only the domain that actually holds the delegation claim gives
     * up its zones — the fake grants the claim to `ID` alone — so the bulk path
     * keeps the per-domain check that stops one workspace's delete taking
     * another's DNS. A bulk teardown with its own copy of this logic is exactly
     * what `releaseDomains` refuses to be.
     */
    expect(zonesGone).toHaveLength(3)
  })

  /*
   * ⚠ ONE DOMAIN THAT WILL NOT DELETE MUST NOT STRAND THE REST. The caller is
   * a webhook finishing a deletion that has already stopped the billing;
   * abandoning the remaining domains would leave live identities behind for a
   * reason that has nothing to do with them.
   */
  it("keeps going past a domain it cannot delete, and counts it", async () => {
    let seen = 0
    const warn = mock(() => {})

    const store = domainStore({
      ...base,
      db: fakeDb({
        many: () => [row({ id: ID }), row({ id: OTHER_ID, name: "second.com" })],
        select: () => [row()],
        del: () => {
          seen += 1
          if (seen === 1) throw new Error("deadlock detected")
        },
      }),
      identity: identity(),
      log: { warn },
    })

    expect(await store.releaseDomains(TENANT)).toEqual({ released: 1, failed: 1 })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  /** A workspace with nothing to give back costs one query and says so. */
  it("is a no-op for a workspace with no domains", async () => {
    const store = domainStore({
      ...base,
      db: fakeDb({ many: () => [] }),
      identity: identity(),
    })

    expect(await store.releaseDomains(TENANT)).toEqual({ released: 0, failed: 0 })
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
      "You have already added example.com, and it is waiting for verification.",
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

/**
 * ⚠ THE CONSOLE ASKS THIS AS SOMEBODY TYPES, SO IT HAS TO AGREE WITH `create`
 * WORD FOR WORD. A box that stays quiet over a name the button then refuses is
 * the toast this exists to replace.
 */
describe("refusal", () => {
  it("refuses our own domain and its subdomains", async () => {
    const store = domainStore({
      ...base,
      identity: identity(),
      db: fakeDb({ select: () => [] }),
    })
    expect(await store.refusal(TENANT, "i10.tech")).toContain("is ours")
    expect(await store.refusal(TENANT, "Mail.I10.tech")).toContain("is ours")
  })

  it("says what state an already-added domain is in", async () => {
    const at = (status: string) =>
      domainStore({
        ...base,
        identity: identity(),
        db: fakeDb({ select: () => [row({ status })] }),
      }).refusal(TENANT, "example.com")
    expect(await at("verified")).toBe(
      "You have already added example.com, and it is verified.",
    )
    expect(await at("not_started")).toContain("waiting for verification")
    expect(await at("failed")).toContain("failed verification")
  })

  it("matches what create says for a name verified elsewhere", async () => {
    const store = domainStore({
      ...base,
      identity: identity(),
      db: fakeDb({ select: () => [], taken: true }),
    })
    const created = await store.create(TENANT, { name: "example.com" })
    expect(created.status === "conflict" ? created.reason : null).toBe(
      await store.refusal(TENANT, "example.com"),
    )
  })

  it("has nothing to say about a free name", async () => {
    const store = domainStore({
      ...base,
      identity: identity(),
      db: fakeDb({ select: () => [] }),
    })
    expect(await store.refusal(TENANT, "example.com")).toBeNull()
  })
})
