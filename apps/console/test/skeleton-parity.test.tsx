import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { diffTrees, normalize, renderLoaded, renderLoading } from "./parity/harness"
import { knownReason } from "./parity/known"

const { VIEWS } = await import("./parity/cases")

/**
 * ⚠ A SKELETON MUST BE THE PAGE, MINUS ITS DATA (docs/decisions/skeletons.md).
 * Each view is drawn loaded and loading from the loaded data's own shape, with
 * every Bone collapsed to a placeholder; the two trees must be equal. A
 * mismatch is a skeleton that lies: a divider, a button or a filter that
 * appears only when the data arrives.
 */
describe("skeleton parity", () => {
  for (const view of VIEWS) {
    describe(view.route, () => {
      for (const c of view.cases) {
        const known = knownReason(view.route, c.name)
        test(`${c.name}: the skeleton is the page`, () => {
          const data = c.fixture("a")
          const loaded = renderLoaded(view, data)
          const loading = renderLoading(view, view.shape.of(data as never))
          const diff = diffTrees(
            `${view.route} (${c.name})`,
            normalize(loaded),
            normalize(loading),
          )
          if (known) {
            if (!diff) {
              throw new Error(
                `${view.route} (${c.name}) now matches its page: delete its \`known\` ` +
                  `(was: ${known}).`,
              )
            }
            return
          }
          if (diff)
            throw new Error(
              `${view.route} (${c.name}) skeleton differs from the page:\n${diff}`,
            )
        })

        // ⚠ SAME SHAPE, DIFFERENT DATA, SAME PAGE OUTSIDE ITS BONES. A name in
        // plain text, or a count that decides a branch, would make the
        // skeleton wrong for every dataset but the one it was drawn from.
        test(`${c.name}: data stays inside its bones`, () => {
          if (known) return
          const a = c.fixture("a")
          const b = c.fixture("b")
          expect(view.shape.of(b as never)).toEqual(view.shape.of(a as never))
          const diff = diffTrees(
            `${view.route} (${c.name})`,
            normalize(renderLoaded(view, a)),
            normalize(renderLoaded(view, b)),
          )
          if (diff)
            throw new Error(
              `${view.route} (${c.name}) shows data outside a Bone:\n${diff}`,
            )
        })
      }
    })
  }
})

/** Every route under app/(app) that has a loading.tsx, as `/domains/[id]`. */
function loadingRoutes(): string[] {
  const shellDir = path.resolve(__dirname, "../app/(app)")
  const routes: string[] = []
  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    if (entries.some((e) => e.name === "loading.tsx")) {
      const segments = path
        .relative(shellDir, dir)
        .split(path.sep)
        .filter((s) => s && !/^\(.*\)$/.test(s))
      routes.push(`/${segments.join("/")}`)
    }
    for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name))
  }
  walk(shellDir)
  return routes.sort()
}

describe("skeleton parity coverage", () => {
  // ⚠ A NEW PAGE CANNOT SKIP THE CHECK. Parity is only as good as the cases
  // registered, so a route with a loading.tsx and no case here would ship
  // unchecked - the same drift this suite exists to catch.
  test("every page with a loading.tsx has parity cases", () => {
    const registered = new Set(VIEWS.map((v) => v.route))
    const missing = loadingRoutes().filter((route) => !registered.has(route))
    if (missing.length > 0) {
      throw new Error(
        `No skeleton parity case for: ${missing.join(", ")}. Add a defineView() ` +
          `entry for each in apps/console/test/parity/cases-*.tsx (see test/parity/cases.tsx).`,
      )
    }
  })

  test("every registered route is a real page with cases", () => {
    const real = new Set(loadingRoutes())
    expect(VIEWS.filter((v) => !real.has(v.route)).map((v) => v.route)).toEqual([])
    expect(VIEWS.filter((v) => v.cases.length === 0).map((v) => v.route)).toEqual([])
  })
})
