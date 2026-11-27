import { timingSafeEqual } from "node:crypto"
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm"
import { ts, type Database } from "../db/client.js"
import { accounts, mailDevices } from "../db/schema.js"
import { raiseConnectionCredentialEpochs } from "../projection/connection-epoch.js"
import { raiseCredentialEpoch } from "../projection/credential-epoch.js"
import { MailDeviceError, mintCode, type MailDeviceCodeKeys } from "./code.js"

/**
 * The one store for `authd.mail_devices` (#383).
 *
 * Every API read or write of `authd.mail_devices` goes through this module.
 * `authd` has no row-level security (authd and the mail front read across
 * workspaces), so the tenant filter in `mint` and `endFor`, and the
 * `DeviceScope` of `listDevices`, `revoke` and `revokeAllFor`, IS the tenant
 * boundary.
 *
 * Lock order across every revocation, mint and key write:
 *   1. `authd.accounts` first
 *   2. `authd.mail_devices` second
 *   3. then `authd.mail_device_cert_permits` (permits.ts) and
 *      `authd.mail_device_cert_binds`, the rows that hang off a device
 *
 * `mint` locks the account row (`FOR NO KEY UPDATE OF a`) and checks the gate
 * and `expectedEpoch` before inserting; every revocation writes `authd.accounts`
 * in the same transaction before calling `endFor`. So a mint either commits
 * first (and its device is deleted by the revocation) or waits on the account
 * lock and sees the hold or moved epoch and refuses. `revokeAllFor` locks the
 * account the same way before its DELETE. A single `revoke` takes no account
 * lock: it names one existing row, so no mint can race it, and it holds
 * nothing before the device row.
 */

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

export const MAIL_DEVICE_PLATFORMS = ["ios", "ipados", "macos"] as const
export type MailDevicePlatform = (typeof MAIL_DEVICE_PLATFORMS)[number]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Public columns of one device row. Never carries `codeHash`, `codeKid` or the
 * certificate key's hash: only whether a key is bound.
 */
export interface MailDeviceRow {
  id: string
  clerkUserId: string
  email: string
  tenantId: string | null
  platform: MailDevicePlatform
  deviceName: string | null
  model: string | null
  serial: string | null
  createdBy: string
  createdAt: Date
  firstUsedAt: Date | null
  lastUsedAt: Date | null
  hasCertKey: boolean
}

const deviceColumns = {
  id: mailDevices.id,
  clerkUserId: mailDevices.clerkUserId,
  email: mailDevices.email,
  tenantId: mailDevices.tenantId,
  platform: mailDevices.platform,
  deviceName: mailDevices.deviceName,
  model: mailDevices.model,
  serial: mailDevices.serial,
  createdBy: mailDevices.createdBy,
  createdAt: mailDevices.createdAt,
  firstUsedAt: mailDevices.firstUsedAt,
  lastUsedAt: mailDevices.lastUsedAt,
  hasCertKey: sql<boolean>`(${mailDevices.certKeySha256} is not null)`.as(
    "has_cert_key",
  ),
}

const toRow = (
  row: Omit<MailDeviceRow, "platform"> & { platform: string },
): MailDeviceRow => ({
  id: row.id,
  clerkUserId: row.clerkUserId,
  email: row.email,
  tenantId: row.tenantId,
  platform: row.platform as MailDevicePlatform,
  deviceName: row.deviceName,
  model: row.model,
  serial: row.serial,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  firstUsedAt: row.firstUsedAt,
  lastUsedAt: row.lastUsedAt,
  hasCertKey: row.hasCertKey,
})

const tenantMatches = (tenantId: string | null) =>
  tenantId === null ? isNull(mailDevices.tenantId) : eq(mailDevices.tenantId, tenantId)

export interface MintInput {
  clerkUserId: string
  tenantId: string | null
  expectedEpoch: number
  platform: MailDevicePlatform
  deviceName?: string | null
  model?: string | null
  serial?: string | null
  createdBy: string
}

export interface MintResult {
  device: MailDeviceRow
  /** Returned once to the caller, never stored or logged. */
  code: string
}

export interface MintGateAccount {
  clerk_user_id: string
  email: string
  active: boolean
  tenant_id: string | null
  credential_epoch: string | number
  suspended: boolean
  payment_hold: boolean
  deleting: boolean
  banned: boolean
  locked: boolean
  domain_not_hosted: boolean
  managed: boolean
  managed_connection: string | null
  connection_inactive: boolean
  sso_required: boolean
  sso_exempt: boolean
}

interface AccountGateRow extends MintGateAccount {
  next_device_id: string
}

/**
 * Pure gate decision for `mint`: checks tenant boundary, active flag, expected
 * credential epoch, and every account/route hold in the same order as authd's
 * `gate.RowRefusal` and `gate.RouteOf`. Returns the `MailDeviceError` refusal,
 * or `null` when minting is allowed.
 */
export function mintRefusal(
  account: MintGateAccount | null | undefined,
  input: Pick<MintInput, "tenantId" | "expectedEpoch">,
): MailDeviceError | null {
  if (!account) {
    return new MailDeviceError("account_not_found", "Mailbox account not found.")
  }
  // Check workspace before revealing any hold or epoch state.
  if ((account.tenant_id ?? null) !== (input.tenantId ?? null)) {
    return new MailDeviceError(
      "tenant_mismatch",
      "Account does not belong to this workspace.",
    )
  }
  if (!account.active) {
    return new MailDeviceError("account_inactive", "Mailbox account is not active.")
  }
  if (Number(account.credential_epoch) !== input.expectedEpoch) {
    return new MailDeviceError(
      "epoch_mismatch",
      "Account credential epoch changed; re-authenticate and retry.",
    )
  }
  return holdRefusal(account)
}

/**
 * The gate for binding a certificate key (#383 PR 3): `mintRefusal` without the
 * epoch, which the CA's webhooks have no caller to read. The account must still
 * be the device's workspace, active, and free of every hold.
 */
export function bindRefusal(
  account: MintGateAccount | null | undefined,
  tenantId: string | null,
): MailDeviceError | null {
  if (!account) {
    return new MailDeviceError("account_not_found", "Mailbox account not found.")
  }
  if ((account.tenant_id ?? null) !== (tenantId ?? null)) {
    return new MailDeviceError(
      "tenant_mismatch",
      "Account does not belong to this workspace.",
    )
  }
  if (!account.active) {
    return new MailDeviceError("account_inactive", "Mailbox account is not active.")
  }
  return holdRefusal(account)
}

/** Every hold and route refusal, in `gate.RowRefusal` then `gate.RouteOf` order. */
function holdRefusal(account: MintGateAccount): MailDeviceError | null {
  if (account.suspended) {
    return new MailDeviceError("mailbox_suspended", "Mailbox is suspended.")
  }
  if (account.deleting) {
    return new MailDeviceError("mailbox_deleting", "Mailbox is scheduled for deletion.")
  }
  if (account.payment_hold) {
    return new MailDeviceError("payment_hold", "Workspace is on payment hold.")
  }
  if (account.domain_not_hosted) {
    return new MailDeviceError("domain_not_hosted", "Domain is not hosting mailboxes.")
  }
  if (account.banned) {
    return new MailDeviceError("account_banned", "Account is banned.")
  }
  if (account.locked) {
    return new MailDeviceError("account_locked", "Account is locked.")
  }
  if (!account.managed && account.sso_required && !account.sso_exempt) {
    return new MailDeviceError(
      "sso_required",
      "SSO sign-in is required for this domain.",
    )
  }
  if (account.managed && !account.managed_connection) {
    return new MailDeviceError(
      "managed_no_connection",
      "Managed account has no SSO connection.",
    )
  }
  if (account.managed && account.connection_inactive) {
    return new MailDeviceError("connection_inactive", "SSO connection is not active.")
  }
  return null
}

/**
 * Mints one mail device code inside a caller-owned transaction (#383 PR 4),
 * refusing when the key ring is absent, the platform is unsupported, the
 * account is missing/inactive, its tenant or epoch moved, or any gate hold
 * applies.
 *
 * The device id is generated by Postgres (`uuidv7()`) inside the transaction,
 * never supplied by a caller, so a deleted device can never reappear under its
 * old id.
 */
export async function mintInTx(
  tx: Pick<Database, "execute">,
  keys: MailDeviceCodeKeys | null | undefined,
  input: MintInput,
): Promise<MintResult> {
  if (!keys || !keys.keys.has(keys.currentKid)) {
    throw new MailDeviceError(
      "keys_not_configured",
      "MAIL_DEVICE_CODE_KEYS is not configured.",
    )
  }
  if (!(MAIL_DEVICE_PLATFORMS as readonly string[]).includes(input.platform)) {
    throw new MailDeviceError(
      "invalid_platform",
      `Unsupported mail device platform: ${String(input.platform)}`,
    )
  }

  // ⚠ LOCK `authd.accounts` FIRST (`FOR NO KEY UPDATE OF a`) so a concurrent
  // revocation either commits before us (and we see the hold or moved epoch
  // and refuse) or waits for us (and deletes the row we insert).
  const [account] = await lockGateAccount<AccountGateRow>(
    tx,
    input.clerkUserId,
    sql`, uuidv7()::text as next_device_id`,
  )
  const refusal = mintRefusal(account, input)
  if (refusal) throw refusal

  const allowed = account!
  const minted = mintCode(keys, allowed.next_device_id)
  const [inserted] = (await tx.execute(sql`
    insert into authd.mail_devices (
      id, clerk_user_id, email, tenant_id, platform, device_name, model,
      serial, code_hash, code_kid, created_by
    )
    values (
      ${allowed.next_device_id}::uuid,
      ${allowed.clerk_user_id},
      ${allowed.email.toLowerCase()},
      ${allowed.tenant_id ?? null}::uuid,
      ${input.platform},
      ${input.deviceName ?? null},
      ${input.model ?? null},
      ${input.serial ?? null},
      ${minted.codeHash},
      ${minted.codeKid},
      ${input.createdBy}
    )
    returning id::text as id,
              clerk_user_id as "clerkUserId",
              email,
              tenant_id::text as "tenantId",
              platform,
              device_name as "deviceName",
              model,
              serial,
              created_by as "createdBy",
              created_at as "createdAt",
              first_used_at as "firstUsedAt",
              last_used_at as "lastUsedAt",
              cert_key_sha256 is not null as "hasCertKey"
  `)) as unknown as {
    id: string
    clerkUserId: string
    email: string
    tenantId: string | null
    platform: string
    deviceName: string | null
    model: string | null
    serial: string | null
    createdBy: string
    createdAt: Date | string
    firstUsedAt: Date | string | null
    lastUsedAt: Date | string | null
    hasCertKey: boolean
  }[]

  const row = inserted!
  return {
    device: toRow({
      ...row,
      createdAt: new Date(row.createdAt),
      firstUsedAt: row.firstUsedAt ? new Date(row.firstUsedAt) : null,
      lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt) : null,
    }),
    code: minted.code,
  }
}

/**
 * Mints one mail device code for an account, refusing when the key ring is
 * absent, the account is missing/inactive, its tenant or epoch moved, or any
 * gate hold applies.
 *
 * The device id is generated by Postgres (`uuidv7()`) inside the transaction,
 * never supplied by a caller, so a deleted device can never reappear under its
 * old id.
 */
export async function mint(
  db: Pick<Database, "transaction">,
  keys: MailDeviceCodeKeys | null | undefined,
  input: MintInput,
): Promise<MintResult> {
  if (!keys || !keys.keys.has(keys.currentKid)) {
    throw new MailDeviceError(
      "keys_not_configured",
      "MAIL_DEVICE_CODE_KEYS is not configured.",
    )
  }
  if (!(MAIL_DEVICE_PLATFORMS as readonly string[]).includes(input.platform)) {
    throw new MailDeviceError(
      "invalid_platform",
      `Unsupported mail device platform: ${String(input.platform)}`,
    )
  }

  return db.transaction((tx) => mintInTx(tx, keys, input))
}

/**
 * Locks one account row (`FOR NO KEY UPDATE OF a`, the first lock of every
 * device write) and reads everything the gate decides on. `extra` appends
 * columns to the select list.
 */
export async function lockGateAccount<Row extends MintGateAccount = MintGateAccount>(
  tx: Pick<Database, "execute">,
  clerkUserId: string,
  extra: SQL = sql``,
): Promise<Row[]> {
  return (await tx.execute(sql`
      select a.clerk_user_id,
             a.email,
             a.active,
             a.tenant_id::text as tenant_id,
             a.credential_epoch,
             (a.suspended_at is not null) as suspended,
             (a.payment_hold_at is not null) as payment_hold,
             (a.deleting_at is not null) as deleting,
             a.banned,
             (a.locked and (a.locked_until is null or a.locked_until > now())) as locked,
             core.mailbox_domain_refused(a.tenant_id, lower(split_part(a.email, '@', 2))) as domain_not_hosted,
             (m.clerk_user_id is not null) as managed,
             m.connection_id::text as managed_connection,
             (pv.active is false) as connection_inactive,
             exists (
               select 1 from authd.required_domains rd
                where rd.domain = lower(split_part(a.email, '@', 2))
                  and rd.tenant_id = a.tenant_id
             ) as sso_required,
             exists (
               select 1 from authd.required_domains rd
                 join authd.required_exempt ex
                   on ex.connection_id = rd.connection_id
                  and ex.tenant_id = rd.tenant_id
                where rd.domain = lower(split_part(a.email, '@', 2))
                  and rd.tenant_id = a.tenant_id
                  and ex.clerk_user_id = a.clerk_user_id
             ) as sso_exempt
             ${extra}
        from authd.accounts a
        left join authd.managed_accounts m on m.clerk_user_id = a.clerk_user_id
        left join authd.passthrough_versions pv on pv.connection_id = m.connection_id
       where a.clerk_user_id = ${clerkUserId}
         for no key update of a
    `)) as unknown as Row[]
}

/**
 * Whose devices a read or a revoke reaches. Every caller says which, so a
 * revoke can never forget to name the person or the workspace.
 *
 *   - `own`: one person's devices in their account's workspace now, which is
 *     null for i10's own domain. What a person sees and revokes as themselves.
 *   - `workspace`: any device of one workspace (`tenant_id` equal to it, never
 *     null), optionally one person's. Only for the workspace's owners and admins.
 */
export type DeviceScope =
  | { kind: "own"; clerkUserId: string }
  | { kind: "workspace"; tenantId: string; clerkUserId?: string }

function scopeWhere(scope: DeviceScope): SQL {
  if (scope.kind === "own") {
    // ⚠ THE ACCOUNT'S WORKSPACE NOW, NOT THE CONSOLE'S: a person's own devices
    // follow their mailbox, wherever it lives. No account means no devices (FK).
    return and(
      eq(mailDevices.clerkUserId, scope.clerkUserId),
      sql`${mailDevices.tenantId} is not distinct from (
        select a.tenant_id from authd.accounts a where a.clerk_user_id = ${scope.clerkUserId}
      )`,
    )!
  }
  return and(
    eq(mailDevices.tenantId, scope.tenantId),
    scope.clerkUserId === undefined
      ? undefined
      : eq(mailDevices.clerkUserId, scope.clerkUserId),
  )!
}

export const DEVICE_PAGE_MAX = 100

export interface DeviceCursor {
  /** `created_at` to the microsecond, as Postgres printed it: a `Date` would lose rows. */
  createdAt: string
  id: string
}

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

export function encodeDeviceCursor(cursor: DeviceCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, "utf8").toString("base64url")
}

/** Null for anything this module did not write. */
export function decodeDeviceCursor(raw: string): DeviceCursor | null {
  const [createdAt, id, extra] = Buffer.from(raw, "base64url")
    .toString("utf8")
    .split("|")
  if (extra !== undefined || !createdAt || !id) return null
  if (!CURSOR_AT.test(createdAt)) return null
  // A date that rolls over (Feb 30) or year 0 parses here but Postgres refuses it.
  const at = new Date(createdAt)
  if (Number.isNaN(at.getTime()) || at.getUTCFullYear() < 1) return null
  if (at.toISOString().slice(0, 19) !== createdAt.slice(0, 19)) return null
  return UUID.test(id) ? { createdAt, id } : null
}

export interface DevicePage {
  devices: MailDeviceRow[]
  nextCursor: string | null
}

/**
 * One page of devices in `scope`, newest first (`created_at desc, id desc`,
 * keyset on both). `email` narrows to one mailbox address.
 */
export async function listDevices(
  db: Pick<Database, "select">,
  input: {
    scope: DeviceScope
    email?: string
    cursor?: DeviceCursor | null
    limit: number
  },
): Promise<DevicePage> {
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), DEVICE_PAGE_MAX)
  const rows = await db
    .select({
      ...deviceColumns,
      cursorAt: sql<string>`to_char(${mailDevices.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(mailDevices)
    .where(
      and(
        scopeWhere(input.scope),
        input.email === undefined
          ? undefined
          : eq(mailDevices.email, input.email.toLowerCase()),
        input.cursor
          ? sql`(${mailDevices.createdAt}, ${mailDevices.id}) < (${input.cursor.createdAt}::timestamptz, ${input.cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(mailDevices.createdAt), desc(mailDevices.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    devices: page.map(toRow),
    nextCursor:
      rows.length > limit && last
        ? encodeDeviceCursor({ createdAt: last.cursorAt, id: last.id })
        : null,
  }
}

/** What a revoke deleted, for its audit entry. */
export interface RevokedDevice {
  id: string
  email: string
  clerkUserId: string
  /** The device's workspace, null for i10's own domain. */
  tenantId: string | null
}

const revokedColumns = {
  id: mailDevices.id,
  email: mailDevices.email,
  clerkUserId: mailDevices.clerkUserId,
  tenantId: mailDevices.tenantId,
}

/**
 * Revokes (deletes) one device in `scope`, or returns null when there is none
 * there.
 *
 * The DELETE is the whole revocation: the access-change trigger names the
 * person and the mail front closes the device's sessions within about a
 * second. It never raises `credential_epoch`, which would sign out every other
 * device and password session too. Its certificate permits and liveness rows
 * go with it by cascade (device row first, then those: the store's lock order).
 */
export async function revoke(
  db: Pick<Database, "delete">,
  input: { deviceId: string; scope: DeviceScope },
): Promise<RevokedDevice | null> {
  if (!UUID.test(input.deviceId)) return null
  const [gone] = await db
    .delete(mailDevices)
    .where(and(eq(mailDevices.id, input.deviceId), scopeWhere(input.scope)))
    .returning(revokedColumns)
  return gone ?? null
}

/**
 * "Sign out all my mail devices": deletes every device of one person in
 * `scope`. Clerk sends no password-change event, so this is how a person ends
 * them all at once.
 *
 * ⚠ ACCOUNT LOCK FIRST (the lock order above). Without it a `mint` in flight
 * commits a device this DELETE's snapshot never saw, and a bulk `endFor`
 * walking the same person's rows in another order can deadlock with it.
 */
export async function revokeAllFor(
  db: Pick<Database, "transaction">,
  scope: DeviceScope & { clerkUserId: string },
): Promise<RevokedDevice[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select 1 from authd.accounts where clerk_user_id = ${scope.clerkUserId}
         for no key update`)
    return tx.delete(mailDevices).where(scopeWhere(scope)).returning(revokedColumns)
  })
}

/**
 * ⚠ OPERATOR ONLY (scripts/mail-device.ts), NEVER FROM A ROUTE: deletes one
 * device by id with no tenant or person filter, so it also reaches a row left
 * behind in a workspace its account has since left.
 */
export async function revokeForOperator(
  db: Pick<Database, "delete">,
  deviceId: string,
): Promise<RevokedDevice | null> {
  if (!UUID.test(deviceId)) return null
  const [gone] = await db
    .delete(mailDevices)
    .where(eq(mailDevices.id, deviceId))
    .returning(revokedColumns)
  return gone ?? null
}

const END_FOR_BATCH = 1000

export type EndForInput =
  | {
      tenantId: string
      clerkUserIds?: readonly string[]
      createdBefore?: Date
    }
  | {
      tenantId: null
      clerkUserIds: readonly string[]
      createdBefore?: Date
    }

/**
 * Deletes the devices of the named people in `tenantId` (or all of `tenantId`'s
 * devices when `clerkUserIds` is omitted for a non-null workspace), optionally
 * only rows created before `createdBefore`.
 *
 * `tenantId: null` (i10's own domain) always requires `clerkUserIds` so a
 * caller can never delete every null-tenant device platform-wide.
 *
 * Callers run this inside their own transaction, AFTER their write to
 * `authd.accounts` (lock order: accounts first, devices second).
 */
export async function endFor(
  tx: Pick<Database, "delete">,
  input: EndForInput,
): Promise<number> {
  const beforeClause = input.createdBefore
    ? sql`${mailDevices.createdAt} < ${ts(input.createdBefore)}`
    : undefined

  if (input.clerkUserIds === undefined) {
    if (input.tenantId === null) {
      throw new Error("endFor requires clerkUserIds when tenantId is null")
    }
    const gone = await tx
      .delete(mailDevices)
      .where(and(eq(mailDevices.tenantId, input.tenantId), beforeClause))
      .returning({ id: mailDevices.id })
    return gone.length
  }

  const ids = [...new Set(input.clerkUserIds)]
  if (ids.length === 0) return 0

  let deleted = 0
  for (let i = 0; i < ids.length; i += END_FOR_BATCH) {
    const slice = ids.slice(i, i + END_FOR_BATCH)
    const gone = await tx
      .delete(mailDevices)
      .where(
        and(
          tenantMatches(input.tenantId),
          inArray(mailDevices.clerkUserId, slice),
          beforeClause,
        ),
      )
      .returning({ id: mailDevices.id })
    deleted += gone.length
  }
  return deleted
}

/**
 * Reconciles a person's devices with the `authd.accounts` row just written by
 * the Clerk projection (`projection/writer.ts` `applyUser`), in the same
 * transaction:
 *   - when the user is banned, every device of theirs is deleted;
 *   - otherwise, any device whose `email` or `tenant_id` no longer matches the
 *     account row is deleted.
 */
export async function reconcileAccountDevices(
  tx: Pick<Database, "delete">,
  input: {
    clerkUserId: string
    email: string
    tenantId: string | null
    banned: boolean
  },
): Promise<number> {
  if (input.banned) {
    const gone = await tx
      .delete(mailDevices)
      .where(eq(mailDevices.clerkUserId, input.clerkUserId))
      .returning({ id: mailDevices.id })
    return gone.length
  }

  const email = input.email.toLowerCase()
  const tenantMismatch =
    input.tenantId === null
      ? sql`${mailDevices.tenantId} is not null`
      : sql`${mailDevices.tenantId} is distinct from ${input.tenantId}::uuid`

  const gone = await tx
    .delete(mailDevices)
    .where(
      and(
        eq(mailDevices.clerkUserId, input.clerkUserId),
        sql`(${mailDevices.email} <> ${email} or ${tenantMismatch})`,
      ),
    )
    .returning({ id: mailDevices.id })
  return gone.length
}

/**
 * Raises one person's `credential_epoch` and ends their mail devices in
 * `tenantId` in ONE transaction (lock order: accounts first, devices second).
 *
 * Used by Okta Universal Logout, user-wide OIDC back-channel logout, user-wide
 * SAML SLO, and device-revoking Okta event hook events.
 */
export async function raiseEpochAndEndDevices(
  db: Pick<Database, "transaction">,
  input: {
    tenantId: string
    clerkUserId: string
    createdBefore?: Date
  },
): Promise<{ devicesEnded: number }> {
  return db.transaction(async (tx) => {
    await raiseCredentialEpoch(tx, input.clerkUserId)
    const devicesEnded = await endFor(tx, {
      tenantId: input.tenantId,
      clerkUserIds: [input.clerkUserId],
      createdBefore: input.createdBefore,
    })
    return { devicesEnded }
  })
}

/**
 * Raises every managed account's `credential_epoch` on a connection and ends
 * their mail devices in `tenantId` in ONE transaction (accounts first, devices
 * second).
 *
 * Used by Okta `application.lifecycle.deactivate` when the event's AppInstance
 * target matches this connection's own Okta app.
 */
export async function raiseConnectionEpochAndEndDevices(
  db: Pick<Database, "transaction">,
  input: {
    tenantId: string
    connectionId: string
    createdBefore?: Date
  },
): Promise<{ accountsRaised: number; devicesEnded: number }> {
  return db.transaction(async (tx) => {
    const raised = await raiseConnectionCredentialEpochs(
      tx,
      input.connectionId,
    ).returning({ clerkUserId: accounts.clerkUserId })
    const clerkUserIds = raised.map((r) => r.clerkUserId)
    const devicesEnded = await endFor(tx, {
      tenantId: input.tenantId,
      clerkUserIds,
      createdBefore: input.createdBefore,
    })
    return { accountsRaised: clerkUserIds.length, devicesEnded }
  })
}

/**
 * A device row as the certificate-key writers see it, locked. `alive` is the
 * code's own clock: unused and inside its ten minutes, or used and inside its
 * ninety idle days (the prune's two rules, by the server's clock).
 */
export interface LockedDevice {
  id: string
  clerk_user_id: string
  email: string
  tenant_id: string | null
  platform: string
  serial: string | null
  cert_key_sha256: Buffer | null
  alive: boolean
}

/** The person a device belongs to, read WITHOUT a lock: it says which account to lock first. */
export async function deviceOwner(
  tx: Pick<Database, "execute">,
  deviceId: string,
): Promise<string | null> {
  if (!UUID.test(deviceId)) return null
  const [row] = (await tx.execute(sql`
    select clerk_user_id from authd.mail_devices where id = ${deviceId}
  `)) as unknown as { clerk_user_id: string }[]
  return row?.clerk_user_id ?? null
}

/**
 * Locks one device row, the second lock of every device write. Call only while
 * holding its account's lock (`lockGateAccount`).
 *
 * ⚠ `FOR NO KEY UPDATE`: the key column's unique index is partial, so Postgres
 * does not count it as a key, and writing it never needs `FOR UPDATE`.
 */
export async function lockDevice(
  tx: Pick<Database, "execute">,
  deviceId: string,
): Promise<LockedDevice | null> {
  const [row] = (await tx.execute(sql`
    select id::text, clerk_user_id, email, tenant_id::text as tenant_id, platform,
           serial, cert_key_sha256,
           case when first_used_at is null
                then created_at > now() - interval '10 minutes'
                else last_used_at > now() - interval '90 days' end as alive
      from authd.mail_devices
     where id = ${deviceId}
       for no key update
  `)) as unknown as LockedDevice[]
  return row ?? null
}

/**
 * Why a locked device may not take (`key: null`) or keep (`key`: the key it
 * should hold) a certificate key for `account`, or null when it may. The same
 * person, address and workspace as the account now (authd's
 * `gate.DeviceRefusal`), a Mac, alive, the expected serial when one is named,
 * and the key state asked for.
 */
export function deviceKeyRefusal(
  device: LockedDevice | null,
  account: MintGateAccount,
  expect: { key: Buffer | null; serial?: string },
): MailDeviceError | null {
  if (!device) {
    return new MailDeviceError("device_not_found", "Mail device not found.")
  }
  if (
    device.clerk_user_id !== account.clerk_user_id ||
    device.email !== account.email.toLowerCase() ||
    (device.tenant_id ?? null) !== (account.tenant_id ?? null)
  ) {
    return new MailDeviceError(
      "device_mismatch",
      "Mail device no longer matches its account.",
    )
  }
  if (device.platform !== "macos") {
    return new MailDeviceError(
      "device_not_macos",
      "Only a Mac binds a certificate key.",
    )
  }
  if (!device.alive) {
    return new MailDeviceError("device_expired", "Mail device code has expired.")
  }
  if (expect.serial !== undefined && device.serial !== expect.serial) {
    return new MailDeviceError("serial_mismatch", "Mail device serial does not match.")
  }
  if (expect.key === null) {
    return device.cert_key_sha256
      ? new MailDeviceError("device_key_bound", "Mail device already has a key.")
      : null
  }
  const bound = device.cert_key_sha256
  if (
    !bound ||
    bound.length !== expect.key.length ||
    !timingSafeEqual(bound, expect.key)
  ) {
    return new MailDeviceError(
      "device_key_changed",
      "Mail device key is not the expected one.",
    )
  }
  return null
}

/**
 * Binds `keySha256` to a locked device, claims its first use (both clocks
 * together, as the CHECK requires; a used device keeps its own), and drops its
 * liveness rows. A key already bound to another device is a unique violation
 * (`isUniqueViolation`), which the caller refuses.
 */
export async function setDeviceKey(
  tx: Pick<Database, "execute">,
  deviceId: string,
  keySha256: Buffer,
): Promise<void> {
  await tx.execute(sql`
    update authd.mail_devices
       set cert_key_sha256 = ${keySha256},
           first_used_at = coalesce(first_used_at, now()),
           last_used_at = coalesce(last_used_at, now())
     where id = ${deviceId}
  `)
  await deleteLiveness(tx, deviceId)
}

/** Clears a locked device's key and drops its liveness rows. Returns whether it had one. */
export async function clearDeviceKey(
  tx: Pick<Database, "execute">,
  deviceId: string,
): Promise<boolean> {
  const cleared = (await tx.execute(sql`
    update authd.mail_devices set cert_key_sha256 = null
     where id = ${deviceId} and cert_key_sha256 is not null
    returning id
  `)) as unknown as { id: string }[]
  await deleteLiveness(tx, deviceId)
  return cleared.length > 0
}

/**
 * ⚠ ONLY AFTER THE DEVICE ROW'S LOCK. authd writes these rows in autocommit
 * statements and never while holding a device row, so device first, liveness
 * second is the one order both sides take.
 */
async function deleteLiveness(tx: Pick<Database, "execute">, deviceId: string) {
  await tx.execute(
    sql`delete from authd.mail_device_cert_binds where device_id = ${deviceId}`,
  )
}

/** A Postgres unique violation (23505), wherever the driver put it. */
export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null
  return e?.code === "23505" || e?.cause?.code === "23505"
}

/**
 * The operator's `bind-key` (#383 PR 3, for a probe until PR 4): binds a
 * certificate key to a Mac in one transaction, accounts first, then the device.
 *
 * ⚠ IT CHECKS WHAT THE HOOKS WOULD, so a prod probe cannot bind what no real
 * enrollment could: the account gate (`bindRefusal`), then the device rules
 * (`deviceKeyRefusal`: the same person, address and workspace, `macos`, a
 * code still alive, and the certificate's CN as the row's serial when the row
 * has one). A row that already has a key is refused unless `replace`, and a
 * key another device holds always is.
 */
export async function bindKey(
  db: Pick<Database, "transaction">,
  input: {
    deviceId: string
    keySha256: Buffer
    /** The leaf's subject CN, or null when it has none. */
    commonName: string | null
    replace: boolean
  },
): Promise<void> {
  if (input.keySha256.length !== 32) throw new Error("keySha256 must be 32 bytes")
  try {
    await db.transaction(async (tx) => {
      const { account, device } = await lockOwnedDevice(tx, input.deviceId)
      // ⚠ NEVER RESURRECTS A DEAD CODE: binding claims the first use, so a code
      // that died unused (or idle) would otherwise come back to life.
      const refusal =
        bindRefusal(account, device.tenant_id) ??
        deviceKeyRefusal(device, account!, {
          // `replace` expects the key the row holds now, so only that check moves.
          key: input.replace ? device.cert_key_sha256 : null,
          serial: device.serial === null ? undefined : (input.commonName ?? ""),
        })
      if (refusal) throw refusal
      await setDeviceKey(tx, device.id, input.keySha256)
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new MailDeviceError("key_in_use", "That key is bound to another device.")
    }
    throw error
  }
}

/** The operator's `unbind-key`: clears a device's key. Returns whether it had one. */
export async function unbindKey(
  db: Pick<Database, "transaction">,
  input: { deviceId: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const { device } = await lockOwnedDevice(tx, input.deviceId)
    return clearDeviceKey(tx, device.id)
  })
}

/** Account lock, then device lock, for a device named only by its id. */
async function lockOwnedDevice(tx: Pick<Database, "execute">, deviceId: string) {
  const owner = await deviceOwner(tx, deviceId)
  if (owner) {
    const [account] = await lockGateAccount(tx, owner)
    const device = await lockDevice(tx, deviceId)
    // The person id can never move under a device (`on update no action`), so
    // a changed owner here means the row was deleted and is gone.
    if (device && device.clerk_user_id === owner) return { account, device }
  }
  throw new MailDeviceError("device_not_found", `No mail device ${deviceId}.`)
}

/**
 * Looks up an account by its primary email address: the operator script's, and
 * which person a mailbox address belongs to for the device routes.
 */
export async function accountByEmail(
  db: Pick<Database, "select">,
  email: string,
): Promise<{
  clerkUserId: string
  email: string
  tenantId: string | null
  credentialEpoch: number
  active: boolean
} | null> {
  const [row] = await db
    .select({
      clerkUserId: accounts.clerkUserId,
      email: accounts.email,
      tenantId: accounts.tenantId,
      credentialEpoch: accounts.credentialEpoch,
      active: accounts.active,
    })
    .from(accounts)
    .where(eq(accounts.email, email.trim().toLowerCase()))
    .limit(1)
  return row ?? null
}
