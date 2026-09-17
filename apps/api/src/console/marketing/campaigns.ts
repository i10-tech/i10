import { and, desc, eq, sql } from "drizzle-orm"
import { withTenant, type Database } from "../../db/client.js"
import { broadcasts, segments, templates, topics } from "../../db/core.js"
import type { MarketingStore } from "./types.js"
import type { Tx } from "./shared.js"
import { LIST_CAP, broadcastStats, toBroadcastRow, toTemplateRow } from "./shared.js"

/**
 * Broadcasts and the templates they are written from.
 *
 * ⚠ READING A LIST NEVER READS A BODY. A broadcast's `html` is a whole
 * marketing email, and the list pages render a name and a status — see
 * `BroadcastSummary`. The bodies come back only from the single-row reads.
 */
export function campaignsStore(
  db: Database,
): Pick<
  MarketingStore,
  | "listBroadcasts"
  | "getBroadcast"
  | "createBroadcast"
  | "updateBroadcast"
  | "deleteBroadcast"
  | "listTemplates"
  | "getTemplate"
  | "createTemplate"
  | "updateTemplate"
  | "publishTemplate"
  | "deleteTemplate"
> {
  /**
   * Refuses a `segment_id` or `topic_id` that is not this workspace's.
   *
   * ⚠ A FOREIGN KEY DOES NOT DO THIS, AND THAT IS THE WHOLE REASON THIS
   * EXISTS. A Postgres FK check runs as the REFERENCED table's owner and is
   * explicitly exempt from row security — that exemption is what makes FKs work
   * under RLS at all — so `broadcasts.segment_id REFERENCES segments(id)` is
   * satisfied by ANY segment in the cluster, including another tenant's. The
   * resulting row carries OUR `tenant_id` and points into somebody else's data:
   * at minimum an existence oracle for their ids, and at worst a broadcast
   * whose recipient list is not ours to send to.
   *
   * ⚠ IT IS THE SAME RULE `addToSegment` AND `setTopicSubscription` FOLLOW, and
   * it was missing here — which is the argument for it being a named helper
   * rather than three inline selects. Every write of one of these two columns
   * goes through it.
   *
   * ⚠ AND `null` IS ALWAYS ALLOWED. Clearing the segment means "send to
   * everybody", which is a real edit and references nothing.
   */
  async function assertOwned(
    tx: Tx,
    ids: { segmentId?: string | null; topicId?: string | null },
  ): Promise<{ ok: true } | { ok: false; field: "segment_id" | "topic_id" }> {
    if (typeof ids.segmentId === "string") {
      const [found] = await tx
        .select({ id: segments.id })
        .from(segments)
        .where(eq(segments.id, ids.segmentId))
        .limit(1)
      if (!found) return { ok: false, field: "segment_id" }
    }

    if (typeof ids.topicId === "string") {
      const [found] = await tx
        .select({ id: topics.id })
        .from(topics)
        .where(eq(topics.id, ids.topicId))
        .limit(1)
      if (!found) return { ok: false, field: "topic_id" }
    }

    return { ok: true }
  }

  return {
    // ── Broadcasts ──────────────────────────────────────────────────────────

    async listBroadcasts(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        /*
         * ⚠ COLUMNS NAMED EXPLICITLY, WITH `html` AND `text` LEFT OUT. A
         * `select()` here reads the bodies out of the heap for every row — the
         * bytes leave the database, cross the wire and are then discarded by a
         * list page that renders a name and a status.
         */
        const rows = await tx
          .select({
            id: broadcasts.id,
            segmentId: broadcasts.segmentId,
            topicId: broadcasts.topicId,
            name: broadcasts.name,
            fromAddress: broadcasts.fromAddress,
            replyTo: broadcasts.replyTo,
            subject: broadcasts.subject,
            previewText: broadcasts.previewText,
            status: broadcasts.status,
            scheduledAt: broadcasts.scheduledAt,
            sentAt: broadcasts.sentAt,
            recipientCount: broadcasts.recipientCount,
            createdAt: broadcasts.createdAt,
            segmentName: segments.name,
          })
          .from(broadcasts)
          .leftJoin(segments, eq(segments.id, broadcasts.segmentId))
          .orderBy(desc(broadcasts.createdAt))
          .limit(LIST_CAP)

        return rows.map((r) => ({
          id: r.id,
          segment_id: r.segmentId,
          segment_name: r.segmentName,
          topic_id: r.topicId,
          name: r.name,
          from: r.fromAddress,
          reply_to: r.replyTo,
          subject: r.subject,
          preview_text: r.previewText,
          status: r.status,
          scheduled_at: r.scheduledAt?.toISOString() ?? null,
          sent_at: r.sentAt?.toISOString() ?? null,
          recipient_count: r.recipientCount,
          created_at: r.createdAt.toISOString(),
        }))
      })
    },

    async getBroadcast(tenantId, id) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select({ b: broadcasts, segmentName: segments.name })
          .from(broadcasts)
          .leftJoin(segments, eq(segments.id, broadcasts.segmentId))
          .where(eq(broadcasts.id, id))
          .limit(1)

        const found = rows[0]
        if (!found) return null

        /*
         * ⚠ THE STATS QUERY IS SKIPPED ENTIRELY FOR A DRAFT. A draft has no
         * messages by definition, so the aggregate would scan every partition of
         * `core.messages` looking for a broadcast id that appears nowhere — the
         * most expensive possible way to compute five zeroes, on the page
         * somebody has open while they write.
         */
        const stats =
          found.b.status === "draft"
            ? { total: 0, delivered: 0, bounced: 0, complained: 0, failed: 0 }
            : await broadcastStats(tx, found.b.id, found.b.createdAt)

        return { ...toBroadcastRow(found.b, found.segmentName), stats }
      })
    },

    async createBroadcast(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        // ⚠ BOTH FKs VERIFIED UNDER RLS BEFORE THE INSERT — see `assertOwned`.
        const owned = await assertOwned(tx, input)
        if (!owned.ok) return { unknown: owned.field }

        const [row] = await tx
          .insert(broadcasts)
          .values({
            tenantId,
            segmentId: input.segmentId ?? null,
            topicId: input.topicId ?? null,
            name: input.name,
            fromAddress: input.from ?? "",
            replyTo: input.replyTo ?? [],
            subject: input.subject ?? "",
            previewText: input.previewText ?? null,
            html: input.html ?? null,
            text: input.text ?? null,
            scheduledAt: input.scheduledAt ?? null,
          })
          .returning()

        if (!row) throw new Error("insert returned nothing")
        return toBroadcastRow(row, null)
      })
    },

    async updateBroadcast(tenantId, id, patch) {
      return withTenant(db, tenantId, async (tx) => {
        // ⚠ THE SAME CHECK ON THE WAY IN — a PATCH can retarget a broadcast at
        // another tenant's segment exactly as a POST can.
        const owned = await assertOwned(tx, patch)
        if (!owned.ok) return { unknown: owned.field }

        const set: Record<string, unknown> = { updatedAt: new Date() }
        if (patch.segmentId !== undefined) set.segmentId = patch.segmentId
        if (patch.topicId !== undefined) set.topicId = patch.topicId
        if (patch.name !== undefined) set.name = patch.name
        if (patch.from !== undefined) set.fromAddress = patch.from
        if (patch.replyTo !== undefined) set.replyTo = patch.replyTo
        if (patch.subject !== undefined) set.subject = patch.subject
        if (patch.previewText !== undefined) set.previewText = patch.previewText
        if (patch.html !== undefined) set.html = patch.html
        if (patch.text !== undefined) set.text = patch.text
        if (patch.scheduledAt !== undefined) set.scheduledAt = patch.scheduledAt

        const [row] = await tx
          .update(broadcasts)
          .set(set)
          /*
           * ⚠ THE STATUS GUARD IS IN THE `WHERE`, NOT IN A READ-THEN-WRITE.
           * Editing the subject of a broadcast that is half-way through fan-out
           * would send two different emails under one name, and the record of
           * what was sent would match neither. Putting the check in the
           * predicate means two concurrent editors cannot both pass it and then
           * both write.
           */
          .where(
            and(
              eq(broadcasts.id, id),
              sql`${broadcasts.status} in ('draft', 'scheduled')`,
            ),
          )
          .returning()

        return row ? toBroadcastRow(row, null) : null
      })
    },

    async deleteBroadcast(tenantId, id) {
      return withTenant(db, tenantId, async (tx) => {
        const deleted = await tx
          .delete(broadcasts)
          .where(
            and(
              eq(broadcasts.id, id),
              // ⚠ A SENT BROADCAST IS A RECORD AND IS NOT DELETABLE. Somebody
              // will ask why they received an email; the answer has to still
              // exist. Drafts and cancelled ones are fair game.
              sql`${broadcasts.status} in ('draft', 'scheduled', 'canceled')`,
            ),
          )
          .returning({ id: broadcasts.id })
        return deleted.length > 0
      })
    },

    // ── Templates ───────────────────────────────────────────────────────────

    async listTemplates(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        // ⚠ NO `html`, NO `text`, AND A CEILING — see `listBroadcasts` above.
        const rows = await tx
          .select({
            id: templates.id,
            name: templates.name,
            folder: templates.folder,
            subject: templates.subject,
            publishedAt: templates.publishedAt,
            version: templates.version,
            createdAt: templates.createdAt,
            updatedAt: templates.updatedAt,
          })
          .from(templates)
          .orderBy(templates.folder, templates.name)
          .limit(LIST_CAP)

        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          folder: r.folder,
          subject: r.subject,
          published_at: r.publishedAt?.toISOString() ?? null,
          version: r.version,
          created_at: r.createdAt.toISOString(),
          updated_at: r.updatedAt.toISOString(),
        }))
      })
    },

    async getTemplate(tenantId, id) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(templates)
          .where(eq(templates.id, id))
          .limit(1)
        return rows[0] ? toTemplateRow(rows[0]) : null
      })
    },

    async createTemplate(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .insert(templates)
          .values({
            tenantId,
            name: input.name.trim(),
            folder: input.folder ?? null,
          })
          .onConflictDoNothing({ target: [templates.tenantId, templates.name] })
          .returning()

        return row ? toTemplateRow(row) : { conflict: true as const }
      })
    },

    async updateTemplate(tenantId, id, patch) {
      return withTenant(db, tenantId, async (tx) => {
        const set: Record<string, unknown> = { updatedAt: new Date() }
        if (patch.name !== undefined) set.name = patch.name.trim()
        if (patch.folder !== undefined) set.folder = patch.folder
        if (patch.subject !== undefined) set.subject = patch.subject
        if (patch.html !== undefined) set.html = patch.html
        if (patch.text !== undefined) set.text = patch.text

        const [row] = await tx
          .update(templates)
          .set(set)
          .where(eq(templates.id, id))
          .returning()
        return row ? toTemplateRow(row) : null
      })
    },

    async publishTemplate(tenantId, id) {
      return withTenant(db, tenantId, async (tx) => {
        /*
         * ⚠ THE COPY HAPPENS IN SQL, IN ONE STATEMENT, SO THERE IS NO WINDOW IN
         * WHICH THE PUBLISHED SUBJECT IS NEW AND THE PUBLISHED BODY IS OLD. A
         * read-then-write would have one, and a send landing inside it would go
         * out with mismatched halves of two versions.
         */
        const [row] = await tx
          .update(templates)
          .set({
            publishedHtml: sql`${templates.html}`,
            publishedText: sql`${templates.text}`,
            publishedSubject: sql`${templates.subject}`,
            publishedAt: new Date(),
            version: sql`${templates.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(templates.id, id))
          .returning()

        return row ? toTemplateRow(row) : null
      })
    },

    async deleteTemplate(tenantId, id) {
      return withTenant(db, tenantId, async (tx) => {
        const deleted = await tx
          .delete(templates)
          .where(eq(templates.id, id))
          .returning({ id: templates.id })
        return deleted.length > 0
      })
    },
  }
}
