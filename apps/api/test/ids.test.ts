import { describe, expect, it } from "bun:test"
import { decodeId, encodeId, timestampFromUuidV7 } from "../src/ids.js"

// A real v7: the first 48 bits are the millisecond timestamp, the version
// nibble is 7, and the variant bits are 0b10.
const V7 = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const V4 = "f47ac10b-58cc-4372-a567-0e02b2c3d479"

describe("public identifiers", () => {
  it("round-trips through the prefixed form", () => {
    const encoded = encodeId("message", V7)
    expect(encoded).toBe("msg_0199a3f2b4c17f3e9d2a8b1c4e5f6071")
    expect(decodeId("message", encoded)).toBe(V7)
  })

  it("gives each kind its own prefix", () => {
    expect(encodeId("tenant", V7)).toMatch(/^ten_/)
    expect(encodeId("domain", V7)).toMatch(/^dom_/)
    expect(encodeId("apiKey", V7)).toMatch(/^key_/)
    expect(encodeId("event", V7)).toMatch(/^evt_/)
  })

  // ⚠ The reason the prefix is checked rather than stripped. A domain id in a
  // message route must be refused, not turned into a lookup that finds nothing
  // and reads as a missing record.
  it("refuses an id of the wrong kind", () => {
    expect(decodeId("message", encodeId("domain", V7))).toBeNull()
  })

  it.each([
    ["no prefix", V7],
    ["empty body", "msg_"],
    ["not hex", "msg_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"],
    ["too short", "msg_0199a3f2"],
    ["dashes kept", `msg_${V7}`],
  ])("returns null for %s", (_label, input) => {
    expect(decodeId("message", input)).toBeNull()
  })

  it("rejects a non-uuid when encoding", () => {
    expect(() => encodeId("message", "nope")).toThrow(TypeError)
  })
})

describe("the timestamp carried inside a v7", () => {
  // This is what lets a bare id resolve to one partition of core.messages
  // instead of a scan across all of them.
  it("reads the creation time back out", () => {
    const at = timestampFromUuidV7(V7)
    expect(at).toBeInstanceOf(Date)
    expect(at!.getTime()).toBe(0x0199a3f2b4c1)
  })

  it("accepts the prefixed form's decoded value", () => {
    expect(timestampFromUuidV7(decodeId("message", encodeId("message", V7))!)).toEqual(
      timestampFromUuidV7(V7),
    )
  })

  // ⚠ Not an error: a v4 has random bits where the timestamp lives, so reading
  // them as a date would produce a confident, meaningless answer. Null tells
  // the caller to fall back to a full lookup.
  it("returns null for a v4 rather than inventing a date", () => {
    expect(timestampFromUuidV7(V4)).toBeNull()
  })

  it("returns null for a v7-shaped string with the wrong variant", () => {
    expect(timestampFromUuidV7("0199a3f2-b4c1-7f3e-0d2a-8b1c4e5f6071")).toBeNull()
  })

  it("returns null for anything that is not a uuid", () => {
    expect(timestampFromUuidV7("msg_0199a3f2b4c17f3e9d2a8b1c4e5f6071")).toBeNull()
  })
})
