import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { withTenant, type Database } from "../../db/client.js"
import {
  contacts,
  contactTopics,
  segmentContacts,
  segments,
  topics,
} from "../../db/core.js"
import type { MarketingStore } from "./types.js"

/**
 * The two ways contacts are grouped: segments, which we put people into, and
 * topics, which people put themselves into.
 *
 * ⚠ A TOPIC'S SUBSCRIBER COUNT IS NOT `count(*) WHERE subscribed`, AND THE
 * DEFAULT IS WHY. On an opt-in topic a contact with no row IS unsubscribed; on
 * an opt-out topic the same absent row means subscribed. Counting only the
 * explicit rows reports a new opt-out topic as having no subscribers while a
 * broadcast to it reaches everybody.
 */
export function segmentsStore(
  db: Database,
): Pick<MarketingStore, "listSegments" | "createSegment" | "updateSegment" | "deleteSegments" | "addToSegment" | "removeFromSegment" | "listTopics" | "createTopic" | "updateTopic" | "deleteTopic" | "setTopicSubscription"> {
  return {
    // ── Segments ────────────────────────────────────────────────────────────

    async listSegments(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        // ⚠ A CORRELATED SUBQUERY, NOT A JOIN WITH GROUP BY. An empty segment
        // must still appear — it is the state every segment starts in, and the
        // empty one is what somebody just made and is looking for.
        const rows = await tx
          .select({
            id: segments.id,
            name: segments.name,
            description: segments.description,
            createdAt: segments.createdAt,
            contactCount: sql<number>`(
              select count(*)::int from core.segment_contacts sc
               where sc.segment_id = ${segments.id}
            )`,
          })
          .from(segments)
          .orderBy(desc(segments.createdAt))

        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          contact_count: r.contactCount,
          created_at: r.createdAt.toISOString(),
        }))
      })
    },

    async createSegment(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .insert(segments)
          .values({
            tenantId,
            name: input.name.trim(),
            description: input.description ?? null,
          })
          .returning()

        if (!row) throw new Error("insert returned nothing")
        return {
          id: row.id,
          name: row.name,
          description: row.description,
          contact_count: 0,
          created_at: row.createdAt.toISOString(),
        }
      })
    },

    async updateSegment(tenantId, id, patch) {
      return withTenant(db, tenantId, async (tx) => {
        const set: Record<string, unknown> = { updatedAt: new Date() }
        if (patch.name !== undefined) set.name = patch.name.trim()
        if (patch.description !== undefined) set.description = patch.description

        const updated = await tx
          .update(segments)
          .set(set)
          .where(eq(segments.id, id))
          .returning({ id: segments.id })
        return updated.length > 0
      })
    },

    async deleteSegments(tenantId, ids) {
      if (ids.length === 0) return 0
      return withTenant(db, tenantId, async (tx) => {
        const deleted = await tx
          .delete(segments)
          .where(inArray(segments.id, ids))
          .returning({ id: segments.id })
        return deleted.length
      })
    },

    async addToSegment(tenantId, segmentId, contactIds) {
      return withTenant(db, tenantId, async (tx) => {
        /*
         * ⚠ BOTH SIDES ARE RE-READ UNDER RLS BEFORE ANYTHING IS WRITTEN, AND
         * THE FOREIGN KEYS DO NOT MAKE THAT REDUNDANT. A Postgres FK check runs
         * as the REFERENCED TABLE'S OWNER and is explicitly exempt from row
         * security — that is what makes FKs work at all under RLS — so
         * `segment_contacts(segment_id) REFERENCES segments(id)` is satisfied by
         * ANY segment in the cluster, including another tenant's. The row that
         * results carries OUR `tenant_id`, so our own policy hides nothing from
         * us and nothing from them; what it creates is a link from our workspace
         * into someone else's rows, and a `DELETE` of their contact that
         * cascades into our segment.
         *
         * These two selects run inside `withTenant`, so they can only see this
         * tenant's rows. Anything the caller sent that is not ours simply is not
         * in the result, and is never written.
         */
        const [segment] = await tx
          .select({ id: segments.id })
          .from(segments)
          .where(eq(segments.id, segmentId))
          .limit(1)
        if (!segment) return null

        // ⚠ THE EMPTY CASE IS ANSWERED AFTER THE SEGMENT IS CHECKED, NOT BEFORE.
        // Returning early meant an empty list reported `0` — "the segment is
        // real and nobody was added" — for a segment that does not exist. The
        // route rejects an empty list with a 422 before reaching here, so this
        // is unreachable today; it is ordered correctly so that it stays right
        // if that guard ever moves.
        if (contactIds.length === 0) return 0

        const own = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(inArray(contacts.id, contactIds))
        if (own.length === 0) return 0

        const written = await tx
          .insert(segmentContacts)
          .values(own.map((c) => ({ tenantId, segmentId, contactId: c.id })))
          // Adding somebody who is already in the segment is not an error; it
          // is a person clicking a button twice.
          .onConflictDoNothing()
          .returning({ contactId: segmentContacts.contactId })
        return written.length
      })
    },

    async removeFromSegment(tenantId, segmentId, contactIds) {
      if (contactIds.length === 0) return 0
      return withTenant(db, tenantId, async (tx) => {
        const removed = await tx
          .delete(segmentContacts)
          .where(
            and(
              eq(segmentContacts.segmentId, segmentId),
              inArray(segmentContacts.contactId, contactIds),
            ),
          )
          .returning({ contactId: segmentContacts.contactId })
        return removed.length
      })
    },

    // ── Topics ──────────────────────────────────────────────────────────────

    async listTopics(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        /*
         * ⚠ THE SUBSCRIBER COUNT HAS TO ACCOUNT FOR THE DEFAULT, WHICH IS WHY
         * IT IS NOT `count(*) WHERE subscribed`. On an opt-in topic, a contact
         * with no row IS subscribed — so the count is "everybody, minus those
         * who explicitly said no". On an opt-out topic it is the opposite.
         * Counting only the explicit rows would report a brand-new opt-in topic
         * as having zero subscribers while a broadcast to it reaches everyone.
         */
        const rows = await tx
          .select({
            id: topics.id,
            name: topics.name,
            description: topics.description,
            defaultSubscription: topics.defaultSubscription,
            visibility: topics.visibility,
            createdAt: topics.createdAt,
            subscriberCount: sql<number>`(
              case when ${topics.defaultSubscription} = 'opt_in' then (
                select count(*)::int from core.contacts c
                 where not c.unsubscribed
                   and not exists (
                     select 1 from core.contact_topics ct
                      where ct.contact_id = c.id
                        and ct.topic_id = ${topics.id}
                        and ct.subscribed = false
                   )
              ) else (
                select count(*)::int from core.contact_topics ct
                 join core.contacts c on c.id = ct.contact_id
                 where ct.topic_id = ${topics.id}
                   and ct.subscribed
                   and not c.unsubscribed
              ) end
            )`,
          })
          .from(topics)
          .orderBy(topics.name)

        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          default_subscription: r.defaultSubscription,
          visibility: r.visibility,
          subscriber_count: r.subscriberCount,
          created_at: r.createdAt.toISOString(),
        }))
      })
    },

    async createTopic(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .insert(topics)
          .values({
            tenantId,
            name: input.name.trim(),
            description: input.description ?? null,
            defaultSubscription: input.defaultSubscription,
            visibility: input.visibility,
          })
          .returning()

        if (!row) throw new Error("insert returned nothing")
        return {
          id: row.id,
          name: row.name,
          description: row.description,
          default_subscription: row.defaultSubscription,
          visibility: row.visibility,
          subscriber_count: 0,
          created_at: row.createdAt.toISOString(),
        }
      })
    },

    async updateTopic(tenantId, id, patch) {
      return withTenant(db, tenantId, async (tx) => {
        const set: Record<string, unknown> = { updatedAt: new Date() }
        if (patch.name !== undefined) set.name = patch.name.trim()
        if (patch.description !== undefined) set.description = patch.description
        if (patch.visibility !== undefined) set.visibility = patch.visibility
        /*
         * ⚠ `default_subscription` IS NOT PATCHABLE AND IS NOT AN OVERSIGHT.
         * Flipping a topic from opt-out to opt-in retroactively subscribes every
         * contact who simply never answered — which is sending marketing mail to
         * people who did not ask for it, at scale, because of a dropdown. The
         * column is set once, at creation, and the UI disables the control on an
         * existing topic and says why.
         */

        const updated = await tx
          .update(topics)
          .set(set)
          .where(eq(topics.id, id))
          .returning({ id: topics.id })
        return updated.length > 0
      })
    },

    async deleteTopic(tenantId, id) {
      return withTenant(db, tenantId, async (tx) => {
        const deleted = await tx
          .delete(topics)
          .where(eq(topics.id, id))
          .returning({ id: topics.id })
        return deleted.length > 0
      })
    },

    async setTopicSubscription(tenantId, contactId, topicId, subscribed) {
      return withTenant(db, tenantId, async (tx) => {
        // ⚠ BOTH IDS VERIFIED UNDER RLS FIRST — an FK check bypasses row
        // security by design, so it would accept another tenant's topic. See
        // `addToSegment`, which states the whole reasoning.
        const [contact] = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(eq(contacts.id, contactId))
          .limit(1)
        if (!contact) return false

        const [topic] = await tx
          .select({ id: topics.id })
          .from(topics)
          .where(eq(topics.id, topicId))
          .limit(1)
        if (!topic) return false

        await tx
          .insert(contactTopics)
          .values({ tenantId, contactId, topicId, subscribed })
          .onConflictDoUpdate({
            target: [contactTopics.contactId, contactTopics.topicId],
            set: { subscribed, updatedAt: new Date() },
          })
        return true
      })
    },
  }
}
