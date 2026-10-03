import { afterEach, describe, expect, it } from "bun:test"
import { computeEnvironment } from "../app/_lib/platform"

/**
 * Which glyph the passkey screen draws, by platform.
 *
 * ⚠ THE CASE THAT MATTERS MOST IS THE NEGATIVE ONE: Apple's Face ID and Touch
 * ID must never be drawn on anything that is not an Apple device.
 */

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  android:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  linux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
}

const original = Object.getOwnPropertyDescriptor(globalThis, "navigator")

function on(userAgent: string, maxTouchPoints: number) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent, maxTouchPoints },
    configurable: true,
  })
  return computeEnvironment()
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "navigator", original)
})

describe("the passkey screen's glyph", () => {
  it("is Face ID on an iPhone and an iPad", () => {
    expect(on(UA.iphone, 5).biometric).toBe("face-id")
    expect(on(UA.ipad, 5).biometric).toBe("face-id")
  })

  it("is Touch ID on a Mac, in Safari and in Chrome", () => {
    expect(on(UA.macSafari, 0).biometric).toBe("touch-id")
    expect(on(UA.macChrome, 0).biometric).toBe("touch-id")
  })

  it("is Android's fingerprint on Android", () => {
    expect(on(UA.android, 5).biometric).toBe("android")
  })

  it("is Windows Hello on Windows", () => {
    expect(on(UA.windows, 0).biometric).toBe("windows")
  })

  it("is the plain passkey icon anywhere else", () => {
    expect(on(UA.linux, 0).biometric).toBe("passkey")
  })

  it("is never Apple's on a non-Apple device", () => {
    for (const ua of [UA.android, UA.windows, UA.linux]) {
      for (const touch of [0, 5]) {
        expect(["face-id", "touch-id"]).not.toContain(on(ua, touch).biometric)
      }
    }
  })
})
