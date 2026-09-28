import { and, desc, eq, sql, type SQL } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { suppressions } from "../db/core.js"
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  escapeLike,
  rawTimestamp,
  type Page,
  type SuppressionRow,
} from "../console/queries.js"
import { sesTenantName } from "../domains/identity.js"
import type { TenantSuppressions } from "./ses.js"

/**
 * A workspace's suppression list: ours in `core.suppressions`, and SES's copy.
 *
 * ⚠ ONE STORE FOR THE CONSOLE AND THE PUBLIC API. The rules below - the
 * complaint guard, SES first on removal - are the whole point of the feature,
 * and a second path to the table would be a way around both.
 */
export interface SuppressionStore {
  list(
    tenantId: string,
    opts: { search?: string; cursor?: string; limit?: number },
  ): Promise<Page<SuppressionRow>>
  add(tenantId: string, address: string): Promise<void>
  remove(
    tenantId: string,
    address: string,
    opts?: { confirmComplaint?: boolean },
  ): Promise<RemoveOutcome>
  /** Every row, newest first, up to `EXPORT_LIMIT`. */
  exportAll(tenantId: string): Promise<SuppressionRow[]>
}

/**
 * ⚠ `complaint` IS A REFUSAL, NOT AN ERROR. A person pressed "this is spam";
 * mailing them again is a decision with legal weight in several jurisdictions,
 * so removing one takes an explicit second yes from the caller. A hard bounce
 * or a manual entry does not - the worst case there is another bounce.
 *
 * ⚠ `unavailable` KEEPS OUR ROW. SES could not be told, and our row is the only
 * visible record that SES still suppresses the address - deleting it anyway
 * would show the customer an address that silently keeps failing.
 */
export type RemoveOutcome = "removed" | "missing" | "complaint" | "unavailable"

/**
 * ⚠ A CAP, SO AN EXPORT IS ONE QUERY AND ONE RESPONSE. A workspace past this
 * many suppressions has a list problem that a CSV will not solve, and an
 * unbounded read is a way to hold a connection and a pod's memory hostage.
 */
export const EXPORT_LIMIT = 100_000

export interface SuppressionStoreDeps {
  db: Database
  ses: TenantSuppressions
  log?: { error?: (o: object, m: string) => void }
}

const present = (r: {
  address: string
  reason: string
  messageId: string | null
  createdAt: Date
}): SuppressionRow => ({
  address: r.address,
  reason: r.reason,
  message_id: r.messageId,
  created_at: r.createdAt.toISOString(),
})

export function suppressionStore({
  db,
  ses,
  log,
}: SuppressionStoreDeps): SuppressionStore {
  const columns = {
    address: suppressions.address,
    reason: suppressions.reason,
    messageId: suppressions.messageId,
    createdAt: suppressions.createdAt,
  }

  return {
    async list(tenantId, opts) {
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
          .select({ ...columns, createdAtRaw: rawTimestamp(suppressions.createdAt) })
          .from(suppressions)
          .where(where.length ? and(...where) : undefined)
          .orderBy(desc(suppressions.createdAt), desc(suppressions.address))
          .limit(limit + 1)

        const hasMore = rows.length > limit
        const page = hasMore ? rows.slice(0, limit) : rows
        const last = page[page.length - 1]

        return {
          data: page.map(present),
          nextCursor:
            hasMore && last ? encodeCursor(last.createdAtRaw, last.address) : null,
        }
      })
    },

    async add(tenantId, address) {
      await withTenant(db, tenantId, async (tx) => {
        await tx
          .insert(suppressions)
          .values({
            tenantId,
            // ⚠ LOWERCASED HERE, BECAUSE THE SEND PATH LOOKS IT UP LOWERCASED.
            // A suppression stored as `Bob@Acme.com` would silently never match
            // and the customer would watch mail keep going to an address they
            // blocked - the worst possible failure for this particular table.
            address: address.trim().toLowerCase(),
            reason: "manual",
          })
          // Adding an address that is already suppressed is not an error; it is
          // somebody making sure.
          .onConflictDoNothing()
      })
    },

    async remove(tenantId, address, opts = {}) {
      const wanted = address.trim().toLowerCase()
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ reason: suppressions.reason, createdAt: suppressions.createdAt })
          .from(suppressions)
          .where(eq(suppressions.address, wanted))
          .limit(1),
      )
      if (!row) return "missing"
      if (row.reason === "complaint" && !opts.confirmComplaint) return "complaint"

      /*
       * ⚠ SES FIRST, OURS SECOND. The other order leaves a window - or, on a
       * failure, a permanent state - in which our list says the address is
       * clear and SES still drops every message to it. See `TenantSuppressions`.
       */
      try {
        await ses.release(sesTenantName(tenantId), wanted, row.createdAt)
      } catch (error) {
        log?.error?.(
          { err: error, tenantId },
          "could not remove an address from the SES tenant suppression list - kept ours",
        )
        return "unavailable"
      }

      const deleted = await withTenant(db, tenantId, (tx) =>
        tx
          .delete(suppressions)
          .where(eq(suppressions.address, wanted))
          .returning({ address: suppressions.address }),
      )
      return deleted.length > 0 ? "removed" : "missing"
    },

    async exportAll(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select(columns)
          .from(suppressions)
          .orderBy(desc(suppressions.createdAt), desc(suppressions.address))
          .limit(EXPORT_LIMIT)
        return rows.map(present)
      })
    },
  }
}

/**
 * The list as CSV, for the console's export.
 *
 * ⚠ EVERY FIELD QUOTED, AND A LEADING `=`, `+`, `-` OR `@` DEFUSED. An address
 * is customer-supplied text that ends up opened in a spreadsheet, and
 * `=HYPERLINK(...)@x.com` is a formula there before it is an address.
 */
export function suppressionsCsv(rows: readonly SuppressionRow[]): string {
  const cell = (value: string | null) => {
    const v = value ?? ""
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
    return `"${safe.replaceAll('"', '""')}"`
  }
  const lines = [["address", "reason", "message_id", "created_at"].map(cell).join(",")]
  for (const r of rows) {
    lines.push([r.address, r.reason, r.message_id, r.created_at].map(cell).join(","))
  }
  return `${lines.join("\r\n")}\r\n`
}

/**
 * What a removal that did not happen says, the same on both surfaces.
 *
 * ⚠ 409 FOR A COMPLAINT, NOT 403 OR 422. The caller is allowed and the request
 * is well formed; it conflicts with what the address is, and repeating it with
 * `confirm=complaint` is the fix - which the message says.
 */
export function removalRefusal(outcome: Exclude<RemoveOutcome, "removed">) {
  switch (outcome) {
    case "missing":
      return {
        status: 404 as const,
        body: {
          statusCode: 404,
          name: "not_found" as const,
          message: "That address is not suppressed.",
        },
      }
    case "complaint":
      return {
        status: 409 as const,
        body: {
          statusCode: 409,
          name: "confirmation_required" as const,
          message:
            "This recipient marked a message as spam. Removing them is a decision " +
            "with legal weight; repeat the request with `confirm=complaint` to do it.",
        },
      }
    case "unavailable":
      return {
        status: 503 as const,
        body: {
          statusCode: 503,
          name: "internal_server_error" as const,
          message:
            "Our sending provider could not be updated, so the address is still " +
            "suppressed. Try again in a minute.",
        },
      }
  }
}
