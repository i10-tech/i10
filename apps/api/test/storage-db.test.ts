import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import {
  restoreAttachments,
  storeAttachments,
  sweepObjects,
} from "../src/content/attachments.js"
import { memoryStore, objectKey } from "../src/content/object-store.js"
import { sweepTemplates } from "../src/content/sweep.js"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { expireTenant } from "../src/retention/expire.js"
import { webhookEventOps } from "../src/webhooks/db.js"
import { ingestEvent, type NormalisedEvent } from "../src/webhooks/events.js"

/**
 * Attachments to R2, retention and the sweeps, against the real schema as
 * `i10_api` (#136, #168, #188).
 *
 * Run it against a THROWAWAY database with every migration applied:
 *
 *   STORAGE_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/storage_scratch bun test test/storage-db.test.ts
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

const A = crypto.randomUUID()
const B = crypto.randomUUID()
const LOGO = Buffer.from("the same logo, in fifty thousand emails").toString("base64")
const PDF = Buffer.from("%PDF-1.7 an invoice").toString("base64")

async function seedMessage(
  tenant: string,
  {
    ageDays = 0,
    status = "sent",
    attachments = null as unknown,
    html = "<p>hi</p>" as string | null,
    templateId = null as string | null,
  } = {},
) {
  const id = crypto.randomUUID()
  const at = new Date(Date.now() - ageDays * 86_400_000).toISOString()
  await owner`insert into core.messages (id, created_at, tenant_id, status, from_address, to_addresses, subject)
              values (${id}, ${at}, ${tenant}, ${status}, 'a@x.test', ${["r@example.com"]}, 's')`
  await owner`insert into core.message_bodies (message_id, created_at, tenant_id, html, attachments, template_id)
              values (${id}, ${at}, ${tenant}, ${html}, ${attachments === null ? null : owner.json(attachments as never)}, ${templateId})`
  return { id, at }
}

suite("storage and retention against Postgres, as i10_api", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    app = postgres(API_URL!, { max: 4, onnotice: () => {}, prepare: false })
    db = drizzle(app, { schema }) as unknown as Database
    for (const id of [A, B]) {
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
                  values (${id}, ${`s-${id.slice(0, 8)}`}, 'T', ${`storage-test-${id}`})`
      await owner`insert into core.plan_assignments (tenant_id, plan_id, anchor) values (${id}, 'free', now())`
    }
  })

  afterAll(async () => {
    for (const id of [A, B]) {
      for (const t of [
        "message_events",
        "message_bodies",
        "messages",
        "content_objects",
        "content_templates",
        "expired_messages",
        "suppressions",
        "meter_events",
        "webhook_deliveries",
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

  it("moves finished messages' files to R2 once per workspace, and never a queued one's", async () => {
    const store = memoryStore()
    const files = [
      { filename: "logo.png", content_type: "image/png", content: LOGO },
      { filename: "invoice.pdf", content: PDF },
    ]
    const sent1 = await seedMessage(A, { attachments: files })
    const sent2 = await seedMessage(A, { attachments: [files[0]] })
    const queued = await seedMessage(A, { status: "queued", attachments: [files[0]] })
    // Another workspace with the same logo gets its own object.
    await seedMessage(B, { attachments: [files[0]] })

    const r = await storeAttachments(A, { db, store })
    expect(r).toMatchObject({ moved: 2, uploaded: 2, reused: 1, errors: 0 })
    await storeAttachments(B, { db, store })
    expect(store.objects.size).toBe(3)

    const [row] =
      await owner`select attachments, attachments_stored_at from core.message_bodies where message_id = ${sent1.id}`
    expect(row!.attachments_stored_at).not.toBeNull()
    expect(row!.attachments[0]).toEqual({
      filename: "logo.png",
      content_type: "image/png",
      size: Buffer.from(LOGO, "base64").byteLength,
      sha256: expect.any(String),
    })
    expect(JSON.stringify(row!.attachments)).not.toContain(LOGO)

    const [still] =
      await owner`select attachments_stored_at from core.message_bodies where message_id = ${queued.id}`
    expect(still!.attachments_stored_at).toBeNull()

    // Byte-exact on the way back: a retry sends exactly what the caller sent.
    const back = await restoreAttachments(store, A, row!.attachments)
    expect(back).toEqual([
      { filename: "logo.png", content_type: "image/png", content: LOGO },
      { filename: "invoice.pdf", content: PDF },
    ])
    expect(sent2).toBeDefined()
  })

  it("keeps billing whole: expiring a free workspace's mail leaves its meter untouched", async () => {
    await owner`delete from core.messages where tenant_id = ${B}`
    const old = await seedMessage(B, { ageDays: 5 })
    const recent = await seedMessage(B, { ageDays: 1 })
    for (const m of [old, recent]) {
      await owner`insert into core.meter_events (tenant_id, feature_id, event_id, occurred_at, value)
                  values (${B}, 'emails', ${m.id}, ${m.at}, 1)`
    }
    await owner`insert into core.message_events (tenant_id, message_id, occurred_at, type, source_event_id, payload)
                values (${B}, ${old.id}, ${old.at}, 'delivered', ${`src-${old.id}`}, '{}')`

    const r = await expireTenant(B, 3, { db, batch: 100 })
    expect(r.messages).toBeGreaterThanOrEqual(1)
    expect(r.events).toBeGreaterThanOrEqual(1)

    const left = await owner`select id from core.messages where tenant_id = ${B}`
    expect(left.map((x) => x.id)).toEqual([recent.id])
    const [bodies] =
      await owner`select count(*)::int as n from core.message_bodies where message_id = ${old.id}`
    expect(bodies!.n).toBe(0)
    const [meter] =
      await owner`select count(*)::int as n from core.meter_events where tenant_id = ${B}`
    expect(meter!.n).toBe(2)
    const [tomb] =
      await owner`select tenant_id from core.expired_messages where message_id = ${old.id}`
    expect(tomb!.tenant_id).toBe(B)
  })

  it("still suppresses an address when the complaint arrives after the message expired", async () => {
    const [tomb] =
      await owner`select message_id from core.expired_messages where tenant_id = ${B} limit 1`
    const ops = webhookEventOps({ db, queue: { add: async () => {} } as never })
    const event: NormalisedEvent = {
      type: "email.complained",
      messageId: tomb!.message_id,
      occurredAt: new Date(),
      sourceEventId: `late-${tomb!.message_id}`,
      suppress: [{ address: "late@example.com", reason: "complaint" }],
      data: {} as never,
      raw: {},
    }
    const out = await ingestEvent(event, {
      ...ops,
      log: { warn: () => {}, error: () => {}, info: () => {} } as never,
    })
    expect(out.status).toBe("suppressed_expired")
    const [s] =
      await owner`select reason from core.suppressions where tenant_id = ${B} and address = 'late@example.com'`
    expect(s!.reason).toBe("complaint")
  })

  it("frees an object only once no body names it, and only past its grace", async () => {
    const store = memoryStore()
    const T = crypto.randomUUID()
    await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id) values (${T}, ${`s-${T.slice(0, 8)}`}, 'T', ${`storage-test-${T}`})`
    try {
      const m1 = await seedMessage(T, {
        attachments: [{ filename: "a", content: LOGO }],
      })
      await seedMessage(T, { attachments: [{ filename: "b", content: LOGO }] })
      await storeAttachments(T, { db, store })
      expect(store.objects.size).toBe(1)
      await owner`update core.content_objects set last_seen_at = now() - interval '2 days' where tenant_id = ${T}`

      // One of two bodies gone: still referenced, still there.
      await owner`delete from core.message_bodies where message_id = ${m1.id}`
      expect(await sweepObjects(T, { db, store, graceHours: 24 })).toBe(0)
      expect(store.objects.size).toBe(1)

      // Both gone, but touched recently: kept.
      await owner`delete from core.message_bodies where tenant_id = ${T}`
      await owner`update core.content_objects set last_seen_at = now() where tenant_id = ${T}`
      expect(await sweepObjects(T, { db, store, graceHours: 24 })).toBe(0)

      // Both gone and stale: deleted from R2 and from the ledger.
      await owner`update core.content_objects set last_seen_at = now() - interval '2 days' where tenant_id = ${T}`
      expect(await sweepObjects(T, { db, store, graceHours: 24 })).toBe(1)
      expect(store.objects.size).toBe(0)
      const [n] =
        await owner`select count(*)::int as n from core.content_objects where tenant_id = ${T}`
      expect(n!.n).toBe(0)

      // The way back: the same file sent again is uploaded again.
      await seedMessage(T, { attachments: [{ filename: "c", content: LOGO }] })
      const again = await storeAttachments(T, { db, store })
      expect(again.uploaded).toBe(1)
      expect([...store.objects.keys()][0]).toBe(
        objectKey(
          T,
          new Bun.CryptoHasher("sha256")
            .update(Buffer.from(LOGO, "base64"))
            .digest("hex"),
        ),
      )
    } finally {
      for (const t of ["message_bodies", "messages", "content_objects"])
        await owner.unsafe(`delete from core.${t} where tenant_id = $1`, [T])
      await owner`delete from core.tenants where id = ${T}`
    }
  })

  it("deletes a template only when nothing uses it and it has gone stale", async () => {
    const [t] =
      await owner`insert into core.content_templates (tenant_id, skeleton_hash, segments, bands, static_bytes, holes, last_seen_at)
                            values (${A}, ${`h-${A}`}, '["<p>Hi ", "</p>"]', '{}', 9, 1, now() - interval '30 days')
                            returning id`
    const used = await seedMessage(A, { html: null, templateId: t!.id })

    expect(await sweepTemplates(db, A, 7)).toBe(0)
    await owner`delete from core.message_bodies where message_id = ${used.id}`
    expect(await sweepTemplates(db, A, 7)).toBe(1)
  })

  it("finds due workspaces through the definer, never below the reconcile floor", async () => {
    await seedMessage(A, { ageDays: 4 })
    const due = await db.execute(
      sql`select tenant_id, retention_days from core.retention_due(3)`,
    )
    const row = (
      due as unknown as { tenant_id: string; retention_days: number }[]
    ).find((r) => r.tenant_id === A)
    expect(row?.retention_days).toBe(3)
    const floored = await db.execute(sql`select tenant_id from core.retention_due(10)`)
    expect(
      (floored as unknown as { tenant_id: string }[]).some((r) => r.tenant_id === A),
    ).toBe(false)
  })
})
