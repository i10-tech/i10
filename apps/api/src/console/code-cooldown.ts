/**
 * One emailed or texted code per minute, per person and purpose (2026-10-12).
 *
 * The console asks here before it asks Clerk to send a code - the step-up
 * dialog's emailed code, verifying an address - and the answer carries how
 * long until the next one, so the "Send a new code" button counts down from
 * the server's clock rather than the tab's. Closing the dialog, reloading or
 * opening a second tab does not buy another send.
 *
 * ⚠ IT GUARDS OUR BUTTONS, NOT CLERK'S API. The send itself goes from the
 * browser to Clerk's Frontend API, which keeps its own limits; somebody
 * scripting against Clerk directly never passes through here. What this stops
 * is the product itself sending a fresh code on every click.
 *
 * ⚠ REDIS FIRST, THIS PROCESS WHEN REDIS IS DOWN. The cache client fails fast,
 * and a cooldown that vanished with Redis would be a button that works again.
 */

export const CODE_COOLDOWN_SECONDS = 60

/** Purposes the console names: `step-up:email`, `email:<clerk id>`. */
export const PURPOSE = /^[a-z0-9_:-]{1,80}$/i

type Store = {
  set(
    key: string,
    value: string,
    mode: "EX",
    seconds: number,
    flag: "NX",
  ): Promise<"OK" | null>
  ttl(key: string): Promise<number>
}

export type Reservation = { ok: boolean; retryAfter: number }

export function codeCooldown(redis: Store | null, seconds = CODE_COOLDOWN_SECONDS) {
  const local = new Map<string, number>()
  return async (userId: string, purpose: string): Promise<Reservation> => {
    const key = `console:code-send:${userId}:${purpose}`
    if (redis) {
      try {
        const set = await redis.set(key, "1", "EX", seconds, "NX")
        if (set === "OK") return { ok: true, retryAfter: seconds }
        const ttl = await redis.ttl(key)
        return { ok: false, retryAfter: ttl > 0 ? ttl : seconds }
      } catch {
        /* falls through to this process */
      }
    }
    const now = Date.now()
    const until = local.get(key) ?? 0
    if (until > now) return { ok: false, retryAfter: Math.ceil((until - now) / 1000) }
    local.set(key, now + seconds * 1000)
    return { ok: true, retryAfter: seconds }
  }
}
