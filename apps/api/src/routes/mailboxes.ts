import { createRoute, OpenAPIHono } from "@hono/zod-openapi"
import { createMailboxSchema, mailboxListSchema, mailboxSchema } from "@repo/contracts"
import { requireUser } from "../middleware/session.js"
import { errorResponse, notWired as notWiredFor } from "./shared.js"

/**
 * Human mailboxes for the signed-in person.
 *
 * ⚠ EVERY ROUTE HERE IS ABOUT THE CALLER AND ONLY THE CALLER. There is no path
 * parameter naming a user and no `user_id` in any body, so there is no
 * authorisation check to get wrong: the subject is whoever the session says it
 * is. Provisioning on somebody else's behalf — an admin filling the seats they
 * bought — is a genuinely different operation, with a different question to
 * answer (does this admin own the domain, and is there a seat left) and a
 * different delivery mechanism (an invite the person completes by choosing
 * their own password). It gets its own routes rather than an optional field
 * here, because an optional field is how one endpoint ends up answering two
 * authorisation questions and only checking one.
 */
export const mailboxes = new OpenAPIHono()

const Mailbox = mailboxSchema.openapi("Mailbox")
const MailboxList = mailboxListSchema.openapi("MailboxList")
const CreateMailbox = createMailboxSchema.openapi("CreateMailbox")
const notWired = notWiredFor("Mailboxes")

const validation = (message: string) => ({
  statusCode: 422,
  name: "validation_error" as const,
  message,
})

const create = createRoute({
  method: "post",
  path: "/",
  summary: "Create your mailbox",
  description:
    "Creates a mailbox for the signed-in user on a domain i10 hosts mail for. " +
    "The account must have a password: mail clients sign in with it, so an " +
    "account created through Google or an email link cannot hold a mailbox " +
    "until one is set.",
  tags: ["Mailboxes"],
  security: [{ sessionAuth: [] }],
  middleware: [requireUser] as const,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateMailbox } },
    },
  },
  responses: {
    201: {
      description: "Created. The mailbox can receive mail and be signed in to.",
      content: { "application/json": { schema: Mailbox } },
    },
    401: errorResponse("Not signed in."),
    403: errorResponse("The plan does not include another mailbox."),
    409: errorResponse(
      "The account has no password, the address is taken, or the user " +
        "already has a mailbox.",
    ),
    422: errorResponse("The address is not one we can host."),
    501: errorResponse("Mailboxes are not configured."),
    503: errorResponse("The session could not be verified."),
  },
})

mailboxes.openapi(
  create,
  async (c) => {
    const provisioning = c.get("mailboxes")
    if (!provisioning) return c.json(notWired, 501)

    const { userId } = c.get("user")
    const outcome = await provisioning.create(userId, c.req.valid("json"))

    switch (outcome.status) {
      case "created":
        return c.json(outcome.mailbox, 201)

      // ⚠ 409, NOT 403, AND THE DISTINCTION IS WHAT THE CLIENT DOES NEXT. 403
      // says "you may not"; this is "not yet, and here is the thing to change".
      // The console's job on seeing it is to send the person to set a password
      // and then retry the identical request — which is a conflict with current
      // state, not a permission the account lacks.
      case "password_required":
        return c.json(
          {
            statusCode: 409,
            name: "password_required" as const,
            message: outcome.reason,
          },
          409,
        )

      case "conflict":
        return c.json(
          {
            statusCode: 409,
            name: "mailbox_already_exists" as const,
            message: outcome.reason,
          },
          409,
        )

      // ⚠ 403, NOT 429 — the same rule the domains route follows. A plan limit
      // is not rate limiting: the SDKs back off on 429, and no amount of
      // waiting produces another seat. The fix is an upgrade or a deletion.
      case "limit":
        return c.json(
          {
            statusCode: 403,
            name: "plan_limit_exceeded" as const,
            message: outcome.reason,
          },
          403,
        )

      default:
        return c.json(validation(outcome.reason), 422)
    }
  },
  (result, c) => {
    if (!result.success) {
      return c.json(
        validation(result.error.issues[0]?.message ?? "Invalid request body."),
        422,
      )
    }
  },
)

/**
 * ⚠ A LIST OF AT MOST ONE, RATHER THAN A BARE OBJECT OR A 404. One person has
 * one mailbox today because the projection keys `authd.accounts` by Clerk user
 * id, but that is a property of the current model and not a promise; a client
 * written against `{ data: [] }` keeps working if it ever stops being true,
 * where one written against a 404 has to be rewritten. It also spares the
 * "no mailbox yet" case from being an error, which it is not.
 */
const list = createRoute({
  method: "get",
  path: "/",
  summary: "List your mailboxes",
  tags: ["Mailboxes"],
  security: [{ sessionAuth: [] }],
  middleware: [requireUser] as const,
  responses: {
    200: {
      description: "The signed-in user's mailboxes. Empty if they have none.",
      content: { "application/json": { schema: MailboxList } },
    },
    401: errorResponse("Not signed in."),
    501: errorResponse("Mailboxes are not configured."),
    503: errorResponse("The session could not be verified."),
  },
})

mailboxes.openapi(list, async (c) => {
  const provisioning = c.get("mailboxes")
  if (!provisioning) return c.json(notWired, 501)

  const { userId } = c.get("user")
  const mailbox = await provisioning.current(userId)

  return c.json({ data: mailbox ? [mailbox] : [] }, 200)
})
