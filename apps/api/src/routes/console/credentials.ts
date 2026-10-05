import type { Hono } from "hono"
import { WEBHOOK_EVENT_TYPES } from "../../webhooks/catalog.js"
import { statsQuery, windowFrom } from "../webhook-stats.js"
import {
  createReplayMissingSchema,
  createReplaySchema,
  rotateWebhookSecretSchema,
  sendTestEventSchema,
  updateWebhookEndpointSchema,
} from "@repo/contracts"
import { cacheKeyFor } from "../../auth/api-key.js"
import { domainScope, scopedDomains } from "../../auth/scope.js"
import { requireFreshAuth } from "../../middleware/session.js"
import type { ConsoleDeps } from "./deps.js"
import { asId, notFound, notWired, readJson, validation } from "./http.js"

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
 *
 * ⚠ THE CONSOLE TALKS IN DOMAIN NAMES; THE ENCODING STAYS ON THIS SIDE. A
 * key's restriction is stored as a `domain:acme.com` entry in `scopes` - see
 * auth/scope.ts - and nothing outside this API needs to know that. These
 * routes take and return a plain `domain`, so the console cannot spell the
 * prefix wrong and the encoding can change without touching it.
 */
/**
 * Turn the `domain` the console sent into the scopes a key is stored with.
 *
 * ⚠ THE NAME IS CHECKED AGAINST THE TENANT'S OWN DOMAINS, AND THAT IS THE
 * POINT OF DOING IT SERVER-SIDE. A scope for a domain the workspace does not
 * hold is a key that can send from nothing - indistinguishable, from the
 * dashboard, from a key that works, until the first send fails in production.
 * A typo is refused here instead.
 *
 * ⚠ AND THE DOMAIN LIST BEING UNAVAILABLE REFUSES THE REQUEST rather than
 * quietly minting an unrestricted key. Falling back to "no scope" on an error
 * would mean an outage in an unrelated store silently widens a credential.
 *
 * ⚠ `null` IS AN EXPLICIT ANSWER - "every domain" - NOT A MISSING FIELD. It is
 * how the edit route widens a key back out, so it cannot be conflated with
 * "the caller did not mention scopes".
 */
async function resolveScope(
  d: ConsoleDeps,
  tenantId: string,
  value: unknown,
): Promise<{ ok: true; scopes: string[] } | { ok: false; error: string }> {
  // ⚠ ABSENT OR EMPTY IS EVERY DOMAIN - the same reading the send path gives
  // an empty `scopes`, so the two can never disagree about an unrestricted key.
  if (value === undefined || value === null) return { ok: true, scopes: [] }
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    return {
      ok: false,
      error: "`domains` must be a list of domain names, or empty for every domain.",
    }
  }

  const names = [
    ...new Set((value as string[]).map((v) => v.trim().toLowerCase())),
  ].filter(Boolean)
  if (names.length === 0) return { ok: true, scopes: [] }

  if (!d.domains) {
    return { ok: false, error: "Domains are not configured on this deployment." }
  }

  const held = new Set(
    (await d.domains.list(tenantId)).map((x) => x.name.toLowerCase()),
  )
  const unknown = names.filter((name) => !held.has(name))
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `You do not have a domain called ${unknown.join(", ")}.`,
    }
  }

  return { ok: true, scopes: names.map(domainScope) }
}

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
        // ⚠ THE PREFIX, NEVER THE KEY. Nothing stores the secret - see
        // auth/store.ts - so this cannot leak it even by accident, and the
        // prefix is what a person matches against their own environment.
        prefix: k.prefix,
        mode: k.mode,
        scopes: k.scopes,
        /*
         * ⚠ DERIVED FROM `scopes`, AND PLURAL NOW. A key may be limited to
         * several domains - two products sharing a deploy, say - and an empty
         * list is every domain. The `domain:` encoding stays the API's business;
         * the console only ever sees names.
         */
        domains: scopedDomains(k.scopes),
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

    const scope = await resolveScope(d, tenantId, body?.domains)
    if (!scope.ok) return c.json(validation(scope.error), 422)

    try {
      const created = await d.keys.store.create({
        tenantId,
        name,
        mode,
        scopes: scope.scopes,
        // ⚠ AUDIT ONLY, NEVER AUTHORIZATION - see 0031. Knowing who minted a
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
          domains: scopedDomains(created.scopes),
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

  /**
   * Narrowing or widening a key that already exists.
   *
   * ⚠ WITHOUT THIS THE SCOPE IS A DECISION MADE ONCE, IN A DIALOG, FOREVER.
   * The only other way to restrict a key minted unrestricted is to revoke it
   * and redeploy the secret everywhere it is used - enough friction that
   * nobody does it, which leaves every key unrestricted and the whole feature
   * decorative.
   *
   * ⚠ AND THE CACHE EVICTION IS NOT OPTIONAL HERE EITHER. A verified key sits
   * in Redis with its scopes baked in for the TTL, so a key narrowed to
   * staging keeps sending as production for up to a minute. It is the same
   * failure the delete route documents with a quieter symptom - nothing looks
   * wrong, the restriction simply is not in force yet.
   */
  app.patch("/api-keys/:id", async (c) => {
    if (!d.keys) return c.json(notWired("API keys"), 501)
    const { tenantId } = c.get("auth")
    const body = await readJson(c)

    const scope = await resolveScope(d, tenantId, body?.domains)
    if (!scope.ok) return c.json(validation(scope.error), 422)

    const updated = await d.keys.store.setScopes(
      tenantId,
      c.req.param("id"),
      scope.scopes,
    )
    // Revoked, or not theirs. One answer for both: see the delete route.
    if (!updated) return c.json(notFound("No such key."), 404)

    if (d.keys.cache) {
      try {
        await d.keys.cache.del(cacheKeyFor(updated.secretHash))
      } catch (error) {
        d.log.error(
          { err: String(error), tenantId, keyId: c.req.param("id") },
          "changed a key's scope but could not evict its cache entry",
        )
        /*
         * ⚠ A 500, LIKE REVOCATION, AND FOR THE HARDER-TO-SEE HALF OF THE SAME
         * REASON. Reporting success while the old, wider permission is still
         * live tells somebody their production domain is protected when it is
         * not. The row is already updated, so a retry converges.
         */
        return c.json(
          {
            statusCode: 500,
            name: "internal_server_error" as const,
            message: "The scope was saved but may not be in force for a minute. Retry.",
          },
          500,
        )
      }
    }

    return c.json({
      id: updated.key.id,
      name: updated.key.name,
      prefix: updated.key.prefix,
      mode: updated.key.mode,
      scopes: updated.key.scopes,
      domains: scopedDomains(updated.key.scopes),
    })
  })

  /*
   * ⚠ STEP-UP, BECAUSE A REVOKED KEY CANNOT BE UN-REVOKED. Everything an
   * attacker holding a stolen session cookie could do to this workspace is
   * recoverable except the deletions - and revoking the key a customer's
   * production systems send with is an outage they cannot undo from this
   * dialog. See `requireFreshAuth`.
   */
  app.delete("/api-keys/:id", requireFreshAuth, async (c) => {
    if (!d.keys) return c.json(notWired("API keys"), 501)
    const { tenantId } = c.get("auth")

    const revoked = await d.keys.store.revoke(tenantId, c.req.param("id"))
    if (!revoked) return c.json(notFound("No key with that id."), 404)

    /*
     * ⚠ THE CACHE EVICTION IS HALF OF REVOCATION AND ITS FAILURE IS A 500.
     * A verified key lives in Redis for the TTL; without deleting that entry
     * the key keeps working for up to a minute after the customer was told it
     * was dead. Reporting success while a leaked credential is still live is
     * the worst possible answer - they stop looking. The row stays revoked, so
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
      ...(body?.signature_scheme === "ed25519" ||
      body?.signature_scheme === "hmac_sha256"
        ? { signature_scheme: body.signature_scheme }
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

  /**
   * ⚠ BEHIND A RECENT SIGN-IN, because the response is a new signing secret.
   * A session somebody else is holding should not be able to mint one.
   *
   * ⚠ AND THE BODY MUST SAY WHAT HAPPENS TO THE OLD KEY. There is no default
   * (docs/decisions/webhooks.md, decision 7): the console asks, as the API does.
   */
  app.post("/webhook-endpoints/:id/rotate-secret", requireFreshAuth, async (c) => {
    if (!d.webhooks) return c.json(notWired("Webhooks"), 501)
    const { tenantId } = c.get("auth")
    const parsed = rotateWebhookSecretSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      return c.json(
        validation(
          parsed.error.issues[0]?.message ??
            "Say what happens to the current secret: `previous_secret` is `revoke` or `expire`.",
        ),
        422,
      )
    }
    const body = parsed.data
    const result = await d.webhooks.rotateSecret(
      tenantId,
      c.req.param("id"),
      body.previous_secret === "expire"
        ? { action: "expire", expiresInSeconds: body.expires_in! }
        : { action: "revoke" },
      body.signature_scheme,
    )
    if (result.status === "not_found")
      return c.json(notFound("No endpoint with that id."), 404)
    if (result.status === "rejected") return c.json(validation(result.reason), 422)
    return c.json(result.endpoint)
  })

  app.patch("/webhook-endpoints/:id", async (c) => {
    if (!d.webhooks) return c.json(notWired("Webhooks"), 501)
    const parsed = updateWebhookEndpointSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      return c.json(
        validation(parsed.error.issues[0]?.message ?? "Invalid update."),
        422,
      )
    }
    const result = await d.webhooks.update(
      c.get("auth").tenantId,
      c.req.param("id"),
      parsed.data,
    )
    if (result.status === "not_found")
      return c.json(notFound("No endpoint with that id."), 404)
    if (result.status === "rejected") return c.json(validation(result.reason), 422)
    return c.json(result.endpoint)
  })

  app.get("/webhook-endpoints/:id/stats", async (c) => {
    if (!d.webhooks) return c.json(notWired("Webhooks"), 501)
    const id = asId(c.req.param("id"))
    if (!id) return c.json(notFound("No endpoint with that id."), 404)
    const window = consoleWindow(c.req.query())
    if ("error" in window) return c.json(validation(window.error), 422)
    const stats = await d.webhooks.stats(c.get("auth").tenantId, id, window)
    return stats ? c.json(stats) : c.json(notFound("No endpoint with that id."), 404)
  })

  // Across every endpoint (#300): the overview and the list's error rates.
  app.get("/webhook-stats", async (c) => {
    if (!d.webhooks) return c.json(notWired("Webhooks"), 501)
    const window = consoleWindow(c.req.query())
    if ("error" in window) return c.json(validation(window.error), 422)
    return c.json(await d.webhooks.workspaceStats(c.get("auth").tenantId, window))
  })

  app.post("/webhook-endpoints/:id/test", async (c) => {
    if (!d.webhookTests) return c.json(notWired("Test events"), 501)
    const parsed = sendTestEventSchema.safeParse(await readJson(c))
    if (!parsed.success) return c.json(validation("Choose an event type."), 422)
    const result = await d.webhookTests(
      c.get("auth").tenantId,
      c.req.param("id"),
      parsed.data.event_type,
    )
    if (result.status === "not_found")
      return c.json(notFound("No endpoint with that id."), 404)
    if (result.status === "paused") {
      return c.json(
        validation("This endpoint is paused or switched off. Resume it first."),
        409,
      )
    }
    return c.json({ delivery_id: result.deliveryId }, 202)
  })

  app.post("/webhook-deliveries/:id/resend", async (c) => {
    if (!d.webhookReplays) return c.json(notWired("Replays"), 501)
    const id = asId(c.req.param("id"))
    if (!id) return c.json(notFound("No delivery with that id."), 404)
    const result = await d.webhookReplays.resend(c.get("auth").tenantId, id)
    if (result.status === "not_found")
      return c.json(notFound("No delivery with that id."), 404)
    if (result.status === "pending") {
      return c.json(validation("This delivery is still being attempted."), 409)
    }
    if (result.status === "paused") {
      return c.json(
        validation("Its endpoint is paused or switched off. Resume it first."),
        409,
      )
    }
    return c.json({ delivery_id: result.deliveryId }, 202)
  })

  for (const [path, kind, failedOnly] of [
    ["replay", "replay", false],
    ["recover", "replay", true],
    ["replay-missing", "replay_missing", false],
  ] as const) {
    app.post(`/webhook-endpoints/:id/${path}`, async (c) => {
      if (!d.webhookReplays) return c.json(notWired("Replays"), 501)
      const schema =
        kind === "replay" && !failedOnly
          ? createReplaySchema
          : createReplayMissingSchema
      const parsed = schema.safeParse(await readJson(c))
      if (!parsed.success) {
        return c.json(
          validation(parsed.error.issues[0]?.message ?? "Choose a window."),
          422,
        )
      }
      const body = parsed.data as {
        since: string
        until?: string
        statuses?: ("delivered" | "failed")[]
        event_type?: string
      }
      const result = await d.webhookReplays.create(
        c.get("auth").tenantId,
        c.req.param("id"),
        kind,
        {
          since: new Date(body.since),
          ...(body.until ? { until: new Date(body.until) } : {}),
          ...(failedOnly
            ? { statuses: ["failed" as const] }
            : body.statuses
              ? { statuses: body.statuses }
              : {}),
          ...(body.event_type ? { eventType: body.event_type } : {}),
        },
      )
      if (result.status === "not_found")
        return c.json(notFound("No endpoint with that id."), 404)
      if (result.status === "paused") {
        return c.json(
          validation("This endpoint is paused or switched off. Resume it first."),
          409,
        )
      }
      if (result.status === "rejected") return c.json(validation(result.reason), 422)
      return c.json(result.replay, 202)
    })
  }

  app.get("/webhook-endpoints/:id/replays", async (c) => {
    if (!d.webhookReplays) return c.json(notWired("Replays"), 501)
    return c.json({
      data: await d.webhookReplays.list(c.get("auth").tenantId, c.req.param("id")),
    })
  })

  app.get("/webhook-endpoints/:id/replays/:replayId", async (c) => {
    if (!d.webhookReplays) return c.json(notWired("Replays"), 501)
    const replay = await d.webhookReplays.get(
      c.get("auth").tenantId,
      c.req.param("replayId"),
    )
    return replay && replay.endpoint_id === c.req.param("id")
      ? c.json(replay)
      : c.json(notFound("No such replay."), 404)
  })

  app.post("/webhook-endpoints/:id/revoke-previous-secrets", async (c) => {
    if (!d.webhooks) return c.json(notWired("Webhooks"), 501)
    const { tenantId } = c.get("auth")
    const endpoint = await d.webhooks.revokePreviousSecrets(tenantId, c.req.param("id"))
    return endpoint
      ? c.json(endpoint)
      : c.json(notFound("No endpoint with that id."), 404)
  })

  app.get("/webhook-deliveries/:id", async (c) => {
    if (!d.webhookHistory) return c.json(notWired("Webhook history"), 501)
    const id = asId(c.req.param("id"))
    if (!id) return c.json(notFound("No delivery with that id."), 404)
    const detail = await d.webhookHistory.get(c.get("auth").tenantId, id)
    return detail ? c.json(detail) : c.json(notFound("No delivery with that id."), 404)
  })

  /**
   * ⚠ BEHIND A RECENT SIGN-IN: it removes data for good. Only a finished
   * delivery can be expunged; a pending one would go out empty.
   */
  app.delete("/webhook-deliveries/:id/payload", requireFreshAuth, async (c) => {
    if (!d.webhookHistory) return c.json(notWired("Webhook history"), 501)
    const id = asId(c.req.param("id"))
    if (!id) return c.json(notFound("No delivery with that id."), 404)
    const result = await d.webhookHistory.expunge(c.get("auth").tenantId, id)
    if (result === "not_found")
      return c.json(notFound("No delivery with that id."), 404)
    if (result === "pending") {
      return c.json(
        validation(
          "This delivery is still being attempted. Expunge it once it has finished.",
        ),
        409,
      )
    }
    return c.json({ id, payload_expunged: true })
  })

  // The event catalog (#283), the same list the API serves.
  app.get("/webhook-event-types", (c) => c.json({ data: WEBHOOK_EVENT_TYPES }))

  // Every change in an endpoint's health (#284): the console's event list.
  app.get("/webhook-health-events", async (c) => {
    if (!d.webhookHistory) return c.json(notWired("Webhook history"), 501)
    const q = c.req.query()
    return c.json(
      await d.webhookHistory.health(c.get("auth").tenantId, {
        ...(asId(q.endpoint_id) ? { endpointId: asId(q.endpoint_id)! } : {}),
        ...(asId(q.cursor) ? { cursor: asId(q.cursor)! } : {}),
        ...(q.limit ? { limit: Number(q.limit) || 50 } : {}),
      }),
    )
  })

  app.get("/webhook-deliveries", async (c) => {
    const { tenantId } = c.get("auth")
    const q = c.req.query()
    return c.json(
      await d.queries.listDeliveries(tenantId, {
        ...(asId(q.endpoint_id) ? { endpointId: asId(q.endpoint_id)! } : {}),
        ...(q.status === "pending" || q.status === "delivered" || q.status === "failed"
          ? { status: q.status }
          : {}),
        ...(q.event_type && /^[a-z_.]{1,64}$/.test(q.event_type)
          ? { eventType: q.event_type }
          : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.limit ? { limit: Number(q.limit) } : {}),
      }),
    )
  })
}

/** A stats window from the console's query string; a malformed one is a 422. */
function consoleWindow(q: Record<string, string>) {
  const parsed = statsQuery.safeParse({
    since: q.since || undefined,
    until: q.until || undefined,
    bucket: q.bucket || undefined,
  })
  if (!parsed.success) return { error: "Invalid window." }
  return windowFrom(parsed.data)
}
