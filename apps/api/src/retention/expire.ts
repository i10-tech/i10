import { sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"

/**
 * Deletes one workspace's mail older than its plan keeps it
 * (docs/decisions/storage.md).
 *
 * ⚠ THE WHOLE MESSAGE, LIKE RESEND: its row, body, events and webhook
 * deliveries, in one statement per batch. Attachments and templates are not
 * deleted here; they are freed, because the body was their only reference,
 * and the sweeps take them next.
 *
 * ⚠ A TOMBSTONE PER MESSAGE, IN THE SAME STATEMENT. A complaint that arrives
 * after the message expired must still suppress its address; see
 * `core.expired_messages`.
 *
 * ⚠ BILLING IS UNTOUCHED. Usage is counted in `core.meter_events`, a separate
 * ledger this never deletes from, so "50 of 100 used today" stays 50 whatever
 * retention has done. The reconcile only looks back `RECONCILE_LOOKBACK_DAYS`,
 * which the caller keeps below every period.
 */
export interface ExpireDeps {
  db: Database
  batch: number
  /** Batches per workspace per run, so one huge backlog cannot hold the job. */
  maxBatches?: number
  now?: Date
}

export interface ExpireResult {
  messages: number
  /** Of which, still queued or sending: mail that never went out in time. */
  unsent: number
  bodies: number
  events: number
  deliveries: number
}

export async function expireTenant(
  tenantId: string,
  retentionDays: number,
  deps: ExpireDeps,
): Promise<ExpireResult> {
  const now = deps.now ?? new Date()
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString()
  const result: ExpireResult = {
    messages: 0,
    unsent: 0,
    bodies: 0,
    events: 0,
    deliveries: 0,
  }
  const maxBatches = deps.maxBatches ?? 50

  // ── Messages, with everything hanging off them ──
  for (let i = 0; i < maxBatches; i++) {
    const [row] = (await withTenant(deps.db, tenantId, (tx) =>
      tx.execute(sql`
        with doomed as (
          select id, created_at, status in ('queued', 'sending') as unsent
            from core.messages
           where tenant_id = ${tenantId}::uuid and created_at < ${cutoff}::timestamptz
           order by created_at
           limit ${deps.batch}
        ), tomb as (
          insert into core.expired_messages (message_id, tenant_id)
          select id, ${tenantId}::uuid from doomed
          on conflict (message_id) do nothing
        ), ev as (
          delete from core.message_events e using doomed d
           where e.tenant_id = ${tenantId}::uuid and e.message_id = d.id
          returning 1
        ), dl as (
          delete from core.webhook_deliveries w using doomed d
           where w.tenant_id = ${tenantId}::uuid and w.message_id = d.id
          returning 1
        ), bo as (
          delete from core.message_bodies b using doomed d
           where b.message_id = d.id and b.created_at = d.created_at
          returning 1
        ), me as (
          delete from core.messages m using doomed d
           where m.id = d.id and m.created_at = d.created_at
          returning 1
        )
        select (select count(*) from me)::int as messages,
               (select count(*) from doomed where unsent)::int as unsent,
               (select count(*) from bo)::int as bodies,
               (select count(*) from ev)::int as events,
               (select count(*) from dl)::int as deliveries
      `),
    )) as unknown as ExpireResult[]
    result.messages += row?.messages ?? 0
    result.unsent += row?.unsent ?? 0
    result.bodies += row?.bodies ?? 0
    result.events += row?.events ?? 0
    result.deliveries += row?.deliveries ?? 0
    if ((row?.messages ?? 0) < deps.batch) break
  }

  // ── Leftovers with no message row: a flush by hand, an old bug ──
  //
  // ⚠ SAFE BY TIME ALONE. An event happens after its message was created and a
  // delivery after its event, so none of these can belong to a message still
  // inside the period.
  for (let i = 0; i < maxBatches; i++) {
    const [row] = (await withTenant(deps.db, tenantId, (tx) =>
      tx.execute(sql`
        with bo as (
          delete from core.message_bodies b
           where (b.message_id, b.created_at) in (
             select message_id, created_at from core.message_bodies
              where tenant_id = ${tenantId}::uuid and created_at < ${cutoff}::timestamptz
              limit ${deps.batch})
          returning 1
        ), ev as (
          delete from core.message_events e
           where (e.id, e.occurred_at) in (
             select id, occurred_at from core.message_events
              where tenant_id = ${tenantId}::uuid and occurred_at < ${cutoff}::timestamptz
              limit ${deps.batch})
          returning 1
        ), dl as (
          delete from core.webhook_deliveries w
           where w.id in (
             select id from core.webhook_deliveries
              where tenant_id = ${tenantId}::uuid and created_at < ${cutoff}::timestamptz
              limit ${deps.batch})
          returning 1
        )
        select (select count(*) from bo)::int as bodies,
               (select count(*) from ev)::int as events,
               (select count(*) from dl)::int as deliveries
      `),
    )) as unknown as { bodies: number; events: number; deliveries: number }[]
    const n = (row?.bodies ?? 0) + (row?.events ?? 0) + (row?.deliveries ?? 0)
    result.bodies += row?.bodies ?? 0
    result.events += row?.events ?? 0
    result.deliveries += row?.deliveries ?? 0
    if (n === 0) break
  }

  return result
}
