import { describe, expect, it } from "bun:test"
import {
  fill,
  flattenPreview,
  marker,
  placeholders,
  skeletonFromHtml,
  withPreviewText,
} from "../src/index.js"

const nonce = "abcdefghijkl"

describe("fill", () => {
  const version = {
    html: `<p>${marker(nonce, 0)}</p>`,
    text: `${marker(nonce, 0)}`,
    subject: "Hi {{ name }} from {{team.name}}",
    nonce,
    variables: [{ path: "name", preview: "" }],
  }

  it("names every missing variable, including the subject's", () => {
    const result = fill(version, {})
    expect(result).toEqual({ ok: false, missing: ["name", "team.name"], invalid: [] })
  })

  it("fills a missing variable with its fallback, in the body and the subject", () => {
    const result = fill(
      {
        ...version,
        variables: [
          { path: "name", preview: "", fallback: "there" },
          { path: "team.name", preview: "", fallback: "Acme" },
        ],
      },
      {},
    )
    expect(result.ok && result.filled).toEqual({
      html: "<p>there</p>",
      text: "there",
      subject: "Hi there from Acme",
    })
  })

  it("prefers the caller's value to the fallback, and escapes the fallback", () => {
    const withFallback = {
      ...version,
      variables: [{ path: "name", preview: "", fallback: "<b>x</b>" }],
    }
    const given = fill(withFallback, { name: "Ada", team: { name: "t" } })
    expect(given.ok && given.filled.html).toBe("<p>Ada</p>")
    const fallen = fill(withFallback, { team: { name: "t" } })
    expect(fallen.ok && fallen.filled.html).toBe("<p>&lt;b&gt;x&lt;/b&gt;</p>")
  })

  it("never uses a fallback for a value of the wrong type", () => {
    const result = fill(
      { ...version, variables: [{ path: "name", preview: "", fallback: "there" }] },
      { name: { first: "a" }, team: { name: "t" } },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.invalid).toEqual(["name"])
  })

  it("refuses an object where a value belongs", () => {
    const result = fill(version, { name: { first: "a" }, team: { name: "x" } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.invalid).toEqual(["name"])
  })

  it("stringifies numbers and booleans", () => {
    const result = fill(version, { name: 42, team: { name: true } })
    expect(result.ok && result.filled.subject).toBe("Hi 42 from true")
  })

  // ⚠ HEADER INJECTION (#189): a line break in a subject is a new header.
  it("folds line breaks out of a subject value", () => {
    const result = fill(version, { name: "a\r\nBcc: x@evil.test", team: { name: "t" } })
    expect(result.ok && result.filled.subject).toBe("Hi a Bcc: x@evil.test from t")
  })

  it("leaves text a template did not mark alone", () => {
    const result = fill(
      { ...version, html: "<p>⟦i10zzzzzzzzzzzz_0⟧ {{name}}</p>", subject: null },
      { name: "x" },
    )
    expect(result.ok && result.filled.html).toBe("<p>⟦i10zzzzzzzzzzzz_0⟧ {{name}}</p>")
  })
})

describe("HTML templates", () => {
  it("turn placeholders into the same markers a render produces", () => {
    const result = skeletonFromHtml({
      html: '<a href="{{ url }}">{{name}}</a>',
      text: "{{name}}: {{url}}",
      nonce,
    })
    if (!result.ok) throw new Error(result.problems.join())
    const filled = fill(
      { ...result.skeleton, subject: null },
      { name: "<b>", url: "javascript:x" },
    )
    expect(filled.ok && filled.filled.html).toBe('<a href="#">&lt;b&gt;</a>')
    expect(filled.ok && filled.filled.text).toBe("<b>: javascript:x")
  })

  it("refuse a placeholder in a script", () => {
    const result = skeletonFromHtml({
      html: "<script>var a='{{x}}'</script>",
      text: null,
      nonce,
    })
    expect(result.ok).toBe(false)
  })
})

describe("PreviewProps", () => {
  it("flattens nested values to paths", () => {
    const result = flattenPreview({ a: "1", b: { c: 2, d: false } })
    expect(result.ok && result.variables).toEqual([
      { path: "a", preview: "1" },
      { path: "b.c", preview: "2" },
      { path: "b.d", preview: "false" },
    ])
  })

  it("refuses names that could not be written in a subject", () => {
    expect(flattenPreview({ "a-b": "1" }).ok).toBe(false)
  })

  it("finds subject placeholders once each", () => {
    expect(placeholders("{{a}} {{ a }} {{b.c}}")).toEqual(["a", "b.c"])
  })
})

describe("withPreviewText", () => {
  it("puts the preview first in the body, escaped, keeping placeholders", () => {
    const out = withPreviewText(
      "<html><body class=x><p>Hi</p></body></html>",
      "Hey <{{ name }}>",
    )
    expect(out.startsWith("<html><body class=x><div data-i10-preview")).toBe(true)
    expect(out).toContain("Hey &lt;{{ name }}&gt;")
    expect(out.endsWith("</div><p>Hi</p></body></html>")).toBe(true)
  })

  it("replaces its own block rather than adding a second", () => {
    const once = withPreviewText("<body><p>Hi</p></body>", "One")
    const twice = withPreviewText(once, "Two")
    expect(twice.match(/data-i10-preview/g)?.length).toBe(1)
    expect(twice).toContain("Two")
    expect(withPreviewText(twice, null)).toBe("<body><p>Hi</p></body>")
  })
})
