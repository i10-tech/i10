import { describe, expect, test } from "bun:test"
import "./parity/harness"
import { KNOWN } from "./parity/known"

const { VIEWS } = await import("./parity/cases")

describe("skeleton parity exceptions", () => {
  // ⚠ THE SECOND OF TWO DELIBERATE EDITS (test/parity/known.ts). Excusing a
  // skeleton from matching its page means changing this list too, so it is
  // never done in passing. Fix the view instead.
  test("the excused list is exactly the reviewed one", () => {
    expect(KNOWN).toEqual([])
  })

  test("every excused case exists", () => {
    const cases = new Set(
      VIEWS.flatMap((v) => v.cases.map((c) => `${v.route} (${c.name})`)),
    )
    const missing = KNOWN.map((k) => `${k.route} (${k.case})`).filter(
      (k) => !cases.has(k),
    )
    expect(missing).toEqual([])
  })

  test("every excused case says why", () => {
    expect(KNOWN.filter((k) => k.reason.trim().length < 20)).toEqual([])
  })
})
