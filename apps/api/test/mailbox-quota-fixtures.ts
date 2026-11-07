import type { Assignment, Entitlement } from "@repo/metering"
import {
  decideAllocation,
  type AllocationStore,
  type MailboxStorageRow,
} from "../src/mailboxes/allocation.js"
import type { StalwartCaller } from "../src/mail/stalwart.js"

/** Pieces shared by the quota, provisioning and route tests. */

export const ACME = "3f1a0e00-0000-4000-8000-0000000000a1"
export const GLOBEX = "3f1a0e00-0000-4000-8000-0000000000b2"

export const GIB = 1024 ** 3

/** A tenant on a plan whose only storage entitlement is `entitlement`. */
export function planFor(
  entitlement: Omit<
    Extract<Entitlement, { kind: "continuous" }>,
    "kind" | "featureId"
  > | null,
  overageEnabled = false,
  tenantId = ACME,
): Assignment {
  return {
    tenantId,
    anchor: new Date(0),
    overageEnabled,
    plan: {
      id: "test-plan",
      source: "catalog",
      entitlements: entitlement
        ? [{ kind: "continuous", featureId: "storage.bytes", ...entitlement }]
        : [],
    },
  }
}

/** 10 GiB prepaid, a hard cap: what `pro` is in migration 0027. */
export const PRO = planFor({ allowance: 10 * GIB, overage: "never" })

/** Allowance zero, billable, and the tenant opted in: pay as you go. */
export const PAYG = planFor({ allowance: 0, overage: "billable" }, true)

/**
 * A registry account as `x:Account/get` returns it. `name` is the address's
 * local part, which is what the registry's only usable filter matches.
 */
export interface FakeAccount {
  id: string
  emailAddress: string
  "@type"?: "User" | "Group"
  quotas?: Record<string, number>
  usedDiskQuota?: number
}

/**
 * A Stalwart registry that answers the calls the quota code makes, records every
 * method it was asked, and applies `x:Account/set` updates to its accounts.
 */
export function fakeRegistry(
  initial: FakeAccount[],
  opts: { refuse?: ReadonlySet<string>; down?: boolean } = {},
) {
  const accounts = initial.map((a) => ({ "@type": "User" as const, quotas: {}, ...a }))
  const methods: { name: string; args: Record<string, unknown> }[] = []

  const nameOf = (a: FakeAccount) =>
    a.emailAddress.slice(0, a.emailAddress.indexOf("@"))

  const call: StalwartCaller = async (methodCalls) => {
    if (opts.down) throw new Error("stalwart unreachable: connection refused")
    const [name, args] = methodCalls[0] as [string, Record<string, unknown>, string]
    methods.push({ name, args })

    if (name === "x:Account/query") {
      const filter = args.filter as { name?: string } | undefined
      const found = accounts.filter((a) => !filter?.name || nameOf(a) === filter.name)
      return [name, { ids: found.map((a) => a.id) }]
    }

    if (name === "x:Account/get") {
      const ids = args.ids as string[]
      return [name, { list: accounts.filter((a) => ids.includes(a.id)) }]
    }

    if (name === "x:Account/set") {
      const update = (args.update ?? {}) as Record<
        string,
        { quotas: Record<string, number> }
      >
      const notUpdated: Record<string, { type: string; description: string }> = {}
      for (const [id, patch] of Object.entries(update)) {
        const account = accounts.find((a) => a.id === id)
        if (!account || opts.refuse?.has(id)) {
          notUpdated[id] = { type: "forbidden", description: "refused" }
          continue
        }
        account.quotas = patch.quotas
      }
      return [name, { updated: {}, notUpdated }]
    }

    throw new Error(`unexpected method ${name}`)
  }

  return {
    call,
    accounts,
    methods,
    /** The `x:Account/set` calls, which are the only writes. */
    sets: () => methods.filter((m) => m.name === "x:Account/set"),
  }
}

/**
 * An `AllocationStore` over an array. It runs the same decision the SQL store
 * runs (`decideAllocation`); the lock that makes that decision safe under
 * concurrency is what `mailbox-quota-db.test.ts` proves against Postgres.
 */
export function memoryStore(
  tenants: Record<string, MailboxStorageRow[]>,
  used: Record<string, number> = {},
): AllocationStore {
  return {
    async allocate({ tenantId, address, bytes, model, activate }) {
      const rows = tenants[tenantId] ?? []
      const outcome = decideAllocation({
        model,
        rows: rows.map((r) => ({ address: r.address, allocation: r.allocation })),
        address,
        bytes,
      })
      if (outcome.status === "ok") {
        const row = rows.find((r) => r.address === address)!
        row.allocation = bytes
        if (activate) (row as { active?: boolean }).active = true
      }
      return outcome
    },
    async rows(tenantId) {
      return (tenants[tenantId] ?? []).map((r) => ({ ...r }))
    },
    async used(tenantId) {
      return used[tenantId] ?? 0
    },
  }
}

export const row = (
  address: string,
  allocation: number | null = null,
): MailboxStorageRow => ({ address, display_name: null, allocation })
