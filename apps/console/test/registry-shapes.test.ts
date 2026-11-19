import { describe, expect, test } from "bun:test"
import { mergeShapes } from "@/lib/shapes"
import { PAGE_SHAPES } from "@/lib/shapes/registry"

const COUNTS = {
  domains: 2,
  transfers: 0,
  apiKeys: 4,
  emails: 7,
  logs: 3,
  suppressions: 1,
  contacts: 6,
  segments: 2,
  topics: 5,
  broadcasts: 9,
  webhooks: 1,
  templates: 8,
  templateFolders: 2,
  trustedTemplates: 1,
  githubConfigured: 1,
  githubInstallations: 1,
  githubRepos: 2,
  ssoConnections: 5,
  ssoDirectories: 3,
  plans: 3,
  planEntitlements: 5,
  // From /console/me, added by the layout: a Pro workspace.
  billingPlan: 1,
  billingCustom: 0,
  billingSubscription: 1,
}

describe("first-visit shapes from GET /console/shapes", () => {
  test("every registered list page draws its count, with no cookie", () => {
    const shapes = mergeShapes({}, COUNTS, PAGE_SHAPES)
    for (const def of PAGE_SHAPES) expect(shapes[def.page]).toBeDefined()
    const read = (page: string) => JSON.parse(shapes[page]!)
    expect(read("domains").rows).toBe(2)
    expect(read("api-keys").rows).toBe(4)
    expect(read("emails").rows).toBe(7)
    expect(read("logs")).toEqual({ rows: 3, keys: 4, hasMore: false })
    expect(read("contacts")).toEqual({ rows: 6, segments: 2, hasMore: false })
    expect(read("broadcasts").rows).toBe(9)
    expect(read("webhooks").endpoints).toBe(1)
    expect(read("templates")).toMatchObject({
      templates: 8,
      folders: 2,
      github: true,
      githubInstalled: true,
      githubRepos: 2,
      trusted: 1,
    })
    expect(read("sso")).toMatchObject({ connections: 5, directories: 3 })
    expect(read("billing")).toMatchObject({
      subscription: "active",
      plans: 3,
      entitlements: 5,
      note: null,
    })
  })

  test("a zero count draws the empty state, not the default", () => {
    const shapes = mergeShapes({}, { ...COUNTS, topics: 0 }, PAGE_SHAPES)
    expect(JSON.parse(shapes.topics!).rows).toBe(0)
  })

  test("a remembered shape beats the count", () => {
    const shapes = mergeShapes(
      { topics: '{"rows":1,"view":"grid"}' },
      COUNTS,
      PAGE_SHAPES,
    )
    expect(JSON.parse(shapes.topics!)).toEqual({ rows: 1, view: "grid" })
  })
})
