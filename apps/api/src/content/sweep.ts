import { sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"

/**
 * Deletes one workspace's templates that nothing uses any more (#167, #169).
 *
 * The lifecycle of a template:
 *   1. The content job derives it from the workspace's own finished mail and
 *      compacts bodies against it: the static HTML once, values per message.
 *   2. While the workspace keeps sending mail that fits it, every match bumps
 *      `last_seen_at`, and only the values are stored.
 *   3. Retention deletes the old messages. Once no body - compacted, or only
 *      linked - references the template AND it has gone unseen for
 *      `staleDays`, this deletes it.
 *   4. THE WAY BACK: if the workspace starts sending that mail again, the
 *      content job finds the near-duplicates and derives the template anew,
 *      exactly as the first time. New mail keeps its full body until then, so
 *      nothing is ever lost in between.
 *
 * ⚠ BOTH CONDITIONS, NEVER ONE. A referenced template is the only copy of the
 * static half of every body compacted against it; deleting it loses mail
 * (`restoreBodies` throws, loudly). An unreferenced but recently seen one is
 * about to be used again, and deleting it only costs a re-derivation.
 *
 * ⚠ SAFE AGAINST A CONCURRENT CONTENT PASS. That pass bumps `last_seen_at` on
 * every template it links a body to, in the same transaction as the link, so
 * a template it is using is never stale here; and one this deleted first has
 * no row for its upsert to find, so it inserts a fresh one.
 */
export async function sweepTemplates(
  db: Database,
  tenantId: string,
  staleDays: number,
): Promise<number> {
  const gone = (await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`
      delete from core.content_templates t
       where t.tenant_id = ${tenantId}::uuid
         and t.last_seen_at < now() - make_interval(days => ${staleDays})
         and not exists (
           select 1 from core.message_bodies b
            where b.tenant_id = ${tenantId}::uuid and b.template_id = t.id
         )
      returning t.id
    `),
  )) as unknown as unknown[]
  return gone.length
}
