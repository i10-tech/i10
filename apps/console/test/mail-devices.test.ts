import { describe, expect, it } from "bun:test"
import {
  deviceDetail,
  deviceTitle,
  devicesReadOf,
  devicesShapeOf,
  parseDevicesShape,
  type MailDevice,
} from "@/lib/mail-devices"

const device = (over: Partial<MailDevice> = {}): MailDevice => ({
  object: "mail_device",
  id: "d1",
  email: "a@acme.test",
  platform: "ios",
  device_name: null,
  model: null,
  serial: null,
  created_at: "2026-11-01T00:00:00.000Z",
  first_used_at: null,
  last_used_at: null,
  created_by: "user_a",
  has_certificate_key: false,
  ...over,
})

describe("mail device labels", () => {
  it("names a device by its name, else its model, else its platform", () => {
    expect(
      deviceTitle(device({ device_name: "Ada's phone", model: "iPhone 17" })),
    ).toBe("Ada's phone")
    expect(deviceTitle(device({ model: "MacBook Air", platform: "macos" }))).toBe(
      "MacBook Air",
    )
    expect(deviceTitle(device({ platform: "ipados" }))).toBe("iPad")
  })

  it("lists the model and serial under the name, without repeating the title", () => {
    expect(deviceDetail(device({ model: "MacBook Air", serial: "C02X" }))).toBe(
      "Serial C02X",
    )
    expect(
      deviceDetail(
        device({ device_name: "Work", model: "MacBook Air", serial: "C02X" }),
      ),
    ).toBe("MacBook Air · Serial C02X")
    expect(deviceDetail(device())).toBeNull()
  })
})

describe("the devices section's state", () => {
  it("hides on a 404, which the API answers when the devices are not the viewer's", () => {
    expect(devicesReadOf({ ok: false, error: { statusCode: 404 } })).toEqual({
      state: "hidden",
    })
    expect(devicesReadOf({ ok: false, error: { statusCode: 500 } })).toEqual({
      state: "error",
    })
  })

  it("draws as many rows as were loaded, capped, and survives a round trip", () => {
    const list = { data: Array.from({ length: 14 }, () => device()), next_cursor: null }
    const shape = devicesShapeOf({ state: "ok", list })
    expect(shape).toEqual({ devices: "list", deviceRows: 10 })
    expect(parseDevicesShape(JSON.parse(JSON.stringify(shape)))).toEqual(shape)
    expect(parseDevicesShape({ devices: "list" })).toBeNull()
  })
})
