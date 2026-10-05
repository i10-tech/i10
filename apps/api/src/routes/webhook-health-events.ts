import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { webhookHealthEventListSchema, webhookHealthEventSchema } from "@repo/contracts"
import { requireApiKey } from "../middleware/auth.js"
import { errorResponse, notWired as notWiredFor } from "./shared.js"

/**
 * Every change in a workspace's endpoints' health (#284): failing, disabled,
 * recovered. The same changes are emailed to the owner and sent as
 * `webhook_endpoint.*` webhooks; this is the record of them.
 */
export const webhookHealthEvents = new OpenAPIHono()

webhookHealthEventSchema.openapi("WebhookHealthEvent")
const List = webhookHealthEventListSchema.openapi("WebhookHealthEventList")

const list = createRoute({
  method: "get",
  path: "/",
  summary: "List webhook endpoint health changes",
  description:
    "Newest first: each time an endpoint started failing (15 minutes with no " +
    "successful delivery), was switched off, or recovered. Page with `cursor` " +
    "from the previous response's `next_cursor`.",
  tags: ["Webhooks"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: {
    query: z.object({
      endpoint_id: z.uuid().optional(),
      cursor: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "A page of changes.",
      content: { "application/json": { schema: List } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    422: errorResponse("A filter is not acceptable."),
    501: errorResponse("Webhooks are not configured."),
  },
})

webhookHealthEvents.openapi(
  list,
  async (c) => {
    const history = c.get("webhookHistory")
    if (!history) return c.json(notWiredFor("Webhook history"), 501)
    const q = c.req.valid("query")
    const page = await history.health(c.get("auth").tenantId, {
      ...(q.endpoint_id ? { endpointId: q.endpoint_id } : {}),
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
