import { describe, expect, it } from "bun:test"
import { keyringFromEnv } from "../src/crypto/keyring.js"
import { tokenKeys } from "../src/crypto/token-keys.js"

const key = (kid: string, fill: number) =>
  `${kid}:${Buffer.alloc(32, fill).toString("base64")}`
const ring = (value: string) => tokenKeys(keyringFromEnv("TOKEN_KEYS", value))

describe("token keys", () => {
  it("signs with the current key and still verifies under an older one after rotation", () => {
    const before = ring(key("k1", 1))
    const mac = before.sign("mailbox-download", "payload")
    const after = ring(`${key("k2", 2)},${key("k1", 1)}`)
    expect(after.verify("mailbox-download", "payload", mac)).toBe("k1")
    expect(
      after.verify(
        "mailbox-download",
        "payload",
        after.sign("mailbox-download", "payload"),
      ),
    ).toBe("k2")
  })

  it("stops verifying once the old key is removed", () => {
    const mac = ring(key("k1", 1)).sign("mailbox-download", "payload")
    expect(ring(key("k2", 2)).verify("mailbox-download", "payload", mac)).toBeNull()
  })

  it("keeps each use apart: a MAC for one use never verifies as another", () => {
    const keys = ring(key("k1", 1))
    const mac = keys.sign("dns-oauth-state", "payload")
    expect(keys.verify("dns-oauth-state", "payload", mac)).toBe("k1")
    expect(keys.verify("dns-oauth-pkce", "payload", mac)).toBeNull()
    expect(keys.verify("mailbox-download", "payload", mac)).toBeNull()
  })

  it("refuses changed data, a truncated MAC and a second spelling of the same bytes", () => {
    const keys = ring(key("k1", 1))
    const mac = keys.sign("mailbox-download", "payload")
    expect(keys.verify("mailbox-download", "payloaD", mac)).toBeNull()
    expect(keys.verify("mailbox-download", "payload", mac.slice(0, -1))).toBeNull()
    expect(keys.verify("mailbox-download", "payload", `${mac}=`)).toBeNull()
  })
})
