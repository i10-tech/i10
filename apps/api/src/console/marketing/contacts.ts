import { and, desc, eq, getTableColumns, inArray, sql, type SQL } from "drizzle-orm"
import { withTenant, type Database } from "../../db/client.js"
import {
  contactProperties,
  contacts,
  contactTopics,
  segmentContacts,
  segments,
  topics,
} from "../../db/core.js"
import { clampLimit, decodeCursor, encodeCursor, escapeLike } from "../queries.js"
import type { MarketingStore } from "./types.js"
import { toContactRow } from "./shared.js"
import { parseContactCsv } from "./csv.js"

/**
 * Contacts, and the properties that describe them.
 *
 * ⚠ NOTHING HERE EVER RE-SUBSCRIBES SOMEBODY, and the one line that enforces it
 * is the `onConflictDoUpdate` in `upsertContact` that deliberately omits
 * `unsubscribed`. Re-adding a contact by hand, or re-importing last quarter's
 * CSV, must not undo an opt-out: their choice outlives our imports.
 */
export function contactsStore(
  db: Database,
): Pick<
  MarketingStore,
  | "listContacts"
  | "getContact"
  | "upsertContact"
  | "updateContact"
  | "deleteContacts"
  | "importContacts"
  | "listProperties"
  | "createProperty"
  | "deleteProperty"
> {
  return {
    // ── Contacts ────────────────────────────────────────────────────────────

    async listContacts(tenantId, opts) {
      const limit = clampLimit(opts.limit)
      const cursor = decodeCursor(opts.cursor)

      return withTenant(db, tenantId, async (tx) => {
        const where: SQL[] = []

        if (opts.search) {
          const pattern = `%${escapeLike(opts.search)}%`
          where.push(
            sql`(${contacts.email} ilike ${pattern}
                 or coalesce(${contacts.firstName}, '') ilike ${pattern}
                 or coalesce(${contacts.lastName}, '') ilike ${pattern})`,
          )
        }

        if (opts.segmentId) {
          /*
           * ⚠ `EXISTS`, NOT A JOIN. A join to `segment_contacts` would multiply
           * the result if the contact were ever in the segment twice — which
           * the primary key prevents today and which a future "add with a
           * label" feature would not. `EXISTS` is a semi-join and cannot
           * duplicate a row regardless.
           */
          where.push(
            sql`exists (
              select 1 from core.segment_contacts sc
               where sc.contact_id = ${contacts.id}
                 and sc.segment_id = ${opts.segmentId}::uuid
            )`,
          )
        }

        if (cursor) {
          where.push(
            sql`(${contacts.createdAt}, ${contacts.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
          )
        }

        const rows = await tx
          .select({
            contact: contacts,
            // See `rawTimestamp` in queries.ts: a `Date` loses the microseconds
            // the cursor needs, so the column is selected a second time as text.
            createdAtRaw: sql<string>`${contacts.createdAt}::text`,
          })
          .from(contacts)
          .where(where.length ? and(...where) : undefined)
          .orderBy(desc(contacts.createdAt), desc(contacts.id))
          .limit(limit + 1)

        const hasMore = rows.length > limit
        const page = hasMore ? rows.slice(0, limit) : rows
        const last = page[page.length - 1]

        return {
          data: page.map((row) => toContactRow(row.contact)),
          nextCursor:
            hasMore && last ? encodeCursor(last.createdAtRaw, last.contact.id) : null,
        }
      })
    },

    async getContact(tenantId, id) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(contacts)
          .where(eq(contacts.id, id))
          .limit(1)
        const contact = rows[0]
        if (!contact) return null

        const [memberships, prefs] = await Promise.all([
          tx
            .select({ id: segments.id, name: segments.name })
            .from(segmentContacts)
            .innerJoin(segments, eq(segments.id, segmentContacts.segmentId))
            .where(eq(segmentContacts.contactId, id)),

          /*
           * ⚠ EVERY TOPIC, LEFT-JOINED TO THIS CONTACT'S ANSWER — not only the
           * topics they have answered. A preference page that showed just the
           * rows in `contact_topics` would hide every topic somebody has never
           * touched, which is all of them for a new contact. The effective
           * value falls back to the topic's own default, and that fallback is
           * computed here so the console and the send path cannot disagree
           * about it.
           */
          tx
            .select({
              id: topics.id,
              name: topics.name,
              defaultSubscription: topics.defaultSubscription,
              subscribed: contactTopics.subscribed,
            })
            .from(topics)
            .leftJoin(
              contactTopics,
              and(
                eq(contactTopics.topicId, topics.id),
                eq(contactTopics.contactId, id),
              ),
            )
            .orderBy(topics.name),
        ])

        return {
          ...toContactRow(contact),
          segments: memberships,
          topics: prefs.map((t) => ({
            id: t.id,
            name: t.name,
            subscribed: t.subscribed ?? t.defaultSubscription === "opt_in",
          })),
        }
      })
    },

    async upsertContact(tenantId, input) {
      const email = input.email.trim().toLowerCase()

      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .insert(contacts)
          .values({
            tenantId,
            email,
            firstName: input.firstName ?? null,
            lastName: input.lastName ?? null,
            unsubscribed: input.unsubscribed ?? false,
            ...(input.unsubscribed ? { unsubscribedAt: new Date() } : {}),
            properties: input.properties ?? null,
          })
          .onConflictDoUpdate({
            target: [contacts.tenantId, contacts.email],
            /*
             * ⚠ `unsubscribed` IS DELIBERATELY ABSENT FROM THIS SET, AND THAT IS
             * THE MOST IMPORTANT LINE IN THE FILE. Re-adding a contact — by
             * hand, or by re-importing last quarter's CSV — must never
             * re-subscribe somebody who opted out. Their choice outlives our
             * imports. Changing it takes the explicit `updateContact` path,
             * which is a different act with a different button.
             *
             * ⚠ AND THE NAME FIELDS USE `coalesce(excluded, existing)` RATHER
             * THAN A PLAIN OVERWRITE, so an import whose file has no name column
             * does not blank out names somebody typed in by hand.
             */
            set: {
              firstName: sql`coalesce(excluded.first_name, ${contacts.firstName})`,
              lastName: sql`coalesce(excluded.last_name, ${contacts.lastName})`,
              properties: sql`coalesce(${contacts.properties}, '{}'::jsonb) || coalesce(excluded.properties, '{}'::jsonb)`,
              updatedAt: new Date(),
            },
          })
          /*
           * ⚠ `xmax = 0` IS HOW POSTGRES ANSWERS "DID THIS INSERT OR UPDATE".
           * A freshly inserted tuple has no deleting transaction, so its `xmax`
           * is zero; a tuple produced by the DO UPDATE branch carries a non-zero
           * one from the speculative-insertion lock. It is evaluated on the
           * RETURNING row of this statement, so it cannot race with anything
           * else in the transaction.
           *
           * ⚠ IT READS AN IMPLEMENTATION DETAIL RATHER THAN A DOCUMENTED API,
           * AND IT DRIVES NOTHING MORE THAN A STATUS CODE — WHICH IS THE REASON
           * IT IS ACCEPTABLE HERE. `xmax` is a system column whose meaning is
           * not part of Postgres's compatibility promise, so the honest bound on
           * this is: if a future release changed it, `POST /contacts` would
           * answer 200 where 201 belonged for a contact that was genuinely
           * created. Nothing branches on that but a cache and a reader. If this
           * ever has to be exact, the deterministic form is a CTE — `INSERT …
           * ON CONFLICT DO NOTHING RETURNING *` beside an `UPDATE … WHERE NOT
           * EXISTS (SELECT 1 FROM ins)` — which costs a more complicated
           * statement to buy a guarantee this route does not need. There is no
           * local Postgres in this repo, so this has been reasoned about rather
           * than executed; it is the first thing to check on the first real run.
           */
          .returning({
            ...getTableColumns(contacts),
            inserted: sql<boolean>`(xmax = 0)`,
          })

        if (!row) throw new Error("upsert returned nothing")
        return { contact: toContactRow(row), created: row.inserted }
      })
    },

    async updateContact(tenantId, id, patch) {
      return withTenant(db, tenantId, async (tx) => {
        const set: Record<string, unknown> = { updatedAt: new Date() }
        if (patch.firstName !== undefined) set.firstName = patch.firstName
        if (patch.lastName !== undefined) set.lastName = patch.lastName
        if (patch.properties !== undefined) set.properties = patch.properties
        if (patch.unsubscribed !== undefined) {
          set.unsubscribed = patch.unsubscribed
          // ⚠ THE TIMESTAMP FOLLOWS THE FLAG IN BOTH DIRECTIONS. A stale
          // `unsubscribed_at` on a re-subscribed contact would make an audit of
          // "who opted out and when" report people who are currently subscribed.
          set.unsubscribedAt = patch.unsubscribed ? new Date() : null
        }

        const [row] = await tx
          .update(contacts)
          .set(set)
          .where(eq(contacts.id, id))
          .returning()

        return row ? toContactRow(row) : null
      })
    },

    async deleteContacts(tenantId, ids) {
      if (ids.length === 0) return 0
      return withTenant(db, tenantId, async (tx) => {
        const deleted = await tx
          .delete(contacts)
          .where(inArray(contacts.id, ids))
          .returning({ id: contacts.id })
        return deleted.length
      })
    },

    async importContacts(tenantId, csv) {
      const parsed = parseContactCsv(csv)
      if (parsed.rows.length === 0) {
        return { parsed: 0, created: 0, updated: 0, invalid: parsed.invalid }
      }

      return withTenant(db, tenantId, async (tx) => {
        /*
         * ⚠ CHUNKED, BECAUSE POSTGRES BINDS AT MOST 65535 PARAMETERS PER
         * STATEMENT. Six bound values per row puts the ceiling around ten
         * thousand; 500 leaves an order of magnitude of headroom and still
         * turns a 50,000-row file into a hundred statements rather than fifty
         * thousand.
         */
        const CHUNK = 500
        let created = 0

        for (let i = 0; i < parsed.rows.length; i += CHUNK) {
          const slice = parsed.rows.slice(i, i + CHUNK)
          const written = await tx
            .insert(contacts)
            .values(
              slice.map((r) => ({
                tenantId,
                email: r.email,
                firstName: r.firstName,
                lastName: r.lastName,
                properties: r.properties,
              })),
            )
            .onConflictDoUpdate({
              target: [contacts.tenantId, contacts.email],
              // Same rule as `upsertContact`: an import never resubscribes.
              set: {
                firstName: sql`coalesce(excluded.first_name, ${contacts.firstName})`,
                lastName: sql`coalesce(excluded.last_name, ${contacts.lastName})`,
                properties: sql`coalesce(${contacts.properties}, '{}'::jsonb) || coalesce(excluded.properties, '{}'::jsonb)`,
                updatedAt: new Date(),
              },
            })
            /*
             * ⚠ `xmax = 0` IS HOW POSTGRES TELLS YOU AN UPSERT INSERTED RATHER
             * THAN UPDATED. The system column is zero on a freshly inserted
             * tuple and non-zero on one that an update superseded. Without it
             * an upsert can only report "n rows touched", and the import
             * summary cannot tell somebody whether they added 400 people or
             * re-imported the same 400.
             */
            .returning({ inserted: sql<boolean>`(xmax = 0)` })

          created += written.filter((w) => w.inserted).length
        }

        return {
          parsed: parsed.rows.length,
          created,
          updated: parsed.rows.length - created,
          invalid: parsed.invalid,
        }
      })
    },

    // ── Properties ──────────────────────────────────────────────────────────

    async listProperties(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(contactProperties)
          .orderBy(contactProperties.key)
        return rows.map((r) => ({
          id: r.id,
          key: r.key,
          type: r.type,
          fallback_value: r.fallbackValue,
          created_at: r.createdAt.toISOString(),
        }))
      })
    },

    async createProperty(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .insert(contactProperties)
          .values({
            tenantId,
            key: input.key,
            type: input.type as "string" | "number" | "boolean",
            fallbackValue: input.fallbackValue ?? null,
          })
          .onConflictDoNothing({
            target: [contactProperties.tenantId, contactProperties.key],
          })
          .returning()

        return row
          ? {
              id: row.id,
              key: row.key,
              type: row.type,
              fallback_value: row.fallbackValue,
              created_at: row.createdAt.toISOString(),
            }
          : { conflict: true as const }
      })
    },

    async deleteProperty(tenantId, id) {
      return withTenant(db, tenantId, async (tx) => {
        /*
         * ⚠ THE DECLARATION IS DELETED; THE VALUES ON EVERY CONTACT ARE NOT.
         * Stripping the key out of every `contacts.properties` bag would be an
         * unbounded UPDATE over the whole table triggered by a click, and it
         * would destroy data that a re-created property would otherwise still
         * find. The orphaned values are inert — nothing reads a key with no
         * declaration — and re-creating the property brings them back.
         */
        const deleted = await tx
          .delete(contactProperties)
          .where(eq(contactProperties.id, id))
          .returning({ id: contactProperties.id })
        return deleted.length > 0
      })
    },
  }
}
