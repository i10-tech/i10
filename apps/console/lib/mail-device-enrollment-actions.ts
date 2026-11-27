"use server"

import { refresh, revalidatePath } from "next/cache"
import { api, ApiRequestError } from "@/lib/api"
import type {
  MailDeviceEnrollment,
  StartedEnrollment,
} from "@/lib/mail-device-enrollments"
import { run } from "@/lib/sso-run"

/**
 * Server actions for Apple OTA mail device enrollment (#383 PR 4 & 5b).
 *
 * Kept next to `lib/mail-devices.ts` in the same server-action style as
 * `lib/mailbox-transfer-actions.ts`: the session token never leaves the server,
 * refusals come back as values, and polling never revalidates until the device
 * actually seals so the open dialog does not flicker.
 */

const MAIL_DEVICE_PAGES = ["/account", "/mailboxes/[address]"]

function revalidateDeviceLists() {
  for (const path of MAIL_DEVICE_PAGES) {
    revalidatePath(path, "page")
  }
  refresh()
}

/**
 * Starts a new enrollment for the signed-in person's own mailbox. Behind
 * `requireFreshAuth`: the caller runs `useStepUp()` first.
 */
export async function startMailDeviceEnrollment() {
  return run(() =>
    api<StartedEnrollment>("/console/mail-devices/enrollments", {
      method: "POST",
      body: {},
    }),
  )
}

/**
 * Polls one enrollment's status. Revalidates the device lists once it reaches
 * `sealed` so the new device row appears in the list right away.
 */
export async function readMailDeviceEnrollment(id: string) {
  const result = await run(() =>
    api<MailDeviceEnrollment>(
      `/console/mail-devices/enrollments/${encodeURIComponent(id)}`,
    ),
  )
  if (result.ok && result.data.status === "sealed") {
    revalidateDeviceLists()
  }
  return result
}

/**
 * Cancels an `open` or `attested` enrollment (best-effort when closing the
 * dialog). If the enrollment sealed right before cancel (`409 already_sealed`),
 * refreshes the device lists so the new row still appears.
 */
export async function cancelMailDeviceEnrollment(id: string) {
  const result = await run(async () => {
    try {
      await api<undefined>(
        `/console/mail-devices/enrollments/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      )
      return { outcome: "cancelled" as const }
    } catch (error) {
      if (
        error instanceof ApiRequestError &&
        error.status === 409 &&
        error.body.name === "already_sealed"
      ) {
        return { outcome: "already_sealed" as const }
      }
      throw error
    }
  })
  if (result.ok && result.data.outcome === "already_sealed") {
    revalidateDeviceLists()
  }
  return result
}
