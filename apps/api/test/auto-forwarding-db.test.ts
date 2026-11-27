import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import { autoForwardingStore } from "../src/mailboxes/auto-forwarding.js"
import {
  applyClerkEvent,
  projectClerkUser,
  projectUserEmails,
} from "../src/projection/writer.js"

/**
 * Per-workspace automatic forwarding policy (#526) against a real migrated
 * Postgres 18 database:
 *
 *   - `core.auto_forward_allowed(sender, rcpt)` executed as the `stalwart` role
 *     for all four modes (`workspace`, `workspace_and_members`, `anywhere`, `off`),
 *     cross-tenant hosted domains, TXT ownership proofs, displaced/unhosted
 *     domains, member sign-in emails, former members, mixed case, groups, and
 *     fail-closed edge cases.
 *   - Function privileges: `PUBLIC` and `i10_api` cannot execute it; `stalwart` can.
 *   - `autoForwardingStore(db)` as `i10_api` with RLS isolation and audit rows.
 *   - `authd.user_emails` projection from Clerk events (including users without a
 *     hosted mailbox, out-of-order protection, and `user.deleted` cleanup).
 *
 *   MAILBOX_ROUTE_TEST_DATABASE_URL=postgres://i10:i10@127.0.0.1:55437/i10 \
 *     bun test test/auto-forwarding-db.test.ts
 */

const URL = process.env.MAILBOX_ROUTE_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const STALWART_URL = URL?.replace(/\/\/[^@]+@/, "//stalwart:stalwart@")
const suite = URL ? describe : describe.skip

const RUN = crypto.randomUUID().slice(0, 8)
const acme = crypto.randomUUID()
const rival = crypto.randomUUID()

const acmeDomain = `acme-${RUN}.test`
const acmeSecondDomain = `acme2-${RUN}.test`
const acmeTxtDomain = `acmetxt-${RUN}.test`
const acmeUnhostedDomain = `acmesend-${RUN}.test`
const acmeDisplacedDomain = `acmedisp-${RUN}.test`
const contestedDomain = `contested-${RUN}.test`
const rivalDomain = `rival-${RUN}.test`

const aliceUser = `user_alice_${RUN}`
const bobUser = `user_bob_${RUN}`
const formerUser = `user_former_${RUN}`
const rivalUser = `user_rival_${RUN}`
const orphanUser = `user_orphan_${RUN}`
const projectedUser = `user_proj_${RUN}`
const backfilledUser = `user_backfill_${RUN}`

const aliceMailbox = `alice@${acmeDomain}`
const acmeTeamInbox = `support@${acmeDomain}`
const bobPersonalEmail = `bob-${RUN}@gmail.com`
const formerPersonalEmail = `former-${RUN}@gmail.com`
const rivalPersonalEmail = `rival-${RUN}@gmail.com`
const orphanMailbox = `orphan-${RUN}@orphan.test`

let owner: ReturnType<typeof postgres>
let sqlApi: ReturnType<typeof postgres>
let sqlStalwart: ReturnType<typeof postgres>
let dbApi: Database

async function allowed(sender: string | null, rcpt: string | null): Promise<boolean> {
  const [row] = await sqlStalwart<{ ok: boolean }[]>`
    select core.auto_forward_allowed(${sender}, ${rcpt}) as ok
  `
  return Boolean(row?.ok)
}

async function setModeDirect(
  tenantId: string,
  mode: "workspace" | "workspace_and_members" | "anywhere" | "off",
) {
  await owner`
    insert into identity.workspace_settings (tenant_id, auto_forwarding)
    values (${tenantId}, ${mode}::identity.auto_forwarding_mode)
    on conflict (tenant_id) do update
      set auto_forwarding = excluded.auto_forwarding
  `
}

suite("automatic forwarding in Postgres", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    sqlApi = postgres(API_URL!, { max: 4, onnotice: () => {}, prepare: false })
    sqlStalwart = postgres(STALWART_URL!, {
      max: 2,
      onnotice: () => {},
      prepare: false,
    })
    dbApi = drizzle({ client: sqlApi }) as unknown as Database

    for (const [id, slug, name, ownerUser] of [
      [acme, `af-acme-${RUN}`, "Acme", aliceUser],
      [rival, `af-rival-${RUN}`, "Rival", rivalUser],
    ] as const) {
      await owner`
        insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
        values (${id}, ${slug}, ${name}, ${ownerUser}, ${`org_${id.slice(0, 8)}`})
      `
    }

    const earlier = new Date("2026-10-01T00:00:00Z")
    const later = new Date("2026-11-01T00:00:00Z")

    // Acme's primary and second hosted domains (verified + hosting).
    await owner`
      insert into core.domains (tenant_id, name, status, hosts_mailboxes, verified_at, identity_registered_at)
      values
        (${acme}, ${acmeDomain}, 'verified', true, ${earlier}, ${earlier}),
        (${acme}, ${acmeSecondDomain}, 'verified', true, ${earlier}, ${earlier}),
        (${acme}, ${acmeUnhostedDomain}, 'verified', false, ${earlier}, ${earlier}),
        (${acme}, ${contestedDomain}, 'verified', true, ${earlier}, ${earlier}),
        (${rival}, ${rivalDomain}, 'verified', true, ${earlier}, ${earlier})
    `

    // Acme's TXT-proved hosted domain (no SES verification, only active TXT proof).
    await owner`
      insert into core.domains (tenant_id, name, status, hosts_mailboxes)
      values (${acme}, ${acmeTxtDomain}, 'pending', true)
    `
    await owner`
      insert into core.join_domains (tenant_id, name, clerk_org_id, source, verified_at)
      values (${acme}, ${acmeTxtDomain}, ${`org_${acme.slice(0, 8)}`}, 'txt', ${earlier})
    `

    // Displaced domain on acme.
    await owner`
      insert into core.domains (tenant_id, name, status, hosts_mailboxes, verified_at, displaced_at)
      values (${acme}, ${acmeDisplacedDomain}, 'verified', true, ${earlier}, ${later})
    `

    // Contested domain: rival holds a NEWER TXT proof, outbidding acme.
    await owner`
      insert into core.join_domains (tenant_id, name, clerk_org_id, source, verified_at)
      values (${rival}, ${contestedDomain}, ${`org_${rival.slice(0, 8)}`}, 'txt', ${later})
    `

    // Mailboxes and team inbox.
    await owner`
      insert into authd.accounts (clerk_user_id, email, active, tenant_id)
      values
        (${aliceUser}, ${aliceMailbox}, true, ${acme}),
        (${rivalUser}, ${`mallory@${rivalDomain}`}, true, ${rival}),
        (${orphanUser}, ${orphanMailbox}, true, null)
    `
    await owner`
      insert into authd.groups (tenant_id, name, email)
      values (${acme}, ${`support-${RUN}`}, ${acmeTeamInbox})
    `

    // Workspace members + verified sign-in emails.
    await owner`
      insert into core.workspace_roles (tenant_id, clerk_user_id, role, source)
      values
        (${acme}, ${aliceUser}, 'owner', 'creator'),
        (${acme}, ${bobUser}, 'member', 'invitation'),
        (${rival}, ${rivalUser}, 'owner', 'creator')
    `
    await owner`
      insert into authd.user_emails (clerk_user_id, email)
      values
        (${bobUser}, ${bobPersonalEmail}),
        (${formerUser}, ${formerPersonalEmail}),
        (${rivalUser}, ${rivalPersonalEmail})
    `
  })

  afterAll(async () => {
    if (owner) {
      await owner`delete from authd.accounts where clerk_user_id in (${aliceUser}, ${rivalUser}, ${orphanUser}, ${projectedUser})`
      await owner`delete from authd.user_emails where clerk_user_id in (${bobUser}, ${formerUser}, ${rivalUser}, ${projectedUser}, ${backfilledUser})`
      await owner`delete from authd.webhook_events where event_id like ${`evt_af_${RUN}_%`}`
      await owner`delete from core.tenants where id in (${acme}, ${rival})`
      await owner.end()
    }
    if (sqlApi) await sqlApi.end()
    if (sqlStalwart) await sqlStalwart.end()
  })

  describe("function privileges", () => {
    it("revokes EXECUTE from PUBLIC and i10_api, and grants it to stalwart", async () => {
      const [privs] = await owner<
        {
          pub: boolean
          api: boolean
          stalwart: boolean
        }[]
      >`
        select
          has_function_privilege('public', 'core.auto_forward_allowed(text, text)', 'execute') as pub,
          has_function_privilege('i10_api', 'core.auto_forward_allowed(text, text)', 'execute') as api,
          has_function_privilege('stalwart', 'core.auto_forward_allowed(text, text)', 'execute') as stalwart
      `
      expect(privs).toEqual({ pub: false, api: false, stalwart: true })

      // ⚠ Catch directly rather than `expect(...).rejects` (hangs postgres.js under bun).
      let apiErrCode: string | undefined
      try {
        await sqlApi`select core.auto_forward_allowed(${aliceMailbox}, ${`team@${acmeDomain}`})`
      } catch (err) {
        apiErrCode = (err as { code?: string }).code
      }
      expect(apiErrCode).toBe("42501")
    })
  })

  describe("core.auto_forward_allowed modes (as stalwart role)", () => {
    it("defaults to workspace mode when no workspace_settings row exists", async () => {
      const rows =
        await owner`select 1 from identity.workspace_settings where tenant_id = ${acme}`
      expect(rows).toHaveLength(0)

      // Own hosted & owned domains (sending proof and TXT proof) are allowed.
      expect(await allowed(aliceMailbox, `colleague@${acmeDomain}`)).toBe(true)
      expect(await allowed(aliceMailbox, `billing@${acmeSecondDomain}`)).toBe(true)
      expect(await allowed(aliceMailbox, `ops@${acmeTxtDomain}`)).toBe(true)

      // Mixed case and leading/trailing spaces are normalised.
      expect(
        await allowed(
          `  ${aliceMailbox.toUpperCase()} `,
          `OPS@${acmeDomain.toUpperCase()}`,
        ),
      ).toBe(true)

      // Team inbox (authd.groups) sender uses its workspace's policy too.
      expect(await allowed(acmeTeamInbox, `colleague@${acmeSecondDomain}`)).toBe(true)
      expect(await allowed(acmeTeamInbox, `mallory@${rivalDomain}`)).toBe(false)

      // The #524 trap: another customer's hosted domain MUST be refused.
      expect(await allowed(aliceMailbox, `mallory@${rivalDomain}`)).toBe(false)

      // External domain and member sign-in email are refused in `workspace` mode.
      expect(await allowed(aliceMailbox, "attacker@gmail.com")).toBe(false)
      expect(await allowed(aliceMailbox, bobPersonalEmail)).toBe(false)

      // Unhosted, displaced, and outbid domains on own tenant are refused.
      expect(await allowed(aliceMailbox, `x@${acmeUnhostedDomain}`)).toBe(false)
      expect(await allowed(aliceMailbox, `x@${acmeDisplacedDomain}`)).toBe(false)
      expect(await allowed(aliceMailbox, `x@${contestedDomain}`)).toBe(false)
    })

    it("allows current members' sign-in emails only in workspace_and_members mode", async () => {
      await setModeDirect(acme, "workspace_and_members")

      // Own hosted domains still allowed.
      expect(await allowed(aliceMailbox, `colleague@${acmeDomain}`)).toBe(true)

      // Current member's sign-in email allowed (exact match, case-insensitive).
      expect(await allowed(aliceMailbox, bobPersonalEmail)).toBe(true)
      expect(
        await allowed(aliceMailbox.toUpperCase(), bobPersonalEmail.toUpperCase()),
      ).toBe(true)

      // Plus-addressed variant is NOT an exact match -> refused.
      expect(await allowed(aliceMailbox, `bob-${RUN}+tag@gmail.com`)).toBe(false)

      // Former member (no core.workspace_roles row) -> refused.
      expect(await allowed(aliceMailbox, formerPersonalEmail)).toBe(false)

      // Another workspace's member and another customer's hosted domain -> refused.
      expect(await allowed(aliceMailbox, rivalPersonalEmail)).toBe(false)
      expect(await allowed(aliceMailbox, `mallory@${rivalDomain}`)).toBe(false)

      // Arbitrary external address -> refused.
      expect(await allowed(aliceMailbox, "stranger@gmail.com")).toBe(false)

      // Removing a member immediately revokes their sign-in address as a target.
      await owner`
        delete from core.workspace_roles
         where tenant_id = ${acme} and clerk_user_id = ${bobUser}
      `
      expect(await allowed(aliceMailbox, bobPersonalEmail)).toBe(false)

      // Restore bob for subsequent tests.
      await owner`
        insert into core.workspace_roles (tenant_id, clerk_user_id, role, source)
        values (${acme}, ${bobUser}, 'member', 'invitation')
      `
    })

    it("allows every valid recipient in anywhere mode", async () => {
      await setModeDirect(acme, "anywhere")

      expect(await allowed(aliceMailbox, `colleague@${acmeDomain}`)).toBe(true)
      expect(await allowed(aliceMailbox, `mallory@${rivalDomain}`)).toBe(true)
      expect(await allowed(aliceMailbox, "external@example.org")).toBe(true)
    })

    it("refuses every recipient in off mode", async () => {
      await setModeDirect(acme, "off")

      expect(await allowed(aliceMailbox, `colleague@${acmeDomain}`)).toBe(false)
      expect(await allowed(aliceMailbox, bobPersonalEmail)).toBe(false)
      expect(await allowed(aliceMailbox, "external@example.org")).toBe(false)
    })

    it("fails closed on unknown, tenantless, null, or malformed inputs", async () => {
      await setModeDirect(acme, "anywhere")

      expect(await allowed(`nobody@${acmeDomain}`, `colleague@${acmeDomain}`)).toBe(
        false,
      )
      expect(await allowed(orphanMailbox, `colleague@${acmeDomain}`)).toBe(false)
      expect(await allowed(null, `colleague@${acmeDomain}`)).toBe(false)
      expect(await allowed(aliceMailbox, null)).toBe(false)
      expect(await allowed("", `colleague@${acmeDomain}`)).toBe(false)
      expect(await allowed(aliceMailbox, "")).toBe(false)
      expect(await allowed(aliceMailbox, "not-an-address")).toBe(false)
      expect(await allowed(aliceMailbox, `@${acmeDomain}`)).toBe(false)
      expect(await allowed(aliceMailbox, "local@")).toBe(false)
    })
  })

  describe("autoForwardingStore as i10_api", () => {
    it("reads workspace without inserting a row, saves changes, audits them, and isolates tenants", async () => {
      const store = autoForwardingStore(dbApi)

      // Rival has no workspace_settings row yet.
      expect(await store.get(rival)).toBe("workspace")
      const beforeRows =
        await owner`select 1 from identity.workspace_settings where tenant_id = ${rival}`
      expect(beforeRows).toHaveLength(0)

      expect(await store.set(rival, rivalUser, "workspace_and_members")).toEqual({
        before: "workspace",
        after: "workspace_and_members",
      })
      expect(await store.get(rival)).toBe("workspace_and_members")

      expect(await store.set(rival, rivalUser, "anywhere")).toEqual({
        before: "workspace_and_members",
        after: "anywhere",
      })
      expect(await store.get(rival)).toBe("anywhere")

      // Other workspace_settings defaults are preserved.
      const [row] = await owner`
        select deprovision, leaver_action, mailbox_creation, auto_forwarding
          from identity.workspace_settings
         where tenant_id = ${rival}
      `
      expect(row).toEqual({
        deprovision: "membership",
        leaver_action: "keep",
        mailbox_creation: "admins",
        auto_forwarding: "anywhere",
      })

      // Audit events recorded in identity.events with before/after and actor.
      const audit = await owner`
        select actor_user_id, data
          from identity.events
         where tenant_id = ${rival}
           and type = 'workspace.auto_forwarding_changed'
         order by id
      `
      expect(audit.map((r) => r.data)).toEqual([
        { before: "workspace", after: "workspace_and_members" },
        { before: "workspace_and_members", after: "anywhere" },
      ])
      expect(audit.every((r) => r.actor_user_id === rivalUser)).toBe(true)

      // Tenant isolation: changing acme never leaks into rival.
      await store.set(acme, aliceUser, "off")
      expect(await store.get(acme)).toBe("off")
      expect(await store.get(rival)).toBe("anywhere")
    })
  })

  describe("authd.user_emails projection", () => {
    it("projects verified external emails even without a hosted mailbox, ignores stale events, and deletes on user.deleted", async () => {
      const t1 = Date.UTC(2026, 10, 20, 12, 0, 0)
      const t2 = Date.UTC(2026, 10, 20, 13, 0, 0)

      await applyClerkEvent(
        dbApi,
        `evt_af_${RUN}_1`,
        "user.created",
        {
          id: projectedUser,
          updated_at: t2,
          email_addresses: [
            {
              id: "e1",
              email_address: `Proj-${RUN}@Gmail.com`,
              verification: { status: "verified" },
            },
            {
              id: "e2",
              email_address: `unverified-${RUN}@gmail.com`,
              verification: { status: "unverified" },
            },
          ],
        },
        [],
      )

      const afterCreate = await owner<{ email: string }[]>`
        select email from authd.user_emails where clerk_user_id = ${projectedUser}
      `
      expect(afterCreate.map((r) => r.email)).toEqual([`proj-${RUN}@gmail.com`])

      // Stale older event must not overwrite newer email list.
      await projectClerkUser(
        dbApi,
        {
          id: projectedUser,
          updated_at: t1,
          email_addresses: [
            {
              id: "e3",
              email_address: `stale-${RUN}@gmail.com`,
              verification: { status: "verified" },
            },
          ],
        },
        [],
      )
      const afterStale = await owner<{ email: string }[]>`
        select email from authd.user_emails where clerk_user_id = ${projectedUser}
      `
      expect(afterStale.map((r) => r.email)).toEqual([`proj-${RUN}@gmail.com`])

      // user.deleted removes all sign-in email rows.
      await applyClerkEvent(
        dbApi,
        `evt_af_${RUN}_2`,
        "user.deleted",
        { id: projectedUser },
        [],
      )
      const afterDelete = await owner<{ email: string }[]>`
        select email from authd.user_emails where clerk_user_id = ${projectedUser}
      `
      expect(afterDelete).toHaveLength(0)
    })

    it("backfills sign-in emails without creating a mailbox, and never rolls back a newer row", async () => {
      const email = (address: string) => ({
        id: address,
        email_address: address,
        verification: { status: "verified" },
      })
      const emailsOf = async () =>
        (
          await owner<{ email: string }[]>`
            select email from authd.user_emails where clerk_user_id = ${backfilledUser}
          `
        ).map((r) => r.email)

      // A hosted address too: the backfill writes the sign-in email, not a mailbox.
      await projectUserEmails(dbApi, {
        id: backfilledUser,
        updated_at: Date.UTC(2026, 10, 21),
        email_addresses: [email(`new-${RUN}@${acmeDomain}`)],
      })
      expect(await emailsOf()).toEqual([`new-${RUN}@${acmeDomain}`])
      const [mailboxes] = await owner<{ n: number }[]>`
        select count(*)::int as n from authd.accounts where clerk_user_id = ${backfilledUser}
      `
      expect(mailboxes?.n).toBe(0)

      await projectUserEmails(dbApi, {
        id: backfilledUser,
        updated_at: Date.UTC(2026, 10, 20),
        email_addresses: [email(`old-${RUN}@gmail.com`)],
      })
      expect(await emailsOf()).toEqual([`new-${RUN}@${acmeDomain}`])
    })
  })
})
