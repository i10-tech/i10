import type { Context, Hono } from "hono"
import { requireFreshAuth, ssoGateRefusal } from "../../middleware/session.js"
import type { ConsoleDeps, MailDeviceEnrollmentsDeps } from "./deps.js"
import { asId, isRecord, notFound, notWired, validation } from "./http.js"

/**
 * Console routes for Apple OTA mail device enrollment (#383 PR 4,
 * docs/research/mail-device-binding.md section 12 + Review 1 rules).
 *
 * Mounted in its own module beside PR 5's `routes/console/mail-devices.ts`:
 *   - `POST /console/mail-devices/enrollments` (behind `requireFreshAuth`,
 *     workspace-optional, `Cache-Control: no-store`)
 *   - `GET /console/mail-devices/enrollments/:id` (polled every 2s by console)
 *   - `DELETE /console/mail-devices/enrollments/:id` (204 cancel, 409 already_sealed, 404 other/missing)
 *
 * Every route acts strictly on the signed-in person's own mailbox and own
 * enrollments; another person's enrollment id always answers 404.
 */

/**
 * The person's mailbox, once its workspace's console policies have passed on
 * this session, or the refusal to send.
 *
 * ⚠ THE MAILBOX'S WORKSPACE DECIDES, NOT THE ONE THE SESSION HAS OPEN. These
 * routes run with any workspace open or none, and they start, show or cancel
 * the enrollment of a credential for the mailbox. So that workspace's policies
 * (SSO, second factor, IP allowlist, session age) run on this session here;
 * `requireTenant` already ran them when it is the open workspace.
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
    if (!mailbox) return c.json({ error: { code: "no_mailbox" } }, 409)

    const result = await enrollments.create({
      clerkUserId: userId,
      tenantId: mailbox.tenantId,
    })
    if (!result.ok) {
      return c.json({ error: { code: result.code } }, result.status)
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
    // An enrollment goes with its mailbox (FK cascade), so no mailbox is no row.
    const gated = await gatedMailbox(c, enrollments, userId)
    if ("refused" in gated) return gated.refused
    if (!gated.mailbox) return c.json(notFound("Enrollment not found."), 404)
    const view = await enrollments.get({ id, clerkUserId: userId })
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
    const outcome = await enrollments.cancel({ id, clerkUserId: userId })
    if (outcome === "not_found") {
      return c.json(notFound("Enrollment not found."), 404)
    }
    if (outcome === "already_sealed") {
      return c.json({ error: { code: "already_sealed" } }, 409)
    }
    return c.body(null, 204)
  })
}
