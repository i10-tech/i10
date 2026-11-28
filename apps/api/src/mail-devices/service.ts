import type { MailDevice, MailDeviceList } from "@repo/contracts"
import type { Database } from "../db/client.js"
import {
  accountByEmail,
  decodeDeviceCursor,
  listDevices,
  readMailboxTenant,
  revoke,
  revokeAllFor,
  type DeviceCursor,
  type DevicePage,
  type DeviceScope,
  type MailDeviceRow,
  type RevokedDevice,
} from "./store.js"

/**
 * Who may see and revoke which mail devices (#383 PR 5), for the console's
 * routes and the public API's. The store's `DeviceScope` filter is the tenant
 * boundary (authd has no RLS); this decides which scope a caller gets.
 *
 *   - Anyone: their own devices (`own`), wherever their mailbox lives, i10's
 *     own domain included.
 *   - An owner or admin (`members:manage`) of the workspace in use: any device
 *     of that workspace (`tenant_id` equal to it), and any one mailbox in it.
 *   - Anything else is `not_found`, which the routes answer as a 404 that says
 *     nothing about whether the address or device exists (routes/console/mailboxes.ts).
 *
 * ⚠ NO STEP-UP ON ANY REVOKE. Revoking only removes access, and someone who has
 * just lost a phone must be able to do it at once, from any session they have.
 */

export interface DeviceViewer {
  userId: string
  /** The workspace in use, or null outside the console (the public API). */
  tenantId: string | null
  /** `members:manage` in `tenantId`. Always false without a workspace. */
  isAdmin: boolean
  /**
   * Optional gate checked right before touching the caller's own scope (`own`).
   * Returning false stops own-scope reads and revokes before hitting the store
   * (the caller already holds the refusal to send), while leaving workspace-
   * admin actions in `tenantId` untouched.
   */
  allowOwn?: () => Promise<boolean>
}

export interface DeviceListQuery {
  scope: "mine" | "workspace"
  /** One mailbox's devices. */
  address?: string
  cursor?: string
  limit?: number
}

export type DeviceListOutcome =
  | { status: "ok"; page: MailDeviceList }
  | { status: "not_found" }
  | { status: "invalid"; message: string }

export type RevokeAllOutcome =
  { status: "ok"; revoked: number } | { status: "not_found" }

/** A scope that names one person, which `revokeAll` requires. */
type PersonScope = DeviceScope & { clerkUserId: string }

/** The store, narrowed to what this module calls; the route tests pass a fake. */
export interface DeviceStorePort {
  list(input: {
    scope: DeviceScope
    email?: string
    cursor?: DeviceCursor | null
    limit: number
  }): Promise<DevicePage>
  revoke(input: { deviceId: string; scope: DeviceScope }): Promise<RevokedDevice | null>
  revokeAll(scope: PersonScope): Promise<RevokedDevice[]>
  /** The person and workspace a mailbox address belongs to now. */
  accountOf(
    address: string,
  ): Promise<{ clerkUserId: string; tenantId: string | null } | null>
  /** The workspace of one person's own mailbox, or null when they have none. */
  mailboxTenant(clerkUserId: string): Promise<{ tenantId: string | null } | null>
}

export const dbDeviceStore = (db: Database): DeviceStorePort => ({
  list: (input) => listDevices(db, input),
  revoke: (input) => revoke(db, input),
  revokeAll: (scope) => revokeAllFor(db, scope),
  accountOf: (address) => accountByEmail(db, address),
  mailboxTenant: (clerkUserId) => readMailboxTenant(db, clerkUserId),
})

export interface AuditLog {
  info(o: object, m: string): void
}

const DEFAULT_PAGE = 50

export function formatDevice(row: MailDeviceRow): MailDevice {
  return {
    object: "mail_device",
    id: row.id,
    email: row.email,
    platform: row.platform,
    device_name: row.deviceName,
    model: row.model,
    serial: row.serial,
    created_at: row.createdAt.toISOString(),
    first_used_at: row.firstUsedAt?.toISOString() ?? null,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    created_by: row.createdBy,
    has_certificate_key: row.hasCertKey,
  }
}

export function mailDeviceService(deps: { store: DeviceStorePort; log: AuditLog }) {
  const { store, log } = deps
  const own = (viewer: DeviceViewer): PersonScope => ({
    kind: "own",
    clerkUserId: viewer.userId,
  })

  /**
   * The scope for one mailbox address: the caller's own, or, for an admin, a
   * person whose account is in the workspace in use. Null for anything else,
   * including an address with no account, so a 404 cannot tell them apart.
   */
  async function scopeForAddress(
    viewer: DeviceViewer,
    address: string,
  ): Promise<PersonScope | null> {
    const account = await store.accountOf(address)
    if (!account) return null
    if (account.clerkUserId === viewer.userId) {
      if (viewer.allowOwn && !(await viewer.allowOwn())) return null
      return own(viewer)
    }
    if (
      viewer.isAdmin &&
      viewer.tenantId !== null &&
      account.tenantId === viewer.tenantId
    ) {
      return {
        kind: "workspace",
        tenantId: viewer.tenantId,
        clerkUserId: account.clerkUserId,
      }
    }
    return null
  }

  return {
    async list(
      viewer: DeviceViewer,
      query: DeviceListQuery,
    ): Promise<DeviceListOutcome> {
      let scope: DeviceScope | null
      if (query.address !== undefined) {
        scope = await scopeForAddress(viewer, query.address)
      } else if (query.scope === "workspace") {
        scope =
          viewer.isAdmin && viewer.tenantId !== null
            ? { kind: "workspace", tenantId: viewer.tenantId }
            : null
      } else {
        if (viewer.allowOwn && !(await viewer.allowOwn()))
          return { status: "not_found" }
        scope = own(viewer)
      }
      if (!scope) return { status: "not_found" }

      let cursor: DeviceCursor | null = null
      if (query.cursor !== undefined) {
        cursor = decodeDeviceCursor(query.cursor)
        if (!cursor) return { status: "invalid", message: "That cursor is not valid." }
      }

      const page = await store.list({
        scope,
        ...(query.address !== undefined ? { email: query.address } : {}),
        cursor,
        limit: query.limit ?? DEFAULT_PAGE,
      })
      return {
        status: "ok",
        page: { data: page.devices.map(formatDevice), next_cursor: page.nextCursor },
      }
    },

    /** The workspace of one person's own mailbox, or null when they have none. */
    mailboxTenant(userId: string): Promise<{ tenantId: string | null } | null> {
      return store.mailboxTenant(userId)
    },

    /** The caller's own device, or for an admin any device of the workspace. Null is a 404. */
    async revoke(
      viewer: DeviceViewer,
      deviceId: string,
    ): Promise<RevokedDevice | null> {
      // Try the open workspace's admin scope first so revoking a workspace
      // member's device never runs the admin's own mailbox workspace gate
      // (for an admin's own device in that workspace, both scopes delete the
      // same row). A valid id that the open workspace does not hold still runs
      // the own gate, because it may be the caller's own device.
      let gone =
        viewer.isAdmin && viewer.tenantId !== null
          ? await store.revoke({
              deviceId,
              scope: { kind: "workspace", tenantId: viewer.tenantId },
            })
          : null
      if (!gone && (!viewer.allowOwn || (await viewer.allowOwn()))) {
        gone = await store.revoke({ deviceId, scope: own(viewer) })
      }
      if (gone) {
        log.info(
          {
            audit: "mail_device.revoked",
            tenantId: gone.tenantId,
            actorUserId: viewer.userId,
            userId: gone.clerkUserId,
            deviceId: gone.id,
            address: gone.email,
          },
          "mail device revoked",
        )
      }
      return gone
    },

    /** Every device of the caller, or for an admin of one mailbox in the workspace. */
    async revokeAll(viewer: DeviceViewer, address?: string): Promise<RevokeAllOutcome> {
      let scope: PersonScope | null
      if (address === undefined) {
        if (viewer.allowOwn && !(await viewer.allowOwn()))
          return { status: "not_found" }
        scope = own(viewer)
      } else {
        scope = await scopeForAddress(viewer, address)
      }
      if (!scope) return { status: "not_found" }
      const gone = await store.revokeAll(scope)
      log.info(
        {
          audit: "mail_device.revoked_all",
          // One scope is one workspace (or none), so every row shares it.
          tenantId:
            gone[0]?.tenantId ?? (scope.kind === "workspace" ? scope.tenantId : null),
          actorUserId: viewer.userId,
          userId: scope.clerkUserId,
          address: address ?? null,
          deviceIds: gone.map((d) => d.id),
        },
        "mail devices revoked",
      )
      return { status: "ok", revoked: gone.length }
    },
  }
}

export type MailDeviceService = ReturnType<typeof mailDeviceService>
