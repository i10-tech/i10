import { and, asc, eq, gt, sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { events, siemExports } from "../db/identity.js"
import type { SecretBox } from "../webhooks/signing.js"
import type { SiemRow, SiemStore } from "./siem.js"

type Row = Record<string, unknown>

const toRow = (r: typeof siemExports.$inferSelect): SiemRow => ({
  tenantId: r.tenantId,
  endpoint: r.endpoint,
  bucket: r.bucket,
  region: r.region,
  prefix: r.prefix,
  accessKeyId: r.accessKeyId,
  secretHint: r.secretHint,
  enabled: r.enabled,
  lastEventId: r.lastEventId,
  lastExportAt: r.lastExportAt,
  lastError: r.lastError,
  lastErrorAt: r.lastErrorAt,
  nextRunAt: r.nextRunAt,
})

/**
 * The SIEM export's settings and cursor (db/identity.ts `siemExports`).
 *
 * ⚠ THE SECRET IS SEALED ON THE WAY IN AND OPENED ONLY BY `withSecret`, which
 * the exporter alone calls. No other method selects the ciphertext into a
 * value that leaves this file.
 */
export function siemStore(db: Database, secrets: SecretBox): SiemStore {
  return {
    async get(tenantId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx.select().from(siemExports).where(eq(siemExports.tenantId, tenantId)),
      )
      return row ? toRow(row) : null
    },

    async withSecret(tenantId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx.select().from(siemExports).where(eq(siemExports.tenantId, tenantId)),
      )
      return row
        ? { ...toRow(row), secretAccessKey: secrets.open(row.secretCiphertext) }
        : null
    },

    async put(tenantId, settings, by) {
      const values = {
        endpoint: settings.endpoint,
        bucket: settings.bucket,
        region: settings.region,
        prefix: settings.prefix,
        accessKeyId: settings.accessKeyId,
        secretCiphertext: secrets.seal(settings.secretAccessKey),
        secretHint: settings.secretAccessKey.slice(-4),
        enabled: settings.enabled,
        updatedBy: by,
      }
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .insert(siemExports)
          .values({ tenantId, ...values })
          .onConflictDoUpdate({
            target: siemExports.tenantId,
            // ⚠ THE CURSOR STAYS: pointing the export at another bucket carries
            // on from where it was rather than re-sending the whole log. A
            // fresh start is a removed and re-added export.
            set: {
              ...values,
              // A changed destination is tried now, and a past failure is stale.
              nextRunAt: sql`now()`,
              lastError: null,
              lastErrorAt: null,
              updatedAt: sql`now()`,
            },
          })
          .returning(),
      )
      return toRow(row!)
    },

    async update(tenantId, settings, by) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .update(siemExports)
          .set({
            endpoint: settings.endpoint,
            bucket: settings.bucket,
            region: settings.region,
            prefix: settings.prefix,
            accessKeyId: settings.accessKeyId,
            enabled: settings.enabled,
            updatedBy: by,
            nextRunAt: sql`now()`,
            lastError: null,
            lastErrorAt: null,
            updatedAt: sql`now()`,
          })
          .where(eq(siemExports.tenantId, tenantId))
          .returning(),
      )
      return row ? toRow(row) : null
    },

    async remove(tenantId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .delete(siemExports)
          .where(eq(siemExports.tenantId, tenantId))
          .returning({ id: siemExports.tenantId }),
      )
      return rows.length > 0
    },

    async eventsAfter(tenantId, after, limit) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(events)
          .where(
            and(
              eq(events.tenantId, tenantId),
              after ? gt(events.id, after) : undefined,
            ),
          )
          .orderBy(asc(events.id))
          .limit(limit),
      )
      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        actorUserId: r.actorUserId,
        subjectUserId: r.subjectUserId,
        connectionId: r.connectionId,
        sessionId: r.sessionId,
        reason: r.reason,
        data: r.data,
        createdAt: r.createdAt,
      }))
    },

    async claim(tenantId, leaseMs) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .update(siemExports)
          .set({
            nextRunAt: sql`now() + ${`${Math.ceil(leaseMs / 1000)} seconds`}::interval`,
          })
          .where(
            and(
              eq(siemExports.tenantId, tenantId),
              eq(siemExports.enabled, true),
              sql`${siemExports.nextRunAt} <= now()`,
            ),
          )
          .returning(),
      )
      return row ? toRow(row) : null
    },

    async progressed(tenantId, lastEventId) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(siemExports)
          .set({
            lastEventId,
            lastExportAt: sql`now()`,
            lastError: null,
            lastErrorAt: null,
          })
          .where(eq(siemExports.tenantId, tenantId)),
      )
    },

    async rescheduled(tenantId, ms) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(siemExports)
          .set({
            nextRunAt: sql`now() + ${`${Math.ceil(ms / 1000)} seconds`}::interval`,
          })
          .where(eq(siemExports.tenantId, tenantId)),
      )
    },

    async failed(tenantId, error, retryMs) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(siemExports)
          .set({
            lastError: error.slice(0, 500),
            lastErrorAt: sql`now()`,
            nextRunAt: sql`now() + ${`${Math.ceil(retryMs / 1000)} seconds`}::interval`,
          })
          .where(eq(siemExports.tenantId, tenantId)),
      )
    },

    async due(after, limit) {
      const rows = (await db.execute(
        sql`select tenant_id from identity.siem_exports_due(${after}::uuid, ${limit}::int)`,
      )) as unknown as Row[]
      return rows.map((r) => String(r.tenant_id))
    },
  }
}
