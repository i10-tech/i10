import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { shapeFromText } from "@/lib/shapes"
import { teamShape, type TeamShape } from "@/lib/shapes/team"

const { TeamSkeleton } = await import("@/components/team-skeleton")

const shape = (over: Partial<TeamShape> = {}): TeamShape => ({
  ...teamShape.fallback,
  ...over,
})

const draw = (s: TeamShape) => renderToStaticMarkup(<TeamSkeleton shape={s} />)
const items = (html: string) => (html.match(/<li>/g) ?? []).length

describe("teamShape", () => {
  test("round-trips what the loaded panel remembers", () => {
    const remembered = shape({
      members: 9,
      invites: 2,
      requests: 2,
      waiting: 2,
      domains: 3,
      proofs: 1,
      suggestions: 1,
      removed: 4,
    })
    expect(shapeFromText(teamShape, JSON.stringify(remembered))).toEqual(remembered)
  })

  test("a value from before the shape grew falls back", () => {
    const old = { members: 2, invites: 0, canManage: true, accessDomains: false }
    expect(shapeFromText(teamShape, JSON.stringify(old))).toEqual(teamShape.fallback)
  })

  test("more proofs or waiting requests than rows cannot be remembered", () => {
    const parsed = teamShape.parse({
      ...shape({ domains: 1, requests: 1 }),
      proofs: 5,
      waiting: 5,
    })
    expect(parsed?.proofs).toBe(1)
    expect(parsed?.waiting).toBe(1)
  })
})

describe("TeamSkeleton", () => {
  test("draws a row for every remembered member, invitation and removed person", () => {
    const html = draw(shape({ members: 3, invites: 2, removed: 2 }))
    // Members, invitations, removed; requests, domains draw one neutral line each.
    expect(items(html)).toBe(3 + 2 + 1 + 1 + 2)
  })

  test("an unknown count draws a neutral bar, never the empty message", () => {
    const html = draw(shape({ invites: 0, requests: 0, domains: 0, removed: 0 }))
    expect(html).not.toContain("No pending invitations")
    expect(html).not.toContain("Nobody is removed")
    expect(html).not.toContain("No requests")
    expect(html).toContain('data-state="loading"')
  })

  test("draws only the blocks the reader will see", () => {
    const member = draw(shape({ canManage: false, accessDomains: false }))
    expect(member).not.toContain("Invitations")
    expect(member).not.toContain("Team access")
    expect(member).not.toContain("Removed and blocked")
    expect(member).toContain("Leave workspace")

    const manager = draw(shape())
    expect(manager).toContain("Invitations")
    expect(manager).toContain("Team access")
    expect(manager).toContain("Removed and blocked")
  })
})
