import { describe, expect, it } from "bun:test"
import { displayCopy } from "../components/email-frame"
import { nest } from "../lib/template-variables"

describe("the display copy of an email (#189)", () => {
  it("puts the policy after the doctype, so the email keeps standards mode", () => {
    const out = displayCopy("<!DOCTYPE html><html><body>x</body></html>", false)
    expect(out).toStartWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"')
    expect(out).toContain("img-src data: cid:;")
    expect(out).not.toContain("https:")
  })

  it("allows remote images only when asked", () => {
    expect(displayCopy("<p>x</p>", true)).toContain("img-src data: cid: https: http:")
  })

  it("removes a meta refresh from the copy it shows", () => {
    const out = displayCopy(
      '<meta http-equiv="refresh" content="0;url=https://evil.test"><p>x</p>',
      false,
    )
    expect(out).not.toContain("evil.test")
    expect(out).toEndWith("<p>x</p>")
  })
})

describe("sample values as a send passes them", () => {
  it("nests dotted paths", () => {
    expect(nest({ name: "Ada", "team.name": "Acme", "team.url": "u" })).toEqual({
      name: "Ada",
      team: { name: "Acme", url: "u" },
    })
  })
})
