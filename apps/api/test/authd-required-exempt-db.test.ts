import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { withTenant, type Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { roleStore } from "../src/console/roles-db.js"
import { mirrorRequiredDomains } from "../src/identity/authd-mirror.js"
import { ssoPolicyStore } from "../src/identity/policy-store.js"

/**
 * Who keeps their Clerk password for mail where SSO is "required"
 * (`authd.required_exempt`, identity/authd-mirror.ts `mirrorRequiredExempt`),
 * against a real database as `i10_api`.
 *
 * ⚠ EVERY ROW IS A PASS, so what these pin is the REVOCATIONS: the set is
 * recomputed in the transaction of each thing that can take a pass away, through
 * the entry points production uses (the policy store's bypass and exemption
 * writes, the role store's one writer), and not by a test calling the mirror.
 * A mutator that stopped calling it fails here.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:<pw>@localhost:<port>/i10 bun test test/authd-required-exempt-db.test.ts
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
const conn = crypto.randomUUID()
const conn2 = crypto.randomUUID()
const boss = `user_boss${sfx}`
const boss2 = `user_boss2${sfx}`
const admin = `user_admin${sfx}`
const member = `user_member${sfx}`
const lister = `user_lister${sfx}`
const gone = `user_gone${sfx}`

type Pass = { clerk_user_id: string; source: string; connection_id: string }

suite("authd.required_exempt follows who SSO exempts", () => {
  const policy = () => ssoPolicyStore(db)
  const roles = () => roleStore(db)

  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    sqlApi = postgres(API_URL!, { max: 8, onnotice: () => {} })
    db = drizzle(sqlApi, { schema }) as unknown as Database
    for (const [id, name] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const)
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                  values (${id}, ${`x-${id.slice(0, 8)}`}, ${name}, ${`owner-${id}`}, ${`org_${id.slice(0, 8)}`})`
    for (const [id, domain] of [
      [conn, `one-${sfx}.test`],
      [conn2, `two-${sfx}.test`],
    ] as const) {
      await owner`insert into identity.connections (id, tenant_id, name, protocol, status, enforcement)
                  values (${id}, ${acme}, ${domain}, 'saml', 'active', 'required_domain')`
      const [p] = await owner`insert into core.join_domains
        (tenant_id, name, clerk_org_id, source, verified_at)
        values (${acme}, ${domain}, ${`org_${sfx}`}, 'txt', now()) returning id`
      await owner`insert into identity.connection_domains (connection_id, join_domain_id, tenant_id)
                  values (${id}, ${p!.id}, ${acme})`
    }
  })

  afterAll(async () => {
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await sqlApi.end()
  })

  const setRoles = async (rows: [string, string][]) => {
    await owner`delete from core.workspace_roles where tenant_id = ${acme}`
    for (const [id, role] of rows)
      await owner`insert into core.workspace_roles (tenant_id, clerk_user_id, role, source)
                  values (${acme}, ${id}, ${role}, 'membership')`
  }
  const reset = async () => {
    await owner`delete from identity.bypass_users where tenant_id = ${acme}`
    await owner`delete from identity.workspace_settings where tenant_id = ${acme}`
    await owner`update core.join_domains set lapsed_at = null, displaced_at = null
                 where tenant_id = ${acme}`
    await owner`update identity.connections set status = 'active', enforcement = 'required_domain'
                 where tenant_id = ${acme}`
    await setRoles([
      [boss, "owner"],
      [boss2, "owner"],
      [admin, "admin"],
      [member, "member"],
      [lister, "member"],
    ])
    await mirror()
  }
  // As in production: inside the workspace's own transaction.
  const mirror = (tenant = acme) =>
    withTenant(db, tenant, (tx) => mirrorRequiredDomains(tx, tenant))
  const passes = async () =>
    (await owner`select clerk_user_id, source, connection_id from authd.required_exempt
                  where tenant_id = ${acme}`) as unknown as Pass[]
  // ⚠ SORTED HERE, IN JAVASCRIPT, NOT BY THE DATABASE: its collation orders
  // `user_boss…` and `user_boss2…` by rules a plain compare does not share.
  const who = async (connection: string) =>
    (await passes())
      .filter((p) => p.connection_id === connection)
      .map((p) => `${p.clerk_user_id}:${p.source}`)
      .sort()
  const exempt = (...ids: string[]) => ids.map((id) => `${id}:owner_exemption`).sort()
  const listed = (...ids: string[]) => ids.map((id) => `${id}:bypass`)
  const owners = exempt(boss, boss2, admin)
  const bypass = (id: string, reason = "break glass") =>
    policy().addBypass(acme, conn, { clerkUserId: id, reason, addedBy: boss })

  it("is empty until an ACTIVE connection requires SSO, and then holds the owners and admins", async () => {
    await reset()
    await owner`update identity.connections set enforcement = 'optional' where tenant_id = ${acme}`
    await mirror()
    expect(await passes()).toEqual([])

    await owner`update identity.connections set enforcement = 'required_domain' where tenant_id = ${acme}`
    await mirror()
    // Owners and admins, for EACH connection that requires; a member is not there.
    expect(await who(conn)).toEqual(owners)
    expect(await who(conn2)).toEqual(owners)
  })

  it("the owner exemption turned off takes the owners' and admins' pass, and on again gives it back", async () => {
    await reset()
    const now = new Date()
    expect(await policy().requestExemptionOff(acme, boss, now)).toBe("requested")
    // A request alone changes nothing: the exemption is on until a second owner agrees.
    expect(await who(conn)).toEqual(owners)

    expect(await policy().approveExemptionOff(acme, boss2, now)).toMatchObject({
      outcome: "applied",
    })
    expect(await passes()).toEqual([])

    expect(await policy().enableExemption(acme, boss)).toBe(true)
    expect(await who(conn)).toEqual(owners)
  })

  it("the bypass list: an entry is a pass for ITS connection, and removing it takes it away at once", async () => {
    await reset()
    expect(await bypass(lister)).toBe("added")
    expect(await who(conn)).toEqual([...owners, ...listed(lister)].sort())
    // ⚠ NOT ANOTHER CONNECTION'S: one IdP's break-glass does not open another's.
    expect(await who(conn2)).toEqual(owners)

    expect(await bypass(lister)).toBe("exists")
    expect(await policy().removeBypass(acme, conn, lister)).not.toBeNull()
    expect(await who(conn)).toEqual(owners)
    expect(await policy().removeBypass(acme, conn, lister)).toBeNull()
  })

  it("a person on both lists is two rows, and losing one leaves the other", async () => {
    await reset()
    await bypass(admin)
    // The owner exemption for each of the two connections, and the bypass for one.
    expect((await passes()).filter((p) => p.clerk_user_id === admin)).toHaveLength(3)

    await roles().transact(acme, () => ({
      writes: [
        {
          put: {
            userId: admin,
            role: "member",
            membershipId: null,
            source: "changed",
            grantedBy: boss,
          },
        },
      ],
      result: null,
    }))
    // Demoted: the owner-exemption rows go, the bypass rows stay.
    expect(
      (await passes())
        .filter((p) => p.clerk_user_id === admin)
        .map((p) => `${p.source}:${p.connection_id === conn ? "1" : "2"}`),
    ).toEqual(["bypass:1"])
  })

  // ⚠ THE ROLE STORE IS THE ONE WRITER OF `workspace_roles`, SO THIS IS THE WHOLE
  // OF "A DEMOTION OR A REMOVED MEMBER LOSES THEIR PASS".
  it("an admin demoted, an owner removed, a member promoted: each reaches the set in the same transaction", async () => {
    await reset()
    const put = (userId: string, role: "owner" | "admin" | "member") => ({
      put: {
        userId,
        role,
        membershipId: null,
        source: "changed" as const,
        grantedBy: boss,
      },
    })
    await roles().transact(acme, () => ({
      writes: [put(admin, "member")],
      result: null,
    }))
    expect(await who(conn)).toEqual(exempt(boss, boss2))

    await roles().transact(acme, () => ({ writes: [{ remove: boss2 }], result: null }))
    expect(await who(conn)).toEqual(exempt(boss))

    await roles().transact(acme, () => ({
      writes: [put(member, "admin")],
      result: null,
    }))
    expect(await who(conn)).toEqual(exempt(boss, member))
  })

  // ⚠ A BYPASS ENTRY COUNTS ONLY WHILE THE PERSON IS A MEMBER: mail has no door the
  // console's "they cannot reach it" argument applies to.
  it("a bypass entry of somebody who is not a member is not a pass; joining makes it one, leaving takes it away", async () => {
    await reset()
    expect(await bypass(gone)).toBe("added")
    expect(await who(conn)).toEqual(owners)

    await roles().transact(acme, () => ({
      writes: [
        {
          put: {
            userId: gone,
            role: "member",
            membershipId: null,
            source: "membership",
            grantedBy: null,
          },
        },
      ],
      result: null,
    }))
    expect(await who(conn)).toEqual([...owners, ...listed(gone)].sort())

    await roles().transact(acme, () => ({ writes: [{ remove: gone }], result: null }))
    expect(await who(conn)).toEqual(owners)
  })

  it("turning 'required' off, or losing the proof, takes every pass with it", async () => {
    await reset()
    await bypass(lister)
    expect((await passes()).length).toBeGreaterThan(0)

    await owner`update identity.connections set enforcement = 'optional' where id = ${conn}`
    await mirror()
    // conn2 still requires, so its owners stay; conn's passes, the bypass included, are gone.
    expect(await who(conn)).toEqual([])
    expect(await who(conn2)).toEqual(owners)

    await owner`update identity.connections set enforcement = 'required_domain' where id = ${conn}`
    await mirror()
    expect(await who(conn)).toEqual([...owners, ...listed(lister)].sort())

    await owner`update core.join_domains set lapsed_at = now() where tenant_id = ${acme}`
    await mirror()
    expect(await passes()).toEqual([])
  })

  // ⚠ THE LOCK. Two changes at once, each blind to the other's uncommitted write,
  // must not leave the pass the second had just taken away: a revoked person
  // exempt again with nothing to correct it.
  it("concurrent changes end at what the tables say, never at a stale pass", async () => {
    for (let round = 0; round < 6; round++) {
      await reset()
      await bypass(lister)
      await Promise.all([
        roles().transact(acme, () => ({
          writes: [
            {
              put: {
                userId: admin,
                role: "member" as const,
                membershipId: null,
                source: "changed" as const,
                grantedBy: boss,
              },
            },
          ],
          result: null,
        })),
        policy().removeBypass(acme, conn, lister),
        bypass(member),
      ])
      expect(await who(conn)).toEqual(
        [...exempt(boss, boss2), ...listed(member)].sort(),
      )
      expect(await who(conn2)).toEqual(exempt(boss, boss2))
    }
  })

  // Last: it removes a connection the tests above rely on.
  it("deleting the connection takes its passes with it (the foreign key), and another workspace's recompute leaves them alone", async () => {
    await reset()
    await bypass(lister)
    await mirror(rival)
    expect((await passes()).length).toBeGreaterThan(0)

    await owner`delete from identity.connections where id = ${conn2}`
    expect(await who(conn2)).toEqual([])
    expect(await who(conn)).toEqual([...owners, ...listed(lister)].sort())
  })
})
