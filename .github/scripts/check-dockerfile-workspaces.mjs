/**
 * Asserts every Dockerfile copies the workspace manifests its image needs.
 *
 * ⚠ THIS EXISTS BECAUSE ADDING A WORKSPACE PACKAGE BREAKS THE IMAGE BUILD AND
 * NOTHING ELSE NOTICES. Each Dockerfile copies an explicit list of
 * `package.json` files before `bun install --frozen-lockfile`, so that a change
 * to source code does not invalidate the dependency layer. The list is
 * hand-maintained. Add a package, have an app depend on it, forget the COPY
 * line, and `lint`, `check-types`, `test` and `bun run build` all still pass —
 * they run against the real repository, where the package is on disk. The image
 * build fails, and only on a push to `main`, which is after the merge.
 *
 * That is exactly how `@repo/dns-providers` took down three images:
 *
 *     error: workspace "@i10/api" depends on workspace "@repo/dns-providers"
 *     (packages/dns-providers), which is listed in bun.lock but not on disk
 *
 * ⚠ IT IS STATIC, NOT AN INSTALL. Reproducing the layer properly means staging
 * the copied files and running `bun install --frozen-lockfile` in a temporary
 * directory — accurate, and seconds per Dockerfile. The failure is entirely a
 * question of which manifests are present versus which workspace dependencies
 * they name, and that is answerable by reading the files. This runs in
 * milliseconds, which is what makes it acceptable in a pre-push hook.
 *
 * ⚠ AND IT CHECKS THE CLOSURE, NOT JUST THE DIRECT DEPENDENCIES. A copied
 * manifest's workspace dependency must itself be copied, and so must ITS
 * workspace dependencies — `bun install` resolves the whole graph. Checking one
 * level deep would pass a Dockerfile that is still broken two levels down.
 */

import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

const DOCKERFILES = [
  "apps/api/Dockerfile",
  "apps/auth/Dockerfile",
  "apps/console/Dockerfile",
  "apps/docs/Dockerfile",
  "apps/web/Dockerfile",
]

/** Every `package.json` a Dockerfile copies BEFORE it installs. */
function copiedManifests(dockerfile) {
  const text = readFileSync(join(REPO, dockerfile), "utf8")

  // ⚠ ONLY THE LINES ABOVE THE INSTALL COUNT. `COPY . .` further down brings in
  // the whole tree, but by then `bun install --frozen-lockfile` has already run
  // and failed. The cut is what makes this check match the real failure.
  const cut = text.indexOf("bun install --frozen-lockfile")
  if (cut === -1) {
    throw new Error(
      `${dockerfile} has no \`bun install --frozen-lockfile\`; this check needs updating.`,
    )
  }

  const manifests = new Set()
  for (const line of text.slice(0, cut).split("\n")) {
    const match = /^COPY\s+(?!--from)(.+)$/.exec(line.trim())
    if (!match) continue
    for (const token of match[1].split(/\s+/).slice(0, -1)) {
      if (token.endsWith("package.json")) manifests.add(token)
    }
  }
  return manifests
}

/** `packages/ui/package.json` → `@repo/ui`, and the reverse. */
function workspaceIndex() {
  const byName = new Map()
  const lock = readFileSync(join(REPO, "bun.lock"), "utf8")
  for (const [, path] of lock.matchAll(/"((?:apps|packages)\/[^/"]+)":\s*\{/g)) {
    const manifest = `${path}/package.json`
    if (!existsSync(join(REPO, manifest))) continue
    const pkg = JSON.parse(readFileSync(join(REPO, manifest), "utf8"))
    byName.set(pkg.name, { manifest, pkg })
  }
  return byName
}

const workspaces = workspaceIndex()

/** The workspace packages a manifest needs, transitively. */
function requiredWorkspaces(manifest, seen = new Set()) {
  const pkg = JSON.parse(readFileSync(join(REPO, manifest), "utf8"))
  const deps = {
    ...(pkg.dependencies ?? {}),
    // ⚠ DEV DEPENDENCIES COUNT. The build stage runs `bun run build`, which
    // needs `@repo/typescript-config` and `@repo/eslint-config` — and
    // `--frozen-lockfile` refuses to install at all if any of them is absent,
    // whichever section named it.
    ...(pkg.devDependencies ?? {}),
  }

  for (const [name, range] of Object.entries(deps)) {
    if (!String(range).startsWith("workspace:")) continue
    const entry = workspaces.get(name)
    if (!entry || seen.has(entry.manifest)) continue
    seen.add(entry.manifest)
    requiredWorkspaces(entry.manifest, seen)
  }
  return seen
}

let failed = false

for (const dockerfile of DOCKERFILES) {
  const copied = copiedManifests(dockerfile)
  const missing = new Map()

  for (const manifest of copied) {
    if (manifest === "package.json") continue // the workspace root
    for (const required of requiredWorkspaces(manifest)) {
      if (!copied.has(required)) {
        missing.set(required, manifest)
      }
    }
  }

  if (missing.size === 0) {
    console.log(`  ok  ${dockerfile}`)
    continue
  }

  failed = true
  console.error(`\n  FAIL  ${dockerfile}`)
  for (const [required, because] of missing) {
    console.error(`        missing: COPY ${required} ${dirname(required)}/`)
    console.error(`        needed by ${because}`)
  }
}

if (failed) {
  console.error(
    "\nA workspace package is depended on but not copied into the image before" +
      "\n`bun install --frozen-lockfile`, so the build will fail with:" +
      '\n\n  error: workspace "…" depends on workspace "…", which is listed in' +
      "\n  bun.lock but not on disk\n",
  )
  process.exit(1)
}

console.log(`\n${DOCKERFILES.length} Dockerfiles carry every workspace they need.`)
