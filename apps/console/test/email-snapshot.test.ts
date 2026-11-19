import { describe, expect, it } from "bun:test"
import { inlineAssets, type AssetKind, type FetchAsset } from "../lib/email-snapshot"

/**
 * The asset inlining behind the template snapshots: what is asked for, what
 * replaces it, and what happens when an asset cannot be had.
 */

const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="

function fake(files: Record<string, string | null>) {
  const calls: [string, AssetKind][] = []
  const fetchAsset: FetchAsset = async (url, kind) => {
    calls.push([url, kind])
    return files[url] ?? null
  }
  return { fetchAsset, calls }
}

describe("inlineAssets", () => {
  it("inlines an <img> and drops its srcset", async () => {
    const { fetchAsset } = fake({ "https://cdn.test/a.png": "data:image/png;base64,AAA" })
    const out = await inlineAssets(
      '<img src="https://cdn.test/a.png" srcset="https://cdn.test/a2.png 2x" width="40" alt="x &amp; y">',
      fetchAsset,
    )
    expect(out).toBe('<img src="data:image/png;base64,AAA" width="40" alt="x &amp; y">')
  })

  it("keeps the box of a failed image with a transparent pixel", async () => {
    const { fetchAsset } = fake({})
    const out = await inlineAssets('<img width="120" height="30" src="https://cdn.test/gone.png">', fetchAsset)
    expect(out).toContain(`src="${PIXEL}"`)
    expect(out).toContain('width="120"')
    expect(out).toContain('height="30"')
  })

  it("reads an entity-escaped address and a protocol-relative one", async () => {
    const { fetchAsset, calls } = fake({})
    await inlineAssets(
      '<img src="https://cdn.test/a.png?x=1&amp;y=2"><img src="//cdn.test/b.png">',
      fetchAsset,
    )
    expect(calls.map((c) => c[0]).sort()).toEqual([
      "https://cdn.test/a.png?x=1&y=2",
      "https://cdn.test/b.png",
    ])
  })

  it("leaves data:, cid: and unfilled variables alone", async () => {
    const { fetchAsset, calls } = fake({})
    const html =
      '<img src="data:image/png;base64,AAA"><img src="cid:logo"><img src="{{{ logo }}}"><a href="https://x.test">x</a>'
    expect(await inlineAssets(html, fetchAsset)).toBe(html)
    expect(calls).toEqual([])
  })

  it("inlines background images in inline styles and the background attribute", async () => {
    const { fetchAsset } = fake({
      "https://cdn.test/bg.jpg": "data:image/jpeg;base64,BBB",
      "https://cdn.test/t.png": "data:image/png;base64,TTT",
    })
    const out = await inlineAssets(
      `<td style="font-family:'Arial';background-image:url('https://cdn.test/bg.jpg')" background="https://cdn.test/t.png">`,
      fetchAsset,
    )
    expect(out).toContain("background-image:url(data:image/jpeg;base64,BBB)")
    expect(out).toContain('background="data:image/png;base64,TTT"')
    expect(out).toContain("font-family:'Arial'")
  })

  it("inlines fonts and images in <style>, and drops a failed font", async () => {
    const { fetchAsset, calls } = fake({
      "https://f.test/a.woff2": "data:font/woff2;base64,FFF",
      "https://cdn.test/h.png": "data:image/png;base64,HHH",
    })
    const out = await inlineAssets(
      `<style>@font-face{font-family:A;src:url(https://f.test/a.woff2) format("woff2")}` +
        `@font-face{font-family:B;src:url("https://f.test/missing.woff")}` +
        `.h{background:url("https://cdn.test/h.png")}</style>`,
      fetchAsset,
    )
    expect(out).toContain("src:url(data:font/woff2;base64,FFF) format(\"woff2\")")
    expect(out).toContain("src:url(data:,)")
    expect(out).toContain("url(data:image/png;base64,HHH)")
    expect(calls.find((c) => c[0].endsWith("a.woff2"))?.[1]).toBe("font")
    expect(calls.find((c) => c[0].endsWith("h.png"))?.[1]).toBe("image")
  })

  it("replaces a stylesheet link with its CSS, resolving relative urls against it", async () => {
    const { fetchAsset, calls } = fake({
      "https://css.test/sheet/mail.css":
        "@import url(https://css.test/other.css); @font-face{font-family:C;src:url(../fonts/c.woff2)} p{color:red}",
      "https://css.test/fonts/c.woff2": "data:font/woff2;base64,CCC",
    })
    const out = await inlineAssets(
      '<head><link rel="stylesheet" href="https://css.test/sheet/mail.css"></head>',
      fetchAsset,
    )
    expect(out).toContain("<style>")
    expect(out).toContain("url(data:font/woff2;base64,CCC)")
    expect(out).toContain("p{color:red}")
    expect(out).not.toContain("<link")
    expect(out).not.toContain("@import")
    expect(calls[0]).toEqual(["https://css.test/sheet/mail.css", "css"])
  })

  it("drops a stylesheet link it could not fetch", async () => {
    const { fetchAsset } = fake({})
    expect(await inlineAssets('<link rel="stylesheet" href="https://css.test/x.css">', fetchAsset)).toBe("")
  })

  it("ignores comments, such as Outlook's conditional blocks", async () => {
    const { fetchAsset, calls } = fake({})
    const html = '<!--[if mso]><img src="https://cdn.test/mso.png"><![endif]-->'
    expect(await inlineAssets(html, fetchAsset)).toBe(html)
    expect(calls).toEqual([])
  })

  it("fetches one URL once and caps the distinct assets", async () => {
    const { fetchAsset, calls } = fake({})
    const same = '<img src="https://cdn.test/a.png"><img src="https://cdn.test/a.png">'
    await inlineAssets(same, fetchAsset)
    expect(calls).toHaveLength(1)

    const many = Array.from({ length: 60 }, (_, i) => `<img src="https://cdn.test/${i}.png">`).join("")
    const capped = fake({})
    const out = await inlineAssets(many, capped.fetchAsset)
    expect(capped.calls).toHaveLength(40)
    expect(out).not.toContain("https://cdn.test/")
  })

  it("runs at most six fetches at once", async () => {
    let active = 0
    let peak = 0
    const fetchAsset: FetchAsset = async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return "data:image/png;base64,AAA"
    }
    const many = Array.from({ length: 30 }, (_, i) => `<img src="https://cdn.test/${i}.png">`).join("")
    await inlineAssets(many, fetchAsset)
    expect(peak).toBe(6)
  })

  it("survives a fetcher that throws", async () => {
    const out = await inlineAssets('<img src="https://cdn.test/a.png">', async () => {
      throw new Error("boom")
    })
    expect(out).toContain(PIXEL)
  })
})
