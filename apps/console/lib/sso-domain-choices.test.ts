import { describe, expect, it } from "bun:test"
import { domainChoices } from "./sso-domain-choices"

const domain = (id: string, name = id) => ({
  id,
  name,
  source: "txt" as const,
  status: "verified" as const,
  txt: { name: "", value: "" },
  rules: [],
  orphaned: false,
  verified_at: null,
  checked_at: null,
  created_at: "",
})

describe("domainChoices", () => {
  it("keeps order, drops the current connection's domains, and marks other owners", () => {
    expect(
      domainChoices(
        [domain("one"), domain("two"), domain("three")],
        [
          { id: "self", name: "Current", domains: [{ joinDomainId: "one" }] },
          { id: "other", name: "Other", domains: [{ joinDomainId: "two" }] },
        ],
        { id: "self", domains: [{ joinDomainId: "one" }] },
      ),
    ).toEqual([
      {
        id: "two",
        name: "two",
        source: "txt",
        coveredBy: { id: "other", name: "Other" },
      },
      { id: "three", name: "three", source: "txt", coveredBy: null },
    ])
  })

  it("goes by the screen's own domains, not a list read before a change", () => {
    const stale = [{ id: "self", name: "Current", domains: [{ joinDomainId: "one" }] }]
    expect(
      domainChoices([domain("one"), domain("two")], stale, {
        id: "self",
        domains: [{ joinDomainId: "two" }],
      }).map((d) => [d.id, d.coveredBy]),
    ).toEqual([["one", null]])
  })

  it("treats a domain as free when no connection covers it", () => {
    expect(domainChoices([domain("one")], [], null)[0]?.coveredBy).toBeNull()
  })
})
