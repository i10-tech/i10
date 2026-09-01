/**
 * Copies Scalar's browser bundle into public/ so the API reference is served
 * from docs.i10.tech and nothing else.
 *
 * @scalar/astro defaults its `cdn` option to jsdelivr. That would mean every
 * reader of our API documentation makes a request to a third party, and that a
 * CDN outage — or a compromised package on it — takes out or rewrites the page
 * describing how to authenticate to our API. Vendoring the bundle removes the
 * dependency entirely.
 *
 * Source maps are skipped: 28 MB of them against 7.4 MB of actual code, for a
 * dependency nobody is going to debug from our origin.
 *
 * The output is generated, gitignored, and rebuilt on every docs build, so it
 * tracks whatever version the lockfile pins.
 */
import { cp, mkdir, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// Resolve through the package's own entry point rather than guessing a path
// into node_modules — pnpm's layout is not something to hard-code.
const entry = require.resolve("@scalar/api-reference")
const source = join(dirname(entry), "browser")
const destination = join(here, "..", "public", "scalar")

await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
await cp(source, destination, {
  recursive: true,
  filter: (path) => !path.endsWith(".map"),
})

console.log(`vendored Scalar from ${source} -> ${destination}`)
