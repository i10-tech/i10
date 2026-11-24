/**
 * The "world" half of the seed: workspaces, people, domains, mailboxes, SSO,
 * keys and plans. It is small enough to keep in memory, and the mail half
 * (seed-mail.ts) reads it so that a message comes from a domain its workspace
 * owns, a delivery goes to an endpoint that exists, and so on.
 */
import type { Sql } from "postgres"
import { bulkRows } from "./bulk.js"
import type { Profile } from "./profiles.js"
import { apportion, Rng, zipfWeights } from "./rng.js"
import {
  clerkId,
  domainName,
  localPart,
  personName,
  slugOf,
} from "./values.js"

export const OWN_DOMAIN = "i10.tech"
const DAY = 86_400_000

export interface Domain {
  id: string
  tenantId: string
  name: string
  status: "not_started" | "pending" | "verified" | "failed" | "temporary_failure"
  sends: boolean
  hosts: boolean
}

export interface Account {
  clerkUserId: string
  email: string
  tenantId: string | null
  active: boolean
}

export interface Tenant {
  id: string
  n: number
  orgId: string | null
  owner: string
  status: "active" | "suspended" | "deleted"
  createdAt: Date
  /** Share of activity (sums to 1 over tenants). */
  weight: number
  plan: string
  members: string[]
  admins: string[]
  domains: Domain[]
  accounts: Account[]
}

export interface World {
  anchor: Date
  tenants: Tenant[]
  /** Tenants that can send: active, with a verified sending domain. */
  senders: Tenant[]
  endpoints: {
    id: string
    tenantId: string
    kind: "http" | "polling" | "sqs"
    ordered: boolean
  }[]
  apiKeys: { id: string; tenantId: string }[]
}

const ago = (anchor: Date, ms: number) => new Date(anchor.getTime() - ms)

export async function seedWorld(
  sql: Sql,
  p: Profile,
  seed: number,
  anchor: Date,
  log: (m: string) => void,
): Promise<World> {
  const root = new Rng(seed)
  const weights = zipfWeights(p.tenants, p.skew)

  // --- tenants ---------------------------------------------------------------
  const tr = root.fork(1)
  const userPool: string[] = []
  const tenants: Tenant[] = weights.map((weight, n) => {
    const createdAt = ago(anchor, Math.floor(tr.next() ** 0.6 * (p.days + 60) * DAY))
    const personal = n > 0 && tr.chance(0.4)
    const status =
      n === 0
        ? "active"
        : tr.weighted([
            ["active", 96],
            ["suspended", 2],
            ["deleted", 2],
          ] as const)
    const owner = clerkId(tr, "user")
    userPool.push(owner)
    const paying = n === 0 || (n < 50 && tr.chance(0.8)) || tr.chance(0.12)
    return {
      id: tr.uuid7(createdAt),
      n,
      orgId: personal ? null : clerkId(tr, "org"),
      owner,
      status,
      createdAt,
      weight,
      plan:
        n === 0
          ? `custom-${n}`
          : paying
            ? tr.chance(0.05)
              ? `custom-${n}`
              : "pro"
            : "free",
      members: [owner],
      admins: [],
      domains: [],
      accounts: [],
    }
  })
  await bulkRows(
    sql,
    "core.tenants",
    [
      "id",
      "slug",
      "name",
      "clerk_org_id",
      "owner_clerk_user_id",
      "status",
      "created_at",
      "updated_at",
    ],
    async (w) => {
      const nr = root.fork(2)
      for (const t of tenants) {
        const name =
          t.n === 0
            ? "Huge Marketplace"
            : t.orgId
              ? personName(nr) || `Workspace ${t.n}`
              : "Personal"
        await w.row([
          t.id,
          slugOf(name, t.n),
          name,
          t.orgId,
          t.owner,
          t.status,
          t.createdAt,
          t.createdAt,
        ])
      }
    },
  )
  log(`tenants ${tenants.length}`)

  // --- members ---------------------------------------------------------------
  const mr = root.fork(3)
  const memberCounts = apportion(
    p.members,
    weights.map((w) => w ** 0.9),
    1,
  )
  await bulkRows(
    sql,
    "core.workspace_roles",
    [
      "tenant_id",
      "clerk_user_id",
      "role",
      "clerk_membership_id",
      "source",
      "created_at",
      "updated_at",
    ],
    async (w) => {
      for (const t of tenants) {
        const seen = new Set<string>([t.owner])
        await w.row([
          t.id,
          t.owner,
          "owner",
          t.orgId ? clerkId(mr, "orgmem") : null,
          "clerk",
          t.createdAt,
          t.createdAt,
        ])
        for (let i = 1; i < memberCounts[t.n]!; i++) {
          // One person in several workspaces (consultants, agencies): 10% of seats.
          let user =
            mr.chance(0.1) && userPool.length > 10
              ? mr.pick(userPool)
              : clerkId(mr, "user")
          if (seen.has(user)) user = clerkId(mr, "user")
          seen.add(user)
          userPool.push(user)
          t.members.push(user)
          const role = mr.chance(0.1) ? "admin" : "member"
          if (role === "admin") t.admins.push(user)
          const at = new Date(
            t.createdAt.getTime() +
              mr.next() * (anchor.getTime() - t.createdAt.getTime()),
          )
          await w.row([
            t.id,
            user,
            role,
            t.orgId ? clerkId(mr, "orgmem") : null,
            mr.weighted([
              ["clerk", 80],
              ["sso", 15],
              ["invitation", 5],
            ] as const),
            at,
            at,
          ])
        }
      }
    },
  )
  log(`members ${memberCounts.reduce((a, b) => a + b, 0)}`)

  // --- domains ---------------------------------------------------------------
  const dr = root.fork(4)
  const domainCounts = apportion(
    p.domains,
    weights.map((w) => w ** 0.45),
    0,
  )
  const verifiedNames: string[] = []
  let dn = 0
  await bulkRows(
    sql,
    "core.domains",
    [
      "id",
      "tenant_id",
      "name",
      "sends",
      "hosts_mailboxes",
      "receiving",
      "status",
      "verified_at",
      "dns_checked_at",
      "created_at",
      "updated_at",
      "displaced_at",
      "proof_missing_since",
      "dkim_selector",
      "identity_registered_at",
    ],
    async (w) => {
      for (const t of tenants) {
        const names = new Set<string>()
        for (let i = 0; i < domainCounts[t.n]!; i++) {
          const status = dr.weighted([
            ["verified", 60],
            ["pending", 15],
            ["not_started", 10],
            ["failed", 10],
            ["temporary_failure", 5],
          ] as const)
          let name = domainName(dr, dn++)
          // A claim of a name another workspace already verified: allowed while unverified.
          if (status !== "verified" && verifiedNames.length && dr.chance(0.03))
            name = dr.pick(verifiedNames)
          if (names.has(name)) continue
          names.add(name)
          if (status === "verified") verifiedNames.push(name)
          const created = new Date(
            t.createdAt.getTime() +
              dr.next() * (anchor.getTime() - t.createdAt.getTime()),
          )
          const verified =
            status === "verified"
              ? new Date(created.getTime() + dr.int(60, 86_400) * 1000)
              : null
          const hosts = status === "verified" && dr.chance(t.n < 20 ? 0.8 : 0.25)
          const d: Domain = {
            id: dr.uuid7(created),
            tenantId: t.id,
            name,
            status,
            sends: dr.chance(0.9) || !hosts,
            hosts,
          }
          t.domains.push(d)
          await w.row([
            d.id,
            t.id,
            name,
            d.sends,
            hosts,
            hosts && dr.chance(0.7),
            status,
            verified,
            status === "not_started" ? null : ago(anchor, dr.int(0, 3600) * 1000),
            created,
            created,
            dr.chance(0.01) ? ago(anchor, dr.int(1, 30) * DAY) : null,
            status === "verified" && dr.chance(0.02)
              ? ago(anchor, dr.int(1, 72) * 3_600_000)
              : null,
            status === "not_started" ? null : "i10",
            verified,
          ])
        }
      }
    },
  )
  log(`domains ${tenants.reduce((a, t) => a + t.domains.length, 0)}`)

  // --- mailboxes (authd) -----------------------------------------------------
  const ar = root.fork(5)
  const hosting = tenants.filter(
    (t) => t.status !== "deleted" && t.domains.some((d) => d.hosts),
  )
  const accountCounts = apportion(
    p.accounts - p.ownDomainAccounts,
    hosting.map((t) => t.weight ** 0.8),
    1,
  )
  const emails = new Set<string>()
  const mailboxOwners = new Set<string>()
  let an = 0
  const gate = (r: Rng) => ({
    suspended: r.chance(0.01),
    hold: r.chance(0.01),
    deleting: r.chance(0.005),
    banned: r.chance(0.002),
    locked: r.chance(0.002),
  })
  await bulkRows(
    sql,
    "authd.accounts",
    [
      "clerk_user_id",
      "email",
      "display_name",
      "description",
      "active",
      "tenant_id",
      "storage_allocation",
      "clerk_updated_at",
      "suspended_at",
      "payment_hold_at",
      "deleting_at",
      "banned",
      "locked",
      "locked_until",
      "created_at",
      "updated_at",
    ],
    async (w) => {
      const write = async (t: Tenant | null, domain: string) => {
        let email = `${localPart(ar, an++)}@${domain}`.toLowerCase()
        while (emails.has(email))
          email = `${localPart(ar, an++)}@${domain}`.toLowerCase()
        emails.add(email)
        // Most mailboxes belong to a member; the rest are shared or service boxes.
        // One mailbox per person (the table is keyed by Clerk user), even for a
        // person who is a member of several workspaces.
        const member =
          t && ar.chance(0.6) && t.members.length > t.accounts.length
            ? t.members[t.accounts.length]!
            : null
        const user = member && !mailboxOwners.has(member) ? member : clerkId(ar, "user")
        mailboxOwners.add(user)
        const active = ar.chance(0.92)
        const g = gate(ar)
        const created = ago(anchor, ar.int(0, p.days) * DAY)
        t?.accounts.push({ clerkUserId: user, email, tenantId: t.id, active })
        await w.row([
          user,
          email,
          ar.chance(0.9) ? personName(ar) : null,
          ar.chance(0.1) ? "" : null,
          active,
          t?.id ?? null,
          ar.chance(0.6) ? ar.pick([1, 5, 10, 50]) * 1_073_741_824 : null,
          ago(anchor, ar.int(0, 30) * DAY),
          g.suspended ? created : null,
          g.hold ? created : null,
          g.deleting ? created : null,
          g.banned,
          g.locked,
          g.locked && ar.chance(0.5) ? new Date(anchor.getTime() + 3_600_000) : null,
          created,
          created,
        ])
        return user
      }
      for (const [i, t] of hosting.entries()) {
        const hosted = t.domains.filter((d) => d.hosts)
        for (let k = 0; k < accountCounts[i]!; k++) {
          // The first mailboxes of a workspace cluster on its first domain, as a company's would.
          await write(t, (ar.chance(0.7) ? hosted[0]! : ar.pick(hosted)).name)
        }
      }
      for (let k = 0; k < p.ownDomainAccounts; k++) await write(null, OWN_DOMAIN)
    },
  )
  log(`accounts ${emails.size}`)

  const xr = root.fork(6)
  const aliasSeen = new Set<string>()
  let aliasN = 0
  await bulkRows(
    sql,
    "authd.aliases",
    ["address", "clerk_user_id", "source"],
    async (w) => {
      for (const t of hosting) {
        const hosted = t.domains.filter((d) => d.hosts)
        for (const a of t.accounts) {
          if (!xr.chance(0.4)) continue
          for (let i = xr.int(1, 3); i > 0; i--) {
            const address =
              `${localPart(xr, aliasN++)}@${xr.pick(hosted).name}`.toLowerCase()
            if (emails.has(address) || aliasSeen.has(address)) continue
            aliasSeen.add(address)
            await w.row([
              address,
              a.clerkUserId,
              xr.weighted([
                ["clerk", 70],
                ["directory", 15],
                ["console", 15],
              ] as const),
            ])
          }
        }
      }
    },
  )

  // Team inboxes, stored lowercase (`groups_email_lowercase`).
  const groups: { name: string; tenant: Tenant }[] = []
  await bulkRows(
    sql,
    "authd.groups",
    ["name", "email", "description", "tenant_id", "created_at"],
    async (w) => {
      let gn = 0
      for (const t of hosting) {
        if (!(t.n < 20 || xr.chance(0.05))) continue
        const hosted = t.domains.filter((d) => d.hosts)
        for (let i = t.n === 0 ? 200 : xr.int(1, 8); i > 0; i--) {
          const name = `team-${gn++}`
          const email =
            `${xr.pick(["support", "sales", "ops", "billing", "hr"])}${gn}@${xr.pick(hosted).name}`.toLowerCase()
          if (emails.has(email)) continue
          groups.push({ name, tenant: t })
          await w.row([
            name,
            email,
            xr.chance(0.5) ? personName(xr) : null,
            t.id,
            ago(anchor, xr.int(0, p.days) * DAY),
          ])
        }
      }
    },
  )
  await bulkRows(
    sql,
    "authd.group_members",
    ["group_name", "clerk_user_id"],
    async (w) => {
      for (const g of groups) {
        const pool = g.tenant.accounts
        const size = Math.min(
          pool.length,
          g.tenant.n === 0 ? xr.int(5, 500) : xr.int(1, 12),
        )
        const picked = new Set<string>()
        for (let i = 0; i < size; i++) picked.add(xr.pick(pool).clerkUserId)
        for (const u of picked) await w.row([g.name, u])
      }
    },
  )
  log(`aliases ${aliasSeen.size}, groups ${groups.length}`)

  await seedSso(sql, root.fork(7), p, tenants, anchor)
  log("sso")
  const apiKeys = await seedKeys(sql, root.fork(8), p, tenants, weights, anchor)
  log(`api keys ${apiKeys.length}`)
  await seedPlans(sql, root.fork(9), tenants, anchor)
  log("plans")
  const endpoints = await seedEndpoints(sql, root.fork(10), p, tenants, weights, anchor)
  log(`webhook endpoints ${endpoints.length}`)

  const senders = tenants.filter(
    (t) =>
      t.status === "active" &&
      t.domains.some((d) => d.status === "verified" && d.sends),
  )
  return { anchor, tenants, senders, endpoints, apiKeys }
}

async function seedSso(
  sql: Sql,
  r: Rng,
  p: Profile,
  tenants: Tenant[],
  anchor: Date,
): Promise<void> {
  // SSO needs an organization and a verified domain; the biggest such workspaces adopt it first.
  const eligible = tenants.filter(
    (t) =>
      t.orgId &&
      t.status === "active" &&
      t.domains.some((d) => d.status === "verified"),
  )
  const sso = eligible.slice(0, p.ssoTenants)
  const conns: { id: string; t: Tenant; status: string; enforcement: string }[] = []
  await bulkRows(
    sql,
    "identity.connections",
    [
      "id",
      "tenant_id",
      "name",
      "protocol",
      "provider",
      "status",
      "enforcement",
      "jit_enabled",
      "created_at",
      "updated_at",
    ],
    async (w) => {
      for (const t of sso) {
        for (let i = r.chance(0.15) ? 2 : 1; i > 0; i--) {
          const at = ago(anchor, r.int(1, p.days) * DAY)
          const c = {
            id: r.uuid7(at),
            t,
            status: r.weighted([
              ["active", 70],
              ["draft", 10],
              ["testing", 10],
              ["disabled", 10],
            ] as const),
            enforcement: r.weighted([
              ["off", 20],
              ["optional", 30],
              ["required_domain", 35],
              ["required_all", 15],
            ] as const),
          }
          conns.push(c)
          await w.row([
            c.id,
            t.id,
            `${r.pick(["Okta", "Entra", "Google", "JumpCloud"])} SSO`,
            r.pick(["saml", "oidc"]),
            r.pick(["okta", "entra", "google", "generic"]),
            c.status,
            c.enforcement,
            r.chance(0.6),
            at,
            at,
          ])
        }
      }
    },
  )

  const joins: { id: string; t: Tenant; d: Domain }[] = []
  await bulkRows(
    sql,
    "core.join_domains",
    [
      "id",
      "tenant_id",
      "domain_id",
      "name",
      "clerk_org_id",
      "source",
      "verified_at",
      "checked_at",
      "created_at",
    ],
    async (w) => {
      // Join domains: every SSO workspace's verified names, and 3% of the other organizations'.
      for (const t of tenants) {
        if (!t.orgId || t.status === "deleted") continue
        const isSso = sso.includes(t)
        if (!isSso && !r.chance(0.03)) continue
        for (const d of t.domains.filter((x) => x.status === "verified").slice(0, 5)) {
          const at = ago(anchor, r.int(1, p.days) * DAY)
          const j = { id: r.uuid7(at), t, d }
          joins.push(j)
          await w.row([j.id, t.id, d.id, d.name, t.orgId, "domain", at, at, at])
        }
      }
    },
  )
  // A join domain proves one connection (`connection_domains_proof_unique`): a
  // workspace's names go to its first connection; a second one has none.
  const covered = new Map<string, typeof joins>()
  for (const c of conns) {
    if (conns.find((x) => x.t === c.t) !== c) continue
    covered.set(
      c.id,
      joins.filter((x) => x.t === c.t),
    )
  }
  await bulkRows(
    sql,
    "identity.connection_domains",
    ["connection_id", "join_domain_id", "tenant_id"],
    async (w) => {
      for (const c of conns)
        for (const j of covered.get(c.id) ?? []) await w.row([c.id, j.id, c.t.id])
    },
  )

  // Managed people: a third of each active connection's workspace members.
  const active = conns.filter((c) => c.status === "active")
  const managed: { user: string; c: (typeof conns)[number]; email: string | null }[] =
    []
  const managedSeen = new Set<string>()
  for (const c of active) {
    for (const a of c.t.accounts) {
      if (managedSeen.has(a.clerkUserId) || !r.chance(0.33)) continue
      managedSeen.add(a.clerkUserId)
      managed.push({ user: a.clerkUserId, c, email: a.email })
    }
  }
  await bulkRows(
    sql,
    "identity.managed_accounts",
    ["clerk_user_id", "tenant_id", "connection_id", "reason", "emails"],
    async (w) => {
      for (const m of managed)
        await w.row([
          m.user,
          m.c.t.id,
          m.c.id,
          r.weighted([
            ["scim", 50],
            ["jit", 30],
            ["linked", 15],
            ["claimed", 5],
          ] as const),
          m.email ? [m.email] : [],
        ])
    },
  )
  await bulkRows(
    sql,
    "authd.managed_accounts",
    ["clerk_user_id", "connection_id"],
    async (w) => {
      for (const m of managed) await w.row([m.user, r.chance(0.98) ? m.c.id : null])
    },
  )
  await bulkRows(
    sql,
    "identity.identities",
    [
      "id",
      "tenant_id",
      "connection_id",
      "subject",
      "clerk_user_id",
      "email",
      "last_login_at",
    ],
    async (w) => {
      for (const m of managed)
        await w.row([
          r.uuid7(anchor),
          m.c.t.id,
          m.c.id,
          r.token(12),
          m.user,
          m.email,
          ago(anchor, r.int(0, 30) * DAY),
        ])
    },
  )
  await bulkRows(
    sql,
    "identity.sso_sessions",
    [
      "session_id",
      "tenant_id",
      "clerk_user_id",
      "connection_id",
      "auth_time",
      "bound_at",
      "fresh_at",
      "last_seen_at",
      "revoked_at",
    ],
    async (w) => {
      for (const m of managed) {
        if (!r.chance(0.5)) continue
        const at = ago(anchor, r.int(0, 14 * 24) * 3_600_000)
        await w.row([
          clerkId(r, "sess"),
          m.c.t.id,
          m.user,
          m.c.id,
          at,
          at,
          at,
          at,
          r.chance(0.2) ? anchor : null,
        ])
      }
    },
  )

  // Required domains: hosted, verified names of a required connection; a name is required once.
  const required = new Set<string>()
  await bulkRows(
    sql,
    "authd.required_domains",
    ["domain", "tenant_id", "connection_id"],
    async (w) => {
      for (const c of active) {
        if (!c.enforcement.startsWith("required")) continue
        for (const j of covered.get(c.id) ?? []) {
          if (required.has(j.d.name)) continue
          required.add(j.d.name)
          await w.row([j.d.name, c.t.id, c.id])
        }
      }
    },
  )
  await bulkRows(
    sql,
    "authd.required_exempt",
    ["connection_id", "tenant_id", "clerk_user_id", "source"],
    async (w) => {
      for (const c of active) {
        if (!c.enforcement.startsWith("required")) continue
        const seen = new Set<string>()
        for (const u of [c.t.owner, ...c.t.admins]) {
          if (seen.has(u)) continue
          seen.add(u)
          await w.row([c.id, c.t.id, u, "owner_exemption"])
        }
        for (const a of c.t.accounts.slice(0, r.int(0, 3)))
          if (!seen.has(a.clerkUserId))
            await w.row([c.id, c.t.id, a.clerkUserId, "bypass"])
      }
    },
  )
  await bulkRows(
    sql,
    "identity.workspace_settings",
    [
      "tenant_id",
      "deprovision",
      "owner_exemption",
      "leaver_action",
      "leaver_days",
      "require_second_factor",
      "ip_allowlist_console",
      "ip_allowlist_api_keys",
      "ip_ranges",
      "mailbox_creation",
    ],
    async (w) => {
      for (const t of tenants) {
        if (!(sso.includes(t) || (t.orgId && r.chance(0.05)))) continue
        const leaver = r.weighted([
          ["keep", 60],
          ["forward_manager", 20],
          ["delete_after", 20],
        ] as const)
        const allow = r.chance(0.1)
        await w.row([
          t.id,
          r.pick(["membership", "account"]),
          r.chance(0.7),
          leaver,
          leaver === "delete_after" ? r.pick([7, 30, 90]) : null,
          r.chance(0.3),
          allow,
          allow && r.chance(0.5),
          allow ? ["203.0.113.0/24", "198.51.100.7/32"] : [],
          r.pick(["admins", "members", "on_join"]),
        ])
      }
    },
  )
}

async function seedKeys(
  sql: Sql,
  r: Rng,
  p: Profile,
  tenants: Tenant[],
  weights: number[],
  anchor: Date,
) {
  const counts = apportion(
    p.apiKeys,
    weights.map((w) => w ** 0.7),
    0,
  )
  const keys: World["apiKeys"] = []
  await bulkRows(
    sql,
    "core.api_keys",
    [
      "id",
      "tenant_id",
      "name",
      "prefix",
      "mode",
      "created_at",
      "secret_hash",
      "scopes",
      "revoked_at",
      "expires_at",
      "last_used_at",
      "created_by",
    ],
    async (w) => {
      for (const t of tenants) {
        if (t.status === "deleted") continue
        for (let i = 0; i < counts[t.n]!; i++) {
          const at = ago(anchor, r.int(0, p.days) * DAY)
          const id = r.uuid7(at)
          const revoked = r.chance(0.2)
          const domain = t.domains.find((d) => d.status === "verified")
          const scopes =
            domain && r.chance(0.2)
              ? [`domain:${domain.name}`]
              : r.chance(0.5)
                ? ["emails:send"]
                : []
          if (!revoked) keys.push({ id, tenantId: t.id })
          await w.row([
            id,
            t.id,
            r.chance(0.1) ? personName(r) || "key" : `key ${i}`,
            `i10_${r.chance(0.9) ? "live" : "test"}_`,
            r.chance(0.9) ? "live" : "test",
            at,
            r.token(32),
            scopes,
            revoked ? anchor : null,
            r.chance(0.05) ? ago(anchor, -r.int(-30, 365) * DAY) : null,
            r.chance(0.7) ? ago(anchor, r.int(0, 3600) * 1000) : null,
            r.chance(0.8) ? r.pick(t.members) : null,
          ])
        }
      }
    },
  )
  return keys
}

async function seedPlans(
  sql: Sql,
  r: Rng,
  tenants: Tenant[],
  anchor: Date,
): Promise<void> {
  const [pro] = await sql<
    { entitlements: unknown }[]
  >`select entitlements from core.plans where id = 'pro'`
  await bulkRows(
    sql,
    "core.plans",
    [
      "id",
      "source",
      "tenant_id",
      "name",
      "entitlements",
      "rank",
      "retention_days",
      "member_limit",
    ],
    async (w) => {
      for (const t of tenants)
        if (t.plan.startsWith("custom"))
          await w.row([
            t.plan,
            "custom",
            t.id,
            `Custom ${t.n}`,
            JSON.stringify(pro!.entitlements),
            20,
            90,
            10_000,
          ])
    },
  )
  const live = tenants.filter((t) => t.status !== "deleted")
  await bulkRows(
    sql,
    "core.plan_assignments",
    [
      "tenant_id",
      "plan_id",
      "anchor",
      "assigned_at",
      "updated_at",
      "overage_enabled",
      "plan_since",
    ],
    async (w) => {
      for (const t of live)
        await w.row([
          t.id,
          t.plan,
          t.createdAt,
          t.createdAt,
          t.createdAt,
          t.plan !== "free" && r.chance(0.5),
          t.createdAt,
        ])
    },
  )
  await bulkRows(
    sql,
    "core.subscriptions",
    [
      "tenant_id",
      "polar_subscription_id",
      "polar_customer_id",
      "polar_product_id",
      "plan_id",
      "status",
      "cancel_at_period_end",
      "current_period_end",
      "event_at",
      "granted_plan_id",
      "granted_at",
    ],
    async (w) => {
      for (const t of live) {
        if (t.plan === "free") continue
        const status = r.weighted([
          ["active", 90],
          ["past_due", 5],
          ["canceled", 5],
        ] as const)
        await w.row([
          t.id,
          `sub_${r.token(12)}`,
          `cus_${r.token(12)}`,
          `prod_${r.token(6)}`,
          t.plan,
          status,
          r.chance(0.05),
          new Date(anchor.getTime() + r.int(1, 30) * DAY),
          anchor,
          t.plan,
          t.createdAt,
        ])
      }
    },
  )
  await bulkRows(
    sql,
    "core.tenant_storage",
    ["tenant_id", "bytes", "sampled_at"],
    async (w) => {
      for (const t of live)
        await w.row([t.id, Math.floor(r.next() ** 4 * 5e11), anchor])
    },
  )
  await bulkRows(
    sql,
    "core.risk_assessments",
    ["tenant_id", "score", "band", "ruleset_version", "contributions", "computed_at"],
    async (w) => {
      for (const t of live) {
        if (!r.chance(0.7)) continue
        const band = r.weighted([
          ["low", 85],
          ["elevated", 10],
          ["high", 4],
          ["critical", 1],
        ] as const)
        await w.row([
          t.id,
          band === "low" ? r.int(0, 30) : r.int(31, 100),
          band,
          7,
          "[]",
          ago(anchor, r.int(0, 86_400) * 1000),
        ])
      }
    },
  )
  await bulkRows(
    sql,
    "core.sending_tiers",
    ["tenant_id", "tier", "source", "reason", "set_by"],
    async (w) => {
      for (const t of live)
        if (t.plan === "free" && r.chance(0.3))
          await w.row([t.id, r.pick(["strict", "normal"]), "auto", "seed", "system"])
    },
  )
  await bulkRows(
    sql,
    "core.sending_holds",
    [
      "tenant_id",
      "scope",
      "source",
      "reason",
      "category",
      "set_by",
      "held_at",
      "review_due_at",
    ],
    async (w) => {
      for (const t of live)
        if (t.n > 0 && r.chance(0.005))
          await w.row([
            t.id,
            r.pick(["api", "all"]),
            "risk",
            "seed",
            "spam",
            "system",
            anchor,
            new Date(anchor.getTime() + DAY),
          ])
    },
  )
}

async function seedEndpoints(
  sql: Sql,
  r: Rng,
  p: Profile,
  tenants: Tenant[],
  weights: number[],
  anchor: Date,
) {
  const counts = apportion(
    p.webhookEndpoints,
    weights.map((w) => w ** 0.6),
    0,
  )
  const out: World["endpoints"] = []
  const ALL = [
    "email.sent",
    "email.delivered",
    "email.bounced",
    "email.complained",
    "email.opened",
    "email.clicked",
  ]
  await bulkRows(
    sql,
    "core.webhook_endpoints",
    [
      "id",
      "tenant_id",
      "url",
      "description",
      "secret_ciphertext",
      "events",
      "enabled",
      "disabled_at",
      "created_at",
      "updated_at",
      "kind",
      "health",
      "failing_since",
      "next_sequence",
      "poll_cursor",
    ],
    async (w) => {
      for (const t of tenants) {
        if (t.status === "deleted") continue
        for (let i = 0; i < counts[t.n]!; i++) {
          const at = ago(anchor, r.int(0, p.days) * DAY)
          const kind = r.weighted([
            ["http", 92],
            ["polling", 5],
            ["sqs", 3],
          ] as const)
          const health = r.weighted([
            ["healthy", 90],
            ["failing", 7],
            ["disabled", 3],
          ] as const)
          const e = { id: r.uuid7(at), tenantId: t.id, kind, ordered: r.chance(0.2) }
          if (health !== "disabled") out.push(e)
          await w.row([
            e.id,
            t.id,
            kind === "polling"
              ? null
              : `https://hooks.${r.pick(t.domains)?.name ?? "example.test"}/i10/${i}`,
            r.chance(0.3) ? personName(r) : null,
            `v1.${r.token(24)}`,
            r.chance(0.5) ? ALL : ALL.slice(0, r.int(1, 4)),
            health !== "disabled",
            health === "disabled" ? anchor : null,
            at,
            at,
            kind,
            health,
            health === "failing" ? ago(anchor, r.int(1, 48) * 3_600_000) : null,
            1,
            0,
          ])
        }
      }
    },
  )
  return out
}
