import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"

const appDir = path.resolve(__dirname, "../app")

/**
 * Explicit allowlist of routes that do not need their own loading.tsx.
 * Each entry has an exact one-line rationale.
 */
const ALLOWLIST: { pattern: RegExp; reason: string }[] = [
  // app/billing: simple redirect to external/active billing portal
  { pattern: /^billing$/, reason: "redirect" },
  // app/invite/ended: static message page with no dynamic data
  { pattern: /^invite\/ended$/, reason: "static" },
  // app/dns/callback/[provider]: client flow in place handling DNS callback
  { pattern: /^dns\/callback\/\[provider\]$/, reason: "client flow in place" },
  // app/(app)/reference/clerk/**: vendor reference components that render themselves
  { pattern: /^\(app\)\/reference\/clerk(\/.*)?$/, reason: "vendor reference" },
  // app/probe/clerk: a dev-only probe of Clerk's raw answers, not a product page
  { pattern: /^probe\/clerk$/, reason: "dev probe" },
]

function isAllowlisted(routeDir: string): boolean {
  return ALLOWLIST.some(({ pattern }) => pattern.test(routeDir))
}

export function findMissingLoading(): string[] {
  const missing: string[] = []

  function walk(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    const hasPage = entries.some((e) => e.isFile() && e.name === "page.tsx")
    const hasLoading = entries.some((e) => e.isFile() && e.name === "loading.tsx")

    if (hasPage) {
      const relDir = path.relative(appDir, currentDir)
      if (!isAllowlisted(relDir) && !hasLoading) {
        missing.push(relDir || ".")
      }
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(currentDir, entry.name))
      }
    }
  }

  walk(appDir)
  return missing.sort()
}

/** Every loading.tsx with a page.tsx anywhere beneath its own directory. */
export function findNestedLoading(): string[] {
  const nested: string[] = []

  function pagesBelow(dir: string): boolean {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .some(
        (e) =>
          e.isDirectory() &&
          (fs.existsSync(path.join(dir, e.name, "page.tsx")) ||
            pagesBelow(path.join(dir, e.name))),
      )
  }

  function walk(currentDir: string) {
    if (fs.existsSync(path.join(currentDir, "loading.tsx")) && pagesBelow(currentDir)) {
      nested.push(path.relative(appDir, currentDir) || ".")
    }
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(currentDir, entry.name))
    }
  }

  walk(appDir)
  return nested.sort()
}

describe("skeleton coverage", () => {
  // ⚠ EVERY PAGE DRAWS ITS OWN SKELETON (docs/decisions/skeletons.md). A page
  // without a loading.tsx of its own inherits its parent's, which is a
  // different page's shape - the drift this whole system exists to remove.
  test("every page has its own loading.tsx", () => {
    expect(findMissingLoading()).toEqual([])
  })

  // ⚠ AND NO loading.tsx MAY SIT ABOVE ANOTHER PAGE (2026-11-05). Next renders
  // the highest boundary below the shared layout first and the page's own one
  // after it, so a click showed two skeletons in a row: the catch-all
  // (app)/loading.tsx, then the page's. A list with record pages beneath it
  // keeps its page and loading.tsx in an `(index)` route group for this reason.
  test("no loading.tsx wraps another page", () => {
    expect(findNestedLoading()).toEqual([])
  })

  // ⚠ EVERY PAGE IN THE SHELL IS IN THE CLICK-TIME REGISTRY (2026-11-05). A
  // page missing from components/instant-skeleton.tsx shows no skeleton on a
  // click in dev, or on any click Next has not prefetched: the old page just
  // sits there until the new one is finished.
  test("every shell page's skeleton is drawn at the click", () => {
    const shellDir = path.join(appDir, "(app)")
    const routes: string[] = []
    function walk(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      const names = new Set(entries.map((e) => e.name))
      if (names.has("page.tsx") && names.has("loading.tsx")) {
        const segments = path
          .relative(shellDir, dir)
          .split(path.sep)
          .filter((s) => s && !/^\(.*\)$/.test(s))
        routes.push(`/${segments.join("/")}`)
      }
      for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name))
    }
    walk(shellDir)
    const registry = fs.readFileSync(
      path.resolve(__dirname, "../components/instant-skeleton.tsx"),
      "utf8",
    )
    const registered = [...registry.matchAll(/route: "([^"]+)"/g)].map((m) => m[1])
    expect(registered.sort()).toEqual(routes.sort())
  })

  // ⚠ A VIEW WITH NO DATA YET DEFAULTS TO `NONE`, NEVER A FRESH `[]` (lib/react).
  // Contacts and Suppressions crashed with "Too many re-renders" on every click
  // into them: the skeleton has no data, `?? []` made a new array per render,
  // and `useResetWhen` read each one as a change.
  test("no view defaults missing data to a fresh []", () => {
    const componentsDir = path.resolve(__dirname, "../components")
    const offenders = fs
      .readdirSync(componentsDir, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".tsx"))
      .flatMap((file) =>
        fs
          .readFileSync(path.join(componentsDir, file), "utf8")
          .split("\n")
          .flatMap((line, i) =>
            /\bdata\?\.[\w?.]+ \?\? \[\]/.test(line) ? [`${file}:${i + 1}`] : [],
          ),
      )
    expect(offenders).toEqual([])
  })
})
