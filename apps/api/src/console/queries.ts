import { and, desc, eq, gte, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import { withTenant, type Database } from "../db/client.js"
import {
  apiKeys,
  apiRequests,
  domains,
  messageBodies,
  messageEvents,
  messages,
  suppressions,
  webhookDeliveries,
  webhookEndpoints,
} from "../db/core.js"
import { lastEvent, PRUNE_WINDOW_MS } from "../send/lookup.js"
import { timestampFromUuidV7 } from "../ids.js"

/**
 * Everything the console reads that no other caller needs.
 *
 * ⚠ THIS IS A READ MODEL AND IT WRITES NOTHING. Every mutation the console
 * performs goes through the store that already owns it — `DomainStore` creates
 * domains, `KeyStore` mints keys, `WebhookEndpointStore` manages endpoints — so
 * there is exactly one implementation of each rule and the console cannot
 * accidentally bypass a plan limit by having its own path to the table. The two
 * exceptions are `suppressions` and `onboarding`, which have no other owner;
 * they are in this file because creating a store for a two-column table nobody
 * else touches would be ceremony.
 *
 * ⚠ AND EVERY QUERY IS INSIDE `withTenant`. `core` is under row level security
 * and a query without the setting RAISES rather than returning nothing — see
 * db/core.ts. That is the desired behaviour and it is also why a missing
 * wrapper is found immediately rather than in production as a cross-tenant
 * read.
 */

/**
 * ⚠ EVERY LIST ON THIS SURFACE IS KEYSET PAGINATED, NOT OFFSET PAGINATED, AND
 * ON `core.messages` THAT IS THE DIFFERENCE BETWEEN A PAGE AND A TIMEOUT.
 * `OFFSET 40000` makes Postgres produce and discard forty thousand rows from a
 * partitioned table on every request; a cursor is an index seek regardless of
 * depth. It is also the only form that is CORRECT while rows are arriving —
 * offset pagination on a descending log shows the same row twice and skips
 * another every time something is inserted between two page loads, which on a
 * live send log is constantly.
 */
export interface Page<T> {
  data: T[]
  /** Opaque. Pass back as `cursor` for the next page. Null at the end. */
  nextCursor: string | null
}

/** How many rows a list returns when the caller does not say. */
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT)
}

/**
 * The cursor is `<iso timestamp>|<id>`, and the second half is not decoration.
 *
 * ⚠ A TIMESTAMP ALONE IS NOT A UNIQUE KEY. Two messages accepted in the same
 * millisecond — which a batch send produces by the hundred — would make a
 * `created_at < cursor` predicate either skip the rest of that millisecond or
 * repeat it forever. The id breaks the tie, and the comparison at each call
 * site is the lexicographic row-value form that Postgres can answer from the
 * composite index.
 */
function encodeCursor(at: string, id: string): string {
  return `${at}|${id}`
}

/**
 * ⚠ `timestamptz` IS MICROSECOND PRECISION AND A JS `Date` IS NOT, WHICH IS WHY
 * EVERY LIST SELECTS ITS CURSOR TIMESTAMP AS `::text`. postgres.js parses a
 * timestamp into a `Date`, truncating to milliseconds — so a cursor built from
 * one says `T.000` for a row actually stored at `T.000500`. The next page then
 * asks for `created_at < T.000`, and a row at `T.000200` — older, and
 * legitimately on the next page — compares GREATER on the first component and
 * is skipped. Permanently: no page ever returns it.
 *
 * ⚠ AND THE TIE-BREAK DOES NOT SAVE IT, because the truncation makes the
 * timestamp component unequal in the wrong direction before the id is ever
 * compared. It only bites when two rows share a millisecond with different
 * microsecond offsets — which is every busy send path, since `now()` is fixed
 * within a transaction but not across them.
 */
const rawTimestamp = (column: AnyPgColumn) => sql<string>`${column}::text`

/**
 * ⚠ SPLIT ON THE **FIRST** SEPARATOR, NOT THE LAST, AND THE SUPPRESSION LIST IS
 * WHY. Its cursor's second half is an EMAIL ADDRESS rather than a uuid, and a
 * quoted local part may legally contain a `|`. An ISO timestamp never can — so
 * taking everything before the first separator always yields the whole
 * timestamp and everything after it always yields the whole id, whatever the id
 * happens to contain. `lastIndexOf` gets the uuid lists right and silently
 * truncates an address at its last separator, which would page past a row
 * instead of to it.
 */
/**
 * ⚠ THE TIMESTAMP HALF IS KEPT AS TEXT AND BOUND WITH `::timestamptz`, NOT
 * PARSED INTO A `Date`. Parsing it would throw away the microseconds the
 * `::text` select exists to preserve — see `rawTimestamp`.
 *
 * ⚠ SO IT IS VALIDATED IN TWO STEPS, AND ONE IS NOT ENOUGH. The shape check
 * alone accepts `2026-13-45 99:99:99`, which is bound safely as a parameter and
 * then raises `invalid input syntax for type timestamp` inside Postgres — a 500
 * on a log page because somebody edited the URL. The `Date.parse` that follows
 * rejects it. The shape check is still needed first, because V8's parser is
 * lenient in the other direction: it accepts things Postgres does not, and it
 * rolls `2026-02-30` over to 2 March rather than refusing it.
 */
const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/

function decodeCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null
  /*
   * ⚠ SPLIT ON THE **FIRST** SEPARATOR, NOT THE LAST, AND THE SUPPRESSION LIST
   * IS WHY. Its cursor's second half is an EMAIL ADDRESS rather than a uuid,
   * and a quoted local part may legally contain a `|`. A rendered timestamp
   * never can — so taking everything before the first separator always yields
   * the whole timestamp and everything after it always yields the whole id.
   */
  const sep = cursor.indexOf("|")
  if (sep <= 0) return null
  const at = cursor.slice(0, sep)
  const id = cursor.slice(sep + 1)
  if (!id || !TIMESTAMP.test(at)) return null
  // ⚠ SHAPE IS NOT VALIDITY. See above: month 13 passes the pattern and raises
  // in Postgres. The parse is only a guard — the ORIGINAL string is what gets
  // bound, so nothing is lost to the Date's millisecond precision.
  if (Number.isNaN(Date.parse(at))) return null
  return { at, id }
}

// ─────────────────────────────────────────────────────────────────────────────
// Overview
// ─────────────────────────────────────────────────────────────────────────────

export interface DailyStat {
  date: string
  sent: number
  delivered: number
  bounced: number
  complained: number
  delayed: number
  failed: number
}

export interface Overview {
  /** One row per day in the window, including days with nothing. */
  series: DailyStat[]
  totals: {
    sent: number
    delivered: number
    bounced: number
    complained: number
    delayed: number
    failed: number
  }
  counts: {
    domains: number
    verifiedDomains: number
    apiKeys: number
    webhookEndpoints: number
    suppressions: number
  }
}

export interface EmailFilters {
  /** Any of the values `lastEvent` can return. Empty means every state. */
  status?: readonly string[]
  domainId?: string
  broadcastId?: string
  /** Matches the subject or any recipient. */
  search?: string
  from?: Date
  to?: Date
  cursor?: string
  limit?: number
}

export interface EmailRow {
  id: string
  created_at: string
  from: string
  to: string[]
  subject: string
  status: string
  last_event: string
  scheduled_at: string | null
  sent_at: string | null
  route: string | null
  last_error: string | null
}

export interface ConsoleQueries {
  overview(tenantId: string, days: number): Promise<Overview>
  listEmails(tenantId: string, filters: EmailFilters): Promise<Page<EmailRow>>
  emailDetail(tenantId: string, id: string): Promise<EmailDetail | null>
  listSuppressions(
    tenantId: string,
    opts: { search?: string; cursor?: string; limit?: number },
  ): Promise<Page<SuppressionRow>>
  addSuppression(tenantId: string, address: string): Promise<void>
  removeSuppression(tenantId: string, address: string): Promise<boolean>
  listDeliveries(
    tenantId: string,
    opts: { endpointId?: string; cursor?: string; limit?: number },
  ): Promise<Page<DeliveryRow>>
  listRequests(
    tenantId: string,
    opts: { cursor?: string; limit?: number; status?: "ok" | "error" },
  ): Promise<Page<RequestRow>>
  recordRequest(input: RequestRecord): Promise<void>
}

export interface EmailDetail extends EmailRow {
  cc: string[]
  bcc: string[]
  reply_to: string[]
  html: string | null
  text: string | null
  headers: Record<string, string> | null
  attachments: { filename?: string; content_type?: string; size?: number }[] | null
  tags: Record<string, string> | null
  events: { type: string; occurred_at: string; payload: unknown }[]
  domain_id: string | null
  api_key_id: string | null
  broadcast_id: string | null
  provider_message_id: string | null
  attempts: number
}

export interface SuppressionRow {
  address: string
  reason: string
  message_id: string | null
  created_at: string
}

export interface DeliveryRow {
  id: string
  endpoint_id: string
  endpoint_url: string | null
  event_type: string
  status: string
  attempts: number
  response_status: number | null
  last_error: string | null
  occurred_at: string
  delivered_at: string | null
  created_at: string
}

export interface RequestRow {
  id: string
  method: string
  path: string
  status: number
  duration_ms: number
  error_name: string | null
  user_agent: string | null
  api_key_id: string | null
  occurred_at: string
}

export interface RequestRecord {
  tenantId: string
  apiKeyId: string | null
  method: string
  path: string
  status: number
  durationMs: number
  errorName?: string | null
  userAgent?: string | null
}

export function consoleQueries(db: Database): ConsoleQueries {
  return {
    async overview(tenantId, days) {
      const to = new Date()
      const from = new Date(to.getTime() - (days - 1) * 86_400_000)

      return withTenant(db, tenantId, async (tx) => {
        /*
         * ⚠ THE SERIES COMES FROM A FUNCTION AND THE COUNTS COME FROM FIVE
         * SCALAR QUERIES, AND BOTH HALVES GO IN ONE `Promise.all`. This is the
         * first screen after sign-in; awaiting them in sequence makes the
         * overview six round trips deep, which is the whole of its perceived
         * latency because none of them depends on another.
         */
        const [series, domainCounts, keyCount, endpointCount, suppressionCount] =
          await Promise.all([
            tx.execute(sql`
              select bucket, sent, delivered, bounced, complained, delayed, failed
                from core.message_stats(${tenantId}::uuid, ${from}, ${to})
            `) as unknown as Promise<
              {
                bucket: Date | string
                sent: string | number
                delivered: string | number
                bounced: string | number
                complained: string | number
                delayed: string | number
                failed: string | number
              }[]
            >,

            tx
              .select({
                total: sql<number>`count(*)::int`,
                verified: sql<number>`count(*) filter (where ${domains.status} = 'verified')::int`,
              })
              .from(domains),

            tx
              .select({ total: sql<number>`count(*)::int` })
              .from(apiKeys)
              .where(sql`${apiKeys.revokedAt} is null`),

            tx.select({ total: sql<number>`count(*)::int` }).from(webhookEndpoints),

            tx.select({ total: sql<number>`count(*)::int` }).from(suppressions),
          ])

        const rows: DailyStat[] = series.map((r) => ({
          // ⚠ THE DATE, NOT A TIMESTAMP. The bucket is already `date_trunc`ed
          // to a day in UTC; handing the browser a full ISO timestamp invites
          // it to render the day before for anyone west of Greenwich.
          date: toDateString(r.bucket),
          sent: num(r.sent),
          delivered: num(r.delivered),
          bounced: num(r.bounced),
          complained: num(r.complained),
          delayed: num(r.delayed),
          failed: num(r.failed),
        }))

        const totals = rows.reduce(
          (acc, r) => ({
            sent: acc.sent + r.sent,
            delivered: acc.delivered + r.delivered,
            bounced: acc.bounced + r.bounced,
            complained: acc.complained + r.complained,
            delayed: acc.delayed + r.delayed,
            failed: acc.failed + r.failed,
          }),
          { sent: 0, delivered: 0, bounced: 0, complained: 0, delayed: 0, failed: 0 },
        )

        return {
          series: rows,
          totals,
          counts: {
            domains: domainCounts[0]?.total ?? 0,
            verifiedDomains: domainCounts[0]?.verified ?? 0,
            apiKeys: keyCount[0]?.total ?? 0,
            webhookEndpoints: endpointCount[0]?.total ?? 0,
            suppressions: suppressionCount[0]?.total ?? 0,
          },
        }
      })
    },

    async listEmails(tenantId, filters) {
      const limit = clampLimit(filters.limit)
      const cursor = decodeCursor(filters.cursor)

      return withTenant(db, tenantId, async (tx) => {
        const where: SQL[] = []

        if (filters.domainId) where.push(eq(messages.domainId, filters.domainId))
        if (filters.broadcastId)
          where.push(eq(messages.broadcastId, filters.broadcastId))
        if (filters.from) where.push(gte(messages.createdAt, filters.from))
        if (filters.to) where.push(lte(messages.createdAt, filters.to))

        if (filters.search) {
          /*
           * ⚠ `ILIKE` WITH THE PATTERN BOUND, NOT INTERPOLATED, AND THE
           * WILDCARDS ADDED HERE RATHER THAN BY THE CALLER. A caller-supplied
           * `%` is harmless; a caller-supplied `\` in front of one is not, and
           * neither is somebody pasting a hundred-character subject that turns
           * into a leading-wildcard scan of a partitioned table. `escapeLike`
           * neutralises the three pattern metacharacters so a search for
           * "50%_off" finds that literal string.
           */
          const pattern = `%${escapeLike(filters.search)}%`
          const clause = or(
            sql`${messages.subject} ilike ${pattern}`,
            sql`${messages.fromAddress} ilike ${pattern}`,
            // ⚠ `array_to_string` RATHER THAN `= ANY`, BECAUSE THIS IS A
            // SUBSTRING SEARCH. A person typing "acme" expects to find
            // `bob@acme.com`, and `ANY` only matches whole elements.
            sql`array_to_string(${messages.toAddresses}, ',') ilike ${pattern}`,
          )
          if (clause) where.push(clause)
        }

        if (cursor) {
          /*
           * ⚠ THE ROW-VALUE COMPARISON, NOT `created_at < x OR (created_at = x
           * AND id < y)`. They are logically identical and only the first is
           * answered by an index scan on `(created_at desc, id desc)` — the
           * second makes the planner choose between two disjoint ranges and it
           * usually chooses a scan of both.
           */
          where.push(
            sql`(${messages.createdAt}, ${messages.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
          )
        }

        /*
         * ⚠ ONE EXTRA ROW IS FETCHED TO LEARN WHETHER THERE IS A NEXT PAGE.
         * The alternative is a `count(*)` over the same predicate on every
         * request, which on a partitioned message table is the single most
         * expensive thing this endpoint could do — and it answers a question
         * nobody asked. Nobody wants to know there are 41,812 results; they
         * want to know whether to show a "load more".
         */
        const rows = await tx
          .select({
            id: messages.id,
            createdAt: messages.createdAt,
            // See `rawTimestamp`: the Date above loses the microseconds the
            // cursor needs, so the same column is selected twice.
            createdAtRaw: rawTimestamp(messages.createdAt),
            fromAddress: messages.fromAddress,
            toAddresses: messages.toAddresses,
            subject: messages.subject,
            status: messages.status,
            scheduledAt: messages.scheduledAt,
            sentAt: messages.sentAt,
            sentRoute: messages.sentRoute,
            lastError: messages.lastError,
          })
          .from(messages)
          .where(where.length ? and(...where) : undefined)
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(limit + 1)

        const hasMore = rows.length > limit
        const page = hasMore ? rows.slice(0, limit) : rows

        /*
         * ⚠ THE EVENTS ARE FETCHED FOR THE PAGE IN ONE QUERY, NOT PER ROW. A
         * per-row lookup is fifty round trips for one screen — the textbook
         * N+1, and on a partitioned events table each one is expensive. The
         * `inArray` below is a single index scan, and `selectDistinct` bounds
         * the result at eight rows per message because there are eight event
         * types.
         */
        const ids = page.map((r) => r.id)
        const eventRows = ids.length
          ? await tx
              .selectDistinct({
                messageId: messageEvents.messageId,
                type: messageEvents.type,
              })
              .from(messageEvents)
              .where(
                and(
                  inArray(messageEvents.messageId, ids),
                  // ⚠ THE PARTITION PRUNE, TAKEN FROM THE PAGE ITSELF. An event
                  // cannot precede its message, so the oldest row on this page
                  // minus an hour of slack excludes every older partition and
                  // excludes nothing real.
                  gte(
                    messageEvents.occurredAt,
                    new Date(
                      Math.min(...page.map((r) => r.createdAt.getTime())) - 3_600_000,
                    ),
                  ),
                ),
              )
          : []

        const byMessage = new Map<string, string[]>()
        for (const e of eventRows) {
          const list = byMessage.get(e.messageId)
          if (list) list.push(e.type)
          else byMessage.set(e.messageId, [e.type])
        }

        let data: EmailRow[] = page.map((r) => ({
          id: r.id,
          created_at: r.createdAt.toISOString(),
          from: r.fromAddress,
          to: r.toAddresses,
          subject: r.subject,
          status: r.status,
          last_event: lastEvent(r.status, r.scheduledAt, byMessage.get(r.id) ?? []),
          scheduled_at: r.scheduledAt?.toISOString() ?? null,
          sent_at: r.sentAt?.toISOString() ?? null,
          route: r.sentRoute,
          last_error: r.lastError,
        }))

        /*
         * ⚠ THE STATUS FILTER IS APPLIED IN TYPESCRIPT, AFTER THE PAGE, AND
         * THAT IS A KNOWN AND DELIBERATE LIMITATION RATHER THAN AN OVERSIGHT.
         * `last_event` is not a column — it is the worst-by-severity of a
         * message's events, falling back to the row's own status — so filtering
         * on it in SQL means a correlated aggregate over the events table per
         * candidate row, on a partitioned table, in the WHERE clause. That is a
         * materialised `messages.last_event` column maintained by the ingest
         * path, which is a real change to the write path and is written up in
         * docs/decisions/console.md §7 rather than smuggled in here.
         *
         * The consequence is visible and is documented at the route: a filtered
         * page can return fewer than `limit` rows while more exist further
         * down. The cursor is still taken from the LAST ROW EXAMINED rather
         * than the last row returned, so paging never stalls — it just walks
         * more pages to fill the screen.
         */
        if (filters.status?.length) {
          const wanted = new Set(filters.status)
          data = data.filter((row) => wanted.has(row.last_event))
        }

        const lastExamined = page[page.length - 1]

        return {
          data,
          nextCursor:
            hasMore && lastExamined
              ? encodeCursor(lastExamined.createdAtRaw, lastExamined.id)
              : null,
        }
      })
    },

    async emailDetail(tenantId, id) {
      /*
       * ⚠ THE PARTITION IS DERIVED FROM THE ID, THE SAME WAY `GET /emails/{id}`
       * ALREADY DOES IT. `core.messages` is partitioned by `created_at` and keyed
       * `(id, created_at)`, so a lookup by bare id fans out across every
       * partition — cheap this month and a scan per partition in a year, on the
       * page somebody opens from every row of the email list. A UUIDv7 carries
       * its own creation millisecond, so an hour either side prunes to one
       * partition before the index is touched.
       *
       * ⚠ AND AN ID WE CANNOT DATE GETS NO WINDOW AT ALL. A v4 from a fixture,
       * or an id minted by a future scheme, would otherwise prune to a window it
       * never belonged to and 404 a message that exists. A slow query is a
       * better failure than a lie. See send/lookup.ts, which states the same
       * rule for the same reason.
       */
      const minted = timestampFromUuidV7(id)
      const window = minted
        ? [
            gte(messages.createdAt, new Date(minted.getTime() - PRUNE_WINDOW_MS)),
            lte(messages.createdAt, new Date(minted.getTime() + PRUNE_WINDOW_MS)),
          ]
        : []

      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.id, id), ...window))
          .limit(1)

        const message = rows[0]
        // ⚠ RLS MAKES ANOTHER TENANT'S ID A 404 RATHER THAN A 403, which is the
        // answer we want: a 403 confirms the id exists and turns this into an
        // oracle for enumerating other people's message ids.
        if (!message) return null

        const [bodies, events] = await Promise.all([
          tx
            .select()
            .from(messageBodies)
            .where(
              and(
                eq(messageBodies.messageId, message.id),
                eq(messageBodies.createdAt, message.createdAt),
              ),
            )
            .limit(1),

          tx
            .select({
              type: messageEvents.type,
              occurredAt: messageEvents.occurredAt,
              payload: messageEvents.payload,
            })
            .from(messageEvents)
            .where(
              and(
                eq(messageEvents.messageId, message.id),
                gte(
                  messageEvents.occurredAt,
                  new Date(message.createdAt.getTime() - 3_600_000),
                ),
              ),
            )
            .orderBy(messageEvents.occurredAt),
        ])

        const body = bodies[0]

        return {
          id: message.id,
          created_at: message.createdAt.toISOString(),
          from: message.fromAddress,
          to: message.toAddresses,
          cc: message.ccAddresses,
          bcc: message.bccAddresses,
          reply_to: message.replyTo,
          subject: message.subject,
          status: message.status,
          last_event: lastEvent(
            message.status,
            message.scheduledAt,
            events.map((e) => e.type),
          ),
          scheduled_at: message.scheduledAt?.toISOString() ?? null,
          sent_at: message.sentAt?.toISOString() ?? null,
          route: message.sentRoute,
          last_error: message.lastError,
          html: body?.html ?? null,
          text: body?.text ?? null,
          headers: (body?.headers as Record<string, string> | null) ?? null,
          /*
           * ⚠ METADATA ONLY — THE BYTES ARE NEVER RETURNED. An attachment is
           * stored as base64 in a jsonb column; a ten-megabyte PDF would be a
           * thirteen-megabyte JSON response for a page that only ever renders
           * the filename. There is a separate download route for the content.
           */
          attachments: summariseAttachments(body?.attachments),
          tags: (body?.tags as Record<string, string> | null) ?? null,
          events: events.map((e) => ({
            type: e.type,
            occurred_at: e.occurredAt.toISOString(),
            payload: e.payload,
          })),
          domain_id: message.domainId,
          api_key_id: message.apiKeyId,
          broadcast_id: message.broadcastId,
          provider_message_id: message.providerMessageId,
          attempts: message.attempts,
        }
      })
    },

    async listSuppressions(tenantId, opts) {
      const limit = clampLimit(opts.limit)
      const cursor = decodeCursor(opts.cursor)

      return withTenant(db, tenantId, async (tx) => {
        const where: SQL[] = []
        if (opts.search) {
          where.push(
            sql`${suppressions.address} ilike ${`%${escapeLike(opts.search)}%`}`,
          )
        }
        if (cursor) {
          where.push(
            sql`(${suppressions.createdAt}, ${suppressions.address}) < (${cursor.at}::timestamptz, ${cursor.id})`,
          )
        }

        const rows = await tx
          .select({
            address: suppressions.address,
            reason: suppressions.reason,
            messageId: suppressions.messageId,
            createdAt: suppressions.createdAt,
            createdAtRaw: rawTimestamp(suppressions.createdAt),
          })
          .from(suppressions)
          .where(where.length ? and(...where) : undefined)
          .orderBy(desc(suppressions.createdAt), desc(suppressions.address))
          .limit(limit + 1)

        const hasMore = rows.length > limit
        const page = hasMore ? rows.slice(0, limit) : rows
        const last = page[page.length - 1]

        return {
          data: page.map((r) => ({
            address: r.address,
            reason: r.reason,
            message_id: r.messageId,
            created_at: r.createdAt.toISOString(),
          })),
          nextCursor:
            hasMore && last ? encodeCursor(last.createdAtRaw, last.address) : null,
        }
      })
    },

    async addSuppression(tenantId, address) {
      await withTenant(db, tenantId, async (tx) => {
        await tx
          .insert(suppressions)
          .values({
            tenantId,
            // ⚠ LOWERCASED HERE, BECAUSE THE SEND PATH LOOKS IT UP LOWERCASED.
            // A suppression stored as `Bob@Acme.com` would silently never match
            // and the customer would watch mail keep going to an address they
            // blocked — the worst possible failure for this particular table.
            address: address.trim().toLowerCase(),
            reason: "manual",
          })
          // Adding an address that is already suppressed is not an error; it is
          // somebody making sure.
          .onConflictDoNothing()
      })
    },

    async removeSuppression(tenantId, address) {
      return withTenant(db, tenantId, async (tx) => {
        const deleted = await tx
          .delete(suppressions)
          .where(eq(suppressions.address, address.trim().toLowerCase()))
          .returning({ address: suppressions.address })
        return deleted.length > 0
      })
    },

    async listDeliveries(tenantId, opts) {
      const limit = clampLimit(opts.limit)
      const cursor = decodeCursor(opts.cursor)

      return withTenant(db, tenantId, async (tx) => {
        const where: SQL[] = []
        if (opts.endpointId)
          where.push(eq(webhookDeliveries.endpointId, opts.endpointId))
        if (cursor) {
          where.push(
            sql`(${webhookDeliveries.createdAt}, ${webhookDeliveries.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
          )
        }

        const rows = await tx
          .select({
            id: webhookDeliveries.id,
            endpointId: webhookDeliveries.endpointId,
            endpointUrl: webhookEndpoints.url,
            eventType: webhookDeliveries.eventType,
            status: webhookDeliveries.status,
            attempts: webhookDeliveries.attempts,
            responseStatus: webhookDeliveries.responseStatus,
            lastError: webhookDeliveries.lastError,
            occurredAt: webhookDeliveries.occurredAt,
            deliveredAt: webhookDeliveries.deliveredAt,
            createdAt: webhookDeliveries.createdAt,
            createdAtRaw: rawTimestamp(webhookDeliveries.createdAt),
          })
          .from(webhookDeliveries)
          // ⚠ A LEFT JOIN, BECAUSE THE ENDPOINT MAY HAVE BEEN DELETED. The
          // delivery record outlives it, and an inner join would make the
          // history of a removed endpoint silently vanish from the log — which
          // is exactly the history somebody is looking for after removing one.
          .leftJoin(
            webhookEndpoints,
            eq(webhookEndpoints.id, webhookDeliveries.endpointId),
          )
          .where(where.length ? and(...where) : undefined)
          .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
          .limit(limit + 1)

        const hasMore = rows.length > limit
        const page = hasMore ? rows.slice(0, limit) : rows
        const last = page[page.length - 1]

        return {
          data: page.map((r) => ({
            id: r.id,
            endpoint_id: r.endpointId,
            endpoint_url: r.endpointUrl,
            event_type: r.eventType,
            status: r.status,
            attempts: r.attempts,
            response_status: r.responseStatus,
            last_error: r.lastError,
            occurred_at: r.occurredAt.toISOString(),
            delivered_at: r.deliveredAt?.toISOString() ?? null,
            created_at: r.createdAt.toISOString(),
          })),
          nextCursor: hasMore && last ? encodeCursor(last.createdAtRaw, last.id) : null,
        }
      })
    },

    async listRequests(tenantId, opts) {
      const limit = clampLimit(opts.limit)
      const cursor = decodeCursor(opts.cursor)

      return withTenant(db, tenantId, async (tx) => {
        const where: SQL[] = []
        if (opts.status === "error") where.push(gte(apiRequests.status, 400))
        if (opts.status === "ok") where.push(lt(apiRequests.status, 400))
        if (cursor) {
          where.push(
            sql`(${apiRequests.occurredAt}, ${apiRequests.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
          )
        }

        const rows = await tx
          .select({
            id: apiRequests.id,
            method: apiRequests.method,
            path: apiRequests.path,
            status: apiRequests.status,
            durationMs: apiRequests.durationMs,
            errorName: apiRequests.errorName,
            userAgent: apiRequests.userAgent,
            apiKeyId: apiRequests.apiKeyId,
            occurredAt: apiRequests.occurredAt,
            occurredAtRaw: rawTimestamp(apiRequests.occurredAt),
          })
          .from(apiRequests)
          .where(where.length ? and(...where) : undefined)
          .orderBy(desc(apiRequests.occurredAt), desc(apiRequests.id))
          .limit(limit + 1)

        const hasMore = rows.length > limit
        const page = hasMore ? rows.slice(0, limit) : rows
        const last = page[page.length - 1]

        return {
          data: page.map((r) => ({
            id: r.id,
            method: r.method,
            path: r.path,
            status: r.status,
            duration_ms: r.durationMs,
            error_name: r.errorName,
            user_agent: r.userAgent,
            api_key_id: r.apiKeyId,
            occurred_at: r.occurredAt.toISOString(),
          })),
          nextCursor:
            hasMore && last ? encodeCursor(last.occurredAtRaw, last.id) : null,
        }
      })
    },

    async recordRequest(input) {
      /*
       * ⚠ THIS IS THE ONE WRITE IN A READ MODEL, AND IT IS FIRE-AND-FORGET AT
       * THE CALL SITE RATHER THAN HERE. The middleware that calls it does not
       * await it: a request log that can fail a request is a log that takes the
       * API down when the table is full. What it must NOT do is swallow the
       * error silently — the caller catches and logs, so a broken log is
       * visible in the API's own logs rather than only in an empty page.
       */
      await withTenant(db, input.tenantId, async (tx) => {
        await tx.insert(apiRequests).values({
          tenantId: input.tenantId,
          apiKeyId: input.apiKeyId,
          method: input.method,
          path: input.path,
          status: input.status,
          durationMs: input.durationMs,
          errorName: input.errorName ?? null,
          // ⚠ TRUNCATED. A user agent is unbounded and attacker-controlled;
          // 200 characters names an SDK and a version, which is the question.
          userAgent: input.userAgent ? input.userAgent.slice(0, 200) : null,
        })
      })
    },
  }
}

/**
 * ⚠ `_`, `%` AND `\` ARE THE THREE `LIKE` METACHARACTERS AND ALL THREE HAVE TO
 * GO. Escaping only `%` leaves `_` as a single-character wildcard, so a search
 * for `a_b` matches `axb` — wrong, but harmless. Leaving `\` unescaped is the
 * one that matters: it lets a search string neutralise the escaping applied to
 * the other two.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

function num(value: string | number): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10) || 0
}

function toDateString(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value)
  return d.toISOString().slice(0, 10)
}

function summariseAttachments(
  value: unknown,
): { filename?: string; content_type?: string; size?: number }[] | null {
  if (!Array.isArray(value)) return null
  return value.map((a) => {
    const item = (a ?? {}) as Record<string, unknown>
    const content = typeof item.content === "string" ? item.content : undefined
    return {
      ...(typeof item.filename === "string" ? { filename: item.filename } : {}),
      ...(typeof item.content_type === "string"
        ? { content_type: item.content_type }
        : {}),
      // ⚠ THE DECODED SIZE, NOT THE BASE64 LENGTH. Reporting the encoded length
      // overstates every attachment by a third, and the number a person
      // compares it against — their provider's limit — is in decoded bytes.
      ...(content ? { size: Math.floor((content.length * 3) / 4) } : {}),
    }
  })
}

export { encodeCursor, decodeCursor, escapeLike, clampLimit }
