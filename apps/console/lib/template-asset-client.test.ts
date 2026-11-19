import { afterEach, describe, expect, it } from "bun:test"
import { fetchAsset } from "./template-asset-client"

/** A 429 fails the snapshot it hit, not the session; any other failure stays remembered. */

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
})

function stub(replies: Response[]) {
  let calls = 0
  globalThis.fetch = (async () =>
    replies[Math.min(calls++, replies.length - 1)]!.clone()) as unknown as typeof fetch
  return () => calls
}

const png = () =>
  new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("fetchAsset", () => {
  it("does not remember a 429 past its Retry-After", async () => {
    const calls = stub([
      new Response(null, { status: 429, headers: { "Retry-After": "0" } }),
      png(),
    ])
    const url = "https://cdn.example.com/limited.png"
    expect(await fetchAsset(url, "image")).toBeNull()
    // Within the wait the same snapshot still gets the failure, with no new request.
    expect(await fetchAsset(url, "image")).toBeNull()
    expect(calls()).toBe(1)
    await tick(20)
    expect(await fetchAsset(url, "image")).toBe("data:image/png;base64,AQID")
    expect(calls()).toBe(2)
  })

  it("keeps a 429 failed until the Retry-After has passed", async () => {
    const calls = stub([
      new Response(null, { status: 429, headers: { "Retry-After": "60" } }),
      png(),
    ])
    const url = "https://cdn.example.com/waiting.png"
    expect(await fetchAsset(url, "image")).toBeNull()
    await tick(20)
    expect(await fetchAsset(url, "image")).toBeNull()
    expect(calls()).toBe(1)
  })

  it("still remembers any other failure for the session", async () => {
    const calls = stub([new Response(null, { status: 502 }), png()])
    const url = "https://cdn.example.com/dead.png"
    expect(await fetchAsset(url, "image")).toBeNull()
    await tick(20)
    expect(await fetchAsset(url, "image")).toBeNull()
    expect(calls()).toBe(1)
  })

  it("fetches our own CDN directly, never through the proxy", async () => {
    const seen: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "application/octet-stream" },
      })
    }) as unknown as typeof fetch
    const font = "https://cdn.i10.tech/catalogue/inter@5.0.0/latin-400-normal.woff2"
    expect(await fetchAsset(font, "font")).toBe("data:font/woff2;base64,AQID")
    expect(seen).toEqual([font])
    const other = "https://fonts.example.com/x.woff2"
    await fetchAsset(other, "font")
    expect(seen[1]).toStartWith("/api/template-asset?")
  })
})
