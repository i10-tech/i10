import { readFileSync } from "node:fs"
import { describe, expect, it } from "bun:test"
import { parseKeyEntry } from "../src/mail-devices/keyring.js"
import { parseMailDeviceCodeKeys } from "../src/mail-devices/code.js"
import { parseEdgeLinkKeys } from "../src/mail-devices/link-token.js"

// The same vectors drive Go's keyring.ParseKey (internal/keyring/vectors_test.go),
// so a key Doppler holds means the same to the API and to enrolld/enrollctl.
interface Vector {
  name: string
  input: string
  id?: number
  secret_hex?: string
  error?: boolean
}
const vectors = JSON.parse(
  readFileSync(
    new URL(
      "../../../services/authd/internal/keyring/testdata/parse-key-vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Vector[]

describe("key entries parse exactly as Go's keyring.ParseKey", () => {
  for (const v of vectors) {
    it(v.name, () => {
      if (v.error) {
        expect(() => parseKeyEntry("TEST_KEYS", v.input)).toThrow()
        expect(() => parseMailDeviceCodeKeys(v.input)).toThrow()
        expect(() => parseEdgeLinkKeys(v.input)).toThrow()
        return
      }
      const k = parseKeyEntry("TEST_KEYS", v.input)
      expect(k.id).toBe(v.id!)
      expect(k.secret.toString("hex")).toBe(v.secret_hex!)
      expect(parseMailDeviceCodeKeys(v.input).keys.get(v.id!)?.toString("hex")).toBe(
        v.secret_hex!,
      )
      expect(parseEdgeLinkKeys(v.input).byId.get(v.id!)?.toString("hex")).toBe(
        v.secret_hex!,
      )
    })
  }

  it("never quotes the entry in an error", () => {
    const secret = "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3JldA=="
    for (const bad of [`${secret}:1`, `1:${secret.slice(0, 10)}`]) {
      try {
        parseKeyEntry("TEST_KEYS", bad)
      } catch (err) {
        expect(String(err)).not.toContain(secret.slice(0, 10))
      }
    }
  })
})
