import { readdirSync, readFileSync } from "node:fs"

const folder = new URL("../drizzle/", import.meta.url)

/**
 * The SQL of one migration, found by its name.
 *
 * Migration folders are `<UTC timestamp>_<name>`, so a test cannot spell the
 * path out the way it could when files were numbered `0028_<name>.sql`. The
 * name is what stays put; two folders with one name is an error, not a pick.
 */
export function migrationSql(name: string): string {
  const matches = readdirSync(folder).filter(
    (dir) => dir.replace(/^\d{14}_/, "") === name,
  )
  if (matches.length !== 1) {
    throw new Error(`expected one migration named ${name}, found ${matches.length}`)
  }
  return readFileSync(new URL(`${matches[0]}/migration.sql`, folder), "utf8")
}
