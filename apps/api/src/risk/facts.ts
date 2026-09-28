import { sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { reputationStore } from "../ses-status/reputation-store.js"
import { looksRandomLabel, registrable, subdomainOf } from "./rules.js"
import type { Facts, FarmPeer, IdentityFacts } from "./types.js"

/**
 * Everything a rule may read about one workspace (#170).
 *
 * ⚠ TENANT DATA THROUGH `withTenant`, CROSS-TENANT QUESTIONS THROUGH THE
 * DEFINER FUNCTIONS IN MIGRATION 0069, AND NOTHING ELSE. No bypass role, and
 * no query here can see another workspace's rows - only counts and booleans
 * about them, which is what the rules need.
 */
export interface OwnerInfo {
  mfa: boolean | null
  email: string | null
}

export interface FactsDeps {
  db: Database
  freePlanId: string
  /** Clerk's view of the owner. Cached by the caller; may fail to null. */
  ownerInfo: (clerkUserId: string) => Promise<OwnerInfo | null>
  now?: Date
}

type Row = Record<string, unknown>
const DAY = 86_400_000
const date = (v: unknown): Date | null => (v ? new Date(v as string) : null)
const num = (v: unknown): number => Number(v ?? 0)

export async function loadFacts(tenantId: string, deps: FactsDeps): Promise<Facts> {
  const { db } = deps
  const now = deps.now ?? new Date()
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString()

  const t = await withTenant(db, tenantId, async (tx) => {
    const q = async (statement: ReturnType<typeof sql>) =>
      (await tx.execute(statement)) as unknown as Row[]

    const [tenant] = await q(sql`
      select t.created_at, t.owner_clerk_user_id, a.plan_id,
             s.status as sub_status, s.created_at as sub_created
        from core.tenants t
        left join core.plan_assignments a on a.tenant_id = t.id
        left join core.subscriptions s on s.tenant_id = t.id
       where t.id = ${tenantId}::uuid
    `)
    if (!tenant) throw new Error(`no workspace ${tenantId}`)

    const [status] = await q(sql`
      select status, origin, changed_at from core.ses_tenant_status
       where tenant_id = ${tenantId}::uuid
    `)
    const pauses = await q(sql`
      select origin, changed_at from core.ses_tenant_status_events
       where tenant_id = ${tenantId}::uuid and status = 'disabled'
         and changed_at > ${ago(180)}::timestamptz
    `)
    const findings = await q(sql`
      select type, impact, opened_at, resolved_at from core.ses_reputation_findings
       where tenant_id = ${tenantId}::uuid
         and (resolved_at is null or opened_at > ${ago(90)}::timestamptz)
    `)

    const [early] = await q(sql`
      with first as (
        select id from core.messages
         where tenant_id = ${tenantId}::uuid and sent_at is not null
         order by created_at limit 500
      )
      select (select count(*) from first) as sends,
             (select count(*) from core.message_events e
               where e.tenant_id = ${tenantId}::uuid and e.type = 'bounced'
                 and e.payload->'bounce'->>'bounceType' = 'Permanent'
                 and e.message_id in (select id from first)) as hard
    `)
    const [unsubs] = await q(sql`
      select count(*) as n from core.message_events
       where tenant_id = ${tenantId}::uuid and type = 'unsubscribed'
         and occurred_at > ${ago(7)}::timestamptz
    `)
    const daily = await q(sql`
      select floor(extract(epoch from (${now.toISOString()}::timestamptz - sent_at)) / 86400)::int as ago,
             count(*)::int as n
        from core.messages
       where tenant_id = ${tenantId}::uuid
         and created_at > ${ago(9)}::timestamptz
         and sent_at > ${ago(7)}::timestamptz
         and sent_at <= ${ago(1)}::timestamptz
       group by 1
    `)

    const [api] = await q(sql`
      select
        count(*) filter (where occurred_at > ${ago(1)}::timestamptz) as req24,
        count(*) filter (where occurred_at > ${ago(1)}::timestamptz
                           and status between 400 and 499 and status <> 429) as err24,
        count(*) filter (where occurred_at > ${ago(1)}::timestamptz
                           and status = 429 and error_name like '%quota%') as quota24,
        count(distinct date_trunc('day', occurred_at))
          filter (where status = 429 and error_name like '%quota%') as quota_days,
        count(distinct country)
          filter (where occurred_at > ${ago(1)}::timestamptz and country is not null) as countries
      from core.api_requests
     where tenant_id = ${tenantId}::uuid and occurred_at > ${ago(7)}::timestamptz
    `)
    const [keys] = await q(sql`
      select count(*) as n from core.api_keys
       where tenant_id = ${tenantId}::uuid and created_at > ${ago(7)}::timestamptz
    `)
    const domains = await q(sql`
      select name, status, verified_at, displaced_at, created_at, registered_at, sends
        from core.domains where tenant_id = ${tenantId}::uuid
    `)

    const [tier] = await q(sql`
      select tier, source, changed_at from core.sending_tiers where tenant_id = ${tenantId}::uuid
    `)
    const [tierEvents] = await q(sql`
      select count(*) as n from core.sending_tier_events
       where tenant_id = ${tenantId}::uuid and to_tier = 'strict' and from_tier <> 'strict'
         and changed_at > ${ago(90)}::timestamptz
    `)
    const [holds] = await q(sql`
      select count(*) filter (where action = 'hold') as holds,
             count(*) filter (where action = 'release' and outcome = 'upheld') as upheld
        from core.sending_hold_events
       where tenant_id = ${tenantId}::uuid and occurred_at > ${ago(180)}::timestamptz
    `)
    const unsafe = await q(sql`
      select host, verdict, day::text as day from core.link_hosts
       where tenant_id = ${tenantId}::uuid and day >= ${ago(7)}::date
         and verdict is not null and verdict <> 'clean'
    `)
    return {
      tenant,
      status,
      pauses,
      findings,
      early,
      unsubs,
      daily,
      api,
      keys,
      domains,
      tier,
      tierEvents,
      holds,
      unsafe,
    }
  })

  const rep = reputationStore(db)
  const [day1, day7] = await Promise.all([
    rep.counts(tenantId, new Date(now.getTime() - DAY)),
    rep.counts(tenantId, new Date(now.getTime() - 7 * DAY)),
  ])

  const owner = String(t.tenant.owner_clerk_user_id)
  const verified = t.domains.filter(
    (d) => d.verified_at && d.status !== "failed" && d.sends !== false,
  )
  const parents = [
    ...new Set(
      verified.map((d) => registrable(String(d.name))).filter(Boolean) as string[],
    ),
  ]
  const registered = verified
    .map((d) => date(d.registered_at))
    .filter(Boolean) as Date[]

  const [identity, workspaces, farm, shared, info] = await Promise.all([
    identityFacts(db, owner, now),
    ownerWorkspaces(db, owner),
    farmPeers(db, tenantId, deps.freePlanId, now),
    sharedParents(db, parents, tenantId),
    deps.ownerInfo(owner).catch(() => null),
  ])

  const emailDomain = info?.email?.split("@")[1]?.toLowerCase() ?? null
  const plan =
    t.tenant.plan_id && t.tenant.plan_id !== deps.freePlanId ? "paid" : "free"
  const subStatus = t.tenant.sub_status ? String(t.tenant.sub_status) : null
  const trailing = Array.from({ length: 6 }, (_, i) =>
    num(t.daily.find((r) => num(r.ago) === 6 - i)?.n),
  )

  return {
    tenantId,
    now,
    plan,
    createdAt: date(t.tenant.created_at)!,
    paidSince: plan === "paid" ? date(t.tenant.sub_created) : null,
    billingTrouble: subStatus === "past_due" || subStatus === "unpaid",
    ses: {
      current: (t.status?.status as Facts["ses"]["current"]) ?? null,
      currentOrigin: (t.status?.origin as string | null) ?? null,
      changedAt: date(t.status?.changed_at),
      pauses: t.pauses.map((p) => ({
        origin: (p.origin as string | null) ?? null,
        at: date(p.changed_at)!,
      })),
      findings: t.findings.map((f) => ({
        type: String(f.type),
        impact: f.impact as "high" | "low",
        openedAt: date(f.opened_at)!,
        resolvedAt: date(f.resolved_at),
      })),
    },
    rates: {
      day1,
      day7,
      early: { sends: num(t.early?.sends), hardBounces: num(t.early?.hard) },
      unsubscribes7d: num(t.unsubs?.n),
      trailingDaily: trailing,
    },
    api: {
      requests24h: num(t.api?.req24),
      clientErrors24h: num(t.api?.err24),
      quotaRefusals24h: num(t.api?.quota24),
      quotaDays7d: num(t.api?.quota_days),
      keysCreated7d: num(t.keys?.n),
      keyCountries24h: num(t.api?.countries),
    },
    domains: {
      total: t.domains.length,
      added7d: t.domains.filter(
        (d) => (date(d.created_at)?.getTime() ?? 0) > now.getTime() - 7 * DAY,
      ).length,
      failedOrDisplaced: t.domains.filter(
        (d) => d.status === "failed" || d.displaced_at,
      ).length,
      youngestRegisteredAt: registered.length
        ? new Date(Math.max(...registered.map((d) => d.getTime())))
        : null,
      randomSubdomain: verified.some((d) => {
        const sub = subdomainOf(String(d.name))
        return sub ? looksRandomLabel(sub.split(".")[0]!) : false
      }),
      parents,
    },
    history: {
      tier: (t.tier?.tier as "strict" | "normal") ?? "normal",
      tierSource: (t.tier?.source as "score" | "staff") ?? "default",
      tierChangedAt: date(t.tier?.changed_at),
      tierDemotions90d: num(t.tierEvents?.n),
      holds180d: num(t.holds?.holds),
      upheldHolds: num(t.holds?.upheld),
    },
    owner: {
      clerkUserId: owner,
      mfa: info?.mfa ?? null,
      emailOnOwnDomain: emailDomain
        ? parents.includes(registrable(emailDomain) ?? "")
        : null,
      workspaces,
    },
    identity,
    farm: { peers: farm },
    parents: shared,
    links: {
      unsafe: t.unsafe.map((u) => ({
        host: String(u.host),
        verdict: String(u.verdict),
        day: String(u.day),
      })),
    },
    content: null,
    model: null,
  }
}

async function identityFacts(
  db: Database,
  owner: string,
  now: Date,
): Promise<IdentityFacts | null> {
  const rows = (await db.execute(sql`
    select * from core.identity_profile(${owner}, ${new Date(now.getTime() - 30 * DAY).toISOString()}::timestamptz)
  `)) as unknown as Row[]
  const r = rows[0]
  if (!r || !r.first_seen) return null
  return {
    firstSeen: date(r.first_seen),
    firstCountry: (r.first_country as string | null) ?? null,
    latestCountry: (r.latest_country as string | null) ?? null,
    latestTimezone: (r.latest_timezone as string | null) ?? null,
    countries: num(r.countries),
    torSeen: r.tor_seen === true,
    hostingSeen: r.hosting_seen === true,
    anomalies: num(r.anomalies),
    devicePeers: num(r.device_peers),
    heldDevicePeers: num(r.held_device_peers),
    subnetSignupPeers: num(r.subnet_signup_peers),
    heldSubnetPeers: num(r.held_subnet_peers),
  }
}

async function ownerWorkspaces(db: Database, owner: string): Promise<number> {
  const rows = (await db.execute(
    sql`select core.risk_owner_workspaces(${owner}) as n`,
  )) as unknown as Row[]
  return num(rows[0]?.n)
}

export async function farmPeers(
  db: Database,
  tenantId: string,
  freePlanId: string,
  now: Date,
): Promise<FarmPeer[]> {
  const since = new Date(now.getTime() - 7 * DAY).toISOString().slice(0, 10)
  const shared = (await db.execute(sql`
    select peer, exact_shared, near_shared from core.fingerprint_peers(${tenantId}::uuid, ${since}::date)
  `)) as unknown as Row[]
  if (shared.length === 0) return []
  const ids = `{${shared.map((s) => String(s.peer)).join(",")}}`
  const profiles = (await db.execute(sql`
    select * from core.risk_peer_profile(${tenantId}::uuid, ${ids}::uuid[], ${freePlanId})
  `)) as unknown as Row[]
  return shared.map((s) => {
    const p = profiles.find((x) => String(x.peer) === String(s.peer)) ?? {}
    return {
      peer: String(s.peer),
      exactShared: num(s.exact_shared),
      nearShared: num(s.near_shared),
      free: p.free !== false,
      held: p.held === true,
      young: p.young === true,
      createdNear: p.created_near === true,
      sameOwner: p.same_owner === true,
      ownerDevice: p.owner_device === true,
      ownerSubnet: p.owner_subnet === true,
      ownerCountry: p.owner_country === true,
    }
  })
}

async function sharedParents(
  db: Database,
  parents: string[],
  tenantId: string,
): Promise<Facts["parents"]> {
  if (parents.length === 0) return { sharedWith: 0, sharedWithHeldOrDead: 0 }
  const rows = (await db.execute(sql`
    select tenant_id, held, dead from core.tenants_sharing_parent(${`{${parents.join(",")}}`}::text[], ${tenantId}::uuid)
  `)) as unknown as Row[]
  const tenants = new Map<string, boolean>()
  for (const r of rows) {
    const id = String(r.tenant_id)
    // ⚠ HELD ONLY, NOT DEAD. A workspace its owner deleted and re-created
    // shares its domains with the dead one, and that is the most ordinary
    // thing in the world - not ban evasion.
    tenants.set(id, (tenants.get(id) ?? false) || r.held === true)
  }
  return {
    sharedWith: tenants.size,
    sharedWithHeldOrDead: [...tenants.values()].filter(Boolean).length,
  }
}
