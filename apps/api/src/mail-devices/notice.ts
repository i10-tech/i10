import { renderMailDeviceEnrolled } from "@repo/emails"
import type { AuthEmailSender } from "../auth-email/deliver.js"
import type { EnrolledNoticePayload } from "./enroll-redis.js"

/**
 * Sends the post-seal notification email through i10's existing system-mail
 * sender (#383 PR 4, Review 1 H2). Invoked by the `enroll:notice` stream
 * consumer with idempotency key `mail-device-enrolled:<deviceId>`.
 */
export type MailDeviceEnrolledNotifier = (
  payload: EnrolledNoticePayload,
) => Promise<void>

export function mailDeviceEnrolledNotifier({
  sender,
  consoleUrl,
}: {
  sender: AuthEmailSender
  consoleUrl: string
}): MailDeviceEnrolledNotifier {
  const url = `${consoleUrl.replace(/\/$/, "")}/account#mail-devices`
  return async (payload) => {
    const rendered = await renderMailDeviceEnrolled({
      email: payload.email,
      model: payload.model,
      serialLast4: payload.serialLast4,
      url,
    })
    await sender.send({
      to: payload.email,
      ...rendered,
      idempotencyKey: `mail-device-enrolled:${payload.deviceId}`,
    })
  }
}
