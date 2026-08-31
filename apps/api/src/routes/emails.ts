import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { batchSendSchema, sendEmailSchema } from "@repo/contracts"
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
 */
export const emails = new Hono()

emails.use("*", requireApiKey)

emails.post("/", zValidator("json", sendEmailSchema), async (c) => {
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
      name: "internal_server_error",
      message: "The send path is not implemented yet.",
    },
    501,
  )
})

emails.post("/batch", zValidator("json", batchSendSchema), async (c) => {
  void c.req.valid("json")
  return c.json(
    {
      statusCode: 501,
      name: "internal_server_error",
      message: "Batch send is not implemented yet.",
    },
    501,
  )
})
