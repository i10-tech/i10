import type { ContentStore } from "../content/object-store.js"
import { restoreContent } from "../content/packs.js"
import { restoreBodies } from "../content/restore.js"
import type { EmailEventName, GetEmailResponse } from "@repo/contracts"
import { and, eq, gte, lte } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { messageBodies, messageEvents, messages } from "../db/core.js"
import { timestampFromUuidV7 } from "../ids.js"

/**
 * Reading one message back.
 *
 * ⚠ THE PARTITION IS DERIVED FROM THE ID, WHICH IS THE WHOLE REASON THIS IS
 * AFFORDABLE. `core.messages` is partitioned by `created_at` and keyed
 * `(id, created_at)`, so a lookup by bare id has to touch every partition -
 * today that is cheap and in a year it is a table scan per status check, on the
 * endpoint an SDK polls. A UUIDv7 carries its own creation millisecond, so the
 * range predicate below prunes to a single partition before the index is used.
 *
 * ⚠ AND THE WINDOW IS A WINDOW RATHER THAN AN EQUALITY, because the id's
 * timestamp and the column's `now()` are minted microseconds apart in the same
 * statement - close enough to prune with, wrong to match on. An hour either side
 * costs nothing (the planner still drops every other partition) and cannot be
 * defeated by clock skew between the database and whoever generated the id.
 */
export const PRUNE_WINDOW_MS = 60 * 60 * 1000

/**
 * The furthest a message has got, as one value.
 *
 * ⚠ ORDERED BY SEVERITY, NOT BY TIME, AND THE DIFFERENCE MATTERS. SES publishes
 * `Delivery` for one recipient and `Bounce` for another on the same message, and
 * the two arrive in whatever order the receivers answer. Taking the latest by
 * timestamp would make the same message read `delivered` or `bounced` depending
 * on which mail server was slower. A caller asking "did this work" needs the
 * worst outcome, deterministically.
 */
const SEVERITY: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivery_delayed: 2,
  delivered: 3,
  // ⚠ ENGAGEMENT RANKS ABOVE DELIVERY AND BELOW EVERY FAILURE. An open proves
  // delivery to that recipient, but on a message with several, a bounce or a
  // complaint from another must still win - "did this work" wants the worst.
  opened: 4,
  clicked: 5,
  unsubscribed: 6,
  complained: 7,
  bounced: 8,
  rejected: 9,
  failed: 10,
}

export interface EmailLookup {
  get: (tenantId: string, id: string) => Promise<GetEmailResponse | null>
}

/** What of a body lives in R2 (#168, #188). */
interface Stored {
  inlineObjects: string[] | null
  packId: string | null
  packOffset: number | null
  packLength: number | null
  bodyKey: string | null
}

export function emailLookup(
  db: Database,
  /** Where data-URI images moved to (#168). Null: none can have moved. */
  store: ContentStore | null = null,
): EmailLookup {
  return {
    async get(tenantId, id) {
      const minted = timestampFromUuidV7(id)
      let stored = null as Stored | null

      const email = await withTenant(db, tenantId, async (tx) => {
        // ⚠ THE RANGE IS OMITTED FOR AN ID WE CANNOT DATE rather than guessed.
        // A v4 from a fixture, or an id minted by some future scheme, would
        // otherwise prune to a window it never belonged to and return null for
        // a message that exists - a 404 for a real send is worse than a slow
        // query.
        const window = minted
          ? [
              gte(messages.createdAt, new Date(minted.getTime() - PRUNE_WINDOW_MS)),
              lte(messages.createdAt, new Date(minted.getTime() + PRUNE_WINDOW_MS)),
            ]
          : []

        const rows = await tx
          .select({
            id: messages.id,
            createdAt: messages.createdAt,
            status: messages.status,
            scheduledAt: messages.scheduledAt,
            fromAddress: messages.fromAddress,
            toAddresses: messages.toAddresses,
            ccAddresses: messages.ccAddresses,
            bccAddresses: messages.bccAddresses,
            replyTo: messages.replyTo,
            subject: messages.subject,
          })
          .from(messages)
          .where(and(eq(messages.id, id), ...window))
          .limit(1)

        const message = rows[0]
        // ⚠ RLS MAKES THIS A 404 RATHER THAN A 403 FOR ANOTHER TENANT'S ID, AND
        // THAT IS THE ANSWER WE WANT. A 403 would confirm the id exists, which
        // turns a status endpoint into an oracle for enumerating other people's
        // message ids.
        if (!message) return null

        // The body lives in its own table so the hot paths never carry it; a
        // status check is not a hot path, and a caller asking what they sent
        // expects to see it.
        // ⚠ TOGETHER, BECAUSE NEITHER READS THE OTHER. Awaiting them in
        // sequence makes a status check four round trips instead of three, on
        // the one endpoint SDKs poll.
        const [bodies, events] = await Promise.all([
          tx
            .select({
              text: messageBodies.text,
              html: messageBodies.html,
              templateId: messageBodies.templateId,
              templateValues: messageBodies.templateValues,
              inlineObjects: messageBodies.inlineObjects,
              packId: messageBodies.packId,
              packOffset: messageBodies.packOffset,
              packLength: messageBodies.packLength,
              bodyKey: messageBodies.bodyKey,
            })
            .from(messageBodies)
            .where(
              and(
                eq(messageBodies.messageId, message.id),
                eq(messageBodies.createdAt, message.createdAt),
              ),
            )
            .limit(1),

          // ⚠ `message_events` IS PARTITIONED ON `occurred_at` TOO, so this
          // needs its own lower bound or it merge-appends across every
          // partition ever created. An event cannot precede the message, so
          // the message's own creation time - minus the same slack the id
          // window uses - prunes everything older and excludes nothing real.
          //
          // ⚠ AND IT IS `distinct` RATHER THAN ordered-and-limited. `lastEvent`
          // takes a maximum over a severity table, so order buys nothing - and
          // a `limit` on an ordered scan could cut off the very event that
          // matters, reporting `delivered` for a message that later bounced.
          // There are eleven event types, so distinct is bounded by design.
          tx
            .selectDistinct({ type: messageEvents.type })
            .from(messageEvents)
            .where(
              and(
                eq(messageEvents.messageId, message.id),
                ...(minted
                  ? [
                      gte(
                        messageEvents.occurredAt,
                        new Date(minted.getTime() - PRUNE_WINDOW_MS),
                      ),
                    ]
                  : []),
              ),
            ),
        ])

        // A body stored as a template plus values (#171) reads like a full one.
        const [body] = await restoreBodies(tx, bodies)
        stored = body && (body.inlineObjects?.length || body.packId) ? body : null

        return {
          object: "email" as const,
          id: message.id,
          from: message.fromAddress,
          to: message.toAddresses,
          cc: message.ccAddresses,
          bcc: message.bccAddresses,
          reply_to: message.replyTo,
          subject: message.subject,
          text: body?.text ?? null,
          html: body?.html ?? null,
          created_at: message.createdAt.toISOString(),
          scheduled_at: message.scheduledAt?.toISOString() ?? null,
          last_event: lastEvent(
            message.status,
            message.scheduledAt,
            events.map((e) => e.type),
          ),
        }
      })
      // ⚠ AFTER THE TRANSACTION: a read from R2 holds nothing open in
      // Postgres. Only packed bodies (#188) and bodies whose data-URI images
      // moved (#168) read at all.
      if (!email || !stored) return email
      const [restored] = await restoreContent(store, tenantId, [
        { ...stored, messageId: email.id, html: email.html, text: email.text },
      ])
      return {
        ...email,
        html: restored?.html ?? email.html,
        text: restored?.text ?? email.text,
      }
    },
  }
}

/**
 * ⚠ THE ROW'S STATUS AND THE EVENT LOG ANSWER DIFFERENT QUESTIONS, AND THE
 * CUSTOMER ONLY CARES ABOUT ONE. `status` is our own sending state machine -
 * queued, sending, sent - and it stops at "SES accepted it". Everything after
 * that lives in the event log, which SES feeds. A message that bounced is still
 * `sent` in the row, so reporting the column alone would tell a customer their
 * mail was fine when it was returned an hour ago.
 */
export function lastEvent(
  status: string,
  scheduledAt: Date | null,
  eventTypes: readonly string[],
): EmailEventName {
  let worst: string | null = null
  for (const type of eventTypes) {
    if (SEVERITY[type] === undefined) continue
    if (worst === null || SEVERITY[type]! > SEVERITY[worst]!) worst = type
  }

  if (worst) return (worst === "rejected" ? "failed" : worst) as EmailEventName

  // No events yet. Fall back to what we know ourselves - and distinguish a
  // message that is waiting for its moment from one that is waiting for a
  // worker, because "queued" for a send scheduled next Tuesday reads as stuck.
  if (status === "queued" && scheduledAt && scheduledAt.getTime() > Date.now()) {
    return "scheduled"
  }
  return status as EmailEventName
}
