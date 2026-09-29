import { restoreAttachments, type AnyAttachment } from "../content/attachments.js"
import type { ContentStore } from "../content/object-store.js"
import { restoreContent } from "../content/packs.js"
import { restoreBodies } from "../content/restore.js"
import type { Attachment, Tag } from "@repo/contracts"
import { eq, inArray } from "drizzle-orm"
import {
  claimStatement,
  markCanceledStatement,
  markFailedStatement,
  markSentStatement,
  type MessageRef,
} from "../db/claim.js"
import { withTenant, type Database } from "../db/client.js"
import { messageBodies, sendingHolds } from "../db/core.js"
import type { RouteOverride } from "../domains/route.js"
import type { SendJob } from "../queue/send-queue.js"
import type { OutboundMessage } from "../send/transport.js"
import type { BatchDeps } from "./handle-batch.js"

/**
 * Binds the batch handler's operations to a real connection.
 *
 * ⚠ EVERY STATEMENT RUNS INSIDE `withTenant`, INCLUDING THE WORKER'S. Row level
 * security is not a request-time concern the worker gets to skip: the same
 * policies apply, `app.tenant_id` has to be set on the transaction, and a
 * connection that never sets it fails with `unrecognized configuration
 * parameter`. A worker that bypassed RLS would be the one component able to
 * read every tenant's mail, which is exactly what the schema exists to prevent.
 */

/**
 * A claimed message carries its partition key.
 *
 * ⚠ `createdAt` IS THREADED THROUGH RATHER THAN RE-DERIVED. `core.messages` is
 * partitioned by `created_at`, so recording the result needs the exact value -
 * and the UUIDv7's embedded timestamp is microseconds away from the column's
 * `now()` default, close enough to look right and wrong for an equality match.
 * The claim returns the real one; it rides along to `markSent` from there.
 *
 * The transport never sees it: `OutboundMessage` is what crosses that boundary,
 * and this type only exists between the claim and the recording.
 */
export type ClaimedMessage = OutboundMessage & {
  createdAt: Date
  /**
   * The routing input, read on the same statement that won the row.
   *
   * ⚠ CARRIED RATHER THAN LOOKED UP AT SEND TIME. Resolving the route needs the
   * domain's override, and fetching it per message would put another round trip
   * on the hot path of every send. The claim is already reading the row; it
   * rides along on it. The plan used to ride along too, until #155 took it out
   * of the transactional rule.
   *
   * ⚠ AND `routeOverride` IS NULLABLE BECAUSE `domain_id` IS. A message with no
   * domain has no override, which `resolveRoute` reads as `auto` - the same
   * answer it would give for a domain that never set one.
   */
  routeOverride: RouteOverride | null
}

type Row = Record<string, unknown>

export interface AdapterOptions {
  db: Database
  workerId: string
  /**
   * How long a row may sit in `sending` before another worker may take it.
   * Must exceed groupmq's `jobTimeoutMs` - see db/claim.ts.
   */
  staleAfter: string
  /**
   * Where attachments moved to R2 are read back from (#136). Only a retry of a
   * finished message ever meets one; absent, such a message fails loudly
   * rather than going out without its files. The same goes for a body packed
   * into R2 (#188).
   */
  store?: ContentStore | null
}

export function databaseOps(
  opts: AdapterOptions,
): Pick<
  BatchDeps<ClaimedMessage>,
  "claim" | "markSent" | "markFailed" | "held" | "markCanceled"
> {
  return {
    async claim(job: SendJob): Promise<ClaimedMessage[]> {
      // What of each claimed body lives in R2 (#168, #188), by id.
      const storedById = new Map<
        string,
        {
          inlineObjects: string[] | null
          packId: string | null
          packOffset: number | null
          packLength: number | null
          bodyKey: string | null
        }
      >()
      const claimed = await withTenant(opts.db, job.tenantId, async (tx) => {
        const claimed = (await tx.execute(
          claimStatement(job.messages, {
            workerId: opts.workerId,
            staleAfter: opts.staleAfter,
          }),
        )) as unknown as Row[]

        if (claimed.length === 0) return []

        // ⚠ FETCHED SEPARATELY, AND ONLY FOR WHAT WAS WON. Bodies live in their
        // own table so the claim - which scans and updates - never drags an HTML
        // body through it. Joining them into that UPDATE would undo the split,
        // and would read bodies for rows another worker owns.
        const ids = claimed.map((r) => String(r.id))
        const bodies = await tx
          .select({
            messageId: messageBodies.messageId,
            text: messageBodies.text,
            html: messageBodies.html,
            headers: messageBodies.headers,
            attachments: messageBodies.attachments,
            tags: messageBodies.tags,
            templateId: messageBodies.templateId,
            templateValues: messageBodies.templateValues,
            inlineObjects: messageBodies.inlineObjects,
            packId: messageBodies.packId,
            packOffset: messageBodies.packOffset,
            packLength: messageBodies.packLength,
            bodyKey: messageBodies.bodyKey,
          })
          .from(messageBodies)
          .where(inArray(messageBodies.messageId, ids))
          // ⚠ RESTORED EVEN HERE. Compaction only touches finished messages, so
          // a claim should never meet a compacted body - but a retry of a
          // failed message would, and it must send the real thing (#171).
          .then((rows) => restoreBodies(tx, rows))

        const byId = new Map(bodies.map((b) => [b.messageId, b]))
        for (const b of bodies) storedById.set(b.messageId, b)

        return claimed.map((row): ClaimedMessage => {
          const body = byId.get(String(row.id))
          return {
            id: String(row.id),
            createdAt: new Date(row.created_at as string),
            routeOverride: (row.transactional_route as RouteOverride | null) ?? null,
            sesTenant:
              row.ses_tenant_name === null ? null : String(row.ses_tenant_name),
            tracking: {
              opens: row.open_tracking === true,
              clicks: row.click_tracking === true,
            },
            tenantId: String(row.tenant_id),
            from: String(row.from_address),
            to: (row.to_addresses as string[] | null) ?? [],
            cc: (row.cc_addresses as string[] | null) ?? [],
            bcc: (row.bcc_addresses as string[] | null) ?? [],
            replyTo: (row.reply_to as string[] | null) ?? [],
            subject: String(row.subject),
            text: body?.text ?? null,
            html: body?.html ?? null,
            headers: (body?.headers as Record<string, string> | null) ?? null,
            attachments: (body?.attachments as Attachment[] | null) ?? null,
            tags: (body?.tags as Tag[] | null) ?? null,
          }
        })
      })

      // ⚠ AFTER THE TRANSACTION, NOT INSIDE IT. Reading R2 holds nothing in
      // Postgres open, and it only ever happens for a retry of a message whose
      // files the content-store job already moved.
      return Promise.all(
        claimed.map(async (m) => {
          // ⚠ PACKED BODIES AND INLINE IMAGES TOO (#168, #188): a retry of a
          // finished message may have had its body packed or its data-URI
          // images moved to R2, and must send them as sent.
          const stored = storedById.get(m.id)
          const [restored] = await restoreContent(opts.store ?? null, m.tenantId, [
            {
              messageId: m.id,
              html: m.html ?? null,
              text: m.text ?? null,
              inlineObjects: stored?.inlineObjects ?? null,
              packId: stored?.packId ?? null,
              packOffset: stored?.packOffset ?? null,
              packLength: stored?.packLength ?? null,
              bodyKey: stored?.bodyKey ?? null,
            },
          ])
          return {
            ...m,
            html: restored?.html ?? m.html,
            text: restored?.text ?? m.text,
            attachments: (await restoreAttachments(
              opts.store ?? null,
              m.tenantId,
              m.attachments as AnyAttachment[] | null,
            )) as Attachment[] | null,
          }
        }),
      )
    },

    // ⚠ RETURNS THE STORED `sent_at`, WHICH THE METER IS THEN BILLED ON. Null
    // means the row was not ours to record - the claim moved on - and the caller
    // must not invent a timestamp for a write that did not happen.
    async markSent(message, providerMessageId, route) {
      const rows = (await withTenant(opts.db, message.tenantId, (tx) =>
        tx.execute(
          markSentStatement(refOf(message), opts.workerId, providerMessageId, route),
        ),
      )) as unknown as Row[]

      const at = rows[0]?.sent_at
      return at ? new Date(at as string | Date) : null
    },

    async held(tenantId) {
      const rows = await withTenant(opts.db, tenantId, (tx) =>
        tx
          .select({ tenantId: sendingHolds.tenantId })
          .from(sendingHolds)
          .where(eq(sendingHolds.tenantId, tenantId))
          .limit(1),
      )
      return rows.length > 0
    },

    async markCanceled(message, reason) {
      await withTenant(opts.db, message.tenantId, (tx) =>
        tx.execute(markCanceledStatement(refOf(message), opts.workerId, reason)),
      )
    },

    async markFailed(message, reason, permanent) {
      await withTenant(opts.db, message.tenantId, (tx) =>
        tx.execute(
          markFailedStatement(refOf(message), opts.workerId, reason, permanent),
        ),
      )
    },
  }
}

const refOf = (m: ClaimedMessage): MessageRef => ({ id: m.id, createdAt: m.createdAt })
