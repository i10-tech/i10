/**
 * One structured line per request.
 *
 * ⚠ WHAT IS NOT HERE IS THE POINT. No query string (handshakes carry
 * `__clerk_session`, dev requests `__clerk_db_jwt`, tickets ride in it), no
 * headers (cookies, `Authorization`), no body (passwords, codes, tickets). The
 * fields below are the whole vocabulary, and the type keeps it that way: a
 * caller cannot add a field without changing this file.
 *
 * TODO(#337): the identity audit log is written from these same facts; this
 * line is what Workers Logs keeps in the meantime.
 */
export interface LogLine {
  /** The effective method (after `_method`). */
  method: string
  /** The allowlist entry, or null when nothing matched. */
  route: string | null
  decision: "pass" | "deny" | "managed" | "unavailable"
  reason: string | null
  /** What the gateway answered. */
  status: number
  /** What Clerk answered, or null when the request never reached Clerk. */
  upstream_status: number | null
  duration_ms: number
  ip: string | null
  ray: string | null
  /** Only for a refused request, sanitised; never the query. */
  path?: string
}

/** A refused path, safe to print: unknown characters masked, length capped. */
export function printablePath(rawPath: string): string {
  const masked = rawPath.replace(/[^A-Za-z0-9\-._~@+/%]/g, "?")
  return masked.length > 200 ? `${masked.slice(0, 200)}...` : masked
}

export function formatLine(line: LogLine): string {
  return JSON.stringify({ msg: "clerk-gateway", ...line })
}
