import { createRoute, OpenAPIHono } from "@hono/zod-openapi"
import {
  WEBHOOK_EVENT_CATALOG,
  webhookEventTypeListSchema,
  webhookPayloadSchema,
} from "@repo/contracts"
import { requireApiKey } from "../middleware/auth.js"
import { WEBHOOK_EVENT_TYPES } from "../webhooks/catalog.js"
import { errorResponse } from "./shared.js"

/**
 * The event catalog (#283), for machines: every event type, its version, a
 * JSON Schema for its `data`, and a realistic example. The docs and the
 * console's catalog are built from this, so there is one definition.
 */
export const webhookEventTypes = new OpenAPIHono()

const List = webhookEventTypeListSchema.openapi("WebhookEventTypeList")

webhookEventTypes.openapi(
  createRoute({
    method: "get",
    path: "/",
    summary: "List webhook event types",
    description:
      "Every event i10 can send, with a JSON Schema for its `data` and an " +
      "example. Payloads are checked against these schemas in i10's own tests, " +
      "on every route mail can take.",
    tags: ["Webhooks"],
    security: [{ bearerAuth: [] }],
    middleware: [requireApiKey] as const,
    responses: {
      200: {
        description: "The catalog.",
        content: { "application/json": { schema: List } },
      },
      401: errorResponse("The API key is missing, malformed, or unknown."),
    },
  }),
  (c) => c.json({ data: WEBHOOK_EVENT_TYPES }, 200),
)

/**
 * Registers every event as an OpenAPI 3.1 `webhooks` entry, so the published
 * document describes what we POST to customers, not only what they call.
 */
export function registerWebhookEvents(registry: {
  registerWebhook: (route: Parameters<typeof createRoute>[0]) => void
}): void {
  for (const e of WEBHOOK_EVENT_CATALOG) {
    const name = e.type
      .split(/[._]/)
      .map((p) => p[0]!.toUpperCase() + p.slice(1))
      .join("")
    registry.registerWebhook({
      method: "post",
      path: e.type,
      summary: e.type,
      description:
        `${e.description} Version ${e.version}. Signed per Standard Webhooks; ` +
        "dedupe on `id`, which is also the `webhook-id` header.",
      tags: ["Webhook events"],
      request: {
        body: {
          content: {
            "application/json": {
              schema: webhookPayloadSchema(e.type).openapi(`${name}Event`),
            },
          },
        },
      },
      responses: {
        200: { description: "Any 2xx acknowledges it; anything else is retried." },
      },
    })
  }
}
