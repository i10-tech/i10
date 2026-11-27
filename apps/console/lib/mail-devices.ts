import { MAX_SKELETON_ROWS } from "@/lib/list-counts"

/**
 * Mail devices (#383): the iPhones, iPads and Macs that sign in to a mailbox
 * with their own device code. The API's shape (`mailDeviceSchema` in
 * packages/contracts), which never carries the code or any hash of it.
 */
export type MailDevicePlatform = "ios" | "ipados" | "macos"

export interface MailDevice {
  object: "mail_device"
  id: string
  email: string
  platform: MailDevicePlatform
  device_name: string | null
  model: string | null
  serial: string | null
  created_at: string
  first_used_at: string | null
  last_used_at: string | null
  created_by: string
  has_certificate_key: boolean
}

export interface MailDeviceList {
  data: MailDevice[]
  next_cursor: string | null
}

export const NO_DEVICES: readonly MailDevice[] = []

const PLATFORM_LABELS: Record<MailDevicePlatform, string> = {
  ios: "iPhone",
  ipados: "iPad",
  macos: "Mac",
}

export const platformLabel = (platform: MailDevicePlatform) => PLATFORM_LABELS[platform]

/** What a person calls it: the name they gave it, else the model, else the platform. */
export const deviceTitle = (device: MailDevice) =>
  device.device_name ?? device.model ?? platformLabel(device.platform)

/** The second line under a device's name: model and serial, where known and not the title. */
export function deviceDetail(device: MailDevice): string | null {
  const title = deviceTitle(device)
  const parts = [
    device.model && device.model !== title ? device.model : null,
    device.serial ? `Serial ${device.serial}` : null,
  ].filter((p): p is string => p !== null)
  return parts.length > 0 ? parts.join(" · ") : null
}

/**
 * The part of a page's shape a devices section decides: the list, its empty
 * card, the error, or nothing at all (the API answered 404: not this viewer's
 * to see).
 */
export type DevicesShapeState = "list" | "empty" | "error" | "hidden"

export interface DevicesShape {
  devices: DevicesShapeState
  /** Device rows to draw, capped. */
  deviceRows: number
}

export const DEVICES_FALLBACK: DevicesShape = { devices: "empty", deviceRows: 0 }

/** What a page's read of `/console/mail-devices` came back as. */
export type DevicesRead =
  { state: "ok"; list: MailDeviceList } | { state: "error" } | { state: "hidden" }

export function devicesShapeOf(read: DevicesRead): DevicesShape {
  if (read.state !== "ok") return { devices: read.state, deviceRows: 0 }
  const n = read.list.data.length
  return {
    devices: n === 0 ? "empty" : "list",
    deviceRows: Math.min(n, MAX_SKELETON_ROWS),
  }
}

const STATES: DevicesShapeState[] = ["list", "empty", "error", "hidden"]

/** Validates a remembered devices slice; null drops the whole shape for its fallback. */
export function parseDevicesShape(r: Record<string, unknown>): DevicesShape | null {
  const devices = STATES.find((s) => s === r.devices)
  const rows = r.deviceRows
  if (!devices || typeof rows !== "number" || !Number.isInteger(rows) || rows < 0) {
    return null
  }
  return { devices, deviceRows: Math.min(rows, MAX_SKELETON_ROWS) }
}

/**
 * A page's `tryApi` answer as a `DevicesRead`. A 404 hides the section: the API
 * answers it when the devices are not this viewer's to see, and says no more.
 */
export function devicesReadOf(
  result:
    { ok: true; data: MailDeviceList } | { ok: false; error: { statusCode: number } },
): DevicesRead {
  if (result.ok) return { state: "ok", list: result.data }
  return result.error.statusCode === 404 ? { state: "hidden" } : { state: "error" }
}
