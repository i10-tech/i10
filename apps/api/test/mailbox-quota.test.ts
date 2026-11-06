import { describe, expect, it, mock } from "bun:test"
import type { Mailbox } from "@repo/contracts"
import type { Database } from "../src/db/client.js"
import {
  DEFAULT_MAILBOX_QUOTA_BYTES,
  effectiveMailboxQuota,
  pushMailboxQuota,
  reconcileQuotas,
} from "../src/mail/quota.js"
import { findRegistryAccount, JmapAsError } from "../src/mail/jmap-as.js"
import {
  decideAllocation,
  storageAllocations,
  storageModel,
  summarize,
} from "../src/mailboxes/allocation.js"
import {
  mailboxProvisioning,
  type MailboxDirectory,
  type MailboxIdentity,
} from "../src/mailboxes/provision.js"
import type { ClerkUser } from "../src/projection/clerk-user.js"
import {
  ACME,
  fakeRegistry,
  GIB,
  memoryStore,
  PAYG,
  planFor,
  PRO,
  row,
} from "./mailbox-quota-fixtures.js"

/**
 * Mailbox storage (#379): what a plan lets a workspace allocate, how an
 * allocation reaches Stalwart, and that nothing here can create an account.
 *
 * The lock that makes the check-and-write atomic is not testable without
 * Postgres; see `mailbox-quota-db.test.ts`. The routes are in
 * `mailbox-storage-routes.test.ts`.
 */

describe("effectiveMailboxQuota", () => {
  it("is the allocation when there is one", () => {
    expect(effectiveMailboxQuota(5 * GIB)).toBe(5 * GIB)
  })

  it("is the high default for no allocation, and never sends zero or a fraction", () => {
    expect(DEFAULT_MAILBOX_QUOTA_BYTES).toBe(100 * GIB)
    expect(effectiveMailboxQuota(null)).toBe(DEFAULT_MAILBOX_QUOTA_BYTES)
    expect(effectiveMailboxQuota(undefined)).toBe(DEFAULT_MAILBOX_QUOTA_BYTES)
    expect(effectiveMailboxQuota(0)).toBe(DEFAULT_MAILBOX_QUOTA_BYTES)
    expect(effectiveMailboxQuota(-1)).toBe(DEFAULT_MAILBOX_QUOTA_BYTES)
    expect(effectiveMailboxQuota(1.5)).toBe(DEFAULT_MAILBOX_QUOTA_BYTES)
  })
})

describe("plan or pay as you go, from the storage entitlement", () => {
  it("is a pool of the plan's bytes for a prepaid allowance", () => {
    expect(storageModel(PRO)).toEqual({ kind: "pool", bytes: 10 * GIB })
  })

  it("is a pool whatever the overage, which bills use past the pool and does not enlarge it", () => {
    const billable = planFor({ allowance: 10 * GIB, overage: "billable" }, true)
    expect(storageModel(billable)).toEqual({ kind: "pool", bytes: 10 * GIB })
  })

  it("is uncapped for allowance zero, billable, with the tenant's overage switch on", () => {
    expect(storageModel(PAYG)).toEqual({ kind: "uncapped" })
  })

  it("is a pool of zero when the tenant has not switched overage on, since metering refuses every byte", () => {
    const off = planFor({ allowance: 0, overage: "billable" }, false)
    expect(storageModel(off)).toEqual({ kind: "pool", bytes: 0 })
  })

  it("is a pool of zero for the free plan: allowance zero, overage never", () => {
    const free = planFor({ allowance: 0, overage: "never" }, true)
    expect(storageModel(free)).toEqual({ kind: "pool", bytes: 0 })
  })

  it("is uncapped for an unlimited allowance", () => {
    expect(storageModel(planFor({ allowance: "unlimited", overage: "never" }))).toEqual(
      {
        kind: "uncapped",
      },
    )
  })

  it("is a pool of zero, NOT uncapped, when the plan has no storage entitlement", () => {
    expect(storageModel(planFor(null))).toEqual({ kind: "pool", bytes: 0 })
  })

  it("is a pool of zero for a tenant with no plan at all", () => {
    expect(storageModel(null)).toEqual({ kind: "pool", bytes: 0 })
  })

  it("never reads a plan id: a plan named payg with a prepaid allowance is a pool", () => {
    const named = planFor({ allowance: 10 * GIB, overage: "never" })
    named.plan = { ...named.plan, id: "payg" }
    expect(storageModel(named)).toEqual({ kind: "pool", bytes: 10 * GIB })
  })
})

describe("the pool", () => {
  const model = { kind: "pool", bytes: 10 * GIB } as const

  it("accepts an allocation that fits and refuses one that does not", () => {
    const rows = [
      { address: "a@acme.test", allocation: 6 * GIB },
      { address: "b@acme.test", allocation: null },
    ]
    expect(
      decideAllocation({ model, rows, address: "b@acme.test", bytes: 4 * GIB }),
    ).toEqual({ status: "ok" })
    expect(
      decideAllocation({ model, rows, address: "b@acme.test", bytes: 4 * GIB + 1 }),
    ).toEqual({ status: "over_pool", total: 10 * GIB, remaining: 4 * GIB })
  })

  it("does not count the inbox being resized against itself", () => {
    const rows = [{ address: "a@acme.test", allocation: 9 * GIB }]
    expect(
      decideAllocation({ model, rows, address: "a@acme.test", bytes: 10 * GIB }),
    ).toEqual({ status: "ok" })
  })

  it("needs a number on a pool and allows none when uncapped", () => {
    const rows = [{ address: "a@acme.test", allocation: null }]
    expect(
      decideAllocation({ model, rows, address: "a@acme.test", bytes: null }),
    ).toEqual({
      status: "required",
    })
    expect(
      decideAllocation({
        model: { kind: "uncapped" },
        rows,
        address: "a@acme.test",
        bytes: null,
      }),
    ).toEqual({ status: "ok" })
  })

  it("is not_found for an address that is not in the workspace", () => {
    expect(
      decideAllocation({ model, rows: [], address: "x@acme.test", bytes: GIB }),
    ).toEqual({ status: "not_found" })
  })

  it("reports legacy inboxes with no allocation as unallocated, outside the pool", () => {
    const pool = summarize(
      model,
      [row("a@acme.test", 4 * GIB), row("old@acme.test"), row("older@acme.test")],
      3 * GIB,
    )
    expect(pool).toEqual({
      kind: "pool",
      total: 10 * GIB,
      allocated: 4 * GIB,
      used: 3 * GIB,
      remaining: 6 * GIB,
      unallocated: 2,
    })
  })

  it("has no pool and no unallocated inboxes when uncapped", () => {
    const pool = summarize({ kind: "uncapped" }, [row("a@acme.test")], 0)
    expect(pool).toMatchObject({
      kind: "uncapped",
      total: null,
      remaining: null,
      unallocated: 0,
    })
  })
})

describe("finding the registry account", () => {
  const accounts = [
    { id: "a", emailAddress: "sam@acme.test" },
    { id: "b", emailAddress: "sam@globex.test" },
    { id: "c", emailAddress: "sam-legacy@acme.test" },
  ]

  it("asks with the exact local part as `name`, never an emailAddress filter", async () => {
    const registry = fakeRegistry(accounts)
    await findRegistryAccount(
      async (m) => (await registry.call(m))[1],
      "sam@globex.test",
    )

    const query = registry.methods.find((m) => m.name === "x:Account/query")!
    expect(query.args.filter).toEqual({ name: "sam" })
    expect(JSON.stringify(registry.methods)).not.toContain('emailAddress":')
  })

  it("picks the account carrying the exact address when two domains share a local part", async () => {
    const registry = fakeRegistry(accounts)
    const found = await findRegistryAccount(
      async (m) => (await registry.call(m))[1],
      "SAM@Globex.test",
    )
    expect(found.id).toBe("b")
  })

  it("throws no_account / address_mismatch rather than guessing", async () => {
    const registry = fakeRegistry(accounts)
    const find = (address: string) =>
      findRegistryAccount(async (m) => (await registry.call(m))[1], address).then(
        () => null,
        (e: unknown) => (e instanceof JmapAsError ? e.code : "other"),
      )

    expect(await find("nobody@acme.test")).toBe("no_account")
    expect(await find("sam@elsewhere.test")).toBe("address_mismatch")
  })
})

describe("pushing one quota", () => {
  it("sets maxDiskQuota on the account whose address matches, and nothing else", async () => {
    const registry = fakeRegistry([
      { id: "a", emailAddress: "sam@acme.test" },
      { id: "b", emailAddress: "sam@globex.test" },
    ])

    const result = await pushMailboxQuota({
      call: registry.call,
      address: "sam@globex.test",
      quotaBytes: 5 * GIB,
    })

    expect(result).toEqual({ status: "updated" })
    expect(registry.sets()).toHaveLength(1)
    expect(registry.sets()[0]!.args).toEqual({
      update: { b: { quotas: { maxDiskQuota: 5 * GIB } } },
    })
    expect(registry.accounts.find((a) => a.id === "a")!.quotas).toEqual({})
  })

  it("never creates an account: with none in the registry it writes nothing", async () => {
    const registry = fakeRegistry([{ id: "a", emailAddress: "other@acme.test" }])

    const result = await pushMailboxQuota({
      call: registry.call,
      address: "new@acme.test",
      quotaBytes: GIB,
    })

    expect(result).toEqual({ status: "no_registry_account" })
    expect(registry.sets()).toHaveLength(0)
    expect(JSON.stringify(registry.methods)).not.toContain("create")
  })

  it("refuses a group, which has no store of its own", async () => {
    const registry = fakeRegistry([
      { id: "g", emailAddress: "team@acme.test", "@type": "Group" },
    ])
    const outcome = await pushMailboxQuota({
      call: registry.call,
      address: "team@acme.test",
      quotaBytes: GIB,
    }).then(
      () => "ok",
      (e: Error) => e.message,
    )
    expect(outcome).toContain("group")
    expect(registry.sets()).toHaveLength(0)
  })

  it("throws when Stalwart refuses the update", async () => {
    const registry = fakeRegistry([{ id: "a", emailAddress: "sam@acme.test" }], {
      refuse: new Set(["a"]),
    })
    const outcome = await pushMailboxQuota({
      call: registry.call,
      address: "sam@acme.test",
      quotaBytes: GIB,
    }).then(
      () => "ok",
      (e: Error) => e.message,
    )
    expect(outcome).toContain("refused")
  })
})

describe("allocating through the service", () => {
  const harness = (opts: {
    registry?: ReturnType<typeof fakeRegistry>
    plan?: typeof PRO
  }) => {
    const tenants = { [ACME]: [row("sam@acme.test"), row("kim@acme.test")] }
    const service = storageAllocations({
      store: memoryStore(tenants),
      assignments: { find: async () => opts.plan ?? PRO },
      ...(opts.registry ? { stalwart: opts.registry.call } : {}),
    })
    return { service, tenants }
  }

  it("saves the allocation and pushes it to Stalwart", async () => {
    const registry = fakeRegistry([{ id: "a", emailAddress: "sam@acme.test" }])
    const { service, tenants } = harness({ registry })

    const outcome = await service.allocate({
      tenantId: ACME,
      address: "sam@acme.test",
      bytes: 4 * GIB,
    })

    expect(outcome).toEqual({ status: "ok", quota: "synced" })
    expect(tenants[ACME]![0]!.allocation).toBe(4 * GIB)
    expect(registry.accounts[0]!.quotas).toEqual({ maxDiskQuota: 4 * GIB })
  })

  it("keeps the allocation when the Stalwart write fails, and says the quota is deferred", async () => {
    const registry = fakeRegistry([{ id: "a", emailAddress: "sam@acme.test" }], {
      refuse: new Set(["a"]),
    })
    const warn = mock(() => {})
    const tenants = { [ACME]: [row("sam@acme.test")] }
    const service = storageAllocations({
      store: memoryStore(tenants),
      assignments: { find: async () => PRO },
      stalwart: registry.call,
      log: { info: () => {}, warn, error: () => {} },
    })

    const outcome = await service.allocate({
      tenantId: ACME,
      address: "sam@acme.test",
      bytes: 4 * GIB,
    })

    expect(outcome).toEqual({ status: "ok", quota: "deferred" })
    expect(tenants[ACME]![0]!.allocation).toBe(4 * GIB)
    expect(warn).toHaveBeenCalled()
  })

  it("keeps the allocation when Stalwart is unreachable", async () => {
    const registry = fakeRegistry([], { down: true })
    const { service, tenants } = harness({ registry })

    const outcome = await service.allocate({
      tenantId: ACME,
      address: "sam@acme.test",
      bytes: 4 * GIB,
    })

    expect(outcome).toEqual({ status: "ok", quota: "deferred" })
    expect(tenants[ACME]![0]!.allocation).toBe(4 * GIB)
  })

  it("defers, writing nothing, when the registry has no account yet", async () => {
    const registry = fakeRegistry([])
    const { service, tenants } = harness({ registry })

    const outcome = await service.allocate({
      tenantId: ACME,
      address: "sam@acme.test",
      bytes: 4 * GIB,
    })

    expect(outcome).toEqual({ status: "ok", quota: "deferred" })
    expect(tenants[ACME]![0]!.allocation).toBe(4 * GIB)
    expect(registry.sets()).toHaveLength(0)
  })

  it("pushes nothing when the allocation is over the pool", async () => {
    const registry = fakeRegistry([{ id: "a", emailAddress: "sam@acme.test" }])
    const { service, tenants } = harness({ registry })

    const outcome = await service.allocate({
      tenantId: ACME,
      address: "sam@acme.test",
      bytes: 11 * GIB,
    })

    expect(outcome.status).toBe("over_pool")
    expect(tenants[ACME]![0]!.allocation).toBeNull()
    expect(registry.methods).toHaveLength(0)
  })

  it("lets PAYG take a cap, or none, and pushes the default for none", async () => {
    const registry = fakeRegistry([{ id: "a", emailAddress: "sam@acme.test" }])
    const { service, tenants } = harness({ registry, plan: PAYG })

    expect(
      await service.allocate({
        tenantId: ACME,
        address: "sam@acme.test",
        bytes: 50 * GIB,
      }),
    ).toEqual({ status: "ok", quota: "synced" })
    expect(registry.accounts[0]!.quotas).toEqual({ maxDiskQuota: 50 * GIB })

    expect(
      await service.allocate({ tenantId: ACME, address: "sam@acme.test", bytes: null }),
    ).toEqual({ status: "ok", quota: "synced" })
    expect(tenants[ACME]![0]!.allocation).toBeNull()
    expect(registry.accounts[0]!.quotas).toEqual({
      maxDiskQuota: DEFAULT_MAILBOX_QUOTA_BYTES,
    })
  })

  it("refuses a missing allocation on a pool", async () => {
    const { service } = harness({})
    expect(
      await service.allocate({ tenantId: ACME, address: "sam@acme.test", bytes: null }),
    ).toEqual({ status: "required" })
  })

  it("answers not_found for an address in another workspace", async () => {
    const { service } = harness({})
    expect(
      await service.allocate({
        tenantId: ACME,
        address: "sam@globex.test",
        bytes: GIB,
      }),
    ).toEqual({ status: "not_found" })
  })
})

describe("the reconcile", () => {
  /** `reconcileQuotas` reads `select ... from authd.accounts`; nothing else. */
  const dbWith = (rows: { email: string; allocation: number | null }[]) =>
    ({ select: () => ({ from: async () => rows }) }) as unknown as Database

  it("sets drifted accounts back to the allocation, or the default for none", async () => {
    const registry = fakeRegistry([
      { id: "a", emailAddress: "sam@acme.test", quotas: {} },
      { id: "b", emailAddress: "kim@acme.test", quotas: { maxDiskQuota: 999 } },
      { id: "c", emailAddress: "lee@acme.test", quotas: { maxDiskQuota: 2 * GIB } },
    ])

    const report = await reconcileQuotas({
      db: dbWith([
        { email: "sam@acme.test", allocation: 3 * GIB },
        { email: "kim@acme.test", allocation: null },
        { email: "lee@acme.test", allocation: 2 * GIB },
      ]),
      call: registry.call,
    })

    expect(report).toEqual({
      mailboxes: 3,
      inSync: 1,
      repaired: 2,
      skipped: 0,
      failed: 0,
    })
    expect(registry.accounts.map((a) => a.quotas)).toEqual([
      { maxDiskQuota: 3 * GIB },
      { maxDiskQuota: DEFAULT_MAILBOX_QUOTA_BYTES },
      { maxDiskQuota: 2 * GIB },
    ])
    // One batched write for the two repairs, none for the account in sync.
    expect(registry.sets()).toHaveLength(1)
  })

  it("skips a mailbox with no registry account and creates nothing", async () => {
    const registry = fakeRegistry([{ id: "a", emailAddress: "sam@acme.test" }])

    const report = await reconcileQuotas({
      db: dbWith([{ email: "new@acme.test", allocation: GIB }]),
      call: registry.call,
    })

    expect(report).toEqual({
      mailboxes: 1,
      inSync: 0,
      repaired: 0,
      skipped: 1,
      failed: 0,
    })
    expect(registry.sets()).toHaveLength(0)
  })

  it("leaves groups alone and counts a refused repair as failed, not repaired", async () => {
    const registry = fakeRegistry(
      [
        { id: "g", emailAddress: "team@acme.test", "@type": "Group" },
        { id: "a", emailAddress: "sam@acme.test" },
      ],
      { refuse: new Set(["a"]) },
    )

    const report = await reconcileQuotas({
      db: dbWith([
        { email: "team@acme.test", allocation: null },
        { email: "sam@acme.test", allocation: GIB },
      ]),
      call: registry.call,
    })

    expect(report).toEqual({
      mailboxes: 2,
      inSync: 0,
      repaired: 0,
      skipped: 1,
      failed: 1,
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe("creating a mailbox", () => {
  const TENANT = ACME
  const ADDRESS = "sam@acme.test"

  const clerkUser = (): ClerkUser => ({
    id: "user_1",
    primary_email_address_id: "idn_1",
    first_name: "Sam",
    last_name: null,
    updated_at: 1_700_000_000_000,
    email_addresses: [
      {
        id: "idn_1",
        email_address: "sam@example.org",
        verification: { status: "verified" },
      },
    ],
  })

  const mailboxOf = (allocation: number | null): Mailbox => ({
    object: "mailbox",
    address: ADDRESS,
    display_name: "Sam",
    active: true,
    created_at: new Date(0).toISOString(),
    storage_allocated: allocation,
  })

  function harness(opts: {
    plan: typeof PRO | null
    admin?: boolean
    existing?: ReturnType<typeof row>[]
    storage?: boolean
  }) {
    const rows = [...(opts.existing ?? [])]
    const tenants = { [TENANT]: rows }
    const addVerifiedAddress = mock(async () => {})
    const activate = mock(async () => mailboxOf(null))

    const identity: MailboxIdentity = {
      get: async () => ({ user: clerkUser(), passwordEnabled: true }),
      addVerifiedAddress,
    }
    const directory: MailboxDirectory = {
      domainOwner: async () => TENANT,
      addressTaken: async () => false,
      // Null until the projection has made the row: one mailbox per person.
      current: async () => {
        const made = rows.find((r) => r.address === ADDRESS)
        return made ? mailboxOf(made.allocation) : null
      },
      activate,
    }
    const storage = storageAllocations({
      store: memoryStore(tenants),
      assignments: { find: async () => opts.plan },
    })

    const provisioning = mailboxProvisioning({
      identity,
      directory,
      capacity: { check: async () => ({ status: "allowed" }) },
      // The projection is what makes the row.
      project: async () => {
        if (!rows.some((r) => r.address === ADDRESS)) rows.push(row(ADDRESS))
        return { email: ADDRESS }
      },
      featureId: "mailboxes",
      ...(opts.storage === false ? {} : { storage }),
      canAllocate: async () => opts.admin ?? false,
    })

    return { provisioning, rows, addVerifiedAddress, activate }
  }

  it("lets an owner or admin create a mailbox with an allocation on a plan", async () => {
    const h = harness({ plan: PRO, admin: true })
    const outcome = await h.provisioning.create("user_1", {
      address: ADDRESS,
      storage_allocation: 4 * GIB,
    })

    expect(outcome.status).toBe("created")
    expect(h.rows.find((r) => r.address === ADDRESS)!.allocation).toBe(4 * GIB)
    // Activated by the same write that allocated, not by a second one.
    expect(h.activate).not.toHaveBeenCalled()
  })

  it("refuses, before anything reaches Clerk, a plan mailbox with no allocation", async () => {
    const h = harness({ plan: PRO, admin: true })
    const outcome = await h.provisioning.create("user_1", { address: ADDRESS })

    expect(outcome.status).toBe("rejected")
    expect(h.addVerifiedAddress).not.toHaveBeenCalled()
  })

  it("refuses a MEMBER who sends an allocation, rather than ignoring it", async () => {
    const h = harness({ plan: PRO, admin: false })
    const outcome = await h.provisioning.create("user_1", {
      address: ADDRESS,
      storage_allocation: GIB,
    })

    expect(outcome.status).toBe("forbidden")
    expect(h.addVerifiedAddress).not.toHaveBeenCalled()
    expect(h.rows).toHaveLength(0)
  })

  it("refuses a MEMBER on PAYG who tries to set a cap", async () => {
    const h = harness({ plan: PAYG, admin: false })
    const outcome = await h.provisioning.create("user_1", {
      address: ADDRESS,
      storage_allocation: GIB,
    })

    expect(outcome.status).toBe("forbidden")
  })

  it("accepts an allocation up to what is left in the pool and refuses one past it", async () => {
    const existing = [row("old@acme.test", 7 * GIB)]

    const fits = harness({ plan: PRO, admin: true, existing: [...existing] })
    expect(
      (
        await fits.provisioning.create("user_1", {
          address: ADDRESS,
          storage_allocation: 3 * GIB,
        })
      ).status,
    ).toBe("created")

    const over = harness({ plan: PRO, admin: true, existing: [...existing] })
    const outcome = await over.provisioning.create("user_1", {
      address: ADDRESS,
      storage_allocation: 3 * GIB + 1,
    })
    expect(outcome.status).toBe("limit")
    expect(over.addVerifiedAddress).not.toHaveBeenCalled()
  })

  it("lets PAYG create with no cap, activating as before", async () => {
    const h = harness({ plan: PAYG, admin: false })
    const outcome = await h.provisioning.create("user_1", { address: ADDRESS })

    expect(outcome.status).toBe("created")
    expect(h.activate).toHaveBeenCalledTimes(1)
    expect(h.rows.find((r) => r.address === ADDRESS)!.allocation).toBeNull()
  })

  it("lets an admin set a PAYG cap on create", async () => {
    const h = harness({ plan: PAYG, admin: true })
    const outcome = await h.provisioning.create("user_1", {
      address: ADDRESS,
      storage_allocation: 20 * GIB,
    })

    expect(outcome.status).toBe("created")
    expect(h.rows.find((r) => r.address === ADDRESS)!.allocation).toBe(20 * GIB)
  })

  it("refuses an allocation where no storage is configured, and otherwise behaves as before", async () => {
    const h = harness({ plan: PRO, admin: true, storage: false })

    expect(
      (
        await h.provisioning.create("user_1", {
          address: ADDRESS,
          storage_allocation: GIB,
        })
      ).status,
    ).toBe("rejected")
    expect((await h.provisioning.create("user_1", { address: ADDRESS })).status).toBe(
      "created",
    )
  })
})
