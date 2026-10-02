import { createHash, randomBytes } from "node:crypto"
import { and, eq, gte, lte, sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import { deviceResumes, rememberedDevices } from "../db/core.js"
import { equalSecrets } from "../webhooks/signing.js"

/**
 * The rows behind "press your saved account and you are back in" (#192).
 *
 * See `core.remembered_devices` for what a row is. This module owns the
 * secret: minting, hashing, rotating and recognising a copy.
 */

/** What the browser holds for one account: the row id and its current secret. */
export interface PresentedDevice {
  id: string
  secret: string
}

export interface DeviceRow {
  id: string
  userId: string
  sessionId: string | null
}

export type Found =
  | { kind: "ok"; row: DeviceRow }
  /**
   * The secret this row had before its last rotation, inside the grace window.
   * Another tab resumed a moment ago and this one still holds the old cookie.
   */
  | { kind: "raced"; row: DeviceRow }
  /** The old secret, long after it was replaced: the cookie was copied. */
  | { kind: "copied"; row: DeviceRow }
  /** Unknown, revoked, expired, or a secret that matches nothing. */
  | { kind: "none" }

export interface DeviceStore {
  /**
   * After a real sign-in: refresh this browser's row for the account, or make
   * one. `prior` is everything the cookie holds; only a row belonging to
   * `userId` is reused.
   */
  remember(input: {
    userId: string
    sessionId: string
    prior: readonly PresentedDevice[]
  }): Promise<PresentedDevice>
  find(presented: PresentedDevice): Promise<Found>
  /** Swap in a fresh secret and return it. */
  rotate(id: string, sessionId?: string): Promise<string>
  recordResume(row: DeviceRow): Promise<void>
  revoke(id: string): Promise<void>
  /** "Forget this account" - only with the secret, so nobody else can. */
  forget(presented: PresentedDevice): Promise<void>
  /**
   * Whether a device minted a session for `userId` close to `at`. Used by the
   * step-up check - see `core.device_resumes`.
   */
  resumedNear(userId: string, at: Date): Promise<boolean>
}

/** Unused for this long, a row stops working. Every sign-in and resume renews it. */
export const IDLE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

/**
 * How long the replaced secret is still recognised as a race rather than a copy.
 *
 * ⚠ TWO TABS ON ONE SIGN-IN PAGE ARE NOT AN ATTACK. Both hold the same cookie;
 * the first press rotates it, and the second arrives with the old secret a
 * second later. Treating that as theft would revoke the row under somebody who
 * did nothing wrong. Outside this window, the old secret has no innocent way
 * back.
 */
export const RACE_GRACE_MS = 30_000

/**
 * How far either side of a session's first-factor time a resume still counts.
 *
 * ⚠ CLERK REPORTS FACTOR AGE IN WHOLE MINUTES, so a time read off the token is
 * up to sixty seconds early, and a sign-in token can be used up to sixty
 * seconds after it is minted. Ninety covers both with room for clock skew.
 */
export const RESUME_MATCH_MS = 90_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function newSecret(): string {
  return randomBytes(32).toString("base64url")
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex")
}

/** A presented pair worth a query: a real uuid and a secret of plausible size. */
export function isPresentable(value: unknown): value is PresentedDevice {
  if (typeof value !== "object" || value === null) return false
  const { id, secret } = value as Record<string, unknown>
  return (
    typeof id === "string" &&
    UUID.test(id) &&
    typeof secret === "string" &&
    secret.length >= 32 &&
    secret.length <= 128
  )
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

/**
 * Run `fn` with the rows this request may see - see the policies on
 * `core.remembered_devices` and `core.device_resumes`.
 *
 * ⚠ THE SAME SHAPE AS `withTenant`, FOR THE SAME REASONS: `set_config(…, true)`
 * inside a transaction, so a value is bound rather than interpolated and
 * cannot outlive the transaction onto a pooled connection.
 */
async function scoped<T>(
  db: Database,
  scope: { deviceId?: string; userId?: string },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (scope.deviceId) {
      await tx.execute(sql`select set_config('app.device_id', ${scope.deviceId}, true)`)
    }
    if (scope.userId) {
      await tx.execute(sql`select set_config('app.user_id', ${scope.userId}, true)`)
    }
    return fn(tx)
  })
}

export function deviceStore(
  db: Database,
  now: () => Date = () => new Date(),
): DeviceStore {
  const expiry = () => new Date(now().getTime() + IDLE_LIFETIME_MS)

  async function find(presented: PresentedDevice): Promise<Found> {
    if (!isPresentable(presented)) return { kind: "none" }

    const [row] = await scoped(db, { deviceId: presented.id }, (tx) =>
      tx
        .select()
        .from(rememberedDevices)
        .where(eq(rememberedDevices.id, presented.id))
        .limit(1),
    )
    if (!row || row.revokedAt) return { kind: "none" }

    const given = hashSecret(presented.secret)
    const view: DeviceRow = { id: row.id, userId: row.userId, sessionId: row.sessionId }

    if (equalSecrets(row.secretHash, given)) {
      return row.expiresAt.getTime() > now().getTime()
        ? { kind: "ok", row: view }
        : { kind: "none" }
    }

    if (row.previousSecretHash && equalSecrets(row.previousSecretHash, given)) {
      const since = now().getTime() - (row.rotatedAt?.getTime() ?? 0)
      return since <= RACE_GRACE_MS
        ? { kind: "raced", row: view }
        : { kind: "copied", row: view }
    }

    return { kind: "none" }
  }

  async function rotate(id: string, sessionId?: string): Promise<string> {
    const secret = newSecret()
    await scoped(db, { deviceId: id }, (tx) =>
      tx
        .update(rememberedDevices)
        .set({
          previousSecretHash: sql`${rememberedDevices.secretHash}`,
          secretHash: hashSecret(secret),
          rotatedAt: now(),
          lastUsedAt: now(),
          expiresAt: expiry(),
          ...(sessionId ? { sessionId } : {}),
        })
        .where(eq(rememberedDevices.id, id)),
    )
    return secret
  }

  return {
    find,
    rotate,

    async remember({ userId, sessionId, prior }) {
      for (const presented of prior) {
        const found = await find(presented)
        if (found.kind !== "ok" || found.row.userId !== userId) continue

        return { id: found.row.id, secret: await rotate(found.row.id, sessionId) }
      }

      const secret = newSecret()
      const [row] = await scoped(db, { userId }, (tx) =>
        tx
          .insert(rememberedDevices)
          .values({
            userId,
            sessionId,
            secretHash: hashSecret(secret),
            expiresAt: expiry(),
          })
          .returning({ id: rememberedDevices.id }),
      )
      if (!row) throw new Error("remembered_devices insert returned no row")
      return { id: row.id, secret }
    },

    async recordResume(row) {
      await scoped(db, { userId: row.userId }, (tx) =>
        tx
          .insert(deviceResumes)
          .values({ userId: row.userId, deviceId: row.id, resumedAt: now() }),
      )
    },

    async revoke(id) {
      await scoped(db, { deviceId: id }, (tx) =>
        tx
          .update(rememberedDevices)
          .set({ revokedAt: now() })
          .where(eq(rememberedDevices.id, id)),
      )
    },

    async forget(presented) {
      const found = await find(presented)
      if (found.kind === "none") return
      const id = found.row.id
      await scoped(db, { deviceId: id }, (tx) =>
        tx
          .update(rememberedDevices)
          .set({ revokedAt: now() })
          .where(eq(rememberedDevices.id, id)),
      )
    },

    async resumedNear(userId, at) {
      const [hit] = await scoped(db, { userId }, (tx) =>
        tx
          .select({ id: deviceResumes.id })
          .from(deviceResumes)
          .where(
            and(
              eq(deviceResumes.userId, userId),
              gte(deviceResumes.resumedAt, new Date(at.getTime() - RESUME_MATCH_MS)),
              lte(deviceResumes.resumedAt, new Date(at.getTime() + RESUME_MATCH_MS)),
            ),
          )
          .limit(1),
      )
      return Boolean(hit)
    },
  }
}
