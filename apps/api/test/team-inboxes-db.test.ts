import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { AddressTakenError } from "../src/team-inboxes/service.js"
import { sentCopyStore, teamInboxStore } from "../src/team-inboxes/store.js"

/**
 * The team inbox rows against a real `authd` schema: the tenant boundary on every
 * query, the cascade on delete, and the copy ledger.
 *
 *   TEAM_INBOX_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/i10_scratch bun test test/team-inboxes-db.test.ts
 *
 * Needs only the `authd` tables (migrations 0000 and 0133). It writes under a
 * per-run prefix and removes what it wrote.
 */
const URL = process.env.TEAM_INBOX_TEST_DATABASE_URL
const suite = URL ? describe : describe.skip
const RUN = crypto.randomUUID().slice(0, 8)

const A = crypto.randomUUID()
const B = crypto.randomUUID()
const user = (n: string) => `user_${RUN}_${n}`
const mail = (n: string) => `${n}-${RUN}@acme.test`
const support = `support-${RUN}@acme.test`

let owner: ReturnType<typeof postgres>
let store: ReturnType<typeof teamInboxStore>
let copies: ReturnType<typeof sentCopyStore>

suite("team inboxes in Postgres", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    const db = drizzle(owner, { schema }) as unknown as Database
    store = teamInboxStore(db)
    copies = sentCopyStore(db)

    for (const n of ["bob", "carol", "dave"]) {
      await owner`insert into authd.accounts (clerk_user_id, email, active)
                  values (${user(n)}, ${mail(n)}, ${n !== "dave"})`
    }
    await owner`insert into authd.aliases (address, clerk_user_id)
                values (${`alias-${RUN}@acme.test`}, ${user("bob")})`
  })

  afterAll(async () => {
    if (owner) {
      await owner`delete from authd.groups where name like ${`%-${RUN}@%`}`
      await owner`delete from authd.accounts where clerk_user_id like ${`user_${RUN}_%`}`
      await owner.end()
    }
  })

  it("creates an inbox with its members and finds it for the owning workspace only", async () => {
    const row = await store.create({
      tenantId: A,
      name: support,
      address: support,
      displayName: "Support",
      memberUserIds: [user("bob"), user("carol")],
    })

    expect(row.members.map((m) => m.address)).toEqual([mail("bob"), mail("carol")])
    expect((await store.find(A, support))?.displayName).toBe("Support")
    expect(await store.find(B, support)).toBeNull()
    expect((await store.forTenant(A)).map((r) => r.address)).toContain(support)
    expect((await store.forTenant(B)).map((r) => r.address)).not.toContain(support)
  })

  it("lists a member's inboxes within the workspace", async () => {
    expect((await store.forMember(A, user("bob"))).map((r) => r.address)).toEqual([
      support,
    ])
    expect(await store.forMember(A, user("dave"))).toEqual([])
    expect(await store.forMember(B, user("bob"))).toEqual([])
  })

  it("sees an address as taken whether it is an inbox, a mailbox or an alias", async () => {
    expect(await store.addressTaken(support)).toBe(true)
    expect(await store.addressTaken(support.toUpperCase())).toBe(false)
    expect(await store.addressTaken(mail("bob"))).toBe(true)
    expect(await store.addressTaken(`alias-${RUN}@acme.test`)).toBe(true)
    expect(await store.addressTaken(`free-${RUN}@acme.test`)).toBe(false)
  })

  it("refuses a second inbox on the same address", async () => {
    const error = await store
      .create({
        tenantId: B,
        name: support,
        address: support,
        displayName: null,
        memberUserIds: [user("bob")],
      })
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(error).toBeInstanceOf(AddressTakenError)
  })

  it("reads mailboxes by primary address, with whether they are active", async () => {
    const found = await store.mailboxes([
      mail("bob"),
      mail("dave"),
      `alias-${RUN}@acme.test`,
    ])
    expect(found.map((m) => [m.address, m.active]).sort()).toEqual([
      [mail("bob"), true],
      [mail("dave"), false],
    ])
  })

  it("replaces the members, and not in another workspace's inbox", async () => {
    expect(await store.setMembers(B, support, [user("dave")])).toBeNull()

    const row = await store.setMembers(A, support, [user("carol"), user("dave")])
    expect(row?.members.map((m) => m.address)).toEqual([mail("carol"), mail("dave")])
    expect(await store.forMember(A, user("bob"))).toEqual([])
  })

  it("drops one person from the workspace's inboxes and names those it changed", async () => {
    expect(await store.dropMember(B, user("carol"))).toEqual([])
    expect(await store.dropMember(A, user("carol"))).toEqual([support])
    expect(await store.dropMember(A, user("carol"))).toEqual([])
    expect((await store.find(A, support))?.members.map((m) => m.address)).toEqual([
      mail("dave"),
    ])
  })

  it("serves the copy pass the team and only its active members", async () => {
    await store.setMembers(A, support, [user("bob"), user("dave")])
    const team = (await copies.teams()).find((t) => t.name === support)
    // dave's mailbox is suspended, so his Sent is not read.
    expect(team?.members).toEqual([{ address: mail("bob") }])
  })

  it("records copied messages once and reports which it has seen", async () => {
    await copies.record(support, ["m1@x", "m2@x"])
    await copies.record(support, ["m2@x", "m3@x"])
    await copies.record(support, [])

    expect(await copies.copied(support, ["m1@x", "m3@x", "m4@x"])).toEqual(
      new Set(["m1@x", "m3@x"]),
    )
    expect(await copies.copied(support, [])).toEqual(new Set())
  })

  it("removes the inbox for its workspace only, with its members and ledger", async () => {
    expect(await store.remove(B, support)).toBe(false)
    expect(await store.remove(A, support)).toBe(true)

    const [members] =
      await owner`select count(*)::int as n from authd.group_members where group_name = ${support}`
    const [ledger] =
      await owner`select count(*)::int as n from authd.group_sent_copies where group_name = ${support}`
    expect(members!.n).toBe(0)
    expect(ledger!.n).toBe(0)
    expect(await store.find(A, support)).toBeNull()
  })
})
