import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { directoryUsers } from "../db/identity.js"
import { aliases, mailboxUsage } from "../db/schema.js"
import { can, type RoleStore } from "../console/roles.js"
import { passthroughFor } from "../identity/ldap.js"
import type { IdentityStore } from "../identity/ports.js"
import type { StoragePool } from "./allocation.js"

/**
 * Workspace mailbox list and detail for the console (Step B5).
 *
 * ⚠ VISIBILITY IS ENFORCED HERE AND IN THE SQL WHERE CLAUSE. Owners and admins
 * (`members:manage` in `console/roles.ts`) see every mailbox in the workspace;
 * everyone else sees only their own (`clerk_user_id = viewer.userId`). Asking
 * for another person's address as a member returns `null` so the route answers
 * 404 rather than 403 and never reveals whether the address exists.
 *
 * ⚠ `authd` HAS NO ROW LEVEL SECURITY. Every query against `authd.accounts`
 * carries `workspaceMailboxPredicate(tenantId)` - matching `mailbox-hosting.ts`
 * by domain and `tenant_id` (`tenant_id = tenantId` on a domain no other
 * workspace hosts, or `tenant_id is null` on a domain this workspace currently
 * hosts). `core.mailbox_usage` has RLS and is read inside `withTenant`.
 */

export const MAILBOX_STATUSES = [
  "deleting",
  "suspended",
  "payment_hold",
  "domain_off",
  "banned",
  "locked",
  "sso_required",
  "inactive",
  "active",
] as const

export type MailboxStatus = (typeof MAILBOX_STATUSES)[number]

export type MailboxSignInLane = "password" | "oidc" | "ldap" | "off"

export interface MailboxStatusInput {
  /** Reserved slot for mailbox deletion (later step); never produced yet. */
  deleting?: boolean | undefined
  /** `authd.accounts.suspended_at is not null` */
  suspended: boolean
  /** `authd.accounts.payment_hold_at is not null` */
  paymentHold: boolean
  /** `core.mailbox_domain_refused(tenant_id, domain)` */
  domainOff: boolean
  /** `authd.accounts.banned` */
  banned: boolean
  /** `authd.accounts.locked and (locked_until is null or locked_until > now())` */
  locked: boolean
  /** Resolved sign-in lane (`"off"` when managed with pass-through lane off). */
  signIn: MailboxSignInLane
  /** Whether the domain requires SSO in this workspace (`authd.required_domains`). */
  ssoRequired?: boolean | undefined
  /** Whether the account is exempt from required SSO (`authd.required_exempt`). */
  ssoExempt?: boolean | undefined
  /** `authd.accounts.active` (false when created in Clerk but no mailbox yet). */
  active: boolean
}

/**
 * Pure status derivation for a workspace mailbox, first match wins.
 *
 * The order matches what `services/authd/internal/ldapsrv/bind.go` refuses:
 * 1. `deleting` - reserved slot at the top for mailbox deletion.
 * 2. `suspended` - checked in `handleBind` (`bind.go:105`) before `refusedByRow`.
 * 3. `payment_hold` - `refusedByRow` case 1 (`bind.go:210`).
 * 4. `domain_off` - `refusedByRow` case 2 (`bind.go:212`, `DomainNotHosted`).
 * 5. `banned` - `refusedByRow` case 3 (`bind.go:214`).
 * 6. `locked` - `refusedByRow` case 4 (`bind.go:216`).
 * 7. `sso_required` - verifier resolution (`bind.go:133`, `passthrough/verifier.go`):
 *    managed account with pass-through lane `"off"`, or unmanaged on a required
 *    domain without exemption.
 * 8. `inactive` - `active = false` (created in Clerk, no mailbox provisioned yet).
 * 9. `active` - can sign in and receive mail.
 */
export function deriveMailboxStatus(input: MailboxStatusInput): MailboxStatus {
  if (input.deleting) return "deleting"
  if (input.suspended) return "suspended"
  if (input.paymentHold) return "payment_hold"
  if (input.domainOff) return "domain_off"
  if (input.banned) return "banned"
  if (input.locked) return "locked"
  if (input.signIn === "off" || Boolean(input.ssoRequired && !input.ssoExempt)) {
    return "sso_required"
  }
  if (!input.active) return "inactive"
  return "active"
}

export type PassthroughIdentityStore = Pick<
  IdentityStore,
  "connectionForStart" | "connectionSecrets" | "liveDomains"
>

/**
 * Resolves the mail sign-in lane for an account:
 * - `"password"` for unmanaged (Clerk) accounts
 * - `"oidc"` / `"ldap"` / `"off"` for managed accounts via `passthroughFor`
 */
export async function laneForConnection(
  identity: PassthroughIdentityStore | undefined,
  connectionId: string | null | undefined,
  managed = true,
): Promise<MailboxSignInLane> {
  if (!managed) return "password"
  if (!connectionId || !identity) return "off"
  const answer = await passthroughFor(identity, connectionId)
  return answer.enabled ? answer.lane : "off"
}

export interface ConsoleMailboxAlias {
  address: string
  source: "clerk" | "directory"
}

export interface ConsoleMailboxOwner {
  userId: string
  clerkUserId: string
  name: string | null
  email: string | null
}

export interface ConsoleMailboxStorage {
  allocatedBytes: number | null
  usedBytes: number | null
  usedAt: string | null
}

export interface ConsoleMailbox {
  address: string
  displayName: string | null
  owner: ConsoleMailboxOwner
  domain: string
  status: MailboxStatus
  signIn: MailboxSignInLane
  aliases: ConsoleMailboxAlias[]
  storage: ConsoleMailboxStorage
  createdAt: string
  updatedAt: string
}

export interface StoredConsoleMailboxRow {
  clerkUserId: string
  address: string
  displayName: string | null
  ownerName: string | null
  ownerEmail: string | null
  active: boolean
  suspended: boolean
  paymentHold: boolean
  domainOff: boolean
  banned: boolean
  locked: boolean
  managed: boolean
  connectionId: string | null
  ssoRequired: boolean
  ssoExempt: boolean
  allocatedBytes: number | null
  usedBytes: number | null
  usedAt: Date | null
  aliases: ConsoleMailboxAlias[]
  createdAt: Date
  updatedAt: Date
}

export interface MailboxPageCursor {
  createdAt: string
  address: string
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export function clampMailboxLimit(limit?: number): number {
  if (limit === undefined || Number.isNaN(limit)) return DEFAULT_LIMIT
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_LIMIT)
}

export function encodeMailboxCursor(cursor: MailboxPageCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.address}`, "utf8").toString(
    "base64url",
  )
}

export function decodeMailboxCursor(raw?: string): MailboxPageCursor | null {
  if (!raw) return null
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8")
    const sep = decoded.indexOf("|")
    if (sep <= 0 || sep === decoded.length - 1) return null
    const createdAt = decoded.slice(0, sep)
    const address = decoded.slice(sep + 1)
    if (Number.isNaN(Date.parse(createdAt)) || !address) return null
    return { createdAt, address }
  } catch {
    return null
  }
}

export interface ConsoleMailboxStore {
  list(input: {
    tenantId: string
    onlyUserId?: string | undefined
    limit: number
    cursor?: MailboxPageCursor | null | undefined
  }): Promise<StoredConsoleMailboxRow[]>
  get(input: {
    tenantId: string
    address: string
    onlyUserId?: string | undefined
  }): Promise<StoredConsoleMailboxRow | null>
}

interface RawAccountRow extends Record<string, unknown> {
  clerk_user_id: string
  email: string
  display_name: string | null
  active: boolean
  storage_allocation: string | number | null
  suspended: boolean
  payment_hold: boolean
  domain_off: boolean
  banned: boolean
  locked: boolean
  managed: boolean
  connection_id: string | null
  sso_required: boolean
  sso_exempt: boolean
  created_at: Date | string
  updated_at: Date | string
}

/**
 * The SQL predicate that scopes `authd.accounts a` to a single workspace.
 *
 * Matches `domains/mailbox-hosting.ts` and `mailboxes/store.ts`:
 * - accounts with `a.tenant_id = tenantId` on a domain no other workspace hosts
 *   (including domains where this workspace switched `hosts_mailboxes` off, so
 *   they surface with `status: "domain_off"`), or
 * - legacy `a.tenant_id is null` accounts ONLY on a domain this workspace
 *   currently hosts (`core.mailbox_domain_settings()`).
 */
export const workspaceMailboxPredicate = (tenantId: string): SQL => sql`(
  (
    a.tenant_id = ${tenantId}::uuid
    and lower(split_part(a.email, '@', 2)) not in (
      select lower(name)
        from core.mailbox_domain_settings()
       where tenant_id is not null
         and tenant_id <> ${tenantId}::uuid
    )
  )
  or (
    a.tenant_id is null
    and lower(split_part(a.email, '@', 2)) in (
      select lower(name)
        from core.mailbox_domain_settings()
       where tenant_id = ${tenantId}::uuid
    )
  )
)`

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value)

export function consoleMailboxStore(db: Database): ConsoleMailboxStore {
  async function hydrate(
    tenantId: string,
    rawRows: RawAccountRow[],
  ): Promise<StoredConsoleMailboxRow[]> {
    if (rawRows.length === 0) return []

    const clerkUserIds = [...new Set(rawRows.map((r) => r.clerk_user_id))]
    const addresses = [...new Set(rawRows.map((r) => r.email.toLowerCase()))]

    const [aliasRows, tenantScoped] = await Promise.all([
      db
        .select({
          clerkUserId: aliases.clerkUserId,
          address: aliases.address,
          source: aliases.source,
        })
        .from(aliases)
        .where(inArray(aliases.clerkUserId, clerkUserIds))
        .orderBy(asc(aliases.address)),
      withTenant(db, tenantId, async (tx) => {
        const [usageRows, dirUsers] = await Promise.all([
          tx
            .select({
              address: mailboxUsage.address,
              usedBytes: mailboxUsage.usedBytes,
              sampledAt: mailboxUsage.sampledAt,
            })
            .from(mailboxUsage)
            .where(
              and(
                eq(mailboxUsage.tenantId, tenantId),
                inArray(mailboxUsage.address, addresses),
              ),
            ),
          tx
            .select({
              clerkUserId: directoryUsers.clerkUserId,
              displayName: directoryUsers.displayName,
              email: directoryUsers.email,
            })
            .from(directoryUsers)
            .where(
              and(
                eq(directoryUsers.tenantId, tenantId),
                inArray(directoryUsers.clerkUserId, clerkUserIds),
              ),
            ),
        ])
        return { usageRows, dirUsers }
      }),
    ])

    const aliasesByUser = new Map<string, ConsoleMailboxAlias[]>()
    for (const row of aliasRows) {
      const source: ConsoleMailboxAlias["source"] =
        row.source === "directory" ? "directory" : "clerk"
      const list = aliasesByUser.get(row.clerkUserId)
      if (list) list.push({ address: row.address, source })
      else aliasesByUser.set(row.clerkUserId, [{ address: row.address, source }])
    }

    const usageByAddress = new Map<string, { usedBytes: number; sampledAt: Date }>()
    for (const row of tenantScoped.usageRows) {
      usageByAddress.set(row.address.toLowerCase(), {
        usedBytes: Number(row.usedBytes),
        sampledAt: row.sampledAt,
      })
    }

    const dirUserByClerkId = new Map<
      string,
      { displayName: string | null; email: string | null }
    >()
    for (const row of tenantScoped.dirUsers) {
      if (row.clerkUserId && !dirUserByClerkId.has(row.clerkUserId)) {
        dirUserByClerkId.set(row.clerkUserId, {
          displayName: row.displayName,
          email: row.email,
        })
      }
    }

    return rawRows.map((row) => {
      const address = row.email.toLowerCase()
      const usage = usageByAddress.get(address)
      const dirUser = dirUserByClerkId.get(row.clerk_user_id)
      const displayName = row.display_name ?? null
      return {
        clerkUserId: row.clerk_user_id,
        address,
        displayName,
        ownerName: displayName ?? dirUser?.displayName ?? null,
        ownerEmail: dirUser?.email ?? address,
        active: Boolean(row.active),
        suspended: Boolean(row.suspended),
        paymentHold: Boolean(row.payment_hold),
        domainOff: Boolean(row.domain_off),
        banned: Boolean(row.banned),
        locked: Boolean(row.locked),
        managed: Boolean(row.managed),
        connectionId: row.connection_id ?? null,
        ssoRequired: Boolean(row.sso_required),
        ssoExempt: Boolean(row.sso_exempt),
        allocatedBytes:
          row.storage_allocation === null || row.storage_allocation === undefined
            ? null
            : Number(row.storage_allocation),
        usedBytes: usage ? usage.usedBytes : null,
        usedAt: usage ? usage.sampledAt : null,
        aliases: aliasesByUser.get(row.clerk_user_id) ?? [],
        createdAt: toDate(row.created_at),
        updatedAt: toDate(row.updated_at),
      }
    })
  }

  const selectColumns = (tenantId: string): SQL => sql`
    select a.clerk_user_id,
           lower(a.email) as email,
           a.display_name,
           a.active,
           a.storage_allocation,
           (a.suspended_at is not null) as suspended,
           (a.payment_hold_at is not null) as payment_hold,
           core.mailbox_domain_refused(a.tenant_id, lower(split_part(a.email, '@', 2))) as domain_off,
           a.banned,
           (a.locked and (a.locked_until is null or a.locked_until > now())) as locked,
           (m.clerk_user_id is not null) as managed,
           m.connection_id::text as connection_id,
           exists (
             select 1
               from authd.required_domains rd
              where rd.domain = lower(split_part(a.email, '@', 2))
                and rd.tenant_id = ${tenantId}::uuid
           ) as sso_required,
           exists (
             select 1
               from authd.required_domains rd
               join authd.required_exempt ex
                 on ex.connection_id = rd.connection_id
                and ex.tenant_id = rd.tenant_id
              where rd.domain = lower(split_part(a.email, '@', 2))
                and rd.tenant_id = ${tenantId}::uuid
                and ex.clerk_user_id = a.clerk_user_id
           ) as sso_exempt,
           a.created_at,
           a.updated_at
      from authd.accounts a
      left join authd.managed_accounts m on m.clerk_user_id = a.clerk_user_id
  `

  return {
    async list({ tenantId, onlyUserId, limit, cursor }) {
      const userClause = onlyUserId ? sql`and a.clerk_user_id = ${onlyUserId}` : sql``
      const cursorClause = cursor
        ? sql`and (a.created_at, lower(a.email)) < (${cursor.createdAt}::timestamptz, ${cursor.address.toLowerCase()})`
        : sql``

      const rows = (await db.execute(sql`
        ${selectColumns(tenantId)}
        where ${workspaceMailboxPredicate(tenantId)}
          ${userClause}
          ${cursorClause}
        order by a.created_at desc, lower(a.email) desc
        limit ${limit}
      `)) as unknown as RawAccountRow[]

      return hydrate(tenantId, rows)
    },

    async get({ tenantId, address, onlyUserId }) {
      const wanted = address.trim().toLowerCase()
      const userClause = onlyUserId ? sql`and a.clerk_user_id = ${onlyUserId}` : sql``

      const rows = (await db.execute(sql`
        ${selectColumns(tenantId)}
        where ${workspaceMailboxPredicate(tenantId)}
          and lower(a.email) = ${wanted}
          ${userClause}
        limit 1
      `)) as unknown as RawAccountRow[]

      const hydrated = await hydrate(tenantId, rows)
      return hydrated[0] ?? null
    },
  }
}

export interface ConsoleMailboxViewer {
  tenantId: string
  userId: string
  orgId?: string | undefined
  isAdmin?: boolean | undefined
}

export interface ConsoleMailboxListOptions {
  limit?: number | undefined
  cursor?: string | undefined
}

export interface ConsoleMailboxListResult {
  data: ConsoleMailbox[]
  pool: StoragePool
  nextCursor: string | null
}

export interface ConsoleMailboxes {
  list(
    viewer: ConsoleMailboxViewer,
    options?: ConsoleMailboxListOptions,
  ): Promise<ConsoleMailboxListResult>
  get(viewer: ConsoleMailboxViewer, address: string): Promise<ConsoleMailbox | null>
}

export interface ConsoleMailboxDeps {
  store: ConsoleMailboxStore
  /** Workspace storage pool summary (`mailboxStorage.overview(tenantId)`). */
  pool: (tenantId: string) => Promise<StoragePool>
  /** Whether the caller holds `members:manage` in this workspace. */
  isAdmin?: ((tenantId: string, userId: string) => Promise<boolean>) | undefined
  /** RoleStore for `can(roles, tenantId, userId, "members:manage")`. */
  roles?: Pick<RoleStore, "roleOf"> | undefined
  /** Connection reader for `laneForConnection` (`passthroughFor`). */
  identity?: PassthroughIdentityStore | undefined
}

const domainOf = (address: string): string =>
  address.slice(address.lastIndexOf("@") + 1).toLowerCase()

export function consoleMailboxes(deps: ConsoleMailboxDeps): ConsoleMailboxes {
  async function viewerIsAdmin(viewer: ConsoleMailboxViewer): Promise<boolean> {
    if (viewer.isAdmin !== undefined) return viewer.isAdmin
    if (deps.isAdmin) return deps.isAdmin(viewer.tenantId, viewer.userId)
    if (deps.roles) {
      return can(deps.roles, viewer.tenantId, viewer.userId, "members:manage")
    }
    return false
  }

  async function toConsoleMailbox(
    row: StoredConsoleMailboxRow,
    laneCache: Map<string, Promise<MailboxSignInLane>>,
  ): Promise<ConsoleMailbox> {
    let signIn: MailboxSignInLane
    if (!row.managed) {
      signIn = "password"
    } else if (!row.connectionId) {
      signIn = "off"
    } else {
      let pending = laneCache.get(row.connectionId)
      if (!pending) {
        pending = laneForConnection(deps.identity, row.connectionId, true)
        laneCache.set(row.connectionId, pending)
      }
      signIn = await pending
    }

    const status = deriveMailboxStatus({
      suspended: row.suspended,
      paymentHold: row.paymentHold,
      domainOff: row.domainOff,
      banned: row.banned,
      locked: row.locked,
      signIn,
      ssoRequired: row.ssoRequired,
      ssoExempt: row.ssoExempt,
      active: row.active,
    })

    const address = row.address.toLowerCase()
    return {
      address,
      displayName: row.displayName,
      owner: {
        userId: row.clerkUserId,
        clerkUserId: row.clerkUserId,
        name: row.ownerName,
        email: row.ownerEmail,
      },
      domain: domainOf(address),
      status,
      signIn,
      aliases: row.aliases,
      storage: {
        allocatedBytes: row.allocatedBytes,
        usedBytes: row.usedBytes,
        usedAt: row.usedAt ? row.usedAt.toISOString() : null,
      },
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  return {
    async list(viewer, options = {}) {
      const admin = await viewerIsAdmin(viewer)
      const limit = clampMailboxLimit(options.limit)
      const cursor = decodeMailboxCursor(options.cursor)

      const [rows, pool] = await Promise.all([
        deps.store.list({
          tenantId: viewer.tenantId,
          onlyUserId: admin ? undefined : viewer.userId,
          limit: limit + 1,
          cursor,
        }),
        deps.pool(viewer.tenantId),
      ])

      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const last = page[page.length - 1]
      const nextCursor =
        hasMore && last
          ? encodeMailboxCursor({
              createdAt: last.createdAt.toISOString(),
              address: last.address,
            })
          : null

      const laneCache = new Map<string, Promise<MailboxSignInLane>>()
      const data = await Promise.all(
        page.map((row) => toConsoleMailbox(row, laneCache)),
      )

      return { data, pool, nextCursor }
    },

    async get(viewer, address) {
      const admin = await viewerIsAdmin(viewer)
      const row = await deps.store.get({
        tenantId: viewer.tenantId,
        address,
        onlyUserId: admin ? undefined : viewer.userId,
      })
      if (!row) return null
      if (!admin && row.clerkUserId !== viewer.userId) return null

      const laneCache = new Map<string, Promise<MailboxSignInLane>>()
      return toConsoleMailbox(row, laneCache)
    },
  }
}
