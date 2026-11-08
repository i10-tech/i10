import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { KEEP } from "../src/identity/directory-mail.js"
import { directoryMailStore } from "../src/identity/mail-store.js"

/**
 * The store half of the owner's "resume mailbox" against a real database as
 * `i10_api`: it clears `suspended_at` and nothing else, reports what still refuses
 * the login, and re-checks the membership inside its own transaction under a lock.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:<pw>@localhost:<port>/i10 bun test test/mailbox-resume-db.test.ts
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
const domain = `acme-${sfx}.test`
const at = new Date("2026-11-08T10:00:00Z")

suite("resuming a mailbox, in the store", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    sqlApi = postgres(API_URL!, { max: 4, onnotice: () => {} })
    db = drizzle(sqlApi, { schema }) as unknown as Database
    for (const [id, name] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const)
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                  values (${id}, ${`r-${id.slice(0, 8)}`}, ${name}, ${`owner-${id}`}, ${`org_${id.slice(0, 8)}`})`
    await owner`insert into authd.accounts (clerk_user_id, email, active, tenant_id)
                values (${ada}, ${`ada@${domain}`}, true, ${acme})`
  })

  afterAll(async () => {
    await owner`delete from authd.accounts where clerk_user_id = ${ada}`
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await sqlApi.end()
  })

  const mail = () => directoryMailStore(db)
  const row = async () =>
    (
      await owner`select active, suspended_at, payment_hold_at, banned, locked, locked_until
                    from authd.accounts where clerk_user_id = ${ada}`
    )[0]!
  const types = async () =>
    (
      await owner`select type from identity.events where tenant_id = ${acme} order by id`
    ).map((r) => r.type as string)
  const member = async (yes: boolean) => {
    await owner`delete from core.workspace_roles where tenant_id = ${acme} and clerk_user_id = ${ada}`
    if (yes)
      await owner`insert into core.workspace_roles (tenant_id, clerk_user_id, role, source)
                  values (${acme}, ${ada}, 'member', 'membership')`
  }
  const suspend = async () => {
    await owner`update authd.accounts set suspended_at = null where clerk_user_id = ${ada}`
    await owner`delete from identity.directory_mailboxes where tenant_id = ${acme}`
    expect(
      await mail().suspend(acme, ada, KEEP, at, { type: "mailbox.suspended" }),
    ).toBe("suspended")
  }

  it("clears suspended_at and nothing else: a payment hold, a ban and a lock stay", async () => {
    await member(true)
    await owner`update authd.accounts set payment_hold_at = now(), banned = true, locked = true,
                       locked_until = null where clerk_user_id = ${ada}`
    await suspend()

    expect(
      await mail().resume(acme, ada, { type: "mailbox.resumed" }, { memberOnly: true }),
    ).toBe("resumed")
    const after = await row()
    expect(after.suspended_at).toBeNull()
    expect(after.payment_hold_at).not.toBeNull()
    expect(after.banned).toBe(true)
    expect(after.locked).toBe(true)
    expect((await mail().mailbox(acme, ada))?.state).toBe("active")
    expect(await types()).toContain("mailbox.resumed")
  })

  it("reports what still refuses the login, and a lockout that has run out is not one", async () => {
    await owner`update authd.accounts set payment_hold_at = null, banned = false, locked = false,
                       locked_until = null where clerk_user_id = ${ada}`
    expect((await mail().account(acme, ada))?.blocks).toEqual([])

    await owner`update authd.accounts set payment_hold_at = now(), banned = true, locked = true,
                       locked_until = now() + interval '1 hour' where clerk_user_id = ${ada}`
    expect((await mail().account(acme, ada))?.blocks).toEqual([
      "payment_hold",
      "banned",
      "locked",
    ])
    await owner`update authd.accounts set locked_until = now() - interval '1 second'
                 where clerk_user_id = ${ada}`
    expect((await mail().account(acme, ada))?.blocks).toEqual([
      "payment_hold",
      "banned",
    ])
  })

  // ⚠ THE MAILBOX WAS SUSPENDED BECAUSE THEY LEFT.
  it("is refused for a person the workspace has no role row for, and changes nothing", async () => {
    await owner`update authd.accounts set payment_hold_at = null, banned = false, locked = false
                 where clerk_user_id = ${ada}`
    await member(false)
    await suspend()
    const before = (await types()).filter((t) => t === "mailbox.resumed").length

    expect(
      await mail().resume(acme, ada, { type: "mailbox.resumed" }, { memberOnly: true }),
    ).toBe("not_member")
    expect((await row()).suspended_at).not.toBeNull()
    expect((await mail().mailbox(acme, ada))?.state).toBe("suspended")
    expect((await types()).filter((t) => t === "mailbox.resumed").length).toBe(before)

    // A directory's reactivation asks nothing of membership: it has its own step.
    expect(await mail().resume(acme, ada, { type: "mailbox.resumed" })).toBe("resumed")
  })

  it("another workspace cannot resume it", async () => {
    await member(true)
    await suspend()
    expect(
      await mail().resume(rival, ada, { type: "x" }, { memberOnly: true }),
    ).not.toBe("resumed")
    expect((await row()).suspended_at).not.toBeNull()
  })

  // ⚠ THE LOCK: a removal that is committing at this moment either lands first (the
  // resume is refused) or waits for the resume (its suspension then follows).
  it("waits for a removal that is committing, then refuses", async () => {
    await member(true)
    await suspend()

    let resumed: Promise<string> | undefined
    await owner.begin(async (tx) => {
      // Stands in for the removal: the role row is locked, about to be deleted.
      await tx`select 1 from core.workspace_roles
                where tenant_id = ${acme} and clerk_user_id = ${ada} for update`
      resumed = mail().resume(
        acme,
        ada,
        { type: "mailbox.resumed" },
        { memberOnly: true },
      )
      const state = await Promise.race([
        resumed.then(() => "settled"),
        new Promise((r) => setTimeout(() => r("waiting"), 400)),
      ])
      expect(state).toBe("waiting")
      await tx`delete from core.workspace_roles where tenant_id = ${acme} and clerk_user_id = ${ada}`
    })
    expect(await resumed).toBe("not_member")
    expect((await row()).suspended_at).not.toBeNull()
  })
})
