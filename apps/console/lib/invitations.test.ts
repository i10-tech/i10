import { describe, expect, it } from "bun:test"
import {
  DAY_MS,
  HOUR_MS,
  expiresLine,
  expiryProblem,
  expirySummary,
  instantIn,
  lastSpotWarning,
  quickPick,
  roomText,
  seatsLine,
  wallIn,
} from "./invitations"

/** How the invitation form and the Team page word expiry and capacity (#327). */

const NOW = new Date("2027-03-15T12:00:00Z")

describe("the expiry summary", () => {
  it("says the time there, how long from now, and the reader's own time", () => {
    const at = new Date(NOW.getTime() + 36 * HOUR_MS)
    expect(expirySummary(at, "Europe/Paris", NOW, "Europe/London")).toBe(
      "1:00 AM in Paris - 1 day 12 hours from now, 12:00 AM your time",
    )
  })

  it("leaves out the reader's time when it is the same", () => {
    const at = new Date(NOW.getTime() + 3 * HOUR_MS)
    expect(expirySummary(at, "Europe/Paris", NOW, "Europe/Paris")).toBe(
      "4:00 PM in Paris - 3 hours from now",
    )
  })
})

describe("a pending invitation's line", () => {
  it("says when, and roughly how long is left", () => {
    const at = new Date(NOW.getTime() + 2 * DAY_MS + 3 * HOUR_MS)
    expect(expiresLine(at, NOW, "UTC")).toBe("Expires 17 Mar, 3:00 PM - in 2 days")
    expect(expiresLine(new Date(NOW.getTime() + 90 * 60_000), NOW, "UTC")).toBe(
      "Expires 15 Mar, 1:30 PM - in 1 hour",
    )
  })
})

describe("a wall clock in a zone", () => {
  it("round-trips through one instant", () => {
    const at = instantIn(
      { year: 2027, month: 3, day: 16, hour: 15, minute: 0 },
      "Europe/Paris",
    )
    expect(at.toISOString()).toBe("2027-03-16T14:00:00.000Z")
    expect(wallIn(at, "Europe/Paris")).toEqual({
      year: 2027,
      month: 3,
      day: 16,
      hour: 15,
      minute: 0,
    })
  })

  it("lands on the right side of a daylight-saving change", () => {
    // New York moved to GMT-4 on 14 March 2027.
    expect(
      instantIn(
        { year: 2027, month: 3, day: 14, hour: 9, minute: 0 },
        "America/New_York",
      ).toISOString(),
    ).toBe("2027-03-14T13:00:00.000Z")
    expect(
      instantIn(
        { year: 2027, month: 3, day: 13, hour: 9, minute: 0 },
        "America/New_York",
      ).toISOString(),
    ).toBe("2027-03-13T14:00:00.000Z")
  })
})

describe("quick picks and bounds", () => {
  it("rounds inward to five minutes", () => {
    const now = new Date("2027-03-15T12:02:00Z")
    expect(quickPick(now, HOUR_MS).toISOString()).toBe("2027-03-15T13:05:00.000Z")
    expect(quickPick(now, 7 * DAY_MS).toISOString()).toBe("2027-03-22T12:00:00.000Z")
    expect(expiryProblem(quickPick(now, HOUR_MS), now)).toBeNull()
    expect(expiryProblem(quickPick(now, 7 * DAY_MS), now)).toBeNull()
  })

  it("refuses under an hour and over a week", () => {
    expect(expiryProblem(new Date(NOW.getTime() + 30 * 60_000), NOW)).toMatch(/an hour/)
    expect(expiryProblem(new Date(NOW.getTime() + 8 * DAY_MS), NOW)).toMatch(/7 days/)
    expect(expiryProblem(null, NOW)).toBe("Pick when it expires.")
  })
})

describe("capacity copy", () => {
  it("warns on the last spot, naming the access domains", () => {
    expect(
      lastSpotWarning({ free: 1, adding: 1, patterns: ["pslhq.app", "dev.pslhq.app"] }),
    ).toBe(
      "This invitation takes the last spot. @pslhq.app and @dev.pslhq.app sign-ups won't be able to join until a spot frees up.",
    )
    expect(lastSpotWarning({ free: 2, adding: 2, patterns: [] })).toBe(
      "These invitations take the last spots. The workspace will be full.",
    )
    expect(lastSpotWarning({ free: 3, adding: 1, patterns: [] })).toBeNull()
  })

  it("offers what would make room as one choice", () => {
    expect(roomText(["Remove a member", "Withdraw an invitation", "Upgrade"])).toBe(
      "remove a member, withdraw an invitation or upgrade",
    )
    expect(roomText([])).toBe("remove a member")
  })

  it("reads the meter's line", () => {
    expect(seatsLine({ members: 10, invitations: 3, free: 7 })).toBe(
      "10 members | 3 invitations | 7 free spots",
    )
    expect(seatsLine({ members: 1, invitations: 1, free: 1 })).toBe(
      "1 member | 1 invitation | 1 free spot",
    )
  })
})
