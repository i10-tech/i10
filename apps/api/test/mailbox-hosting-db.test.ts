import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { mailboxHosting } from "../src/domains/mailbox-hosting.js"
import { directoryMailStore } from "../src/identity/mail-store.js"
import type { StalwartCaller } from "../src/mail/stalwart.js"
import { MANAGED_MARKER } from "../src/mail/stalwart-domains.js"
import { mailRevocation } from "../src/mailboxes/revoke.js"

/**
 * Hosting mailboxes needs ownership of the name and nothing else (#406), against
 * a real database as `i10_api`: the SQL rule behind `core.mailbox_domains()`, and
 * the service that switches it on and off.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:<pw>@localhost:<port>/i10 bun test test/mailbox-hosting-db.test.ts
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
const name = (label: string) => `${label}-${sfx}.test`
const ids = [`user_ada${sfx}`, `user_bob${sfx}`, `user_eve${sfx}`]
const [ada, bob, eve] = ids as [string, string, string]

/** A Stalwart registry that holds Domain objects, and can be made to fail. */
function fakeStalwart() {
  const store: Record<string, unknown>[] = []
  let next = 1
  const state = { failing: false }
  const call: StalwartCaller = async (methodCalls) => {
    if (state.failing) throw new Error("stalwart is down")
    const [method, args] = methodCalls[0] as [string, Record<string, unknown>, string]
    if (method === "x:Domain/query") return [method, { ids: store.map((d) => d.id) }]
    if (method === "x:Domain/get") {
      const wanted = args.ids as string[]
      return [method, { list: store.filter((d) => wanted.includes(d.id as string)) }]
    }
    if (method === "x:Domain/set") {
      for (const value of Object.values((args.create ?? {}) as Record<string, object>))
        store.push({ id: `d${next++}`, ...value })
      for (const [id, patch] of Object.entries(
        (args.update ?? {}) as Record<string, object>,
      ))
        Object.assign(store.find((d) => d.id === id) ?? {}, patch)
      return [method, { created: {}, notCreated: {}, notUpdated: {}, notDestroyed: {} }]
    }
    throw new Error(`unexpected ${method}`)
  }
  return { call, store, state, find: (n: string) => store.find((d) => d.name === n) }
}

suite("mailbox hosting by ownership", () => {
  let stalwart: ReturnType<typeof fakeStalwart>
  let exceeded = false

  const hosting = () =>
    mailboxHosting({
      db,
      capacity: { check: async () => ({ status: exceeded ? "exceeded" : "ok" }) },
      stalwart: stalwart.call,
      revocation: mailRevocation({
        db,
        mail: directoryMailStore(db),
        isMember: async () => true,
        managedHere: async () => false,
        leaver: () => {
          throw new Error("no leaver here")
        },
        record: async () => {},
        log: { info() {}, warn() {}, error() {} },
      }),
      log: { warn() {} },
    })

  const domainId = async (n: string) =>
    (
      await owner`select id::text as id from core.domains where name = ${n} order by created_at limit 1`
    )[0]!.id as string
  const listed = async () =>
    (
      (await owner`select name, tenant_id::text as tenant_id from core.mailbox_domains()`) as unknown as {
        name: string
        tenant_id: string
      }[]
    ).filter((r) => r.name.endsWith(`-${sfx}.test`))
  const account = async (id: string) =>
    (
      await owner`select suspended_at, credential_epoch::text as epoch from authd.accounts where clerk_user_id = ${id}`
    )[0]!

  const addDomain = (tenant: string, n: string, over: Record<string, unknown> = {}) => {
    const row = {
      tenant_id: tenant,
      name: n,
      hosts_mailboxes: false,
      status: "not_started",
      ...over,
    }
    return owner`insert into core.domains ${owner(row)}`
  }

  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    sqlApi = postgres(API_URL!, { max: 4, onnotice: () => {} })
    db = drizzle(sqlApi, { schema }) as unknown as Database
    for (const [id, label] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const)
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                  values (${id}, ${`h-${id.slice(0, 8)}`}, ${label}, ${`owner-${id}`}, ${`org_${id.slice(0, 8)}`})`
  })

  afterAll(async () => {
    await owner`delete from authd.groups where tenant_id in (${acme}, ${rival})`
    await owner`delete from authd.accounts where clerk_user_id = any(${ids})`
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await sqlApi.end()
  })

  // ── the rule ────────────────────────────────────────────────────────────

  it("lists an owned domain SES never verified, and excludes the ones that do not hold the name", async () => {
    const t = new Date("2026-11-01T10:00:00Z")
    // Proved by DKIM (registered with SES), SES still pending: hosts.
    await addDomain(acme, name("proved"), {
      hosts_mailboxes: true,
      status: "pending",
      identity_registered_at: t,
    })
    // How 0029 seeded i10.tech: `verified_at` only, no registration, not verified.
    await addDomain(acme, name("seeded"), { hosts_mailboxes: true, verified_at: t })
    // Another workspace proved it: displaced rows never host.
    await addDomain(acme, name("displaced"), {
      hosts_mailboxes: true,
      status: "failed",
      verified_at: t,
      identity_registered_at: t,
      displaced_at: t,
    })
    // The re-check stood it down (`displace_domain`): failed with the clock set.
    await addDomain(acme, name("lapsed"), {
      hosts_mailboxes: true,
      status: "failed",
      verified_at: t,
      identity_registered_at: t,
    })
    await owner`update core.domains set proof_missing_since = now() where name = ${name("lapsed")}`
    // Switched on by hand for a name nobody proved.
    await addDomain(acme, name("unproven"), { hosts_mailboxes: true })

    expect((await listed()).map((r) => r.name).sort()).toEqual(
      [name("proved"), name("seeded")].sort(),
    )
  })

  it("counts a TXT proof made for SSO, and not a lapsed or displaced one", async () => {
    await addDomain(acme, name("txt"), { hosts_mailboxes: true })
    await addDomain(acme, name("txtlapsed"), { hosts_mailboxes: true })
    await addDomain(acme, name("txtdisplaced"), { hosts_mailboxes: true })
    const proof = (label: string, over: Record<string, unknown> = {}) =>
      owner`insert into core.join_domains ${owner({
        tenant_id: acme,
        name: name(label),
        clerk_org_id: "org_x",
        source: "txt",
        verified_at: new Date(),
        ...over,
      })}`
    await proof("txt")
    await proof("txtlapsed", { lapsed_at: new Date() })
    await proof("txtdisplaced", { displaced_at: new Date() })

    const names = (await listed()).map((r) => r.name)
    expect(names).toContain(name("txt"))
    expect(names).not.toContain(name("txtlapsed"))
    expect(names).not.toContain(name("txtdisplaced"))
  })

  it("gives a name to ONE workspace: the latest proof wins", async () => {
    const early = new Date("2026-10-01T10:00:00Z")
    const late = new Date("2026-11-02T10:00:00Z")
    await addDomain(acme, name("contested"), {
      hosts_mailboxes: true,
      status: "pending",
      identity_registered_at: early,
    })
    await addDomain(rival, name("contested"), {
      hosts_mailboxes: true,
      status: "pending",
      identity_registered_at: late,
    })

    const rows = (await listed()).filter((r) => r.name === name("contested"))
    expect(rows).toEqual([{ name: name("contested"), tenant_id: rival }])
  })

  // ── the switch ──────────────────────────────────────────────────────────

  it("switches hosting on for an owned domain, and registers it in Stalwart", async () => {
    stalwart = fakeStalwart()
    await addDomain(acme, name("on"), {
      status: "pending",
      identity_registered_at: new Date(),
    })
    const id = await domainId(name("on"))

    const out = await hosting().setEnabled(acme, id, true)

    expect(out).toMatchObject({
      status: "ok",
      stalwart: "synced",
      // Owned, hosting, and SES has not verified it: it can receive, not send.
      mailboxes: { enabled: true, owned: true, sending: false, catch_all: null },
    })
    expect(stalwart.find(name("on"))).toMatchObject({
      description: MANAGED_MARKER,
      enable: true,
    })
    expect((await listed()).map((r) => r.name)).toContain(name("on"))
  })

  it("refuses a domain the workspace has not proved, and one another workspace took", async () => {
    stalwart = fakeStalwart()
    await addDomain(acme, name("nothing"))
    await addDomain(acme, name("lost"), {
      status: "failed",
      identity_registered_at: new Date(),
      displaced_at: new Date(),
    })

    expect(
      await hosting().setEnabled(acme, await domainId(name("nothing")), true),
    ).toEqual({
      status: "not_held",
      reason: "unowned",
    })
    expect(
      await hosting().setEnabled(acme, await domainId(name("lost")), true),
    ).toEqual({
      status: "not_held",
      reason: "displaced",
    })
    expect(
      await owner`select hosts_mailboxes from core.domains where name = ${name("lost")}`,
    ).toMatchObject([{ hosts_mailboxes: false }])
    expect(stalwart.store).toEqual([])
  })

  it("refuses another workspace's domain id, and an id that is not there", async () => {
    await addDomain(rival, name("theirs"), { identity_registered_at: new Date() })
    const id = await domainId(name("theirs"))
    expect(await hosting().setEnabled(acme, id, true)).toEqual({ status: "missing" })
    expect(await hosting().forDomain(acme, id)).toBeNull()
  })

  it("refuses over the allowance, and writes nothing", async () => {
    stalwart = fakeStalwart()
    await addDomain(acme, name("full"), { identity_registered_at: new Date() })
    exceeded = true
    try {
      expect(
        await hosting().setEnabled(acme, await domainId(name("full")), true),
      ).toEqual({
        status: "limit",
      })
    } finally {
      exceeded = false
    }
    expect((await listed()).map((r) => r.name)).not.toContain(name("full"))
    expect(stalwart.store).toEqual([])
  })

  it("hosts on a TXT proof alone, with no sending set-up at all", async () => {
    stalwart = fakeStalwart()
    await addDomain(acme, name("sso"))
    await owner`insert into core.join_domains (tenant_id, name, clerk_org_id, source, verified_at)
                values (${acme}, ${name("sso")}, 'org_x', 'txt', now())`
    const out = await hosting().setEnabled(acme, await domainId(name("sso")), true)
    expect(out).toMatchObject({
      status: "ok",
      mailboxes: { enabled: true, owned: true },
    })
  })

  it("still answers when Stalwart is down: the row is right and the reconcile catches up", async () => {
    stalwart = fakeStalwart()
    stalwart.state.failing = true
    await addDomain(acme, name("down"), { identity_registered_at: new Date() })
    const out = await hosting().setEnabled(acme, await domainId(name("down")), true)
    expect(out).toMatchObject({ status: "ok", stalwart: "pending" })
    expect((await listed()).map((r) => r.name)).toContain(name("down"))
  })

  it("off closes the domain's logins and disables it in Stalwart; on again does not resume a mailbox suspended by hand", async () => {
    stalwart = fakeStalwart()
    const n = name("cycle")
    await addDomain(acme, n, { identity_registered_at: new Date() })
    const id = await domainId(n)
    await owner`insert into authd.accounts (clerk_user_id, email, active, tenant_id, suspended_at)
                values (${ada}, ${`ada@${n}`}, true, ${acme}, '2026-11-01T00:00:00Z')`
    await owner`insert into authd.accounts (clerk_user_id, email, active, tenant_id)
                values (${bob}, ${`bob@${n}`}, true, ${acme})`
    // Somebody else's mailbox on another of this workspace's domains.
    await owner`insert into authd.accounts (clerk_user_id, email, active, tenant_id)
                values (${eve}, ${`eve@${name("on")}`}, true, ${acme})`
    await hosting().setEnabled(acme, id, true)
    const before = {
      ada: await account(ada),
      bob: await account(bob),
      eve: await account(eve),
    }

    const off = await hosting().setEnabled(acme, id, false)

    expect(off).toMatchObject({
      status: "ok",
      mailboxes: { enabled: false, owned: true },
    })
    expect((await listed()).map((r) => r.name)).not.toContain(n)
    expect(stalwart.find(n)).toMatchObject({ enable: false })
    const after = {
      ada: await account(ada),
      bob: await account(bob),
      eve: await account(eve),
    }
    // The cached passwords of the domain's mailboxes are dead; nobody else's are.
    expect(BigInt(after.ada.epoch)).toBeGreaterThan(BigInt(before.ada.epoch))
    expect(BigInt(after.bob.epoch)).toBeGreaterThan(BigInt(before.bob.epoch))
    expect(after.eve.epoch).toBe(before.eve.epoch)
    // And nothing was suspended or un-suspended: it is a domain-level gate.
    expect(after.bob.suspended_at).toBeNull()
    expect(after.ada.suspended_at).toEqual(before.ada.suspended_at)
    // authd's gate says the same thing the list does.
    expect(
      (
        await owner`select core.mailbox_domain_refused(${acme}::uuid, ${n}) as refused`
      )[0]!.refused,
    ).toBe(true)

    // Off again is harmless (a retry completes whatever half failed).
    expect(await hosting().setEnabled(acme, id, false)).toMatchObject({ status: "ok" })

    const on = await hosting().setEnabled(acme, id, true)

    expect(on).toMatchObject({ status: "ok", mailboxes: { enabled: true } })
    expect(stalwart.find(n)).toMatchObject({ enable: true })
    expect(
      (
        await owner`select core.mailbox_domain_refused(${acme}::uuid, ${n}) as refused`
      )[0]!.refused,
    ).toBe(false)
    const back = await account(ada)
    expect(back.suspended_at).toEqual(before.ada.suspended_at)
    expect((await account(bob)).suspended_at).toBeNull()
  })

  it("switching off a twin row does not disable the domain another workspace hosts", async () => {
    stalwart = fakeStalwart()
    const n = name("twin")
    await addDomain(rival, n, {
      hosts_mailboxes: true,
      status: "verified",
      identity_registered_at: new Date(),
    })
    await addDomain(acme, n, { hosts_mailboxes: true })
    await hosting().setEnabled(rival, await rivalRow(n), true)
    expect(stalwart.find(n)).toMatchObject({ enable: true })

    await hosting().setEnabled(acme, await acmeRow(n), false)

    expect(stalwart.find(n)).toMatchObject({ enable: true })
  })

  // ── catch-all ───────────────────────────────────────────────────────────

  it("validates the catch-all target and pushes it to Stalwart", async () => {
    stalwart = fakeStalwart()
    const n = name("catch")
    const sibling = name("on")
    await addDomain(acme, n, { identity_registered_at: new Date() })
    const id = await domainId(n)
    const svc = hosting()

    // Not hosting yet: a catch-all on a domain that does not receive is refused.
    expect(await svc.setCatchAll(acme, id, `ada@${n}`)).toMatchObject({
      status: "rejected",
    })

    await svc.setEnabled(acme, id, true)
    await owner`insert into authd.accounts (clerk_user_id, email, active, tenant_id)
                values (${ada}, ${`ada-${sfx}@${n}`}, true, ${acme})
                on conflict (clerk_user_id) do update set email = excluded.email, tenant_id = excluded.tenant_id`
    await owner`insert into authd.accounts (clerk_user_id, email, active, tenant_id)
                values (${bob}, ${`bob@${name("theirs")}`}, true, ${rival})
                on conflict (clerk_user_id) do update set email = excluded.email, tenant_id = excluded.tenant_id`

    // Another workspace's mailbox, on a domain this one does not host.
    expect(await svc.setCatchAll(acme, id, `bob@${name("theirs")}`)).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("not one of this workspace's mailbox domains"),
    })
    // A hosted domain, but nobody there.
    expect(await svc.setCatchAll(acme, id, `ghost@${n}`)).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("not a mailbox or team inbox"),
    })
    // Not an address at all.
    expect(await svc.setCatchAll(acme, id, "nope")).toMatchObject({
      status: "rejected",
    })
    expect(
      (await owner`select catch_all_address from core.domains where name = ${n}`)[0]!
        .catch_all_address,
    ).toBeNull()

    // A mailbox of the workspace, written to Stalwart.
    const ok = await svc.setCatchAll(acme, id, `ADA-${sfx}@${n}`)
    expect(ok).toMatchObject({
      status: "ok",
      stalwart: "synced",
      mailboxes: { catch_all: `ada-${sfx}@${n}` },
    })
    expect(stalwart.find(n)).toMatchObject({ catchAllAddress: `ada-${sfx}@${n}` })

    // A team inbox on a sibling hosted domain.
    await owner`insert into authd.groups (name, email, tenant_id)
                values (${`team-${sfx}`}, ${`team@${sibling}`}, ${acme})`
    expect(await svc.setCatchAll(acme, id, `team@${sibling}`)).toMatchObject({
      status: "ok",
    })

    // Cleared.
    expect(await svc.setCatchAll(acme, id, null)).toMatchObject({
      status: "ok",
      mailboxes: { catch_all: null },
    })
    expect(stalwart.find(n)).toMatchObject({ catchAllAddress: null })
  })

  it("hands the reconcile each hosted domain with its catch-all", async () => {
    const rows =
      (await owner`select name, catch_all_address from core.mailbox_domain_settings()`) as unknown as {
        name: string
        catch_all_address: string | null
      }[]
    const mine = rows.filter((r) => r.name.endsWith(`-${sfx}.test`))
    expect(mine.map((r) => r.name).sort()).toEqual(
      (await listed()).map((r) => r.name).sort(),
    )
  })

  it("lists every domain's mailboxes view in one call, counting the mailboxes on it", async () => {
    const all = await hosting().forTenant(acme)
    const on = all[await domainId(name("on"))]
    expect(on).toMatchObject({ enabled: true, owned: true, sending: false })
    expect(on!.count).toBe(1)
  })
})

/** The row of a name that belongs to a given workspace (names repeat across workspaces). */
const rowOf = async (tenant: string, n: string) =>
  (
    await owner`select id::text as id from core.domains where name = ${n} and tenant_id = ${tenant}`
  )[0]!.id as string
const rivalRow = (n: string) => rowOf(rival, n)
const acmeRow = (n: string) => rowOf(acme, n)
