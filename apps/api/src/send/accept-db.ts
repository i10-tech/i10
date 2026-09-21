import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm"
import type { Queue } from "groupmq"
import { withTenant, type Database } from "../db/client.js"
import {
  domains as domainsTable,
  idempotencyKeys,
  messageBodies,
  messages,
  suppressions,
} from "../db/core.js"
import { enqueueBatch, type SendClass, type SendJob } from "../queue/send-queue.js"
import { addrSpec, asList, type AcceptOps } from "./accept.js"

/**
 * The accept path, bound to Postgres and to the two queues.
 *
 * This is the half of `acceptSend` that touches the world. What it has to
 * guarantee is narrow and unforgiving:
 *
 *   1. ONE TRANSACTION. Messages, bodies and the idempotency row commit
 *      together or not at all. A body without its message is unsendable; a
 *      message without its body sends an empty email.
 *   2. ORDER PRESERVED. `refs[i]` and `ids[i]` must describe `messages[i]` —
 *      the caller filters refs by index against the prepared messages, and the
 *      batch response is read positionally by every SDK. A shuffle here sends
 *      one customer's email to another customer's recipient.
 *   3. THE COMMIT HAPPENS BEFORE THE ENQUEUE, which is the caller's job and the
 *      reason `persist` and `enqueue` are two methods rather than one.
 *
 * ⚠ EVERY STATEMENT RUNS INSIDE `withTenant`. Row level security is the tenant
 * boundary, `app.tenant_id` is what the policies read, and a transaction that
 * never sets it raises rather than returning nothing — see db/client.ts.
 */

export interface SendPathOptions {
  db: Database
  /** One queue per class. Both are constructed at boot; see queue/send-queue.ts. */
  queues: Record<SendClass, Queue<SendJob>>
  /**
   * Domains this particular ops object may send from without a verified row.
   *
   * ⚠ IT EXISTS FOR i10'S OWN MAIL AND FOR NOTHING ELSE. Authentication email
   * leaves from `AUTH_EMAIL_FROM` on a domain we host ourselves — and
   * `DomainStore.create` REFUSES to create a row for our own sending domains,
   * deliberately, so there is no verified row for the gate to find and never
   * will be. Without this, turning the gate on would have stopped every
   * password reset and every verification code in the product.
   *
   * ⚠ AND IT IS SCOPED BY CONSTRUCTION RATHER THAN BY A FLAG ON THE REQUEST,
   * WHICH IS THE WHOLE REASON IT IS SAFE. The auth-email path builds its own
   * ops object with this set; the customer-facing `sendPath` builds one
   * without it. A customer's request never reaches an object carrying the
   * exemption, so there is no field for anybody to set, copy or guess — see
   * where both are constructed in index.ts.
   */
  alwaysSendable?: readonly string[]
}

type Row = Record<string, unknown>

export function acceptDatabaseOps(opts: SendPathOptions): AcceptOps {
  return {
    async persist(input) {
      return withTenant(opts.db, input.tenantId, async (tx) => {
        if (input.idempotencyKey) {
          // ⚠ THE KEY IS INSERTED BEFORE THE MESSAGES, AND THE PRIMARY KEY IS
          // THE LOCK. `on conflict do nothing` BLOCKS on a conflicting row that
          // another transaction has written but not yet committed, so of two
          // simultaneous retries one inserts and the other waits — and by the
          // time the loser reads, the winner's ids are there to return.
          //
          // Reading first and inserting second would let both miss, both mint a
          // full set of messages and both enqueue: the duplicate send this
          // header exists to prevent, arriving precisely under the double-post
          // it is supposed to absorb.
          const claimed = await tx
            .insert(idempotencyKeys)
            .values({
              tenantId: input.tenantId,
              key: input.idempotencyKey,
              requestHash: input.requestHash,
            })
            .onConflictDoNothing()
            .returning({ key: idempotencyKeys.key })

          if (claimed.length === 0) {
            const [prior] = await tx
              .select({
                requestHash: idempotencyKeys.requestHash,
                messageIds: idempotencyKeys.messageIds,
              })
              .from(idempotencyKeys)
              .where(
                and(
                  eq(idempotencyKeys.tenantId, input.tenantId),
                  eq(idempotencyKeys.key, input.idempotencyKey),
                ),
              )
              .limit(1)

            // ⚠ ANYTHING WE CANNOT ANSWER WITH THE ORIGINAL IDS IS A CONFLICT,
            // NEVER A SECOND SEND. A different hash is the ordinary case. A row
            // that vanished between the insert and this read is the 24-hour
            // prune racing a very late retry, and a row with no ids should be
            // impossible — the ids are written in the same transaction that
            // created it. In all three the honest answer is "your key is
            // ambiguous, use a new one", because the alternative is sending
            // mail the caller may already have sent.
            if (!prior || prior.requestHash !== input.requestHash) {
              return { status: "conflict" as const }
            }
            if (!prior.messageIds || prior.messageIds.length === 0) {
              return { status: "conflict" as const }
            }
            return { status: "replayed" as const, ids: prior.messageIds }
          }
        }

        // ⚠ IDS MINTED UP FRONT, IN ONE ROUND TRIP, RATHER THAN READ BACK FROM
        // `RETURNING`. A multi-row INSERT gives no ordinal to correlate on, and
        // RETURNING's row order is not contractual — so the only way to know
        // which id belongs to which submitted email would be to trust an
        // ordering Postgres does not promise. Generating them first makes the
        // mapping ours: `ids[i]` is `input.messages[i]`, by construction.
        //
        // `uuidv7()` and `now()` come from the database rather than from Node so
        // that the id's embedded timestamp, the partition key and every other
        // row written in this transaction agree on one clock.
        const minted = (await tx.execute(
          sql`select uuidv7() as id, now() as minted_at
                from generate_series(1, ${input.messages.length}::int)`,
        )) as unknown as Row[]

        const ids = minted.map((r) => String(r.id))
        // postgres-js parses `timestamptz` into a Date; the copy costs nothing
        // and means a driver that hands back a string is not a silent NaN.
        const createdAt = new Date(minted[0]!.minted_at as string | Date)

        // ⚠ NO LOOKUP ANY MORE, AND ONE FEWER STATEMENT ON THE SEND PATH. This
        // used to translate Clerk's `ak_…` into our own row id, best-effort,
        // because a key minted seconds earlier might not have reached this
        // table yet. Self-issued keys ARE this table, so `apiKeyId` is already
        // the foreign key — and it cannot be missing, because the request could
        // not have authenticated without the row it names.
        await tx.insert(messages).values(
          input.messages.map((m, i) => ({
            id: ids[i]!,
            createdAt,
            tenantId: input.tenantId,
            apiKeyId: input.apiKeyId,
            queue: input.queue,
            fromAddress: m.payload.from,
            toAddresses: m.to,
            ccAddresses: m.cc,
            bccAddresses: m.bcc,
            replyTo: asList(m.payload.reply_to),
            subject: m.payload.subject,
            // ⚠ AND THE CLAIM READS IT. The queue delays the job, but this
            // column is what actually refuses an early send — see db/claim.ts.
            // A row written without it would be sendable the moment anything
            // re-enqueued it.
            scheduledAt: m.scheduledAt,
          })),
        )

        // ⚠ A SEPARATE TABLE, SAME TRANSACTION, SAME PARTITION KEY. The bodies
        // are split off so the claim and the dashboard never drag an HTML body
        // through their scans — but a message whose body never committed sends
        // an empty email, so the split is physical and never transactional.
        //
        // Attachments live here rather than in object storage because the
        // contract caps them, so the row cannot grow without limit — and the
        // alternative would put a second store with its own lifecycle and its
        // own access control in front of every send.
        await tx.insert(messageBodies).values(
          input.messages.map((m, i) => ({
            messageId: ids[i]!,
            createdAt,
            tenantId: input.tenantId,
            text: m.payload.text ?? null,
            html: m.payload.html ?? null,
            headers: m.payload.headers ?? null,
            attachments: m.payload.attachments ?? null,
            tags: m.payload.tags ?? null,
          })),
        )

        if (input.idempotencyKey) {
          await tx
            .update(idempotencyKeys)
            .set({ messageIds: ids })
            .where(
              and(
                eq(idempotencyKeys.tenantId, input.tenantId),
                eq(idempotencyKeys.key, input.idempotencyKey),
              ),
            )
        }

        return {
          status: "written" as const,
          ids,
          refs: ids.map((id) => ({ id, createdAt })),
        }
      })
    },

    async suppressedFor(tenantId, addresses) {
      // ⚠ NORMALISED THE SAME WAY ON BOTH SIDES. The set this returns is
      // compared against `addrSpec()` of each recipient, so the lookup has to
      // use the same form — otherwise `Bob <bob@x.com>` misses a suppression on
      // `bob@x.com` and the bounced address is sent to again.
      const wanted = [...new Set(addresses.map(addrSpec))].filter(Boolean)
      if (wanted.length === 0) return new Set<string>()

      return withTenant(opts.db, tenantId, async (tx) => {
        const rows = await tx
          .select({ address: suppressions.address })
          .from(suppressions)
          .where(inArray(suppressions.address, wanted))

        return new Set(rows.map((r) => r.address))
      })
    },

    /**
     * ⚠ `verified_at IS NOT NULL` RATHER THAN `status = 'verified'`, WHICH IS
     * WHAT THE COLUMN WAS WRITTEN FOR. `status` is SES's current opinion and
     * moves both ways — a domain that has sent for months can read
     * `temporary_failure` because one DKIM lookup timed out, and stopping that
     * customer's mail over a transient is a far worse failure than the one this
     * gate exists to prevent. `verified_at` is stamped once and never moved
     * backwards, and `store.ts` already says the send path reads it as "has
     * this ever been proven".
     *
     * ⚠ AND `status <> 'failed'` IS THE HALF THAT MAKES IT SAFE, because
     * `core.displace_domain` sets `failed` and LEAVES `verified_at` ALONE. That
     * function is how a domain is taken from a workspace that no longer proves
     * it — a lapsed registration, a name that moved to somebody else, a proof
     * missing past the grace period. On `verified_at` alone, every displaced
     * domain would keep its ability to send, which is precisely backwards: the
     * one case where we are most sure the sender is no longer the owner.
     */
    async sendableFrom(tenantId, domains) {
      const wanted = [...new Set(domains.map((d) => d.trim().toLowerCase()))].filter(
        Boolean,
      )
      if (wanted.length === 0) return new Set<string>()

      const always = new Set(
        (opts.alwaysSendable ?? []).map((d) => d.trim().toLowerCase()),
      )
      const toCheck = wanted.filter((d) => !always.has(d))
      const allowed = new Set(wanted.filter((d) => always.has(d)))
      if (toCheck.length === 0) return allowed

      const rows = await withTenant(opts.db, tenantId, async (tx) =>
        tx
          .select({ name: domainsTable.name })
          .from(domainsTable)
          .where(
            and(
              inArray(domainsTable.name, toCheck),
              isNotNull(domainsTable.verifiedAt),
              ne(domainsTable.status, "failed"),
            ),
          ),
      )

      for (const row of rows) allowed.add(row.name.toLowerCase())
      return allowed
    },

    async enqueue(queue, job, options) {
      await enqueueBatch(opts.queues[queue], job, options)
    },
  }
}
