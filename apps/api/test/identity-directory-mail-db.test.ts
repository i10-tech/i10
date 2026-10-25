import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { directoryMailStore } from "../src/identity/mail-store.js"
import { directoryStore } from "../src/identity/scim-store.js"
import { KEEP } from "../src/identity/directory-mail.js"
import { projectClerkUser } from "../src/projection/writer.js"

/**
 * Mail from the directory (#344 slice B) against a real database as `i10_api`:
 * the authd rows, the lifecycle row and the audit event move together, the
 * projection leaves a directory's aliases alone, seats count a person once.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/templates_scratch_3442 bun test test/identity-directory-mail-db.test.ts
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
const ada = `user_ada${sfx}`
const grace = `user_grace${sfx}`
const bob = `user_bob${sfx}`
const dirA = crypto.randomUUID()
const dirB = crypto.randomUUID()
const dirOff = crypto.randomUUID()
const domain = `acme-${sfx}.test`
const at = new Date("2026-10-21T10:00:00Z")

suite("directory mail", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    sqlApi = postgres(API_URL!, { max: 4, onnotice: () => {} })
    db = drizzle(sqlApi, { schema }) as unknown as Database
    for (const [id, name] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const)
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                  values (${id}, ${`m-${id.slice(0, 8)}`}, ${name}, ${`owner-${id}`}, ${`org_${id.slice(0, 8)}`})`
    for (const [id, enabled] of [
      [dirA, true],
      [dirB, true],
      [dirOff, false],
    ] as const)
      await owner`insert into identity.directories (id, tenant_id, name, enabled) values (${id}, ${acme}, ${"d"}, ${enabled})`
    for (const [id, email] of [
      [ada, `ada@${domain}`],
      [grace, `grace@${domain}`],
      [bob, `bob@${domain}`],
    ] as const)
      await owner`insert into authd.accounts (clerk_user_id, email, active, tenant_id)
                  values (${id}, ${email}, true, ${acme})`
  })
  afterAll(async () => {
    await owner`delete from authd.accounts where clerk_user_id in (${ada}, ${grace}, ${bob})`
    await owner`delete from authd.groups where name like ${`%${sfx}`}`
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await sqlApi.end()
  })

  const mail = () => directoryMailStore(db)
  const acct = async (id: string) =>
    (
      await owner`select active, suspended_at from authd.accounts where clerk_user_id = ${id}`
    )[0]!
  const types = async () =>
    (
      await owner`select type from identity.events where tenant_id = ${acme} order by id`
    ).map((r) => r.type as string)

  it("suspension keeps the account ACTIVE (delivery) and sets suspended_at (login), with row and audit together", async () => {
    expect(await mail().suspend(rival, ada, KEEP, at, { type: "x" })).toBe("no_mailbox")
    expect((await acct(ada)).suspended_at).toBeNull()
    expect(
      await mail().suspend(acme, ada, KEEP, at, { type: "mailbox.suspended" }),
    ).toBe("suspended")
    expect(await acct(ada)).toMatchObject({ active: true })
    expect((await acct(ada)).suspended_at).not.toBeNull()
    expect((await mail().mailbox(acme, ada))?.state).toBe("suspended")
    expect(await types()).toContain("mailbox.suspended")
    expect(await mail().suspend(acme, ada, KEEP, at, { type: "again" })).toBe("already")
    expect(await types()).not.toContain("again")
  })

  it("another workspace cannot see, resume or delete it", async () => {
    expect(await mail().mailbox(rival, ada)).toBeNull()
    expect(await mail().resume(rival, ada, { type: "x" })).toBe("none")
    expect((await acct(ada)).suspended_at).not.toBeNull()
  })

  it("resume restores it unchanged", async () => {
    expect(await mail().resume(acme, ada, { type: "mailbox.resumed" })).toBe("resumed")
    expect((await acct(ada)).suspended_at).toBeNull()
    expect((await mail().mailbox(acme, ada))?.next).toBe("keep")
  })

  it("deletion: refused before the date, the row check refuses a bad plan, done on the date", async () => {
    const plan = {
      next: "delete" as const,
      targetUserId: null,
      targetAddress: null,
      days: 7,
      deleteAt: new Date(at.getTime() + 7 * 86400_000),
    }
    await mail().suspend(acme, ada, plan, at, { type: "mailbox.suspended" })
    expect(
      await mail().remove(acme, ada, new Date(at.getTime() + 86400_000), { type: "d" }),
    ).toBe("not_due")
    expect((await acct(ada)).active).toBe(true)
    // The database refuses a delete date under 7 days or a half-set plan.
    const refused = async (run: () => PromiseLike<unknown>) => {
      try {
        await run()
        return false
      } catch {
        return true
      }
    }
    expect(
      await refused(
        () =>
          owner`update identity.directory_mailboxes set delete_after_days = 3 where clerk_user_id = ${ada}`,
      ),
    ).toBe(true)
    expect(
      await refused(
        () =>
          owner`update identity.directory_mailboxes set delete_at = null where clerk_user_id = ${ada}`,
      ),
    ).toBe(true)
    expect(await mail().due(acme, plan.deleteAt)).toHaveLength(1)
    expect(
      await mail().remove(acme, ada, plan.deleteAt, { type: "mailbox.deleted" }),
    ).toBe("deleted")
    expect(
      await owner`select 1 from authd.accounts where clerk_user_id = ${ada}`,
    ).toHaveLength(0)
    expect(await mail().mailbox(acme, ada)).toBeNull()
  })

  it("forward writes a route list and resume removes it", async () => {
    const plan = {
      next: "forward_manager" as const,
      targetUserId: grace,
      targetAddress: `grace@${domain}`,
      days: null,
      deleteAt: null,
    }
    await mail().suspend(acme, bob, plan, at, { type: "mailbox.suspended" })
    const g = await owner`select email from authd.groups where name = ${`fwd-${bob}`}`
    expect(g[0]?.email).toBe(`bob@${domain}`)
    const members =
      await owner`select clerk_user_id from authd.group_members where group_name = ${`fwd-${bob}`}`
    expect(members.map((r) => r.clerk_user_id as string)).toEqual([grace])
    await mail().resume(acme, bob, { type: "mailbox.resumed" })
    expect(
      await owner`select 1 from authd.groups where name = ${`fwd-${bob}`}`,
    ).toHaveLength(0)
  })

  it("aliases: taken ones are left out; the projection replaces only Clerk's own", async () => {
    const r = await mail().setAliases(
      acme,
      grace,
      [`g1@${domain}`, `bob@${domain}`],
      () => ({ type: "mailbox.aliases_changed" }),
    )
    expect(r.taken).toEqual([`bob@${domain}`])
    const user = {
      id: grace,
      primary_email_address_id: "i1",
      email_addresses: [
        {
          id: "i1",
          email_address: `grace@${domain}`,
          verification: { status: "verified" },
        },
        {
          id: "i2",
          email_address: `gc@${domain}`,
          verification: { status: "verified" },
        },
      ],
      updated_at: Date.now(),
    }
    await projectClerkUser(db, user, [domain])
    await projectClerkUser(
      db,
      {
        ...user,
        email_addresses: [user.email_addresses[0]!],
        updated_at: Date.now() + 5,
      },
      [domain],
    )
    const rows =
      await owner`select address, source from authd.aliases where clerk_user_id = ${grace} order by address`
    expect(rows.map((r) => ({ address: r.address, source: r.source }))).toEqual([
      { address: `g1@${domain}`, source: "directory" },
    ])
  })

  it("seats count a person once across directories, skip disabled ones and the deleted", async () => {
    const row = (dir: string, name: string, over: Record<string, unknown> = {}) =>
      owner`insert into identity.directory_users (tenant_id, directory_id, user_name, email, active, clerk_user_id, deleted_at)
            values (${acme}, ${dir}, ${name}, ${over.email as string}, ${(over.active as boolean) ?? true}, ${(over.clerk as string | null) ?? null}, ${(over.deleted as Date | null) ?? null})`
    await row(dirA, "ada", { email: `ada@${domain}`, clerk: grace })
    await row(dirB, "ada2", { email: `ada2@${domain}`, clerk: grace })
    await row(dirA, "new", { email: `New@${domain}` })
    await row(dirB, "new2", { email: `new@${domain}` })
    await row(dirOff, "off", { email: `off@${domain}` })
    await row(dirA, "gone", { email: `gone@${domain}`, deleted: new Date() })
    await row(dirA, "inactive", { email: `in@${domain}`, active: false })
    await owner`insert into core.workspace_roles (tenant_id, clerk_user_id, role, source) values (${acme}, ${grace}, 'member', 'test')`
    expect(await directoryStore(db).seats(acme)).toEqual({ people: 2, outside: 1 })
  })

  it("a group opted in becomes a list that goes with its group, and refuses an address that is a mailbox", async () => {
    const [g] =
      await owner`insert into identity.directory_groups (tenant_id, directory_id, display_name)
                            values (${acme}, ${dirA}, ${"Eng"}) returning id`
    const id = g!.id as string
    expect(
      await mail().setGroupMail(
        acme,
        dirA,
        id,
        { address: `bob@${domain}`, kind: "list" },
        { type: "x" },
      ),
    ).toBe("taken")
    expect(
      await mail().setGroupMail(
        acme,
        dirA,
        id,
        { address: `eng${sfx}@${domain}`, kind: "list" },
        { type: "directory.group_mail_enabled" },
      ),
    ).toBe("ok")
    const list =
      await owner`select name, email from authd.groups where directory_group_id = ${id}`
    expect(list).toHaveLength(1)
    await owner`delete from identity.directory_groups where id = ${id}`
    expect(
      await owner`select 1 from authd.groups where directory_group_id = ${id}`,
    ).toHaveLength(0)
  })

  it("the manager is resolved inside the leaver's own directory, and an ambiguous string is nobody", async () => {
    const urn = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"
    const [boss] =
      await owner`insert into identity.directory_users (tenant_id, directory_id, user_name, external_id, active, clerk_user_id)
      values (${acme}, ${dirA}, ${"boss"}, ${"ext-boss"}, true, ${`user_boss${sfx}`}) returning id`
    await owner`insert into identity.directory_users (tenant_id, directory_id, user_name, active, clerk_user_id, resource)
      values (${acme}, ${dirA}, ${"report"}, true, ${bob}, ${JSON.stringify({ [urn]: { manager: { value: boss!.id } } })}::jsonb)`
    expect(await mail().manager(acme, bob)).toMatchObject({
      status: "found",
      clerkUserId: `user_boss${sfx}`,
      active: true,
    })
    await owner`update identity.directory_users set resource = ${JSON.stringify({ [urn]: { manager: { value: "nobody" } } })}::jsonb where clerk_user_id = ${bob}`
    expect(await mail().manager(acme, bob)).toEqual({ status: "none" })
    expect(await mail().manager(rival, bob)).toEqual({ status: "none" })
  })

  it("lists seat only active members who have a mailbox, and drop them when they go", async () => {
    const [g] =
      await owner`insert into identity.directory_groups (tenant_id, directory_id, display_name)
      values (${acme}, ${dirA}, ${"Ops"}) returning id`
    const gid = g!.id as string
    const [u] =
      await owner`select id from identity.directory_users where clerk_user_id = ${bob} and directory_id = ${dirA}`
    await owner`insert into identity.directory_memberships (group_id, user_id, directory_id, tenant_id) values (${gid}, ${u!.id}, ${dirA}, ${acme})`
    await mail().setGroupMail(
      acme,
      dirA,
      gid,
      { address: `ops${sfx}@${domain}`, kind: "shared" },
      { type: "e" },
    )
    const seated = async () =>
      (
        await owner`select clerk_user_id from authd.group_members where group_name = ${`dg-${gid}`}`
      ).map((r) => r.clerk_user_id as string)
    expect(await seated()).toEqual([bob])
    await owner`update identity.directory_users set active = false where id = ${u!.id}`
    await mail().syncLists(acme, bob)
    expect(await seated()).toEqual([])
    await owner`update identity.directory_users set active = true where id = ${u!.id}`
    await mail().syncLists(acme, bob)
    expect(await seated()).toEqual([bob])
  })

  it("a list sync leaves the person's seats on another workspace's lists alone", async () => {
    const rivalDir = crypto.randomUUID()
    await owner`insert into identity.directories (id, tenant_id, name, enabled) values (${rivalDir}, ${rival}, ${"r"}, true)`
    const [g] =
      await owner`insert into identity.directory_groups (tenant_id, directory_id, display_name)
      values (${rival}, ${rivalDir}, ${"Rival"}) returning id`
    const name = `dg-${g!.id}`
    await owner`insert into authd.groups (name, email, directory_group_id) values (${name}, ${`r${sfx}@rival-${sfx}.test`}, ${g!.id})`
    await owner`insert into authd.group_members (group_name, clerk_user_id) values (${name}, ${bob})`
    await mail().syncLists(acme, bob)
    expect(
      await owner`select 1 from authd.group_members where group_name = ${name} and clerk_user_id = ${bob}`,
    ).toHaveLength(1)
  })
})
