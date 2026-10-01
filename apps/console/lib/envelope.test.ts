import { describe, expect, it } from "bun:test"
import {
  addressOf,
  domainOf,
  fromProblem,
  replyToProblem,
  subjectProblem,
} from "./envelope"

describe("the template envelope", () => {
  it("reads an address with or without a display name", () => {
    expect(addressOf("hi@acme.test")).toBe("hi@acme.test")
    expect(addressOf("Acme <hi@acme.test>")).toBe("hi@acme.test")
    expect(addressOf('"Acme, Inc" <hi@acme.test>')).toBe("hi@acme.test")
    expect(addressOf("nope")).toBeNull()
    expect(domainOf("Acme <Hi@Acme.Test>")).toBe("acme.test")
  })

  it("accepts a sender only on a verified domain, and an empty one", () => {
    expect(fromProblem("", ["acme.test"])).toBeNull()
    expect(fromProblem("Acme <hi@acme.test>", ["acme.test"])).toBeNull()
    expect(fromProblem("hi@mail.acme.test", ["acme.test"])).toContain("not verified")
    expect(fromProblem("hi@acme.test", [])).toContain("Verify a domain")
    expect(fromProblem("acme", ["acme.test"])).toContain("Write it as")
    expect(fromProblem("Evil\r\nBcc: x <hi@acme.test>", ["acme.test"])).toBe(
      "A sender is one line.",
    )
  })

  it("checks every reply-to address and the subject's one line", () => {
    expect(replyToProblem("a@acme.test, Help <b@acme.test>")).toBeNull()
    expect(replyToProblem("a@acme.test, nope")).toBe("nope is not an email address.")
    expect(subjectProblem("Hi {{ name }}")).toBeNull()
    expect(subjectProblem("Hi\nthere")).toBe("A subject is one line.")
  })
})
