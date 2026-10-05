import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import {
  webhookDeliveryDetailSchema,
  webhookDeliveryListSchema,
  webhookDeliverySchema,
} from "@repo/contracts"
import { requireApiKey } from "../middleware/auth.js"
import { errorResponse, notWired as notWiredFor } from "./shared.js"

/**
 * What happened to a workspace's webhooks: every delivery, and every attempt
 * at each (#281, the headless half of #182).
 *
 * ⚠ READ UNDER THE KEY'S TENANT, LIKE EVERYTHING ELSE. Another workspace's
 * delivery id answers 404, exactly as a made-up one does.
 */
export const webhookDeliveries = new OpenAPIHono()

webhookDeliverySchema.openapi("WebhookDelivery")
const List = webhookDeliveryListSchema.openapi("WebhookDeliveryList")
const Detail = webhookDeliveryDetailSchema.openapi("WebhookDeliveryDetail")
const notWired = notWiredFor("Webhook deliveries")
const notFound = {
  statusCode: 404,
  name: "not_found" as const,
  message: "No webhook delivery with that id.",
}
const idParam = z.object({
  id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
})

const list = createRoute({
  method: "get",
  path: "/",
  summary: "List webhook deliveries",
  description:
    "Newest first. Filter by endpoint, status, event type and time; page with " +
    "`cursor` from the previous response's `next_cursor`.",
  tags: ["Webhooks"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: {
    query: z.object({
      endpoint_id: z.uuid().optional(),
      status: z.enum(["pending", "delivered", "failed"]).optional(),
      event_type: z
        .string()
        .regex(/^[a-z_.]{1,64}$/)
        .optional(),
      after: z.iso.datetime({ offset: true }).optional(),
      before: z.iso.datetime({ offset: true }).optional(),
      cursor: z.string().max(512).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "A page of deliveries.",
      content: { "application/json": { schema: List } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    422: errorResponse("A filter is not acceptable."),
    501: errorResponse("Webhooks are not configured."),
  },
})

webhookDeliveries.openapi(
  list,
  async (c) => {
    const history = c.get("webhookHistory")
    if (!history) return c.json(notWired, 501)
    const q = c.req.valid("query")
    const page = await history.list(c.get("auth").tenantId, {
      ...(q.endpoint_id ? { endpointId: q.endpoint_id } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.event_type ? { eventType: q.event_type } : {}),
      ...(q.after ? { after: new Date(q.after) } : {}),
      ...(q.before ? { before: new Date(q.before) } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
    })
    return c.json(page, 200)
  },
  (result, c) => {
    if (!result.success) {
      return c.json(
        {
          statusCode: 422,
          name: "validation_error" as const,
          message: result.error.issues[0]?.message ?? "Invalid filter.",
        },
        422,
      )
    }
  },
)

const get = createRoute({
  method: "get",
  path: "/{id}",
  summary: "Get a webhook delivery and its attempts",
  description:
    "The delivery, what it carried, and every attempt with what was sent " +
    "(never the signature) and the first 20KB of what came back.",
  tags: ["Webhooks"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: { params: idParam },
  responses: {
    200: {
      description: "The delivery.",
      content: { "application/json": { schema: Detail } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    404: errorResponse("No such delivery for this API key's tenant."),
    501: errorResponse("Webhooks are not configured."),
  },
})

webhookDeliveries.openapi(get, async (c) => {
  const history = c.get("webhookHistory")
  if (!history) return c.json(notWired, 501)
  const detail = await history.get(c.get("auth").tenantId, c.req.valid("param").id)
  if (!detail) return c.json(notFound, 404)
  return c.json(detail, 200)
})

const expunge = createRoute({
  method: "delete",
  path: "/{id}/payload",
  summary: "Expunge a webhook delivery's payload",
  description:
    "Empties what a finished delivery carried, for good. The delivery and its " +
    "attempts stay, so the history still reads. A delivery still being " +
    "attempted answers 409: it would otherwise go out empty.",
  tags: ["Webhooks"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: { params: idParam },
  responses: {
    200: {
      description: "Expunged.",
      content: {
        "application/json": {
          schema: z.object({ id: z.uuid(), payload_expunged: z.literal(true) }),
        },
      },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    404: errorResponse("No such delivery for this API key's tenant."),
    409: errorResponse("The delivery is still being attempted."),
    501: errorResponse("Webhooks are not configured."),
  },
})

webhookDeliveries.openapi(expunge, async (c) => {
  const history = c.get("webhookHistory")
  if (!history) return c.json(notWired, 501)
  const { id } = c.req.valid("param")
  const result = await history.expunge(c.get("auth").tenantId, id)
  if (result === "not_found") return c.json(notFound, 404)
  if (result === "pending") {
    return c.json(
      {
        statusCode: 409,
        name: "validation_error" as const,
        message:
          "This delivery is still being attempted. Expunge it once it has finished.",
      },
      409,
    )
  }
  return c.json({ id, payload_expunged: true as const }, 200)
})
