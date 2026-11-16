import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import { mailboxCreationStore } from "../src/mailboxes/creation-mode.js"
import { hostedDomainsOf } from "../src/mailboxes/store.js"

/**
 * The "who creates mailboxes" setting and the hosted-domain count that `on_join`
 * relies on, against Postgres as `i10_api`.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@127.0.0.1:55450/i10 bun test test/mailbox-creation-db.test.ts
 */
const URL =
  process.env.TEMPLATES_TEST_DATABASE_URL ?? process.env.STORAGE_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let sqlApi: ReturnType<typeof postgres>
let db: Database

const acme = crypto.randomUUID()
const rival = crypto.randomUUID()
const sfx = acme.slice(0, 8)
const actor = `user_actor_${sfx}`

suite("mailbox creation mode and hosted domains against Postgres as i10_api", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    sqlApi = postgres(API_URL!, { max: 4, onnotice: () => {}, prepare: false })
    db = drizzle({ client: sqlApi }) as unknown as Database

    for (const [id, name] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const) {
      await owner`
        insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
        values (${id}, ${`b6-${id.slice(0, 8)}`}, ${name}, ${actor}, ${`org_${id.slice(0, 8)}`})
      `
    }
    const provedAt = new Date("2026-11-01T00:00:00Z")
    for (const [tenant, name, hosts] of [
      [acme, `acme-${sfx}.test`, true],
      [acme, `off-${sfx}.test`, false],
      [rival, `rival-${sfx}.test`, true],
    ] as const) {
      await owner`
        insert into core.domains (tenant_id, name, status, hosts_mailboxes, verified_at, identity_registered_at)
        values (${tenant}, ${name}, 'verified', ${hosts}, ${provedAt}, ${provedAt})
      `
    }
  })

  afterAll(async () => {
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await sqlApi.end()
  })

  it("reads admins for a workspace that never set anything, without making a row", async () => {
    const store = mailboxCreationStore(db)

    expect(await store.get(acme)).toBe("admins")
    const rows =
      await owner`select 1 from identity.workspace_settings where tenant_id = ${acme}`
    expect(rows).toHaveLength(0)
  })

  it("saves a mode, reads it back, and audits the change with who made it", async () => {
    const store = mailboxCreationStore(db)

    expect(await store.set(acme, actor, "on_join")).toEqual({
      before: "admins",
      after: "on_join",
    })
    expect(await store.get(acme)).toBe("on_join")
    expect(await store.set(acme, actor, "members")).toEqual({
      before: "on_join",
      after: "members",
    })

    const audit = await owner`
      select actor_user_id, data from identity.events
       where tenant_id = ${acme} and type = 'mailbox_creation.updated'
       order by id`
    expect(audit.map((r) => r.data)).toEqual([
      { before: "admins", after: "on_join" },
      { before: "on_join", after: "members" },
    ])
    expect(audit.every((r) => r.actor_user_id === actor)).toBe(true)
  })

  it("keeps the other settings on the row when it makes one", async () => {
    const store = mailboxCreationStore(db)
    await store.set(rival, actor, "members")

    const [row] = await owner`
      select deprovision, leaver_action, require_second_factor, mailbox_creation
        from identity.workspace_settings where tenant_id = ${rival}`
    expect(row).toEqual({
      deprovision: "membership",
      leaver_action: "keep",
      require_second_factor: false,
      mailbox_creation: "members",
    })
  })

  it("never shows one workspace another's mode", async () => {
    const store = mailboxCreationStore(db)
    await store.set(acme, actor, "on_join")
    await store.set(rival, actor, "admins")

    expect(await store.get(acme)).toBe("on_join")
    expect(await store.get(rival)).toBe("admins")
  })

  it("refuses a value the constraint does not know", async () => {
    const outcome = await owner`
      update identity.workspace_settings set mailbox_creation = 'everyone'
       where tenant_id = ${acme}`.then(
      () => "accepted",
      (err: { code?: string }) => err.code,
    )
    expect(outcome).toBe("23514")
  })

  it("lists only the verified, hosting domains of the workspace", async () => {
    const domains = hostedDomainsOf(db)

    expect(await domains(acme)).toEqual([`acme-${sfx}.test`])
    expect(await domains(rival)).toEqual([`rival-${sfx}.test`])
    expect(await domains(crypto.randomUUID())).toEqual([])
  })
})
