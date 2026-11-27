import { describe, expect, it, mock } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  enrollmentDeviceLabel,
  enrollmentStatusCopy,
  formatTimeLeft,
  isEnrollmentLive,
  MAC_MAIL_SETUP_STEPS,
  nextEnrollmentPollDelay,
  refusalMessage,
  shouldPollEnrollment,
  startEnrollmentError,
  type EnrollmentStatus,
  type MailDeviceEnrollment,
} from "@/lib/mail-device-enrollments"
import type { DevicesShape, MailDevice } from "@/lib/mail-devices"

// The devices section imports its server actions; rendering it never calls them.
mock.module("server-only", () => ({}))

const { MailDevices } = await import("@/components/mail-devices")

const NOW = Date.parse("2026-11-27T10:00:00.000Z")
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

const view = (over: Partial<MailDeviceEnrollment> = {}): MailDeviceEnrollment => ({
  id: "019ab100-0000-7000-8000-000000000010",
  status: "open",
  expiresAt: at(15 * 60_000),
  refusal: null,
  platform: null,
  model: null,
  deviceName: null,
  deviceId: null,
  needsMailSetup: false,
  ...over,
})

const sampleDevice: MailDevice = {
  object: "mail_device",
  id: "dev-1",
  email: "ada@acme.test",
  platform: "ios",
  device_name: "Ada's iPhone",
  model: "iPhone17,2",
  serial: "C02X",
  created_at: "2026-11-26T10:00:00.000Z",
  first_used_at: null,
  last_used_at: null,
  created_by: "user_ada",
  has_certificate_key: false,
}

describe("mail device enrollment polling decisions", () => {
  it("polls and cancels on close only while open or attested", () => {
    const cases: [EnrollmentStatus, boolean][] = [
      ["open", true],
      ["attested", true],
      ["sealed", false],
      ["refused", false],
      ["expired", false],
      ["cancelled", false],
    ]
    for (const [status, expected] of cases) {
      expect(shouldPollEnrollment(status)).toBe(expected)
      expect(isEnrollmentLive(status)).toBe(expected)
    }
  })

  it("polls every 2s normally and backs off gently on consecutive transient failures", () => {
    expect(nextEnrollmentPollDelay(0)).toBe(2000)
    expect(nextEnrollmentPollDelay(1)).toBe(4000)
    expect(nextEnrollmentPollDelay(2)).toBe(8000)
    expect(nextEnrollmentPollDelay(3)).toBe(10_000)
    expect(nextEnrollmentPollDelay(10)).toBe(10_000)
  })
})

describe("mail device enrollment time-left formatting", () => {
  it("formats minutes and seconds left and clamps to Expired once elapsed", () => {
    expect(formatTimeLeft(at(15 * 60_000), NOW)).toBe("15:00 left")
    expect(formatTimeLeft(at(10 * 60_000 + 5_000), NOW)).toBe("10:05 left")
    expect(formatTimeLeft(at(45_000), NOW)).toBe("0:45 left")
    expect(formatTimeLeft(at(250), NOW)).toBe("0:01 left")
    expect(formatTimeLeft(at(0), NOW)).toBe("Expired")
    expect(formatTimeLeft(at(-5_000), NOW)).toBe("Expired")
  })

  it("returns null for an unparseable timestamp", () => {
    expect(formatTimeLeft("not-a-date", NOW)).toBeNull()
  })
})

describe("mail device enrollment status and refusal copy", () => {
  it("names the device from deviceName, else model, else platform, else fallback", () => {
    expect(
      enrollmentDeviceLabel({
        deviceName: "Ada's MacBook Air",
        model: "Mac14,2",
        platform: "macos",
      }),
    ).toBe("Ada's MacBook Air")
    expect(
      enrollmentDeviceLabel({
        deviceName: "   ",
        model: "Mac14,2",
        platform: "macos",
      }),
    ).toBe("Mac14,2")
    expect(
      enrollmentDeviceLabel({
        deviceName: null,
        model: null,
        platform: "ipados",
      }),
    ).toBe("iPad")
    expect(
      enrollmentDeviceLabel({ deviceName: null, model: null, platform: null }),
    ).toBe("Your device")
  })

  it("maps open, attested, sealed (iOS and Mac), cancelled and expired states", () => {
    const waiting = enrollmentStatusCopy(view({ status: "open" }))
    expect(waiting.kind).toBe("waiting")
    expect(waiting.title).toBe("Waiting for the device")
    expect(waiting.canRestart).toBe(false)

    const installing = enrollmentStatusCopy(
      view({ status: "attested", platform: "ios" }),
    )
    expect(installing.kind).toBe("installing")
    expect(installing.title).toBe("Installing")

    const sealedIos = enrollmentStatusCopy(
      view({
        status: "sealed",
        platform: "ios",
        model: "iPhone17,2",
        deviceName: "Ada's iPhone",
        needsMailSetup: false,
      }),
    )
    expect(sealedIos.kind).toBe("sealed")
    expect(sealedIos.showMacSetup).toBe(false)
    expect(sealedIos.message).toContain("Ada's iPhone")

    const sealedMac = enrollmentStatusCopy(
      view({
        status: "sealed",
        platform: "macos",
        model: "Mac14,2",
        deviceName: null,
        needsMailSetup: true,
      }),
    )
    expect(sealedMac.kind).toBe("sealed")
    expect(sealedMac.showMacSetup).toBe(true)
    expect(sealedMac.message).toContain("Mac14,2")
    expect(MAC_MAIL_SETUP_STEPS.join(" ")).toContain("External")
    expect(MAC_MAIL_SETUP_STEPS.join(" ")).toContain("TLS Certificate")

    const expiredBeforeAttest = enrollmentStatusCopy(view({ status: "expired" }))
    expect(expiredBeforeAttest.canRestart).toBe(true)
    expect(expiredBeforeAttest.message).not.toContain("Stolen Device Protection")

    // Observed attested directly during polling:
    const expiredAfterAttest = enrollmentStatusCopy(view({ status: "expired" }), {
      wasAttested: true,
    })
    expect(expiredAfterAttest.canRestart).toBe(true)
    expect(expiredAfterAttest.message).toContain("Stolen Device Protection")
    expect(expiredAfterAttest.message).toContain('"Always"')
    expect(expiredAfterAttest.message).toContain("about an hour")

    // Tab slept through attested and woke up expired (platform was already bound):
    const expiredWithPlatform = enrollmentStatusCopy(
      view({ status: "expired", platform: "ios" }),
    )
    expect(expiredWithPlatform.message).toContain("Stolen Device Protection")

    const cancelled = enrollmentStatusCopy(view({ status: "cancelled" }))
    expect(cancelled.canRestart).toBe(true)
    expect(cancelled.title).toContain("cancelled")
  })

  it("maps known refusal words to plain copy and falls back without leaking raw codes", () => {
    expect(refusalMessage("mac_not_apple_silicon")).toContain("Apple silicon")
    expect(refusalMessage("macos_too_old")).toContain("macOS 14")
    expect(refusalMessage("unsupported_product")).toContain("not supported")
    expect(refusalMessage("mailbox_suspended")).toContain("suspended")
    expect(refusalMessage("payment_hold")).toContain("payment hold")

    const unknown = enrollmentStatusCopy(
      view({ status: "refused", refusal: "weird_internal_code_99" }),
    )
    expect(unknown.canRestart).toBe(true)
    expect(unknown.message).not.toContain("weird_internal_code_99")
  })

  it("maps POST start failures for no_mailbox, other 409s and 503", () => {
    const noMailbox = startEnrollmentError({
      status: 409,
      name: "no_mailbox",
      error: "The API answered 409.",
    })
    expect(noMailbox.retryable).toBe(false)
    expect(noMailbox.message).toContain("no mailbox")

    const suspended = startEnrollmentError({
      status: 409,
      name: "mailbox_suspended",
      error: "The API answered 409.",
    })
    expect(suspended.retryable).toBe(true)
    expect(suspended.message).toContain("suspended")

    const unknown409 = startEnrollmentError({
      status: 409,
      name: "mystery_code",
      error: "The API answered 409.",
    })
    expect(unknown409.message).not.toContain("mystery_code")

    const keysOff = startEnrollmentError({
      status: 503,
      name: "keys_not_configured",
      error: "The API answered 503.",
    })
    expect(keysOff.message).toContain("not available")
    expect(keysOff.message).not.toContain("keys_not_configured")
  })
})

describe("MailDevices section server render", () => {
  const emptyShape: DevicesShape = { devices: "empty", deviceRows: 0 }
  const listShape: DevicesShape = { devices: "list", deviceRows: 1 }

  it('has id="mail-devices" and shows "Add a device" on the account page', () => {
    const emptyHtml = renderToStaticMarkup(
      <MailDevices
        on="account"
        shape={emptyShape}
        data={{ read: { state: "ok", list: { data: [], next_cursor: null } } }}
      />,
    )
    expect(emptyHtml).toContain('id="mail-devices"')
    expect(emptyHtml).toContain("Add a device")

    const listHtml = renderToStaticMarkup(
      <MailDevices
        on="account"
        shape={listShape}
        data={{
          read: { state: "ok", list: { data: [sampleDevice], next_cursor: null } },
        }}
      />,
    )
    expect(listHtml).toContain('id="mail-devices"')
    expect(listHtml).toContain("Add a device")
    expect(listHtml).toContain("Sign out all devices")
  })

  it('omits id="mail-devices" and "Add a device" on the admin mailbox view', () => {
    const emptyHtml = renderToStaticMarkup(
      <MailDevices
        on="mailbox"
        shape={emptyShape}
        data={{
          address: "ada@acme.test",
          read: { state: "ok", list: { data: [], next_cursor: null } },
        }}
      />,
    )
    expect(emptyHtml).not.toContain('id="mail-devices"')
    expect(emptyHtml).not.toContain("Add a device")

    const listHtml = renderToStaticMarkup(
      <MailDevices
        on="mailbox"
        shape={listShape}
        data={{
          address: "ada@acme.test",
          read: { state: "ok", list: { data: [sampleDevice], next_cursor: null } },
        }}
      />,
    )
    expect(listHtml).not.toContain('id="mail-devices"')
    expect(listHtml).not.toContain("Add a device")
    expect(listHtml).toContain("Sign out all devices")
  })
})
