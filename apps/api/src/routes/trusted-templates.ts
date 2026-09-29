import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import {
  createTrustedTemplateSchema,
  trustedTemplateListSchema,
  trustedTemplateSchema,
} from "@repo/contracts"
import type { MiddlewareHandler } from "hono"
import { isRestricted } from "../auth/scope.js"
import { requireApiKey } from "../middleware/auth.js"
import type { TrustedTemplate } from "../risk/trusted.js"
import { errorResponse, notWired as notWiredFor } from "./shared.js"

/**
 * Templates submitted for review, over the API (#222): list, submit, read,
 * withdraw. Staff decide; nothing here can approve anything.
 *
 * ⚠ THE SAME STORE AS THE CONSOLE (risk/trusted.ts), so the same limits, the
 * same duplicate rule and the same audit trail whichever door was used.
 *
 * ⚠ A DOMAIN-RESTRICTED KEY IS REFUSED, like `/suppressions`. An approval
 * covers the whole workspace's sending, not one domain's.
 */
export const trustedTemplateRoutes = new OpenAPIHono()

trustedTemplateSchema.openapi("TrustedTemplate")
const TrustedTemplateList = trustedTemplateListSchema.openapi("TrustedTemplateList")
const CreateTrustedTemplate = createTrustedTemplateSchema.openapi(
  "CreateTrustedTemplate",
)
const notWired = notWiredFor("Trusted templates")

const restricted = {
  statusCode: 403,
  name: "restricted_api_key" as const,
  message:
    "This key is restricted to a domain, and a reviewed template covers the whole " +
    "workspace. Use an unrestricted key.",
}

const unrestricted: MiddlewareHandler = async (c, next) => {
  if (isRestricted(c.get("auth").scopes)) return c.json(restricted, 403)
  return next()
}

/** The public shape, shared with the console. */
export const presentTrustedTemplate = (t: TrustedTemplate) => ({
  object: "trusted_template" as const,
  id: t.id,
  name: t.name,
  status: t.status,
  html: t.html,
  text: t.text,
  holes: t.holes,
  matched: t.matched,
  submitted_at: t.submittedAt.toISOString(),
  decided_at: t.decidedAt?.toISOString() ?? null,
  decision_reason: t.decisionReason,
})

const common = {
  tags: ["Trusted templates"],
  security: [{ bearerAuth: [] }],
}

const denied = {
  401: errorResponse("The API key is missing, malformed, or unknown."),
  403: errorResponse("The key is restricted to a domain."),
  501: errorResponse("Trusted templates are not configured."),
}

const idParam = z.object({
  id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
})

const list = createRoute({
  ...common,
  middleware: [requireApiKey, unrestricted] as const,
  method: "get",
  path: "/",
  summary: "List submitted templates",
  description: "Newest first, whatever their status.",
  responses: {
    200: {
      description: "The workspace's submissions.",
      content: { "application/json": { schema: TrustedTemplateList } },
    },
    ...denied,
  },
})

trustedTemplateRoutes.openapi(list, async (c) => {
  const store = c.get("trustedTemplates")
  if (!store) return c.json(notWired, 501)
  const rows = await store.list(c.get("auth").tenantId)
  return c.json({ data: rows.map(presentTrustedTemplate) }, 200)
})

const submit = createRoute({
  ...common,
  middleware: [requireApiKey, unrestricted] as const,
  method: "post",
  path: "/",
  summary: "Submit a template for review",
  description:
    "Send the body exactly as you will send it, with `{{name}}` wherever a value " +
    "goes. Once our team approves it, messages matching it exactly stop counting " +
    "as repeated content. Approval never excuses bounces or spam complaints, and " +
    "is withdrawn automatically when they run high. Links inside values must " +
    "point at your own verified domains.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateTrustedTemplate } },
    },
  },
  responses: {
    201: {
      description: "Submitted; waiting for review.",
      content: { "application/json": { schema: trustedTemplateSchema } },
    },
    409: errorResponse("The same template is already waiting for review or approved."),
    422: errorResponse(
      "The template is not acceptable, or the workspace is at its limit.",
    ),
    ...denied,
  },
})

trustedTemplateRoutes.openapi(
  submit,
  async (c) => {
    const store = c.get("trustedTemplates")
    if (!store) return c.json(notWired, 501)
    const auth = c.get("auth")
    const body = c.req.valid("json")
    const r = await store.submit(
      auth.tenantId,
      {
        name: body.name,
        html: body.html ?? null,
        text: body.text ?? null,
        ...(body.holes ? { holes: body.holes } : {}),
      },
      `api_key:${auth.apiKeyId}`,
    )
    if ("error" in r) {
      return r.code === "duplicate"
        ? c.json(
            {
              statusCode: 409,
              name: "template_already_submitted" as const,
              message: r.error,
            },
            409,
          )
        : c.json(
            { statusCode: 422, name: "validation_error" as const, message: r.error },
            422,
          )
    }
    return c.json(presentTrustedTemplate(r.template), 201)
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

const get = createRoute({
  ...common,
  middleware: [requireApiKey, unrestricted] as const,
  method: "get",
  path: "/{id}",
  summary: "Read a submitted template",
  request: { params: idParam },
  responses: {
    200: {
      description: "The submission and its status.",
      content: { "application/json": { schema: trustedTemplateSchema } },
    },
    404: errorResponse("No submission with that id."),
    ...denied,
  },
})

trustedTemplateRoutes.openapi(get, async (c) => {
  const store = c.get("trustedTemplates")
  if (!store) return c.json(notWired, 501)
  const found = await store.get(c.get("auth").tenantId, c.req.valid("param").id)
  return found
    ? c.json(presentTrustedTemplate(found), 200)
    : c.json(
        {
          statusCode: 404,
          name: "not_found" as const,
          message: "No submission with that id.",
        },
        404,
      )
})

const withdraw = createRoute({
  ...common,
  middleware: [requireApiKey, unrestricted] as const,
  method: "delete",
  path: "/{id}",
  summary: "Withdraw a submitted template",
  description:
    "Takes back a submission waiting for review, or an approval. Mail matching it " +
    "is then treated like any other mail. The record stays, marked `withdrawn`.",
  request: { params: idParam },
  responses: {
    200: {
      description: "Withdrawn.",
      content: { "application/json": { schema: trustedTemplateSchema } },
    },
    404: errorResponse("No pending or approved submission with that id."),
    ...denied,
  },
})

trustedTemplateRoutes.openapi(withdraw, async (c) => {
  const store = c.get("trustedTemplates")
  if (!store) return c.json(notWired, 501)
  const auth = c.get("auth")
  const done = await store.withdraw(
    auth.tenantId,
    c.req.valid("param").id,
    `api_key:${auth.apiKeyId}`,
  )
  return done
    ? c.json(presentTrustedTemplate(done), 200)
    : c.json(
        {
          statusCode: 404,
          name: "not_found" as const,
          message: "No pending or approved submission with that id.",
        },
        404,
      )
})
