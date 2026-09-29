import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { compactContent } from "../src/content/compact.js"
import { hashEmbedder } from "../src/content/embed.js"
import { analyseContent } from "../src/content/job.js"
import { restoreBodies } from "../src/content/restore.js"
import { withTenant, type Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { fingerprintStored } from "../src/risk/content.js"

/**
 * The content passes against Postgres, as `i10_api` (#171): compaction that
 * always progresses, pairing across passes, promotion by template, the risk
 * half's own progress marker, and fingerprints read from stored bodies.
 *
 * Run it against a THROWAWAY database with every migration applied:
 *
 *   STORAGE_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/storage_scratch bun test test/content-db.test.ts
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

const receipt = (name: string, order: string) =>
  `<html><body><table width="600"><tr><td><img src="https://cdn.acme.com/logo.png"></td></tr>` +
  `<tr><td><h1>Thanks for your order, ${name}!</h1><p>Your order <b>#${order}</b> is confirmed ` +
  `and ships within two business days. Questions? Reply to this email and our team will help.</p>` +
  `<p style="color:#999">Acme Inc, 1 Market St, San Francisco</p></td></tr></table></body></html>`

const WORDS = [
  "harbour lantern quietly folds the evening map",
  "copper kettles whistle beside orchard ladders",
  "velvet thunder rolls over basalt meadows tonight",
  "seven pilgrims barter saffron for glass beads",
  "the archivist misplaced a comet in drawer nine",
  "moss grows faster where the violinist practises",
  "tidal clocks disagree about the length of noon",
  "a cartographer sketches rivers that flow uphill",
]
/** Mail that is like nothing else, long enough to fingerprint. */
const unique = (i: number) =>
  `<p>${WORDS[i % WORDS.length]}; ${WORDS[(i + 3) % WORDS.length]}. Entry ${"abcdefghij"[i]} of the ledger, ${WORDS[(i + 5) % WORDS.length]}.</p>`

async function workspace() {
  const id = crypto.randomUUID()
  await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
              values (${id}, ${`c-${id.slice(0, 8)}`}, 'T', ${`content-test-${id}`})`
  tenants.push(id)
  return id
}

/** One message and its body, `minutesAgo` old. */
async function seed(
  tenantId: string,
  html: string,
  { minutesAgo = 0, status = "sent", subject = "Your order" } = {},
) {
  // ⚠ ONE STATEMENT, so `created_at` never round-trips through a JS Date.
  const [m] = await owner`
    with m as (
      insert into core.messages (tenant_id, created_at, from_address, to_addresses, subject, status, queue, sent_at)
      values (${tenantId}, now() - make_interval(mins => ${minutesAgo}), 'shop@acme.com',
              '{a@example.com}', ${subject}, ${status}, 'transactional', now())
      returning id, created_at, tenant_id
    )
    insert into core.message_bodies (message_id, created_at, tenant_id, html)
    select id, created_at, tenant_id, ${html} from m
    returning message_id as id`
  return m!.id as string
}

async function compactedCount(tenantId: string) {
  const [r] =
    await owner`select count(*)::int as n from core.message_bodies where tenant_id = ${tenantId} and compacted_at is not null`
  return r!.n as number
}

suite("content passes against Postgres, as i10_api (#171)", () => {
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
        "content_fingerprints",
        "link_hosts",
        "content_vectors",
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

  it("never starves: five old unique bodies no longer hide six newer receipts", async () => {
    // The review's reproduction, exactly: with a batch of five, the old pass
    // scanned the same five unique bodies on every run and compacted nothing.
    const t = await workspace()
    for (let i = 0; i < 5; i++) await seed(t, unique(i), { minutesAgo: 120 - i })
    const names = ["John", "Sarah", "Li", "Zoe", "Omar", "Ana"]
    for (const [i, n] of names.entries()) {
      await seed(t, receipt(n, String(1000 + i)), { minutesAgo: 60 - i })
    }

    const runs = []
    for (let i = 0; i < 3; i++) runs.push(await compactContent(t, { db, limit: 5 }))
    expect(runs.map((r) => r.scanned)).toEqual([5, 5, 1])
    expect(runs[0]!.compacted).toBe(0)
    expect(await compactedCount(t)).toBe(6)
    // And the unique ones stay whole, examined, with their bands kept.
    const lonely =
      await owner`select html, examined_at, content_bands from core.message_bodies where tenant_id = ${t} and template_id is null`
    expect(lonely).toHaveLength(5)
    expect(lonely.every((b) => b.html !== null && b.examined_at !== null)).toBe(true)
    expect(lonely.every((b) => (b.content_bands as string[]).length > 0)).toBe(true)
    // A fourth run has nothing left to read.
    expect((await compactContent(t, { db, limit: 5 })).scanned).toBe(0)
  })

  it("pairs a body with its twin from an earlier pass", async () => {
    const t = await workspace()
    await seed(t, receipt("Ada", "1"), { minutesAgo: 30 })
    const first = await compactContent(t, { db })
    expect(first).toMatchObject({ scanned: 1, matched: 0, derived: 0 })

    // Its twin arrives after the first body was examined and never re-read.
    await seed(t, receipt("Bob", "2"))
    const second = await compactContent(t, { db })
    expect(second.scanned).toBe(1)
    expect(second.derived).toBe(1)
    expect(second.matched).toBe(2)
    const linked =
      await owner`select count(*)::int as n from core.message_bodies where tenant_id = ${t} and template_id is not null and content_bands is null`
    expect(linked[0]!.n).toBe(2)
  })

  it("compacts earlier links when a later pass establishes the template, byte-exactly", async () => {
    const t = await workspace()
    const early = [
      await seed(t, receipt("Ada", "1"), { minutesAgo: 20 }),
      await seed(t, receipt("Bob", "2"), { minutesAgo: 19 }),
    ]
    const first = await compactContent(t, { db, promoteAt: 3 })
    expect(first).toMatchObject({ matched: 2, compacted: 0 })

    await seed(t, receipt("Cy", "3"))
    const second = await compactContent(t, { db, promoteAt: 3 })
    expect(second.scanned).toBe(1)
    expect(second.compacted).toBe(3)

    for (const [i, id] of early.entries()) {
      const [row] = await withTenant(db, t, async (tx) =>
        restoreBodies(
          tx,
          await tx
            .select({
              html: schema.messageBodies.html,
              text: schema.messageBodies.text,
              templateId: schema.messageBodies.templateId,
              templateValues: schema.messageBodies.templateValues,
            })
            .from(schema.messageBodies)
            .where(eq(schema.messageBodies.messageId, id)),
        ),
      )
      expect(row!.html).toBe(receipt(["Ada", "Bob"][i]!, String(i + 1)))
    }
  })

  it("finds every workspace with work, whatever its status, and skips one with only queued mail", async () => {
    const active = await workspace()
    const suspended = await workspace()
    await owner`update core.tenants set status = 'suspended' where id = ${suspended}`
    const queuedOnly = await workspace()
    await seed(active, receipt("A", "1"))
    await seed(suspended, receipt("S", "1"))
    await seed(queuedOnly, receipt("Q", "1"), { status: "queued" })

    const due = (
      (await app`select tenant_id from core.content_compaction_due(10000, now() - interval '7 days', 3)`) as {
        tenant_id: string
      }[]
    ).map((r) => r.tenant_id)
    expect(due).toContain(active)
    expect(due).toContain(suspended)
    expect(due).not.toContain(queuedOnly)

    // Fingerprints are any status: queued mail is still a sighting.
    const fp = (
      (await app`select tenant_id from core.content_fingerprint_due(10000, now() - interval '7 days')`) as {
        tenant_id: string
      }[]
    ).map((r) => r.tenant_id)
    expect(fp).toContain(queuedOnly)
  })

  it("embeds a backlog over several runs instead of re-reading the head of it", async () => {
    const t = await workspace()
    for (let i = 0; i < 8; i++) {
      await seed(t, unique(i), {
        minutesAgo: 10 - i,
        subject: `Subject ${"abcdefgh"[i]}`,
      })
    }
    const embedder = hashEmbedder()
    const embedded = []
    for (let i = 0; i < 3; i++) {
      embedded.push((await analyseContent(t, { db, embedder, embedLimit: 3 })).embedded)
    }
    expect(embedded).toEqual([3, 3, 2])
    const [left] =
      await owner`select count(*)::int as n from core.message_bodies where tenant_id = ${t} and analysed_at is null`
    expect(left!.n).toBe(0)
  })

  it("fingerprints stored bodies once, and trips the wire across workspaces", async () => {
    const a = await workspace()
    const b = await workspace()
    const promo = (i: number) =>
      `<p>Claim your reward today, recipient ${i}. Limited stock, act now before the offer ends at https://deals.example.top/c?u=${i}</p>`
    await seed(a, promo(1), { subject: "Exclusive offer" })
    await seed(a, promo(2), { subject: "Exclusive offer" })
    await seed(b, promo(3), { subject: "Exclusive offer", status: "queued" })

    const sets = new Map<string, Set<string>>()
    const redis = {
      pipeline() {
        const ops: (() => unknown)[] = []
        const p = {
          sadd: (k: string, m: string) => (
            ops.push(() => (sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(m)),
            p
          ),
          expire: () => (ops.push(() => 1), p),
          scard: (k: string) => (ops.push(() => sets.get(k)?.size ?? 0), p),
          exec: async () => ops.map((f) => [null, f()] as [null, unknown]),
        }
        return p
      },
      smembers: async (k: string) => [...(sets.get(k) ?? [])],
      set: async () => "OK",
    }
    const rescored: string[][] = []
    const deps = {
      db,
      redis,
      threshold: 2,
      rescore: (ids: string[]) => rescored.push(ids),
    }
    expect(await fingerprintStored(a, deps)).toBe(2)
    expect(await fingerprintStored(b, deps)).toBe(1)
    expect(rescored.some((ids) => ids.includes(a) && ids.includes(b))).toBe(true)

    const [row] =
      await owner`select messages from core.content_fingerprints where tenant_id = ${a}`
    expect(row!.messages).toBe(2)
    // Stamped in the same commit: a second pass counts nothing again.
    expect(await fingerprintStored(a, deps)).toBe(0)
    const [again] =
      await owner`select messages from core.content_fingerprints where tenant_id = ${a}`
    expect(again!.messages).toBe(2)
  })
})
