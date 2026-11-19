import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import { directoryMailStore } from "../src/identity/mail-store.js"
import type { DirectoryMailDeps } from "../src/identity/directory-mail.js"
import type { MailboxJobRow } from "../src/mailboxes/jobs.js"
import { consoleMailboxStore, consoleMailboxes } from "../src/mailboxes/console.js"
import {
  mailboxAdminLifecycle,
  purgeDueMailboxes,
  purgeMailbox,
  type MailboxAccounts,
  type PurgeDeps,
} from "../src/mailboxes/lifecycle.js"
import { mailboxLifecycleStore } from "../src/mailboxes/lifecycle-store.js"
import {
  aliasListName,
  directoryMail,
  mailboxDirectory,
} from "../src/mailboxes/store.js"

/**
 * A mailbox's suspend, resume, deletion, restore and purge against a real database
 * as `i10_api`.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@127.0.0.1:<port>/i10 bun test test/mailbox-lifecycle-db.test.ts
 *
 * ⚠ "REFUSED BY AUTHD" IS READ FROM THE SAME COLUMNS authd READS, AHEAD OF ITS
 * CREDENTIAL CACHE (`services/authd/internal/projection/postgres.go`, then
 * `ldapsrv/bind.go` `handleBind`): the Go test `TestEveryRowGateBeatsAWarmCache`
 * proves each of these turns a warm cache away, so a column that is set here is a
 * login that is refused there.
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let sqlApi: ReturnType<typeof postgres>
let db: Database

const acme = crypto.randomUUID()
const rival = crypto.randomUUID()
const sfx = acme.slice(0, 8)
const domain = `acme-${sfx}.test`
const admin = `user_admin${sfx}`
const ada = `user_ada${sfx}`
const bob = `user_bob${sfx}`
const cy = `user_cy${sfx}`
const people = [ada, bob, cy]
const address = (id: string) => `${id.replace(/^user_/, "").replace(sfx, "")}@${domain}`
const T0 = new Date("2026-11-16T10:00:00Z")
const DAY = 24 * 60 * 60 * 1000

let clock = T0

/** What authd reads of the row before it looks at the credential cache. */
async function gates(id: string) {
  const [row] = await owner`
    select active,
           (suspended_at is not null) as suspended,
           (payment_hold_at is not null) as payment_hold,
           (deleting_at is not null) as deleting,
           banned,
           (locked and (locked_until is null or locked_until > now())) as locked,
           credential_epoch::text as epoch
      from authd.accounts where clerk_user_id = ${id}`
  const g = row!
  return {
    active: g.active as boolean,
    suspended: g.suspended as boolean,
    paymentHold: g.payment_hold as boolean,
    deleting: g.deleting as boolean,
    epoch: BigInt(g.epoch as string),
    refused: Boolean(
      g.suspended || g.payment_hold || g.deleting || g.banned || g.locked,
    ),
  }
}

const eventTypes = async () =>
  (
    await owner`select type from identity.events where tenant_id = ${acme} order by id`
  ).map((r) => r.type as string)

const accountExists = async (id: string) =>
  (await owner`select 1 from authd.accounts where clerk_user_id = ${id}`).length > 0

const groupMembers = async (name: string) =>
  (
    await owner`select clerk_user_id from authd.group_members where group_name = ${name}`
  ).map((r) => r.clerk_user_id as string)

const groupExists = async (name: string) =>
  (await owner`select 1 from authd.groups where name = ${name}`).length > 0

async function reset() {
  await owner`delete from core.mailbox_deletions where tenant_id = ${acme}`
  await owner`delete from identity.directory_mailboxes where tenant_id = ${acme}`
  // The primary's list ends in the id, an alias's list in the alias address.
  await owner`delete from authd.groups where name like ${`fwd-%${sfx}%`}`
  await owner`delete from core.mailbox_jobs where tenant_id = ${acme}`
  await owner`delete from authd.accounts where clerk_user_id = any(${people})`
  for (const id of people)
    await owner`insert into authd.accounts (clerk_user_id, email, active, tenant_id)
                values (${id}, ${address(id)}, true, ${acme})`
  await owner`delete from core.workspace_roles where tenant_id = ${acme}`
  for (const id of [ada, bob, cy])
    await owner`insert into core.workspace_roles (tenant_id, clerk_user_id, role, source)
                values (${acme}, ${id}, 'member', 'membership')`
  await owner`delete from identity.events where tenant_id = ${acme}`
  clock = T0
}

const memberRows = async (tenantId: string, userId: string) =>
  (
    await owner`select 1 from core.workspace_roles
                 where tenant_id = ${tenantId} and clerk_user_id = ${userId}`
  ).length > 0

suite("a mailbox's lifecycle, against Postgres", () => {
  const store = () => mailboxLifecycleStore(db)

  const resumeDeps = (): DirectoryMailDeps => ({
    store: { ...directoryMailStore(db), hostedBy: async () => acme },
    provision: async () => ({ status: "gone" }),
    isMember: memberRows,
    directoryActive: async () => false,
    directoryDeactivated: async () => false,
    scheduleDeletion: async () => {},
    record: async () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
  })

  const exportsStarted: { address: string; requestedBy: string }[] = []
  let exportShouldFail = false
  const life = (over: { exportable?: boolean } = {}) =>
    mailboxAdminLifecycle({
      store: store(),
      mail: directoryMailStore(db),
      resume: resumeDeps(),
      isAdmin: async (_t, user) => user === admin,
      startExport:
        over.exportable === false
          ? null
          : async (input) => {
              if (exportShouldFail) throw new Error("queue down")
              exportsStarted.push({
                address: input.address,
                requestedBy: input.requestedBy,
              })
            },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => clock,
    })

  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    sqlApi = postgres(API_URL!, { max: 6, onnotice: () => {} })
    db = drizzle({ client: sqlApi }) as unknown as Database
    for (const [id, name] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const)
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                  values (${id}, ${`lc-${id.slice(0, 8)}`}, ${name}, ${`owner-${id}`}, ${`org_${id.slice(0, 8)}`})`
  })

  beforeEach(async () => {
    exportsStarted.length = 0
    exportShouldFail = false
    await reset()
  })

  afterAll(async () => {
    await owner`delete from core.mailbox_deletions where tenant_id in (${acme}, ${rival})`
    await owner`delete from authd.groups where name like ${`fwd-%${sfx}%`}`
    await owner`delete from core.mailbox_jobs where tenant_id in (${acme}, ${rival})`
    await owner`delete from authd.accounts where clerk_user_id = any(${people})`
    await owner`delete from core.workspace_roles where tenant_id in (${acme}, ${rival})`
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await sqlApi.end()
  })

  // ── Suspend and resume ────────────────────────────────────────────────────

  it("suspend refuses the login, keeps the mailbox receiving, and is repeatable", async () => {
    const input = { tenantId: acme, address: address(ada), actorId: admin }
    expect(await life().suspend(input)).toBe("suspended")

    const after = await gates(ada)
    expect(after.suspended).toBe(true)
    expect(after.refused).toBe(true)
    // ⚠ STILL ACTIVE: authd's recipient lookups read `active`, so mail keeps arriving.
    expect(after.active).toBe(true)
    expect(await eventTypes()).toContain("mailbox.suspended")
    const [event] = await owner`select reason, actor_user_id from identity.events
                                 where tenant_id = ${acme} and type = 'mailbox.suspended'`
    expect(event).toMatchObject({ reason: "owner", actor_user_id: admin })

    expect(await life().suspend(input)).toBe("already")
  })

  it("an owner's suspension is not the leaver policy: nothing is scheduled for deletion", async () => {
    await life().suspend({ tenantId: acme, address: address(ada), actorId: admin })
    const [row] = await owner`select next, delete_at from identity.directory_mailboxes
                               where tenant_id = ${acme} and clerk_user_id = ${ada}`
    expect(row).toMatchObject({ next: "keep", delete_at: null })
  })

  it("resume lifts the owner's suspension and nothing else", async () => {
    await owner`update authd.accounts set payment_hold_at = now(), banned = true
                 where clerk_user_id = ${ada}`
    const input = { tenantId: acme, address: address(ada), actorId: admin }
    await life().suspend(input)

    const done = await life().resume(input)
    expect(done).toEqual({
      status: "resumed",
      stillBlocked: ["payment_hold", "banned"],
    })
    const after = await gates(ada)
    expect(after.suspended).toBe(false)
    expect(after.paymentHold).toBe(true)
    // Still refused, by the hold and the ban, and the answer said so.
    expect(after.refused).toBe(true)
  })

  it("resume does not give a removed member their login back", async () => {
    const input = { tenantId: acme, address: address(ada), actorId: admin }
    await life().suspend(input)
    await owner`delete from core.workspace_roles where tenant_id = ${acme} and clerk_user_id = ${ada}`

    expect(await life().resume(input)).toEqual({ status: "not_member" })
    expect((await gates(ada)).suspended).toBe(true)
  })

  it("resume of a mailbox that is not suspended says so", async () => {
    expect(
      await life().resume({ tenantId: acme, address: address(ada), actorId: admin }),
    ).toEqual({ status: "not_suspended" })
  })

  it("another workspace's admin finds no such mailbox", async () => {
    const input = { tenantId: rival, address: address(ada), actorId: admin }
    expect(await life().suspend(input)).toBe("not_found")
    expect(await life().resume(input)).toEqual({ status: "not_found" })
    expect(await life().remove({ ...input, request: { outcome: "delete" } })).toEqual({
      status: "not_found",
    })
    expect(await life().restore(input)).toBe("not_found")
    expect(await gates(ada)).toMatchObject({ suspended: false, deleting: false })
  })

  // ── Delete ────────────────────────────────────────────────────────────────

  it("delete stops the login at once, keeps receiving, and schedules the purge 30 days out", async () => {
    const before = await gates(ada)
    const done = await life().remove({
      tenantId: acme,
      address: address(ada),
      actorId: admin,
      request: { outcome: "delete" },
    })
    expect(done.status).toBe("deleting")

    const after = await gates(ada)
    expect(after.deleting).toBe(true)
    expect(after.refused).toBe(true)
    expect(after.active).toBe(true)
    // The credential epoch moved, so nothing verified before survives a restore.
    expect(after.epoch).toBeGreaterThan(before.epoch)

    const [row] = await owner`select outcome, purge_after, deleting_at, requested_by
                                from core.mailbox_deletions where clerk_user_id = ${ada}`
    expect(row!.outcome).toBe("delete")
    expect(new Date(row!.purge_after as string).getTime()).toBe(T0.getTime() + 30 * DAY)
    expect(row!.requested_by).toBe(admin)
    expect(await eventTypes()).toContain("mailbox.deleting")
  })

  it("delete twice is refused, not restarted", async () => {
    const input = {
      tenantId: acme,
      address: address(ada),
      actorId: admin,
      request: { outcome: "delete" as const },
    }
    await life().remove(input)
    clock = new Date(T0.getTime() + 5 * DAY)
    expect(await life().remove(input)).toEqual({ status: "already" })
    const [row] = await owner`select purge_after from core.mailbox_deletions
                               where clerk_user_id = ${ada}`
    expect(new Date(row!.purge_after as string).getTime()).toBe(T0.getTime() + 30 * DAY)
  })

  // ⚠ EVERY RESUME PATH, AND NONE MAY LIFT IT.
  it("no resume path lifts a deletion", async () => {
    await life().remove({
      tenantId: acme,
      address: address(ada),
      actorId: admin,
      request: { outcome: "delete" },
    })

    // The owner's.
    expect(
      await life().resume({ tenantId: acme, address: address(ada), actorId: admin }),
    ).toEqual({ status: "deleting" })
    // The directory's reactivation (the store call `mailForActive` makes).
    await directoryMailStore(db).resume(acme, ada, { type: "mailbox.resumed" })
    // A payment arriving.
    await owner`update authd.accounts set payment_hold_at = now() where clerk_user_id = ${ada}`
    await owner`update authd.accounts set payment_hold_at = null where clerk_user_id = ${ada}`

    expect(await gates(ada)).toMatchObject({ deleting: true, refused: true })
    // And a suspend does not stack on top of it.
    expect(
      await life().suspend({ tenantId: acme, address: address(ada), actorId: admin }),
    ).toBe("deleting")
  })

  it("deleting a suspended mailbox and restoring it leaves it suspended", async () => {
    const input = { tenantId: acme, address: address(ada), actorId: admin }
    await life().suspend(input)
    await life().remove({ ...input, request: { outcome: "delete" } })
    expect(await life().restore(input)).toBe("restored")
    expect(await gates(ada)).toMatchObject({ deleting: false, suspended: true })
  })

  // ── Restore ───────────────────────────────────────────────────────────────

  it("restore within the 30 days gives the mailbox back, with no mail ever lost", async () => {
    const input = { tenantId: acme, address: address(ada), actorId: admin }
    await life().remove({ ...input, request: { outcome: "delete" } })
    clock = new Date(T0.getTime() + 29 * DAY)

    expect(await life().restore(input)).toBe("restored")
    expect(await gates(ada)).toMatchObject({
      deleting: false,
      refused: false,
      active: true,
    })
    expect(
      await owner`select 1 from core.mailbox_deletions where clerk_user_id = ${ada}`,
    ).toHaveLength(0)
    expect(await eventTypes()).toContain("mailbox.restored")
    // The way back is open again and nothing is left of the first deletion.
    expect(
      (await life().remove({ ...input, request: { outcome: "delete" } })).status,
    ).toBe("deleting")
  })

  it("restore after the 30 days is refused, and restoring what is not deleting says so", async () => {
    const input = { tenantId: acme, address: address(ada), actorId: admin }
    expect(await life().restore(input)).toBe("not_deleting")

    await life().remove({ ...input, request: { outcome: "delete" } })
    clock = new Date(T0.getTime() + 30 * DAY)
    expect(await life().restore(input)).toBe("window_closed")
    expect((await gates(ada)).deleting).toBe(true)
  })

  // ── Forward ───────────────────────────────────────────────────────────────

  it("forward installs the existing list route and restore takes it away", async () => {
    const input = { tenantId: acme, address: address(ada), actorId: admin }
    const done = await life().remove({
      ...input,
      request: { outcome: "forward", forward_to: address(bob) },
    })
    expect(done.status).toBe("deleting")

    const [group] = await owner`select email, description from authd.groups
                                 where name = ${`fwd-${ada}`}`
    expect(group).toMatchObject({ email: address(ada), description: "fwd" })
    expect(await groupMembers(`fwd-${ada}`)).toEqual([bob])

    await life().restore(input)
    expect(await groupExists(`fwd-${ada}`)).toBe(false)
  })

  it("forward refuses a target that cannot take the mail", async () => {
    const input = {
      tenantId: acme,
      address: address(ada),
      actorId: admin,
    }
    const forward = (to: string) =>
      life().remove({ ...input, request: { outcome: "forward", forward_to: to } })

    expect(await forward(address(ada))).toEqual({ status: "forward_invalid" })
    expect(await forward(`nobody@${domain}`)).toEqual({ status: "forward_invalid" })
    await owner`update authd.accounts set suspended_at = now() where clerk_user_id = ${bob}`
    expect(await forward(address(bob))).toEqual({ status: "forward_invalid" })
    await owner`update authd.accounts set suspended_at = null, deleting_at = now()
                 where clerk_user_id = ${bob}`
    expect(await forward(address(bob))).toEqual({ status: "forward_invalid" })
    await owner`update authd.accounts set deleting_at = null, active = false
                 where clerk_user_id = ${bob}`
    expect(await forward(address(bob))).toEqual({ status: "forward_invalid" })
    expect((await gates(ada)).deleting).toBe(false)
    expect(await groupExists(`fwd-${ada}`)).toBe(false)
  })

  it("forward refuses an address that already has a forward, and a mailbox others forward to", async () => {
    await life().remove({
      tenantId: acme,
      address: address(ada),
      actorId: admin,
      request: { outcome: "forward", forward_to: address(bob) },
    })

    // ⚠ BOB RECEIVES ADA'S MAIL: deleting him would leave a list with no member.
    expect(
      await life().remove({
        tenantId: acme,
        address: address(bob),
        actorId: admin,
        request: { outcome: "delete" },
      }),
    ).toEqual({ status: "forward_target_in_use" })
    expect((await gates(bob)).deleting).toBe(false)

    // A forward of the same address from a leaver policy is in the way too.
    await owner`insert into authd.groups (name, email, description)
                values (${`fwd-${cy}`}, ${address(cy)}, 'fwd')`
    expect(
      await life().remove({
        tenantId: acme,
        address: address(cy),
        actorId: admin,
        request: { outcome: "forward", forward_to: address(bob) },
      }),
    ).toEqual({ status: "forward_exists" })
  })

  // ── Export then delete ────────────────────────────────────────────────────

  it("export_then_delete starts the export after sign-in has stopped", async () => {
    const done = await life().remove({
      tenantId: acme,
      address: address(ada),
      actorId: admin,
      request: { outcome: "export_then_delete" },
    })
    expect(done.status).toBe("deleting")
    expect(exportsStarted).toEqual([{ address: address(ada), requestedBy: admin }])
    expect((await gates(ada)).deleting).toBe(true)
  })

  it("a deployment that cannot export refuses export_then_delete before changing anything", async () => {
    const done = await life({ exportable: false }).remove({
      tenantId: acme,
      address: address(ada),
      actorId: admin,
      request: { outcome: "export_then_delete" },
    })
    expect(done).toEqual({ status: "export_unavailable" })
    expect(await gates(ada)).toMatchObject({ deleting: false, refused: false })
  })

  it("an export that cannot be queued undoes the deletion", async () => {
    exportShouldFail = true
    const done = await life().remove({
      tenantId: acme,
      address: address(ada),
      actorId: admin,
      request: { outcome: "export_then_delete" },
    })
    expect(done).toEqual({ status: "export_failed" })
    expect(await gates(ada)).toMatchObject({ deleting: false, refused: false })
    expect(
      await owner`select 1 from core.mailbox_deletions where clerk_user_id = ${ada}`,
    ).toHaveLength(0)
  })

  // ── The console ───────────────────────────────────────────────────────────

  it("the console list and detail show the deleting state, its outcome and its date", async () => {
    await life().remove({
      tenantId: acme,
      address: address(ada),
      actorId: admin,
      request: { outcome: "forward", forward_to: address(bob) },
    })
    const console = consoleMailboxes({
      store: consoleMailboxStore(db),
      pool: async () => ({
        kind: "uncapped",
        total: null,
        allocated: 0,
        used: 0,
        remaining: null,
        unallocated: 0,
      }),
    })
    const viewer = { tenantId: acme, userId: admin, isAdmin: true }

    const one = await console.get(viewer, address(ada))
    expect(one?.status).toBe("deleting")
    expect(one?.deletion).toEqual({
      outcome: "forward",
      deletedAt: T0.toISOString(),
      purgeAt: new Date(T0.getTime() + 30 * DAY).toISOString(),
      forwardTo: address(bob),
      exportWait: null,
    })
    const listed = (await console.list(viewer)).data.find(
      (m) => m.address === address(ada),
    )
    expect(listed?.status).toBe("deleting")
    expect((await console.get(viewer, address(cy)))?.deletion).toBeNull()
  })

  // ── The purge ─────────────────────────────────────────────────────────────

  /** The purge's collaborators, recording what each saw of the database as it was called. */
  function world(over: { clerkKept?: string[] } = {}) {
    const calls: string[] = []
    const seen: Record<string, unknown> = {}
    let destroyed = 0
    const accounts: MailboxAccounts = {
      async destroy(addr) {
        calls.push(`destroy:${addr}`)
        // The first destroy finds an account, the next says there is none.
        const existed = destroyed++ === 0
        if (existed) seen.activeAtDestroy = (await gates(ada)).active
        return existed
      },
    }
    const deps: PurgeDeps = {
      store: store(),
      accounts,
      clerk: {
        async remove(userId, addresses) {
          calls.push(`clerk:${userId}:${addresses.join(",")}`)
          seen.stillRowAtClerk = await accountExists(ada)
          return { kept: over.clerkKept ?? [] }
        },
      },
      exports: { latest: async () => null },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => clock,
    }
    return { calls, seen, deps }
  }

  const deleteAda = async (
    request: Parameters<ReturnType<typeof life>["remove"]>[0]["request"] = {
      outcome: "delete",
    },
  ) => {
    const done = await life().remove({
      tenantId: acme,
      address: address(ada),
      actorId: admin,
      request,
    })
    expect(done.status).toBe("deleting")
  }

  it("a directory provisioning the same person cannot switch a closed mailbox back on", async () => {
    await deleteAda()
    await owner`update authd.accounts set active = false where clerk_user_id = ${ada}`
    expect(await mailboxDirectory(db).activate(ada)).toBeNull()
    expect((await gates(ada)).active).toBe(false)
    // A mailbox that is not deleting activates as before.
    expect((await mailboxDirectory(db).activate(cy))?.address).toBe(address(cy))
  })

  it("does nothing before the date", async () => {
    await deleteAda()
    clock = new Date(T0.getTime() + 30 * DAY - 1)
    const w = world()
    expect(await purgeMailbox(w.deps, { tenantId: acme, clerkUserId: ada })).toBe(
      "not_due",
    )
    expect(w.calls).toEqual([])
    expect(await gates(ada)).toMatchObject({ active: true, deleting: true })
  })

  it("closes the address, destroys the mail, frees the Clerk address, then removes the rows", async () => {
    await deleteAda()
    clock = new Date(T0.getTime() + 30 * DAY)
    const w = world()

    expect(await purgeMailbox(w.deps, { tenantId: acme, clerkUserId: ada })).toBe(
      "purged",
    )

    // ⚠ THE ORDER: closed before anything is destroyed, the account row still
    // there while Clerk is asked, and the destroy repeated until the registry has none.
    expect(w.seen.activeAtDestroy).toBe(false)
    expect(w.seen.stillRowAtClerk).toBe(true)
    expect(w.calls).toEqual([
      `destroy:${address(ada)}`,
      `destroy:${address(ada)}`,
      `clerk:${ada}:${address(ada)}`,
      `destroy:${address(ada)}`,
    ])

    expect(await accountExists(ada)).toBe(false)
    expect(
      await owner`select 1 from core.mailbox_deletions where clerk_user_id = ${ada}`,
    ).toHaveLength(0)
    const types = await eventTypes()
    expect(types).toContain("mailbox.purge_started")
    expect(types).toContain("mailbox.purged")
    // The address is free for somebody else only now.
    expect(await mailboxDirectory(db).addressTaken(address(ada))).toBe(false)
    // Another mailbox is untouched.
    expect(await gates(cy)).toMatchObject({ active: true, refused: false })
  })

  it("takes every Clerk address of the mailbox, aliases the person was given included", async () => {
    await owner`insert into authd.aliases (address, clerk_user_id, source)
                values (${`ada.alias@${domain}`}, ${ada}, 'clerk'),
                       (${`ada.dir@${domain}`}, ${ada}, 'directory')`
    await deleteAda()
    clock = new Date(T0.getTime() + 30 * DAY)
    const w = world()
    await purgeMailbox(w.deps, { tenantId: acme, clerkUserId: ada })
    const clerk = w.calls.find((c) => c.startsWith("clerk:"))!
    expect(clerk).toContain(address(ada))
    expect(clerk).toContain(`ada.alias@${domain}`)
    // A directory's alias is the directory's: it leaves with the row.
    expect(clerk).not.toContain(`ada.dir@${domain}`)
    expect(
      await owner`select 1 from authd.aliases where clerk_user_id = ${ada}`,
    ).toHaveLength(0)
  })

  // ⚠ A CRASH AT ANY STEP, THEN THE NEXT RUN.
  for (const crash of ["first destroy", "clerk", "second destroy", "rows"] as const) {
    it(`survives a crash at the ${crash}: nothing is claimable, and the next run finishes`, async () => {
      await deleteAda()
      clock = new Date(T0.getTime() + 30 * DAY)
      const w = world()
      let destroys = 0
      let armed = true
      const failing: PurgeDeps = {
        ...w.deps,
        accounts: {
          async destroy(addr) {
            destroys++
            if (
              armed &&
              ((crash === "first destroy" && destroys === 1) ||
                (crash === "second destroy" && destroys === 3))
            ) {
              armed = false
              throw new Error("stalwart down")
            }
            // Idempotent like the real thing: an account exists until it is destroyed once.
            return w.deps.accounts.destroy(addr)
          },
        },
        clerk: {
          async remove(userId, addresses) {
            if (armed && crash === "clerk") {
              armed = false
              throw new Error("clerk down")
            }
            return w.deps.clerk.remove(userId, addresses)
          },
        },
        store: {
          ...w.deps.store,
          async finish(...args) {
            if (armed && crash === "rows") {
              armed = false
              throw new Error("database down")
            }
            return w.deps.store.finish(...args)
          },
        },
      }

      await expect(
        purgeMailbox(failing, { tenantId: acme, clerkUserId: ada }),
      ).rejects.toThrow()

      // Half done, and safe: the address still belongs to the old mailbox, so nobody
      // else can take it, and it has stopped receiving.
      expect(await mailboxDirectory(db).addressTaken(address(ada))).toBe(true)
      expect(await gates(ada)).toMatchObject({ active: false, deleting: true })
      expect(await accountExists(ada)).toBe(true)

      expect(await purgeMailbox(failing, { tenantId: acme, clerkUserId: ada })).toBe(
        "purged",
      )
      expect(await accountExists(ada)).toBe(false)
      expect(await mailboxDirectory(db).addressTaken(address(ada))).toBe(false)
      // And a third run finds nothing to do.
      expect(await purgeMailbox(failing, { tenantId: acme, clerkUserId: ada })).toBe(
        "gone",
      )
    })
  }

  it("finishes when the projection already removed the account row", async () => {
    await deleteAda()
    clock = new Date(T0.getTime() + 30 * DAY)
    const w = world()
    // Clerk's event for the removed address deletes the row before the last step.
    const racing: PurgeDeps = {
      ...w.deps,
      clerk: {
        async remove(userId, addresses) {
          const kept = await w.deps.clerk.remove(userId, addresses)
          await owner`delete from authd.accounts where clerk_user_id = ${ada}`
          return kept
        },
      },
    }
    expect(await purgeMailbox(racing, { tenantId: acme, clerkUserId: ada })).toBe(
      "purged",
    )
    expect(
      await owner`select 1 from core.mailbox_deletions where clerk_user_id = ${ada}`,
    ).toHaveLength(0)
  })

  it("records an address that Clerk had to leave on the person", async () => {
    await deleteAda()
    clock = new Date(T0.getTime() + 30 * DAY)
    const w = world({ clerkKept: [address(ada)] })
    expect(await purgeMailbox(w.deps, { tenantId: acme, clerkUserId: ada })).toBe(
      "purged",
    )
    const [event] = await owner`select data from identity.events
                                 where tenant_id = ${acme} and type = 'mailbox.purged'`
    expect(event!.data).toMatchObject({ clerkAddressKept: [address(ada)] })
  })

  it("a restore that has won the lock leaves the purge nothing to do", async () => {
    await deleteAda()
    clock = new Date(T0.getTime() + 10 * DAY)
    await life().restore({ tenantId: acme, address: address(ada), actorId: admin })
    clock = new Date(T0.getTime() + 31 * DAY)
    const w = world()
    expect(await purgeMailbox(w.deps, { tenantId: acme, clerkUserId: ada })).toBe(
      "gone",
    )
    expect(w.calls).toEqual([])
    expect(await gates(ada)).toMatchObject({ active: true, deleting: false })
  })

  it("never removes a mailbox that is not deleting, whatever the clock says", async () => {
    clock = new Date(T0.getTime() + 400 * DAY)
    const w = world()
    expect(await purgeDueMailboxes({ ...w.deps })).toMatchObject({ purged: 0 })
    expect(await accountExists(ada)).toBe(true)
    expect(await accountExists(cy)).toBe(true)
  })

  it("purgeDueMailboxes walks every workspace and counts what it did", async () => {
    await deleteAda()
    await life().remove({
      tenantId: acme,
      address: address(cy),
      actorId: admin,
      request: { outcome: "delete" },
    })
    clock = new Date(T0.getTime() + 30 * DAY)
    const w = world()
    const counts = await purgeDueMailboxes(w.deps)
    // Other test files' leftovers may be in the table, so this counts at least ours.
    expect(counts.purged).toBeGreaterThanOrEqual(2)
    expect(await accountExists(ada)).toBe(false)
    expect(await accountExists(cy)).toBe(false)
    expect(await accountExists(bob)).toBe(true)
  })

  // ── Export gating ─────────────────────────────────────────────────────────

  describe("export_then_delete waits for its export", () => {
    const job = (over: Partial<MailboxJobRow>): MailboxJobRow =>
      ({
        id: crypto.randomUUID(),
        tenantId: acme,
        mailboxAddress: address(ada),
        type: "export",
        status: "completed",
        createdAt: new Date(T0.getTime() + 1000),
        completedAt: new Date(T0.getTime() + 60_000),
        expiresAt: new Date(T0.getTime() + 7 * DAY),
        ...over,
      }) as MailboxJobRow

    const purgeWith = async (latest: MailboxJobRow | null, now: Date) => {
      clock = now
      const w = world()
      const outcome = await purgeMailbox(
        { ...w.deps, exports: { latest: async () => latest } },
        { tenantId: acme, clerkUserId: ada },
      )
      return { outcome, w }
    }

    beforeEach(async () => {
      await deleteAda({ outcome: "export_then_delete" })
    })

    const due = new Date(T0.getTime() + 30 * DAY)

    it("waits with no export, a running one, and a failed one", async () => {
      for (const latest of [
        null,
        job({ status: "pending", expiresAt: null }),
        job({ status: "running", expiresAt: null }),
        job({ status: "failed", expiresAt: null }),
      ]) {
        const { outcome, w } = await purgeWith(latest, due)
        expect(outcome).toBe("waiting_export")
        // Nothing was closed or destroyed: the mailbox is untouched and still receiving.
        expect(w.calls).toEqual([])
        expect(await gates(ada)).toMatchObject({ active: true, deleting: true })
      }
    })

    it("does not count an export from before the deletion", async () => {
      const { outcome } = await purgeWith(
        job({ createdAt: new Date(T0.getTime() - DAY) }),
        due,
      )
      expect(outcome).toBe("waiting_export")
    })

    it("waits until the finished export has been available for its whole retention", async () => {
      // Finished late, on day 29: it expires on day 36, so day 30 is too soon.
      const late = job({
        completedAt: new Date(T0.getTime() + 29 * DAY),
        expiresAt: new Date(T0.getTime() + 36 * DAY),
      })
      expect((await purgeWith(late, due)).outcome).toBe("waiting_export")
      expect(
        (await purgeWith(late, new Date(T0.getTime() + 36 * DAY - 1))).outcome,
      ).toBe("waiting_export")
      expect((await purgeWith(late, new Date(T0.getTime() + 36 * DAY))).outcome).toBe(
        "purged",
      )
    })

    it("purges on the date when the export finished early and has run its course", async () => {
      expect((await purgeWith(job({}), due)).outcome).toBe("purged")
    })
  })

  // ── Forward, after the purge ──────────────────────────────────────────────

  it("a forwarded address keeps its list after the purge, and nobody can take the address", async () => {
    await deleteAda({ outcome: "forward", forward_to: address(bob) })
    clock = new Date(T0.getTime() + 30 * DAY)
    const w = world()
    expect(await purgeMailbox(w.deps, { tenantId: acme, clerkUserId: ada })).toBe(
      "purged",
    )

    expect(await accountExists(ada)).toBe(false)
    expect(await groupExists(`fwd-${ada}`)).toBe(true)
    expect(await groupMembers(`fwd-${ada}`)).toEqual([bob])
    // ⚠ THE LIST IS THE ADDRESS NOW, so provisioning must treat it as taken.
    expect(await mailboxDirectory(db).addressTaken(address(ada))).toBe(true)
  })

  it("a forward whose target is gone becomes a plain delete rather than a list for nobody", async () => {
    await deleteAda({ outcome: "forward", forward_to: address(bob) })
    // The target's mailbox goes by another route (a directory's delete, say).
    await owner`delete from authd.accounts where clerk_user_id = ${bob}`
    clock = new Date(T0.getTime() + 30 * DAY)
    const w = world()
    expect(await purgeMailbox(w.deps, { tenantId: acme, clerkUserId: ada })).toBe(
      "purged",
    )
    expect(await groupExists(`fwd-${ada}`)).toBe(false)
    expect(await eventTypes()).toContain("mailbox.forward_lost")
    expect(await mailboxDirectory(db).addressTaken(address(ada))).toBe(false)
  })

  it("a plain delete drops a forward a leaver policy had left on the address", async () => {
    await owner`insert into authd.groups (name, email, description)
                values (${`fwd-${ada}`}, ${address(ada)}, 'fwd')`
    await owner`insert into authd.group_members (group_name, clerk_user_id)
                values (${`fwd-${ada}`}, ${cy})`
    await deleteAda()
    clock = new Date(T0.getTime() + 30 * DAY)
    expect(await purgeMailbox(world().deps, { tenantId: acme, clerkUserId: ada })).toBe(
      "purged",
    )
    expect(await groupExists(`fwd-${ada}`)).toBe(false)
  })

  // ── Aliases follow the forward ────────────────────────────────────────────

  describe("a forwarded mailbox's aliases", () => {
    const aliasOf = (source: string) => `ada.${source}@${domain}`
    const sources = ["clerk", "directory", "console"] as const
    const aliasList = (source: string) => aliasListName(ada, aliasOf(source))

    beforeEach(async () => {
      for (const source of sources)
        await owner`insert into authd.aliases (address, clerk_user_id, source)
                    values (${aliasOf(source)}, ${ada}, ${source})`
    })

    const aliasRows = async () =>
      (await owner`select address from authd.aliases where clerk_user_id = ${ada}`)
        .length

    it("keep delivering to the mailbox during the grace, and a restore leaves them as they were", async () => {
      await deleteAda({ outcome: "forward", forward_to: address(bob) })
      expect(await aliasRows()).toBe(3)
      for (const source of sources)
        expect(await groupExists(aliasList(source))).toBe(false)

      clock = new Date(T0.getTime() + 10 * DAY)
      expect(
        await life().restore({ tenantId: acme, address: address(ada), actorId: admin }),
      ).toBe("restored")
      expect(await aliasRows()).toBe(3)
      for (const source of sources)
        expect(await groupExists(aliasList(source))).toBe(false)
    })

    it("become forwards to the same target at the purge, every source, and stay held", async () => {
      await deleteAda({ outcome: "forward", forward_to: address(bob) })
      clock = new Date(T0.getTime() + 30 * DAY)
      expect(
        await purgeMailbox(world().deps, { tenantId: acme, clerkUserId: ada }),
      ).toBe("purged")

      expect(await aliasRows()).toBe(0)
      for (const source of sources) {
        const [group] = await owner`select email, description from authd.groups
                                     where name = ${aliasList(source)}`
        expect(group).toMatchObject({ email: aliasOf(source), description: "fwd" })
        expect(await groupMembers(aliasList(source))).toEqual([bob])
        // ⚠ HELD: nobody can claim an address that now forwards somebody's mail.
        expect(await mailboxDirectory(db).addressTaken(aliasOf(source))).toBe(true)
      }
      // The primary's own list is unchanged by this.
      expect(await groupMembers(`fwd-${ada}`)).toEqual([bob])
      const [event] = await owner`select data from identity.events
                                   where tenant_id = ${acme} and type = 'mailbox.purged'`
      expect(event!.data).toMatchObject({
        aliasesForwarded: sources.map(aliasOf).sort(),
      })
    })

    it("are never an address that answers for nobody: a crash before the rows leaves them aliases", async () => {
      await deleteAda({ outcome: "forward", forward_to: address(bob) })
      clock = new Date(T0.getTime() + 30 * DAY)
      const w = world()
      let armed = true
      const failing: PurgeDeps = {
        ...w.deps,
        store: {
          ...w.deps.store,
          async finish(...args) {
            if (armed) {
              armed = false
              throw new Error("database down")
            }
            return w.deps.store.finish(...args)
          },
        },
      }
      await purgeMailbox(failing, { tenantId: acme, clerkUserId: ada }).then(
        () => {
          throw new Error("expected the purge to fail")
        },
        () => {},
      )

      // Neither half-way: the rows are still aliases of a closed mailbox (refused
      // like the primary), with no list yet, and still held.
      expect(await aliasRows()).toBe(3)
      for (const source of sources) {
        expect(await groupExists(aliasList(source))).toBe(false)
        expect(await mailboxDirectory(db).addressTaken(aliasOf(source))).toBe(true)
      }

      expect(await purgeMailbox(failing, { tenantId: acme, clerkUserId: ada })).toBe(
        "purged",
      )
      expect(await aliasRows()).toBe(0)
      for (const source of sources)
        expect(await groupMembers(aliasList(source))).toEqual([bob])
    })

    it("go the way of the address when the target is gone, rather than forward to nobody", async () => {
      await deleteAda({ outcome: "forward", forward_to: address(bob) })
      await owner`delete from authd.accounts where clerk_user_id = ${bob}`
      clock = new Date(T0.getTime() + 30 * DAY)
      expect(
        await purgeMailbox(world().deps, { tenantId: acme, clerkUserId: ada }),
      ).toBe("purged")
      for (const source of sources) {
        expect(await groupExists(aliasList(source))).toBe(false)
        expect(await mailboxDirectory(db).addressTaken(aliasOf(source))).toBe(false)
      }
    })

    it("leave out an address some other list already answers for, instead of failing the purge", async () => {
      await deleteAda({ outcome: "forward", forward_to: address(bob) })
      await owner`insert into authd.groups (name, email, description)
                  values (${`fwd-${cy}-other`}, ${aliasOf("clerk")}, 'team')`
      clock = new Date(T0.getTime() + 30 * DAY)
      expect(
        await purgeMailbox(world().deps, { tenantId: acme, clerkUserId: ada }),
      ).toBe("purged")
      expect(await groupExists(aliasList("clerk"))).toBe(false)
      expect(await groupExists(aliasList("console"))).toBe(true)
    })

    it("only a forward hands them on: a plain delete releases them with the mailbox", async () => {
      await deleteAda()
      clock = new Date(T0.getTime() + 30 * DAY)
      await purgeMailbox(world().deps, { tenantId: acme, clerkUserId: ada })
      for (const source of sources) {
        expect(await groupExists(aliasList(source))).toBe(false)
        expect(await mailboxDirectory(db).addressTaken(aliasOf(source))).toBe(false)
      }
    })

    it("keep the target from being deleted, like the primary's forward does", async () => {
      await deleteAda({ outcome: "forward", forward_to: address(bob) })
      clock = new Date(T0.getTime() + 30 * DAY)
      await purgeMailbox(world().deps, { tenantId: acme, clerkUserId: ada })
      // Only the alias lists are left to refuse it: the primary's has been let go.
      await owner`delete from authd.groups where name = ${`fwd-${ada}`}`

      expect(
        await life().remove({
          tenantId: acme,
          address: address(bob),
          actorId: admin,
          request: { outcome: "delete" },
        }),
      ).toEqual({ status: "forward_target_in_use" })
      expect((await gates(bob)).deleting).toBe(false)
    })

    it("are released together with the primary's forward by the one call that drops routes", async () => {
      await deleteAda({ outcome: "forward", forward_to: address(bob) })
      clock = new Date(T0.getTime() + 30 * DAY)
      await purgeMailbox(world().deps, { tenantId: acme, clerkUserId: ada })

      await db.transaction((tx) => directoryMail.dropRoutes(tx, ada))
      expect(await groupExists(`fwd-${ada}`)).toBe(false)
      for (const source of sources) {
        expect(await groupExists(aliasList(source))).toBe(false)
        expect(await mailboxDirectory(db).addressTaken(aliasOf(source))).toBe(false)
      }
    })
  })

  // ── A failed export is visible ────────────────────────────────────────────

  describe("a deleting mailbox whose export did not finish", () => {
    const job = (over: Record<string, unknown>) => ({
      status: "completed",
      created_at: new Date(T0.getTime() + 1000),
      completed_at: new Date(T0.getTime() + 60_000),
      expires_at: new Date(T0.getTime() + 7 * DAY),
      ...over,
    })
    const addJob = async (over: Record<string, unknown> = {}) => {
      const j = job(over)
      await owner`insert into core.mailbox_jobs
                    (tenant_id, mailbox_address, type, status, requested_by,
                     created_at, completed_at, expires_at)
                  values (${acme}, ${address(ada)}, 'export', ${j.status as string}, ${admin},
                          ${j.created_at as Date}, ${j.completed_at as Date},
                          ${j.expires_at as Date | null})`
    }
    const consoleView = async () => {
      const c = consoleMailboxes({
        store: consoleMailboxStore(db, () => clock),
        pool: async () => ({
          kind: "uncapped",
          total: null,
          allocated: 0,
          used: 0,
          remaining: null,
          unallocated: 0,
        }),
      })
      return (
        await c.get({ tenantId: acme, userId: admin, isAdmin: true }, address(ada))
      )?.deletion
    }

    beforeEach(async () => {
      await deleteAda({ outcome: "export_then_delete" })
    })

    it("says in the console why it is waiting, with the purge's own rule", async () => {
      clock = new Date(T0.getTime() + 2 * DAY)
      expect((await consoleView())?.exportWait).toEqual({
        reason: "export_missing",
        readyAfter: null,
      })

      await addJob({ status: "running", completed_at: null, expires_at: null })
      expect((await consoleView())?.exportWait).toEqual({
        reason: "export_pending",
        readyAfter: null,
      })

      await owner`delete from core.mailbox_jobs where tenant_id = ${acme}`
      await addJob({ status: "failed", expires_at: null })
      expect((await consoleView())?.exportWait?.reason).toBe("export_failed")

      await owner`delete from core.mailbox_jobs where tenant_id = ${acme}`
      await addJob()
      expect((await consoleView())?.exportWait).toEqual({
        reason: "export_ready_after",
        readyAfter: new Date(T0.getTime() + 7 * DAY).toISOString(),
      })

      // Past its retention it is not waiting any more.
      clock = new Date(T0.getTime() + 8 * DAY)
      expect((await consoleView())?.exportWait).toBeNull()
    })

    it("an export from before the deletion is missing, not ready", async () => {
      await addJob({ created_at: new Date(T0.getTime() - DAY) })
      expect((await consoleView())?.exportWait?.reason).toBe("export_missing")
    })

    it("the purge reports a failed export once a day, with the tenant and no address", async () => {
      const errors: { o: object; m: string }[] = []
      const log = {
        info: () => {},
        warn: () => {},
        error: (o: object, m: string) => errors.push({ o, m }),
      }
      const failed = {
        id: "j",
        status: "failed",
        createdAt: new Date(T0.getTime() + 1000),
        expiresAt: null,
      } as unknown as MailboxJobRow
      const run = async (at: Date) => {
        clock = at
        return purgeMailbox(
          { ...world().deps, log, exports: { latest: async () => failed } },
          { tenantId: acme, clerkUserId: ada },
        )
      }

      const due = new Date(T0.getTime() + 30 * DAY)
      expect(await run(due)).toBe("waiting_export")
      expect(await run(new Date(due.getTime() + 60 * 60 * 1000))).toBe("waiting_export")
      expect(await run(new Date(due.getTime() + 23 * 60 * 60 * 1000))).toBe(
        "waiting_export",
      )
      expect(errors).toHaveLength(1)
      expect(errors[0]!.o).toEqual({ tenantId: acme, reason: "export_failed" })
      expect(JSON.stringify(errors)).not.toContain(address(ada))

      expect(await run(new Date(due.getTime() + 25 * 60 * 60 * 1000))).toBe(
        "waiting_export",
      )
      expect(errors).toHaveLength(2)
    })

    it("a running or finished-but-not-yet-offered export is not an error", async () => {
      const errors: unknown[] = []
      const log = {
        info: () => {},
        warn: () => {},
        error: (o: object) => errors.push(o),
      }
      for (const latest of [
        { status: "running", expiresAt: null },
        { status: "completed", expiresAt: new Date(T0.getTime() + 36 * DAY) },
      ]) {
        clock = new Date(T0.getTime() + 30 * DAY)
        const out = await purgeMailbox(
          {
            ...world().deps,
            log,
            exports: {
              latest: async () =>
                ({
                  ...latest,
                  createdAt: new Date(T0.getTime() + 1000),
                }) as MailboxJobRow,
            },
          },
          { tenantId: acme, clerkUserId: ada },
        )
        expect(out).toBe("waiting_export")
      }
      expect(errors).toEqual([])
    })

    it("an admin starts the export again, and it is one the purge counts", async () => {
      clock = new Date(T0.getTime() + 20 * DAY)
      const done = await life().retryExport({
        tenantId: acme,
        address: address(ada),
        actorId: admin,
      })
      expect(done).toBe("started")
      // Once from the deletion, once from the retry.
      expect(exportsStarted).toEqual([
        { address: address(ada), requestedBy: admin },
        { address: address(ada), requestedBy: admin },
      ])
    })

    it("a retry is refused for what is not waiting for an export", async () => {
      const input = { tenantId: acme, address: address(ada), actorId: admin }
      expect(await life().retryExport({ ...input, tenantId: rival })).toBe("not_found")
      expect(await life({ exportable: false }).retryExport(input)).toBe(
        "export_unavailable",
      )
      expect(await life().retryExport({ ...input, address: address(cy) })).toBe(
        "not_deleting",
      )

      await life().restore(input)
      expect(await life().retryExport(input)).toBe("not_deleting")

      await deleteAda({ outcome: "delete" })
      expect(await life().retryExport(input)).toBe("not_waiting_for_export")
    })

    it("a retry whose queue is down says so and changes nothing", async () => {
      exportShouldFail = true
      expect(
        await life().retryExport({
          tenantId: acme,
          address: address(ada),
          actorId: admin,
        }),
      ).toBe("export_failed")
      expect(await gates(ada)).toMatchObject({ deleting: true })
    })
  })
})
