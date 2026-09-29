import { describe, expect, it } from "bun:test"
import {
  classify,
  describe as describeSkeleton,
  parseSubmission,
  trustMark,
  valueHosts,
  type Skeleton,
  type TrustContext,
  type TrustEntry,
} from "../src/content/trust.js"
import { render, splitBody } from "../src/content/templates.js"

/**
 * Trusted content (#222): what counts as "this message IS that template".
 *
 * The line these tests hold: credit only for an exact fit of the fixed part,
 * holes within their limits, no markup in a hole, and no link in a hole that
 * leaves the sending workspace's own verified, Web Risk-clean domains.
 */

const RESET_HTML =
  "<html><body><h1>Reset your password</h1><p>Hi {{name}},</p>" +
  "<p>Someone asked to reset the password for your Acme account. If it was you, " +
  'use the button below within the next hour.</p><p><a href="{{url}}">Reset password</a></p>' +
  "<p>If you did not ask, ignore this email and nothing changes.</p></body></html>"

const skeleton = (html = RESET_HTML, holes?: Record<string, number>): Skeleton => {
  const s = parseSubmission({ html, text: null, ...(holes ? { holes } : {}) })
  if ("error" in s) throw new Error(s.error)
  return s
}

const entry = (
  s: Skeleton,
  kind: TrustEntry["kind"] = "template",
  id = "t1",
): TrustEntry => ({
  kind,
  id,
  name: kind === "template" ? "Password reset" : "acme/reset",
  template: s.template,
  limits: s.holes.map((h) => h.max),
})

const ctx = (over: Partial<TrustContext> = {}): TrustContext => ({
  verifiedParents: new Set(["acme.com"]),
  verdict: async () => "clean",
  ...over,
})

const fill = (s: Skeleton, values: string[]) => splitBody(render(s.template, values))

describe("parseSubmission", () => {
  it("turns placeholders into holes with limits, and keeps the rest fixed", () => {
    const s = skeleton(RESET_HTML, { name: 40 })
    expect(s.holes).toEqual([
      { name: "name", max: 40 },
      { name: "url", max: 100 },
    ])
    expect(s.template.segments).toHaveLength(3)
    expect(s.staticBytes).toBeGreaterThan(250)
    expect(s.bands.length).toBeGreaterThan(0)
    expect(describeSkeleton(s.template, s.holes).html).toBe(RESET_HTML)
  })

  it("lists the hosts the fixed part links to, for staff to check", () => {
    const s = skeleton(
      RESET_HTML.replace("</body>", '<a href="https://twitter.com/acme">x</a></body>'),
    )
    expect(s.staticHosts).toEqual(["twitter.com"])
  })

  it("refuses two placeholders with nothing fixed between them", () => {
    expect(
      parseSubmission({
        html: RESET_HTML.replace("{{name}}", "{{first}}{{last}}"),
        text: null,
      }),
    ).toEqual({
      error: "Two placeholders must be separated by fixed text.",
    })
  })

  it("refuses a frame around whatever the sender likes", () => {
    const r = parseSubmission({ html: "<p>Hello</p>{{body}}<p>Bye</p>", text: null })
    expect("error" in r && r.error).toContain("fixed text")
    const big = parseSubmission({
      html: RESET_HTML,
      text: null,
      holes: { name: 1_000 },
    })
    expect("error" in big && big.error).toContain("add up to more than the fixed text")
  })

  it("refuses a limit for a placeholder that does not exist, and absurd limits", () => {
    expect(
      parseSubmission({ html: RESET_HTML, text: null, holes: { nope: 5 } }),
    ).toEqual({
      error: "No placeholder named {{nope}}.",
    })
    const zero = parseSubmission({ html: RESET_HTML, text: null, holes: { name: 0 } })
    expect("error" in zero).toBe(true)
  })

  it("needs a body", () => {
    expect("error" in parseSubmission({ html: "", text: null })).toBe(true)
  })
})

describe("classify", () => {
  const s = skeleton(RESET_HTML, { name: 40, url: 200 })

  it("credits an exact fit with safe values", async () => {
    const m = await classify(
      fill(s, ["Ada", "https://app.acme.com/reset?t=abc123"]),
      [entry(s)],
      ctx(),
    )
    expect(m?.entry.id).toBe("t1")
    expect(m?.values).toEqual(["Ada", "https://app.acme.com/reset?t=abc123"])
    expect(trustMark(m!.entry)).toBe("template:t1")
  })

  it("gives nothing for a message that changed one fixed word", async () => {
    const body = fill(s, ["Ada", "https://app.acme.com/r"])
    body.html = body.html!.replace("within the next hour", "within the next day")
    expect(await classify(body, [entry(s)], ctx())).toBeNull()
  })

  it("gives nothing when a value is longer than its hole allows", async () => {
    expect(
      await classify(fill(s, ["A".repeat(41), "https://acme.com/"]), [entry(s)], ctx()),
    ).toBeNull()
  })

  it("gives nothing when a value carries markup: a hole cannot open a new paragraph", async () => {
    expect(
      await classify(
        fill(s, ["Ada</p><p>Win a prize", "https://acme.com/"]),
        [entry(s)],
        ctx(),
      ),
    ).toBeNull()
  })

  it("gives nothing when a link in a hole leaves the workspace's verified domains", async () => {
    expect(
      await classify(fill(s, ["Ada", "https://evil.example/login"]), [entry(s)], ctx()),
    ).toBeNull()
    // A hostname in plain text counts too: mail clients turn it into a link.
    expect(
      await classify(
        fill(s, ["visit evil.top", "https://acme.com/"]),
        [entry(s)],
        ctx(),
      ),
    ).toBeNull()
  })

  it("gives nothing when the link's verdict is unknown or unsafe", async () => {
    const body = fill(s, ["Ada", "https://app.acme.com/reset"])
    expect(
      await classify(body, [entry(s)], ctx({ verdict: async () => "unknown" })),
    ).toBeNull()
    expect(
      await classify(body, [entry(s)], ctx({ verdict: async () => "unsafe" })),
    ).toBeNull()
  })

  it("refuses a link target that is not a web address", async () => {
    expect(
      await classify(fill(s, ["Ada", "javascript:alert(1)"]), [entry(s)], ctx()),
    ).toBeNull()
  })

  it("prefers the workspace's own template over boilerplate", async () => {
    const m = await classify(
      fill(s, ["Ada", "https://acme.com/x"]),
      [entry(s, "boilerplate", "b1"), entry(s, "template", "t1")],
      ctx(),
    )
    expect(m?.entry.kind).toBe("template")
  })

  it("ignores an email address in a value: that is not a link", async () => {
    expect(
      await classify(
        fill(s, ["ada@gmail.com", "https://acme.com/x"]),
        [entry(s)],
        ctx(),
      ),
    ).not.toBeNull()
  })
})

describe("valueHosts", () => {
  it("reads the host after a scheme in the fixed part", () => {
    expect(valueHosts('<a href="https://', "evil.example/x")).toEqual(["evil.example"])
  })
  it("reads URLs and bare hostnames anywhere in a value", () => {
    expect(valueHosts("<p>", "see https://a.acme.com/x and b.acme.com")).toEqual([
      "a.acme.com",
      "b.acme.com",
    ])
  })
  it("does not mistake file names or initials for hosts", () => {
    expect(valueHosts("<p>", "invoice.pdf from J.R. Smith")).toEqual([])
  })
})
