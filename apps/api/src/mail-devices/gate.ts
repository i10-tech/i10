import type { Context } from "hono"
import { ssoGateRefusal } from "../middleware/session.js"
import type { MailDeviceService } from "./service.js"

/**
 * Runs the console policies (SSO, second factor, IP allowlist, session age) of
 * the signed-in person's mailbox workspace whenever that workspace is not
 * already the open one. Shared by the console's workspace-optional own-device
 * routes and the public `/mail-devices` routes (`openTenantId = null`).
 *
 * Returns the refusal response to send, or null to carry on.
 */
export async function ownMailboxRefusal(
  c: Context,
  devices: MailDeviceService,
  userId: string,
  openTenantId: string | null,
): Promise<Response | null> {
  if (!c.get("ssoGate")) return null
  const mailbox = await devices.mailboxTenant(userId)
  if (mailbox?.tenantId && mailbox.tenantId !== openTenantId) {
    return ssoGateRefusal(c, userId, mailbox.tenantId)
  }
  return null
}
