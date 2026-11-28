import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"

/**
 * env.ts runs in check-env and at every boot before anything connects. Its
 * import graph must not reach ioredis or the database client (it once did,
 * through enroll-redis.ts for one URL constant).
 */
function importGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>()
  const packages = new Set<string>()
  const visit = (file: string) => {
    if (files.has(file)) return
    files.add(file)
    const src = readFileSync(file, "utf8")
    // Value imports only: `import type` is erased at build time.
    for (const m of src.matchAll(
      /^\s*(?:import|export)\s(?!type\s)[^"']*?from\s+["']([^"']+)["']/gm,
    )) {
      const spec = m[1]!
      if (!spec.startsWith(".")) {
        packages.add(spec)
        continue
      }
      const ts = resolve(dirname(file), spec.replace(/\.js$/, ".ts"))
      if (existsSync(ts)) visit(ts)
    }
  }
  visit(entry)
  return { files, packages }
}

describe("env.ts imports", () => {
  it("reach neither ioredis nor the database client", () => {
    const src = resolve(import.meta.dir, "../src")
    const { files, packages } = importGraph(resolve(src, "env.ts"))
    const reached = [...files].map((f) => relative(src, f))
    expect(reached).not.toContain("mail-devices/enroll-redis.ts")
    expect(reached).not.toContain("db/client.ts")
    expect([...packages]).not.toContain("ioredis")
    expect(reached).toContain("mail-devices/enroll-constants.ts")
  })
})
