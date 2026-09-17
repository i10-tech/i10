import type { Hono } from "hono"
import { cacheKeyFor } from "../../auth/api-key.js"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"

/**
 * The two things a customer's own systems authenticate with: API keys, and the
 * signing secrets on their webhook endpoints.
 *
 * ⚠ BOTH SECRETS ARE SHOWN ONCE AND NEVER AGAIN, AND NEITHER IS EVER LOGGED.
 * The store hands back the plaintext on creation and on rotation; after that
 * only a prefix and a hash exist. Anything here that stashed the value for
 * convenience would turn a leaked database into a leaked key.
 *
 * ⚠ AND REVOKING A KEY IS TWO ACTS, THE ROW AND THE CACHE. Without the second,
 * a revoked key keeps working for up to the cache TTL after the customer was
 * told it was dead. See the delete route.
 */
export function mountCredentials(app: Hono, d: ConsoleDeps): void {
  // ───────────────────────────────────────────────────────────────────────────
  // API keys
  // ───────────────────────────────────────────────────────────────────────────

  app.get("/api-keys", async (c) => {
    if (!d.keys) return c.json(notWired("API keys"), 501)
    const { tenantId } = c.get("auth")
    const keys = await d.keys.store.list(tenantId)
    return c.json({
      data: keys.map((k) => ({
        id: k.id,
        name: k.name,
        // ⚠ THE PREFIX, NEVER THE KEY. Nothing stores the secret — see
        // auth/store.ts — so this cannot leak it even by accident, and the
        // prefix is what a person matches against their own environment.
        prefix: k.prefix,
        mode: k.mode,
        scopes: k.scopes,
        created_at: k.createdAt.toISOString(),
        last_used_at: k.lastUsedAt?.toISOString() ?? null,
        expires_at: k.expiresAt?.toISOString() ?? null,
        revoked_at: k.revokedAt?.toISOString() ?? null,
      })),
    })
  })

  app.post("/api-keys", async (c) => {
    if (!d.keys) return c.json(notWired("API keys"), 501)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const body = await readJson(c)

    const name = typeof body?.name === "string" ? body.name.trim() : ""
    if (!name) return c.json(validation("`name` is required."), 422)

    const mode = body?.mode === "test" ? "test" : "live"

    try {
      const created = await d.keys.store.create({
        tenantId,
        name,
        mode,
        scopes: Array.isArray(body?.scopes)
          ? (body.scopes as unknown[]).filter((s): s is string => typeof s === "string")
          : [],
        // ⚠ AUDIT ONLY, NEVER AUTHORIZATION — see 0031. Knowing who minted a
        // key matters during an incident; tying the key's life to an employee's
        // account would take production sending down when they leave.
        createdBy: userId,
      })

      return c.json(
        {
          id: created.id,
          name: created.name,
          prefix: created.prefix,
          mode: created.mode,
          scopes: created.scopes,
          created_at: created.createdAt.toISOString(),
          /** ⚠ THE ONLY RESPONSE IN THE SYSTEM THAT EVER CARRIES THIS. */
          secret: created.secret,
        },
        201,
      )
    } catch (error) {
      d.log.error({ err: String(error), tenantId }, "could not create an API key")
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

  app.delete("/api-keys/:id", async (c) => {
    if (!d.keys) return c.json(notWired("API keys"), 501)
    const { tenantId } = c.get("auth")

    const revoked = await d.keys.store.revoke(tenantId, c.req.param("id"))
    if (!revoked) return c.json(notFound("No key with that id."), 404)

    /*
     * ⚠ THE CACHE EVICTION IS HALF OF REVOCATION AND ITS FAILURE IS A 500.
     * A verified key lives in Redis for the TTL; without deleting that entry
     * the key keeps working for up to a minute after the customer was told it
     * was dead. Reporting success while a leaked credential is still live is
     * the worst possible answer — they stop looking. The row stays revoked, so
     * a retry converges.
     */
    if (d.keys.cache) {
      try {
        await d.keys.cache.del(cacheKeyFor(revoked.secretHash))
      } catch (error) {
        d.log.error(
          { err: String(error), tenantId, keyId: c.req.param("id") },
          "revoked a key but could not evict it from the cache",
        )
        return c.json(
          {
            statusCode: 500,
            name: "internal_server_error" as const,
            message:
              "The key was revoked but may stay usable for up to a minute. Retry to confirm.",
          },
          500,
        )
      }
    }

    return c.json({ id: c.req.param("id"), deleted: true })
  })

  app.post("/api-keys/:id/rotate", async (c) => {
    if (!d.keys) return c.json(notWired("API keys"), 501)
    const { tenantId } = c.get("auth")

    const rotated = await d.keys.store.rotate(tenantId, c.req.param("id"))
    if (!rotated) return c.json(notFound("No key with that id."), 404)

    if (d.keys.cache) {
      try {
        await d.keys.cache.del(cacheKeyFor(rotated.revokedHash))
      } catch (error) {
        d.log.error(
          { err: String(error), tenantId },
          "rotated a key but could not evict the old one from the cache",
        )
      }
    }

    return c.json(
      {
        id: rotated.created.id,
        name: rotated.created.name,
        prefix: rotated.created.prefix,
        mode: rotated.created.mode,
        created_at: rotated.created.createdAt.toISOString(),
        secret: rotated.created.secret,
      },
      201,
    )
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Webhooks
  // ───────────────────────────────────────────────────────────────────────────

  app.get("/webhook-endpoints", async (c) => {
    if (!d.webhooks) return c.json(notWired("Webhooks"), 501)
    const { tenantId } = c.get("auth")
    return c.json({ data: await d.webhooks.list(tenantId) })
  })

  app.post("/webhook-endpoints", async (c) => {
    if (!d.webhooks) return c.json(notWired("Webhooks"), 501)
    const { tenantId } = c.get("auth")
    const body = await readJson(c)

    const created = await d.webhooks.create(tenantId, {
      url: typeof body?.url === "string" ? body.url : "",
      events: Array.isArray(body?.events) ? body.events : [],
      ...(typeof body?.description === "string"
        ? { description: body.description }
        : {}),
    })

    return created.status === "created"
      ? c.json(created.endpoint, 201)
      : c.json(validation(created.reason), 422)
  })

  app.delete("/webhook-endpoints/:id", async (c) => {
    if (!d.webhooks) return c.json(notWired("Webhooks"), 501)
    const { tenantId } = c.get("auth")
    const removed = await d.webhooks.remove(tenantId, c.req.param("id"))
    return removed
      ? c.json({ id: c.req.param("id"), deleted: true })
      : c.json(notFound("No endpoint with that id."), 404)
  })

  app.post("/webhook-endpoints/:id/rotate-secret", async (c) => {
    if (!d.webhooks) return c.json(notWired("Webhooks"), 501)
    const { tenantId } = c.get("auth")
    const rotated = await d.webhooks.rotateSecret(tenantId, c.req.param("id"))
    return rotated
      ? c.json(rotated)
      : c.json(notFound("No endpoint with that id."), 404)
  })

  app.get("/webhook-deliveries", async (c) => {
    const { tenantId } = c.get("auth")
    const q = c.req.query()
    return c.json(
      await d.queries.listDeliveries(tenantId, {
        ...(q.endpoint_id ? { endpointId: q.endpoint_id } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.limit ? { limit: Number(q.limit) } : {}),
      }),
    )
  })
}
