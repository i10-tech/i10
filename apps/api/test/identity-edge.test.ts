import { describe, expect, it } from "bun:test"
import { EDGE_HEADER, edgeHeader, viaEdge } from "../src/identity/edge.js"

/**
 * The proof a request came through our Cloudflare zone: `x-i10-edge` equal to
 * EDGE_SECRET. Without it a `cf-*` header is whatever the caller typed.
 */

const SECRET = "edge-secret-for-tests-0123456789abcdef"
const h = (init: Record<string, string>) => new Headers(init)

describe("viaEdge", () => {
  it("accepts the exact secret", () => {
    expect(viaEdge(h({ [EDGE_HEADER]: SECRET }), SECRET)).toBe(true)
  })

  it("refuses a wrong value of the same length", () => {
    expect(viaEdge(h({ [EDGE_HEADER]: SECRET.replace(/.$/, "!") }), SECRET)).toBe(false)
  })

  it("refuses a value of a different length without throwing", () => {
    expect(viaEdge(h({ [EDGE_HEADER]: SECRET.slice(0, -1) }), SECRET)).toBe(false)
    expect(viaEdge(h({ [EDGE_HEADER]: `${SECRET}x` }), SECRET)).toBe(false)
    expect(viaEdge(h({ [EDGE_HEADER]: "x" }), SECRET)).toBe(false)
  })

  it("refuses a request with no header", () => {
    expect(viaEdge(h({}), SECRET)).toBe(false)
    expect(viaEdge(h({ [EDGE_HEADER]: "" }), SECRET)).toBe(false)
  })

  it("proves nothing when no secret is configured, even for an empty or matching header", () => {
    expect(viaEdge(h({ [EDGE_HEADER]: SECRET }), undefined)).toBe(false)
    expect(viaEdge(h({ [EDGE_HEADER]: "" }), "")).toBe(false)
    expect(viaEdge(h({}), undefined)).toBe(false)
  })
})

describe("edgeHeader", () => {
  const ip = { "cf-connecting-ip": " 198.51.100.4 " }

  it("returns the trimmed cf header only with the proof", () => {
    expect(
      edgeHeader(h({ ...ip, [EDGE_HEADER]: SECRET }), "cf-connecting-ip", SECRET),
    ).toBe("198.51.100.4")
    expect(edgeHeader(h(ip), "cf-connecting-ip", SECRET)).toBeNull()
    expect(
      edgeHeader(h({ ...ip, [EDGE_HEADER]: "nope" }), "cf-connecting-ip", SECRET),
    ).toBeNull()
    expect(
      edgeHeader(h({ ...ip, [EDGE_HEADER]: SECRET }), "cf-connecting-ip", undefined),
    ).toBeNull()
  })

  it("is null for a proven request that lacks the header", () => {
    expect(edgeHeader(h({ [EDGE_HEADER]: SECRET }), "cf-ipcountry", SECRET)).toBeNull()
  })
})
