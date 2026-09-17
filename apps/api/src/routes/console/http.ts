import type { Context } from "hono"

/**
 * The small shared vocabulary every console route speaks: the three refusal
 * shapes, and the handful of coercions that turn an untyped JSON body into
 * something a store can be handed.
 *
 * ⚠ ONE COPY OF EACH, EXPORTED, BECAUSE THE ALTERNATIVE IS SIX SLIGHTLY
 * DIFFERENT ERROR ENVELOPES. The console branches on `name` and on
 * `statusCode`; a route module that invented its own shape would render as a
 * blank panel rather than as a message, and only on the one page that got it
 * wrong.
 */

export const notWired = (what: string) => ({
  statusCode: 501 as const,
  name: "internal_server_error" as const,
  message: `${what} are not configured on this deployment.`,
})

export const validation = (message: string) => ({
  statusCode: 422 as const,
  name: "validation_error" as const,
  message,
})

export const notFound = (message = "Not found.") => ({
  statusCode: 404 as const,
  name: "not_found" as const,
  message,
})

// ─────────────────────────────────────────────────────────────────────────────

export async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    // ⚠ CLONED, BECAUSE THE BODY IS A ONE-SHOT STREAM. Hono's own helpers may
    // have read it already, and a second read of a consumed body throws in a
    // way that surfaces as a 500 on a perfectly valid request.
    const value: unknown = await c.req.raw.clone().json()
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

/**
 * ⚠ IT FILTERS TO WELL-FORMED UUIDs RATHER THAN PASSING STRINGS THROUGH. These
 * ids go into an `IN` list against a uuid column; a non-uuid string does not
 * match nothing, it raises `invalid input syntax for type uuid` and fails the
 * whole statement — so one junk id in a bulk delete of 400 would refuse all 400
 * with an error that names Postgres rather than the input.
 */
export function asIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  return value.filter((v): v is string => typeof v === "string" && uuid.test(v))
}

export function clampInt(
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), min), max)
}

export function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}
