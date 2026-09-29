import { describe, expect, it } from "bun:test"
import {
  canonicalFileSet,
  closureOf,
  discoverTemplates,
  displaySkeleton,
  importsOf,
  marker,
  normalizePath,
  readFileSet,
  resolveImport,
} from "../src/index.js"

const template = (body = "") =>
  `import { Html } from "react-email"
${body}
export default function T() { return <Html /> }
T.PreviewProps = {}
`

describe("paths", () => {
  it("normalizes, and refuses a path that leaves the root", () => {
    expect(normalizePath("./emails//auth/../welcome.tsx")).toBe("emails/welcome.tsx")
    expect(normalizePath("a\\b.tsx")).toBe("a/b.tsx")
    expect(normalizePath("../secret.tsx")).toBeNull()
    expect(normalizePath("a/../../b.tsx")).toBeNull()
    expect(normalizePath("")).toBeNull()
  })
})

describe("importsOf", () => {
  it("finds every static form, and nothing in comments", () => {
    const source = `
      import React from "react"
      import type { Props } from './types'
      import {
        Button,
        Text,
      } from "react-email"
      import "./side-effect"
      export * from "./re-export"
      export { a as b } from '../shared/a'
      const lazy = import("./lazy")
      const old = require("./old")
      // import Ghost from "./ghost"
      /* export * from "./gone" */
      const url = "https://example.com//not-a-comment"
    `
    expect(importsOf(source)).toEqual([
      "react",
      "./types",
      "react-email",
      "./side-effect",
      "./re-export",
      "../shared/a",
      "./lazy",
      "./old",
    ])
  })
})

describe("resolveImport", () => {
  const files = {
    "emails/welcome.tsx": "",
    "emails/components/layout.tsx": "",
    "emails/components/index.ts": "",
    "emails/util.ts": "",
  }
  it("tries extensions, then index, and maps .js to .ts as NodeNext writes it", () => {
    expect(resolveImport("emails/welcome.tsx", "./components/layout", files)).toBe(
      "emails/components/layout.tsx",
    )
    expect(resolveImport("emails/welcome.tsx", "./components", files)).toBe(
      "emails/components/index.ts",
    )
    expect(resolveImport("emails/components/layout.tsx", "../util.js", files)).toBe(
      "emails/util.ts",
    )
    expect(resolveImport("emails/welcome.tsx", "../../outside", files)).toBeNull()
    expect(resolveImport("emails/welcome.tsx", "./missing", files)).toBeNull()
  })
})

describe("closureOf", () => {
  it("collects relative imports transitively, and links each specifier", () => {
    const files = {
      "welcome.tsx": template('import { Layout } from "./components/layout"'),
      "components/layout.tsx":
        'import { Footer } from "./footer"\nexport const Layout = 1',
      "components/footer.tsx":
        'import { Layout } from "./layout"\nexport const Footer = 2',
      "unrelated.tsx": "export const X = 3",
    }
    const closure = closureOf("welcome.tsx", files)
    expect(closure.problems).toEqual([])
    expect(closure.paths).toEqual([
      "welcome.tsx",
      "components/footer.tsx",
      "components/layout.tsx",
    ])
    expect(closure.links["welcome.tsx"]).toEqual({
      "./components/layout": "components/layout.tsx",
    })
    expect(closure.links["components/footer.tsx"]).toEqual({
      "./layout": "components/layout.tsx",
    })
  })

  it("names an import that is not in the files", () => {
    const closure = closureOf("a.tsx", { "a.tsx": 'import x from "./nope"' })
    expect(closure.problems).toEqual([
      "`./nope`, imported by `a.tsx`, is not in the files.",
    ])
  })
})

describe("discoverTemplates", () => {
  it("finds React Email's convention and skips components and private folders", () => {
    const found = discoverTemplates({
      "welcome.tsx": template(),
      "auth/reset.tsx": template(),
      "components/layout.tsx": "export default function Layout() { return null }",
      "_drafts/wip.tsx": template(),
      "node_modules/x/y.tsx": template(),
      "helpers.ts": template(),
    })
    expect(found.problems).toEqual([])
    expect(found.templates).toEqual([
      { path: "auth/reset.tsx", name: "reset", folder: "auth" },
      { path: "welcome.tsx", name: "welcome", folder: null },
    ])
  })

  it("refuses two templates that would share a name", () => {
    const found = discoverTemplates({
      "auth/welcome.tsx": template(),
      "marketing/welcome.tsx": template(),
      "reset.tsx": template(),
    })
    expect(found.templates.map((t) => t.name)).toEqual(["reset"])
    expect(found.problems[0]).toContain("would both be named `welcome`")
  })

  it("uses i10.json when there is one, and says what it lists that is missing", () => {
    const found = discoverTemplates({
      "i10.json": JSON.stringify({ templates: ["./a.tsx", "b.tsx"] }),
      "a.tsx": "export default () => null",
      "c.tsx": template(),
    })
    expect(found.templates).toEqual([{ path: "a.tsx", name: "a", folder: null }])
    expect(found.problems).toEqual([
      "`b.tsx`, listed in i10.json, is not in the files.",
    ])
    expect(discoverTemplates({ "i10.json": "{" }).problems).toEqual([
      "i10.json is not valid JSON.",
    ])
  })
})

describe("readFileSet", () => {
  it("keeps code and the manifest, drops the rest, and refuses escaping paths", () => {
    expect(
      readFileSet({
        "./a.tsx": "x",
        "logo.png": "…",
        "i10.json": "{}",
        "README.md": "",
      }),
    ).toEqual({ ok: true, files: { "a.tsx": "x", "i10.json": "{}" } })
    expect(readFileSet({ "../a.tsx": "x" })).toEqual({
      ok: false,
      problems: ["`../a.tsx` is not a path inside the upload."],
    })
    expect(readFileSet(["a"]).ok).toBe(false)
  })
})

describe("canonicalFileSet", () => {
  it("ignores key order and includes the entry", () => {
    const a = canonicalFileSet("a.tsx", { "a.tsx": "1", "b.tsx": "2" })
    expect(canonicalFileSet("a.tsx", { "b.tsx": "2", "a.tsx": "1" })).toBe(a)
    expect(canonicalFileSet("b.tsx", { "a.tsx": "1", "b.tsx": "2" })).not.toBe(a)
  })
})

describe("displaySkeleton", () => {
  it("shows markers as placeholders, so versions with different nonces compare equal", () => {
    const vars = [
      { path: "name", preview: "Ada" },
      { path: "url", preview: "https://x" },
    ]
    const one = `<a href="${marker("aaaaaaaaaaaa", 1, true)}">${marker("aaaaaaaaaaaa", 0)}</a>`
    const two = `<a href="${marker("bbbbbbbbbbbb", 1, true)}">${marker("bbbbbbbbbbbb", 0)}</a>`
    expect(displaySkeleton(one, "aaaaaaaaaaaa", vars)).toBe(
      '<a href="{{ url }}">{{ name }}</a>',
    )
    expect(displaySkeleton(two, "bbbbbbbbbbbb", vars)).toBe(
      displaySkeleton(one, "aaaaaaaaaaaa", vars),
    )
  })
})
