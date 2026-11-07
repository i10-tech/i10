import { createHmac } from "node:crypto"
import { describe, expect, it } from "bun:test"
import { EDGE_HEADER, edgeHeader, signedContext, viaEdge } from "../lib/edge-context"

/**
 * The console signs the browser's address for the API only when the request
 * provably came through our Cloudflare zone (x-i10-edge equal to EDGE_SECRET).
 */

const EDGE = "edge-secret-for-tests-0123456789abcdef"
const CONTEXT = "context-secret-for-tests-0123456789ab"
const secrets = { context: CONTEXT, edge: EDGE }
const h = (init: Record<string, string>) => new Headers(init)
const cf = { "cf-connecting-ip": "198.51.100.4", "cf-ipcountry": "DE" }

const read = (signed: string) => {
  const [payload, sig] = signed.split(".") as [string, string]
  expect(sig).toBe(createHmac("sha256", CONTEXT).update(payload).digest("base64url"))
  return JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<
    string,
    unknown
  >
}

describe("viaEdge", () => {
  it("accepts the exact secret only", () => {
    expect(viaEdge(h({ [EDGE_HEADER]: EDGE }), EDGE)).toBe(true)
    expect(viaEdge(h({ [EDGE_HEADER]: EDGE.replace(/.$/, "!") }), EDGE)).toBe(false)
    expect(viaEdge(h({ [EDGE_HEADER]: EDGE.slice(1) }), EDGE)).toBe(false)
    expect(viaEdge(h({}), EDGE)).toBe(false)
    expect(viaEdge(h({ [EDGE_HEADER]: EDGE }), undefined)).toBe(false)
    expect(viaEdge(h({ [EDGE_HEADER]: "" }), "")).toBe(false)
  })

  it("only releases a cf header with the proof", () => {
    expect(
      edgeHeader(h({ ...cf, [EDGE_HEADER]: EDGE }), "cf-connecting-ip", EDGE),
    ).toBe("198.51.100.4")
    expect(edgeHeader(h(cf), "cf-connecting-ip", EDGE)).toBeNull()
  })
})

describe("signedContext", () => {
  it("signs the address and country when the edge proof is there", () => {
    const signed = signedContext(h({ ...cf, [EDGE_HEADER]: EDGE }), secrets, {
      tz: "Europe/Berlin",
    })
    expect(read(signed!)).toMatchObject({
      ip: "198.51.100.4",
      country: "DE",
      tz: "Europe/Berlin",
    })
  })

  it("signs nothing for an address it could not prove", () => {
    expect(signedContext(h(cf), secrets)).toBeNull()
    expect(signedContext(h({ ...cf, [EDGE_HEADER]: "wrong" }), secrets)).toBeNull()
    expect(
      signedContext(h({ ...cf, [EDGE_HEADER]: EDGE }), {
        context: CONTEXT,
        edge: undefined,
      }),
    ).toBeNull()
  })
})
