import { describe, expect, it } from "bun:test"
import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import { apiKeys, delegations, domains, domainTransfers } from "../src/db/core.js"
import { domainTransferStore, normaliseEmail } from "../src/domains/transfers.js"
import type { Database } from "../src/db/client.js"

/**
 * Offering a domain by email, and the one step that moves it: accepting.
 *
 * ⚠ WHAT THESE PIN IS THE ORDER OF TENANT CONTEXTS, because that order IS the
 * security. Every statement runs under row level security for whichever
 * workspace `app.tenant_id` names at that moment; the move reads and deletes as
 * the sender and inserts as the receiver. Get the order wrong and a statement
 * either fails under RLS or — worse — runs as the wrong workspace.
 */

const dialect = new PgDialect()
const SENDER = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const RECEIVER = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6072"
const SESSION = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6073"
const DOMAIN = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60bb"
const OFFER = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60cc"
const NOW = new Date("2026-09-26T12:00:00.000Z")

const offerRow = (over: Record<string, unknown> = {}) => ({
  id: OFFER,
  tenantId: SENDER,
  domainId: DOMAIN,
  domainName: "example.com",
  recipientEmail: "new@owner.test",
  offeredBy: "Mohamed",
  fromWorkspace: "Acme",
  createdAt: NOW,
  expiresAt: new Date(NOW.getTime() + 7 * 86400000),
  ...over,
})

type Event =
  | { kind: "setting"; name: string; value: unknown }
  | { kind: "insert" | "update"; table: string; values: Record<string, unknown> }
  | { kind: "delete"; table: string }

const nameOf = (table: unknown) =>
  table === domains
    ? "domains"
    : table === delegations
      ? "delegations"
      : table === domainTransfers
        ? "domain_transfers"
        : table === apiKeys
          ? "api_keys"
          : "?"

function fakeDb(rows: {
  offer?: () => unknown[]
  domain?: () => unknown[]
  claim?: () => unknown[]
  keys?: () => unknown[]
  insertFails?: (table: string) => unknown
}) {
  const events: Event[] = []
  let transactions = 0

  const read = (table: string) =>
    (table === "domain_transfers"
      ? rows.offer?.()
      : table === "domains"
        ? rows.domain?.()
        : table === "api_keys"
          ? rows.keys?.()
          : rows.claim?.()) ?? []

  const chain = (value: () => unknown[]) => {
    const p = {
      limit: () => p,
      for: () => p,
      orderBy: () => p,
      then: (ok: (v: unknown) => unknown, no: (e: unknown) => unknown) =>
        Promise.resolve().then(value).then(ok, no),
    }
    return p
  }

  const tx = {
    execute: async (q: unknown) => {
      const { sql, params } = dialect.sqlToQuery(q as SQL)
      const name = /set_config\('([^']+)'/.exec(sql)?.[1]
      if (name) events.push({ kind: "setting", name, value: params[0] })
      return []
    },
    select: () => ({
      from: (table: unknown) => ({ where: () => chain(() => read(nameOf(table))) }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const t = nameOf(table)
        events.push({ kind: "insert", table: t, values })
        const failure = rows.insertFails?.(t)
        const result = () => {
          if (failure) throw failure
          return [offerRow(values)]
        }
        return { returning: async () => result(), ...chain(result) }
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        events.push({ kind: "update", table: nameOf(table), values })
        return {
          where: () => ({ returning: async () => [{ id: OFFER }], ...chain(() => []) }),
        }
      },
    }),
    delete: (table: unknown) => ({
      where: async () => {
        events.push({ kind: "delete", table: nameOf(table) })
      },
    }),
  }

  const db = {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      transactions += 1
      return fn(tx)
    },
  } as unknown as Database

  return { db, events, transactions: () => transactions }
}

const room = (status = "ok") => ({ check: async () => ({ status }) })

const settings = (events: Event[]) =>
  events.flatMap((e) => (e.kind === "setting" ? [[e.name, e.value]] : []))

describe("accepting an offer", () => {
  it("reads as the recipient, deletes as the sender, inserts as the receiver", async () => {
    const f = fakeDb({
      offer: () => [offerRow()],
      domain: () => [
        { id: DOMAIN, tenantId: SENDER, name: "example.com", hostsMailboxes: false },
      ],
      claim: () => [{ name: "example.com", domainId: DOMAIN, claimedAt: NOW }],
    })
    const store = domainTransferStore({ db: f.db, capacity: room(), now: () => NOW })

    const out = await store.accept({
      tenantId: SESSION,
      emails: ["New@Owner.test"],
      id: OFFER,
      toTenantId: RECEIVER,
    })

    expect(out).toMatchObject({
      status: "accepted",
      domainId: DOMAIN,
      domainName: "example.com",
    })
    expect(settings(f.events)).toEqual([
      ["app.tenant_id", SESSION],
      // ⚠ LOWERCASED, AND FROM THE CALLER'S VERIFIED LIST — never the request.
      ["app.recipient_emails", "new@owner.test"],
      ["app.tenant_id", SENDER],
      ["app.tenant_id", RECEIVER],
      // ⚠ BACK TO THE SENDER for their keys, which are their rows.
      ["app.tenant_id", SENDER],
    ])

    const writes = f.events.filter((e) => e.kind !== "setting")
    expect(writes.map((e) => `${e.kind}:${"table" in e ? e.table : ""}`)).toEqual([
      "delete:domains",
      "insert:domains",
      "insert:delegations",
      "update:domain_transfers",
    ])
    expect(writes[1]).toMatchObject({ values: { id: DOMAIN, tenantId: RECEIVER } })
    expect(writes[2]).toMatchObject({
      values: { domainId: DOMAIN, tenantId: RECEIVER },
    })
    expect(writes[3]).toMatchObject({
      values: { acceptedAt: NOW, acceptedTenantId: RECEIVER },
    })
    expect(f.transactions()).toBe(1)
  })

  /**
   * ⚠ SOMEBODY IN THE SAME WORKSPACE AS THE SENDER MAY BE THE RECIPIENT — they
   * take it into one of their OTHER workspaces. Taking it into the one it is
   * already in is the only refusal, and it moves nothing.
   */
  it("refuses to land it in the workspace it is already in", async () => {
    const f = fakeDb({ offer: () => [offerRow()] })
    const store = domainTransferStore({ db: f.db, capacity: room(), now: () => NOW })

    const out = await store.accept({
      tenantId: SENDER,
      emails: ["new@owner.test"],
      id: OFFER,
      toTenantId: SENDER,
    })

    expect(out.status).toBe("rejected")
    expect(f.events.some((e) => e.kind === "delete" || e.kind === "insert")).toBe(false)
  })

  it("answers missing, without touching the database, for a person with no verified address", async () => {
    const f = fakeDb({ offer: () => [offerRow()] })
    const store = domainTransferStore({ db: f.db, capacity: room(), now: () => NOW })

    const out = await store.accept({
      tenantId: SESSION,
      emails: [],
      id: OFFER,
      toTenantId: RECEIVER,
    })

    expect(out.status).toBe("missing")
    expect(f.transactions()).toBe(0)
  })

  it("answers missing when no open offer is visible to the recipient", async () => {
    const f = fakeDb({ offer: () => [] })
    const store = domainTransferStore({ db: f.db, capacity: room(), now: () => NOW })

    const out = await store.accept({
      tenantId: SESSION,
      emails: ["someone@else.test"],
      id: OFFER,
      toTenantId: RECEIVER,
    })

    expect(out.status).toBe("missing")
    expect(f.events.some((e) => e.kind === "delete")).toBe(false)
  })

  it("respects the receiving workspace's plan limit", async () => {
    const f = fakeDb({ offer: () => [offerRow()] })
    const store = domainTransferStore({
      db: f.db,
      capacity: room("exceeded"),
      now: () => NOW,
    })

    const out = await store.accept({
      tenantId: SESSION,
      emails: ["new@owner.test"],
      id: OFFER,
      toTenantId: RECEIVER,
    })

    expect(out.status).toBe("limit")
    expect(f.transactions()).toBe(0)
  })

  it("reports a name the receiving workspace already has", async () => {
    const f = fakeDb({
      offer: () => [offerRow()],
      domain: () => [{ id: DOMAIN, name: "example.com", hostsMailboxes: false }],
      insertFails: (table) =>
        table === "domains"
          ? Object.assign(new Error("duplicate"), { code: "23505" })
          : undefined,
    })
    const store = domainTransferStore({ db: f.db, capacity: room(), now: () => NOW })

    const out = await store.accept({
      tenantId: SESSION,
      emails: ["new@owner.test"],
      id: OFFER,
      toTenantId: RECEIVER,
    })

    expect(out.status).toBe("conflict")
  })

  it("will not move a mailbox domain", async () => {
    const f = fakeDb({
      offer: () => [offerRow()],
      domain: () => [{ id: DOMAIN, name: "example.com", hostsMailboxes: true }],
    })
    const store = domainTransferStore({ db: f.db, capacity: room(), now: () => NOW })

    const out = await store.accept({
      tenantId: SESSION,
      emails: ["new@owner.test"],
      id: OFFER,
      toTenantId: RECEIVER,
    })

    expect(out.status).toBe("rejected")
    expect(f.events.some((e) => e.kind === "delete")).toBe(false)
  })
})

describe("the sender's keys when a transfer is accepted", () => {
  /**
   * ⚠ KEYS NEVER MOVE. They are saved in the sender's systems. A key limited to
   * only this domain could send from nothing afterwards, so it is revoked; a
   * key limited to this domain and others keeps the others.
   */
  it("revokes a key limited to only this domain, and narrows one that had others", async () => {
    const f = fakeDb({
      offer: () => [offerRow()],
      domain: () => [{ id: DOMAIN, name: "example.com", hostsMailboxes: false }],
      keys: () => [
        { id: "k1", scopes: ["domain:example.com"], secretHash: "h1" },
        {
          id: "k2",
          scopes: ["domain:example.com", "domain:other.com"],
          secretHash: "h2",
        },
      ],
    })
    const store = domainTransferStore({ db: f.db, capacity: room(), now: () => NOW })

    const out = await store.accept({
      tenantId: SESSION,
      emails: ["new@owner.test"],
      id: OFFER,
      toTenantId: RECEIVER,
    })

    expect(out.status === "accepted" && out.keys).toEqual({
      revoked: 1,
      narrowed: 1,
      secretHashes: ["h1", "h2"],
    })
    const keyWrites = f.events.filter(
      (e) => e.kind === "update" && e.table === "api_keys",
    )
    expect(keyWrites).toEqual([
      { kind: "update", table: "api_keys", values: { revokedAt: NOW } },
      { kind: "update", table: "api_keys", values: { scopes: ["domain:other.com"] } },
    ])
  })
})

describe("making an offer", () => {
  it("withdraws any open offer, then records a new one that expires in a week", async () => {
    const f = fakeDb({ domain: () => [{ name: "example.com", hostsMailboxes: false }] })
    const store = domainTransferStore({ db: f.db, capacity: room(), now: () => NOW })

    const out = await store.offer(SENDER, DOMAIN, {
      email: "  New@Owner.TEST ",
      offeredBy: "Mohamed",
      fromWorkspace: "Acme",
    })

    expect(out.status).toBe("offered")
    expect(settings(f.events)).toEqual([["app.tenant_id", SENDER]])
    const writes = f.events.filter((e) => e.kind !== "setting")
    expect(writes[0]).toMatchObject({ kind: "update", values: { canceledAt: NOW } })
    expect(writes[1]).toMatchObject({
      kind: "insert",
      values: {
        tenantId: SENDER,
        recipientEmail: "new@owner.test",
        domainName: "example.com",
        expiresAt: new Date(NOW.getTime() + 7 * 86400000),
      },
    })
  })

  it("refuses something that is not an address", async () => {
    const f = fakeDb({})
    const store = domainTransferStore({ db: f.db, capacity: room(), now: () => NOW })
    const out = await store.offer(SENDER, DOMAIN, {
      email: "not an email",
      offeredBy: "x",
      fromWorkspace: "y",
    })
    expect(out.status).toBe("rejected")
    expect(f.transactions()).toBe(0)
  })
})

describe("addresses", () => {
  /**
   * ⚠ A COMMA WOULD SPLIT THE POLICY'S LIST. `app.recipient_emails` is one
   * comma-joined setting, so an address containing one could smuggle a second
   * address into it. Refused outright.
   */
  it("refuses an address containing a comma", () => {
    expect(normaliseEmail('"a,b"@example.com')).toBeNull()
    expect(normaliseEmail("a@b.co,c@d.co")).toBeNull()
    expect(normaliseEmail(" A@B.Co ")).toBe("a@b.co")
  })

  it("lists nothing, without a query, for a person with no verified address", async () => {
    const f = fakeDb({ offer: () => [offerRow()] })
    const store = domainTransferStore({ db: f.db, capacity: room(), now: () => NOW })
    expect(await store.incoming(SESSION, [])).toEqual([])
    expect(f.transactions()).toBe(0)
  })
})
