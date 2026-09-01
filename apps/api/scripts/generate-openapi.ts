/**
 * Writes the OpenAPI document to disk.
 *
 * The document is a COMMITTED ARTIFACT, not something generated at deploy time,
 * for two reasons:
 *
 *   The docs site is a static Astro build on a different host. Inlining a file
 *   from the repo means docs.i10.tech/api needs no CORS header, no runtime call
 *   to the API, and still renders if the API is down.
 *
 *   SDK generation reads it in CI. Pointing a generator at a live endpoint makes
 *   builds depend on a running service; pointing it at a file in the tree does
 *   not.
 *
 * Committing it also makes contract changes visible in review — a diff on this
 * file is a diff on the public API, which is exactly the thing that should never
 * change by accident.
 *
 * CI regenerates and fails if the result differs, so the artifact cannot drift
 * from the Zod schemas it came from.
 */
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createApp } from "../src/app.js"

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "openapi.json")

const res = await createApp().request("/openapi.json")
if (!res.ok) {
  throw new Error(`Could not render the document: HTTP ${res.status}`)
}

// Pretty-printed with a trailing newline so the committed file diffs like
// source rather than as one enormous line.
const spec: unknown = await res.json()
writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`)

console.log(`wrote ${out}`)
