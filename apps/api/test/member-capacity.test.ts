import { describe, expect, it } from "bun:test"
import {
  capacityOf,
  clerkLimitFor,
  lastSpotWarning,
  levelOf,
  memberLimitFor,
  nextAlert,
  roomReasons,
} from "../src/console/capacity.js"
import {
  cityOf,
  expiryForEmail,
  offsetIn,
  resolveZone,
  spanOf,
  zoneCatalog,
} from "../src/console/zones.js"

/**
 * Member limits, counting and capacity alerts (#327), as arithmetic.
 */

describe("limits per plan", () => {
  it("is the plan's for a team, and one for a Personal workspace", () => {
    expect(memberLimitFor(3, false)).toBe(3)
    expect(memberLimitFor(20, false)).toBe(20)
    expect(memberLimitFor(20, true)).toBe(1)
  })

  // ⚠ A downgrade moves nobody out: Clerk is never set below the members there.
  it("gives Clerk the larger of the limit and the members already in", () => {
    expect(clerkLimitFor(20, 4)).toBe(20)
    expect(clerkLimitFor(3, 4)).toBe(4)
    expect(clerkLimitFor(3, 3)).toBe(3)
  })
})

describe("counting", () => {
  it("counts members plus invitations for full, as Clerk does", () => {
    expect(capacityOf({ members: 10, invitations: 3, limit: 20 })).toEqual({
      members: 10,
      invitations: 3,
      limit: 20,
      free: 7,
      full: false,
    })
    expect(capacityOf({ members: 2, invitations: 1, limit: 3 }).full).toBe(true)
    // Over the limit after a downgrade: full, and never negative spots.
    expect(capacityOf({ members: 5, invitations: 0, limit: 3 })).toMatchObject({
      free: 0,
      full: true,
    })
  })

  it("counts members only for alerts", () => {
    // 10 members and 6 invitations is 80% of seats taken, but not an alert.
    expect(levelOf(10, 20)).toBe(0)
    expect(levelOf(16, 20)).toBe(80)
    expect(levelOf(15, 20)).toBe(0)
    expect(levelOf(20, 20)).toBe(100)
    expect(levelOf(21, 20)).toBe(100)
    // Free's three: two is 66%, three is full.
    expect(levelOf(2, 3)).toBe(0)
    expect(levelOf(3, 3)).toBe(100)
  })
})

describe("alert crossings", () => {
  it("sends once per crossing and stays quiet while it wobbles", () => {
    let level = nextAlert(0, 16, 20)
    expect(level).toEqual({ level: 80, send: 80 })
    level = nextAlert(level.level, 17, 20)
    expect(level).toEqual({ level: 80, send: null })
    level = nextAlert(level.level, 20, 20)
    expect(level).toEqual({ level: 100, send: 100 })
    // Back to 90%: nothing, not even a second 80.
    level = nextAlert(level.level, 18, 20)
    expect(level).toEqual({ level: 100, send: null })
    level = nextAlert(level.level, 20, 20)
    expect(level).toEqual({ level: 100, send: null })
  })

  it("re-arms below 80%", () => {
    let level = nextAlert(100, 15, 20)
    expect(level).toEqual({ level: 0, send: null })
    level = nextAlert(level.level, 16, 20)
    expect(level).toEqual({ level: 80, send: 80 })
  })

  it("sends the higher alert alone when one change jumps past both", () => {
    expect(nextAlert(0, 20, 20)).toEqual({ level: 100, send: 100 })
    // A downgrade from 20 to 3 with five members.
    expect(nextAlert(0, 5, 3)).toEqual({ level: 100, send: 100 })
  })
})

describe("what would make room", () => {
  it("names only what applies", () => {
    expect(roomReasons({ invitations: 2, canUpgrade: true })).toEqual([
      "Remove a member",
      "Withdraw an invitation",
      "Upgrade",
    ])
    expect(roomReasons({ invitations: 0, canUpgrade: false })).toEqual([
      "Remove a member",
    ])
  })
})

describe("the last-spot warning", () => {
  it("names the access domains it shuts out", () => {
    expect(
      lastSpotWarning({ free: 1, adding: 1, patterns: ["pslhq.app", "dev.pslhq.app"] }),
    ).toBe(
      "This invitation takes the last spot. @pslhq.app and @dev.pslhq.app sign-ups won't be able to join until a spot frees up.",
    )
  })

  it("covers a batch that crosses it", () => {
    expect(lastSpotWarning({ free: 3, adding: 3, patterns: ["a.app"] })).toBe(
      "These invitations take the last spots. @a.app sign-ups won't be able to join until a spot frees up.",
    )
  })

  it("just says full without access rules", () => {
    expect(lastSpotWarning({ free: 1, adding: 1, patterns: [] })).toBe(
      "This invitation takes the last spot. The workspace will be full.",
    )
  })

  it("says nothing short of the last spot, or past it", () => {
    expect(lastSpotWarning({ free: 3, adding: 2, patterns: [] })).toBeNull()
    // More than the free spots is a refusal, not a warning.
    expect(lastSpotWarning({ free: 1, adding: 2, patterns: [] })).toBeNull()
    expect(lastSpotWarning({ free: 0, adding: 1, patterns: [] })).toBeNull()
  })
})

describe("countries and time zones", () => {
  it("comes from the runtime, with several zones for the US", () => {
    const catalog = zoneCatalog()
    const us = catalog.countries.find((c) => c.code === "US")
    const fr = catalog.countries.find((c) => c.code === "FR")
    expect(us?.name).toBe("United States")
    expect(us!.zones.length).toBeGreaterThan(1)
    expect(fr?.zones.map((z) => z.id)).toEqual(["Europe/Paris"])
    expect(catalog.zones.length).toBeGreaterThan(400)
  })

  it("checks a country uses the zone it is paired with", () => {
    expect(resolveZone({ zone: "Europe/Paris", country: "FR" })).toEqual({
      zone: "Europe/Paris",
      country: "FR",
    })
    expect(resolveZone({ zone: "Asia/Tokyo" })).toEqual({
      zone: "Asia/Tokyo",
      country: null,
    })
    expect(resolveZone({ zone: "Europe/Paris", country: "US" })).toBeNull()
    expect(resolveZone({ zone: "Mars/Olympus" })).toBeNull()
    expect(resolveZone({ zone: "Europe/Paris", country: "fr" })).toBeNull()
  })

  it("words the email's expiry by city for a country, by offset for a zone", () => {
    // 13:00 UTC on 15 March 2027 is 2 PM in Paris (winter time, GMT+1).
    const at = new Date("2027-03-15T13:00:00Z")
    expect(expiryForEmail(at, { zone: "Europe/Paris", country: "FR" })).toBe(
      "15 March at 2:00 PM Paris time",
    )
    expect(expiryForEmail(at, { zone: "Europe/Paris", country: null })).toBe(
      "15 March at 2:00 PM GMT+1",
    )
    // In summer the offset follows daylight saving.
    expect(offsetIn(new Date("2027-07-01T12:00:00Z"), "Europe/Paris")).toBe("GMT+2")
    expect(cityOf("America/Argentina/Buenos_Aires")).toBe("Buenos Aires")
  })

  it("says how long is left in the two largest units", () => {
    expect(spanOf(36 * 3600_000)).toBe("1 day 12 hours")
    expect(spanOf(3 * 3600_000)).toBe("3 hours")
    expect(spanOf(45 * 60_000)).toBe("45 minutes")
    expect(spanOf(7 * 24 * 3600_000)).toBe("7 days")
  })
})
