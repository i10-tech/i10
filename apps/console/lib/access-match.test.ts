import { describe, expect, it } from "bun:test"
import { atDomain, modeForAddress, ruleForAddress } from "@/lib/access-match"
import type { AccessDomain } from "@/lib/actions"

const domain = (over: Partial<AccessDomain> = {}): AccessDomain => ({
  id: "jd_1",
  name: "pslhq.app",
  source: "domains",
  status: "verified",
  txt: { name: "_i10-access.pslhq.app", value: "i10-access=x" },
  rules: [
    { pattern: "pslhq.app", mode: "suggest", role: "org:member" },
    { pattern: "*.pslhq.app", mode: "auto", role: "org:member" },
    { pattern: "dev.pslhq.app", mode: "off", role: "org:member" },
  ],
  orphaned: false,
  verified_at: null,
  checked_at: null,
  created_at: "",
  ...over,
})

describe("ruleForAddress", () => {
  it("takes the most specific rule, the same way the API does", () => {
    expect(modeForAddress([domain()], "a@pslhq.app")).toBe("suggest")
    expect(modeForAddress([domain()], "a@eu.pslhq.app")).toBe("auto")
    expect(modeForAddress([domain()], "a@dev.pslhq.app")).toBe("off")
    expect(modeForAddress([domain()], "a@x.dev.pslhq.app")).toBe("auto")
  })
  it("ignores a domain whose proof is not current", () => {
    expect(ruleForAddress([domain({ status: "lapsed" })], "a@eu.pslhq.app")).toBeNull()
  })
  it("never covers a parent of the proven name", () => {
    const sub = domain({
      name: "notifications.pslhq.app",
      rules: [{ pattern: "*.pslhq.app", mode: "auto", role: "org:member" }],
    })
    expect(ruleForAddress([sub], "a@pslhq.app")).toBeNull()
  })
})

describe("atDomain", () => {
  it("names how someone joined by their address's domain", () => {
    expect(atDomain("a@dev.pslhq.app")).toBe("@dev.pslhq.app")
  })
})
