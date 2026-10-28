import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { webhookEventData } from "@repo/contracts"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { connectionHealthStore } from "../src/identity/health-store.js"
import { healthOf } from "../src/identity/health.js"
import { siemStore } from "../src/identity/siem-store.js"
import { identityStore } from "../src/identity/store.js"
import { keyStore } from "../src/auth/store.js"
import { secretBox } from "../src/webhooks/signing.js"
import { identityWebhooks } from "../src/webhooks/identity-events.js"
import { SECRET } from "./identity-siem-fakes.js"

/**
 * #345 slice B against a real database as `i10_api`: connection health from
 * the audit log, the once-per-15-minutes claim, the SIEM settings with the key
 * sealed, the events cursor, and the identity webhooks fanned out to a real
 * endpoint row.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/templates_scratch_345b bun test test/identity-extras-db.test.ts
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let db: ReturnType<typeof postgres>
let database: Database
const acme = crypto.randomUUID()
const rival = crypto.randomUUID()
const conn = crypto.randomUUID()
const box = secretBox("00".repeat(32))

suite("#345 identity extras", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    database = drizzle(db, { schema }) as unknown as Database
    for (const [id, name] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const)
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                  values (${id}, ${`x-${id.slice(0, 8)}`}, ${name}, ${`owner-${id}`}, ${`org_${id.slice(0, 8)}`})`
  })
  afterAll(async () => {
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await db.end()
  })

  const event = (
    tenant: string,
    type: string,
    over: { reason?: string; ago?: string; connection?: string } = {},
  ) =>
    owner`insert into identity.events (tenant_id, type, connection_id, reason, created_at)
          values (${tenant}, ${type}, ${over.connection ?? conn}, ${over.reason ?? null},
                  now() - ${over.ago ?? "0 seconds"}::interval)`

  describe("connection health", () => {
    const health = () => connectionHealthStore(database)

    it("counts failures by window, ignores a stranger's replays, and finds the last success", async () => {
      await event(acme, "sign_in.failed", {
        reason: "signature_invalid",
        ago: "5 minutes",
      })
      await event(acme, "sign_in.idp_unavailable", {
        reason: "timeout",
        ago: "40 minutes",
      })
      await event(acme, "sign_in.failed", {
        reason: "signature_invalid",
        ago: "10 hours",
      })
      await event(acme, "sign_in.failed", {
        reason: "signature_invalid",
        ago: "30 hours",
      })
      await event(acme, "sign_in.failed", { reason: "wrong_browser" })
      await event(acme, "sign_in.failed", { reason: "attempt_used" })
      await event(acme, "sign_in.succeeded", { ago: "2 days" })
      await event(acme, "sign_in.succeeded", { ago: "3 hours" })
      // Another connection, and another workspace, count for nothing here.
      await event(acme, "sign_in.failed", { connection: crypto.randomUUID() })
      await event(rival, "sign_in.failed", { reason: "signature_invalid" })

      const counts = await health().counts(acme, conn)
      expect(counts).toMatchObject({
        failuresLast15Minutes: 1,
        failuresLastHour: 2,
        failuresLast24Hours: 3,
      })
      const ago = Date.now() - counts.lastSuccessAt!.getTime()
      expect(ago).toBeGreaterThan(2.9 * 3_600_000)
      expect(ago).toBeLessThan(3.1 * 3_600_000)
      expect(healthOf(counts, "active", new Date()).failing).toBe(false)
    })

    it("answers an empty connection with zeroes and no success", async () => {
      expect(await health().counts(acme, crypto.randomUUID())).toEqual({
        lastSuccessAt: null,
        failuresLast15Minutes: 0,
        failuresLastHour: 0,
        failuresLast24Hours: 0,
      })
    })

    it("hands one alert claim per connection per window, and audits it", async () => {
      const h = health()
      const c = crypto.randomUUID()
      const snapshot = { trigger: "sign_in_failed" }
      expect(await h.claimAlert(acme, c, snapshot, 900_000)).toBe(true)
      expect(await h.claimAlert(acme, c, snapshot, 900_000)).toBe(false)
      // Another connection has its own window.
      expect(await h.claimAlert(acme, crypto.randomUUID(), snapshot, 900_000)).toBe(
        true,
      )
      // A window that has passed lets the next one through.
      await owner`update identity.events set created_at = now() - interval '16 minutes'
                  where connection_id = ${c} and type = 'sso.connection.failure_alerted'`
      expect(await h.claimAlert(acme, c, snapshot, 900_000)).toBe(true)
    })

    it("claims once under concurrency", async () => {
      const c = crypto.randomUUID()
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          health().claimAlert(acme, c, { trigger: "x" }, 900_000),
        ),
      )
      expect(results.filter(Boolean)).toHaveLength(1)
    })

    it("has the index the count reads, on connection, type and time", async () => {
      // ⚠ NOT AN EXPLAIN: on a table this small the planner prefers any index.
      const [idx] = await owner`select indexdef from pg_indexes
        where schemaname = 'identity' and indexname = 'events_connection_type_idx'`
      expect(idx!.indexdef).toContain(
        "(tenant_id, connection_id, type, created_at DESC",
      )
    })
  })

  describe("the SIEM settings", () => {
    const settings = {
      endpoint: "https://s3.eu-west-1.amazonaws.com",
      bucket: "acme-siem",
      region: "eu-west-1",
      prefix: "logs",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: SECRET,
      enabled: true,
    }

    it("seals the key and opens it only for the exporter", async () => {
      const s = siemStore(database, box)
      const row = await s.put(acme, settings, "user_owner")
      expect(JSON.stringify(row)).not.toContain(SECRET)
      expect(row.secretHint).toBe(SECRET.slice(-4))
      const [raw] =
        await owner`select secret_ciphertext from identity.siem_exports where tenant_id = ${acme}`
      expect(raw!.secret_ciphertext).not.toContain(SECRET)
      expect(JSON.stringify(await s.get(acme))).not.toContain(SECRET)
      expect((await s.withSecret(acme))!.secretAccessKey).toBe(SECRET)
    })

    it("keeps the stored key on an update that omits it, and the cursor on a new destination", async () => {
      const s = siemStore(database, box)
      await s.progressed(acme, "00000000-0000-7000-8000-000000000009")
      const rest = { ...settings, secretAccessKey: undefined }
      await s.update(acme, { ...rest, bucket: "other" }, "user_owner")
      const after = await s.withSecret(acme)
      expect(after).toMatchObject({
        bucket: "other",
        secretAccessKey: SECRET,
        lastEventId: "00000000-0000-7000-8000-000000000009",
      })
      await s.put(acme, { ...settings, bucket: "third" }, "user_owner")
      expect((await s.get(acme))!.lastEventId).toBe(
        "00000000-0000-7000-8000-000000000009",
      )
    })

    it("claims a due run once, and is not due again until rescheduled", async () => {
      const s = siemStore(database, box)
      await s.rescheduled(acme, 0)
      expect(await s.due(null, 50)).toContain(acme)
      expect(await s.claim(acme, 600_000)).not.toBeNull()
      expect(await s.claim(acme, 600_000)).toBeNull()
      expect(await s.due(null, 50)).not.toContain(acme)
      await s.failed(acme, "The bucket answered 403 AccessDenied.", 0)
      expect((await s.get(acme))!.lastError).toBe(
        "The bucket answered 403 AccessDenied.",
      )
      await s.progressed(acme, "00000000-0000-7000-8000-00000000000a")
      expect((await s.get(acme))!.lastError).toBeNull()
    })

    it("reads events in id order after the cursor, for one workspace only", async () => {
      const s = siemStore(database, box)
      const mine =
        await owner`select id from identity.events where tenant_id = ${acme} order by id`
      const after = await s.eventsAfter(acme, mine[1]!.id as string, 3)
      expect(after.map((e) => e.id)).toEqual(
        mine.slice(2, 5).map((r) => r.id as string),
      )
      expect(await s.eventsAfter(rival, null, 1000)).toHaveLength(1)
    })

    it("keeps one workspace out of another's settings", async () => {
      const s = siemStore(database, box)
      expect(await s.get(rival)).toBeNull()
      expect(await s.remove(rival)).toBe(false)
      expect(await s.get(acme)).not.toBeNull()
      expect(await s.remove(acme)).toBe(true)
    })
  })

  describe("identity webhooks", () => {
    it("fan out to the subscribed endpoints only, with the payload as recorded", async () => {
      const subscribed = crypto.randomUUID()
      const other = crypto.randomUUID()
      for (const [id, events] of [
        [subscribed, ["member.deprovisioned"]],
        [other, ["email.sent"]],
      ] as const)
        await owner`insert into core.webhook_endpoints
          (id, tenant_id, url, events, secret_ciphertext)
          values (${id}, ${acme}, ${"https://example.com/hook"},
                  ${owner.array(events as unknown as string[])}::core.webhook_event_type[], 'sealed')`
      const warnings: string[] = []
      await identityWebhooks({
        db: database,
        log: { warn: (_o, m) => void warnings.push(m) },
      }).emit(
        acme,
        "member.deprovisioned",
        {
          user_id: "user_gone",
          connection_id: null,
          mode: "membership",
          cause: "admin",
          actor_user_id: "user_admin",
          sessions_revoked: 1,
          api_keys: [{ id: "k1", name: "Production" }],
        },
        new Date("2026-10-28T12:00:00Z"),
      )
      expect(warnings).toEqual([])
      const rows =
        await owner`select endpoint_id, event_type, payload, sequence, status, next_attempt_at
        from core.webhook_deliveries where tenant_id = ${acme}`
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        endpoint_id: subscribed,
        event_type: "member.deprovisioned",
        sequence: "1",
        status: "pending",
      })
      expect(rows[0]!.next_attempt_at).not.toBeNull()
      const parsed = webhookEventData["member.deprovisioned"].safeParse(
        rows[0]!.payload,
      )
      expect(parsed.success).toBe(true)
      expect((rows[0]!.payload as { created_at: string }).created_at).toBe(
        "2026-10-28T12:00:00.000Z",
      )
    })

    it("never throws when it cannot record", async () => {
      const warnings: string[] = []
      await identityWebhooks({
        db: database,
        log: { warn: (_o, m) => void warnings.push(m) },
      }).emit("not-a-uuid", "sso.connection.failed", {})
      expect(warnings).toHaveLength(1)
    })
  })

  describe("the keys a person created", () => {
    it("lists only that person's live keys in that workspace", async () => {
      const insert = (tenant: string, by: string, name: string, revoked = false) =>
        owner`insert into core.api_keys (tenant_id, name, secret_hash, prefix, mode, created_by, revoked_at)
              values (${tenant}, ${name}, ${crypto.randomUUID()}, 'i10_live_x', 'live', ${by},
                      ${revoked ? new Date() : null})`
      await insert(acme, "user_gone", "Production")
      await insert(acme, "user_gone", "Old", true)
      await insert(acme, "user_other", "Theirs")
      await insert(rival, "user_gone", "Elsewhere")
      const keys = await keyStore(database).createdBy(acme, "user_gone")
      expect(keys.map((k) => k.name)).toEqual(["Production"])
    })

    it("rotates into the actor's name when asked", async () => {
      const store = keyStore(database)
      const [made] = await store.createdBy(acme, "user_gone")
      const rotated = await store.rotate(acme, made!.id, { createdBy: "user_admin" })
      expect(rotated).not.toBeNull()
      expect(await store.createdBy(acme, "user_gone")).toEqual([])
      expect((await store.createdBy(acme, "user_admin")).map((k) => k.name)).toEqual([
        "Production",
      ])
    })
  })

  it("keeps the identity store usable beside the new tables", async () => {
    const id = identityStore(database, box)
    await id.record(acme, { type: "settings.updated", data: {} })
    expect((await id.events(acme, { limit: 1 }))[0]!.type).toBe("settings.updated")
  })
})
