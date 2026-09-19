import { Hono } from "hono"
import { cacheKeyFor, type KeyCache, type Mode } from "../auth/api-key.js"
import type { CreatedKey, KeySummary, KeyStore } from "../auth/store.js"
import { requireApiKey } from "../middleware/auth.js"
import { isRestricted } from "../auth/scope.js"

/**
 * Managing the keys a tenant sends with.
 *
 * ⚠ THESE ROUTES CANNOT MINT A TENANT'S FIRST KEY, AND THAT IS A REAL GAP
 * RATHER THAN AN OVERSIGHT. They authenticate with `requireApiKey`, so reaching
 * them requires a key already. Closing it needs the console to authenticate
 * with a Clerk SESSION rather than an API key, and no session middleware exists
 * in this API yet — so today the first key of a new tenant is an operator
 * action. Nothing here should be read as the bootstrap being solved.
 *
 * ⚠ A RESTRICTED KEY MAY READ THIS LIST AND CHANGE NOTHING, WHICH IS WHAT
 * MAKES A SCOPE A BOUNDARY RATHER THAN A SUGGESTION. These routes authenticate
 * with any valid key and take whatever `scopes` they are given — so without the
 * guard below, a key limited to `staging.acme.com` could mint itself one
 * limited to nothing, and every restriction in the product would be exactly one
 * request wide. It could also revoke the keys that are not leaked.
 *
 * ⚠ THE CONSOLE IS NOT AFFECTED, AND THAT IS THE POINT OF THE SPLIT. Key
 * management there is session-authenticated — a person who signed in and holds
 * the workspace — rather than key-authenticated. Somebody with the dashboard
 * can always widen a key; a credential sitting in a deploy environment cannot.
 *
 * ⚠ AND THE SECRET IS RETURNED EXACTLY ONCE, ON THE RESPONSE THAT CREATES IT.
 * There is deliberately no endpoint that reads one back: the plaintext is not
 * stored anywhere, only its SHA-256, so a customer who loses a key rotates it.
 * An endpoint that could return an existing secret would turn a database read
 * into a credential leak.
 */

export interface ApiKeyRouteDeps {
  store: KeyStore
  /** ⚠ The same cache the verifier reads, or revocation is not immediate. */
  cache: KeyCache
  log: { error: (o: object, m: string) => void }
}

const notWired = {
  statusCode: 501,
  name: "internal_server_error" as const,
  message: "API key management is not configured.",
}

/**
 * ⚠ `prefix` AND NEVER THE SECRET. This is what the dashboard lists, and the
 * shape is deliberate: enough to recognise a key, not enough to use one.
 */
const present = (k: KeySummary) => ({
  object: "api_key" as const,
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  mode: k.mode,
  scopes: k.scopes,
  created_at: k.createdAt.toISOString(),
  last_used_at: k.lastUsedAt?.toISOString() ?? null,
  expires_at: k.expiresAt?.toISOString() ?? null,
  revoked_at: k.revokedAt?.toISOString() ?? null,
})

const presentCreated = (k: CreatedKey) => ({
  ...present(k),
  /**
   * ⚠ THE ONLY RESPONSE IN THE API THAT CARRIES A CREDENTIAL. It must never be
   * logged, and the field is named plainly so that a log scrubber can find it.
   */
  secret: k.secret,
})

/**
 * ⚠ STRUCTURAL, NOT `req: Request`, AND THE REASON IS A TYPES COLLISION RATHER
 * THAN A STYLE PREFERENCE. Under @types/bun the global `Request` is the merged
 * declaration — Bun's members and Node's — but `clone()` comes from Node's
 * half and is declared as returning undici's `Request`, which lacks the members
 * Bun's half adds. So `readJson(c.req.raw.clone())` failed to typecheck against
 * a nominal `Request` while being, at runtime, exactly the object this wants.
 * Asking only for what is used sidesteps the disagreement and says what the
 * function actually needs.
 */
const readJson = async (req: {
  json(): Promise<unknown>
}): Promise<Record<string, unknown> | null> => {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

const modeOf = (v: unknown): Mode | null =>
  v === "live" || v === "test" ? v : v === undefined ? "live" : null

/**
 * ⚠ 403 AND NOT 401. The key is real; it is being used for something outside
 * what it was issued for, and telling somebody their credential is invalid
 * would send them to rotate one that is fine.
 */
const restricted = {
  statusCode: 403,
  name: "restricted_api_key" as const,
  message:
    "This key is restricted to a domain, so it cannot manage keys. " +
    "Use the dashboard, or an unrestricted key.",
}

export function createApiKeyRoutes(deps?: ApiKeyRouteDeps) {
  const app = new Hono()

  app.use("*", requireApiKey)

  /*
   * ⚠ ON EVERY METHOD THAT IS NOT A READ, RATHER THAN ON EACH ROUTE. A guard
   * repeated four times is a guard that will be missing from the fifth route
   * somebody adds — and the fifth route is the one nobody thinks to test.
   * `GET` is deliberately allowed: listing prefixes tells a restricted key
   * nothing it does not already have, and it is what makes a key usable for
   * its own diagnostics.
   */
  app.use("*", async (c, next) => {
    if (c.req.method === "GET") return next()
    const auth = c.get("auth")
    if (auth && isRestricted(auth.scopes)) return c.json(restricted, 403)
    return next()
  })

  app.get("/", async (c) => {
    if (!deps) return c.json(notWired, 501)
    const auth = c.get("auth")
    return c.json({ data: (await deps.store.list(auth.tenantId)).map(present) }, 200)
  })

  app.post("/", async (c) => {
    if (!deps) return c.json(notWired, 501)
    const auth = c.get("auth")
    const body = await readJson(c.req.raw.clone())

    const name = typeof body?.name === "string" ? body.name.trim() : ""
    if (!name) {
      return c.json(
        {
          statusCode: 422,
          name: "validation_error" as const,
          message: 'Send `{ "name": "production" }`.',
        },
        422,
      )
    }

    const mode = modeOf(body?.mode)
    if (!mode) {
      return c.json(
        {
          statusCode: 422,
          name: "validation_error" as const,
          message: '`mode` must be "live" or "test".',
        },
        422,
      )
    }

    try {
      const created = await deps.store.create({
        tenantId: auth.tenantId,
        name,
        mode,
        scopes: Array.isArray(body?.scopes)
          ? (body.scopes as unknown[]).filter((s): s is string => typeof s === "string")
          : [],
      })
      return c.json(presentCreated(created), 201)
    } catch (error) {
      deps.log.error(
        { err: error, tenantId: auth.tenantId },
        "could not create an API key",
      )
      return c.json(
        {
          statusCode: 500,
          name: "internal_server_error" as const,
          message: "Could not create the key.",
        },
        500,
      )
    }
  })

  /**
   * ⚠ REVOCATION IS IMMEDIATE, AND THE CACHE EVICTION IS WHAT MAKES IT SO. The
   * row is only half of it: a verified key lives in Redis for the TTL, and
   * without deleting that entry the key keeps working for up to a minute after
   * the customer was told it was dead. That minute is the entire reason this
   * system stopped asking Clerk.
   *
   * ⚠ AND THE EVICTION FAILING IS A 500, NOT A QUIET SUCCESS. Reporting success
   * while a leaked credential is still live is the worst possible answer here —
   * the customer stops looking. The row stays revoked, so a retry converges.
   */
  app.delete("/:id", async (c) => {
    if (!deps) return c.json(notWired, 501)
    const auth = c.get("auth")
    const id = c.req.param("id")

    const revoked = await deps.store.revoke(auth.tenantId, id)
    if (!revoked) {
      // Already revoked, or not theirs. The two are deliberately one answer:
      // distinguishing them tells a caller whether another tenant holds that id.
      return c.json(
        { statusCode: 404, name: "not_found" as const, message: "No such key." },
        404,
      )
    }

    try {
      await deps.cache.del(cacheKeyFor(revoked.secretHash))
    } catch (error) {
      deps.log.error(
        { err: error, tenantId: auth.tenantId, keyId: id },
        "revoked a key but could not evict its cache entry",
      )
      return c.json(
        {
          statusCode: 500,
          name: "internal_server_error" as const,
          message: "The key was revoked but may remain usable briefly. Retry.",
        },
        500,
      )
    }

    return c.body(null, 204)
  })

  /**
   * ⚠ NO OVERLAP BETWEEN THE OLD KEY AND THE NEW ONE, DELIBERATELY. A grace
   * period is the polite design for planned rotation and the wrong one for the
   * case this button is actually pressed in: the secret has leaked, and leaving
   * it alive is precisely what the customer is trying to stop.
   *
   * ⚠ ITS VALUE IS NOT THE ROTATION. It is not having to compose a replacement
   * by hand — same scopes, same mode, same tenant — while under pressure.
   * Nobody reads a scopes checklist during an incident.
   */
  app.post("/:id/rotate", async (c) => {
    if (!deps) return c.json(notWired, 501)
    const auth = c.get("auth")
    const id = c.req.param("id")

    const rotated = await deps.store.rotate(auth.tenantId, id)
    if (!rotated) {
      return c.json(
        { statusCode: 404, name: "not_found" as const, message: "No such key." },
        404,
      )
    }

    try {
      await deps.cache.del(cacheKeyFor(rotated.revokedHash))
    } catch (error) {
      deps.log.error(
        { err: error, tenantId: auth.tenantId, keyId: id },
        "rotated a key but could not evict the old cache entry",
      )
      // ⚠ 200 WITH THE NEW KEY, NOT A 500. The replacement exists and the
      // caller must receive it — losing it would leave them with a revoked key
      // and no successor. The stale entry expires on its own within the TTL.
    }

    return c.json(presentCreated(rotated.created), 200)
  })

  return app
}
