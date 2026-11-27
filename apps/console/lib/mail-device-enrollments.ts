import { platformLabel, type MailDevicePlatform } from "@/lib/mail-devices"

/**
 * Apple over-the-air mail device enrollment state, polling rules, time-left
 * formatting and plain-language copy (#383 PR 5b).
 *
 * Pure and safe on both server and client: no `server-only`, no React, no
 * storage. The enrollment URL returned by POST is shown once in the dialog and
 * never persisted here or anywhere else.
 */

export type EnrollmentStatus =
  "open" | "attested" | "sealed" | "refused" | "expired" | "cancelled"

export interface StartedEnrollment {
  id: string
  /** `https://ca.i10.tech/enroll/apple/<token>`, shown once in the dialog only. */
  url: string
  expiresAt: string
}

export interface MailDeviceEnrollment {
  id: string
  status: EnrollmentStatus
  expiresAt: string
  refusal: string | null
  platform: MailDevicePlatform | null
  model: string | null
  deviceName: string | null
  deviceId: string | null
  needsMailSetup: boolean
}

/** Base poll interval while an enrollment is `open` or `attested`. */
export const ENROLLMENT_POLL_MS = 2000
/** Cap on backoff after consecutive transient poll errors. */
export const ENROLLMENT_POLL_MAX_MS = 10_000

/**
 * The two manual clicks macOS Mail needs after a Mac installs its profile
 * (docs/research/mail-device-binding.md sections 5 & 12).
 */
export const MAC_MAIL_SETUP_STEPS: readonly string[] = [
  "In Mail, open Account Settings > Server Settings and set Authentication to External.",
  "Open Advanced IMAP Settings > TLS Certificate and pick the i10 certificate.",
]

/** Poll GET only while the device has not finished or stopped. */
export function shouldPollEnrollment(status: EnrollmentStatus): boolean {
  return status === "open" || status === "attested"
}

/** Whether closing the dialog should send a best-effort DELETE to cancel. */
export function isEnrollmentLive(status: EnrollmentStatus): boolean {
  return status === "open" || status === "attested"
}

/** Delay before the next poll; backs off gently on transient network errors. */
export function nextEnrollmentPollDelay(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return ENROLLMENT_POLL_MS
  return Math.min(
    ENROLLMENT_POLL_MAX_MS,
    ENROLLMENT_POLL_MS * 2 ** Math.min(consecutiveFailures, 3),
  )
}

/** What to call the device in the dialog and toast: name, else model, else platform. */
export function enrollmentDeviceLabel(device: {
  deviceName: string | null
  model: string | null
  platform: MailDevicePlatform | null
}): string {
  const name = device.deviceName?.trim()
  if (name) return name
  const model = device.model?.trim()
  if (model) return model
  if (device.platform) return platformLabel(device.platform)
  return "Your device"
}

const REFUSAL_COPY: Record<string, string> = {
  mac_not_apple_silicon:
    "This Mac has an Intel processor. Mail device setup on macOS requires a Mac with Apple silicon.",
  macos_too_old: "This Mac needs macOS 14 Sonoma or later to set up a mail device.",
  unsupported_product:
    "This device is not supported. Mail device setup works on iPhone, iPad and Apple silicon Macs.",
  no_mailbox:
    "This account has no mailbox yet. Create a mailbox before adding a mail device.",
  keys_not_configured: "Mail device setup is not available right now. Try again later.",
  invalid_platform:
    "This device is not supported. Mail device setup works on iPhone, iPad and Apple silicon Macs.",
  account_not_found: "Your mailbox account could not be found.",
  account_inactive: "Your mailbox is not active right now.",
  tenant_mismatch:
    "Your mailbox moved to a different workspace while setting up. Start again to continue.",
  epoch_mismatch:
    "Your account security settings changed while setting up. Start again to continue.",
  email_mismatch:
    "Your mailbox address changed while setting up. Start again to continue.",
  mailbox_suspended:
    "Your mailbox is suspended, so a new device cannot be added right now.",
  mailbox_deleting:
    "Your mailbox is scheduled for deletion, so a new device cannot be added.",
  payment_hold:
    "This workspace is on a payment hold. Resolve billing before adding a device.",
  domain_not_hosted: "Your mailbox's domain is not hosting mailboxes right now.",
  account_banned: "This account cannot add mail devices.",
  account_locked: "This account is currently locked. Unlock it before adding a device.",
  sso_required:
    "Your workspace requires signing in with your company's SSO before adding a device.",
  managed_no_connection: "This managed account has no active SSO connection.",
  connection_inactive: "Your company's SSO connection is not active right now.",
}

const FALLBACK_REFUSAL = "This device could not be added. Start again to try once more."

/** Maps a fixed API refusal word to plain copy, never leaking the raw code. */
export function refusalMessage(code: string | null | undefined): string {
  if (!code) return FALLBACK_REFUSAL
  return REFUSAL_COPY[code] ?? FALLBACK_REFUSAL
}

export interface EnrollmentStatusCopy {
  kind: "waiting" | "installing" | "sealed" | "failed"
  title: string
  message: string
  canRestart: boolean
  showMacSetup: boolean
}

/**
 * Plain copy for each enrollment status.
 *
 * When status reaches `expired` after the device attested (observed directly
 * via `wasAttested`, or inferred from `platform !== null` when a backgrounded
 * tab wakes up after expiry), explains the iPhone Stolen Device Protection
 * "Always" delay and offers to start again.
 */
export function enrollmentStatusCopy(
  view: Pick<
    MailDeviceEnrollment,
    "status" | "refusal" | "platform" | "model" | "deviceName" | "needsMailSetup"
  >,
  options: { wasAttested?: boolean } = {},
): EnrollmentStatusCopy {
  switch (view.status) {
    case "open":
      return {
        kind: "waiting",
        title: "Waiting for the device",
        message:
          "Scan the QR code with your iPhone or iPad camera, or open the link on this device.",
        canRestart: false,
        showMacSetup: false,
      }
    case "attested":
      return {
        kind: "installing",
        title: "Installing",
        message:
          "Finish installing the profile on your device. This window updates once it is ready.",
        canRestart: false,
        showMacSetup: false,
      }
    case "sealed": {
      const label = enrollmentDeviceLabel(view)
      return {
        kind: "sealed",
        title: "Device added",
        message: view.needsMailSetup
          ? `${label} was added. Complete the two steps below in Apple Mail to connect.`
          : `${label} was added and can now sign in to your mailbox.`,
        canRestart: false,
        showMacSetup: view.needsMailSetup,
      }
    }
    case "refused":
      return {
        kind: "failed",
        title: "Device could not be added",
        message: refusalMessage(view.refusal),
        canRestart: true,
        showMacSetup: false,
      }
    case "expired": {
      const afterAttest = Boolean(options.wasAttested) || view.platform !== null
      return afterAttest
        ? {
            kind: "failed",
            title: "Setup timed out",
            message:
              'Your device started setup, but did not finish in time. On iPhone, Stolen Device Protection set to "Always" can make the install take about an hour and time out. Start again when you are ready.',
            canRestart: true,
            showMacSetup: false,
          }
        : {
            kind: "failed",
            title: "Setup link expired",
            message:
              "This setup link expired before a device connected. Start again to get a new QR code and link.",
            canRestart: true,
            showMacSetup: false,
          }
    }
    case "cancelled":
      return {
        kind: "failed",
        title: "Setup was cancelled",
        message:
          "This setup session was cancelled. Start again if you still want to add a device.",
        canRestart: true,
        showMacSetup: false,
      }
  }
}

export interface StartEnrollmentError {
  title: string
  message: string
  retryable: boolean
}

function errorCodeOf(failure: { name?: string }): string | null {
  return failure.name && failure.name.length > 0 ? failure.name : null
}

/** Plain copy for failures from `POST /console/mail-devices/enrollments`. */
export function startEnrollmentError(failure: {
  status: number
  name: string
  error: string
  body?: Record<string, unknown>
}): StartEnrollmentError {
  const code = errorCodeOf(failure)
  if (failure.status === 409 && code === "no_mailbox") {
    return {
      title: "No mailbox on this account",
      message: REFUSAL_COPY.no_mailbox!,
      retryable: false,
    }
  }
  if (failure.status === 503 || code === "keys_not_configured") {
    return {
      title: "Device setup is unavailable",
      message: REFUSAL_COPY.keys_not_configured!,
      retryable: true,
    }
  }
  if (failure.status === 409) {
    return {
      title: "Could not start device setup",
      message:
        code && code in REFUSAL_COPY
          ? REFUSAL_COPY[code]!
          : "Your mailbox is not ready for a new device right now.",
      retryable: true,
    }
  }
  if (failure.status === 401 || failure.status === 403) {
    const hasPlainMessage =
      failure.error.length > 0 && !failure.error.startsWith("The API answered ")
    return {
      title: "Could not start device setup",
      message: hasPlainMessage
        ? failure.error
        : "Your session does not meet this workspace's sign-in requirements.",
      retryable: true,
    }
  }
  return {
    title: "Could not start device setup",
    message: "Something went wrong while starting device setup. Try again in a moment.",
    retryable: true,
  }
}

/**
 * Formats remaining time until `expiresAt` as `m:ss left` (or `Expired` once
 * past). Returns `null` when `expiresAt` is not a valid timestamp.
 */
export function formatTimeLeft(
  expiresAt: string,
  nowMs: number = Date.now(),
): string | null {
  const end = Date.parse(expiresAt)
  if (Number.isNaN(end)) return null
  const remainingMs = end - nowMs
  if (remainingMs <= 0) return "Expired"
  const totalSeconds = Math.ceil(remainingMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, "0")} left`
}
