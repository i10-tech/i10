import type { Logger } from "./events.js"
import type { StalwartAccountEvent } from "./stalwart.js"

/**
 * What Stalwart tells us about a mailbox: failed sign-ins and a full quota (#384).
 *
 * ⚠ ONLY MAILBOXES WE HOST ARE RECORDED. The internet tries random usernames
 * against IMAP and submission all day, and Stalwart reports every one. An
 * account that is not a row in `authd.accounts` is noise, and writing it would
 * let a scanner grow our tables for free - so it is dropped, counted as
 * ignored, and nothing is claimed for it.
 *
 * ⚠ LOGIN FAILURES NEVER GO INTO `identity_events`. See `mailboxAuthFailures`
 * in db/core.ts: every risk reader takes a row there as the person's own
 * sighting, and a failed login is by definition not.
 */

/** Who a hosted mailbox belongs to. */
export interface MailboxOwner {
  clerkUserId: string
  /** Null for a mailbox on a domain no workspace owns - i10's own. */
  tenantId: string | null
}

export interface AccountEventOps {
  /** The hosted mailbox behind an address, or null when we do not host it. */
  mailboxOwnerOf: (address: string) => Promise<MailboxOwner | null>

  /**
   * Claims the event and, for a failed sign-in, writes its row, in one
   * transaction: a claim that survived a failed write would make the retry
   * Stalwart sends after our 500 look like a duplicate and lose the event.
   */
  recordAuthFailure: (input: {
    owner: MailboxOwner & { tenantId: string }
    event: Extract<StalwartAccountEvent, { type: "auth.failed" }>
  }) => Promise<"recorded" | "duplicate">

  /** Claims a quota event, so a second node's copy is not notified twice. */
  claimQuota: (
    event: Extract<StalwartAccountEvent, { type: "limit.quota" }>,
  ) => Promise<"recorded" | "duplicate">
}

export interface QuotaReached {
  tenantId: string
  account: string
  occurredAt: Date
}

/**
 * Where the workspace is told its mailbox is full, before mail starts to
 * bounce: over quota, inbound SMTP is deferred with 451 and bounces when the
 * queue expires.
 *
 * ⚠ ONLY LOGS TODAY, AND THAT IS A GAP, NOT A DESIGN. There is no email
 * template for it yet, so the customer is not actually told; this is the one
 * place to send it from when there is.
 */
export function notifyQuotaReached(log: Logger): (n: QuotaReached) => Promise<void> {
  return async (n) => {
    log.warn(
      {
        tenantId: n.tenantId,
        account: n.account,
        occurredAt: n.occurredAt.toISOString(),
      },
      "mailbox quota reached",
    )
  }
}

export type AccountOutcome = "recorded" | "duplicate" | "ignored"

export async function ingestAccountEvent(
  event: StalwartAccountEvent,
  deps: AccountEventOps & {
    log: Logger
    notifyQuotaReached: (n: QuotaReached) => Promise<void>
  },
): Promise<AccountOutcome> {
  const owner = await deps.mailboxOwnerOf(event.account)
  // Not ours, or ours with no workspace to score or tell. i10's own mailboxes
  // are the second case: the risk score and the quota notice are both a
  // workspace's, and there is nobody to hand them to.
  if (!owner || !owner.tenantId) return "ignored"
  const tenantId = owner.tenantId

  if (event.type === "auth.failed") {
    return deps.recordAuthFailure({ owner: { ...owner, tenantId }, event })
  }

  const claimed = await deps.claimQuota(event)
  if (claimed === "duplicate") return claimed

  // ⚠ AFTER THE CLAIM, SO A FAILURE HERE CANNOT BE RETRIED INTO A SECOND
  // NOTICE - and for the same reason it must not fail the batch: a 500 would
  // replay it, find the claim, and lose the notice anyway. Best effort, loudly.
  try {
    await deps.notifyQuotaReached({
      tenantId,
      account: event.account,
      occurredAt: event.occurredAt,
    })
  } catch (err) {
    deps.log.error({ err, tenantId, account: event.account }, "quota notice failed")
  }
  return "recorded"
}
