import type { Context, Hono } from "hono"
import { WEBHOOK_EVENT_TYPES } from "../../webhooks/catalog.js"
import { statsQuery, windowFrom } from "../webhook-stats.js"
import { DELIVERY_HTTP_CLASSES } from "../../webhooks/history.js"
import { POLLING_REPLAY } from "../../webhooks/replay.js"
import {
  createReplayMissingSchema,
  createWebhookEndpointSchema,
  createReplaySchema,
  rotateWebhookSecretSchema,
  sendTestEventSchema,
  testWebhookTransformationSchema,
  updateWebhookEndpointSchema,
} from "@repo/contracts"
import { cacheKeyFor } from "../../auth/api-key.js"
import { revokeKey, rotateKey } from "../../auth/key-actions.js"
import { domainScope, scopedDomains } from "../../auth/scope.js"
import { requireFreshAuth } from "../../middleware/session.js"
import { keyAccess, type KeyAccess } from "../../console/api-key-access.js"
import type { AuditEvent } from "../../identity/ports.js"
import type { KeySummary } from "../../auth/store.js"
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

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

export function mountCredentials(app: Hono, d: ConsoleDeps): void {
  // ───────────────────────────────────────────────────────────────────────────
  // API keys
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * ⚠ EVERY KEY ROUTE ASKS `keyAccess` - see console/api-key-access.ts for the
   * rules. A member reaches only the keys they created; admins and owners all
   * of them; the keys of a deprovisioned person are an owner's alone.
   *
   * ⚠ NOT YOURS IS A 404, NOT A 403. The list never shows a member another
   * person's key, so an id that is not theirs must answer exactly as an id that
   * does not exist - a 403 would confirm that the key is there. A key the
   * caller CAN see but may not touch (its creator was deprovisioned) is a 403,
   * because hiding it would contradict the list.
   *
   * ⚠ EVERY CHANGE IS AUDITED WITH ITS ACTOR, in the identity audit log. The
   * change has already happened by then and, for a create or a rotation, the
   * secret exists nowhere else: a failed audit write is logged loudly and does
   * not take the response with it.
   */
  const audit = async (tenantId: string, event: AuditEvent) => {
    try {
      if (!d.identity) {
        d.log.warn(
          { tenantId, type: event.type },
          "an API key changed but the audit log is not wired",
        )
        return
      }
      await d.identity.store.record(tenantId, event)
    } catch (error) {
      d.log.error(
        { err: String(error), tenantId, type: event.type },
        "an API key changed but its audit event could not be written",
      )
    }
  }

  /** The key, if the caller may act on it; otherwise the response to give. */
  const authorize = async (
    c: Context,
    id: string | undefined,
  ): Promise<{ key: KeySummary; access: KeyAccess } | { refusal: Response }> => {
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const missing = { refusal: c.json(notFound("No such key."), 404) }
    if (!id || !d.keys) return missing
    const key = await d.keys.store.get(tenantId, id)
    if (!key) return missing
    const access = await keyAccess(d, tenantId, userId)
    const verdict = await access.decide(key)
    if (verdict === "hidden") return missing
    if (verdict === "owner_only") {
      return {
        refusal: c.json(
          forbidden(
            "The person who created this key left the workspace. Only an owner can change it.",
          ),
          403,
        ),
      }
    }
    return { key, access }
  }

  app.get("/api-keys", async (c) => {
    if (!d.keys) return c.json(notWired("API keys"), 501)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const access = await keyAccess(d, tenantId, userId)
    const verdicts = new Map<string, "allowed" | "owner_only">()
    const keys: KeySummary[] = []
    for (const k of await d.keys.store.list(tenantId)) {
      const verdict = await access.decide(k)
      if (verdict === "hidden") continue
      verdicts.set(k.id, verdict)
      keys.push(k)
    }
    const people = await creatorsOf(d, keys)
    return c.json({
      data: keys.map((k) => {
        const actionable = verdicts.get(k.id) === "allowed" && k.revokedAt === null
        return {
          // ⚠ THE FLAGS ARE THE ROUTES' OWN ANSWER, so the console hides exactly
          // what the API would refuse.
          can_rotate: actionable,
          can_revoke: actionable,
          can_edit: actionable,
          created_by: k.createdBy
            ? (people.get(k.createdBy) ?? { id: k.createdBy, name: null, email: null })
            : null,
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
        }
      }),
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

      await audit(tenantId, {
        type: "api_key.created",
        actorUserId: userId,
        subjectUserId: userId,
        data: {
          keyId: created.id,
          name: created.name,
          mode: created.mode,
          domains: scopedDomains(created.scopes),
        },
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
  /*
   * ⚠ STEP-UP, BECAUSE THIS IS A PERMISSION CHANGE ON A LIVE CREDENTIAL. A
   * stolen session could widen a key narrowed to staging and send as
   * production; narrowing is the same request with the same risk of being
   * somebody else's. See `requireFreshAuth`.
   */
  app.patch("/api-keys/:id", requireFreshAuth, async (c) => {
    if (!d.keys) return c.json(notWired("API keys"), 501)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const id = asId(c.req.param("id"))
    const found = await authorize(c, id)
    if ("refusal" in found) return found.refusal
    const body = await readJson(c)

    const scope = await resolveScope(d, tenantId, body?.domains)
    if (!scope.ok) return c.json(validation(scope.error), 422)

    const updated = await d.keys.store.setScopes(tenantId, id!, scope.scopes)
    // Revoked: the same answer as a key that is not there.
    if (!updated) return c.json(notFound("No such key."), 404)

    await audit(tenantId, {
      type: "api_key.scope_changed",
      actorUserId: userId,
      subjectUserId: found.key.createdBy,
      data: {
        keyId: id,
        name: found.key.name,
        from: scopedDomains(found.key.scopes),
        to: scopedDomains(updated.key.scopes),
      },
    })

    if (d.keys.cache) {
      try {
        await d.keys.cache.del(cacheKeyFor(updated.secretHash))
      } catch (error) {
        d.log.error(
          { err: String(error), tenantId, keyId: id },
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
    const { userId } = c.get("user")
    const id = asId(c.req.param("id"))
    const found = await authorize(c, id)
    if ("refusal" in found) return found.refusal

    const revoked = await revokeKey(d.keys, tenantId, id!, d.log)
    if (revoked.status === "not_found")
      return c.json(notFound("No key with that id."), 404)
    // ⚠ AUDITED BEFORE THE CACHE VERDICT: the row is revoked either way.
    await audit(tenantId, {
      type: "api_key.revoked",
      actorUserId: userId,
      subjectUserId: found.key.createdBy,
      data: { keyId: id, name: found.key.name },
    })
    // ⚠ A 500, NOT A SUCCESS: see `revokeKey` for why the cache half matters.
    if (revoked.status === "cache_failed") {
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

    return c.json({ id, deleted: true })
  })

  /*
   * ⚠ STEP-UP, BECAUSE THE OLD KEY DIES THE MOMENT THIS RETURNS AND A NEW
   * SECRET IS HANDED OVER. A stolen session could otherwise mint itself a
   * working credential and cut the real one off.
   */
  app.post("/api-keys/:id/rotate", requireFreshAuth, async (c) => {
    if (!d.keys) return c.json(notWired("API keys"), 501)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const id = asId(c.req.param("id"))
    const found = await authorize(c, id)
    if ("refusal" in found) return found.refusal

    const rotated = await rotateKey(d.keys, tenantId, id!, d.log)
    if (rotated.status === "not_found")
      return c.json(notFound("No key with that id."), 404)
    await audit(tenantId, {
      type: "api_key.rotated",
      actorUserId: userId,
      subjectUserId: found.key.createdBy,
      data: { keyId: id, name: found.key.name, newKeyId: rotated.created.id },
    })

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

  /**
   * ⚠ THE WHOLE CREATE CONTRACT, AS THE PUBLIC API TAKES IT. This route once
   * picked out `url`, `events`, `description` and the scheme by hand, so a
   * polling or SQS endpoint, headers, filters and a rate limit could be made
   * through the API and not through the console.
   */
  app.post("/webhook-endpoints", async (c) => {
    if (!d.webhooks) return c.json(notWired("Webhooks"), 501)
    const { tenantId } = c.get("auth")
    const parsed = createWebhookEndpointSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      return c.json(
        validation(parsed.error.issues[0]?.message ?? "Invalid endpoint."),
        422,
      )
    }

    const created = await d.webhooks.create(tenantId, parsed.data)
    return created.status === "created"
      ? c.json(created.endpoint, 201)
      : c.json(validation(created.reason), 422)
  })

  app.get("/webhook-endpoints/:id", async (c) => {
    if (!d.webhooks) return c.json(notWired("Webhooks"), 501)
    const id = asId(c.req.param("id"))
    if (!id) return c.json(notFound("No endpoint with that id."), 404)
    const endpoint = await d.webhooks.get(c.get("auth").tenantId, id)
    return endpoint
      ? c.json(endpoint)
      : c.json(notFound("No endpoint with that id."), 404)
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

  // Try a transformation on an example event (#302): saves and sends nothing.
  app.post("/webhook-endpoints/:id/transformation/test", async (c) => {
    if (!d.webhooks) return c.json(notWired("Webhooks"), 501)
    const id = asId(c.req.param("id"))
    if (!id) return c.json(notFound("No endpoint with that id."), 404)
    const parsed = testWebhookTransformationSchema.safeParse(await readJson(c))
    if (!parsed.success)
      return c.json(validation("Send `code` and an `event_type`."), 422)
    const result = await d.webhooks.testTransformation(c.get("auth").tenantId, id, {
      ...(parsed.data.code !== undefined ? { code: parsed.data.code } : {}),
      ...(parsed.data.event_type !== undefined
        ? { eventType: parsed.data.event_type }
        : {}),
    })
    if (result.status === "not_found")
      return c.json(notFound("No endpoint with that id."), 404)
    if (result.status === "rejected") return c.json(validation(result.reason), 422)
    if (result.status === "unavailable") return c.json(validation(result.reason), 503)
    return c.json(result.result)
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
    if (result.status === "polling") return c.json(validation(POLLING_REPLAY), 409)
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
    const since = asDate(q.since)
    const until = asDate(q.until)
    const httpClass = DELIVERY_HTTP_CLASSES.find((band) => band === q.http_class)
    return c.json(
      await d.queries.listDeliveries(tenantId, {
        ...(asId(q.endpoint_id) ? { endpointId: asId(q.endpoint_id)! } : {}),
        ...(q.status === "pending" || q.status === "delivered" || q.status === "failed"
          ? { status: q.status }
          : {}),
        ...(q.event_type && /^[a-z_.]{1,64}$/.test(q.event_type)
          ? { eventType: q.event_type }
          : {}),
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
        ...(httpClass ? { httpClass } : {}),
        // ⚠ PASSED ON EVEN WHEN IT CANNOT BE AN ID, so "acme" answers "no
        // delivery matches" rather than quietly showing every delivery.
        ...(q.q?.trim() ? { q: q.q } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.limit ? { limit: Number(q.limit) } : {}),
      }),
    )
  })
}

/**
 * Who made each key, as the Team page names people: Clerk's name and primary
 * address. A person Clerk cannot answer for still shows by id - the list must
 * not fail because one lookup did.
 */
async function creatorsOf(d: ConsoleDeps, keys: KeySummary[]) {
  const ids = [...new Set(keys.flatMap((k) => (k.createdBy ? [k.createdBy] : [])))]
  const found = new Map<
    string,
    { id: string; name: string | null; email: string | null }
  >()
  if (!d.people) return found
  const people = d.people
  await Promise.all(
    ids.map(async (id) => {
      try {
        const p = await people.get(id)
        found.set(id, { id, name: p.name || null, email: p.primaryEmail })
      } catch (error) {
        d.log.warn({ err: String(error) }, "could not name the creator of an API key")
      }
    }),
  )
  return found
}

/** A time from the console's query string, or nothing when it is not one. */
function asDate(value: string | undefined): Date | undefined {
  if (!value) return undefined
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? undefined : at
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
