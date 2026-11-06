import { and, eq, sql } from "drizzle-orm"
import { entitlementFor, type Assignment, type AssignmentStore } from "@repo/metering"
import { withTenant, type Database } from "../db/client.js"
import { accounts } from "../db/schema.js"
import { effectiveMailboxQuota, pushMailboxQuota } from "../mail/quota.js"
import type { StalwartCaller } from "../mail/stalwart.js"
import type { Logger } from "../mail/storage.js"
import { STORAGE, storageStatement } from "../metering/levels.js"

/**
 * How a workspace's mailbox storage is split, and who may split it.
 *
 * ⚠ ONLY AN OWNER OR ADMIN OF THE WORKSPACE SETS AN ALLOCATION, AND THIS FILE
 * KNOWS NOTHING ABOUT WHO THAT IS. The caller proves it (the console route asks
 * Clerk for the members-manage permission) and passes a tenant id that came from
 * the verified session. What this file guarantees is the other half: the mailbox
 * it writes belongs to THAT tenant, and the writes cannot overfill the pool.
 */

/**
 * What the plan lets a workspace allocate.
 *
 * ⚠ DERIVED FROM THE PLAN'S `storage.bytes` ENTITLEMENT, NEVER GUESSED FROM A
 * PLAN ID OR AN OVERAGE SWITCH. The shapes `@repo/metering` defines (plan.ts):
 * `allowance` is a number of bytes or `"unlimited"`, `overage` is `"billable"`
 * or `"never"`, and the tenant's own `overageEnabled` decides whether billable
 * overage is on. The mapping:
 *
 *   - `pool`     - a number of bytes, prepaid. The owner or admin splits it, and
 *                  allocations sum to at most `bytes`. That is every plan with a
 *                  positive allowance, whatever its overage: overage bills use
 *                  past the pool and does not enlarge what can be handed out.
 *   - `uncapped` - nothing is prepaid, so there is no pool to split. This is
 *                  PAYG - "the same mechanism with the allowance set to zero"
 *                  (docs/decisions/metering.md): `allowance: 0`, `overage:
 *                  "billable"` AND the tenant has overage on, since without that
 *                  switch metering refuses every byte - and an `"unlimited"`
 *                  allowance. A per-inbox cap is optional.
 *
 * ⚠ NO STORAGE ENTITLEMENT AT ALL IS A POOL OF ZERO BYTES, NOT UNCAPPED. A plan
 * without one is a misconfiguration (or a tenant with no plan row); reading it
 * as unlimited would turn our mistake into free storage, while a pool of zero
 * only means nothing can be allocated until the plan is fixed. A zero allowance
 * with `overage: "never"` (the free plan) lands in the same place, on purpose.
 */
export type StorageModel = { kind: "pool"; bytes: number } | { kind: "uncapped" }

export function storageModel(
  assignment: Pick<Assignment, "plan" | "overageEnabled"> | null,
): StorageModel {
  if (!assignment) return { kind: "pool", bytes: 0 }

  const entitlement = entitlementFor(assignment.plan, STORAGE)
  if (!entitlement || entitlement.kind !== "continuous") {
    return { kind: "pool", bytes: 0 }
  }

  if (entitlement.allowance === "unlimited") return { kind: "uncapped" }

  if (
    entitlement.allowance === 0 &&
    entitlement.overage === "billable" &&
    assignment.overageEnabled
  ) {
    return { kind: "uncapped" }
  }

  return { kind: "pool", bytes: entitlement.allowance }
}

export interface MailboxStorageRow {
  address: string
  display_name: string | null
  /** Null: no allocation. */
  allocation: number | null
}

export interface StoragePool {
  kind: StorageModel["kind"]
  /** The prepaid pool in bytes. Null when uncapped. */
  total: number | null
  /** Sum of the allocations. */
  allocated: number
  /**
   * What the workspace's mailboxes occupy, from the last storage sample.
   *
   * ⚠ THE SAME FIGURE METERING GATES ON (`core.tenant_storage`, written by
   * `sampleStorage`), NOT A SECOND COPY. There is no per-inbox usage here: the
   * sample sums accounts per tenant and keeps only the sum, and caching each
   * inbox's figure beside it would be one more number to go stale.
   */
  used: number
  /** Total minus allocated, never below zero. Null when uncapped. */
  remaining: number | null
  /**
   * Inboxes on a pool with no allocation.
   *
   * ⚠ THESE ARE THE INBOXES THAT PREDATE ALLOCATION. They keep the high default
   * quota so no live mailbox starts bouncing, which means they sit OUTSIDE the
   * pool until an owner or admin gives each a number; the console prompts for
   * it. Always zero when uncapped, where no allocation is the normal state.
   */
  unallocated: number
}

export function summarize(
  model: StorageModel,
  rows: readonly MailboxStorageRow[],
  used: number,
): StoragePool {
  const allocated = rows.reduce((sum, r) => sum + (r.allocation ?? 0), 0)

  return {
    kind: model.kind,
    total: model.kind === "pool" ? model.bytes : null,
    allocated,
    used,
    remaining: model.kind === "pool" ? Math.max(0, model.bytes - allocated) : null,
    unallocated:
      model.kind === "pool" ? rows.filter((r) => r.allocation === null).length : 0,
  }
}

export type DecideOutcome =
  | { status: "ok" }
  | { status: "not_found" }
  /** A pool needs a number; `null` (no allocation) is only for uncapped. */
  | { status: "required" }
  | { status: "over_pool"; total: number; remaining: number }

/**
 * Whether `address` may be given `bytes`, given every inbox in the workspace.
 *
 * ⚠ PURE ON PURPOSE: the rows it reads are the ones the store has just locked,
 * so this is the arithmetic the lock protects and nothing else.
 */
export function decideAllocation(input: {
  model: StorageModel
  rows: readonly { address: string; allocation: number | null }[]
  address: string
  bytes: number | null
}): DecideOutcome {
  const { model, rows, address, bytes } = input

  if (!rows.some((r) => r.address === address)) return { status: "not_found" }
  if (model.kind === "uncapped") return { status: "ok" }
  if (bytes === null) return { status: "required" }

  // Everyone's allocation but this inbox's own, which is being replaced.
  const others = rows
    .filter((r) => r.address !== address)
    .reduce((sum, r) => sum + (r.allocation ?? 0), 0)

  if (others + bytes > model.bytes) {
    return {
      status: "over_pool",
      total: model.bytes,
      remaining: Math.max(0, model.bytes - others),
    }
  }

  return { status: "ok" }
}

export interface AllocationStore {
  /**
   * Check and write in one transaction, under a lock on the tenant's rows.
   *
   * ⚠ THE LOCK IS WHAT CLOSES THE RACE. Two admins allocating at once each read
   * the sum, each see room, and each write - the pool is overfilled by whatever
   * the second did. `select ... for update` over EVERY account of the tenant
   * (in one fixed order, so two of them cannot deadlock) makes the second wait
   * for the first to commit and then read its result. A single conditional
   * UPDATE would not do it: under READ COMMITTED each statement re-checks only
   * the row it updates, so two updates of two different rows both pass a `where
   * sum(...) <= pool` evaluated against their own snapshot.
   */
  allocate(input: {
    tenantId: string
    address: string
    bytes: number | null
    model: StorageModel
    /** Flip the subscription gate in the same write (a new mailbox). */
    activate?: boolean
  }): Promise<DecideOutcome>

  /** Every inbox of the tenant. */
  rows(tenantId: string): Promise<MailboxStorageRow[]>

  /** The tenant's sampled disk use in bytes; 0 before the first sample. */
  used(tenantId: string): Promise<number>
}

interface LockedRow extends Record<string, unknown> {
  email: string
  allocation: string | number | null
}

export function allocationStore(db: Database): AllocationStore {
  return {
    async allocate({ tenantId, address, bytes, model, activate }) {
      return db.transaction(async (tx) => {
        const locked = (await tx.execute(sql`
          select email, storage_allocation as allocation
            from authd.accounts
           where tenant_id = ${tenantId}::uuid
           order by clerk_user_id
             for update
        `)) as unknown as LockedRow[]

        const outcome = decideAllocation({
          model,
          rows: locked.map((r) => ({
            address: r.email.toLowerCase(),
            allocation: r.allocation === null ? null : Number(r.allocation),
          })),
          address,
          bytes,
        })
        if (outcome.status !== "ok") return outcome

        // ⚠ BY TENANT AS WELL AS ADDRESS, so an address in another workspace
        // matches nothing here even if a caller got this far with it.
        await tx
          .update(accounts)
          .set({
            storageAllocation: bytes,
            ...(activate ? { active: true } : {}),
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(accounts.tenantId, tenantId),
              sql`lower(${accounts.email}) = ${address}`,
            ),
          )

        return outcome
      })
    },

    async rows(tenantId) {
      const found = await db
        .select({
          address: accounts.email,
          display_name: accounts.displayName,
          allocation: accounts.storageAllocation,
        })
        .from(accounts)
        .where(eq(accounts.tenantId, tenantId))
        .orderBy(accounts.email)

      return found.map((r) => ({ ...r, allocation: r.allocation ?? null }))
    },

    async used(tenantId) {
      const found = (await withTenant(db, tenantId, async (tx) =>
        tx.execute(storageStatement(tenantId)),
      )) as unknown as { level: string | number }[]
      return Number(found[0]?.level ?? 0)
    },
  }
}

export type AllocateOutcome =
  | {
      status: "ok"
      /**
       * `synced`: Stalwart has the quota. `deferred`: our database has the
       * allocation and the reconcile will apply it - the account does not exist
       * yet, Stalwart refused or was unreachable, or it is not configured.
       */
      quota: "synced" | "deferred"
    }
  | Exclude<DecideOutcome, { status: "ok" }>

export interface StorageAllocations {
  /** What the plan lets this workspace allocate. */
  model(tenantId: string): Promise<StorageModel>
  /** The pool and every inbox in it. */
  overview(
    tenantId: string,
  ): Promise<{ pool: StoragePool; mailboxes: MailboxStorageRow[] }>
  /** Saves the allocation, then pushes it to Stalwart. See `AllocateOutcome`. */
  allocate(input: {
    tenantId: string
    address: string
    bytes: number | null
    activate?: boolean
  }): Promise<AllocateOutcome>
}

export interface StorageAllocationDeps {
  store: AllocationStore
  /** `planAssignmentStore(db)`: the plan the workspace holds. */
  assignments: AssignmentStore
  /** The registry caller. Without it nothing is pushed and the reconcile does it. */
  stalwart?: StalwartCaller
  log?: Logger
}

export function storageAllocations(deps: StorageAllocationDeps): StorageAllocations {
  const model = async (tenantId: string) =>
    storageModel(await deps.assignments.find(tenantId))

  return {
    model,

    async overview(tenantId) {
      const [m, mailboxes, used] = await Promise.all([
        model(tenantId),
        deps.store.rows(tenantId),
        deps.store.used(tenantId),
      ])
      return { pool: summarize(m, mailboxes, used), mailboxes }
    },

    async allocate({ tenantId, address, bytes, activate }) {
      const wanted = address.trim().toLowerCase()
      const outcome = await deps.store.allocate({
        tenantId,
        address: wanted,
        bytes,
        model: await model(tenantId),
        activate,
      })
      if (outcome.status !== "ok") return outcome

      // ⚠ THE ALLOCATION IS SAVED BEFORE STALWART IS ASKED AND STAYS SAVED IF
      // IT FAILS. Our database is the source of truth; a mail server that is
      // down must not undo a decision, and the reconcile closes the gap.
      if (!deps.stalwart) return { status: "ok", quota: "deferred" }
      try {
        const pushed = await pushMailboxQuota({
          call: deps.stalwart,
          address: wanted,
          quotaBytes: effectiveMailboxQuota(bytes),
          log: deps.log,
        })
        return {
          status: "ok",
          quota: pushed.status === "updated" ? "synced" : "deferred",
        }
      } catch (error) {
        deps.log?.warn(
          { err: error, address: wanted },
          "quota not pushed to stalwart; the reconcile will apply it",
        )
        return { status: "ok", quota: "deferred" }
      }
    },
  }
}

/**
 * Who owns a workspace, for the question "may this person size an inbox".
 *
 * ⚠ READ UNDER THE TENANT'S OWN SCOPE, because `core.tenants` is protected by
 * `id = current_setting('app.tenant_id')` and the caller is not necessarily
 * scoped to the workspace that owns the mailbox's domain.
 */
export async function workspaceOwnership(
  db: Database,
  tenantId: string,
): Promise<{ clerkOrgId: string | null; ownerClerkUserId: string } | null> {
  const rows = (await withTenant(db, tenantId, async (tx) =>
    tx.execute(sql`
      select clerk_org_id, owner_clerk_user_id
        from core.tenants
       where id = ${tenantId}::uuid
    `),
  )) as unknown as { clerk_org_id: string | null; owner_clerk_user_id: string }[]

  const row = rows[0]
  return row
    ? { clerkOrgId: row.clerk_org_id, ownerClerkUserId: row.owner_clerk_user_id }
    : null
}
