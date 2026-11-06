import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { assertRlsSubject, type Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { mailboxAuthFailureSummary } from "../src/risk/mailbox-auth.js"
import { accountEventOps } from "../src/webhooks/stalwart-account-db.js"
import type { StalwartAccountEvent } from "../src/webhooks/stalwart.js"

/**
 * Failed sign-ins to a mailbox, against a real Postgres, as `i10_api` (#384).
 *
 * ⚠ THIS IS WHERE "A LOGIN FAILURE IS NOT A SIGHTING" IS PROVEN. The unit suite
 * fakes the database and can only show the handler never asks for an identity
 * write; this one counts the rows in `core.identity_events` before and after.
 *
 * Run it against a THROWAWAY database with every migration applied, exactly as
 * `risk-db.test.ts` is:
 *
 *   MAILBOX_AUTH_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/i10_scratch bun test test/mailbox-auth-db.test.ts
 *
 * The URL is the OWNER's (to seed); the code under test logs in as `i10_api`
 * (the dev password, or MAILBOX_AUTH_TEST_API_DATABASE_URL), which is what makes
 * RLS apply.
 */
const URL = process.env.MAILBOX_AUTH_TEST_DATABASE_URL
const API_URL =
  process.env.MAILBOX_AUTH_TEST_API_DATABASE_URL ??
  URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip
const RUN = crypto.randomUUID().slice(0, 8)

const tenantA = crypto.randomUUID()
const tenantB = crypto.randomUUID()
const USER = `mba-test-${RUN}-user`
const DOMAIN = `mba-${RUN}.example`
/** TEST-NET-2, so it can never be a real subnet in the table. */
const SUBNET = "198.51.100"

let owner: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>
let db: Database

const failure = (
  n: number,
  over: Partial<Extract<StalwartAccountEvent, { type: "auth.failed" }>> = {},
): Extract<StalwartAccountEvent, { type: "auth.failed" }> => ({
  type: "auth.failed",
  account: `alice@${DOMAIN}`,
  ip: `${SUBNET}.${n}`,
  listener: "imap",
  occurredAt: new Date(),
  sourceEventId: `stalwart_test_${RUN}_${n}`,
  ...over,
})

const identityRows = async () => {
  const [row] = await owner`
    select count(*)::int as n from core.identity_events
     where clerk_user_id = ${USER} or subnet = ${SUBNET}`
  return row?.n as number
}

suite("mailbox sign-in failures against Postgres, as i10_api", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    app = postgres(API_URL!, { max: 4, onnotice: () => {}, prepare: false })
    db = drizzle(app, { schema }) as unknown as Database

    for (const id of [tenantA, tenantB])
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
                  values (${id}, ${`mba-${id.slice(0, 8)}`}, 'T', ${`mba-test-${RUN}-owner`})`
    await owner`insert into core.domains (tenant_id, name, hosts_mailboxes, verified_at)
                values (${tenantA}, ${DOMAIN}, true, now())`
    // One mailbox with the workspace on its row, one that only has its domain,
    // and one on a domain no workspace owns - i10's own.
    await owner`insert into authd.accounts (clerk_user_id, email, tenant_id)
                values (${USER}, ${`alice@${DOMAIN}`}, null),
                       (${`${USER}-b`}, ${`bob@elsewhere-${RUN}.example`}, ${tenantB}),
                       (${`${USER}-own`}, ${`staff@own-${RUN}.example`}, null)`
  })

  afterAll(async () => {
    for (const id of [tenantA, tenantB])
      await owner`delete from core.tenants where id = ${id}`.catch(() => {})
    await owner`delete from authd.accounts where clerk_user_id like ${`${USER}%`}`.catch(
      () => {},
    )
    await owner`delete from authd.webhook_events where event_id like ${`stalwart_test_${RUN}%`}`.catch(
      () => {},
    )
    await owner?.end()
    await app?.end()
  })

  it("connects as a role row level security applies to", async () => {
    await assertRlsSubject(app)
  })

  it("finds a hosted mailbox and its workspace, from the row or the domain", async () => {
    const ops = accountEventOps(db)

    expect(await ops.mailboxOwnerOf(`alice@${DOMAIN}`)).toEqual({
      clerkUserId: USER,
      tenantId: tenantA,
    })
    expect(await ops.mailboxOwnerOf(`bob@elsewhere-${RUN}.example`)).toEqual({
      clerkUserId: `${USER}-b`,
      tenantId: tenantB,
    })
    expect(await ops.mailboxOwnerOf(`staff@own-${RUN}.example`)).toEqual({
      clerkUserId: `${USER}-own`,
      tenantId: null,
    })
  })

  it("does not know an account we do not host", async () => {
    const ops = accountEventOps(db)
    expect(await ops.mailboxOwnerOf(`admin@${DOMAIN}`)).toBeNull()
    expect(await ops.mailboxOwnerOf("root@nowhere.example")).toBeNull()
  })

  it("records a failure, once, and never as an identity event", async () => {
    const ops = accountEventOps(db)
    const before = await identityRows()
    const owned = { clerkUserId: USER, tenantId: tenantA }

    expect(await ops.recordAuthFailure({ owner: owned, event: failure(1) })).toBe(
      "recorded",
    )
    expect(await ops.recordAuthFailure({ owner: owned, event: failure(1) })).toBe(
      "duplicate",
    )

    const [claims] = await owner`
      select count(*)::int as n from authd.webhook_events
       where event_id = ${`stalwart_test_${RUN}_1`}`
    expect(claims?.n).toBe(1)

    const [rows] = await owner`
      select count(*)::int as n, min(subnet) as subnet, min(listener) as listener
        from core.mailbox_auth_failures where tenant_id = ${tenantA}`
    expect(rows).toMatchObject({ n: 1, subnet: SUBNET, listener: "imap" })

    // The whole point: the network the failures came from is not "familiar" to
    // the person, and they are not a sighting of them.
    expect(await identityRows()).toBe(before)
    expect(before).toBe(0)
  })

  it("summarises a window by failures and distinct addresses", async () => {
    const ops = accountEventOps(db)
    const owned = { clerkUserId: USER, tenantId: tenantA }
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000)

    await ops.recordAuthFailure({ owner: owned, event: failure(2) })
    await ops.recordAuthFailure({
      owner: owned,
      event: failure(3, { ip: "203.0.113.7" }),
    })
    await ops.recordAuthFailure({
      owner: owned,
      event: failure(4, { occurredAt: old }),
    })

    const day = await mailboxAuthFailureSummary(db, {
      tenantId: tenantA,
      account: `Alice@${DOMAIN}`,
      since: new Date(Date.now() - 24 * 3600 * 1000),
    })
    // 1 (recorded above), 2 and 3 are inside the day; 4 is three days old.
    expect(day).toMatchObject({ failures: 3, distinctIps: 3, distinctSubnets: 2 })
    expect(day.lastAt).toBeInstanceOf(Date)

    const all = await mailboxAuthFailureSummary(db, {
      tenantId: tenantA,
      account: `alice@${DOMAIN}`,
      since: new Date(0),
    })
    expect(all.failures).toBe(4)
  })

  it("keeps one workspace's failures out of another's reads", async () => {
    const seenByB = await mailboxAuthFailureSummary(db, {
      tenantId: tenantB,
      account: `alice@${DOMAIN}`,
      since: new Date(0),
    })
    expect(seenByB).toEqual({
      failures: 0,
      distinctIps: 0,
      distinctSubnets: 0,
      lastAt: null,
    })
  })

  it("claims a quota event once", async () => {
    const ops = accountEventOps(db)
    const event: Extract<StalwartAccountEvent, { type: "limit.quota" }> = {
      type: "limit.quota",
      account: `alice@${DOMAIN}`,
      occurredAt: new Date(),
      sourceEventId: `stalwart_test_${RUN}_quota`,
    }

    expect(await ops.claimQuota(event)).toBe("recorded")
    expect(await ops.claimQuota(event)).toBe("duplicate")
  })
})
