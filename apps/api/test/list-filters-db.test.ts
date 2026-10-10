import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { marketingStore } from "../src/console/marketing.js"
import { consoleQueries } from "../src/console/queries.js"
import { suppressionStore } from "../src/suppressions/store.js"
import { webhookHistory, type DeliveryFilter } from "../src/webhooks/history.js"

/**
 * The console lists' filters against a real database as `i10_api`: the
 * request log, webhook deliveries, contacts and suppressions. The SQL is the
 * point - an enum compared to text, a method upper-cased, a lower time bound -
 * and only Postgres can say whether it is right.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/templates_scratch bun test test/list-filters-db.test.ts
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let db: ReturnType<typeof postgres>
let database: Database
let tenant: string
const key = crypto.randomUUID()
let endpoint: string

suite("console list filters", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    database = drizzle(db, { schema }) as unknown as Database
    tenant = crypto.randomUUID()
    await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
                values (${tenant}, ${`f-${tenant.slice(0, 8)}`}, 'F', ${`filters-${tenant}`})`

    await owner`insert into core.api_requests (tenant_id, api_key_id, method, path, status, duration_ms, occurred_at)
                values (${tenant}, ${key}, 'POST', '/emails', 200, 40, now()),
                       (${tenant}, ${key}, 'GET', '/emails/{id}', 404, 12, now() - interval '2 days'),
                       (${tenant}, null, 'DELETE', '/domains/{id}', 500, 90, now() - interval '20 days')`

    const [row] =
      await owner`insert into core.webhook_endpoints (tenant_id, url, secret_ciphertext, events)
                              values (${tenant}, 'https://acme.test/hook', 'x', '{email.delivered,email.bounced}')
                              returning id`
    endpoint = row!.id as string
    await owner`insert into core.webhook_deliveries (tenant_id, endpoint_id, event_type, occurred_at, payload, status)
                values (${tenant}, ${endpoint}, 'email.delivered', now(), '{}', 'delivered'),
                       (${tenant}, ${endpoint}, 'email.bounced', now(), '{}', 'failed'),
                       (${tenant}, ${endpoint}, 'email.bounced', now(), '{}', 'pending')`

    await owner`insert into core.contacts (tenant_id, email, unsubscribed)
                values (${tenant}, 'ada@acme.test', false), (${tenant}, 'bob@acme.test', true)`

    await owner`insert into core.suppressions (tenant_id, address, reason)
                values (${tenant}, 'gone@acme.test', 'hard_bounce'), (${tenant}, 'angry@acme.test', 'complaint')`
  })
  afterAll(async () => {
    await owner`delete from core.tenants where id = ${tenant}`
    await owner.end()
    await db.end()
  })

  it("narrows the request log by path, method, key, status and time", async () => {
    const q = consoleQueries(database)
    const paths = async (opts: Parameters<typeof q.listRequests>[1]) =>
      (await q.listRequests(tenant, opts)).data.map((r) => r.path).sort()

    expect(await paths({})).toHaveLength(3)
    expect(await paths({ search: "emails" })).toEqual(["/emails", "/emails/{id}"])
    expect(await paths({ method: "get" })).toEqual(["/emails/{id}"])
    expect(await paths({ apiKeyId: key })).toEqual(["/emails", "/emails/{id}"])
    expect(await paths({ status: "error" })).toEqual(["/domains/{id}", "/emails/{id}"])
    expect(await paths({ from: new Date(Date.now() - 7 * 86_400_000) })).toEqual([
      "/emails",
      "/emails/{id}",
    ])
    expect(await paths({ search: "50%_" })).toEqual([])
  })

  it("narrows webhook deliveries by status and event, and an unknown event matches nothing", async () => {
    const q = consoleQueries(database)
    const statuses = async (opts: Parameters<typeof q.listDeliveries>[1]) =>
      (await q.listDeliveries(tenant, opts)).data.map((d) => d.status).sort()

    expect(await statuses({ endpointId: endpoint })).toEqual([
      "delivered",
      "failed",
      "pending",
    ])
    expect(await statuses({ status: "failed" })).toEqual(["failed"])
    expect(await statuses({ eventType: "email.bounced" })).toEqual([
      "failed",
      "pending",
    ])
    expect(await statuses({ eventType: "email.nonsense" })).toEqual([])
  })

  it("narrows contacts to subscribed or unsubscribed", async () => {
    const m = marketingStore(database)
    const emails = async (subscribed?: boolean) =>
      (
        await m.listContacts(tenant, subscribed === undefined ? {} : { subscribed })
      ).data
        .map((c) => c.email)
        .sort()

    expect(await emails()).toEqual(["ada@acme.test", "bob@acme.test"])
    expect(await emails(true)).toEqual(["ada@acme.test"])
    expect(await emails(false)).toEqual(["bob@acme.test"])
  })

  it("narrows suppressions by reason, and an unknown reason matches nothing", async () => {
    const s = suppressionStore({ db: database, ses: {} as never })
    const addresses = async (reason?: string) =>
      (await s.list(tenant, reason ? { reason } : {})).data.map((r) => r.address).sort()

    expect(await addresses()).toEqual(["angry@acme.test", "gone@acme.test"])
    expect(await addresses("complaint")).toEqual(["angry@acme.test"])
    expect(await addresses("unsubscribe")).toEqual([])
    expect(await addresses("nonsense")).toEqual([])
  })
})

/**
 * Time, response class and id prefix, on both lists: the console's query and
 * the API's history. Each delivery is labelled by its event's `label` in the
 * payload so a failure names the row.
 */
suite("webhook delivery filters", () => {
  // ⚠ OWN CONNECTIONS: the suite above closes its own in its afterAll.
  let owner: ReturnType<typeof postgres>
  let db: ReturnType<typeof postgres>
  let database: Database
  let dtenant: string
  let dendpoint: string
  const message = "0192f3a1-7c2b-7e00-8a11-3b2c1d0e9f88"
  const rows: Record<string, string> = {}

  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    database = drizzle(db, { schema }) as unknown as Database
    dtenant = crypto.randomUUID()
    await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
                values (${dtenant}, ${`d-${dtenant.slice(0, 8)}`}, 'D', ${`delivery-filters-${dtenant}`})`
    const [row] =
      await owner`insert into core.webhook_endpoints (tenant_id, url, secret_ciphertext, events)
                  values (${dtenant}, 'https://acme.test/hook', 'x', '{email.delivered}')
                  returning id`
    dendpoint = row!.id as string
    // label, response_status, attempts, age in days, message
    const seed: [string, number | null, number, number, string | null][] = [
      ["ok", 200, 1, 0, message],
      ["created", 204, 1, 1, null],
      ["unauthorized", 401, 3, 2, null],
      ["broken", 503, 2, 5, null],
      ["silent", null, 4, 8, null],
      ["waiting", null, 0, 0, null],
      ["polled", null, 1, 3, null],
    ]
    for (const [label, status, attempts, days, msg] of seed) {
      const [r] = await owner`insert into core.webhook_deliveries
          (tenant_id, endpoint_id, event_type, occurred_at, payload, status, response_status, attempts, message_id, created_at)
        values (${dtenant}, ${dendpoint}, 'email.delivered', now(), ${owner.json({ label })},
                ${attempts === 0 ? "pending" : label === "silent" ? "failed" : "delivered"}, ${status}, ${attempts}, ${msg},
                now() - make_interval(days => ${days}))
        returning id`
      rows[label] = r!.id as string
    }
  })
  afterAll(async () => {
    await owner`delete from core.tenants where id = ${dtenant}`
    await owner.end()
    await db.end()
  })

  const byId = () => Object.fromEntries(Object.entries(rows).map(([l, id]) => [id, l]))

  it("narrows by time, response class and id prefix on both lists", async () => {
    const q = consoleQueries(database)
    const h = webhookHistory(database)
    const consoleLabels = async (f: DeliveryFilter) =>
      (await q.listDeliveries(dtenant, f)).data.map((d) => byId()[d.id]).sort()
    const apiLabels = async (f: DeliveryFilter) =>
      (await h.list(dtenant, f)).data.map((d) => byId()[d.id]).sort()
    const both = async (f: DeliveryFilter) => {
      const a = await consoleLabels(f)
      expect(await apiLabels(f)).toEqual(a)
      return a
    }
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000 - 60_000)

    expect(await both({ since: daysAgo(2) })).toEqual([
      "created",
      "ok",
      "unauthorized",
      "waiting",
    ])
    expect(await both({ until: daysAgo(2) })).toEqual(["broken", "polled", "silent"])
    expect(await both({ since: daysAgo(6), until: daysAgo(1) })).toEqual([
      "broken",
      "polled",
      "unauthorized",
    ])

    expect(await both({ httpClass: "2xx" })).toEqual(["created", "ok"])
    expect(await both({ httpClass: "4xx" })).toEqual(["unauthorized"])
    expect(await both({ httpClass: "5xx" })).toEqual(["broken"])
    // Attempted, undelivered, never answered: neither the delivery still
    // waiting nor the one a polling endpoint fetched is one.
    expect(await both({ httpClass: "none" })).toEqual(["silent"])

    const id = rows.broken!
    expect(await both({ q: id })).toEqual(["broken"])
    // ⚠ PAST THE CLOCK: a uuidv7's first 12 hex digits are its millisecond,
    // which rows written together share, so a short prefix matches them all.
    expect(await both({ q: id.slice(0, 23).toUpperCase() })).toEqual(["broken"])
    expect(await both({ q: id.replaceAll("-", "").slice(0, 20) })).toEqual(["broken"])
    expect(await both({ q: "0192f3a1-7c" })).toEqual(["ok"])
    expect(await both({ q: message })).toEqual(["ok"])
    expect(await both({ q: "acme" })).toEqual([])
    expect(await both({ q: "%" })).toEqual([])
  })

  it("pages exactly under a filter, one row at a time", async () => {
    const q = consoleQueries(database)
    const h = webhookHistory(database)
    const filter: DeliveryFilter = { since: new Date(Date.now() - 6 * 86_400_000) }

    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await q.listDeliveries(dtenant, {
        ...filter,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      })
      seen.push(...page.data.map((d) => byId()[d.id]!))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    // Newest first, each once: "waiting" was written after "ok" on the same day.
    expect(seen).toEqual([
      "waiting",
      "ok",
      "created",
      "unauthorized",
      "polled",
      "broken",
    ])

    const api: string[] = []
    let next: string | undefined
    do {
      const page = await h.list(dtenant, {
        ...filter,
        httpClass: "2xx",
        limit: 1,
        ...(next ? { cursor: next } : {}),
      })
      api.push(...page.data.map((d) => byId()[d.id]!))
      next = page.next_cursor ?? undefined
    } while (next)
    expect(api).toEqual(["ok", "created"])
  })
})
