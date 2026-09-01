import { createRoute, OpenAPIHono } from "@hono/zod-openapi"
import {
  batchSendResponseSchema,
  batchSendSchema,
  errorSchema,
  sendEmailResponseSchema,
  sendEmailSchema,
} from "@repo/contracts"
import { requireApiKey } from "../middleware/auth.js"

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
    429: errorResponse("Sending too fast, or the daily quota is exhausted."),
    501: errorResponse("The send path is not implemented yet."),
  },
})

emails.openapi(
  send,
  (c) => {
    const payload = c.req.valid("json")

    // TODO(phase-2): record-then-send.
    //   1. Persist the message and mint its id in the SAME transaction as the
    //      caller's work, so a rollback never sends. That is the outbox pattern
    //      and it is the reason this is a database write before it is a queue push.
    //   2. Honour `Idempotency-Key` — a replay returns the FIRST id rather than
    //      sending again.
    //   3. Check the suppression list (bounce · complaint · unsubscribe) before
    //      enqueueing, not after.
    //   4. Enqueue for relay. Stalwart signs DKIM before handing to SES, so the
    //      customer's record stays a plain TXT public key we rotate on our own
    //      schedule rather than an amazonses CNAME.
    void payload

    return c.json(
      {
        statusCode: 501,
        name: "internal_server_error" as const,
        message: "The send path is not implemented yet.",
      },
      501,
    )
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
    429: errorResponse("Sending too fast, or the daily quota is exhausted."),
    501: errorResponse("Batch send is not implemented yet."),
  },
})

emails.openapi(
  sendBatch,
  (c) => {
    void c.req.valid("json")
    return c.json(
      {
        statusCode: 501,
        name: "internal_server_error" as const,
        message: "Batch send is not implemented yet.",
      },
      501,
    )
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
