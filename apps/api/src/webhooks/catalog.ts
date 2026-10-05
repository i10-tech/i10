import { WEBHOOK_EVENT_CATALOG, webhookEventData } from "@repo/contracts"
import { z } from "@hono/zod-openapi"
import { exampleData } from "./examples.js"

/**
 * The event catalog as served to people and machines (#283): the API's
 * `/webhook-event-types` and the console's catalog read the same list.
 * Computed once - the catalog is code, so it cannot change while we run.
 */
export const WEBHOOK_EVENT_TYPES = WEBHOOK_EVENT_CATALOG.map((e) => ({
  object: "webhook_event_type" as const,
  type: e.type,
  version: e.version,
  description: e.description,
  schema: z.toJSONSchema(webhookEventData[e.type]) as Record<string, unknown>,
  example: exampleData(e.type, new Date("2026-10-01T12:00:00Z")),
}))
