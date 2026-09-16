import type { Attachment, Tag } from "@repo/contracts"
import { inArray } from "drizzle-orm"
import {
  claimStatement,
  markFailedStatement,
  markSentStatement,
  type MessageRef,
} from "../db/claim.js"
import { withTenant, type Database } from "../db/client.js"
import { messageBodies } from "../db/core.js"
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
 * partitioned by `created_at`, so recording the result needs the exact value —
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
   * The routing inputs, read on the same statement that won the row.
   *
   * ⚠ CARRIED RATHER THAN LOOKED UP AT SEND TIME. Resolving the route needs the
   * domain's override and the tenant's plan, and fetching either per message
   * would put two more round trips on the hot path of every send. The claim is
   * already reading the row; these ride along on it.
   *
   * ⚠ AND `routeOverride` IS NULLABLE BECAUSE `domain_id` IS. A message with no
   * domain has no override, which `resolveRoute` reads as `auto` — the same
   * answer it would give for a domain that never set one.
   */
  routeOverride: RouteOverride | null
  planId: string | null
}

type Row = Record<string, unknown>

export interface AdapterOptions {
  db: Database
  workerId: string
  /**
   * How long a row may sit in `sending` before another worker may take it.
   * Must exceed groupmq's `jobTimeoutMs` — see db/claim.ts.
   */
  staleAfter: string
}

export function databaseOps(
  opts: AdapterOptions,
): Pick<BatchDeps<ClaimedMessage>, "claim" | "markSent" | "markFailed"> {
  return {
    async claim(job: SendJob): Promise<ClaimedMessage[]> {
      return withTenant(opts.db, job.tenantId, async (tx) => {
        const claimed = (await tx.execute(
          claimStatement(job.messages, {
            workerId: opts.workerId,
            staleAfter: opts.staleAfter,
          }),
        )) as unknown as Row[]

        if (claimed.length === 0) return []

        // ⚠ FETCHED SEPARATELY, AND ONLY FOR WHAT WAS WON. Bodies live in their
        // own table so the claim — which scans and updates — never drags an HTML
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
          })
          .from(messageBodies)
          .where(inArray(messageBodies.messageId, ids))

        const byId = new Map(bodies.map((b) => [b.messageId, b]))

        return claimed.map((row): ClaimedMessage => {
          const body = byId.get(String(row.id))
          return {
            id: String(row.id),
            createdAt: new Date(row.created_at as string),
            routeOverride: (row.transactional_route as RouteOverride | null) ?? null,
            planId: row.plan_id === null ? null : String(row.plan_id),
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
    },

    // ⚠ RETURNS THE STORED `sent_at`, WHICH THE METER IS THEN BILLED ON. Null
    // means the row was not ours to record — the claim moved on — and the caller
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
