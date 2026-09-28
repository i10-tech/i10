import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import {
  createSuppressionSchema,
  suppressionListSchema,
  suppressionSchema,
} from "@repo/contracts"
import type { MiddlewareHandler } from "hono"
import { isRestricted } from "../auth/scope.js"
import type { SuppressionRow } from "../console/queries.js"
import { requireApiKey } from "../middleware/auth.js"
import { removalRefusal } from "../suppressions/store.js"
import { errorResponse, notWired as notWiredFor } from "./shared.js"

/**
 * The workspace's suppression list over the API (#159): list, add, remove.
 *
 * ⚠ THE SAME STORE AS THE CONSOLE, SO THE SAME TWO RULES. Removing a complaint
 * needs `confirm=complaint`, and a removal reaches SES's copy of the list
 * before ours - see suppressions/store.ts.
 *
 * ⚠ A DOMAIN-RESTRICTED KEY IS REFUSED ON EVERY METHOD, READS INCLUDED. The list
 * is workspace-wide - one address, whichever domain bounced it - so a key scoped
 * to `a.com` reading it would see addresses `b.com`'s mail produced, and a
 * removal would unblock them for `b.com` too.
 */
export const suppressionRoutes = new OpenAPIHono()

// ⚠ REGISTERED FOR ITS NAME, as `WebhookEndpoint` is: the list schema is built
// from this one, so naming it makes the document `$ref` it instead of inlining.
suppressionSchema.openapi("Suppression")
const SuppressionList = suppressionListSchema.openapi("SuppressionList")
const CreateSuppression = createSuppressionSchema.openapi("CreateSuppression")
const notWired = notWiredFor("Suppressions")

const restricted = {
  statusCode: 403,
  name: "restricted_api_key" as const,
  message:
    "This key is restricted to a domain, and the suppression list belongs to the " +
    "whole workspace. Use an unrestricted key.",
}

const unrestricted: MiddlewareHandler = async (c, next) => {
  if (isRestricted(c.get("auth").scopes)) return c.json(restricted, 403)
  return next()
}

const present = (r: SuppressionRow) => ({
  object: "suppression" as const,
  address: r.address,
  reason: r.reason as z.infer<typeof suppressionSchema>["reason"],
  message_id: r.message_id,
  created_at: r.created_at,
})

const common = {
  tags: ["Suppressions"],
  security: [{ bearerAuth: [] }],
}

const denied = {
  401: errorResponse("The API key is missing, malformed, or unknown."),
  403: errorResponse("The key is restricted to a domain."),
  501: errorResponse("Suppressions are not configured."),
}

const list = createRoute({
  ...common,
  middleware: [requireApiKey, unrestricted] as const,
  method: "get",
  path: "/",
  summary: "List suppressed addresses",
  description:
    "Newest first. Addresses here are skipped at send, whichever domain the " +
    "message is from.",
  request: {
    query: z.object({
      search: z.string().max(200).optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  },
  responses: {
    200: {
      description: "A page of the list.",
      content: { "application/json": { schema: SuppressionList } },
    },
    ...denied,
  },
})

suppressionRoutes.openapi(list, async (c) => {
  const store = c.get("suppressions")
  if (!store) return c.json(notWired, 501)
  const { search, cursor, limit } = c.req.valid("query")
  const page = await store.list(c.get("auth").tenantId, {
    ...(search ? { search } : {}),
    ...(cursor ? { cursor } : {}),
    ...(limit ? { limit } : {}),
  })
  return c.json({ data: page.data.map(present), next_cursor: page.nextCursor }, 200)
})

const create = createRoute({
  ...common,
  middleware: [requireApiKey, unrestricted] as const,
  method: "post",
  path: "/",
  summary: "Suppress an address",
  description: "Idempotent: suppressing an address that already is changes nothing.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateSuppression } },
    },
  },
  responses: {
    201: {
      description: "Suppressed.",
      content: {
        "application/json": {
          schema: z.object({ address: z.string(), suppressed: z.literal(true) }),
        },
      },
    },
    422: errorResponse("The address is not acceptable."),
    ...denied,
  },
})

suppressionRoutes.openapi(
  create,
  async (c) => {
    const store = c.get("suppressions")
    if (!store) return c.json(notWired, 501)
    const { address } = c.req.valid("json")
    await store.add(c.get("auth").tenantId, address)
    return c.json({ address: address.toLowerCase(), suppressed: true as const }, 201)
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

const remove = createRoute({
  ...common,
  middleware: [requireApiKey, unrestricted] as const,
  method: "delete",
  path: "/{address}",
  summary: "Remove a suppressed address",
  description:
    "Mail to the address is sent again. If it bounces or complains again it is " +
    "suppressed again automatically. ⚠ An address suppressed for a complaint " +
    "needs `confirm=complaint`: its recipient marked your mail as spam.",
  request: {
    params: z.object({
      address: z.string().openapi({ param: { name: "address", in: "path" } }),
    }),
    query: z.object({ confirm: z.literal("complaint").optional() }),
  },
  responses: {
    200: {
      description: "Removed, here and at our sending provider.",
      content: {
        "application/json": {
          schema: z.object({
            object: z.literal("suppression"),
            address: z.string(),
            deleted: z.literal(true),
          }),
        },
      },
    },
    404: errorResponse("The address is not suppressed."),
    409: errorResponse("The address complained; repeat with `confirm=complaint`."),
    503: errorResponse("Our sending provider could not be updated; nothing changed."),
    ...denied,
  },
})

suppressionRoutes.openapi(remove, async (c) => {
  const store = c.get("suppressions")
  if (!store) return c.json(notWired, 501)
  const { address } = c.req.valid("param")
  const { confirm } = c.req.valid("query")
  const outcome = await store.remove(c.get("auth").tenantId, address, {
    confirmComplaint: confirm === "complaint",
  })
  if (outcome === "removed") {
    return c.json(
      {
        object: "suppression" as const,
        address: address.trim().toLowerCase(),
        deleted: true as const,
      },
      200,
    )
  }
  const refusal = removalRefusal(outcome)
  return c.json(refusal.body, refusal.status)
})
