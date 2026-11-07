import type { ManagedAccounts } from "./managed.js"
import {
  COMPILED_ALLOW,
  COMPILED_DENY,
  type AllowEntry,
  type Compiled,
  type DenyEntry,
  type Method,
} from "./routes.js"

/**
 * Pass or refuse one Frontend API request. Pure: no Worker globals, no I/O
 * except through the managed-account hook it is handed.
 *
 * ⚠ WE ROUTE ON EXACTLY THE PATH WE FORWARD. Anything that could make the
 * string we match differ from what Clerk's router resolves - percent-encoding,
 * dot segments, empty segments, odd characters - is refused outright rather
 * than normalised, because a normaliser that disagrees with Clerk's by one
 * character is a bypass. clerk-js never sends any of them. The one
 * normalisation is a single trailing slash, which clerk-js itself sends for
 * backup codes and which Clerk treats as the same route.
 */

/** What the Worker learned about the body before asking. */
export type Body =
  /** No body, or an empty one. */
  | { kind: "none" }
  /** `application/x-www-form-urlencoded`, buffered and parsed. */
  | { kind: "form"; form: URLSearchParams }
  /** `multipart/form-data` or `application/octet-stream`, streamed unread. */
  | { kind: "upload" }
  /** A non-empty body of any other type. */
  | { kind: "other" }
  /** Larger than the Worker is willing to buffer. */
  | { kind: "too_large" }

export interface PolicyRequest {
  /** The HTTP method as received. */
  method: string
  /** The path exactly as received: no decoding, no dot-segment resolution. */
  rawPath: string
  /** The raw query string, with or without the leading `?`. */
  search: string
  /** `Access-Control-Request-Method`, for a CORS preflight. */
  preflightMethod: string | null
  body: Body
}

export interface PolicyOptions {
  /** `INSTANCE=development`: dev-only entries pass. */
  development: boolean
  managed: ManagedAccounts
}

export type Decision =
  | { outcome: "pass"; method: Method | "OPTIONS"; route: string; entry: AllowEntry }
  | { outcome: "deny"; method: string; route: string | null; reason: string }
  | {
      outcome: "managed"
      method: Method
      route: string
      reason: "sso_required" | "managed_account"
    }
  | { outcome: "unavailable"; method: Method; route: string; reason: string }

const METHODS: readonly string[] = ["GET", "POST", "PUT", "PATCH", "DELETE"]
const OVERRIDES: readonly string[] = ["PUT", "PATCH", "DELETE"]
const SESSION_ID = /^sess_[A-Za-z0-9]{1,64}$/
const MAX_PATH = 1024

/**
 * ⚠ A CHARACTER ALLOWLIST, NOT A BLOCKLIST. Every path clerk-js, the Next SDK
 * or Clerk's own probes build uses only these. `%` in particular is refused so
 * that an encoded slash or dot can never be decoded upstream into a path we did
 * not match.
 */
const PATH_CHARS = /^[A-Za-z0-9\-._~@+/]+$/

/** Why a raw path is refused, or null when it is safe to route on. */
export function pathProblem(rawPath: string): string | null {
  if (!rawPath.startsWith("/")) return "bad_path"
  if (rawPath.length > MAX_PATH) return "path_too_long"
  if (rawPath.includes("%")) return "encoded_path"
  if (!PATH_CHARS.test(rawPath)) return "bad_character"
  if (rawPath.includes("//")) return "empty_segment"
  const segments = rawPath.split("/")
  if (segments.some((s) => s === "." || s === "..")) return "dot_segment"
  return null
}

/** The path we match on: one trailing slash removed (see the note above). */
export function routePath(rawPath: string): string {
  return rawPath.length > 1 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath
}

export function findDeny(method: Method, path: string): DenyEntry | null {
  return find(COMPILED_DENY, path, (e) => e.method === "*" || e.method === method)
}

export function findAllow(method: Method, path: string): AllowEntry | null {
  return find(COMPILED_ALLOW, path, (e) => e.method === method)
}

function find<T>(
  table: readonly Compiled<T>[],
  path: string,
  methodMatches: (entry: T) => boolean,
): T | null {
  for (const { entry, pattern } of table) {
    if (methodMatches(entry) && pattern.test(path)) return entry
  }
  return null
}

/**
 * The method Clerk will act on: the HTTP method, or the `_method` override
 * clerk-js puts in the query string for PUT, PATCH and DELETE.
 *
 * ⚠ ANY KEY THAT IS `_method` IGNORING CASE COUNTS, AND MORE THAN ONE IS
 * REFUSED. We cannot know which of two overrides, or which spelling, Clerk's
 * parser picks; clerk-js sends exactly one, lower-case.
 */
function effectiveMethod(
  request: PolicyRequest,
  query: URLSearchParams,
): { method: Method; preflight: boolean } | { reason: string; method: string } {
  const http = request.method.toUpperCase()
  const preflight = http === "OPTIONS"
  const base = preflight ? (request.preflightMethod ?? "").trim().toUpperCase() : http
  if (!METHODS.includes(base)) return { reason: "method_not_allowed", method: http }

  const keys = [...query.keys()].filter((k) => k.toLowerCase() === "_method")
  if (keys.length === 0) return { method: base as Method, preflight }
  if (keys.length > 1 || keys[0] !== "_method") {
    return { reason: "ambiguous_method_override", method: http }
  }
  const override = (query.get("_method") ?? "").toUpperCase()
  if (base !== "POST" || !OVERRIDES.includes(override)) {
    return { reason: "bad_method_override", method: http }
  }
  return { method: override as Method, preflight }
}

export async function decide(
  request: PolicyRequest,
  options: PolicyOptions,
): Promise<Decision> {
  const query = new URLSearchParams(request.search)
  const resolved = effectiveMethod(request, query)
  if ("reason" in resolved) {
    return {
      outcome: "deny",
      method: resolved.method,
      route: null,
      reason: resolved.reason,
    }
  }
  const { method, preflight } = resolved
  const deny = (reason: string, route: string | null = null): Decision => ({
    outcome: "deny",
    method,
    route,
    reason,
  })

  const problem = pathProblem(request.rawPath)
  if (problem) return deny(problem)
  const path = routePath(request.rawPath)

  const refused = findDeny(method, path)
  if (refused) return deny(refused.reason)

  const entry = findAllow(method, path)
  if (!entry) return deny("not_allowlisted")
  if (entry.devOnly && !options.development) return deny("dev_only", entry.name)

  // A preflight carries no body and changes nothing: the route decides it.
  if (preflight) return { outcome: "pass", method: "OPTIONS", route: entry.name, entry }

  const body = request.body
  if (body.kind === "too_large") return deny("body_too_large", entry.name)
  if (body.kind === "other") return deny("unsupported_content_type", entry.name)
  if (body.kind === "upload" && !entry.upload) {
    return deny("unsupported_content_type", entry.name)
  }
  if (body.kind === "form") {
    /*
     * ⚠ AN OVERRIDE IN THE BODY IS REFUSED, NOT IGNORED. clerk-js only ever
     * puts `_method` in the query. If Clerk also honoured a body field, a POST
     * we allowed could act as a DELETE on the same path; refusing it costs
     * nothing.
     */
    if ([...body.form.keys()].some((k) => k.toLowerCase() === "_method")) {
      return deny("method_override_in_body", entry.name)
    }
  }
  const pass: Decision = { outcome: "pass", method, route: entry.name, entry }
  if (!entry.guard) return pass

  try {
    if (entry.guard === "sign_in_create") {
      const form = body.kind === "form" ? body.form : new URLSearchParams()
      const strategies = form.getAll("strategy")
      const identifiers = form.getAll("identifier")
      if (strategies.length > 1 || identifiers.length > 1) {
        return deny("ambiguous_form", entry.name)
      }
      /*
       * ⚠ A TICKET PASSES WITHOUT A LOOKUP: it is the one way in for a managed
       * account (sso.md 1.4). Telling OUR tickets from Clerk's invitation
       * tickets is #337's, inside the hook's implementation or the bridge.
       */
      if (strategies[0] === "ticket") return pass
      const identifier = (identifiers[0] ?? "").trim().toLowerCase()
      /*
       * ⚠ NO IDENTIFIER, NO LOOKUP - AND THAT IS A KNOWN GAP, NOT AN OVERSIGHT.
       * A discoverable passkey, an OAuth button and `transfer` name nobody at
       * this step; Clerk resolves the person later (at attempt_first_factor or
       * in /v1/oauth_callback). For a managed account those methods are removed
       * at link time and the API gate refuses the session (#337, sso.md 2.2).
       */
      if (!identifier) return pass
      if (await options.managed.byIdentifier(identifier)) {
        return { outcome: "managed", method, route: entry.name, reason: "sso_required" }
      }
      return pass
    }

    // self_service
    /*
     * ⚠ THE SESSION IS THE ONE IN THE QUERY, AND IT MUST BE THERE. clerk-js
     * adds `_clerk_session_id` to every path outside /client, and Clerk acts as
     * that session; a request without exactly one is not one our UI makes.
     */
    const sessions = query.getAll("_clerk_session_id")
    if (sessions.length !== 1 || !SESSION_ID.test(sessions[0] ?? "")) {
      return deny("session_required", entry.name)
    }
    if (await options.managed.bySession(sessions[0] ?? "")) {
      return {
        outcome: "managed",
        method,
        route: entry.name,
        reason: "managed_account",
      }
    }
    return pass
  } catch {
    return {
      outcome: "unavailable",
      method,
      route: entry.name,
      reason: "managed_lookup_failed",
    }
  }
}
