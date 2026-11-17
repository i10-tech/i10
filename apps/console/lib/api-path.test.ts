import { describe, expect, it } from "bun:test"
import { isReachablePath } from "./api-path"

describe("isReachablePath", () => {
  it("allows the console's own routes", () => {
    expect(isReachablePath("/console/mailboxes")).toBe(true)
    expect(isReachablePath("/console/mailboxes/a%40b.dev/aliases")).toBe(true)
  })

  it("allows the session mailbox routes: create, export and import", () => {
    expect(isReachablePath("/mailboxes")).toBe(true)
    expect(isReachablePath("/mailboxes/alice%40acme.dev/export")).toBe(true)
    expect(isReachablePath("/mailboxes/alice%40acme.dev/import/job_1/start")).toBe(true)
  })

  it("refuses every other API route", () => {
    expect(isReachablePath("/emails")).toBe(false)
    expect(isReachablePath("/mailboxes-admin")).toBe(false)
    expect(isReachablePath("/consolex/mailboxes")).toBe(false)
    expect(isReachablePath("mailboxes")).toBe(false)
  })

  it("refuses a path that climbs out of an allowed prefix", () => {
    expect(isReachablePath("/mailboxes/../emails")).toBe(false)
    expect(isReachablePath("/console/../emails")).toBe(false)
    expect(isReachablePath("/mailboxes//x")).toBe(false)
    expect(isReachablePath("/mailboxes\\x")).toBe(false)
  })

  it("refuses a path that carries its own query or fragment", () => {
    expect(isReachablePath("/mailboxes/a@b.dev/export?x=1")).toBe(false)
    expect(isReachablePath("/mailboxes/a@b.dev#top")).toBe(false)
  })
})
