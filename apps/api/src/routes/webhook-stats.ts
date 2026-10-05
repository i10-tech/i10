import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { webhookStatsSchema } from "@repo/contracts"
import { requireApiKey } from "../middleware/auth.js"
import { statsWindow, type StatsWindow } from "../webhooks/stats.js"
import { errorResponse, notWired as notWiredFor } from "./shared.js"

/** The window a stats request names: `since`, `until`, `bucket`. Shared by both routes. */
export const statsQuery = z.object({
  since: z.iso.datetime({ offset: true }).optional(),
  until: z.iso.datetime({ offset: true }).optional(),
  bucket: z.enum(["hour", "day"]).optional(),
})

export const windowFrom = (
  q: z.infer<typeof statsQuery>,
): StatsWindow | { error: string } =>
  statsWindow({
    ...(q.since ? { since: new Date(q.since) } : {}),
    ...(q.until ? { until: new Date(q.until) } : {}),
    ...(q.bucket ? { bucket: q.bucket } : {}),
  })

export const invalidWindow = (message?: string) => ({
  statusCode: 422,
  name: "validation_error" as const,
  message: message ?? "Invalid window.",
})

/**
 * Stats across every endpoint in the workspace (#300): the console's overview,
 * and the per-endpoint error rates its list shows.
 */
export const webhookStats = new OpenAPIHono()

const Stats = webhookStatsSchema.openapi("WebhookStats")

const get = createRoute({
  method: "get",
  path: "/",
  summary: "Get webhook stats for the workspace",
  description:
    "Deliveries created and attempts made between `since` and `until` " +
    "(default: the last 24 hours) across every endpoint: in total, in `hour` " +
    "or `day` steps (at most 200), by event type, and by endpoint.",
  tags: ["Webhooks"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: { query: statsQuery },
  responses: {
    200: {
      description: "The stats.",
      content: { "application/json": { schema: Stats } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    422: errorResponse("The window is backwards, or has too many steps."),
    501: errorResponse("Webhook endpoints are not configured."),
  },
})

webhookStats.openapi(
  get,
  async (c) => {
    const store = c.get("webhookEndpoints")
    if (!store) return c.json(notWiredFor("Webhook endpoints"), 501)
    const window = windowFrom(c.req.valid("query"))
    if ("error" in window) return c.json(invalidWindow(window.error), 422)
    return c.json(await store.workspaceStats(c.get("auth").tenantId, window), 200)
  },
  (result, c) => {
    if (!result.success)
      return c.json(invalidWindow(result.error.issues[0]?.message), 422)
  },
)
