import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const api = join(import.meta.dir, "..")

/** The entry points `bun build` bundles, read from the build script itself. */
const entries = (): string[] => {
  const pkg = JSON.parse(readFileSync(join(api, "package.json"), "utf8")) as {
    scripts: { build: string }
  }
  return pkg.scripts.build.split(/\s+/).filter((part) => /^src\/.+\.ts$/.test(part))
}

/** The first import statement in a file, comments and blank lines skipped. */
const firstImport = (source: string): string | undefined =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("import "))

describe("every bundled entry point", () => {
  it("finds the entries in the build script", () => {
    expect(entries()).toContain("src/index.ts")
  })

  for (const entry of entries()) {
    it(`${entry} imports openapi-first before anything else`, () => {
      const source = readFileSync(join(api, entry), "utf8")
      expect(firstImport(source)).toBe('import "./openapi-first.js"')
    })
  }
})
