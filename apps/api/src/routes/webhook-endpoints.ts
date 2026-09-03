import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import {
  createWebhookEndpointSchema,
  webhookEndpointListSchema,
  webhookEndpointSchema,
  webhookEndpointWithSecretSchema,
} from "@repo/contracts"
import { requireApiKey } from "../middleware/auth.js"
import { errorResponse, notWired as notWiredFor } from "./shared.js"

/**
 * Managing where a customer's events go.
 *
 * ⚠ SEPARATE FROM `/webhooks`, WHICH IS INBOUND AND UNAUTHENTICATED. That
 * router receives Clerk's and Amazon's requests and is guarded by signatures;
 * this one is a customer API guarded by an API key. Putting both under one
 * prefix would mean one middleware mistake exposes the wrong half — and the
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
    "here and never again — store it before you discard the response.",
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

const rotate = createRoute({
  method: "post",
  path: "/{id}/rotate-secret",
  summary: "Rotate a webhook signing secret",
  description:
    "Issues a new signing secret and returns it once. ⚠ The old secret stops " +
    "working immediately — deliveries in flight are signed with whichever " +
    "secret was current when they were signed, so update your receiver first " +
    "or accept a short window of rejected deliveries.",
  tags: ["Webhooks"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: {
    params: z.object({ id: z.uuid().openapi({ param: { name: "id", in: "path" } }) }),
  },
  responses: {
    200: {
      description: "Rotated. `secret` is shown only in this response.",
      content: { "application/json": { schema: WebhookEndpointWithSecret } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    404: errorResponse("No such endpoint for this API key's tenant."),
    501: errorResponse("Webhook endpoints are not configured."),
  },
})

webhookEndpoints.openapi(rotate, async (c) => {
  const store = c.get("webhookEndpoints")
  if (!store) return c.json(notWired, 501)

  const auth = c.get("auth")
  const { id } = c.req.valid("param")
  const rotated = await store.rotateSecret(auth.tenantId, id)

  if (!rotated) return c.json(notFound, 404)
  return c.json(rotated, 200)
})
