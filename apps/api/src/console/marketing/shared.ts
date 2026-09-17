import { and, eq, sql } from "drizzle-orm"
import { type Database } from "../../db/client.js"
import {
  broadcasts,
  contacts,
  messageEvents,
  messages,
  templates,
} from "../../db/core.js"
import type { BroadcastRow, BroadcastStats, ContactRow, TemplateRow } from "./types.js"

/**
 * What the four store modules have in common: the row mappers that turn a
 * Drizzle row into the wire shape, and the one aggregate two of them need.
 *
 * ⚠ THE MAPPERS ARE SHARED SO THAT ONE COLUMN RENAME IS ONE EDIT. A contact is
 * returned by six routes; six copies of `first_name: row.firstName` is six
 * places for a rename to be half-applied, and the half that is missed returns
 * `undefined` rather than failing.
 *
 * ⚠ AND `LIST_CAP` LIVES HERE FOR THE SAME REASON THE MAPPERS DO: two modules
 * bound their lists with it, and a ceiling that differs between them is a
 * ceiling nobody can state.
 */

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

export async function broadcastStats(
  tx: Tx,
  broadcastId: string,
  since: Date,
): Promise<BroadcastStats> {
  // ⚠ THE LOWER BOUND PRUNES BOTH PARTITIONED TABLES. A message cannot predate
  // its broadcast and an event cannot predate its message, so the broadcast's
  // own creation time minus an hour of slack excludes every older partition and
  // excludes nothing real.
  const floor = new Date(since.getTime() - 3_600_000)

  const rows = await tx
    .select({
      total: sql<number>`count(distinct ${messages.id})::int`,
      delivered: sql<number>`count(distinct ${messages.id}) filter (where ${messageEvents.type} = 'delivered')::int`,
      bounced: sql<number>`count(distinct ${messages.id}) filter (where ${messageEvents.type} = 'bounced')::int`,
      complained: sql<number>`count(distinct ${messages.id}) filter (where ${messageEvents.type} = 'complained')::int`,
      failed: sql<number>`count(distinct ${messages.id}) filter (where ${messageEvents.type} in ('failed','rejected'))::int`,
    })
    .from(messages)
    .leftJoin(
      messageEvents,
      and(
        eq(messageEvents.messageId, messages.id),
        sql`${messageEvents.occurredAt} >= ${floor}`,
      ),
    )
    .where(
      and(
        eq(messages.broadcastId, broadcastId),
        sql`${messages.createdAt} >= ${floor}`,
      ),
    )

  return rows[0] ?? { total: 0, delivered: 0, bounced: 0, complained: 0, failed: 0 }
}

export function toContactRow(row: typeof contacts.$inferSelect): ContactRow {
  return {
    id: row.id,
    email: row.email,
    first_name: row.firstName,
    last_name: row.lastName,
    unsubscribed: row.unsubscribed,
    properties: row.properties ?? null,
    created_at: row.createdAt.toISOString(),
  }
}

export function toBroadcastRow(
  row: typeof broadcasts.$inferSelect,
  segmentName: string | null,
): BroadcastRow {
  return {
    id: row.id,
    segment_id: row.segmentId,
    segment_name: segmentName,
    topic_id: row.topicId,
    name: row.name,
    from: row.fromAddress,
    reply_to: row.replyTo,
    subject: row.subject,
    preview_text: row.previewText,
    html: row.html,
    text: row.text,
    status: row.status,
    scheduled_at: row.scheduledAt?.toISOString() ?? null,
    sent_at: row.sentAt?.toISOString() ?? null,
    recipient_count: row.recipientCount,
    created_at: row.createdAt.toISOString(),
  }
}

export function toTemplateRow(row: typeof templates.$inferSelect): TemplateRow {
  return {
    id: row.id,
    name: row.name,
    folder: row.folder,
    subject: row.subject,
    html: row.html,
    text: row.text,
    published_at: row.publishedAt?.toISOString() ?? null,
    version: row.version,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

/**
 * The most rows either of the two editorial lists will return.
 *
 * ⚠ A CEILING RATHER THAN A CURSOR, AND THE ASYMMETRY WITH THE EMAIL LOG IS
 * DELIBERATE. `core.messages` grows without bound at machine speed, so it has
 * to be paginated; broadcasts and templates are written by hand, and a
 * workspace reaching two hundred of either has a filing problem before it has
 * a pagination problem. What matters is that the query CANNOT return an
 * unbounded result set — an account that somehow has ten thousand templates
 * must not be able to take the console down by opening a page. When somebody
 * genuinely hits this, the fix is a cursor like the log's, not a bigger number.
 */
export const LIST_CAP = 200
