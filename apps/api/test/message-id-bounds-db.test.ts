import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { claimStatement } from "../src/db/claim.js"
import type { Database } from "../src/db/client.js"
import { consoleQueries } from "../src/console/queries.js"
import { emailLookup } from "../src/send/lookup.js"

/**
 * The partition bounds on reads by message id (#507) exclude nothing real: an
 * event in the month after its message, an id that cannot be dated, and a
 * claim whose batch spans two months.
 *
 *   STORAGE_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/storage_scratch bun test test/message-id-bounds-db.test.ts
 */
const URL = process.env.STORAGE_TEST_DATABASE_URL
const API_URL =
  process.env.STORAGE_TEST_API_DATABASE_URL ??
  URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

const T = crypto.randomUUID()
// The last millisecond of a month, so its first event lands in the next one.
const MONTH_END = Date.UTC(2026, 9, 31, 23, 59, 59, 999)

let owner: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>
let db: Database

/** A version 7 uuid minted at `ms`, as `uuidv7()` would have minted it then. */
function uuidv7At(ms: number): string {
  const hex =
    ms.toString(16).padStart(12, "0") +
    "7" +
    crypto.randomUUID().replaceAll("-", "").slice(13)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function message(id: string, at: number, status = "sent") {
  const created = new Date(at).toISOString()
  await owner`insert into core.messages (id, created_at, tenant_id, status, from_address, to_addresses, subject)
              values (${id}, ${created}, ${T}, ${status}, 'a@x.test', ${["r@example.com"]}, 's')`
  await owner`insert into core.message_bodies (message_id, created_at, tenant_id, html)
              values (${id}, ${created}, ${T}, '<p>hi</p>')`
}

async function event(messageId: string, type: string, at: number) {
  await owner`insert into core.message_events (tenant_id, message_id, type, occurred_at)
              values (${T}, ${messageId}, ${type}::core.message_event_type, ${new Date(at).toISOString()})`
}

const EDGE = uuidv7At(MONTH_END)
const V4 = crypto.randomUUID()
const NEXT_MONTH = uuidv7At(MONTH_END + 2 * 86_400_000)
// As production writes them: `created_at` is the transaction's start and the id
// is minted a little later, here across the month boundary.
const SKEWED = uuidv7At(MONTH_END + 5)

suite("reads by message id within partition bounds, against Postgres", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    app = postgres(API_URL!, { max: 2, onnotice: () => {}, prepare: false })
    db = drizzle({ client: app }) as unknown as Database
    await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
                values (${T}, ${`b-${T.slice(0, 8)}`}, 'T', ${`id-bounds-${T}`})`
    await message(EDGE, MONTH_END)
    await message(SKEWED, MONTH_END - 5)
    await event(SKEWED, "delivered", MONTH_END + 1_000)
    await event(EDGE, "delivered", MONTH_END + 1_000)
    await event(EDGE, "bounced", MONTH_END + 3_600_000)
    // An id we cannot date: found the slow way, not missed.
    await message(V4, Date.now() - 60_000)
    await event(V4, "delivered", Date.now() - 30_000)
    await message(NEXT_MONTH, MONTH_END + 2 * 86_400_000, "queued")
  })

  afterAll(async () => {
    for (const t of ["message_events", "message_bodies", "messages"]) {
      await owner
        .unsafe(`delete from core.${t} where tenant_id = $1`, [T])
        .catch(() => {})
    }
    await owner`delete from core.tenants where id = ${T}`.catch(() => {})
    await owner?.end()
    await app?.end()
  })

  it("finds an event in the month after its message", async () => {
    const email = await emailLookup(db).get(T, EDGE)
    expect(email?.last_event).toBe("bounced")

    const detail = await consoleQueries(db).emailDetail(T, EDGE)
    expect(detail?.events.map((e) => e.type)).toEqual(["delivered", "bounced"])
  })

  // ⚠ THE MARGIN IS WHAT MAKES THIS PASS: the id says 00:00:00.004 of the next
  // month, the row sits at 23:59:59.994 of this one, in the partition before.
  it("finds a message whose id was minted after its created_at", async () => {
    const email = await emailLookup(db).get(T, SKEWED)
    expect(email?.id).toBe(SKEWED)
    expect(email?.last_event).toBe("delivered")

    const detail = await consoleQueries(db).emailDetail(T, SKEWED)
    expect(detail?.id).toBe(SKEWED)
    expect(detail?.events.map((e) => e.type)).toEqual(["delivered"])
  })

  it("still finds a message whose id is not a v7", async () => {
    const email = await emailLookup(db).get(T, V4)
    expect(email?.id).toBe(V4)
    expect(email?.last_event).toBe("delivered")
  })

  it("finds nothing for a v7 we never minted", async () => {
    expect(
      await emailLookup(db).get(T, uuidv7At(MONTH_END - 86_400_000 * 40)),
    ).toBeNull()
  })

  it("lists a page whose events span months", async () => {
    const page = await consoleQueries(db).listEmails(T, {})
    const edge = page.data.find((e) => e.id === EDGE)
    expect(edge?.last_event).toBe("bounced")
  })

  it("claims a batch whose rows sit in two partitions", async () => {
    await owner`update core.messages set status = 'queued' where id = ${EDGE}`
    const won = await drizzle({ client: owner }).execute(
      claimStatement(
        [
          { id: EDGE, createdAt: new Date(MONTH_END) },
          { id: NEXT_MONTH, createdAt: new Date(MONTH_END + 2 * 86_400_000) },
        ],
        { workerId: "bounds-test", staleAfter: "5 minutes" },
      ),
    )
    expect((won as unknown as { id: string }[]).map((r) => r.id).sort()).toEqual(
      [EDGE, NEXT_MONTH].sort(),
    )
  })
})
