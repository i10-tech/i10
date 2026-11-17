import { describe, expect, test } from "bun:test"
import {
  CREATION_MODES,
  creationModeSentence,
  onJoinCaveat,
  storageSummary,
  unallocatedLine,
} from "../lib/mailbox-settings"
import type { StoragePool } from "../lib/mailbox-view"

/** Built from its code point so this file holds none itself. */
const EM_DASH = String.fromCharCode(0x2014)

const GB = 1024 ** 3

const pool = (over: Partial<StoragePool> = {}): StoragePool => ({
  kind: "pool",
  total: 20 * GB,
  allocated: 8 * GB,
  used: 2 * GB,
  remaining: 12 * GB,
  unallocated: 0,
  ...over,
})

describe("creation modes", () => {
  test("every mode the API knows has a choice and a read-only sentence", () => {
    expect(CREATION_MODES.map((m) => m.value)).toEqual(["admins", "members", "on_join"])
    for (const { value } of CREATION_MODES) {
      expect(creationModeSentence(value).length).toBeGreaterThan(20)
    }
  })

  test("copy has no em dashes", () => {
    for (const mode of CREATION_MODES) {
      expect(`${mode.label} ${mode.description}`).not.toContain(EM_DASH)
    }
  })
})

describe("onJoinCaveat", () => {
  test("only 'automatically' needs one, and only unless exactly one domain hosts mail", () => {
    expect(onJoinCaveat("admins", 0)).toBeNull()
    expect(onJoinCaveat("members", 3)).toBeNull()
    expect(onJoinCaveat("on_join", 1)).toBeNull()
    expect(onJoinCaveat("on_join", 0)).toContain("until a domain hosts mailboxes")
    expect(onJoinCaveat("on_join", 3)).toContain("3 domains")
  })
})

describe("storageSummary", () => {
  test("a pool says how much is given and how much is left", () => {
    const summary = storageSummary(pool())
    expect(summary.title).toBe("A pool you share out")
    expect(summary.body).toContain("20.0 GB")
    expect(summary.body).toContain("8.0 GB")
    expect(summary.body).toContain("12.0 GB")
  })

  test("pay as you go says it is billed on use", () => {
    const summary = storageSummary(
      pool({ kind: "uncapped", total: null, remaining: null, used: 3 * GB }),
    )
    expect(summary.title).toBe("Pay as you go")
    expect(summary.body).toContain("3.0 GB")
  })

  test("a pool with no total is read as pay as you go, not as zero left", () => {
    expect(storageSummary(pool({ total: null })).title).toBe("Pay as you go")
  })
})

describe("unallocatedLine", () => {
  test("says nothing when every mailbox has a share", () => {
    expect(unallocatedLine(pool({ unallocated: 0 }))).toBeNull()
  })

  test("counts the ones without", () => {
    expect(unallocatedLine(pool({ unallocated: 1 }))).toContain("1 mailbox has")
    expect(unallocatedLine(pool({ unallocated: 4 }))).toContain("4 mailboxes have")
  })
})
