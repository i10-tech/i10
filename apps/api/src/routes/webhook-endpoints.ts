import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import {
  createWebhookEndpointSchema,
  rotateWebhookSecretSchema,
  sendTestEventSchema,
  createReplayMissingSchema,
  createReplaySchema,
  webhookReplaySchema,
  updateWebhookEndpointSchema,
  webhookEndpointStatsSchema,
  webhookEndpointListSchema,
  webhookEndpointSchema,
  webhookEndpointWithSecretSchema,
  webhookPollSchema,
} from "@repo/contracts"
import { requireApiKey } from "../middleware/auth.js"
import { invalidWindow, statsQuery, windowFrom } from "./webhook-stats.js"
import { errorResponse, notWired as notWiredFor } from "./shared.js"

/**
 * Managing where a customer's events go.
 *
 * ⚠ SEPARATE FROM `/webhooks`, WHICH IS INBOUND AND UNAUTHENTICATED. That
 * router receives Clerk's and Amazon's requests and is guarded by signatures;
 * this one is a customer API guarded by an API key. Putting both under one
 * prefix would mean one middleware mistake exposes the wrong half - and the
 * halves fail in opposite directions, so the mistake would not look like one.
 */
export const webhookEndpoints = new OpenAPIHono()

// ⚠ REGISTERED FOR ITS NAME, NOT FOR A LOCAL BINDING. The list schema is built
// from this one in @repo/contracts, so naming it here is what makes the
// generated document emit a `$ref` to `WebhookEndpoint` inside
// `WebhookEndpointList` rather than inlining the same object twice.
webhookEndpointSchema.openapi("WebhookEndpoint")
const WebhookEndpointWithSecret = webhookEndpointWithSecretSchema.openapi(
  "WebhookEndpointWithSecret",
)
const WebhookEndpointList = webhookEndpointListSchema.openapi("WebhookEndpointList")
const CreateWebhookEndpoint = createWebhookEndpointSchema.openapi(
  "CreateWebhookEndpoint",
)
const notWired = notWiredFor("Webhook endpoints")

const notFound = {
  statusCode: 404,
  name: "not_found" as const,
  message: "No webhook endpoint with that id.",
}

const create = createRoute({
  method: "post",
  path: "/",
  summary: "Create a webhook endpoint",
  description:
    "Registers an https URL to receive events. The signing secret is returned " +
    "here and never again - store it before you discard the response.",
  tags: ["Webhooks"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateWebhookEndpoint } },
    },
  },
  responses: {
    200: {
      description: "Created. `secret` is shown only in this response.",
      content: { "application/json": { schema: WebhookEndpointWithSecret } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    422: errorResponse("The URL or the event list is not acceptable."),
    501: errorResponse("Webhook endpoints are not configured."),
  },
})

webhookEndpoints.openapi(
  create,
  async (c) => {
    const store = c.get("webhookEndpoints")
    if (!store) return c.json(notWired, 501)

    const auth = c.get("auth")
    const body = c.req.valid("json")
    const created = await store.create(auth.tenantId, body)

    if (created.status === "rejected") {
      return c.json(
        { statusCode: 422, name: "validation_error" as const, message: created.reason },
        422,
      )
    }

    return c.json(created.endpoint, 200)
  },
  (result, c) => {
    if (!result.success) {
      return c.json(
        {
          statusCode: 422,
          name: "validation_error" as const,
          message: result.error.issues[0]?.message ?? "Invalid request body.",
        },
        422,
      )
    }
  },
)

const list = createRoute({
  method: "get",
  path: "/",
  summary: "List webhook endpoints",
  tags: ["Webhooks"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  responses: {
    200: {
      description: "Every endpoint for this tenant. Secrets are never included.",
      content: { "application/json": { schema: WebhookEndpointList } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    501: errorResponse("Webhook endpoints are not configured."),
  },
})

webhookEndpoints.openapi(list, async (c) => {
  const store = c.get("webhookEndpoints")
  if (!store) return c.json(notWired, 501)
  const auth = c.get("auth")
  return c.json({ data: await store.list(auth.tenantId) }, 200)
})

const remove = createRoute({
  method: "delete",
  path: "/{id}",
  summary: "Delete a webhook endpoint",
  description:
    "Deletes the endpoint and every delivery recorded against it. Pending " +
    "deliveries stop; already-sent ones are not recalled.",
  tags: ["Webhooks"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: {
    params: z.object({ id: z.uuid().openapi({ param: { name: "id", in: "path" } }) }),
  },
  responses: {
    200: {
      description: "Deleted.",
      content: {
        "application/json": {
          schema: z.object({
            object: z.literal("webhook_endpoint"),
            id: z.uuid(),
            deleted: z.literal(true),
          }),
        },
      },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    404: errorResponse("No such endpoint for this API key's tenant."),
    501: errorResponse("Webhook endpoints are not configured."),
  },
})

webhookEndpoints.openapi(remove, async (c) => {
  const store = c.get("webhookEndpoints")
  if (!store) return c.json(notWired, 501)

  const auth = c.get("auth")
  const { id } = c.req.valid("param")
  const deleted = await store.remove(auth.tenantId, id)

  // ⚠ 404 RATHER THAN 403 FOR SOMEBODY ELSE'S ENDPOINT, for the same reason as
  // the message lookup: row level security returns nothing, and a 403 would
  // confirm the id exists.
  if (!deleted) return c.json(notFound, 404)
  return c.json(
    { object: "webhook_endpoint" as const, id, deleted: true as const },
    200,
  )
})

const RotateWebhookSecret = rotateWebhookSecretSchema.openapi("RotateWebhookSecret")

const rotate = createRoute({
  method: "post",
  path: "/{id}/rotate-secret",
  summary: "Rotate a webhook signing secret",
  description:
    "Issues a new signing key and returns its secret once. You choose what " +
    'happens to the key it replaces: `previous_secret: "revoke"` stops it ' +
    'immediately; `previous_secret: "expire"` with `expires_in` (60 to ' +
    "259200 seconds, which is 72 hours) keeps it signing alongside the new one " +
    "so you can deploy the new secret first. While both are live, every " +
    "webhook carries one signature per key. At most 3 keys are live at once. " +
    "Pass `signature_scheme` to switch between HMAC and Ed25519.",
  tags: ["Webhooks"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: {
    params: z.object({ id: z.uuid().openapi({ param: { name: "id", in: "path" } }) }),
    body: {
      required: true,
      content: { "application/json": { schema: RotateWebhookSecret } },
    },
  },
  responses: {
    200: {
      description:
        "Rotated. `secret` is shown only in this response (null for Ed25519, " +
        "which you verify with `public_key`).",
      content: { "application/json": { schema: WebhookEndpointWithSecret } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    404: errorResponse("No such endpoint for this API key's tenant."),
    422: errorResponse(
      "No choice for the previous secret, an `expires_in` out of range, or too many live keys.",
    ),
    501: errorResponse("Webhook endpoints are not configured."),
  },
})

webhookEndpoints.openapi(
  rotate,
  async (c) => {
    const store = c.get("webhookEndpoints")
    if (!store) return c.json(notWired, 501)

    const auth = c.get("auth")
    const { id } = c.req.valid("param")
    const body = c.req.valid("json")
    const result = await store.rotateSecret(
      auth.tenantId,
      id,
      body.previous_secret === "expire"
        ? { action: "expire", expiresInSeconds: body.expires_in! }
        : { action: "revoke" },
      body.signature_scheme,
    )

    if (result.status === "not_found") return c.json(notFound, 404)
    if (result.status === "rejected") {
      return c.json(
        { statusCode: 422, name: "validation_error" as const, message: result.reason },
        422,
      )
    }
    return c.json(result.endpoint, 200)
  },
  (result, c) => {
    if (!result.success) {
      return c.json(
        {
          statusCode: 422,
          name: "validation_error" as const,
          message:
            result.error.issues[0]?.message ??
            "Say what happens to the current secret: `previous_secret` is `revoke` or `expire`.",
        },
        422,
      )
    }
  },
)

const revokePrevious = createRoute({
  method: "post",
  path: "/{id}/revoke-previous-secrets",
  summary: "Revoke previous webhook signing secrets",
  description:
    "Ends every grace period chosen at rotation, now. From this request on, " +
    "only the current key signs. Use it when a previous secret may have leaked.",
  tags: ["Webhooks"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: {
    params: z.object({ id: z.uuid().openapi({ param: { name: "id", in: "path" } }) }),
  },
  responses: {
    200: {
      description: "Revoked. `previous_secrets` is now empty.",
      content: { "application/json": { schema: webhookEndpointSchema } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    404: errorResponse("No such endpoint for this API key's tenant."),
    501: errorResponse("Webhook endpoints are not configured."),
  },
})

webhookEndpoints.openapi(revokePrevious, async (c) => {
  const store = c.get("webhookEndpoints")
  if (!store) return c.json(notWired, 501)

  const auth = c.get("auth")
  const { id } = c.req.valid("param")
  const endpoint = await store.revokePreviousSecrets(auth.tenantId, id)
  if (!endpoint) return c.json(notFound, 404)
  return c.json(endpoint, 200)
})

const UpdateWebhookEndpoint = updateWebhookEndpointSchema.openapi(
  "UpdateWebhookEndpoint",
)
const WebhookEndpointStats = webhookEndpointStatsSchema.openapi("WebhookEndpointStats")
const SendTestEvent = sendTestEventSchema.openapi("SendTestEvent")
const idParam = z.object({
  id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
})
const validationHook = (
  result: { success: boolean; error?: { issues: { message: string }[] } },
  c: { json: (body: unknown, status: 422) => Response },
) => {
  if (!result.success) {
    return c.json(
      {
        statusCode: 422,
        name: "validation_error" as const,
        message: result.error?.issues[0]?.message ?? "Invalid request body.",
      },
      422,
    )
  }
}

const getOne = createRoute({
  method: "get",
  path: "/{id}",
  summary: "Get a webhook endpoint",
  tags: ["Webhooks"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: { params: idParam },
  responses: {
    200: {
      description: "The endpoint. Never its secret, never its header values.",
      content: { "application/json": { schema: webhookEndpointSchema } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    404: errorResponse("No such endpoint for this API key's tenant."),
    501: errorResponse("Webhook endpoints are not configured."),
  },
})

webhookEndpoints.openapi(getOne, async (c) => {
  const store = c.get("webhookEndpoints")
  if (!store) return c.json(notWired, 501)
  const endpoint = await store.get(c.get("auth").tenantId, c.req.valid("param").id)
  return endpoint ? c.json(endpoint, 200) : c.json(notFound, 404)
})

const update = createRoute({
  method: "patch",
  path: "/{id}",
  summary: "Update a webhook endpoint",
  description:
    "Change any of its settings; `null` clears one that can be cleared. A new " +
    "`url` gets the same checks as a new endpoint. `enabled: false` pauses it " +
    "and `true` resumes it, clearing why it was switched off. `headers` " +
    "replaces the whole set.",
  tags: ["Webhooks"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: {
    params: idParam,
    body: {
      required: true,
      content: { "application/json": { schema: UpdateWebhookEndpoint } },
    },
  },
  responses: {
    200: {
      description: "Updated.",
      content: { "application/json": { schema: webhookEndpointSchema } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    404: errorResponse("No such endpoint for this API key's tenant."),
    422: errorResponse("A field is not acceptable."),
    501: errorResponse("Webhook endpoints are not configured."),
  },
})

webhookEndpoints.openapi(
  update,
  async (c) => {
    const store = c.get("webhookEndpoints")
    if (!store) return c.json(notWired, 501)
    const result = await store.update(
      c.get("auth").tenantId,
      c.req.valid("param").id,
      c.req.valid("json"),
    )
    if (result.status === "not_found") return c.json(notFound, 404)
    if (result.status === "rejected") {
      return c.json(
        { statusCode: 422, name: "validation_error" as const, message: result.reason },
        422,
      )
    }
    return c.json(result.endpoint, 200)
  },
  validationHook as never,
)

for (const [verb, enabled] of [
  ["pause", false],
  ["resume", true],
] as const) {
  const route = createRoute({
    method: "post",
    path: `/{id}/${verb}`,
    summary: enabled ? "Resume a webhook endpoint" : "Pause a webhook endpoint",
    description: enabled
      ? "Starts delivering again, and clears why it was switched off."
      : "Stops delivering. Events that happen while it is paused are not sent later.",
    tags: ["Webhooks"],
    security: [{ bearerAuth: [] }],
    middleware: [requireApiKey] as const,
    request: { params: idParam },
    responses: {
      200: {
        description: enabled ? "Resumed." : "Paused.",
        content: { "application/json": { schema: webhookEndpointSchema } },
      },
      401: errorResponse("The API key is missing, malformed, or unknown."),
      404: errorResponse("No such endpoint for this API key's tenant."),
      501: errorResponse("Webhook endpoints are not configured."),
    },
  })
  webhookEndpoints.openapi(route, async (c) => {
    const store = c.get("webhookEndpoints")
    if (!store) return c.json(notWired, 501)
    const result = await store.update(c.get("auth").tenantId, c.req.valid("param").id, {
      enabled,
    })
    if (result.status !== "updated") return c.json(notFound, 404)
    return c.json(result.endpoint, 200)
  })
}

const stats = createRoute({
  method: "get",
  path: "/{id}/stats",
  summary: "Get a webhook endpoint's delivery stats",
  description:
    "Deliveries created and attempts made between `since` and `until` " +
    "(default: the last 24 hours), in total, in `hour` or `day` steps (at most " +
    "200), and by event type. The error rate is `failed_attempts / attempts`.",
  tags: ["Webhooks"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: { params: idParam, query: statsQuery },
  responses: {
    200: {
      description: "The stats.",
      content: { "application/json": { schema: WebhookEndpointStats } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    404: errorResponse("No such endpoint for this API key's tenant."),
    422: errorResponse("The window is backwards, or has too many steps."),
    501: errorResponse("Webhook endpoints are not configured."),
  },
})

webhookEndpoints.openapi(
  stats,
  async (c) => {
    const store = c.get("webhookEndpoints")
    if (!store) return c.json(notWired, 501)
    const window = windowFrom(c.req.valid("query"))
    if ("error" in window) return c.json(invalidWindow(window.error), 422)
    const result = await store.stats(
      c.get("auth").tenantId,
      c.req.valid("param").id,
      window,
    )
    return result ? c.json(result, 200) : c.json(notFound, 404)
  },
  (result, c) => {
    if (!result.success)
      return c.json(invalidWindow(result.error.issues[0]?.message), 422)
  },
)

const Poll = webhookPollSchema.openapi("WebhookPoll")

const poll = createRoute({
  method: "get",
  path: "/{id}/poll",
  summary: "Poll a polling endpoint for its events",
  description:
    "For an endpoint created with `kind: polling`. Returns the events after " +
    "`cursor`, oldest first, each the same body an HTTP endpoint is POSTed. " +
    "Passing a cursor acknowledges every event up to it; without one, polling " +
    "resumes after the last acknowledged. Pass an older cursor to read events " +
    "again. Poll at least every 15 minutes while events are waiting, or the " +
    "endpoint is reported as failing.",
  tags: ["Webhooks"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: {
    params: idParam,
    query: z.object({
      cursor: z
        .string()
        .regex(/^\d{1,15}$/, "`cursor` is the `next_cursor` of a previous poll.")
        .optional(),
      limit: z.coerce.number().int().min(1).max(250).optional(),
    }),
  },
  responses: {
    200: {
      description: "The next page of events.",
      content: { "application/json": { schema: Poll } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    404: errorResponse("No such endpoint for this API key's tenant."),
    409: errorResponse("Not a polling endpoint, or it is paused."),
    422: errorResponse("The cursor is malformed or ahead of the stream."),
    501: errorResponse("Webhooks are not configured."),
  },
})

webhookEndpoints.openapi(
  poll,
  async (c) => {
    const history = c.get("webhookHistory")
    if (!history) return c.json(notWired, 501)
    const q = c.req.valid("query")
    const result = await history.poll(c.get("auth").tenantId, c.req.valid("param").id, {
      ...(q.cursor !== undefined ? { cursor: Number(q.cursor) } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    })
    switch (result.status) {
      case "not_found":
        return c.json(notFound, 404)
      case "not_polling":
      case "paused":
        return c.json(
          {
            statusCode: 409,
            name: "validation_error" as const,
            message:
              result.status === "paused"
                ? "This endpoint is paused or switched off. Resume it first."
                : "This endpoint is sent its events; only a `polling` endpoint is polled.",
          },
          409,
        )
      case "rejected":
        return c.json(
          {
            statusCode: 422,
            name: "validation_error" as const,
            message: result.reason,
          },
          422,
        )
      case "ok":
        return c.json(
          { data: result.data, next_cursor: result.next_cursor, done: result.done },
          200,
        )
    }
  },
  (result, c) => {
    if (!result.success)
      return c.json(
        {
          statusCode: 422,
          name: "validation_error" as const,
          message: result.error.issues[0]?.message ?? "Invalid poll.",
        },
        422,
      )
  },
)

const test = createRoute({
  method: "post",
  path: "/{id}/test",
  summary: "Send a test event to a webhook endpoint",
  description:
    "Sends a realistic sample of `event_type`, with `test: true` in its data. " +
    "It is a real delivery: signed with the endpoint's keys, retried and " +
    "logged like any other, so it shows exactly what your receiver will see.",
  tags: ["Webhooks"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: {
    params: idParam,
    body: {
      required: true,
      content: { "application/json": { schema: SendTestEvent } },
    },
  },
  responses: {
    202: {
      description: "Queued. Follow it with `GET /webhook-deliveries/{delivery_id}`.",
      content: { "application/json": { schema: z.object({ delivery_id: z.uuid() }) } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    404: errorResponse("No such endpoint for this API key's tenant."),
    409: errorResponse("The endpoint is paused or switched off."),
    422: errorResponse("Not an event type."),
    501: errorResponse("Webhooks are not configured."),
  },
})

webhookEndpoints.openapi(
  test,
  async (c) => {
    const send = c.get("webhookTests")
    if (!send) return c.json(notWired, 501)
    const result = await send(
      c.get("auth").tenantId,
      c.req.valid("param").id,
      c.req.valid("json").event_type,
    )
    if (result.status === "not_found") return c.json(notFound, 404)
    if (result.status === "paused") {
      return c.json(
        {
          statusCode: 409,
          name: "validation_error" as const,
          message: "This endpoint is paused or switched off. Resume it first.",
        },
        409,
      )
    }
    return c.json({ delivery_id: result.deliveryId }, 202)
  },
  validationHook as never,
)

const Replay = webhookReplaySchema.openapi("WebhookReplay")
const CreateReplay = createReplaySchema.openapi("CreateReplay")
const CreateReplayMissing = createReplayMissingSchema.openapi("CreateReplayMissing")
const replayResponses = {
  202: {
    description: "Started. Poll `GET /webhook-endpoints/{id}/replays/{replay_id}`.",
    content: { "application/json": { schema: Replay } },
  },
  401: errorResponse("The API key is missing, malformed, or unknown."),
  404: errorResponse("No such endpoint for this API key's tenant."),
  409: errorResponse("The endpoint is paused or switched off."),
  422: errorResponse("The window is not acceptable."),
  501: errorResponse("Webhooks are not configured."),
}

const startReplay = async (
  c: Parameters<Parameters<typeof webhookEndpoints.openapi>[1]>[0],
  kind: "replay" | "replay_missing",
  body: {
    since: string
    until?: string | undefined
    statuses?: ("delivered" | "failed")[]
    event_type?: string
  },
) => {
  const replays = c.get("webhookReplays")
  if (!replays) return c.json(notWired, 501)
  const result = await replays.create(
    c.get("auth").tenantId,
    c.req.param("id")!,
    kind,
    {
      since: new Date(body.since),
      ...(body.until ? { until: new Date(body.until) } : {}),
      ...(body.statuses ? { statuses: body.statuses } : {}),
      ...(body.event_type ? { eventType: body.event_type } : {}),
    },
  )
  if (result.status === "not_found") return c.json(notFound, 404)
  if (result.status === "paused") {
    return c.json(
      {
        statusCode: 409,
        name: "validation_error" as const,
        message: "This endpoint is paused or switched off. Resume it first.",
      },
      409,
    )
  }
  if (result.status === "rejected") {
    return c.json(
      { statusCode: 422, name: "validation_error" as const, message: result.reason },
      422,
    )
  }
  return c.json(result.replay, 202)
}

webhookEndpoints.openapi(
  createRoute({
    method: "post",
    path: "/{id}/replay",
    summary: "Replay a webhook endpoint's deliveries",
    description:
      "Sends this endpoint's deliveries from the window again, in the background, " +
      'one attempt each. `statuses` defaults to `["failed"]`, which replays ' +
      'failures only; pass `["delivered", "failed"]` for everything. At most ' +
      "31 days per replay.",
    tags: ["Webhooks"],
    security: [{ bearerAuth: [] }],
    middleware: [requireApiKey] as const,
    request: {
      params: idParam,
      body: {
        required: true,
        content: { "application/json": { schema: CreateReplay } },
      },
    },
    responses: replayResponses,
  }),
  (c) => startReplay(c as never, "replay", c.req.valid("json")) as never,
  validationHook as never,
)

webhookEndpoints.openapi(
  createRoute({
    method: "post",
    path: "/{id}/recover",
    summary: "Recover a webhook endpoint's failed deliveries",
    description:
      "Replay with failures only: every delivery that failed in the window, sent again.",
    tags: ["Webhooks"],
    security: [{ bearerAuth: [] }],
    middleware: [requireApiKey] as const,
    request: {
      params: idParam,
      body: {
        required: true,
        content: { "application/json": { schema: CreateReplayMissing } },
      },
    },
    responses: replayResponses,
  }),
  (c) =>
    startReplay(c as never, "replay", {
      ...c.req.valid("json"),
      statuses: ["failed"],
    }) as never,
  validationHook as never,
)

webhookEndpoints.openapi(
  createRoute({
    method: "post",
    path: "/{id}/replay-missing",
    summary: "Send a webhook endpoint the events it never received",
    description:
      "Every event in the window this endpoint is subscribed to (and passes its " +
      "filters) but never got a delivery for, because it did not exist yet or " +
      "was paused. Built from the stored event, exactly as it would have been.",
    tags: ["Webhooks"],
    security: [{ bearerAuth: [] }],
    middleware: [requireApiKey] as const,
    request: {
      params: idParam,
      body: {
        required: true,
        content: { "application/json": { schema: CreateReplayMissing } },
      },
    },
    responses: replayResponses,
  }),
  (c) => startReplay(c as never, "replay_missing", c.req.valid("json")) as never,
  validationHook as never,
)

webhookEndpoints.openapi(
  createRoute({
    method: "get",
    path: "/{id}/replays",
    summary: "List a webhook endpoint's replays",
    tags: ["Webhooks"],
    security: [{ bearerAuth: [] }],
    middleware: [requireApiKey] as const,
    request: { params: idParam },
    responses: {
      200: {
        description: "The latest 50, newest first.",
        content: {
          "application/json": { schema: z.object({ data: z.array(Replay) }) },
        },
      },
      401: errorResponse("The API key is missing, malformed, or unknown."),
      501: errorResponse("Webhooks are not configured."),
    },
  }),
  async (c) => {
    const replays = c.get("webhookReplays")
    if (!replays) return c.json(notWired, 501)
    return c.json(
      { data: await replays.list(c.get("auth").tenantId, c.req.valid("param").id) },
      200,
    )
  },
)

webhookEndpoints.openapi(
  createRoute({
    method: "get",
    path: "/{id}/replays/{replay_id}",
    summary: "Get a replay's progress",
    tags: ["Webhooks"],
    security: [{ bearerAuth: [] }],
    middleware: [requireApiKey] as const,
    request: {
      params: idParam.extend({
        replay_id: z.uuid().openapi({ param: { name: "replay_id", in: "path" } }),
      }),
    },
    responses: {
      200: {
        description: "The replay.",
        content: { "application/json": { schema: Replay } },
      },
      401: errorResponse("The API key is missing, malformed, or unknown."),
      404: errorResponse("No such replay."),
      501: errorResponse("Webhooks are not configured."),
    },
  }),
  async (c) => {
    const replays = c.get("webhookReplays")
    if (!replays) return c.json(notWired, 501)
    const { id, replay_id } = c.req.valid("param")
    const replay = await replays.get(c.get("auth").tenantId, replay_id)
    if (!replay || replay.endpoint_id !== id) {
      return c.json(
        { statusCode: 404, name: "not_found" as const, message: "No such replay." },
        404,
      )
    }
    return c.json(replay, 200)
  },
)
