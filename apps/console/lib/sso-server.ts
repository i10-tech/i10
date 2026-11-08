import "server-only"
import { tryApi } from "@/lib/api"
import type { Me } from "@/lib/types"
import type { SsoAbilities } from "@/lib/sso-types"

/**
 * What the SSO pages decide on the server (#340).
 *
 * ⚠ ABILITIES ARE OURS, FROM `/console/me`, NEVER CLERK'S `has()`: Clerk gives
 * every member the same powerless role (#335). They only decide what a button
 * says; the API refuses the same move for anyone it does not allow.
 */
export async function ssoAbilities(): Promise<
  { ok: true; abilities: SsoAbilities } | { ok: false; message: string }
> {
  const me = await tryApi<Me>("/console/me")
  if (!me.ok) return { ok: false, message: me.error.message }
  const permissions = me.data.access?.permissions ?? []
  return {
    ok: true,
    abilities: {
      manage: permissions.includes("sso:manage"),
      owner: permissions.includes("owners:manage"),
      userId: me.data.user.id,
    },
  }
}

/**
 * Where apps/auth is, for the links an admin copies and the test-run start.
 * It is the origin of the sign-in URL the console is already configured with
 * (`CLERK_SIGN_IN_URL`), read per request like every deployment variable here.
 * Null when unset - local review with no auth app - and the pages then say so
 * instead of printing a link that goes nowhere.
 */
export function authOrigin(): string | null {
  const configured = process.env.CLERK_SIGN_IN_URL?.trim()
  if (!configured) return null
  try {
    return new URL(configured).origin
  } catch {
    return null
  }
}
