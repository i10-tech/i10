import { createRoute, OpenAPIHono } from "@hono/zod-openapi"
import {
  batchSendResponseSchema,
  batchSendSchema,
  errorSchema,
  sendEmailResponseSchema,
  sendEmailSchema,
} from "@repo/contracts"
import { requireApiKey } from "../middleware/auth.js"
import { acceptSend, type AcceptOutcome } from "../send/accept.js"

/**
 * The send path.
 *
 * `POST /emails` must return a message id SYNCHRONOUSLY. That is the shape
 * every Resend caller already codes against, and it is also why this service
 * exists rather than the apps posting to Stalwart: SMTP submission and JMAP
 * are message-shaped, not API-shaped — no synchronous id, no per-send tenant
 * or configuration-set parameters, and a password reset coupled to the mail
 * store's uptime. The two queues want opposite behaviour too: an MTA retries
 * for days, a reset should fail in seconds.
 *
 * ⚠ THE SCHEMAS COME FROM @repo/contracts, NOT FROM HERE. They are the same
 * objects `@i10/node` validates against, so the published OpenAPI document and
 * the SDK cannot drift from each other — there is only one definition.
 */
export const emails = new OpenAPIHono()

/**
 * Named components, so the document carries `$ref`s instead of inlining every
 * schema at every use site.
 *
 * This is what makes generated SDKs usable: without names, a generator emits an
 * anonymous type per endpoint — `SendEmailsPostRequestBody` and friends — and
 * the same Error object appears four times under four different names. `.openapi()`
 * comes from @hono/zod-openapi's extension of Zod's prototype, so it applies to
 * the plain-Zod schemas in @repo/contracts without those needing to know it exists.
 */
const SendEmail = sendEmailSchema.openapi("SendEmail")
const SendEmailResponse = sendEmailResponseSchema.openapi("SendEmailResponse")
const BatchSend = batchSendSchema.openapi("BatchSend")
const BatchSendResponse = batchSendResponseSchema.openapi("BatchSendResponse")
const ApiError = errorSchema.openapi("Error")

/** Shorthand for the error responses every route shares. */
const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: ApiError } },
})

/**
 * The error shape for every non-success outcome of `acceptSend`.
 *
 * ⚠ THE STATUS CODES ARE A COMPATIBILITY SURFACE, NOT A STYLE CHOICE. An SDK
 * maps 429 to a retry and 4xx to a thrown error, so `daily_quota_exceeded`
 * arriving as a 429 is what makes a client back off — and `idempotency_conflict`
 * arriving as a 409 rather than a 422 is what stops it retrying a request that
 * will never succeed unchanged.
 */
function acceptError(outcome: AcceptOutcome) {
  if (outcome.status === "quota_exceeded") {
    return {
      body: {
        statusCode: 429,
        name: "daily_quota_exceeded" as const,
        message: outcome.message,
      },
      status: 429 as const,
    }
  }
  return {
    body: {
      statusCode: 409,
      name: "idempotency_conflict" as const,
      message: outcome.status === "conflict" ? outcome.message : "Conflict.",
    },
    status: 409 as const,
  }
}

/**
 * ⚠ 501 WHEN THE SEND PATH IS NOT WIRED, NEVER A SILENT SUCCESS. An
 * unconfigured deployment that returned an id would be telling callers their
 * mail was accepted while nothing existed to send it.
 */
const notWired = {
  statusCode: 501,
  name: "internal_server_error" as const,
  message: "The send path is not configured.",
}

const send = createRoute({
  method: "post",
  path: "/",
  summary: "Send an email",
  description:
    "Queues a single message and returns its id immediately. The id is minted " +
    "in the same transaction as the caller's own work, so a rollback never sends.",
  tags: ["Emails"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: SendEmail } },
    },
  },
  responses: {
    200: {
      description: "The message was accepted.",
      content: { "application/json": { schema: SendEmailResponse } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    422: errorResponse("The request body failed validation."),
    409: errorResponse(
      "This Idempotency-Key was already used with a different request body.",
    ),
    429: errorResponse("Sending too fast, or the daily quota is exhausted."),
    501: errorResponse("The send path is not configured."),
  },
})

emails.openapi(
  send,
  async (c) => {
    const sendPath = c.get("sendPath")
    if (!sendPath) return c.json(notWired, 501)

    const auth = c.get("auth")
    const outcome = await acceptSend(
      {
        tenantId: auth.tenantId,
        apiKeyId: auth.apiKeyId,
        payloads: [c.req.valid("json")],
        endpoint: "single",
        // ⚠ THE HEADER IS THE CUSTOMER'S, NOT OURS TO INVENT. Absent, every
        // request is distinct — which is correct: generating one here would
        // make an accidental double-POST look like a replay and silently drop
        // the second email.
        idempotencyKey: c.req.header("Idempotency-Key"),
      },
      sendPath,
    )

    if (outcome.status === "accepted" || outcome.status === "replayed") {
      // ⚠ A REPLAY IS A 200 WITH THE ORIGINAL ID. That is the entire point of
      // the header: the caller cannot tell whether their first attempt landed,
      // and the answer that lets them stop worrying is the id they would have
      // got the first time.
      return c.json({ id: outcome.ids[0]! }, 200)
    }

    const error = acceptError(outcome)
    return c.json(error.body, error.status)
  },
  // Validation failures must speak the API's own error shape. The default is
  // Zod's, which no SDK on the compatibility path knows how to read.
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

const sendBatch = createRoute({
  method: "post",
  path: "/batch",
  summary: "Send up to 100 emails",
  description: "One response id per element, in the order submitted.",
  tags: ["Emails"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: BatchSend } },
    },
  },
  responses: {
    200: {
      description: "Every message was accepted.",
      content: { "application/json": { schema: BatchSendResponse } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    422: errorResponse("The request body failed validation."),
    409: errorResponse(
      "This Idempotency-Key was already used with a different request body.",
    ),
    429: errorResponse("Sending too fast, or the daily quota is exhausted."),
    501: errorResponse("The send path is not configured."),
  },
})

emails.openapi(
  sendBatch,
  async (c) => {
    const sendPath = c.get("sendPath")
    if (!sendPath) return c.json(notWired, 501)

    const auth = c.get("auth")
    const outcome = await acceptSend(
      {
        tenantId: auth.tenantId,
        apiKeyId: auth.apiKeyId,
        payloads: c.req.valid("json"),
        // ⚠ `bulk`, WHICH IS A DIFFERENT QUEUE FROM /emails. A batch is by
        // definition not the message somebody is watching a spinner for, and
        // routing it alongside password resets is exactly the head-of-line
        // blocking the two classes exist to prevent.
        endpoint: "batch",
        idempotencyKey: c.req.header("Idempotency-Key"),
      },
      sendPath,
    )

    if (outcome.status === "accepted" || outcome.status === "replayed") {
      // Ids come back in submission order, so element N of the response is
      // element N of the request — which is the only thing that makes them
      // usable to a caller iterating their own list.
      return c.json({ data: outcome.ids.map((id) => ({ id })) }, 200)
    }

    const error = acceptError(outcome)
    return c.json(error.body, error.status)
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
