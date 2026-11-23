/**
 * Runs every `test/*-db.test.ts` against one migrated database, and fails if any
 * test in them skipped.
 *
 *   DB_TESTS_DATABASE_URL=postgres://i10:i10@127.0.0.1:5432/i10 bun run test:db
 *
 * The url is the OWNER's (`i10`) on a database with every migration applied, as
 * `bun run check-migrations` leaves it. The tests log in as `i10_api` themselves.
 *
 * ⚠ EACH FILE SKIPS ITSELF WHEN ITS VARIABLE IS UNSET, AND THE FILES USE NINE
 * DIFFERENT NAMES. That is why eleven of these tests failed on main for weeks
 * (#514): nothing ever set the variables, so every file reported a skip and the
 * run was green. So the variables are read out of the test files rather than
 * listed here, and a skipped test fails the run: a new file with a new name is
 * covered without anyone remembering this script, and one this misses is a red
 * run, not a silent one.
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ⚠ NO DEFAULT AND NO SKIP, like check-migrations: a check that quietly passes
// when it is not configured has stopped running without anyone noticing.
const url = process.env.DB_TESTS_DATABASE_URL
if (!url) {
  console.error(
    "DB_TESTS_DATABASE_URL is required: the owner's url to a throwaway, fully migrated `i10`",
  )
  process.exit(1)
}

const api = join(import.meta.dir, "..")
const files = (await readdir(join(api, "test")))
  .filter((name) => name.endsWith("-db.test.ts"))
  .sort()
  .map((name) => `test/${name}`)

/** `*_TEST_DATABASE_URL`, not `*_TEST_API_DATABASE_URL`: the tests derive the `i10_api` url from the owner's. */
const VARIABLE = /process\.env\.([A-Z0-9_]+_TEST_DATABASE_URL)\b/g
const variables = new Set<string>()
for (const file of files) {
  for (const [, name] of (await readFile(join(api, file), "utf8")).matchAll(VARIABLE))
    variables.add(name!)
}

/** One file's totals from bun's junit report. */
interface FileResult {
  tests: number
  skipped: number
}

/** The per-file `<testsuite>` elements: the ones whose name is their file. */
function perFile(junit: string): Map<string, FileResult> {
  const results = new Map<string, FileResult>()
  for (const [tag] of junit.matchAll(/<testsuite\s[^>]*>/g)) {
    const attr = (key: string) => new RegExp(`\\s${key}="([^"]*)"`).exec(tag)?.[1]
    const file = attr("file")
    if (!file || attr("name") !== file) continue
    results.set(file, {
      tests: Number(attr("tests")),
      skipped: Number(attr("skipped")),
    })
  }
  return results
}

const work = await mkdtemp(join(tmpdir(), "i10-db-tests-"))
try {
  const report = join(work, "junit.xml")
  console.log(
    `${files.length} files, with ${[...variables].sort().join(", ")} set to the same database`,
  )
  // The running Bun binary, so nothing has to be looked up on a PATH. `./` makes
  // each argument a path rather than a name filter.
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      ...files.map((file) => `./${file}`),
      "--reporter=junit",
      `--reporter-outfile=${report}`,
    ],
    {
      cwd: api,
      env: {
        ...process.env,
        ...Object.fromEntries([...variables].map((name) => [name, url])),
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  const code = await child.exited

  const results = perFile(await readFile(report, "utf8"))
  const problems: string[] = []
  for (const file of files) {
    const result = results.get(file)
    if (!result) problems.push(`${file}: not in the report`)
    else if (result.tests === 0) problems.push(`${file}: ran no tests`)
    else if (result.skipped > 0)
      problems.push(`${file}: ${result.skipped} of ${result.tests} skipped`)
  }
  if (problems.length > 0) {
    console.error(
      "A database test skipped. Every -db file must run here; a file that reads a new variable name needs it to match /_TEST_DATABASE_URL$/:",
    )
    for (const problem of problems) console.error(`  ${problem}`)
  }
  process.exitCode = code !== 0 || problems.length > 0 ? 1 : 0
} finally {
  await rm(work, { recursive: true, force: true })
}
