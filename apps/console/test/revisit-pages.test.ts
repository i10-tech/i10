import fs from "node:fs"
import path from "node:path"
import { describe, expect, mock, test } from "bun:test"
import {
  REVISIT_SECONDS,
  forgetOtherVisits,
  isWarm,
  noteVisit,
  versionOf,
} from "@/lib/revisits"
import { setWorkspaceKey } from "@/lib/workspace-key"

mock.module("server-only", () => ({}))
const { KEPT_PAGES, keptPage } = await import("@/lib/kept-pages")

const appDir = path.resolve(__dirname, "../app")

function pages(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return pages(full)
    return entry.name === "page.tsx" ? [full] : []
  })
}

/** `app/(app)/templates/(index)/page.tsx` is the route `/templates`. */
function routeOf(file: string): string {
  const segments = path
    .relative(appDir, path.dirname(file))
    .split(path.sep)
    .filter((s) => s && !/^\(.*\)$/.test(s))
  return `/${segments.join("/")}`
}

const kept = pages(appDir)
  .filter((file) => fs.readFileSync(file, "utf8").includes('from "@/components/revisit"'))
  .map((file) => ({ file, route: routeOf(file), source: fs.readFileSync(file, "utf8") }))

/**
 * ⚠ A KEPT PAGE NEEDS THREE THINGS THAT LIVE IN THREE FILES (lib/revisits.ts):
 * Next told to keep it, `<Revisit>` noting it, and its loader listed for the
 * check. Without the first a revisit draws its skeleton; without the last the
 * check never sees a change.
 */
describe("kept pages", () => {
  test("templates are kept", () => {
    expect(kept.map((p) => p.route).sort()).toEqual(["/templates", "/templates/folder/[id]"])
  })

  for (const page of kept) {
    test(`${page.route} tells Next to keep it for ${REVISIT_SECONDS}s`, () => {
      expect(page.source).toContain(`export const unstable_dynamicStaleTime = ${REVISIT_SECONDS}\n`)
    })
  }

  test("the check knows every kept page and nothing else", () => {
    expect(KEPT_PAGES.map((p) => p.route).sort()).toEqual(kept.map((p) => p.route).sort())
  })

  test("the check finds a page by its path", () => {
    expect(keptPage("/templates")).not.toBeNull()
    expect(keptPage("/templates/folder/f01de700-0000-4000-8000-000000000002")).not.toBeNull()
    expect(keptPage("/templates/folder")).toBeNull()
    expect(keptPage("/domains")).toBeNull()
  })
})

describe("visits", () => {
  test("a page shown again from Next's cache is a revisit, and only then", () => {
    const first = {}
    expect(noteVisit("/a", "r1", first)).toBe("fresh")
    expect(noteVisit("/a", "r1", first)).toBe("again")
    expect(isWarm("/a")).toBe(true)

    const second = {}
    expect(noteVisit("/a", "r1", second)).toBe("cached")
    expect(noteVisit("/a", "r2", second)).toBe("redrawn")
    expect(noteVisit("/a", "r3", {})).toBe("fresh")
  })

  test("a redraw forgets every other page, since Next emptied its cache", () => {
    noteVisit("/b", "r1", {})
    noteVisit("/c", "r1", {})
    forgetOtherVisits("/c")
    expect(isWarm("/b")).toBe(false)
    expect(isWarm("/c")).toBe(true)
  })

  test("another workspace's page is never warm", () => {
    setWorkspaceKey("org_one")
    const mount = {}
    noteVisit("/d", "r1", mount)
    setWorkspaceKey("org_two")
    expect(isWarm("/d")).toBe(false)
    expect(noteVisit("/d", "r1", {})).toBe("fresh")
    setWorkspaceKey(null)
  })
})

test("a fingerprint changes with the data and only with it", () => {
  expect(versionOf({ rows: [1, 2] })).toBe(versionOf({ rows: [1, 2] }))
  expect(versionOf({ rows: [1, 2] })).not.toBe(versionOf({ rows: [2, 1] }))
  expect(versionOf(null)).not.toBe(versionOf({}))
})
