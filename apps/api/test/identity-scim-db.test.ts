import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { DIRECTORY_CONFLICTS } from "../src/identity/directory-ports.js"
import { hashSecret } from "../src/identity/model.js"
import { directoryStore } from "../src/identity/scim-store.js"
import { readGroup, readUser } from "../src/identity/scim.js"

/**
 * The SCIM tables against a real database as `i10_api` (#342): row-level
 * security, the one outsider policy on token hashes, the composite foreign keys
 * that keep a group's people in its own directory, the partial unique indexes,
 * and the store's transactions.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/templates_scratch_342 bun test test/identity-scim-db.test.ts
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let db: ReturnType<typeof postgres>
let database: Database
const acme = crypto.randomUUID()
const rival = crypto.randomUUID()
const suffix = acme.slice(0, 8)
const live = `acme-${suffix}.test`
let dirA = ""
let dirB = ""
let rivalDir = ""

const store = () => directoryStore(database)
const person = (name: string, over: Record<string, unknown> = {}) =>
  readUser({
    userName: `${name}@${live}`,
    active: true,
    name: { givenName: name, familyName: "Test" },
    emails: [{ value: `${name}@${live}`, primary: true }],
    ...over,
  })
const refusal = async (run: () => Promise<unknown>) => {
  try {
    await run()
    return "accepted"
  } catch (error) {
    return `${String(error)} ${String((error as { cause?: unknown }).cause ?? "")}`
  }
}
const event = { type: "scim.user.created" }

suite("SCIM directories", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    database = drizzle(db, { schema }) as unknown as Database
    for (const [id, name] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const)
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                  values (${id}, ${`d-${id.slice(0, 8)}`}, ${name}, ${`owner-${id}`}, ${`org_${id.slice(0, 8)}`})`
    await owner`insert into core.join_domains (tenant_id, name, clerk_org_id, source, verified_at)
                values (${acme}, ${live}, 'org_a', 'txt', now())`
    await owner`insert into core.join_domains (tenant_id, name, clerk_org_id, source, verified_at, lapsed_at)
                values (${acme}, ${`lapsed-${suffix}.test`}, 'org_a', 'txt', now(), now())`
    await owner`insert into core.join_domains (tenant_id, name, clerk_org_id, source, verified_at, displaced_at)
                values (${acme}, ${`displaced-${suffix}.test`}, 'org_a', 'txt', now(), now())`
    await owner`insert into core.join_domains (tenant_id, name, clerk_org_id, source)
                values (${acme}, ${`pending-${suffix}.test`}, 'org_a', 'txt')`
    dirA = (
      await store().createDirectory(acme, {
        name: "Okta",
        provider: "okta",
        createdBy: "u",
      })
    ).id
    dirB = (
      await store().createDirectory(acme, {
        name: "Entra",
        provider: "entra",
        createdBy: "u",
      })
    ).id
    rivalDir = (
      await store().createDirectory(rival, {
        name: "Theirs",
        provider: "generic",
        createdBy: "u",
      })
    ).id
  })
  afterAll(async () => {
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await db.end()
  })

  // ── Row-level security ──

  it("shows a workspace only its own directories, tokens, people and groups", async () => {
    await store().issueToken(
      acme,
      dirA,
      {
        tokenHash: hashSecret("a-token"),
        hint: "i10_scim_aaaa",
        createdBy: "u",
        overlapMs: 0,
      },
      new Date(),
    )
    const made = await store().createUser(acme, dirA, person("ada"), event)
    if (made === "taken") throw new Error("taken")
    await store().createGroup(
      acme,
      dirA,
      readGroup({ displayName: "Eng", members: [{ value: made.row.id }] }),
      { type: "scim.group.created" },
    )

    expect((await store().directories(rival)).map((d) => d.id)).toEqual([rivalDir])
    expect(await store().directory(rival, dirA)).toBeNull()
    expect(await store().user(rival, dirA, made.row.id)).toBeNull()
    expect(
      (
        await store().listUsers(rival, dirA, {
          filter: null,
          startIndex: 1,
          count: 100,
        })
      ).total,
    ).toBe(0)
    expect(
      (
        await store().listGroups(rival, dirA, {
          filter: null,
          startIndex: 1,
          count: 100,
        })
      ).total,
    ).toBe(0)
    expect(await store().pending(rival, dirA, new Date(Date.now() + 1000), 10)).toEqual(
      [],
    )
    expect(await store().forApply(rival, made.row.id)).toBeNull()
    expect(await store().conflicts(rival, dirA)).toEqual([])
    // And cannot write into it, with the right directory id and the wrong workspace.
    expect(
      await refusal(() => store().createUser(rival, dirA, person("eve"), event)),
    ).not.toBe("accepted")
    expect(
      await store().revokeToken(
        rival,
        dirA,
        "00000000-0000-4000-8000-000000000000",
        new Date(),
      ),
    ).toBe(false)
    expect(await store().updateDirectory(rival, dirA, { enabled: false })).toBeNull()
    expect((await store().directory(acme, dirA))?.enabled).toBe(true)
  })

  it("lets a token's own hash read exactly its row with no workspace in scope, and nothing else", async () => {
    const a = hashSecret("token-one")
    const b = hashSecret("token-two")
    await store().issueToken(
      acme,
      dirB,
      { tokenHash: a, hint: "i10_scim_one", createdBy: "u", overlapMs: 3_600_000 },
      new Date(),
    )
    await store().issueToken(
      rival,
      rivalDir,
      { tokenHash: b, hint: "i10_scim_two", createdBy: "u", overlapMs: 0 },
      new Date(),
    )
    expect(await store().tokenByHash(a)).toMatchObject({
      tenantId: acme,
      directoryId: dirB,
      tokenHash: a,
      revokedAt: null,
    })
    expect(await store().tokenByHash(b)).toMatchObject({
      tenantId: rival,
      directoryId: rivalDir,
    })
    expect(await store().tokenByHash(hashSecret("nobody"))).toBeNull()
    expect(await store().tokenByHash("not-a-hash")).toBeNull()
    expect(await store().tokenByHash(a.toUpperCase())).toBeNull()
    expect(await store().tokenByHash("")).toBeNull()

    // The policy itself: with a hash set and no workspace, a select sees one row.
    const seen = await database.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true)`,
      )
      await tx.execute(sql`select set_config('app.scim_token', ${a}, true)`)
      return tx.execute(sql`select token_hash from identity.directory_tokens`)
    })
    expect([...seen].map((r) => (r as { token_hash: string }).token_hash)).toEqual([a])
    // With no hash set, and no workspace, nothing is visible at all.
    const none = await database.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true)`,
      )
      return tx.execute(sql`select token_hash from identity.directory_tokens`)
    })
    expect([...none]).toEqual([])
    // The hash policy reads and nothing more: it cannot write a token or a user.
    const write = await refusal(() =>
      database.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true)`,
        )
        await tx.execute(sql`select set_config('app.scim_token', ${a}, true)`)
        await tx.execute(
          sql`update identity.directory_tokens set revoked_at = now() where token_hash = ${a}`,
        )
        return tx.execute(
          sql`select revoked_at from identity.directory_tokens where token_hash = ${a}`,
        )
      }),
    )
    expect(write).toBe("accepted")
    expect((await store().tokenByHash(a))?.revokedAt).toBeNull()
  })

  // ── Composite keys ──

  it("refuses, in the database, a row pointing at another workspace's or another directory's parent", async () => {
    const [u] =
      await owner`select id from identity.directory_users where directory_id = ${dirA} limit 1`
    const [g] =
      await owner`select id from identity.directory_groups where directory_id = ${dirA} limit 1`
    // A user whose directory belongs to another workspace.
    expect(
      await refusal(
        () =>
          owner`insert into identity.directory_users (tenant_id, directory_id, user_name) values (${rival}, ${dirA}, 'x')`,
      ),
    ).toMatch(/directory_users_directory_fk/)
    expect(
      await refusal(
        () =>
          owner`insert into identity.directory_groups (tenant_id, directory_id, display_name) values (${rival}, ${dirA}, 'x')`,
      ),
    ).toMatch(/directory_groups_directory_fk/)
    expect(
      await refusal(
        () =>
          owner`insert into identity.directory_tokens (tenant_id, directory_id, token_hash, hint) values (${rival}, ${dirA}, 'h', 'h')`,
      ),
    ).toMatch(/directory_tokens_directory_fk/)
    // A group holding a person of ANOTHER directory of the same workspace.
    const [other] =
      await owner`insert into identity.directory_users (tenant_id, directory_id, user_name)
                                values (${acme}, ${dirB}, ${`other-${suffix}`}) returning id`
    expect(
      await refusal(
        () => owner`insert into identity.directory_memberships (group_id, user_id, directory_id, tenant_id)
                    values (${g!.id}, ${other!.id}, ${dirA}, ${acme})`,
      ),
    ).toMatch(/directory_memberships_user_fk/)
    const [fresh] =
      await owner`insert into identity.directory_users (tenant_id, directory_id, user_name)
                                values (${acme}, ${dirA}, ${`fresh-${suffix}`}) returning id`
    expect(
      await refusal(
        () => owner`insert into identity.directory_memberships (group_id, user_id, directory_id, tenant_id)
                    values (${g!.id}, ${fresh!.id}, ${dirB}, ${acme})`,
      ),
    ).toMatch(/directory_memberships_(user|group)_fk/)
    // An outbox entry naming a person under the wrong directory or workspace.
    expect(
      await refusal(
        () => owner`insert into identity.directory_outbox (tenant_id, directory_id, directory_user_id, cause)
                    values (${acme}, ${dirB}, ${u!.id}, 'updated')`,
      ),
    ).toMatch(/directory_outbox_user_fk/)
    expect(
      await refusal(
        () => owner`insert into identity.directory_outbox (tenant_id, directory_id, directory_user_id, cause)
                    values (${rival}, ${dirA}, ${u!.id}, 'updated')`,
      ),
    ).toMatch(/directory_outbox_user_fk/)
  })

  it("accepts only the conflicts and causes it knows", async () => {
    const [u] =
      await owner`select id from identity.directory_users where directory_id = ${dirA} limit 1`
    for (const conflict of DIRECTORY_CONFLICTS)
      expect(
        await refusal(
          () =>
            owner`update identity.directory_users set conflict = ${conflict} where id = ${u!.id}`,
        ),
      ).toBe("accepted")
    expect(
      await refusal(
        () =>
          owner`update identity.directory_users set conflict = 'whatever' where id = ${u!.id}`,
      ),
    ).toMatch(/directory_users_conflict_check/)
    await owner`update identity.directory_users set conflict = null where id = ${u!.id}`
    expect(
      await refusal(
        () => owner`insert into identity.directory_outbox (tenant_id, directory_id, directory_user_id, cause)
                    values (${acme}, ${dirA}, ${u!.id}, 'explode')`,
      ),
    ).toMatch(/directory_outbox_cause_check/)
    expect(
      await refusal(
        () =>
          owner`update identity.directories set provider = 'ldap' where id = ${dirA}`,
      ),
    ).toMatch(/directories_provider_check/)
  })

  // ── Unique indexes ──

  it("keeps a userName unique per directory, case-insensitively, among live people only", async () => {
    expect(await store().createUser(acme, dirA, person("ADA"), event)).toBe("taken")
    // Another directory may hold the same name.
    expect(await store().createUser(acme, dirB, person("ada"), event)).not.toBe("taken")
    const made = await store().createUser(acme, dirA, person("grace"), event)
    if (made === "taken") throw new Error("taken")
    expect(await store().createUser(acme, dirA, person("Grace"), event)).toBe("taken")
    // Gone for SCIM at once, so the name is free again.
    expect(
      await store().deleteUser(acme, dirA, made.row.id, { type: "scim.user.deleted" }),
    ).not.toBeNull()
    const again = await store().createUser(acme, dirA, person("grace"), event)
    expect(again).not.toBe("taken")
    // A rename onto another live person's name is refused, and changes nothing.
    const [ada] = (
      await store().listUsers(acme, dirA, {
        filter: { terms: [{ attr: "userName", value: `ada@${live}` }] },
        startIndex: 1,
        count: 1,
      })
    ).rows
    const refused = await store().editUser(
      acme,
      dirA,
      ada!.id,
      () => person("GRACE"),
      () => ({ type: "x" }),
    )
    expect(refused).toBe("taken")
    expect((await store().user(acme, dirA, ada!.id))?.userName).toBe(`ada@${live}`)
  })

  it("keeps a group displayName unique per directory, case-insensitively", async () => {
    const made = await store().createGroup(
      acme,
      dirA,
      readGroup({ displayName: "uniq-a" }),
      event,
    )
    if (made.kind !== "written") throw new Error("duplicate")
    expect(
      (
        await store().createGroup(
          acme,
          dirA,
          readGroup({ displayName: "UNIQ-A" }),
          event,
        )
      ).kind,
    ).toBe("duplicate")
    // Another directory may hold the same name.
    expect(
      (
        await store().createGroup(
          acme,
          dirB,
          readGroup({ displayName: "uniq-a" }),
          event,
        )
      ).kind,
    ).toBe("written")
    // A rename onto another group's name is refused, and changes nothing.
    const second = await store().createGroup(
      acme,
      dirA,
      readGroup({ displayName: "uniq-b" }),
      event,
    )
    if (second.kind !== "written") throw new Error("duplicate")
    const renamed = await store().editGroup(
      acme,
      dirA,
      second.row.id,
      (cur) => ({
        displayName: "uniq-A",
        externalId: null,
        members: cur.members,
        resource: cur.row.resource,
      }),
      { type: "scim.group.updated" },
    )
    expect(renamed?.kind).toBe("duplicate")
    expect((await store().group(acme, dirA, second.row.id))?.displayName).toBe("uniq-b")
  })

  it("links an account to one live person per directory", async () => {
    const [ada] = (
      await store().listUsers(acme, dirA, {
        filter: { terms: [{ attr: "userName", value: `ada@${live}` }] },
        startIndex: 1,
        count: 1,
      })
    ).rows
    const other = await store().createUser(acme, dirA, person("alan"), event)
    if (other === "taken") throw new Error("taken")
    expect(await store().linkUser(acme, ada!.id, `user_${suffix}`)).toBe("linked")
    expect(await store().linkUser(acme, ada!.id, `user_${suffix}`)).toBe("linked")
    expect(await store().linkUser(acme, other.row.id, `user_${suffix}`)).toBe("taken")
    expect(await store().linkUser(acme, ada!.id, "user_someone_else")).toBe("taken")
    // Another directory may link the same account.
    const inB = await store().createUser(acme, dirB, person("ada2"), event)
    if (inB === "taken") throw new Error("taken")
    expect(await store().linkUser(acme, inB.row.id, `user_${suffix}`)).toBe("linked")
  })

  // ── Writes are one transaction ──

  it("writes the person, the outbox entry and the audit event together, or none of them", async () => {
    const before = {
      users: (
        await owner`select count(*)::int as n from identity.directory_users where directory_id = ${dirA}`
      )[0]!.n,
      outbox: (
        await owner`select count(*)::int as n from identity.directory_outbox where directory_id = ${dirA}`
      )[0]!.n,
    }
    const failed = await refusal(() =>
      store().createUser(acme, dirA, person("doomed"), {
        // No type: the audit insert, the last of the three writes, fails.
        type: null as unknown as string,
      }),
    )
    expect(failed).not.toBe("accepted")
    expect(
      (
        await owner`select count(*)::int as n from identity.directory_users where directory_id = ${dirA}`
      )[0]!.n,
    ).toBe(before.users)
    expect(
      (
        await owner`select count(*)::int as n from identity.directory_outbox where directory_id = ${dirA}`
      )[0]!.n,
    ).toBe(before.outbox)

    const made = await store().createUser(acme, dirA, person("kept"), event)
    if (made === "taken") throw new Error("taken")
    expect(made.outbox).toHaveLength(1)
    const [entry] =
      await owner`select cause, applied_at from identity.directory_outbox where id = ${made.outbox[0]!.id}`
    expect(entry).toMatchObject({ cause: "created", applied_at: null })
    const [audit] =
      await owner`select type, data from identity.events where tenant_id = ${acme} and data->>'directoryUserId' = ${made.row.id}`
    expect(audit).toMatchObject({ type: "scim.user.created" })
  })

  it("rolls an edit back when its callback refuses, writing neither the row nor an entry", async () => {
    const made = await store().createUser(acme, dirA, person("steady"), event)
    if (made === "taken") throw new Error("taken")
    const entries = async () =>
      (
        await owner`select count(*)::int as n from identity.directory_outbox where directory_user_id = ${made.row.id}`
      )[0]!.n as number
    const before = await entries()
    await expect(
      store().editUser(
        acme,
        dirA,
        made.row.id,
        () => {
          throw new Error("bad patch")
        },
        () => ({ type: "x" }),
      ),
    ).rejects.toThrow("bad patch")
    expect(await entries()).toBe(before)
    expect((await store().user(acme, dirA, made.row.id))?.updatedAt).toEqual(
      made.row.updatedAt,
    )
  })

  it("serialises two edits of one person, so neither is applied to a stale copy", async () => {
    const made = await store().createUser(acme, dirA, person("busy"), event)
    if (made === "taken") throw new Error("taken")
    const add = (tag: string) =>
      store().editUser(
        acme,
        dirA,
        made.row.id,
        (current) => {
          const tags = (current.resource.tags as string[] | undefined) ?? []
          return {
            ...person("busy"),
            resource: { ...current.resource, tags: [...tags, tag] },
          }
        },
        () => ({ type: "scim.user.updated" }),
      )
    await Promise.all(Array.from({ length: 8 }, (_, i) => add(`t${i}`)))
    const tags = (
      (await store().user(acme, dirA, made.row.id))!.resource.tags as string[]
    ).sort()
    expect(tags).toEqual(Array.from({ length: 8 }, (_, i) => `t${i}`))
  })

  // ── Groups ──

  it("holds only its own directory's live people, skips the rest, and touches who changed", async () => {
    const a = await store().createUser(acme, dirA, person("g1"), event)
    const b = await store().createUser(acme, dirA, person("g2"), event)
    const c = await store().createUser(acme, dirB, person("g3"), event)
    if (a === "taken" || b === "taken" || c === "taken") throw new Error("taken")
    const made = await store().createGroup(
      acme,
      dirA,
      readGroup({
        displayName: "Team",
        members: [
          { value: a.row.id },
          { value: c.row.id },
          { value: "banana" },
          { value: crypto.randomUUID() },
        ],
      }),
      { type: "scim.group.created" },
    )
    expect(made.kind).toBe("written")
    if (made.kind !== "written") throw new Error("duplicate")
    expect(made.skipped).toBe(3)
    expect(made.outbox.map((e) => e.directoryUserId)).toEqual([a.row.id])
    expect((await store().membersOf(acme, [made.row.id])).get(made.row.id)).toEqual([
      { id: a.row.id, display: a.row.displayName ?? a.row.userName },
    ])
    expect((await store().groupsOf(acme, [a.row.id, c.row.id])).get(a.row.id)).toEqual([
      { id: made.row.id, displayName: "Team" },
    ])

    const added = await store().editGroup(
      acme,
      dirA,
      made.row.id,
      (cur) => ({
        displayName: cur.row.displayName,
        externalId: cur.row.externalId,
        members: [...cur.members, b.row.id],
        resource: cur.row.resource,
      }),
      { type: "scim.group.updated" },
    )
    if (!added || added.kind !== "written") throw new Error("expected written")
    expect(added.outbox.map((e) => e.directoryUserId)).toEqual([b.row.id])
    const renamed = await store().editGroup(
      acme,
      dirA,
      made.row.id,
      (cur) => ({
        displayName: "Renamed",
        externalId: cur.row.externalId,
        members: cur.members,
        resource: cur.row.resource,
      }),
      { type: "scim.group.updated" },
    )
    if (!renamed || renamed.kind !== "written") throw new Error("expected written")
    expect(renamed.outbox.map((e) => e.directoryUserId).sort()).toEqual(
      [a.row.id, b.row.id].sort(),
    )

    // A deleted person leaves its groups; a deleted group touches its members.
    await store().deleteUser(acme, dirA, a.row.id, { type: "scim.user.deleted" })
    expect(
      (await store().membersOf(acme, [made.row.id])).get(made.row.id)!.map((m) => m.id),
    ).toEqual([b.row.id])
    const gone = await store().deleteGroup(acme, dirA, made.row.id, {
      type: "scim.group.deleted",
    })
    expect(gone!.outbox.map((e) => e.directoryUserId)).toEqual([b.row.id])
    expect(await store().group(acme, dirA, made.row.id)).toBeNull()
    // Another workspace can neither edit nor delete it.
    expect(
      await store().deleteGroup(rival, dirA, made.row.id, { type: "x" }),
    ).toBeNull()
  })

  it("filters users by userName, externalId and emails.value, and pages them", async () => {
    await store().createUser(acme, dirB, person("p1", { externalId: "ext-p1" }), event)
    await store().createUser(
      acme,
      dirB,
      person("p2", {
        externalId: "ext-p2",
        emails: [{ value: `p2@${live}`, type: "work", primary: true }],
      }),
      event,
    )
    const list = (
      filter: Parameters<ReturnType<typeof store>["listUsers"]>[2]["filter"],
      startIndex = 1,
      count = 100,
    ) => store().listUsers(acme, dirB, { filter, startIndex, count })
    expect(
      (await list({ terms: [{ attr: "userName", value: `P1@${live.toUpperCase()}` }] }))
        .total,
    ).toBe(1)
    expect(
      (await list({ terms: [{ attr: "externalId", value: "ext-p2" }] })).rows[0]!
        .userName,
    ).toBe(`p2@${live}`)
    expect(
      (await list({ terms: [{ attr: "emails.value", value: `P2@${live}` }] })).total,
    ).toBe(1)
    expect(
      (await list({ terms: [{ attr: "emails.value", value: "nobody@x.test" }] })).total,
    ).toBe(0)
    // The bracketed form is the same address with a work type on it.
    expect(
      (await list({ terms: [{ attr: "workEmail", value: `P2@${live}` }] })).total,
    ).toBe(1)
    // Both comparisons must hold.
    expect(
      (
        await list({
          terms: [
            { attr: "userName", value: `P2@${live}` },
            { attr: "externalId", value: "ext-p2" },
          ],
        })
      ).total,
    ).toBe(1)
    expect(
      (
        await list({
          terms: [
            { attr: "userName", value: `P2@${live}` },
            { attr: "externalId", value: "ext-p1" },
          ],
        })
      ).total,
    ).toBe(0)
    const all = await list(null)
    const second = await list(null, 2, 1)
    expect(second.total).toBe(all.total)
    expect(second.rows[0]!.id).toBe(all.rows[1]!.id)
    expect((await list(null, 1, 0)).rows).toEqual([])
    // A filter value is a value: SQL in it matches nothing and breaks nothing.
    expect(
      (await list({ terms: [{ attr: "userName", value: "x' or '1'='1" }] })).total,
    ).toBe(0)
    expect(
      (
        await store().listGroups(acme, dirB, {
          filter: { terms: [{ attr: "displayName", value: "' or true --" }] },
          startIndex: 1,
          count: 10,
        })
      ).total,
    ).toBe(0)
  })

  // ── The apply job's reads and marks ──

  it("reads the row with its newest entry and marks only entries up to that", async () => {
    const made = await store().createUser(acme, dirA, person("marked"), event)
    if (made === "taken") throw new Error("taken")
    const first = made.outbox[0]!.id
    const read = await store().forApply(acme, made.row.id)
    expect(read).toMatchObject({
      upTo: first,
      row: { directoryEnabled: true, id: made.row.id },
    })
    // A change lands after the read.
    const second = await store().editUser(
      acme,
      dirA,
      made.row.id,
      (c) => ({ ...person("marked"), resource: c.resource }),
      () => ({ type: "x" }),
    )
    if (!second || second === "taken") throw new Error("edit")
    const later = second.outbox[0]!.id
    expect(later > first).toBe(true)
    await store().markApplied(acme, made.row.id, read!.upTo!, new Date())
    const left = await store().pending(acme, dirA, new Date(Date.now() + 60_000), 100)
    expect(
      left.filter((e) => e.directoryUserId === made.row.id).map((e) => e.id),
    ).toEqual([later])
    // Not old enough yet: a kick leaves fresh entries to their own job.
    expect(
      await store().pending(acme, dirA, new Date(Date.now() - 3_600_000), 100),
    ).toEqual([])
    await store().noteFailure(acme, made.row.id, "x".repeat(500))
    const [failed] =
      await owner`select attempts, last_error from identity.directory_outbox where id = ${later}`
    expect(failed).toMatchObject({ attempts: 1 })
    expect(String(failed!.last_error)).toHaveLength(200)
    // Another workspace marks nothing.
    await store().markApplied(rival, made.row.id, later, new Date())
    expect(
      (await store().pending(acme, dirA, new Date(Date.now() + 60_000), 100)).some(
        (e) => e.id === later,
      ),
    ).toBe(true)
    expect(await store().forApply(acme, "banana")).toBeNull()
  })

  it("carries a disabled directory's state to the job, and drops it from the votes", async () => {
    const made = await store().createUser(acme, dirB, person("votes"), event)
    if (made === "taken") throw new Error("taken")
    await store().linkUser(acme, made.row.id, `user_votes_${suffix}`)
    expect(await store().personStatus(acme, `user_votes_${suffix}`)).toBe("active")
    expect(await store().personStatus(acme, `user_votes_${suffix}`, made.row.id)).toBe(
      "unknown",
    )
    await store().updateDirectory(acme, dirB, { enabled: false })
    expect((await store().forApply(acme, made.row.id))!.row.directoryEnabled).toBe(
      false,
    )
    expect(await store().personStatus(acme, `user_votes_${suffix}`)).toBe("unknown")
    expect(
      await store().provisioned(acme, {
        subject: `votes@${live}`,
        email: `votes@${live}`,
      }),
    ).toEqual([])
    await store().updateDirectory(acme, dirB, { enabled: true })
    await store().editUser(
      acme,
      dirB,
      made.row.id,
      () => person("votes", { active: false }),
      () => ({ type: "x" }),
    )
    expect(await store().personStatus(acme, `user_votes_${suffix}`)).toBe("inactive")
    // The last owner counts as active, and is not locked out.
    await store().setConflict(acme, made.row.id, "last_owner", null, new Date())
    expect(await store().personStatus(acme, `user_votes_${suffix}`)).toBe("active")
    expect(
      (
        await store().provisioned(acme, { subject: `votes@${live}`, email: "x@y.test" })
      )[0],
    ).toMatchObject({
      active: true,
      by: "subject",
      clerkUserId: `user_votes_${suffix}`,
    })
    expect(await store().personStatus(rival, `user_votes_${suffix}`)).toBe("unknown")
  })

  it("sets and clears a conflict, reporting only a real change", async () => {
    const made = await store().createUser(acme, dirA, person("conflicted"), event)
    if (made === "taken") throw new Error("taken")
    const at = new Date()
    expect(
      await store().setConflict(acme, made.row.id, "blocked", { why: 1 }, at),
    ).toBe(true)
    expect(
      await store().setConflict(acme, made.row.id, "blocked", { why: 1 }, at),
    ).toBe(false)
    expect((await store().conflicts(acme, dirA)).map((r) => r.conflict)).toContain(
      "blocked",
    )
    expect(await store().setConflict(acme, made.row.id, "banned", null, at)).toBe(true)
    expect(await store().setConflict(acme, made.row.id, null, null, at)).toBe(true)
    expect(await store().setConflict(acme, made.row.id, null, null, at)).toBe(false)
    expect(await store().setConflict(rival, made.row.id, "blocked", null, at)).toBe(
      false,
    )
  })

  it("remembers a ban of its own on every row of the person, and drops deleted rows when it lifts", async () => {
    const account = `user_ban_${suffix}`
    const live1 = await store().createUser(acme, dirA, person("ban1"), event)
    const gone = await store().createUser(acme, dirB, person("ban2"), event)
    if (live1 === "taken" || gone === "taken") throw new Error("taken")
    await store().linkUser(acme, live1.row.id, account)
    await store().linkUser(acme, gone.row.id, account)
    expect(await store().bannedByDirectory(acme, account)).toBe(false)
    await store().setBannedByDirectory(acme, account, true)
    expect(await store().bannedByDirectory(acme, account)).toBe(true)
    expect(await store().bannedByDirectory(rival, account)).toBe(false)
    await store().deleteUser(acme, dirB, gone.row.id, { type: "scim.user.deleted" })
    expect((await store().forApply(acme, gone.row.id))!.row.deletedAt).not.toBeNull()
    await store().setBannedByDirectory(acme, account, false)
    expect(await store().forApply(acme, gone.row.id)).toBeNull()
    expect((await store().forApply(acme, live1.row.id))!.row.bannedByDirectory).toBe(
      false,
    )
    // purgeUser takes only a deleted row.
    await store().purgeUser(acme, live1.row.id)
    expect(await store().forApply(acme, live1.row.id)).not.toBeNull()
  })

  it("purges a deleted row with its outbox entries, and requeues only a live one", async () => {
    const made = await store().createUser(acme, dirA, person("purged"), event)
    if (made === "taken") throw new Error("taken")
    const entry = await store().requeue(acme, dirA, made.row.id)
    expect(entry).not.toBeNull()
    expect(await store().requeue(acme, dirB, made.row.id)).toBeNull()
    expect(await store().requeue(rival, dirA, made.row.id)).toBeNull()
    expect(await store().requeue(acme, dirA, "banana")).toBeNull()
    await store().deleteUser(acme, dirA, made.row.id, { type: "scim.user.deleted" })
    expect(await store().requeue(acme, dirA, made.row.id)).toBeNull()
    await store().purgeUser(acme, made.row.id)
    expect(await store().forApply(acme, made.row.id)).toBeNull()
    expect(
      (
        await owner`select count(*)::int as n from identity.directory_outbox where directory_user_id = ${made.row.id}`
      )[0]!.n,
    ).toBe(0)
  })

  it("lists only the domains with a live proof", async () => {
    expect(await store().liveDomains(acme)).toEqual([live])
    expect(await store().liveDomains(rival)).toEqual([])
  })

  it("files the waiting list once, and answers it", async () => {
    const user = `user_wait_${suffix}`
    await store().fileWaitlist(acme, { userId: user, email: `Wait@${live}` })
    await store().fileWaitlist(acme, { userId: user, email: `Wait@${live}` })
    const rows = async () =>
      owner`select email, via, "full", accepted, answered_at from core.join_requests where tenant_id = ${acme} and user_id = ${user}`
    expect(await rows()).toMatchObject([
      {
        email: `wait@${live}`,
        via: "directory",
        full: true,
        accepted: null,
        answered_at: null,
      },
    ])
    await store().closeWaitlist(rival, user, true)
    expect((await rows())[0]!.accepted).toBeNull()
    await store().closeWaitlist(acme, user, true)
    expect(await rows()).toMatchObject([{ accepted: true }])
    // Answered once; a later close changes nothing.
    await store().closeWaitlist(acme, user, false)
    expect((await rows())[0]!.accepted).toBe(true)
  })

  it("finds who a subject or an address belongs to, linked or not", async () => {
    const made = await store().createUser(
      acme,
      dirA,
      person("finder", { externalId: "ext-finder" }),
      event,
    )
    if (made === "taken") throw new Error("taken")
    expect(
      await store().provisioned(acme, { subject: "ext-finder", email: "z@z.test" }),
    ).toEqual([{ clerkUserId: null, active: true, by: "subject" }])
    expect(
      await store().provisioned(acme, { subject: "someone", email: `finder@${live}` }),
    ).toEqual([{ clerkUserId: null, active: true, by: "email" }])
    expect(
      await store().provisioned(acme, { subject: `FINDER@${live}`, email: "z@z.test" }),
    ).toMatchObject([{ by: "subject" }])
    expect(
      await store().provisioned(rival, {
        subject: "ext-finder",
        email: `finder@${live}`,
      }),
    ).toEqual([])
    await store().deleteUser(acme, dirA, made.row.id, { type: "scim.user.deleted" })
    expect(
      await store().provisioned(acme, { subject: "ext-finder", email: "z@z.test" }),
    ).toEqual([])
  })

  // ── Tokens ──

  it("rotates with an overlap and never lengthens an older token's life", async () => {
    const dir = (
      await store().createDirectory(acme, {
        name: "Rot",
        provider: "generic",
        createdBy: "u",
      })
    ).id
    const now = new Date("2026-10-21T10:00:00Z")
    const t = (name: string, overlapMs: number, at = now) =>
      store().issueToken(
        acme,
        dir,
        {
          tokenHash: hashSecret(name),
          hint: `i10_scim_${name}`,
          createdBy: "u",
          overlapMs,
        },
        at,
      )
    const one = (await t("one", 0))!
    const two = (await t("two", 3_600_000))!
    expect((await store().tokenByHash(hashSecret("one")))!.expiresAt).toEqual(
      new Date(now.getTime() + 3_600_000),
    )
    // A later rotation with a longer overlap leaves the sooner expiry alone.
    await t("three", 86_400_000, new Date(now.getTime() + 60_000))
    expect((await store().tokenByHash(hashSecret("one")))!.expiresAt).toEqual(
      new Date(now.getTime() + 3_600_000),
    )
    expect((await store().tokenByHash(hashSecret("two")))!.expiresAt).toEqual(
      new Date(now.getTime() + 60_000 + 86_400_000),
    )
    // Overlap zero revokes every live one at once.
    await t("four", 0, new Date(now.getTime() + 120_000))
    expect((await store().tokenByHash(hashSecret("two")))!.revokedAt).toEqual(
      new Date(now.getTime() + 120_000),
    )
    expect((await store().tokenByHash(hashSecret("four")))!.revokedAt).toBeNull()
    expect(await store().revokeToken(acme, dir, one.id, new Date())).toBe(false)
    expect(await store().revokeToken(acme, dir, two.id, new Date())).toBe(false)
    expect(
      await store().issueToken(
        acme,
        rivalDir,
        { tokenHash: hashSecret("x"), hint: "h", createdBy: "u", overlapMs: 0 },
        now,
      ),
    ).toBeNull()
    expect(
      await store().issueToken(
        rival,
        dir,
        { tokenHash: hashSecret("y"), hint: "h", createdBy: "u", overlapMs: 0 },
        now,
      ),
    ).toBeNull()
  })

  it("never stores a token, only its hash and a hint", async () => {
    const token = `i10_scim_${"q".repeat(43)}`
    await store().issueToken(
      acme,
      dirA,
      {
        tokenHash: hashSecret(token),
        hint: token.slice(0, 13),
        createdBy: "u",
        overlapMs: 0,
      },
      new Date(),
    )
    const rows =
      await owner`select * from identity.directory_tokens where tenant_id = ${acme}`
    expect(JSON.stringify(rows)).not.toContain(token)
    const events = await owner`select * from identity.events where tenant_id = ${acme}`
    expect(JSON.stringify(events)).not.toContain(token)
  })

  it("notes a token's use at most once a minute", async () => {
    const hash = hashSecret("used")
    const issued = await store().issueToken(
      acme,
      dirA,
      { tokenHash: hash, hint: "i10_scim_used", createdBy: "u", overlapMs: 0 },
      new Date(),
    )
    const t0 = new Date("2026-10-21T10:00:00Z")
    await store().touchToken(acme, issued!.id, t0)
    await store().touchToken(acme, issued!.id, new Date(t0.getTime() + 30_000))
    expect((await store().tokenByHash(hash))!.lastUsedAt).toEqual(t0)
    await store().touchToken(acme, issued!.id, new Date(t0.getTime() + 61_000))
    expect((await store().tokenByHash(hash))!.lastUsedAt).toEqual(
      new Date(t0.getTime() + 61_000),
    )
  })

  it("counts users, conflicts and pending entries on the directory summary", async () => {
    const summary = (await store().directories(acme)).find((d) => d.id === dirA)!
    expect(summary.users).toBeGreaterThan(0)
    expect(summary.pending).toBeGreaterThan(0)
    expect(summary.tokens.length).toBeGreaterThan(0)
    expect(JSON.stringify(summary)).not.toContain("tokenHash")
  })

  it("removes everything of a workspace with the workspace", async () => {
    const t = crypto.randomUUID()
    await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                values (${t}, ${`x-${t.slice(0, 8)}`}, 'Temp', 'o', ${`org_${t.slice(0, 8)}`})`
    const d = await store().createDirectory(t, {
      name: "T",
      provider: "generic",
      createdBy: "u",
    })
    await store().createUser(t, d.id, person("temp"), event)
    await owner`delete from core.tenants where id = ${t}`
    expect(
      (
        await owner`select count(*)::int as n from identity.directory_users where tenant_id = ${t}`
      )[0]!.n,
    ).toBe(0)
    expect(
      (
        await owner`select count(*)::int as n from identity.directory_outbox where tenant_id = ${t}`
      )[0]!.n,
    ).toBe(0)
  })

  it("lists a directory's groups with member counts, never another tenant's or directory's", async () => {
    const a = await store().createUser(acme, dirA, person("gs1"), event)
    const b = await store().createUser(acme, dirA, person("gs2"), event)
    if (a === "taken" || b === "taken") throw new Error("taken")
    const mk = (t: string, d: string, displayName: string, ids: string[] = []) =>
      store().createGroup(
        t,
        d,
        readGroup({ displayName, members: ids.map((value) => ({ value })) }),
        { type: "scim.group.created" },
      )
    await mk(acme, dirA, "zz-picker-last", [a.row.id, b.row.id])
    await mk(acme, dirA, "AA-picker-first", [a.row.id])
    await mk(acme, dirA, "mm-picker-empty")
    await mk(acme, dirB, "zz-picker-other-directory")
    await mk(rival, rivalDir, "zz-picker-rival")

    const mine = (await store().groupSummaries(acme, dirA)).filter(
      (g) =>
        g.displayName.endsWith("picker-last") ||
        g.displayName.includes("picker-first") ||
        g.displayName.includes("picker-empty"),
    )
    expect(mine.map((g) => [g.displayName, g.memberCount])).toEqual([
      ["AA-picker-first", 1],
      ["mm-picker-empty", 0],
      ["zz-picker-last", 2],
    ])
    const all = (await store().groupSummaries(acme, dirA)).map((g) => g.displayName)
    expect(all).not.toContain("zz-picker-other-directory")
    expect(all).not.toContain("zz-picker-rival")
    // Another tenant asking for this tenant's directory id gets nothing.
    expect(await store().groupSummaries(rival, dirA)).toEqual([])
  })
})
