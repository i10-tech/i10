import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { memoryStore, packKey, type ContentStore } from "../src/content/object-store.js"
import { packBodies, sweepPacks, type PackDeps } from "../src/content/packs.js"
import { parseKeyring } from "../src/content/seal.js"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { expireTenant } from "../src/retention/expire.js"
import { emailLookup } from "../src/send/lookup.js"

/**
 * Bodies to R2 in packs (#188), against the real schema as `i10_api`.
 *
 * Run it against a THROWAWAY database with every migration applied:
 *
 *   STORAGE_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/pack_scratch bun test test/content-packs-db.test.ts
 *
 * The URL is the OWNER's (to seed and to age rows); the code under test logs
 * in as `i10_api`, which is what makes RLS apply.
 */
const URL = process.env.STORAGE_TEST_DATABASE_URL
const API_URL =
  process.env.STORAGE_TEST_API_DATABASE_URL ??
  URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>
let db: Database
const tenants: string[] = []

const keys = parseKeyring(
  `k1:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}`,
)
const contentStore = () => Object.assign(memoryStore(), { keys })

async function workspace() {
  const id = crypto.randomUUID()
  await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
              values (${id}, ${`p-${id.slice(0, 8)}`}, 'T', ${`pack-test-${id}`})`
  await owner`insert into core.plan_assignments (tenant_id, plan_id, anchor) values (${id}, 'free', now())`
  tenants.push(id)
  return id
}

/**
 * One message and its body, examined by compaction unless told otherwise.
 *
 * ⚠ MILLISECOND `created_at`, as accept writes it: `GET /emails/:id` reads
 * the body keyed on the message's timestamp through a JS Date.
 */
async function seed(
  tenantId: string,
  {
    html = "<p>hello</p>" as string | null,
    text = "hello" as string | null,
    minutesAgo = 120,
    status = "sent",
    examined = true,
    linked = false,
  } = {},
) {
  const [m] = await owner`
    with m as (
      insert into core.messages (tenant_id, created_at, from_address, to_addresses, subject, status, queue, sent_at)
      values (${tenantId}, date_trunc('milliseconds', now() - make_interval(mins => ${minutesAgo})), 'shop@acme.com',
              '{a@example.com}', 's', ${status}, 'transactional', now())
      returning id, created_at, tenant_id
    )
    insert into core.message_bodies (message_id, created_at, tenant_id, html, text, examined_at)
    select id, created_at, tenant_id, ${html}, ${text}, ${examined ? new Date().toISOString() : null}::timestamptz from m
    returning message_id as id`
  const id = m!.id as string
  if (linked) {
    const [t] = await owner`
      insert into core.content_templates (tenant_id, skeleton_hash, segments, bands, static_bytes, holes, messages)
      values (${tenantId}, ${crypto.randomUUID()}, '["<p>", "</p>"]'::jsonb, '{}', 7, 1, 1)
      returning id`
    await owner`update core.message_bodies set template_id = ${t!.id}, template_values = '["hello"]'::jsonb
                 where message_id = ${id}`
  }
  return id
}

const body = async (id: string) =>
  (
    await owner`select html, text, pack_id, pack_offset, pack_length, body_key, template_id
                 from core.message_bodies where message_id = ${id}`
  )[0]!

const deps = (store: ContentStore, over: Partial<PackDeps> = {}): PackDeps => ({
  db,
  store,
  targetBytes: 1,
  maxWaitHours: 6,
  ...over,
})

suite("bodies packed into R2, against Postgres as i10_api (#188)", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    app = postgres(API_URL!, { max: 4, onnotice: () => {}, prepare: false })
    db = drizzle(app, { schema }) as unknown as Database
  })

  afterAll(async () => {
    for (const id of tenants) {
      for (const t of [
        "message_bodies",
        "messages",
        "content_templates",
        "content_packs",
        "expired_messages",
        "plan_assignments",
      ]) {
        await owner
          .unsafe(`delete from core.${t} where tenant_id = $1`, [id])
          .catch(() => {})
      }
      await owner`delete from core.tenants where id = ${id}`.catch(() => {})
    }
    await owner?.end()
    await app?.end()
  })

  it("packs finished, examined bodies into one object and reads each back exactly", async () => {
    const t = await workspace()
    const store = contentStore()
    const bodies = [
      { html: "<p>first 🎉</p>", text: "first" },
      { html: null, text: "text only" },
      {
        html: "<table>" + "<tr><td>x</td></tr>".repeat(2_000) + "</table>",
        text: null,
      },
    ]
    // ⚠ JUST NOW, AND PACKED WITH NO MINIMUM AGE: `GET /emails/:id` prunes by
    // the id's own timestamp, which a back-dated `created_at` would fall
    // outside of.
    const ids = []
    for (const b of bodies) ids.push(await seed(t, { ...b, minutesAgo: 0 }))

    const [due] =
      await app`select tenant_id from core.content_pack_due(500, now()) where tenant_id = ${t}`
    expect(due).toBeDefined()

    const r = await packBodies(t, deps(store, { minAgeMinutes: 0 }))
    expect(r).toMatchObject({ packs: 1, bodies: 3, errors: 0, waiting: false })
    expect(store.puts).toBe(1)
    expect(r.sealedBytes).toBeLessThan(r.rawBytes)

    for (const id of ids) {
      const row = await body(id)
      expect(row.html).toBeNull()
      expect(row.text).toBeNull()
      expect(row.pack_id).not.toBeNull()
      expect(row.body_key).not.toBeNull()
    }
    // Nothing readable in R2: sealed, not stored in the clear.
    const [object] = [...store.objects.values()]
    expect(Buffer.from(object!).toString()).not.toContain("first")

    // Read through the API as a customer would, one ranged read each.
    const lookup = emailLookup(db, store)
    for (const [i, id] of ids.entries()) {
      const email = await lookup.get(t, id)
      expect({ html: email!.html, text: email!.text }).toEqual(bodies[i]!)
    }
    expect(store.ranges).toBe(3)

    // A second run finds nothing left to pack.
    expect((await packBodies(t, deps(store))).packs).toBe(0)
  })

  it("leaves alone what is not ready: queued, too young, unexamined, compacted, recently linked", async () => {
    const t = await workspace()
    const store = contentStore()
    const queued = await seed(t, { status: "queued" })
    const young = await seed(t, { minutesAgo: 10 })
    const unexamined = await seed(t, { examined: false })
    const linked = await seed(t, { linked: true })
    const compacted = await seed(t)
    await owner`update core.message_bodies set html = null, text = null, compacted_at = now()
                 where message_id = ${compacted}`

    const r = await packBodies(t, deps(store))
    expect(r.packs).toBe(0)
    for (const id of [queued, young, unexamined, linked]) {
      expect((await body(id)).pack_id).toBeNull()
      expect((await body(id)).html).toBe("<p>hello</p>")
    }
    expect(store.puts).toBe(0)
  })

  it("waits for the risk passes when risk is on, up to a day", async () => {
    const t = await workspace()
    const store = contentStore()
    const unread = await seed(t)
    const stale = await seed(t, { minutesAgo: 25 * 60 })
    const r = await packBodies(t, deps(store, { awaitRisk: true }))
    expect(r.bodies).toBe(1)
    expect((await body(unread)).pack_id).toBeNull()
    expect((await body(stale)).pack_id).not.toBeNull()
  })

  it("packs mail compaction will never examine, and unlinks a template that never established", async () => {
    const t = await workspace()
    const store = contentStore()
    const old = await seed(t, { examined: false, minutesAgo: 8 * 24 * 60 })
    const orphan = await seed(t, { linked: true, minutesAgo: 25 * 60 })
    await packBodies(t, deps(store))
    expect((await body(old)).pack_id).not.toBeNull()
    const o = await body(orphan)
    expect(o.pack_id).not.toBeNull()
    // ⚠ UNLINKED, or it would read as compacted and be rebuilt from a template.
    expect(o.template_id).toBeNull()
  })

  it("waits until enough is waiting to be worth a write, or the oldest has waited too long", async () => {
    const t = await workspace()
    const store = contentStore()
    const id = await seed(t)
    const waiting = await packBodies(t, deps(store, { targetBytes: 1_000_000 }))
    expect(waiting).toMatchObject({ packs: 0, waiting: true })
    expect(store.puts).toBe(0)
    expect((await body(id)).html).toBe("<p>hello</p>")

    // Two hours old, one of them past the hour of age: past a one-hour wait.
    const shipped = await packBodies(
      t,
      deps(store, { targetBytes: 1_000_000, maxWaitHours: 0 }),
    )
    expect(shipped).toMatchObject({ packs: 1, bodies: 1 })
  })

  it("keeps every body in Postgres when R2 fails the upload, and sweeps the empty pack", async () => {
    const t = await workspace()
    const store = contentStore()
    store.put = async () => {
      throw new Error("R2 is having a bad day")
    }
    const id = await seed(t)
    const r = await packBodies(t, deps(store))
    expect(r).toMatchObject({ packs: 0, errors: 1 })
    expect((await body(id)).html).toBe("<p>hello</p>")
    expect((await body(id)).pack_id).toBeNull()

    // The pack row was written first and nothing points at it: swept.
    const [pack] =
      await owner`select count(*)::int as n from core.content_packs where tenant_id = ${t}`
    expect(pack!.n).toBe(1)
    expect(await sweepPacks(t, { db, store, graceHours: 0 })).toBe(1)
  })

  it("keeps every body in Postgres when R2 returns something other than what was written", async () => {
    const t = await workspace()
    const store = contentStore()
    const get = store.get.bind(store)
    store.get = async (key) => {
      const bytes = Buffer.from(await get(key))
      bytes[0] = bytes[0]! ^ 1
      return bytes
    }
    const id = await seed(t)
    const r = await packBodies(t, deps(store))
    expect(r).toMatchObject({ packs: 0, errors: 1 })
    expect((await body(id)).html).toBe("<p>hello</p>")
  })

  it("never releases a body that changed while its pack was uploading", async () => {
    const t = await workspace()
    const store = contentStore()
    const changed = await seed(t, { html: "<p>before</p>" })
    const steady = await seed(t)
    const put = store.put.bind(store)
    store.put = async (key, bytes, type) => {
      await owner`update core.message_bodies set html = '<p>after</p>' where message_id = ${changed}`
      return put(key, bytes, type)
    }
    const r = await packBodies(t, deps(store))
    expect(r.bodies).toBe(1)
    expect((await body(changed)).html).toBe("<p>after</p>")
    expect((await body(changed)).pack_id).toBeNull()
    expect((await body(steady)).pack_id).not.toBeNull()
  })

  it("keeps a pack while any body points into it, and sweeps it when retention took the last", async () => {
    const t = await workspace()
    const store = contentStore()
    const older = await seed(t, { minutesAgo: 5 * 24 * 60 })
    const newer = await seed(t, { minutesAgo: 2 * 24 * 60 })
    await packBodies(t, deps(store))
    const packId = String((await body(older)).pack_id)
    expect((await body(newer)).pack_id).toBe(packId)
    await owner`update core.content_packs set created_at = now() - interval '3 days' where id = ${packId}`

    // Free keeps 3 days: the older message goes, key and all.
    await expireTenant(t, 3, { db, batch: 100 })
    expect(
      await owner`select 1 from core.message_bodies where message_id = ${older}`,
    ).toHaveLength(0)
    expect(await sweepPacks(t, { db, store, graceHours: 24 })).toBe(0)
    expect(store.objects.has(packKey(t, packId))).toBe(true)

    await expireTenant(t, 1, { db, batch: 100 })
    const [due] =
      await app`select tenant_id from core.content_sweep_due(interval '24 hours') where tenant_id = ${t}`
    expect(due).toBeDefined()
    expect(await sweepPacks(t, { db, store, graceHours: 24 })).toBe(1)
    expect(store.objects.has(packKey(t, packId))).toBe(false)
  })

  it("packs nothing without CONTENT_KEYS", async () => {
    const t = await workspace()
    const store = memoryStore()
    await seed(t)
    expect((await packBodies(t, deps(store))).packs).toBe(0)
    expect(store.puts).toBe(0)
  })
})
