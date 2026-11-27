import type { Context } from "hono"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { mailDeviceListSchema, mailDevicesRevokedSchema } from "@repo/contracts"
import { ownMailboxRefusal } from "../mail-devices/gate.js"
import type { DeviceViewer, MailDeviceService } from "../mail-devices/service.js"
import { requireUser } from "../middleware/session.js"
import { errorResponse, notWired as notWiredFor } from "./shared.js"

/**
 * The signed-in person's mail devices (#383 PR 5, PR 5b).
 *
 * ⚠ ABOUT THE CALLER AND ONLY THE CALLER, the rule routes/mailboxes.ts states:
 * no path or body names a person, so the subject is whoever the session says.
 * An owner or admin managing someone else's devices does that in the console,
 * which knows the workspace in use. Session auth only: an API key never
 * reaches these, so a leaked sending key cannot sign anyone's phone out.
 *
 * ⚠ GATED BY THE MAILBOX'S WORKSPACE: `requireUser` runs the person-level
 * managed-account SSO gate; own-scope calls also run the mailbox workspace's
 * console policies (SSO, second factor, IP allowlist, session age) through
 * `ownMailboxRefusal`.
 *
 * ⚠ NO STEP-UP: revoking only removes access, and a lost phone must be signed
 * out at once (mail-devices/service.ts).
 */

declare module "hono" {
  interface ContextVariableMap {
    mailDevices?: MailDeviceService
  }
}

export const mailDevices = new OpenAPIHono()

const MailDeviceList = mailDeviceListSchema.openapi("MailDeviceList")
const MailDevicesRevoked = mailDevicesRevokedSchema.openapi("MailDevicesRevoked")
const notWired = notWiredFor("Mail devices")

/**
 * The mailbox-workspace gate refusal, handed back from a typed route.
 * The OpenAPI handler types only the documented shapes, hence the cast
 * (same pattern as routes/mailbox-migration.ts).
 */
const refusal = (response: Response): never => response as never

/** The caller as themselves: never an admin, never a workspace, gated by their mailbox's workspace. */
async function withSelf<T>(
  c: Context,
  service: MailDeviceService,
  run: (viewer: DeviceViewer) => Promise<T>,
): Promise<{ refused: Response } | { result: T }> {
  const { userId } = c.get("user")
  let refused: Response | null = null
  let checked = false
  const allowOwn = async (): Promise<boolean> => {
    if (!checked) {
      checked = true
      refused = await ownMailboxRefusal(c, service, userId, null)
    }
    return refused === null
  }
  const result = await run({ userId, tenantId: null, isAdmin: false, allowOwn })
  return refused ? { refused } : { result }
}

const list = createRoute({
  method: "get",
  path: "/",
  summary: "List your mail devices",
  description:
    "The iPhones, iPads and Macs that sign in to your mailbox with their own " +
    "device code, newest first.",
  tags: ["Mailboxes"],
  security: [{ sessionAuth: [] }],
  middleware: [requireUser] as const,
  request: { query: z.object({ cursor: z.string().optional() }) },
  responses: {
    200: {
      description: "Your devices. Empty if you have none.",
      content: { "application/json": { schema: MailDeviceList } },
    },
    401: errorResponse("Not signed in."),
    422: errorResponse("The cursor is not valid."),
    501: errorResponse("Mail devices are not configured."),
    503: errorResponse("The session could not be verified."),
  },
})

mailDevices.openapi(list, async (c) => {
  const service = c.get("mailDevices")
  if (!service) return c.json(notWired, 501)
  const { cursor } = c.req.valid("query")
  const call = await withSelf(c, service, (viewer) =>
    service.list(viewer, {
      scope: "mine",
      ...(cursor ? { cursor } : {}),
    }),
  )
  if ("refused" in call) return refusal(call.refused)
  const outcome = call.result
  if (outcome.status === "ok") return c.json(outcome.page, 200)
  return c.json(
    {
      statusCode: 422,
      name: "validation_error" as const,
      message: outcome.status === "invalid" ? outcome.message : "Invalid request.",
    },
    422,
  )
})

const revokeAll = createRoute({
  method: "post",
  path: "/revoke-all",
  summary: "Sign out all your mail devices",
  description:
    "Revokes every one of your mail devices. Their mail connections close " +
    "within seconds; your password and other sign-ins are not affected.",
  tags: ["Mailboxes"],
  security: [{ sessionAuth: [] }],
  middleware: [requireUser] as const,
  responses: {
    200: {
      description: "How many devices were signed out.",
      content: { "application/json": { schema: MailDevicesRevoked } },
    },
    401: errorResponse("Not signed in."),
    501: errorResponse("Mail devices are not configured."),
    503: errorResponse("The session could not be verified."),
  },
})

mailDevices.openapi(revokeAll, async (c) => {
  const service = c.get("mailDevices")
  if (!service) return c.json(notWired, 501)
  const call = await withSelf(c, service, (viewer) => service.revokeAll(viewer))
  if ("refused" in call) return refusal(call.refused)
  const outcome = call.result
  // Always "ok" without an address when the gate passed; the type allows not_found for the console.
  const revoked = outcome.status === "ok" ? outcome.revoked : 0
  return c.json({ object: "mail_devices_revoked" as const, revoked }, 200)
})

const revokeOne = createRoute({
  method: "delete",
  path: "/{id}",
  summary: "Revoke a mail device",
  description:
    "Signs one of your devices out: it can no longer sign in, and its open " +
    "mail connections close within seconds.",
  tags: ["Mailboxes"],
  security: [{ sessionAuth: [] }],
  middleware: [requireUser] as const,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Revoked.",
      content: {
        "application/json": {
          schema: z.object({ deleted: z.literal(true), id: z.string() }),
        },
      },
    },
    401: errorResponse("Not signed in."),
    404: errorResponse("You have no device with that id."),
    501: errorResponse("Mail devices are not configured."),
    503: errorResponse("The session could not be verified."),
  },
})

mailDevices.openapi(revokeOne, async (c) => {
  const service = c.get("mailDevices")
  if (!service) return c.json(notWired, 501)
  const call = await withSelf(c, service, (viewer) =>
    service.revoke(viewer, c.req.valid("param").id),
  )
  if ("refused" in call) return refusal(call.refused)
  const gone = call.result
  if (gone) return c.json({ deleted: true as const, id: gone.id }, 200)
  return c.json(
    { statusCode: 404, name: "not_found" as const, message: "No such mail device." },
    404,
  )
})
