import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { marketingStore } from "../src/console/marketing.js"
import { consoleQueries } from "../src/console/queries.js"
import { suppressionStore } from "../src/suppressions/store.js"

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
