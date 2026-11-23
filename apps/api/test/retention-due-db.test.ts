import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import postgres from "postgres"

/**
 * `core.retention_due` through the horizons (#507) finds exactly the
 * workspaces the full scan found: on its first run, on later runs that skip
 * most of them, after a plan change, and for mail whose workspace row is gone.
 *
 *   STORAGE_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/storage_scratch bun test test/retention-due-db.test.ts
 *
 * ⚠ It clears `core.retention_horizons`, a cache the function rebuilds, so it
 * must not run beside another file that calls `core.retention_due`.
 */
const URL = process.env.STORAGE_TEST_DATABASE_URL
const API_URL =
  process.env.STORAGE_TEST_API_DATABASE_URL ??
  URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

const DAY = 86_400_000
const FLOOR = 3

// Free (3 days) with mail 5 days old, free with mail 1 day old, Pro (30 days)
// with mail 10 days old, free with no mail, and a workspace id with no tenant
// row holding only a 10 day old body.
const OLD_FREE = crypto.randomUUID()
const NEW_FREE = crypto.randomUUID()
const PRO = crypto.randomUUID()
const EMPTY = crypto.randomUUID()
const GONE = crypto.randomUUID()
// Created after the first run, given old mail, then its tenant row deleted.
const REMOVED = crypto.randomUUID()
const OURS = [OLD_FREE, NEW_FREE, PRO, EMPTY, GONE, REMOVED]

let owner: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>

async function mail(
  tenant: string,
  ageDays: number,
  { body = true, message = true } = {},
) {
  const id = crypto.randomUUID()
  const at = new Date(Date.now() - ageDays * DAY).toISOString()
  if (message) {
    await owner`insert into core.messages (id, created_at, tenant_id, status, from_address, to_addresses, subject)
                values (${id}, ${at}, ${tenant}, 'sent', 'a@x.test', ${["r@example.com"]}, 's')`
  }
  if (body) {
    await owner`insert into core.message_bodies (message_id, created_at, tenant_id, html)
                values (${id}, ${at}, ${tenant}, '<p>hi</p>')`
  }
}

/** What the function returned before the horizons: 20260929024333's body. */
async function scanned(): Promise<string[]> {
  const rows = await owner`
    with oldest as (
      select o.tenant_id, min(o.created_at) as oldest
        from (select m.tenant_id, min(m.created_at) as created_at from core.messages m group by 1
              union all
              select b.tenant_id, min(b.created_at) from core.message_bodies b group by 1) o
       group by 1
    ), policy as (
      select x.tenant_id, x.oldest,
             greatest(${FLOOR}::int, coalesce(p.retention_days, f.retention_days, 30)) as days
        from oldest x
        left join core.plan_assignments a on a.tenant_id = x.tenant_id
        left join core.plans p on p.id = a.plan_id
        left join core.plans f on f.id = 'free'
    )
    select tenant_id::text || ':' || days as due from policy
     where oldest < now() - make_interval(days => days)`
  return rows
    .map((r) => String(r.due))
    .filter((d) => OURS.some((id) => d.startsWith(id)))
}

/** As the retention job calls it: `i10_api`, outside a transaction. */
async function due(): Promise<string[]> {
  const rows =
    await app`select tenant_id, retention_days from core.retention_due(${FLOOR})`
  return rows
    .map((r) => `${String(r.tenant_id)}:${Number(r.retention_days)}`)
    .filter((d) => OURS.some((id) => d.startsWith(id)))
}

/** Every horizon is at or before its workspace's oldest mail. */
async function horizonsHold(): Promise<void> {
  const broken = await owner`
    select h.tenant_id from core.retention_horizons h
     where h.oldest_at > least(
             (select min(m.created_at) from core.messages m where m.tenant_id = h.tenant_id),
             (select min(b.created_at) from core.message_bodies b where b.tenant_id = h.tenant_id))`
  expect(broken.map((r) => String(r.tenant_id))).toEqual([])
}

suite("retention_due through the horizons, against Postgres", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    app = postgres(API_URL!, { max: 2, onnotice: () => {}, prepare: false })
    for (const [id, plan] of [
      [OLD_FREE, "free"],
      [NEW_FREE, "free"],
      [PRO, "pro"],
      [EMPTY, "free"],
    ] as const) {
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
                  values (${id}, ${`r-${id.slice(0, 8)}`}, 'T', ${`retention-due-${id}`})`
      await owner`insert into core.plan_assignments (tenant_id, plan_id, anchor) values (${id}, ${plan}, now())`
    }
    await mail(OLD_FREE, 5)
    await mail(OLD_FREE, 0.5)
    await mail(NEW_FREE, 1)
    await mail(PRO, 10)
    await mail(GONE, 10, { message: false })
    await owner`delete from core.retention_horizons`
  })

  afterAll(async () => {
    for (const t of ["message_bodies", "messages", "plan_assignments"]) {
      await owner
        .unsafe(`delete from core.${t} where tenant_id = any($1::uuid[])`, [OURS])
        .catch(() => {})
    }
    await owner`delete from core.tenants where id = any(${OURS}::uuid[])`.catch(
      () => {},
    )
    // After the tenants: deleting a tenant writes its horizon (the trigger).
    await owner`delete from core.retention_horizons where tenant_id = any(${OURS}::uuid[])`.catch(
      () => {},
    )
    await owner?.end()
    await app?.end()
  })

  it("finds on its first run what the full scan finds", async () => {
    const expected = [`${OLD_FREE}:3`, `${GONE}:3`].sort()
    expect((await scanned()).sort()).toEqual(expected)
    expect((await due()).sort()).toEqual(expected)
    await horizonsHold()
  })

  it("finds the same on the next run, from the horizons", async () => {
    expect((await due()).sort()).toEqual((await scanned()).sort())
    const [empty] =
      await owner`select oldest_at from core.retention_horizons where tenant_id = ${EMPTY}`
    // No mail: an hour before the run, so a send already under way is covered.
    expect(Date.now() - (empty!.oldest_at as Date).getTime()).toBeGreaterThan(
      59 * 60_000,
    )
    const [fresh] =
      await owner`select oldest_at from core.retention_horizons where tenant_id = ${NEW_FREE}`
    // Its oldest mail: not looked at again until that is past its period.
    expect(Date.now() - (fresh!.oldest_at as Date).getTime()).toBeGreaterThan(
      0.99 * DAY,
    )
    await horizonsHold()
  })

  it("sees a downgrade from Pro on the next run", async () => {
    expect(await due()).not.toContain(`${PRO}:30`)
    await owner`update core.plan_assignments set plan_id = 'free' where tenant_id = ${PRO}`
    expect(await due()).toContain(`${PRO}:3`)
    expect((await due()).sort()).toEqual((await scanned()).sort())
  })

  it("keeps finding a workspace until its old mail is gone, then lets it go", async () => {
    await owner`delete from core.messages where tenant_id = ${OLD_FREE} and created_at < now() - interval '3 days'`
    // The body is still there: still due.
    expect(await due()).toContain(`${OLD_FREE}:3`)
    await owner`delete from core.message_bodies where tenant_id = ${OLD_FREE} and created_at < now() - interval '3 days'`
    expect(await due()).not.toContain(`${OLD_FREE}:3`)
    expect((await due()).sort()).toEqual((await scanned()).sort())
    await horizonsHold()
  })

  it("forgets a workspace id with no tenant row once its mail is gone", async () => {
    await owner`delete from core.message_bodies where tenant_id = ${GONE}`
    expect(await due()).not.toContain(`${GONE}:3`)
    const rows =
      await owner`select 1 from core.retention_horizons where tenant_id = ${GONE}`
    expect(rows).toHaveLength(0)
  })

  it("finds the mail of a workspace deleted before it ever had a horizon", async () => {
    await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
                values (${REMOVED}, ${`r-${REMOVED.slice(0, 8)}`}, 'T', ${`retention-due-${REMOVED}`})`
    await mail(REMOVED, 40)
    await owner`delete from core.tenants where id = ${REMOVED}`
    expect(await due()).toContain(`${REMOVED}:3`)
    expect((await due()).sort()).toEqual((await scanned()).sort())
  })

  it("shows the horizons to nobody but the function", async () => {
    const rows = await app`select count(*)::int as n from core.retention_horizons`
    expect(rows[0]!.n).toBe(0)
  })
})
