/**
 * Starts every built entry point and proves its whole module graph loads.
 *
 * ⚠ THE UNIT TESTS RUN THE SOURCE, NOT THE BUNDLE. On 2026-11-16 every API pod
 * after #471 crash-looped for 11 hours on `errorSchema.openapi is not a function`
 * while CI was green: `bun build --splitting` evaluated the contracts before the
 * zod extension (see src/openapi-first.ts). Only running the bundle shows that.
 *
 * Each entry runs with an empty environment, so a healthy one gets through every
 * import and then refuses to start on its environment check. That refusal is the
 * PASS signal: anything else (a TypeError at load, a missing module, a hang) fails.
 *
 * Run after `bun run build`: `bun scripts/boot-bundles.ts`.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const api = join(import.meta.dir, "..")
const pkg = JSON.parse(readFileSync(join(api, "package.json"), "utf8")) as {
  scripts: { build: string }
}
const entries = pkg.scripts.build
  .split(/\s+/)
  .filter((part) => /^src\/.+\.ts$/.test(part))
  .map((part) => part.replace(/^src\//, "dist/").replace(/\.ts$/, ".js"))

/** What a healthy entry says when it has no environment. */
const REFUSED_ON_ENV = /Invalid environment|is required/
const TIMEOUT_MS = 20_000

let failed = 0
for (const entry of entries) {
  // The running Bun binary, so nothing has to be looked up on a PATH.
  const child = Bun.spawn([process.execPath, entry], {
    cwd: api,
    env: {},
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  await child.exited
  clearTimeout(timer)

  const output = `${out}\n${err}`
  if (REFUSED_ON_ENV.test(output)) {
    console.log(`ok    ${entry}`)
    continue
  }
  failed++
  console.error(`FAIL  ${entry} did not reach its environment check:`)
  console.error(output.trim().split("\n").slice(-15).join("\n"))
}

if (failed > 0) {
  console.error(`\n${failed} of ${entries.length} bundled entries failed to load.`)
  process.exit(1)
}
console.log(`\nall ${entries.length} bundled entries load.`)
