import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { roleStore } from "../src/console/roles-db.js"
import { withTenant, type Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { sampleStorage } from "../src/mail/storage.js"
import { allocationStore, storageAllocations } from "../src/mailboxes/allocation.js"
import {
  consoleMailboxStore,
  consoleMailboxes,
  type PassthroughIdentityStore,
} from "../src/mailboxes/console.js"
import { planAssignmentStore } from "../src/metering/postgres.js"

/**
 * Console mailbox list, detail, tenant isolation, and per-mailbox storage
 * usage against Postgres as `i10_api` (Step B5).
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@127.0.0.1:55450/i10 bun test test/console-mailboxes-db.test.ts
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
const domainOf = (label: string) => `${label}-${sfx}.test`

const ownerUser = `user_owner_${sfx}`
const adminUser = `user_admin_${sfx}`
const memberUser = `user_member_${sfx}`
const legacyUser = `user_legacy_${sfx}`
const unhostedNullUser = `user_unhosted_${sfx}`
const offDomainUser = `user_off_${sfx}`
const managedUser = `user_managed_${sfx}`
const ssoReqUser = `user_ssoreq_${sfx}`
const rivalUser = `user_rival_${sfx}`
const allUsers = [
  ownerUser,
  adminUser,
  memberUser,
  legacyUser,
  unhostedNullUser,
  offDomainUser,
  managedUser,
  ssoReqUser,
  rivalUser,
]

const oidcConnId = crypto.randomUUID()
const reqConnId = crypto.randomUUID()

suite("console mailboxes and per-mailbox usage against Postgres as i10_api", () => {
  const hostedDomain = domainOf("acme")
  const offDomain = domainOf("off")
  const unhostedDomain = domainOf("unhosted")
  const rivalDomain = domainOf("rival")

  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    sqlApi = postgres(API_URL!, { max: 4, onnotice: () => {}, prepare: false })
    db = drizzle(sqlApi, { schema }) as unknown as Database

    for (const [id, name, ownerClerkId] of [
      [acme, "Acme", ownerUser],
      [rival, "Rival", rivalUser],
    ] as const) {
      await owner`
        insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
        values (${id}, ${`b5-${id.slice(0, 8)}`}, ${name}, ${ownerClerkId}, ${`org_${id.slice(0, 8)}`})
      `
      await owner`
        insert into core.plan_assignments (tenant_id, plan_id, anchor)
        values (${id}, 'pro', now())
      `
    }

    // Roles in Acme: ownerUser is owner, adminUser is admin, memberUser has no row (member).
    await owner`
      insert into core.workspace_roles (tenant_id, clerk_user_id, role, source)
      values
        (${acme}, ${ownerUser}, 'owner', 'creator'),
        (${acme}, ${adminUser}, 'admin', 'changed')
    `

    const provedAt = new Date("2026-11-01T00:00:00Z")
    // 1. Hosted domain for Acme
    await owner`
      insert into core.domains (tenant_id, name, status, hosts_mailboxes, verified_at, identity_registered_at)
      values (${acme}, ${hostedDomain}, 'verified', true, ${provedAt}, ${provedAt})
    `
    // 2. Domain owned by Acme where mailbox hosting was turned off (`domain_off`)
    await owner`
      insert into core.domains (tenant_id, name, status, hosts_mailboxes, verified_at, identity_registered_at)
      values (${acme}, ${offDomain}, 'verified', false, ${provedAt}, ${provedAt})
    `
    // 3. Domain with hosts_mailboxes = false (null tenant_id accounts on it must NOT be visible)
    await owner`
      insert into core.domains (tenant_id, name, status, hosts_mailboxes, verified_at, identity_registered_at)
      values (${acme}, ${unhostedDomain}, 'verified', false, ${provedAt}, ${provedAt})
    `
    // 4. Domain hosted by Rival
    await owner`
      insert into core.domains (tenant_id, name, status, hosts_mailboxes, verified_at, identity_registered_at)
      values (${rival}, ${rivalDomain}, 'verified', true, ${provedAt}, ${provedAt})
    `

    // Connections in identity.connections for managed account and required domain
    await owner`
      insert into identity.connections (id, tenant_id, name, protocol, provider, status, created_by)
      values
        (${oidcConnId}, ${acme}, 'Acme Okta', 'oidc', 'okta', 'active', ${ownerUser}),
        (${reqConnId}, ${acme}, 'Acme SAML', 'saml', 'entra', 'active', ${ownerUser})
    `

    // Seed accounts in authd.accounts
    await owner`
      insert into authd.accounts (
        clerk_user_id, email, display_name, active, tenant_id, storage_allocation, created_at, updated_at
      ) values
        (${ownerUser}, ${`owner@${hostedDomain}`}, 'Ada Owner', true, ${acme}, ${4 * 1024 * 1024 * 1024}, '2026-11-05T10:00:00Z', '2026-11-05T10:00:00Z'),
        (${memberUser}, ${`sam@${hostedDomain}`}, 'Sam Member', true, ${acme}, ${2 * 1024 * 1024 * 1024}, '2026-11-04T10:00:00Z', '2026-11-04T10:00:00Z'),
        (${legacyUser}, ${`legacy@${hostedDomain}`}, null, false, null, null, '2026-11-03T10:00:00Z', '2026-11-03T10:00:00Z'),
        (${offDomainUser}, ${`off@${offDomain}`}, 'Off Domain', true, ${acme}, null, '2026-11-02T10:00:00Z', '2026-11-02T10:00:00Z'),
        (${managedUser}, ${`managed@${hostedDomain}`}, 'Managed User', true, ${acme}, null, '2026-11-01T10:00:00Z', '2026-11-01T10:00:00Z'),
        (${unhostedNullUser}, ${`ghost@${unhostedDomain}`}, 'Ghost Null', true, null, null, '2026-11-01T09:00:00Z', '2026-11-01T09:00:00Z'),
        (${rivalUser}, ${`rival@${rivalDomain}`}, 'Rival User', true, ${rival}, ${1024 * 1024 * 1024}, '2026-11-05T10:00:00Z', '2026-11-05T10:00:00Z')
    `

    await owner`
      insert into identity.managed_accounts (clerk_user_id, tenant_id, connection_id, reason, emails)
      values (${managedUser}, ${acme}, ${oidcConnId}, 'jit', ${[`managed@${hostedDomain}`]})
    `

    await owner`
      insert into authd.managed_accounts (clerk_user_id, connection_id)
      values (${managedUser}, ${oidcConnId})
    `

    await owner`
      insert into authd.aliases (address, clerk_user_id, source)
      values
        (${`ada@${hostedDomain}`}, ${ownerUser}, 'clerk'),
        (${`founders@${hostedDomain}`}, ${ownerUser}, 'directory')
    `
  })

  afterAll(async () => {
    await owner`delete from authd.aliases where clerk_user_id = any(${allUsers})`
    await owner`delete from authd.managed_accounts where clerk_user_id = any(${allUsers})`
    await owner`delete from identity.managed_accounts where clerk_user_id = any(${allUsers})`
    await owner`delete from authd.accounts where clerk_user_id = any(${allUsers})`
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await sqlApi.end()
  })

  function buildService() {
    const storage = storageAllocations({
      store: allocationStore(db),
      assignments: planAssignmentStore(db),
    })
    const fakeIdentity: PassthroughIdentityStore = {
      connectionForStart: async (id) => {
        if (id !== oidcConnId) return null
        return {
          id: oidcConnId,
          tenantId: acme,
          name: "Acme Okta",
          protocol: "oidc",
          provider: "okta",
          status: "active",
          enforcement: "optional",
          jitEnabled: true,
          mfaRequired: false,
          maxSessionSeconds: null,
          idleTimeoutSeconds: null,
          config: {
            oidcMail: {
              preset: "okta",
              issuer: "https://acme.okta.com/oauth2/default",
              tokenEndpoint: "https://acme.okta.com/oauth2/default/v1/token",
              clientId: "0oa1b2c3d4e5f6g7h8i9",
              extra: {},
              enabled: true,
            },
          },
          attributeMapping: {},
          relink: "ask",
          upnAsEmail: false,
        }
      },
      connectionSecrets: async () => null,
      liveDomains: async () => [hostedDomain],
    }
    return consoleMailboxes({
      store: consoleMailboxStore(db),
      roles: roleStore(db),
      pool: async (tenantId) => (await storage.overview(tenantId)).pool,
      identity: fakeIdentity,
    })
  }

  it("isolates workspace mailboxes, includes null-tenant rows only on a hosted domain, and derives statuses and lanes", async () => {
    const svc = buildService()
    const res = await svc.list({ tenantId: acme, userId: ownerUser })

    // Included: owner, sam, legacy (null tenant on hosted domain), off (tenant_id = acme on domain_off), managed.
    // Excluded: ghost@unhosted (null tenant on unhosted domain) and rival@rival.
    expect(res.data.map((m) => m.address)).toEqual([
      `owner@${hostedDomain}`,
      `sam@${hostedDomain}`,
      `legacy@${hostedDomain}`,
      `off@${offDomain}`,
      `managed@${hostedDomain}`,
    ])

    const byAddress = Object.fromEntries(res.data.map((m) => [m.address, m]))
    expect(byAddress[`owner@${hostedDomain}`]).toMatchObject({
      status: "active",
      signIn: "password",
      aliases: [
        { address: `ada@${hostedDomain}`, source: "clerk" },
        { address: `founders@${hostedDomain}`, source: "directory" },
      ],
      storage: {
        allocatedBytes: 4 * 1024 * 1024 * 1024,
        usedBytes: null,
        usedAt: null,
      },
    })
    expect(byAddress[`legacy@${hostedDomain}`]).toMatchObject({
      status: "inactive",
      signIn: "password",
    })
    expect(byAddress[`off@${offDomain}`]).toMatchObject({
      status: "domain_off",
      signIn: "password",
    })
    expect(byAddress[`managed@${hostedDomain}`]).toMatchObject({
      status: "active",
      signIn: "oidc",
    })

    // Rival mailbox is invisible to Acme even when asked by address as owner.
    expect(
      await svc.get({ tenantId: acme, userId: ownerUser }, `rival@${rivalDomain}`),
    ).toBeNull()
    expect(
      await svc.get({ tenantId: acme, userId: ownerUser }, `ghost@${unhostedDomain}`),
    ).toBeNull()
  })

  it("enforces member visibility against the real database", async () => {
    const svc = buildService()

    const memberList = await svc.list({ tenantId: acme, userId: memberUser })
    expect(memberList.data.map((m) => m.address)).toEqual([`sam@${hostedDomain}`])

    expect(
      await svc.get({ tenantId: acme, userId: memberUser }, `sam@${hostedDomain}`),
    ).toMatchObject({ address: `sam@${hostedDomain}` })
    expect(
      await svc.get({ tenantId: acme, userId: memberUser }, `owner@${hostedDomain}`),
    ).toBeNull()
  })

  it("records per-mailbox usage in core.mailbox_usage during sampleStorage and enforces RLS per tenant", async () => {
    const svc = buildService()

    await sampleStorage({
      db,
      mail: {
        snapshot: async () =>
          new Map([
            [`owner@${hostedDomain}`, 512_000],
            [`sam@${hostedDomain}`, 128_000],
            [`legacy@${hostedDomain}`, 0],
            [`off@${offDomain}`, 64_000],
            [`managed@${hostedDomain}`, 256_000],
            [`rival@${rivalDomain}`, 999_999],
          ]),
      },
    })

    const ownerBox = await svc.get(
      { tenantId: acme, userId: ownerUser },
      `owner@${hostedDomain}`,
    )
    expect(ownerBox?.storage.usedBytes).toBe(512_000)
    expect(ownerBox?.storage.usedAt).toEqual(expect.any(String))

    const listAfter = await svc.list({ tenantId: acme, userId: ownerUser })
    // Pool total used is the sum of Acme's mailboxes written to core.tenant_storage.
    expect(listAfter.pool.used).toBe(512_000 + 128_000 + 0 + 64_000 + 256_000)

    // RLS check as i10_api: reading core.mailbox_usage under Acme's tenant never sees Rival's row.
    const acmeUsageRows = await withTenant(db, acme, (tx) =>
      tx.select().from(schema.mailboxUsage),
    )
    expect(acmeUsageRows.some((r) => r.address === `rival@${rivalDomain}`)).toBe(false)
    expect(acmeUsageRows.some((r) => r.address === `owner@${hostedDomain}`)).toBe(true)
  })
})
