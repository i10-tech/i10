import type { MailDevicePlatform } from "./store.js"

/**
 * Pure platform classification rules for Apple OTA enrollment phase 2 (#383 PR 4,
 * docs/research/mail-device-binding.md section 12).
 *
 * Rules:
 *   - `iPhone<major>,<minor>` -> `ios`
 *   - `iPad<major>,<minor>` -> `ipados`
 *   - Mac identifiers -> `macos` ONLY when Apple silicon (`MacBookPro17,1`,
 *     `MacBookPro18,*`, `MacBookAir10,1`, `Macmini9,1`, `iMac21,*`, `Mac13,*`
 *     and above) AND macOS 14+ (OS build major >= 23, e.g. `23A344`).
 *   - Intel Macs -> `mac_not_apple_silicon`
 *   - Apple silicon Macs on older builds -> `macos_too_old`
 *   - Everything else -> `unsupported_product`
 */

export type PlatformRefusal =
  "unsupported_product" | "mac_not_apple_silicon" | "macos_too_old"

export type PlatformDecision =
  { ok: true; platform: MailDevicePlatform } | { ok: false; refusal: PlatformRefusal }

/** Minimum macOS build major for Secure Enclave ACME `device-attest-01` (macOS 14 Sonoma). */
export const MIN_MACOS_BUILD_MAJOR = 23

const IPHONE = /^iPhone(\d+),(\d+)$/
const IPAD = /^iPad(\d+),(\d+)$/
const MAC_MODEL =
  /^(Mac|MacBook|MacBookAir|MacBookPro|Macmini|MacPro|iMac|iMacPro)(\d+),(\d+)$/
/** Apple OS build identifier, e.g. `23A344`, `24D70`, `25A5279m`. */
const APPLE_BUILD = /^(\d+)[A-Za-z]\d+[A-Za-z]?$/

function isAppleSiliconMac(family: string, major: number, minor: number): boolean {
  switch (family) {
    case "Mac":
      return major >= 13
    case "MacBookPro":
      return (major === 17 && minor === 1) || major >= 18
    case "MacBookAir":
      return major === 10 && minor === 1
    case "Macmini":
      return major === 9 && minor === 1
    case "iMac":
      return major === 21
    default:
      return false
  }
}

/** Extracts the leading build major integer from an Apple OS build string, or null. */
export function parseAppleBuildMajor(version: string): number | null {
  const match = APPLE_BUILD.exec(version.trim())
  if (!match) return null
  const major = Number(match[1])
  return Number.isSafeInteger(major) ? major : null
}

/**
 * Classifies an Apple OTA `PRODUCT` and `VERSION` pair into a supported mail
 * device platform or a fixed refusal reason.
 */
export function classifyApplePlatform(
  product: string,
  version: string,
): PlatformDecision {
  const trimmedProduct = product.trim()
  if (IPHONE.test(trimmedProduct)) {
    return { ok: true, platform: "ios" }
  }
  if (IPAD.test(trimmedProduct)) {
    return { ok: true, platform: "ipados" }
  }

  const mac = MAC_MODEL.exec(trimmedProduct)
  if (!mac) {
    return { ok: false, refusal: "unsupported_product" }
  }
  const family = mac[1]!
  const major = Number(mac[2])
  const minor = Number(mac[3])
  if (!isAppleSiliconMac(family, major, minor)) {
    return { ok: false, refusal: "mac_not_apple_silicon" }
  }

  const buildMajor = parseAppleBuildMajor(version)
  if (buildMajor === null || buildMajor < MIN_MACOS_BUILD_MAJOR) {
    return { ok: false, refusal: "macos_too_old" }
  }
  return { ok: true, platform: "macos" }
}
