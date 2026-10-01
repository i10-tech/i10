/**
 * How many accounts are saved on this device - see `save` in ./remembered.ts.
 *
 * ⚠ ITS OWN PLAIN MODULE BECAUSE THE SERVER READS IT. remembered.ts is
 * `"use client"`, and a server component importing a constant from a client
 * module gets a client-reference proxy instead of the string.
 */
export const SAVED_COUNT_COOKIE = "i10_saved_accounts"

/** Most cards the list keeps, so a hand-edited cookie cannot ask for fifty. */
export const SAVED_LIMIT = 4

export function savedCount(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "", 10)
  return Number.isFinite(n) ? Math.max(0, Math.min(SAVED_LIMIT, n)) : 0
}
