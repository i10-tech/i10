import { describe, expect, it } from "bun:test"
import { domainCompletion, domainCorrection } from "../src/email-domains"

describe("domainCompletion", () => {
  it("waits for an @ with something before it", () => {
    expect(domainCompletion("")).toBeNull()
    expect(domainCompletion("mohamed")).toBeNull()
    expect(domainCompletion("@")).toBeNull()
  })

  it("offers the most likely provider after a bare @", () => {
    expect(domainCompletion("mohamed@")).toBe("gmail.com")
  })

  it("filters as the domain is typed", () => {
    expect(domainCompletion("a@h")).toBe("otmail.com")
    expect(domainCompletion("a@o")).toBe("utlook.com")
    expect(domainCompletion("a@proton")).toBe(".me")
    expect(domainCompletion("a@protonm")).toBe("ail.com")
    expect(domainCompletion("a@ICL")).toBe("oud.com")
  })

  it("offers nothing once the domain is complete or unknown", () => {
    expect(domainCompletion("a@gmail.com")).toBeNull()
    expect(domainCompletion("a@dopamineus")).toBeNull()
    expect(domainCompletion("a b@g")).toBeNull()
  })

  it("splits at the last @", () => {
    expect(domainCompletion('"a@b"@y')).toBe("ahoo.com")
  })
})

describe("domainCorrection", () => {
  it("catches the slips fingers make", () => {
    expect(domainCorrection("a@gmial.com")).toBe("a@gmail.com")
    expect(domainCorrection("a@hotmial.com")).toBe("a@hotmail.com")
    expect(domainCorrection("a@gmail.co")).toBe("a@gmail.com")
    expect(domainCorrection("a@gmail.con")).toBe("a@gmail.com")
    expect(domainCorrection("a@yahooo.com")).toBe("a@yahoo.com")
    expect(domainCorrection("a@outlok.com")).toBe("a@outlook.com")
    expect(domainCorrection(" A@GMIAL.COM ")).toBe("A@gmail.com")
  })

  it("leaves correct and real neighbouring domains alone", () => {
    expect(domainCorrection("a@gmail.com")).toBeNull()
    expect(domainCorrection("a@mail.com")).toBeNull()
    expect(domainCorrection("a@ymail.com")).toBeNull()
    expect(domainCorrection("a@dopamineus.com")).toBeNull()
    expect(domainCorrection("a@gmai")).toBeNull()
    expect(domainCorrection("nope")).toBeNull()
  })
})
