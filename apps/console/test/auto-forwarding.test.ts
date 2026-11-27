import { describe, expect, it } from "bun:test"
import { AUTO_FORWARDING_OPTIONS } from "@/components/sso/auto-forwarding"
import { previewFor } from "@/lib/preview"

describe("automatic forwarding options and preview", () => {
  it("lists all four modes in order with one line of plain copy each and no em dashes", () => {
    expect(AUTO_FORWARDING_OPTIONS.map((o) => o.value)).toEqual([
      "workspace",
      "workspace_and_members",
      "anywhere",
      "off",
    ])
    for (const option of AUTO_FORWARDING_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0)
      expect(option.description.length).toBeGreaterThan(0)
      expect(option.label).not.toContain("\u2014")
      expect(option.description).not.toContain("\u2014")
    }
  })

  it("answers workspace by default in preview mode and echoes saved modes", () => {
    expect(previewFor("/console/workspace/auto-forwarding")).toEqual({
      mode: "workspace",
    })
    expect(
      previewFor("/console/workspace/auto-forwarding", undefined, "PATCH", {
        mode: "anywhere",
        confirm_anywhere: true,
      }),
    ).toEqual({ mode: "anywhere" })
  })
})
