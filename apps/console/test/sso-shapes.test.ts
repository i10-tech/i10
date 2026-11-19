import { describe, expect, test } from "bun:test"
import { mergeShapes, shapeFromText } from "@/lib/shapes"
import { ssoShape } from "@/lib/shapes/sso"
import { renderLoading } from "./parity/harness"

const { SsoHomeView } = await import("@/components/sso-home-view")

// ⚠ ONLY THE EMPTY STATE SAYS THIS; the section blurb above it is static copy.
const EMPTY_STATE_COPY = "Keep members in step with"
const view = {
  route: "/settings/sso",
  pathname: "/settings/sso",
  View: SsoHomeView,
  shape: ssoShape,
  cases: [],
} as never

describe("ssoShape first visit", () => {
  test("counts from GET /console/shapes become the skeleton rows", () => {
    expect(ssoShape.fromCounts?.({ ssoConnections: 5, ssoDirectories: 3 })).toEqual({
      canManage: true,
      available: true,
      connections: 5,
      directories: 3,
    })
  })

  test("a zero is a real zero: the empty state is right for an empty workspace", () => {
    expect(
      ssoShape.fromCounts?.({ ssoConnections: 0, ssoDirectories: 0 }),
    ).toMatchObject({ connections: 0, directories: 0 })
  })

  test("counts are capped like the other lists", () => {
    expect(
      ssoShape.fromCounts?.({ ssoConnections: 99, ssoDirectories: 99 }),
    ).toMatchObject({ connections: 10, directories: 5 })
  })

  test("a count the API did not send stays unknown, never zero", () => {
    expect(ssoShape.fromCounts?.({ ssoConnections: 2 })).toMatchObject({
      connections: 2,
      directories: null,
    })
    expect(ssoShape.fromCounts?.({ ssoDirectories: 2 })).toMatchObject({
      connections: 1,
      directories: 2,
    })
  })

  test("an old API (no SSO keys) leaves the fallback", () => {
    expect(ssoShape.fromCounts?.({ domains: 3 })).toBeNull()
    expect(mergeShapes({}, { domains: 3 }, [ssoShape]).sso).toBeUndefined()
    expect(shapeFromText(ssoShape, undefined).directories).toBeNull()
  })

  test("a remembered cookie wins over the counts", () => {
    const cookie = JSON.stringify({
      canManage: true,
      available: true,
      connections: 1,
      directories: 0,
    })
    const merged = mergeShapes({ sso: cookie }, { ssoConnections: 5 }, [ssoShape])
    expect(merged.sso).toBe(cookie)
  })
})

describe("ssoShape remembered value", () => {
  test("an unknown directory count round-trips", () => {
    const shape = {
      canManage: true,
      available: true,
      connections: 2,
      directories: null,
    }
    expect(ssoShape.parse(JSON.parse(JSON.stringify(shape)))).toEqual(shape)
  })

  test("a failed directories read is remembered as unknown, not zero", () => {
    const shape = ssoShape.of({
      canManage: true,
      available: true,
      catalog: { data: [], protocols: [], presets: { oidc: [], saml: [] } },
      abilities: { manage: true, owner: true, userId: null },
    })
    expect(shape.directories).toBeNull()
  })

  test("an old cookie with plain numbers still parses", () => {
    expect(
      ssoShape.parse({
        canManage: true,
        available: true,
        connections: 2,
        directories: 1,
      }),
    ).toEqual({ canManage: true, available: true, connections: 2, directories: 1 })
  })

  test("garbage drops to the fallback", () => {
    expect(ssoShape.parse({ connections: "x", directories: 1 })).toBeNull()
    expect(ssoShape.parse({ connections: 1, directories: "x" })).toBeNull()
    expect(ssoShape.parse({ connections: 1, directories: -1 })).toBeNull()
  })
})

describe("the SSO skeleton", () => {
  const base = { canManage: true, available: true, connections: 1 }

  test("unknown directories draw rows, never the empty state", () => {
    const html = renderLoading(view, { ...base, directories: null })
    expect(html).not.toContain(EMPTY_STATE_COPY)
  })

  test("known directories draw rows", () => {
    const html = renderLoading(view, { ...base, directories: 3 })
    expect(html).not.toContain(EMPTY_STATE_COPY)
  })

  test("zero directories is the empty state", () => {
    const html = renderLoading(view, { ...base, directories: 0 })
    expect(html).toContain(EMPTY_STATE_COPY)
  })
})
