import type { ClerkClient } from "@clerk/backend"
import type { DeviceStore, PresentedDevice } from "./store.js"

/**
 * What pressing a saved account on the sign-in page does (#192).
 *
 *   ticket   - straight in. A single-use Clerk sign-in token; the page signs
 *              in with it. For an account with 2FA and no passkey, Clerk still
 *              asks for the code afterwards (probed 2026-10-02 - a sign-in
 *              token does not skip a second factor).
 *   passkey  - ask for this account's passkey, which Clerk accepts as both
 *              factors at once.
 *   signin   - nothing to skip: the ordinary flow for this account.
 *   forget   - this browser's entry is dead. Drop it, then the ordinary flow.
 *
 * ⚠ "STRAIGHT IN" ONLY WHEN THE SESSION EXPIRED. Somebody who pressed Sign out
 * meant it - on a shared computer, the next person must not get back in by
 * pressing a card. Clerk keeps the old session and says which it was, so the
 * row's last session is asked rather than guessed: `expired` (or `abandoned`,
 * or still `active`) is a timeout, anything else is somebody ending it -
 * signing out, removing the session, or "sign out of all devices".
 *
 * ⚠ AND A PASSKEY BEATS A 2FA CODE. An account with both is sent to the
 * passkey even when the session only expired: one tap instead of the
 * authenticator app.
 */
export type ResumeOutcome =
  | { outcome: "ticket"; ticket: string; secret: string; secondFactor: boolean }
  | { outcome: "passkey" }
  | { outcome: "signin" }
  | { outcome: "forget" }

export interface ResumeUser {
  banned: boolean
  locked: boolean
  hasPasskey: boolean
  twoFactor: boolean
}

export interface ResumeClerk {
  /** `null` when the user no longer exists. */
  user(userId: string): Promise<ResumeUser | null>
  /** `null` when Clerk has no such session any more. */
  sessionStatus(sessionId: string): Promise<string | null>
  signInToken(userId: string): Promise<string>
  /** When the user and the session were created, in ms. `null` if either is gone. */
  ages(
    userId: string,
    sessionId: string,
  ): Promise<{ user: number; session: number } | null>
}

/** Session states that mean "it ran out", not "somebody ended it". */
const TIMED_OUT = new Set(["expired", "abandoned", "active"])

export async function resume(
  presented: PresentedDevice,
  deps: { store: DeviceStore; clerk: ResumeClerk },
): Promise<ResumeOutcome> {
  const { store, clerk } = deps
  const found = await store.find(presented)

  switch (found.kind) {
    case "none":
      return { outcome: "forget" }
    case "copied":
      // ⚠ REVOKED, NOT JUST REFUSED. Whoever holds the copy would try again.
      await store.revoke(found.row.id)
      return { outcome: "forget" }
    case "raced":
      return { outcome: "signin" }
    case "ok":
      break
  }

  const { row } = found
  const user = await clerk.user(row.userId)
  if (!user || user.banned) {
    await store.revoke(row.id)
    return { outcome: "forget" }
  }
  // Locked out by too many wrong attempts: the ordinary flow says so.
  if (user.locked) return { outcome: "signin" }

  // ⚠ NO SESSION ON RECORD COUNTS AS SIGNED OUT. Fail towards asking.
  const status = row.sessionId ? await clerk.sessionStatus(row.sessionId) : null
  const signedOut = status === null || !TIMED_OUT.has(status)

  if (signedOut || (user.twoFactor && user.hasPasskey)) {
    return user.hasPasskey ? { outcome: "passkey" } : { outcome: "signin" }
  }

  /*
   * ⚠ THE TOKEN IS MINTED BEFORE THE SECRET ROTATES, AND THE ORDER MATTERS. If
   * Clerk fails after a rotation, the browser never hears the new secret, keeps
   * the old one, and presenting it half a minute later reads as a copied
   * cookie - revoking the row over our own outage. This way a failure leaves
   * the row exactly as it was.
   */
  const ticket = await clerk.signInToken(row.userId)
  const secret = await store.rotate(row.id)
  await store.recordResume(row)

  return { outcome: "ticket", ticket, secret, secondFactor: user.twoFactor }
}

/** Clerk's 404, which these calls answer with `null` rather than an outage. */
function isNotFound(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 404
}

/**
 * ⚠ SIXTY SECONDS. The page uses the token immediately; anything longer is a
 * window in which a token caught in a log still signs somebody in.
 */
const TICKET_SECONDS = 60

export function clerkResume(clerk: ClerkClient): ResumeClerk {
  return {
    async user(userId) {
      try {
        const user = await clerk.users.getUser(userId)
        return {
          banned: user.banned,
          locked: user.locked,
          // ⚠ READ FROM THE RAW JSON. The SDK's `User` drops `passkeys`; the
          // Backend API sends them (checked with curl against the dev instance).
          hasPasskey:
            ((user.raw as { passkeys?: unknown[] } | null)?.passkeys?.length ?? 0) > 0,
          twoFactor: user.twoFactorEnabled,
        }
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },

    async sessionStatus(sessionId) {
      try {
        return (await clerk.sessions.getSession(sessionId)).status
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },

    async ages(userId, sessionId) {
      try {
        const [user, session] = await Promise.all([
          clerk.users.getUser(userId),
          clerk.sessions.getSession(sessionId),
        ])
        if (session.userId !== userId) return null
        return { user: user.createdAt, session: session.createdAt }
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },

    async signInToken(userId) {
      const token = await clerk.signInTokens.createSignInToken({
        userId,
        expiresInSeconds: TICKET_SECONDS,
      })
      return token.token
    },
  }
}

/**
 * How long after sign-up the account may swap its session for a fresh one.
 *
 * ⚠ WHY THIS EXISTS AT ALL: A SESSION MADE BY SIGN-UP IS NEVER "RECENTLY
 * VERIFIED". Probed on the dev instance 2026-10-03: it reads `fva: [99999, -1]`
 * seconds after the password was set, so Clerk asks somebody who JUST made the
 * account to re-enter that password before it will add their passkey. A
 * sign-in token gives a session with `fva: [0, -1]` instead.
 *
 * ⚠ FIFTEEN MINUTES, AND BOTH THE ACCOUNT AND THE SESSION MUST BE THAT YOUNG.
 * Anybody holding such a session already owns an account nobody else has
 * touched yet; what it buys is skipping a prompt on a minutes-old account,
 * never on an established one.
 */
export const FRESH_AFTER_SIGN_UP_MS = 15 * 60 * 1000

export type FreshOutcome =
  { outcome: "ticket"; ticket: string } | { outcome: "refused" }

export async function freshAfterSignUp(
  who: { userId: string; sessionId: string },
  deps: { clerk: ResumeClerk; now?: () => number },
): Promise<FreshOutcome> {
  const now = deps.now?.() ?? Date.now()
  const ages = await deps.clerk.ages(who.userId, who.sessionId)
  if (
    !ages ||
    now - ages.user > FRESH_AFTER_SIGN_UP_MS ||
    now - ages.session > FRESH_AFTER_SIGN_UP_MS
  ) {
    return { outcome: "refused" }
  }
  return { outcome: "ticket", ticket: await deps.clerk.signInToken(who.userId) }
}
