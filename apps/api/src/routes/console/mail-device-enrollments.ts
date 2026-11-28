import type { Context, Hono } from "hono"
import { EnrollRedisUnavailableError } from "../../mail-devices/enroll-redis.js"
import { requireFreshAuth, ssoGateRefusal } from "../../middleware/session.js"
import type { ConsoleDeps, MailDeviceEnrollmentsDeps } from "./deps.js"
import { asId, isRecord, notFound, notWired, validation } from "./http.js"

/**
 * Console routes for Apple OTA mail device enrollment (I10-62,
 * docs/research/enrollment-at-scale.md):
 *   - `POST /console/mail-devices/enrollments` (behind `requireFreshAuth`,
 *     workspace-optional, `Cache-Control: no-store`, 1 read-only account SELECT
 *     + 1 Lua script on `i10-enroll-redis`, 0 Postgres writes)
 *   - `GET /console/mail-devices/enrollments/:id` (polled every 2s by console;
 *     reads `i10-enroll-redis`, 0 Postgres beyond `gatedMailbox`)
 *   - `DELETE /console/mail-devices/enrollments/:id` (204 cancel, 409
 *     already_sealed, 404 other/missing)
 *
 * Every route acts strictly on the signed-in person's own mailbox and own
 * enrollments; another person's enrollment id always answers 404. Redis errors
 * fail closed with 503 `enrollment_unavailable`. Every refusal and unavailable
 * answer uses the console's usual error envelope (`refused` below).
 */

/**
 * The person's mailbox, once its workspace's console policies have passed on
 * this session, or the refusal to send.
 *
 * ⚠ THE MAILBOX'S WORKSPACE DECIDES, NOT THE ONE THE SESSION HAS OPEN. These
 * routes run with any workspace open or none, and they start, show or cancel
 * the enrollment of a credential for the mailbox. So that workspace's policies
 * (SSO, second factor, IP allowlist, session age) run on this session here;
 * `requireTenant` already ran them when it is the open workspace. They are
 * checked here, on the request, and nowhere else: enrollctl re-checks only the
 * account's own gate (holds, epoch, address, workspace) under the account lock
 * before it mints.
 */
async function gatedMailbox(
  c: Context,
  enrollments: MailDeviceEnrollmentsDeps,
  userId: string,
): Promise<{ mailbox: { tenantId: string | null } | null } | { refused: Response }> {
  const mailbox = await enrollments.mailboxTenant({ clerkUserId: userId })
  if (mailbox?.tenantId && mailbox.tenantId !== c.get("auth").tenantId) {
    const refused = await ssoGateRefusal(c, userId, mailbox.tenantId)
    if (refused) return { refused }
  }
  return { mailbox }
}

/**
 * A refusal in the console's usual envelope, with the refusal word as `name`,
 * so the console reads it the way it reads every other route's error.
 */
const refused = (statusCode: 409 | 503, name: string, message: string) => ({
  statusCode,
  name,
  message,
})

const MESSAGES: Record<string, string> = {
  no_mailbox: "This account has no mailbox to add a device to.",
  already_sealed:
    "That device is already set up. Revoke it from the device list instead.",
  enrollment_unavailable: "Device setup is not available right now.",
}
const messageFor = (code: string) =>
  MESSAGES[code] ?? "This mailbox cannot add a device right now."

const unavailable = () =>
  refused(503, "enrollment_unavailable", messageFor("enrollment_unavailable"))

export function mountMailDeviceEnrollments(app: Hono, d: ConsoleDeps): void {
  app.post("/mail-devices/enrollments", requireFreshAuth, async (c) => {
    const enrollments = d.mailDeviceEnrollments
    if (!enrollments) return c.json(notWired("Mail device enrollments"), 501)

    c.header("Cache-Control", "no-store")

    // Accept an empty body or `{}` (reject non-object / malformed JSON).
    const raw = (await c.req.raw.clone().text()).trim()
    if (raw.length > 0) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return c.json(validation("Request body must be a JSON object."), 422)
      }
      if (!isRecord(parsed)) {
        return c.json(validation("Request body must be a JSON object."), 422)
      }
    }

    const { userId } = c.get("user")
    const gated = await gatedMailbox(c, enrollments, userId)
    if ("refused" in gated) return gated.refused
    const { mailbox } = gated
    if (!mailbox)
      return c.json(refused(409, "no_mailbox", messageFor("no_mailbox")), 409)

    const result = await enrollments.create({
      clerkUserId: userId,
      tenantId: mailbox.tenantId,
    })
    if (!result.ok) {
      return c.json(
        refused(result.status, result.code, messageFor(result.code)),
        result.status,
      )
    }

    return c.json(
      {
        id: result.id,
        url: result.url,
        expiresAt: result.expiresAt.toISOString(),
      },
      201,
    )
  })

  app.get("/mail-devices/enrollments/:id", async (c) => {
    const enrollments = d.mailDeviceEnrollments
    if (!enrollments) return c.json(notWired("Mail device enrollments"), 501)

    c.header("Cache-Control", "no-store")
    const id = asId(c.req.param("id"))
    if (!id) return c.json(notFound("Enrollment not found."), 404)

    const { userId } = c.get("user")
    const gated = await gatedMailbox(c, enrollments, userId)
    if ("refused" in gated) return gated.refused
    if (!gated.mailbox) return c.json(notFound("Enrollment not found."), 404)

    let view
    try {
      view = await enrollments.get({ id, clerkUserId: userId })
    } catch (err) {
      if (err instanceof EnrollRedisUnavailableError) {
        return c.json(unavailable(), 503)
      }
      throw err
    }
    if (!view) return c.json(notFound("Enrollment not found."), 404)

    return c.json({
      id: view.id,
      status: view.status,
      expiresAt: view.expiresAt.toISOString(),
      refusal: view.refusal,
      platform: view.platform,
      model: view.model,
      deviceName: view.deviceName,
      deviceId: view.deviceId,
      needsMailSetup: view.needsMailSetup,
    })
  })

  app.delete("/mail-devices/enrollments/:id", async (c) => {
    const enrollments = d.mailDeviceEnrollments
    if (!enrollments) return c.json(notWired("Mail device enrollments"), 501)

    const id = asId(c.req.param("id"))
    if (!id) return c.json(notFound("Enrollment not found."), 404)

    const { userId } = c.get("user")
    const gated = await gatedMailbox(c, enrollments, userId)
    if ("refused" in gated) return gated.refused
    if (!gated.mailbox) return c.json(notFound("Enrollment not found."), 404)

    let outcome
    try {
      outcome = await enrollments.cancel({ id, clerkUserId: userId })
    } catch (err) {
      if (err instanceof EnrollRedisUnavailableError) {
        return c.json(unavailable(), 503)
      }
      throw err
    }
    if (outcome === "not_found") {
      return c.json(notFound("Enrollment not found."), 404)
    }
    if (outcome === "already_sealed") {
      return c.json(refused(409, "already_sealed", messageFor("already_sealed")), 409)
    }
    return c.body(null, 204)
  })
}
