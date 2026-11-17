import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { MAILBOX_ALIAS_LIMIT } from "@repo/contracts"
import type { Database } from "../src/db/client.js"
import { mailboxAliases } from "../src/mailboxes/aliases.js"
import { consoleMailboxStore, consoleMailboxes } from "../src/mailboxes/console.js"
import {
  mailboxAdminLifecycle,
  purgeMailbox,
  type PurgeDeps,
} from "../src/mailboxes/lifecycle.js"
import { mailboxLifecycleStore } from "../src/mailboxes/lifecycle-store.js"
import { mailboxDirectory } from "../src/mailboxes/store.js"
import { projectClerkUser } from "../src/projection/writer.js"
import { directoryMailStore } from "../src/identity/mail-store.js"

/**
 * A mailbox's aliases against a real database as `i10_api`: the rules of adding
 * one, and what a suspension, a deletion and the purge do to them.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@127.0.0.1:<port>/i10 bun test test/mailbox-aliases-db.test.ts
 *
 * ⚠ "DELIVERS" IS READ FROM THE SAME QUERY authd RUNS (`AccountsByAddress`,
 * services/authd/internal/projection/postgres.go): an active account, matched by
 * its address or by any row of `authd.aliases`. A test that checked only the alias
 * table would pass for a mailbox the purge had already closed.
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
const main = `acme-${sfx}.test`
const second = `acme2-${sfx}.test`
const unhosted = `off-${sfx}.test`
const theirs = `rival-${sfx}.test`
const admin = `user_admin${sfx}`
const ada = `user_ada${sfx}`
const bob = `user_bob${sfx}`
const people = [ada, bob]
const at = (local: string, domain = main) => `${local}@${domain}`
const T0 = new Date("2026-11-16T10:00:00Z")
const DAY = 24 * 60 * 60 * 1000
let clock = T0

/** The lookup authd answers a recipient check with. */
async function delivers(address: string): Promise<string | null> {
  const rows = await owner`
    select a.clerk_user_id from authd.accounts a
     where a.active
       and (a.email = ${address}
            or exists (select 1 from authd.aliases al
                        where al.clerk_user_id = a.clerk_user_id and al.address = ${address}))`
  return (rows[0]?.clerk_user_id as string | undefined) ?? null
}

/** Sorted here: the database's collation ignores punctuation, so its order is not stable across hosts. */
const aliasRows = async (id: string) =>
  (await owner`select address, source from authd.aliases where clerk_user_id = ${id}`)
    .map((r) => `${r.address}:${r.source}`)
    .sort()

const eventTypes = async () =>
  (
    await owner`select type from identity.events where tenant_id = ${acme} order by id`
  ).map((r) => r.type as string)

async function reset() {
  await owner`delete from core.mailbox_deletions where tenant_id = ${acme}`
  await owner`delete from identity.directory_mailboxes where tenant_id = ${acme}`
  await owner`delete from authd.groups where tenant_id = ${acme} or name like ${`%${sfx}`}`
  await owner`delete from authd.accounts where clerk_user_id = any(${people})`
  for (const id of people)
    await owner`insert into authd.accounts (clerk_user_id, email, active, tenant_id)
                values (${id}, ${at(id.replace(/^user_/, "").replace(sfx, ""))}, true, ${acme})`
  await owner`delete from identity.events where tenant_id = ${acme}`
  clock = T0
}

suite("a mailbox's aliases, against Postgres", () => {
  const service = () =>
    mailboxAliases({ db, isAdmin: async (_t, user) => user === admin })
  const add = (alias: string, mailbox = at("ada")) =>
    service().add({ tenantId: acme, address: mailbox, alias, actorId: admin })
  const remove = (alias: string, mailbox = at("ada")) =>
    service().remove({ tenantId: acme, address: mailbox, alias, actorId: admin })

  const life = () =>
    mailboxAdminLifecycle({
      store: mailboxLifecycleStore(db),
      mail: directoryMailStore(db),
      resume: {} as never,
      isAdmin: async (_t, user) => user === admin,
      startExport: null,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => clock,
    })

  const purgeDeps = (): PurgeDeps => ({
    store: mailboxLifecycleStore(db),
    accounts: {
      destroy: async () => false,
    },
    clerk: { remove: async () => ({ kept: [] }) },
    exports: { latest: async () => null },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => clock,
  })

  const addDomain = (
    tenant: string,
    name: string,
    over: Record<string, unknown> = {},
  ) =>
    owner`insert into core.domains ${owner({
      tenant_id: tenant,
      name,
      hosts_mailboxes: true,
      status: "not_started",
      verified_at: new Date("2026-11-01T10:00:00Z"),
      ...over,
    })}`

  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    sqlApi = postgres(API_URL!, { max: 6, onnotice: () => {} })
    db = drizzle({ client: sqlApi }) as unknown as Database
    for (const [id, label] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const)
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                  values (${id}, ${`al-${id.slice(0, 8)}`}, ${label}, ${`owner-${id}`}, ${`org_${id.slice(0, 8)}`})`
    await addDomain(acme, main)
    await addDomain(acme, second)
    // Not hosting: owned and verified, but switched off.
    await addDomain(acme, unhosted, { hosts_mailboxes: false })
    await addDomain(rival, theirs)
  })

  beforeEach(reset)

  afterAll(async () => {
    await owner`delete from core.mailbox_deletions where tenant_id in (${acme}, ${rival})`
    await owner`delete from authd.groups where tenant_id = ${acme} or name like ${`%${sfx}`}`
    await owner`delete from authd.accounts where clerk_user_id = any(${people})`
    await owner`delete from core.domains where tenant_id in (${acme}, ${rival})`
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await sqlApi.end()
  })

  // ── Adding ────────────────────────────────────────────────────────────────

  it("an alias on the mailbox's own domain and on a second hosted one both deliver to it", async () => {
    expect((await add(at("sales"))).status).toBe("added")
    const done = await add(at("sales", second))
    expect(done.status).toBe("added")

    expect(await delivers(at("sales"))).toBe(ada)
    expect(await delivers(at("sales", second))).toBe(ada)
    expect(await aliasRows(ada)).toEqual(
      [`${at("sales")}:console`, `${at("sales", second)}:console`].sort(),
    )
    expect(await eventTypes()).toEqual(["mailbox.alias_added", "mailbox.alias_added"])
    const [event] =
      await owner`select actor_user_id, subject_user_id, data from identity.events
                                 where tenant_id = ${acme} order by id limit 1`
    expect(event).toMatchObject({ actor_user_id: admin, subject_user_id: ada })
    expect(event!.data).toEqual({ mailbox: at("ada"), alias: at("sales") })
  })

  it("is case-insensitive: the alias is stored in the one lowercase form", async () => {
    expect((await add("  Sales@ACME2-" + sfx + ".test ")).status).toBe("added")
    expect(await aliasRows(ada)).toEqual([`${at("sales", second)}:console`])
    expect((await add(at("sales", second))).status).toBe("taken")
  })

  it("accepts a role address: only an admin reaches this", async () => {
    expect((await add(at("postmaster"))).status).toBe("added")
    expect((await add(at("abuse", second))).status).toBe("added")
  })

  it("refuses another workspace's domain, one that is switched off and one nobody hosts, alike", async () => {
    for (const domain of [theirs, unhosted, `nobody-${sfx}.test`])
      expect((await add(at("sales", domain))).status).toBe("domain_not_hosted")
    expect(await aliasRows(ada)).toEqual([])
  })

  it("refuses an address that is any mailbox, any alias, or any list", async () => {
    await owner`insert into authd.aliases (address, clerk_user_id, source)
                values (${at("bobs")}, ${bob}, 'clerk')`
    await owner`insert into authd.groups (name, email, tenant_id)
                values (${`support-${sfx}`}, ${at("support")}, ${acme})`
    await owner`insert into authd.groups (name, email, description)
                values (${`fwd-gone-${sfx}`}, ${at("gone")}, 'fwd')`

    expect((await add(at("bob"))).status).toBe("taken") // a mailbox
    expect((await add(at("ada"))).status).toBe("taken") // its own address
    expect((await add(at("bobs"))).status).toBe("taken") // somebody's alias
    expect((await add(at("support"))).status).toBe("taken") // a team inbox
    expect((await add(at("gone"))).status).toBe("taken") // a forward's list
    expect(await aliasRows(ada)).toEqual([])
  })

  it("the same address cannot be given to two mailboxes, even at the same moment", async () => {
    const results = await Promise.all([
      add(at("shared"), at("ada")),
      add(at("shared"), at("bob")),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(["added", "taken"])
  })

  it("stops at the cap, counting only the console's own, and a removal frees a slot", async () => {
    // A directory's and a Clerk's do not use up the admin's slots.
    await owner`insert into authd.aliases (address, clerk_user_id, source)
                values (${at("fromdir")}, ${ada}, 'directory'), (${at("fromclerk")}, ${ada}, 'clerk')`
    for (let i = 0; i < MAILBOX_ALIAS_LIMIT; i++)
      expect((await add(at(`a${i}`))).status).toBe("added")

    expect((await add(at("one-too-many"))).status).toBe("limit")
    expect((await remove(at("a0"))).status).toBe("removed")
    expect((await add(at("one-too-many"))).status).toBe("added")
  })

  it("two adds at the last slot cannot both win", async () => {
    for (let i = 0; i < MAILBOX_ALIAS_LIMIT - 1; i++) await add(at(`a${i}`))
    const results = await Promise.all([add(at("x1")), add(at("x2"))])
    expect(results.map((r) => r.status).sort()).toEqual(["added", "limit"])
  })

  it("answers not_found for a mailbox of another workspace or an address that is none", async () => {
    await owner`insert into authd.accounts (clerk_user_id, email, active, tenant_id)
                values (${`user_zed${sfx}`}, ${at("zed", theirs)}, true, ${rival})`
    try {
      expect((await add(at("sales"), at("zed", theirs))).status).toBe("not_found")
      expect((await add(at("sales"), at("nobody"))).status).toBe("not_found")
    } finally {
      await owner`delete from authd.accounts where clerk_user_id = ${`user_zed${sfx}`}`
    }
  })

  // ── Removing ──────────────────────────────────────────────────────────────

  it("removing stops delivery at once, and the address can then be taken by somebody else", async () => {
    await add(at("sales"))
    expect(await delivers(at("sales"))).toBe(ada)

    expect((await remove(at("SALES"))).status).toBe("removed")
    expect(await delivers(at("sales"))).toBeNull()
    expect(await eventTypes()).toEqual(["mailbox.alias_added", "mailbox.alias_removed"])

    expect((await add(at("sales"), at("bob"))).status).toBe("added")
    expect(await delivers(at("sales"))).toBe(bob)
  })

  it("will not remove somebody else's alias, nor Clerk's or a directory's", async () => {
    await owner`insert into authd.aliases (address, clerk_user_id, source) values
                  (${at("bobs")}, ${bob}, 'console'),
                  (${at("fromdir")}, ${ada}, 'directory'),
                  (${at("fromclerk")}, ${ada}, 'clerk')`
    expect((await remove(at("bobs"))).status).toBe("not_found")
    expect((await remove(at("fromdir"))).status).toBe("not_removable")
    expect((await remove(at("fromclerk"))).status).toBe("not_removable")
    expect((await remove(at("never"))).status).toBe("not_found")
    expect(await delivers(at("bobs"))).toBe(bob)
    expect(await aliasRows(ada)).toEqual([
      `${at("fromclerk")}:clerk`,
      `${at("fromdir")}:directory`,
    ])
  })

  // ── Listing ───────────────────────────────────────────────────────────────

  it("an admin lists any mailbox's aliases; a member only their own", async () => {
    await add(at("sales"))
    const list = (userId: string, isAdmin: boolean, mailbox = at("ada")) =>
      service().list({ tenantId: acme, userId, isAdmin }, mailbox)

    expect(await list(admin, true)).toEqual({
      status: "ok",
      aliases: [{ address: at("sales"), source: "console" }],
    })
    expect((await list(ada, false)).status).toBe("ok")
    expect((await list(bob, false)).status).toBe("not_found")
  })

  it("the console's mailbox detail shows a console alias with its source", async () => {
    await add(at("sales"))
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
    const one = await console.get(
      { tenantId: acme, userId: admin, isAdmin: true },
      at("ada"),
    )
    expect(one?.aliases).toEqual([{ address: at("sales"), source: "console" }])
  })

  // ── Sources that are not ours ─────────────────────────────────────────────

  it("a Clerk event for the person leaves the console's aliases alone, and so does an empty one", async () => {
    await add(at("sales"))
    await owner`insert into authd.aliases (address, clerk_user_id, source)
                values (${at("dir")}, ${ada}, 'directory')`

    const user = (emails: string[]) => ({
      id: ada,
      primary_email_address_id: "e0",
      updated_at: Date.now(),
      email_addresses: emails.map((e, i) => ({
        id: `e${i}`,
        email_address: e,
        verification: { status: "verified" },
      })),
    })
    await projectClerkUser(db, user([at("ada")]), [])
    await projectClerkUser(db, user([at("ada"), at("clerkalias")]), [])
    await projectClerkUser(db, user([at("ada")]), [])

    expect(await aliasRows(ada)).toEqual([
      `${at("dir")}:directory`,
      `${at("sales")}:console`,
    ])
  })

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  it("a suspended mailbox keeps its aliases and keeps delivering to them", async () => {
    await add(at("sales"))
    await owner`update authd.accounts set suspended_at = now() where clerk_user_id = ${ada}`
    expect(await delivers(at("sales"))).toBe(ada)
    expect((await add(at("more"))).status).toBe("added")
    expect((await remove(at("more"))).status).toBe("removed")
  })

  it("a deleting mailbox keeps and delivers its aliases, refuses new ones, and lets one go", async () => {
    await add(at("sales"))
    await add(at("old"))
    await life().remove({
      tenantId: acme,
      address: at("ada"),
      actorId: admin,
      request: { outcome: "delete" },
    })

    expect(await delivers(at("sales"))).toBe(ada)
    expect((await add(at("new"))).status).toBe("deleting")
    // Held by the old mailbox, so nobody else may have it.
    expect((await add(at("sales"), at("bob"))).status).toBe("taken")
    expect((await remove(at("old"))).status).toBe("removed")
    expect(await delivers(at("old"))).toBeNull()

    // Restoring gives the mailbox back with what is left.
    expect(
      await life().restore({ tenantId: acme, address: at("ada"), actorId: admin }),
    ).toBe("restored")
    expect(await aliasRows(ada)).toEqual([`${at("sales")}:console`])
    expect((await add(at("new"))).status).toBe("added")
  })

  it("the purge stops delivery before the aliases are released, then releases them all", async () => {
    await add(at("sales"))
    await add(at("sales", second))
    await life().remove({
      tenantId: acme,
      address: at("ada"),
      actorId: admin,
      request: { outcome: "delete" },
    })
    clock = new Date(T0.getTime() + 31 * DAY)

    const seen: { deliveredAtDestroy?: string | null; heldAtDestroy?: boolean } = {}
    const deps = purgeDeps()
    deps.accounts = {
      destroy: async () => {
        // ⚠ BY THE FIRST DESTROY THE ADDRESS IS ALREADY CLOSED, YET STILL HELD:
        // nothing receives at the alias, and nobody else can claim it.
        seen.deliveredAtDestroy = await delivers(at("sales"))
        seen.heldAtDestroy = await mailboxDirectory(db).addressTaken(at("sales"))
        return false
      },
    }
    expect(await purgeMailbox(deps, { tenantId: acme, clerkUserId: ada })).toBe(
      "purged",
    )

    expect(seen).toEqual({ deliveredAtDestroy: null, heldAtDestroy: true })
    expect(await aliasRows(ada)).toEqual([])
    expect(await mailboxDirectory(db).addressTaken(at("sales"))).toBe(false)
    // Free to anybody now, with nothing of the old mail left to inherit.
    expect((await add(at("sales"), at("bob"))).status).toBe("added")
  })

  it("a forward keeps the address's mail going to the target but releases the aliases", async () => {
    await add(at("sales"))
    await life().remove({
      tenantId: acme,
      address: at("ada"),
      actorId: admin,
      request: { outcome: "forward", forward_to: at("bob") },
    })
    clock = new Date(T0.getTime() + 31 * DAY)
    expect(await purgeMailbox(purgeDeps(), { tenantId: acme, clerkUserId: ada })).toBe(
      "purged",
    )

    // The mailbox's own address still forwards, through its list...
    const [route] =
      await owner`select email from authd.groups where name = ${`fwd-${ada}`}`
    expect(route?.email).toBe(at("ada"))
    // ...and the alias is gone: it delivers nowhere and is free to take.
    expect(await delivers(at("sales"))).toBeNull()
    expect(await aliasRows(ada)).toEqual([])
    expect(await mailboxDirectory(db).addressTaken(at("sales"))).toBe(false)
  })
})
