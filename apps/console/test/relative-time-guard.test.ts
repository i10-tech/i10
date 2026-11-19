import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"

const root = path.resolve(__dirname, "..")

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

/*
 * ⚠ RELATIVE TIME GOES THROUGH <Time>, NEVER `formatRelative` IN MARKUP
 * (2026-11-17). `formatRelative` reads the clock, so the server and the
 * browser can land either side of a minute ("2 minutes ago" against "3"), and
 * React throws the server HTML away. The overview's recent sends did exactly
 * that. <Time> lets the boundary through and corrects it on mount.
 */
/*
 * ⚠ AND EXACT TIME GOES THROUGH <Time mode="exact"> OR `useExactTime`
 * (2026-11-18). `formatExact` formats in the runtime's time zone: the server is
 * UTC in production, so every exact time in server-rendered markup mismatched
 * by hours for anyone not in UTC.
 */
const outsideTime = (call: string) =>
  ["components", "app"]
    .flatMap((dir) => sources(path.join(root, dir)))
    .filter((file) => !file.endsWith(path.join("components", "time.tsx")))
    .filter((file) => fs.readFileSync(file, "utf8").includes(`${call}(`))
    .map((file) => path.relative(root, file))

describe("times in markup", () => {
  test("only components/time.tsx calls formatRelative", () => {
    expect(outsideTime("formatRelative")).toEqual([])
  })

  test("only components/time.tsx calls formatExact", () => {
    expect(outsideTime("formatExact")).toEqual([])
  })
})
