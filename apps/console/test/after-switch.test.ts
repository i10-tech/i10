import { describe, expect, test } from "bun:test"
import { afterSwitch } from "../lib/after-switch"

describe("afterSwitch", () => {
  test("a page about one of the old workspace's things goes up to its list", () => {
    expect(afterSwitch("/domains/abc")).toBe("/domains")
    expect(afterSwitch("/webhooks/ep_1")).toBe("/webhooks")
    expect(afterSwitch("/webhooks/deliveries/d_1")).toBe("/webhooks")
    expect(afterSwitch("/emails/e_1")).toBe("/emails")
    expect(afterSwitch("/broadcasts/b_1")).toBe("/broadcasts")
    expect(afterSwitch("/templates/folder/f_1")).toBe("/templates")
  })
  test("every other page stays, settings included", () => {
    expect(afterSwitch("/domains")).toBe("/domains")
    expect(afterSwitch("/domains/new")).toBe("/domains/new")
    expect(afterSwitch("/settings/team")).toBe("/settings/team")
    expect(afterSwitch("/")).toBe("/")
  })
  test("only the tab survives from the query", () => {
    expect(afterSwitch("/webhooks", "?tab=deliveries&endpoint=ep_1")).toBe(
      "/webhooks?tab=deliveries",
    )
    expect(afterSwitch("/contacts", "?segment=s_1")).toBe("/contacts")
  })
})
