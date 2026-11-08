import { describe, expect, it } from "bun:test"
import { draftOfSiem, siemBody, siemChanged, siemMissing } from "../lib/siem"
import type { SiemView } from "../lib/sso-types"

const view: SiemView = {
  endpoint: "https://s3.example.com",
  bucket: "audit",
  region: "eu-west-1",
  prefix: "i10/",
  accessKeyId: "AKIA1234567890ABCDEF",
  secretAccessKey: "••••wxyz",
  enabled: true,
  lastExportAt: null,
  lastError: null,
  lastErrorAt: null,
}

describe("the SIEM form", () => {
  it("starts empty and enabled before anything is saved", () => {
    expect(draftOfSiem(null)).toMatchObject({ endpoint: "", enabled: true })
  })

  it("never shows the stored key: the field starts empty", () => {
    expect(draftOfSiem(view).secretAccessKey).toBe("")
  })

  it("leaves the key out of the body when none was typed", () => {
    const body = siemBody(draftOfSiem(view))
    expect("secretAccessKey" in body).toBe(false)
  })

  it("sends a typed key, trimmed, with trimmed fields", () => {
    const body = siemBody({
      ...draftOfSiem(view),
      endpoint: " https://s3.example.com ",
      secretAccessKey: " abcdefghijklmnop ",
    })
    expect(body.secretAccessKey).toBe("abcdefghijklmnop")
    expect(body.endpoint).toBe("https://s3.example.com")
  })

  it("needs a key on the first save only", () => {
    const filled = { ...draftOfSiem(view), secretAccessKey: "" }
    expect(siemMissing(filled, false)).toBe("Enter the secret access key.")
    expect(siemMissing(filled, true)).toBeNull()
    expect(siemMissing({ ...filled, bucket: " " }, true)).toBe("Enter the bucket.")
  })

  it("counts a typed key or a changed field as a change, and nothing else", () => {
    expect(siemChanged(draftOfSiem(view), view)).toBe(false)
    expect(siemChanged({ ...draftOfSiem(view), enabled: false }, view)).toBe(true)
    expect(
      siemChanged({ ...draftOfSiem(view), secretAccessKey: "abcdefghijklmnop" }, view),
    ).toBe(true)
    expect(siemChanged(draftOfSiem(null), null)).toBe(true)
  })
})
