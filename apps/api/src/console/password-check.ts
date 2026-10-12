/**
 * "Is this my current password?", asked by the console's change-password form
 * as soon as somebody leaves the field (2026-10-12), so a wrong one is said
 * there rather than after they have typed a new one twice.
 *
 * ⚠ IT IS A CONVENIENCE, NOT THE GATE. Clerk's `updatePassword` still takes
 * the current password and refuses a wrong one; this only moves the answer
 * earlier. Someone who skips it entirely is refused by Clerk at save.
 *
 * ⚠ AND IT IS RATE LIMITED BY US, BECAUSE CLERK DOES NOT. The backend
 * `verify_password` endpoint never feeds the account lockout (probed
 * 2026-09-01), so without a cap this route would be an unlimited password
 * oracle for anybody holding a session - a borrowed laptop guessing at the
 * owner's password with nothing to stop it.
 *
 * ⚠ AN OUTAGE IS NEVER "WRONG". A 429 or 5xx from Clerk answers `unavailable`;
 * telling somebody their correct password is wrong is how they end up
 * resetting a password that was fine.
 */

export type PasswordVerdict = "verified" | "wrong" | "none" | "unavailable" | "limited"

export interface PasswordCheckDeps {
  /** Clerk's `users.verifyPassword`; resolves when correct, throws otherwise. */
  verify(userId: string, password: string): Promise<unknown>
  /** Counts one attempt and says whether it is still within the window. */
  allow(userId: string): Promise<boolean>
}

export const PASSWORD_ATTEMPTS = 10
export const PASSWORD_WINDOW_SECONDS = 15 * 60

export async function checkPassword(
  d: PasswordCheckDeps,
  userId: string,
  password: string,
): Promise<PasswordVerdict> {
  if (!(await d.allow(userId))) return "limited"
  try {
    await d.verify(userId, password)
    return "verified"
  } catch (error) {
    return classify(error)
  }
}

/** Clerk's answers, mapped as the mail bridge maps them - see the memory note. */
export function classify(error: unknown): PasswordVerdict {
  const status = (error as { status?: number } | null)?.status
  const codes = ((error as { errors?: { code?: string }[] } | null)?.errors ?? []).map(
    (entry) => entry.code,
  )
  if (codes.includes("no_password_set")) return "none"
  if (status === 422) return "wrong"
  if (status === 400 && codes.some((code) => code?.includes("password"))) return "wrong"
  return "unavailable"
}

type Counter = {
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
}

/**
 * A fixed window per person in Redis, and in this process when Redis is down.
 *
 * ⚠ THE FALLBACK STILL LIMITS. The cache client fails fast when Redis is
 * unavailable, and "no limit while Redis is down" would be exactly the oracle
 * the limit exists to close; a per-process window is weaker across replicas
 * but never open.
 */
export function passwordAttempts(redis: Counter | null): PasswordCheckDeps["allow"] {
  const local = new Map<string, { count: number; until: number }>()
  return async (userId) => {
    const key = `console:verify-password:${userId}`
    if (redis) {
      try {
        const count = await redis.incr(key)
        if (count === 1) await redis.expire(key, PASSWORD_WINDOW_SECONDS)
        return count <= PASSWORD_ATTEMPTS
      } catch {
        /* falls through to the local window */
      }
    }
    const now = Date.now()
    const entry = local.get(key)
    if (!entry || entry.until <= now) {
      local.set(key, { count: 1, until: now + PASSWORD_WINDOW_SECONDS * 1000 })
      return true
    }
    entry.count += 1
    return entry.count <= PASSWORD_ATTEMPTS
  }
}
