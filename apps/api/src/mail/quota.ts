import { accounts } from "../db/schema.js"
import type { Database } from "../db/client.js"
import { findRegistryAccount, JmapAsError } from "./jmap-as.js"
import { listRegistryAccounts, type StalwartCaller } from "./stalwart.js"
import type { Logger } from "./storage.js"

/**
 * Mailbox storage quotas, from our database to Stalwart's `maxDiskQuota`.
 *
 * ⚠ OUR DATABASE IS THE SOURCE OF TRUTH. `authd.accounts.storage_allocation` is
 * what a workspace's owner or admin decided (see mailboxes/allocation.ts); the
 * quota in Stalwart is a copy that enforces it, and the reconcile below puts
 * any account that drifted back. Nothing here reads a quota out of Stalwart to
 * decide what an allocation is.
 *
 * ⚠ NEVER CREATE A STALWART ACCOUNT. Only accounts that come from the authd
 * LDAP directory are mailboxes: one created directly in the registry is refused
 * at RCPT with `550 5.1.1 Mailbox does not exist` (C5 probe, 1.0.3). The registry
 * keeps an account for each LDAP mailbox once it has been seen, so this finds
 * that account and updates its quota. When there is none yet, the push is
 * skipped and the reconcile applies it after the account appears.
 *
 * A quota set on an LDAP-backed account survives the login-time directory sync
 * (probed on prod, 1.0.3), which is why the reconcile is a safety net and the
 * push on change is the mechanism.
 */

/**
 * What an inbox with no allocation gets, in bytes: 100 GiB.
 *
 * ⚠ FINITE ON PURPOSE. IMAP clients (Apple Mail among them) and JMAP clients
 * read the server's quota and draw usage against it; with none they show no
 * gauge, and with a small one a mailbox that is not full looks it. 100 GiB is
 * beyond what an uncapped PAYG inbox reaches in practice, and it is billed on
 * usage, not on this number.
 *
 * ⚠ THE DEFAULT IS OUTSIDE EVERY POOL, SO IT MUST STAY RARE ON A PLAN. It is
 * for PAYG inboxes with no cap, where nothing is prepaid, and for plan inboxes
 * that predate allocation, which keep it so no live mailbox starts bouncing and
 * are reported as `unallocated` until an admin gives them a number (see
 * mailboxes/allocation.ts). A plan inbox created from now on always carries one.
 */
export const DEFAULT_MAILBOX_QUOTA_BYTES = 100 * 1024 * 1024 * 1024

/**
 * The quota an allocation maps to.
 *
 * ⚠ AN ALLOCATION OF ZERO IS NEVER PUSHED. Whether Stalwart reads a
 * `maxDiskQuota` of 0 as "none" or as "unlimited" was not probed, and a wrong
 * guess is an unbounded mailbox. Allocations are positive integers (the contract
 * and a CHECK on the column), so a non-positive value here means "no allocation".
 */
export function effectiveMailboxQuota(allocation: number | null | undefined): number {
  return typeof allocation === "number" &&
    Number.isInteger(allocation) &&
    allocation > 0
    ? allocation
    : DEFAULT_MAILBOX_QUOTA_BYTES
}

/** Accounts per `x:Account/set`, so one reconcile of a large directory is a few calls. */
const SET_CHUNK = 100

/**
 * Sets `quotas.maxDiskQuota` on registry accounts and returns the ids Stalwart
 * refused. Throws only when the whole call fails (unreachable, a JMAP error).
 *
 * ⚠ THE MAP IS WRITTEN WHOLE, AS PROBED: `quotas: {"maxDiskQuota": n}` is stored
 * and read back as written. No other quota key is set anywhere, so nothing else
 * is lost; a JMAP patch path was not probed and is not used.
 */
async function setQuotas(
  call: StalwartCaller,
  quotas: ReadonlyMap<string, number>,
): Promise<Map<string, string>> {
  const refused = new Map<string, string>()
  const entries = [...quotas]

  for (let i = 0; i < entries.length; i += SET_CHUNK) {
    const update = Object.fromEntries(
      entries
        .slice(i, i + SET_CHUNK)
        .map(([id, bytes]) => [id, { quotas: { maxDiskQuota: bytes } }]),
    )
    const [, result] = await call([["x:Account/set", { update }, "quota"]])

    const notUpdated = (result.notUpdated ?? {}) as Record<
      string,
      { type?: string; description?: string }
    >
    for (const [id, why] of Object.entries(notUpdated)) {
      refused.set(id, `${why.type ?? "unknown"} ${why.description ?? ""}`.trim())
    }
  }

  return refused
}

export interface PushQuotaResult {
  status: "updated" | "no_registry_account"
}

/**
 * Pushes one mailbox's quota to Stalwart.
 *
 * ⚠ FOUND BY THE SHARED B6 LOOKUP, NOT BY SCANNING THE REGISTRY: `x:Account/query`
 * on the exact local part, then `x:Account/get` and an exact address match
 * (`findRegistryAccount`). One mailbox costs two small calls however many
 * accounts Stalwart holds.
 *
 * Throws when Stalwart is unreachable or refuses; the caller decides whether
 * that matters (an allocation is saved regardless - see `mailboxes/allocation.ts`).
 */
export async function pushMailboxQuota(input: {
  call: StalwartCaller
  address: string
  quotaBytes: number
  log?: Logger
}): Promise<PushQuotaResult> {
  const { call, quotaBytes, log } = input
  const address = input.address.trim().toLowerCase()

  let account: { id: string; "@type"?: unknown }
  try {
    account = await findRegistryAccount(
      async (methodCalls) => (await call(methodCalls))[1],
      address,
    )
  } catch (error) {
    // Not there yet: the reconcile applies the quota once the account exists.
    if (
      error instanceof JmapAsError &&
      (error.code === "no_account" || error.code === "address_mismatch")
    ) {
      log?.info({ address }, "no registry account yet; quota left for the reconcile")
      return { status: "no_registry_account" }
    }
    throw error
  }

  // A group is a delivery target with no store of its own, so it has no quota.
  if (account["@type"] === "Group") {
    throw new Error(`${address} is a group, not a mailbox`)
  }

  const refused = await setQuotas(call, new Map([[account.id, quotaBytes]]))
  const why = refused.get(account.id)
  if (why !== undefined) throw new Error(`stalwart refused the quota update: ${why}`)

  log?.info({ address, quotaBytes }, "mailbox quota pushed to stalwart")
  return { status: "updated" }
}

export interface ReconcileQuotaReport {
  mailboxes: number
  inSync: number
  repaired: number
  /** No registry account yet, so nothing to compare. */
  skipped: number
  failed: number
}

/**
 * Sets every drifted account back to what our database says.
 *
 * ⚠ A WHOLE-DIRECTORY SCAN IS RIGHT HERE, UNLIKE THE PUSH. This runs on the
 * reconcile job's cadence with nobody waiting, and compares every mailbox, in
 * the same listing `sampleStorage` uses. It reads no usage: per-tenant usage is
 * what `sampleStorage` already writes to `core.tenant_storage`, and a second
 * per-mailbox copy would be one more number to go stale.
 */
export async function reconcileQuotas(input: {
  db: Database
  call: StalwartCaller
  log?: Logger
}): Promise<ReconcileQuotaReport> {
  const { db, call, log } = input

  const registry = new Map<string, { id: string; max: number | null }>()
  for (const account of await listRegistryAccounts(call)) {
    const email = account.emailAddress
    // A group is a delivery target with no store, so no quota to hold.
    if (typeof email !== "string" || account["@type"] === "Group") continue
    const quotas = account.quotas as Record<string, unknown> | undefined
    registry.set(email.toLowerCase(), {
      id: String(account.id),
      max: typeof quotas?.maxDiskQuota === "number" ? quotas.maxDiskQuota : null,
    })
  }

  const rows = await db
    .select({ email: accounts.email, allocation: accounts.storageAllocation })
    .from(accounts)

  const report: ReconcileQuotaReport = {
    mailboxes: rows.length,
    inSync: 0,
    repaired: 0,
    skipped: 0,
    failed: 0,
  }

  const drifted = new Map<string, { email: string; from: number | null; to: number }>()
  for (const row of rows) {
    const remote = registry.get(row.email.toLowerCase())
    if (!remote) {
      report.skipped += 1
      continue
    }

    const wanted = effectiveMailboxQuota(row.allocation)
    if (remote.max === wanted) {
      report.inSync += 1
      continue
    }
    drifted.set(remote.id, { email: row.email, from: remote.max, to: wanted })
  }

  if (drifted.size > 0) {
    let refused: Map<string, string>
    try {
      refused = await setQuotas(
        call,
        new Map([...drifted].map(([id, d]) => [id, d.to])),
      )
    } catch (error) {
      // The next run tries them again.
      report.failed += drifted.size
      log?.error({ err: error }, "mailbox quota reconcile failed")
      return report
    }

    for (const [id, d] of drifted) {
      const why = refused.get(id)
      if (why !== undefined) {
        report.failed += 1
        log?.error({ address: d.email, why }, "stalwart refused a quota repair")
        continue
      }
      report.repaired += 1
      log?.info(
        { address: d.email, from: d.from, to: d.to },
        "mailbox quota drift repaired",
      )
    }
  }

  return report
}
