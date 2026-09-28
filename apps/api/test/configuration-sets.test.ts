import { describe, expect, it } from "bun:test"
import {
  configurationSetFor,
  configurationSetsFor,
} from "../src/send/configuration-sets.js"

/**
 * Tracking is decided by the SES configuration set, not the message (#154), so
 * the domain's two switches must land on exactly one of four sets - and every
 * one of those four must be one an SES tenant is given.
 */
describe("choosing the configuration set", () => {
  it("maps each combination of switches to its own set", () => {
    expect(configurationSetFor("i10-events", { opens: false, clicks: false })).toBe(
      "i10-events",
    )
    expect(configurationSetFor("i10-events", { opens: true, clicks: false })).toBe(
      "i10-events-opens",
    )
    expect(configurationSetFor("i10-events", { opens: false, clicks: true })).toBe(
      "i10-events-clicks",
    )
    expect(configurationSetFor("i10-events", { opens: true, clicks: true })).toBe(
      "i10-events-tracked",
    )
  })

  // ⚠ A set a send can name but a tenant does not hold is a refused send.
  it("lists every set a send can name, for the tenant attach", () => {
    const all = configurationSetsFor("i10-events")
    for (const opens of [false, true]) {
      for (const clicks of [false, true]) {
        expect(all).toContain(configurationSetFor("i10-events", { opens, clicks }))
      }
    }
    expect(all).toHaveLength(4)
  })

  // SES's limit: 64 letters, digits, hyphens and underscores.
  it("stays within SES's name limits", () => {
    for (const name of configurationSetsFor("i10-events")) {
      expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    }
  })
})
