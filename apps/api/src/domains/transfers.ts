import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import { apiKeys, delegations, domains, domainTransfers } from "../db/core.js"
import { domainScope, scopedDomains } from "../auth/scope.js"
import { SENDING_DOMAINS, type Capacity, type Logger } from "./store.js"

/**
 * Offering a domain to somebody by email, and them accepting it.
 *
 * ⚠ AN OFFER MOVES NOTHING. The domain keeps sending from the workspace that
 * made it until the recipient accepts, and the sender can withdraw it until
 * then. Accepting is the only thing that moves a domain between workspaces
 * without anybody proving it in DNS - so it is the one step that requires the
 * recipient to be signed in with the address the offer names, verified.
 *
 * ⚠ ROW LEVEL SECURITY ON EVERY STATEMENT, AND NO DEFINER FUNCTION. The sender
 * reads and writes offers as its own tenant. The recipient reads them through
 * the second policy on `core.domain_transfers`, which admits only rows
 * addressed to one of `app.recipient_emails` - set here, per transaction, from
 * Clerk's verified addresses and never from the request. The move itself is
 * done as the sender to delete and as the receiver to insert, so neither half
 * can touch a row outside its own tenant.
 */

/** How long an offer stays open. Long enough to sign up; short enough to forget. */
const OFFER_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** A plausible address - no comma, which would split the policy's list. */
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/

export const normaliseEmail = (raw: string): string | null => {
  const email = raw.trim().toLowerCase()
  return EMAIL.test(email) ? email : null
}

export interface TransferOffer {
  id: string
  domain_id: string
  domain_name: string
  recipient_email: string
  offered_by: string
  from_workspace: string
  created_at: string
  expires_at: string
}

export type OfferOutcome =
  | { status: "offered"; offer: TransferOffer }
  | { status: "missing" }
  | { status: "rejected"; reason: string }

/**
 * What accepting did to the SENDER's keys.
 *
 * ⚠ KEYS NEVER MOVE WITH A DOMAIN. They are the sender's, saved in the
 * sender's systems; handing one to the recipient would give a stranger a
 * credential somebody else holds. So a key limited to only this domain is
 * revoked - it could send from nothing - and a key limited to this domain and
 * others simply loses this one. Unrestricted keys are untouched.
 */
export interface KeyChanges {
  revoked: number
  narrowed: number
  /** For the caller to evict from the key cache after the commit. */
  secretHashes: string[]
}

export type AcceptOutcome =
  | { status: "accepted"; domainId: string; domainName: string; keys: KeyChanges }
  | { status: "missing" }
  | { status: "rejected"; reason: string }
  | { status: "conflict"; reason: string }
  | { status: "limit"; reason: string }

export interface DomainTransfers {
  offer(
    tenantId: string,
    domainId: string,
    input: { email: string; offeredBy: string; fromWorkspace: string },
  ): Promise<OfferOutcome>
  /** The open offer for one of this workspace's domains, if any. */
  outgoing(tenantId: string, domainId: string): Promise<TransferOffer | null>
  cancel(tenantId: string, domainId: string): Promise<boolean>
  /** Open offers addressed to any of `emails`. `tenantId` is the caller's own. */
  incoming(tenantId: string, emails: string[]): Promise<TransferOffer[]>
  /**
   * One open offer, with the sending workspace's tenant id - the caller needs
   * it to leave that workspace out of the choice of destination, and it never
   * reaches a response.
   */
  find(
    tenantId: string,
    emails: string[],
    id: string,
  ): Promise<(TransferOffer & { fromTenantId: string }) | null>
  accept(input: {
    /** The caller's session tenant - only to satisfy the sender policy's setting. */
    tenantId: string
    emails: string[]
    id: string
    /** Where it lands. Already checked against the person's memberships. */
    toTenantId: string
  }): Promise<AcceptOutcome>
  decline(tenantId: string, emails: string[], id: string): Promise<boolean>
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

const OFFER_COLUMNS = {
  id: domainTransfers.id,
  tenantId: domainTransfers.tenantId,
  domainId: domainTransfers.domainId,
  domainName: domainTransfers.domainName,
  recipientEmail: domainTransfers.recipientEmail,
  offeredBy: domainTransfers.offeredBy,
  fromWorkspace: domainTransfers.fromWorkspace,
  createdAt: domainTransfers.createdAt,
  expiresAt: domainTransfers.expiresAt,
}

type OfferRow = {
  id: string
  tenantId: string
  domainId: string
  domainName: string
  recipientEmail: string
  offeredBy: string
  fromWorkspace: string
  createdAt: Date
  expiresAt: Date
}

const present = (r: OfferRow): TransferOffer => ({
  id: r.id,
  domain_id: r.domainId,
  domain_name: r.domainName,
  recipient_email: r.recipientEmail,
  offered_by: r.offeredBy,
  from_workspace: r.fromWorkspace,
  created_at: r.createdAt.toISOString(),
  expires_at: r.expiresAt.toISOString(),
})

const isUniqueViolation = (error: unknown) =>
  (error as { code?: string }).code === "23505"

/*
 * ⚠ ONE PARAMETER CARRYING A LIST, NOT ONE PER ADDRESS. The policy splits it on
 * commas, which `normaliseEmail` refuses inside an address. An empty list sets
 * an empty string, which the policy reads as "nobody".
 */
const asTenant = (tx: Tx, tenantId: string) =>
  tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`)
const asRecipient = (tx: Tx, emails: string[]) =>
  tx.execute(
    sql`select set_config('app.recipient_emails', ${cleanEmails(emails).join(",")}, true)`,
  )

function cleanEmails(emails: string[]): string[] {
  return [...new Set(emails.flatMap((e) => normaliseEmail(e) ?? []))]
}

/** Open: not answered, not withdrawn, not expired. */
const open = (at: Date) =>
  and(
    isNull(domainTransfers.acceptedAt),
    isNull(domainTransfers.declinedAt),
    isNull(domainTransfers.canceledAt),
    gt(domainTransfers.expiresAt, at),
  )

/**
 * Moves one domain row, with its delegation claim, between two tenants.
 *
 * ⚠ THE ROW MOVES, NOT A COPY OF ITS NAME. Its DKIM key, its delegation token
 * and its claim go with it, so the records already in the customer's DNS keep
 * proving it and nothing has to be republished. The SES identity and the zones
 * are keyed on the name and are untouched. The id is kept: messages already
 * sent reference it, and the sender keeps their history.
 *
 * ⚠ RUNS INSIDE THE CALLER'S TRANSACTION, so a failure anywhere after it rolls
 * the move back too. It leaves `app.tenant_id` set to `to`.
 */
async function moveDomain(
  tx: Tx,
  from: string,
  id: string,
  to: string,
): Promise<"moved" | "missing" | "mailboxes"> {
  await asTenant(tx, from)

  const [moving] = await tx
    .select()
    .from(domains)
    .where(and(eq(domains.tenantId, from), eq(domains.id, id)))
    .limit(1)
  if (!moving) return "missing"

  /*
   * ⚠ A MAILBOX DOMAIN IS NOT MOVABLE. Its addresses are local recipients with
   * people behind them, and moving the domain would move where their mail
   * lands without moving them.
   */
  if (moving.hostsMailboxes) return "mailboxes"

  const [claim] = await tx
    .select({
      name: delegations.name,
      domainId: delegations.domainId,
      claimedAt: delegations.claimedAt,
    })
    .from(delegations)
    .where(and(eq(delegations.tenantId, from), eq(delegations.domainId, id)))
    .limit(1)

  // ⚠ THE CLAIM CASCADES WITH THE ROW, which is why it was read first.
  await tx.delete(domains).where(and(eq(domains.tenantId, from), eq(domains.id, id)))

  await asTenant(tx, to)

  await tx.insert(domains).values({ ...moving, tenantId: to, updatedAt: new Date() })
  if (claim) await tx.insert(delegations).values({ ...claim, tenantId: to })

  return "moved"
}

/**
 * Revokes or narrows the sender's keys that were limited to a departing domain.
 *
 * ⚠ AS THE SENDER, IN THE ACCEPTING TRANSACTION. The keys are the sender's
 * rows, so row level security needs their tenant; and if anything after this
 * fails, the domain and the keys roll back together - a key must never be left
 * scoped to a domain that did not actually leave, nor live for one that did.
 *
 * ⚠ THE MATCH IS ONE BOUND STRING AGAINST THE ARRAY, NOT AN ARRAY PARAMETER.
 * Drizzle expands a JS array in `sql` into a row constructor; `= any(column)`
 * with a single parameter is the shape that cannot go wrong.
 */
async function releaseKeys(
  tx: Tx,
  from: string,
  name: string,
  at: Date,
): Promise<KeyChanges> {
  await asTenant(tx, from)
  const scope = domainScope(name)

  const held = await tx
    .select({ id: apiKeys.id, scopes: apiKeys.scopes, secretHash: apiKeys.secretHash })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.tenantId, from),
        isNull(apiKeys.revokedAt),
        sql`${scope} = any(${apiKeys.scopes})`,
      ),
    )

  const changes: KeyChanges = { revoked: 0, narrowed: 0, secretHashes: [] }
  for (const key of held) {
    const remaining = key.scopes.filter((s) => s !== scope)
    const onlyThis = scopedDomains(remaining).length === 0

    await tx
      .update(apiKeys)
      .set(onlyThis ? { revokedAt: at } : { scopes: remaining })
      .where(and(eq(apiKeys.tenantId, from), eq(apiKeys.id, key.id)))

    if (onlyThis) changes.revoked += 1
    else changes.narrowed += 1
    changes.secretHashes.push(key.secretHash)
  }
  return changes
}

export function domainTransferStore({
  db,
  capacity,
  log,
  now = () => new Date(),
  ttlMs = OFFER_TTL_MS,
}: {
  db: Database
  capacity: Capacity
  log?: Logger
  now?: () => Date
  ttlMs?: number
}): DomainTransfers {
  return {
    async offer(tenantId, domainId, input) {
      const email = normaliseEmail(input.email)
      if (!email)
        return { status: "rejected", reason: `${input.email} is not an email address.` }

      return db.transaction(async (tx): Promise<OfferOutcome> => {
        await asTenant(tx, tenantId)

        const [domain] = await tx
          .select({ name: domains.name, hostsMailboxes: domains.hostsMailboxes })
          .from(domains)
          .where(and(eq(domains.tenantId, tenantId), eq(domains.id, domainId)))
          .limit(1)
        if (!domain) return { status: "missing" }
        if (domain.hostsMailboxes) {
          return {
            status: "rejected",
            reason: `${domain.name} hosts mailboxes, so it cannot be transferred.`,
          }
        }

        // ⚠ A NEW OFFER REPLACES THE OLD ONE - including an expired one, which
        // still holds the open-offer index because expiry is not in it.
        await tx
          .update(domainTransfers)
          .set({ canceledAt: now() })
          .where(
            and(
              eq(domainTransfers.tenantId, tenantId),
              eq(domainTransfers.domainId, domainId),
              isNull(domainTransfers.acceptedAt),
              isNull(domainTransfers.declinedAt),
              isNull(domainTransfers.canceledAt),
            ),
          )

        const [row] = await tx
          .insert(domainTransfers)
          .values({
            tenantId,
            domainId,
            domainName: domain.name,
            recipientEmail: email,
            offeredBy: input.offeredBy,
            fromWorkspace: input.fromWorkspace,
            expiresAt: new Date(now().getTime() + ttlMs),
          })
          .returning(OFFER_COLUMNS)

        log?.warn(
          { domain: domain.name, tenantId, to: email },
          "domain transfer offered",
        )
        return { status: "offered", offer: present(row as OfferRow) }
      })
    },

    async outgoing(tenantId, domainId) {
      return db.transaction(async (tx) => {
        await asTenant(tx, tenantId)
        const [row] = await tx
          .select(OFFER_COLUMNS)
          .from(domainTransfers)
          .where(
            and(
              eq(domainTransfers.tenantId, tenantId),
              eq(domainTransfers.domainId, domainId),
              open(now()),
            ),
          )
          .limit(1)
        return row ? present(row as OfferRow) : null
      })
    },

    async cancel(tenantId, domainId) {
      return db.transaction(async (tx) => {
        await asTenant(tx, tenantId)
        const rows = await tx
          .update(domainTransfers)
          .set({ canceledAt: now() })
          .where(
            and(
              eq(domainTransfers.tenantId, tenantId),
              eq(domainTransfers.domainId, domainId),
              isNull(domainTransfers.acceptedAt),
              isNull(domainTransfers.declinedAt),
              isNull(domainTransfers.canceledAt),
            ),
          )
          .returning({ id: domainTransfers.id })
        return rows.length > 0
      })
    },

    async incoming(tenantId, emails) {
      const mine = cleanEmails(emails)
      if (mine.length === 0) return []
      return db.transaction(async (tx) => {
        await asTenant(tx, tenantId)
        await asRecipient(tx, mine)
        /*
         * ⚠ THE ADDRESS IS FILTERED HERE TOO, NOT LEFT TO THE POLICY ALONE.
         * The sender policy also matches - a workspace offering a domain to its
         * own member would otherwise see that offer listed as incoming.
         */
        const rows = await tx
          .select(OFFER_COLUMNS)
          .from(domainTransfers)
          .where(and(inArray(domainTransfers.recipientEmail, mine), open(now())))
          .orderBy(desc(domainTransfers.createdAt))
        return rows.map((r) => present(r as OfferRow))
      })
    },

    async find(tenantId, emails, id) {
      const mine = cleanEmails(emails)
      if (mine.length === 0) return null
      return db.transaction(async (tx) => {
        await asTenant(tx, tenantId)
        await asRecipient(tx, mine)
        const [row] = await tx
          .select(OFFER_COLUMNS)
          .from(domainTransfers)
          .where(
            and(
              eq(domainTransfers.id, id),
              inArray(domainTransfers.recipientEmail, mine),
              open(now()),
            ),
          )
          .limit(1)
        return row ? { ...present(row as OfferRow), fromTenantId: row.tenantId } : null
      })
    },

    async accept({ tenantId, emails, id, toTenantId }) {
      const mine = cleanEmails(emails)
      if (mine.length === 0) return { status: "missing" }

      // ⚠ THE RECEIVING WORKSPACE'S LIMIT. Accepting is an add from its point
      // of view, and a plan must not be walked past by moving a domain in.
      const room = await capacity.check({
        tenantId: toTenantId,
        featureId: SENDING_DOMAINS,
        requested: 1,
        at: now(),
      })
      if (room.status === "exceeded") {
        return {
          status: "limit",
          reason: "That workspace has used every domain its plan includes.",
        }
      }

      try {
        return await db.transaction(async (tx): Promise<AcceptOutcome> => {
          await asTenant(tx, tenantId)
          await asRecipient(tx, mine)

          /*
           * ⚠ LOCKED, SO TWO ACCEPTS OF ONE OFFER CANNOT BOTH MOVE IT. The
           * second waits here and then finds it answered.
           */
          const [offer] = await tx
            .select(OFFER_COLUMNS)
            .from(domainTransfers)
            .where(
              and(
                eq(domainTransfers.id, id),
                inArray(domainTransfers.recipientEmail, mine),
                open(now()),
              ),
            )
            .limit(1)
            .for("update")
          if (!offer) return { status: "missing" }

          if (offer.tenantId === toTenantId) {
            return {
              status: "rejected",
              reason:
                `${offer.domainName} is already in that workspace. Choose ` +
                `another workspace to move it into.`,
            }
          }

          const moved = await moveDomain(tx, offer.tenantId, offer.domainId, toTenantId)
          if (moved === "missing") return { status: "missing" }
          if (moved === "mailboxes") {
            return {
              status: "rejected",
              reason: `${offer.domainName} hosts mailboxes, so it cannot be transferred.`,
            }
          }

          const keys = await releaseKeys(tx, offer.tenantId, offer.domainName, now())

          // ⚠ ANSWERED UNDER THE RECIPIENT POLICY - `app.recipient_emails` is
          // still set in this transaction.
          await tx
            .update(domainTransfers)
            .set({ acceptedAt: now(), acceptedTenantId: toTenantId })
            .where(eq(domainTransfers.id, id))

          log?.warn(
            { domain: offer.domainName, from: offer.tenantId, to: toTenantId },
            "domain transfer accepted",
          )
          return {
            status: "accepted",
            domainId: offer.domainId,
            domainName: offer.domainName,
            keys,
          }
        })
      } catch (error) {
        // `domains_tenant_name_unique`: the receiving workspace already has it.
        if (isUniqueViolation(error)) {
          return {
            status: "conflict",
            reason:
              "That workspace already has this domain. Delete it there first, " +
              "then accept again.",
          }
        }
        throw error
      }
    },

    async decline(tenantId, emails, id) {
      const mine = cleanEmails(emails)
      if (mine.length === 0) return false
      return db.transaction(async (tx) => {
        await asTenant(tx, tenantId)
        await asRecipient(tx, mine)
        const rows = await tx
          .update(domainTransfers)
          .set({ declinedAt: now() })
          .where(
            and(
              eq(domainTransfers.id, id),
              inArray(domainTransfers.recipientEmail, mine),
              open(now()),
            ),
          )
          .returning({ id: domainTransfers.id })
        return rows.length > 0
      })
    },
  }
}
