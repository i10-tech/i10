import { sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { events } from "../db/identity.js"
import {
  FAILURE_ALERT_TYPE,
  FAILURE_TYPES,
  NOT_THE_CONNECTIONS_FAULT,
  SUCCESS_TYPE,
  type ConnectionHealthStore,
} from "./health.js"

type Row = Record<string, unknown>

const list = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )

/** The health of a connection, counted from the identity audit log. */
export function connectionHealthStore(db: Database): ConnectionHealthStore {
  return {
    async counts(tenantId, connectionId) {
      return withTenant(db, tenantId, async (tx) => {
        // ⚠ ONE PASS OVER THE LAST 24 HOURS OF THIS CONNECTION'S FAILURES, and
        // a second, index-ordered read for the latest success: a connection can
        // go quiet for a month and its last success is still the answer.
        const [failures] = (await tx.execute(sql`
          select
            count(*) filter (where created_at > now() - interval '15 minutes')::int as f15,
            count(*) filter (where created_at > now() - interval '1 hour')::int as f1h,
            count(*)::int as f24h
            from identity.events
           where tenant_id = ${tenantId}::uuid
             and connection_id = ${connectionId}::uuid
             and type in (${list(FAILURE_TYPES)})
             and coalesce(reason, '') not in (${list(NOT_THE_CONNECTIONS_FAULT)})
             and created_at > now() - interval '24 hours'
        `)) as unknown as Row[]
        const [success] = (await tx.execute(sql`
          select created_at
            from identity.events
           where tenant_id = ${tenantId}::uuid
             and connection_id = ${connectionId}::uuid
             and type = ${SUCCESS_TYPE}
           order by created_at desc
           limit 1
        `)) as unknown as Row[]
        return {
          lastSuccessAt: success ? new Date(success.created_at as string | Date) : null,
          failuresLast15Minutes: Number(failures?.f15 ?? 0),
          failuresLastHour: Number(failures?.f1h ?? 0),
          failuresLast24Hours: Number(failures?.f24h ?? 0),
        }
      })
    },

    async claimAlert(
      tenantId,
      target,
      snapshot,
      everyMs,
      eventType = FAILURE_ALERT_TYPE,
    ) {
      const connId = typeof target === "string" ? target : target.connectionId
      const dirId = typeof target === "object" ? target.directoryId : undefined
      const lockKey = dirId
        ? `sso-directory-alert:${dirId}`
        : `sso-failure-alert:${connId}`
      return withTenant(db, tenantId, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
        )
        const [recent] = (connId
          ? await tx.execute(sql`
                select 1 as one
                  from identity.events
                 where tenant_id = ${tenantId}::uuid
                   and connection_id = ${connId}::uuid
                   and type = ${eventType}
                   and created_at > now() - ${`${Math.ceil(everyMs / 1000)} seconds`}::interval
                 limit 1
              `)
          : await tx.execute(sql`
                select 1 as one
                  from identity.events
                 where tenant_id = ${tenantId}::uuid
                   and type = ${eventType}
                   and data->>'directoryId' = ${dirId}
                   and created_at > now() - ${`${Math.ceil(everyMs / 1000)} seconds`}::interval
                 limit 1
              `)) as unknown as Row[]
        if (recent) return false
        await tx.insert(events).values({
          tenantId,
          type: eventType,
          connectionId: connId ?? null,
          data: { ...snapshot, ...(dirId ? { directoryId: dirId } : {}) },
        })
        return true
      })
    },
  }
}
