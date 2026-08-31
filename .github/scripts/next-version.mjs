// Derive the next semantic version from conventional commits.
//
// WHY THIS AND NOT release-please
// -------------------------------
// release-please's versioning LOGIC is what we want; its ceremony is not. It
// maintains a long-lived "Release PR" that bumps a version file — valuable
// when something consumes that file. Nothing here does: the git TAG is the
// version. That removes a version file, a bump commit and an extra PR, which
// is why this slots into workflows we already run instead of adding one.
//
// TWO CALL SITES, ONE CALCULATION
//   release.yml --prerelease  → v0.3.0-rc.1  (a staging candidate)
//   release.yml (no flag)     → v0.3.0       (what shipped)
//
// Both recompute from history rather than passing state between workflows.
// That is deliberate: if more commits land between the PR opening and the
// merge, the promoted version reflects what ACTUALLY shipped. A `feat:`
// arriving late correctly turns a patch bump into a minor one.
//
// PRE-1.0 BUMP RULES
// Semver calls 0.y.z initial development where anything may change, so a
// breaking change must NOT force 1.0.0 — going 1.0 is a product decision, not
// something a commit message triggers.
//   breaking (`!` or BREAKING CHANGE) → minor   0.2.1 → 0.3.0
//   feat                              → minor   0.2.1 → 0.3.0
//   fix / perf / everything else      → patch   0.2.1 → 0.2.2
// Once MAJOR >= 1 these become the standard rules.
//
// ⚠ A NON-CONVENTIONAL SUBJECT IS SKIPPED, NOT REJECTED. This script cannot
// tell "no features this release" from "the feature commit was worded wrong",
// so a whole release can bump patch when it should have bumped minor. That is
// why commitlint runs in CI — the guard lives there, not here.
//
// Usage: node .github/scripts/next-version.mjs [--prerelease rc] [--github-output]

import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"

const args = process.argv.slice(2)
const preIdx = args.indexOf("--prerelease")
const preLabel = preIdx !== -1 ? (args[preIdx + 1] ?? "rc") : null
const toOutput = args.includes("--github-output")

const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim()

// Latest STABLE tag: vX.Y.Z with no prerelease suffix. Prerelease tags are
// excluded so a string of v0.3.0-rc.N candidates never becomes the baseline —
// the baseline is the last thing that actually shipped.
function lastStableTag() {
  let tags = []
  try {
    tags = git("tag", "--list", "v*", "--sort=-v:refname").split("\n").filter(Boolean)
  } catch {
    return null
  }
  return tags.find((t) => /^v\d+\.\d+\.\d+$/.test(t)) ?? null
}

const base = lastStableTag()
const range = base ? `${base}..HEAD` : "HEAD"

// %s = subject, %b = body; the body is where `BREAKING CHANGE:` lives.
// \x1e (record separator) delimits commits so multi-line bodies survive.
let log = ""
try {
  log = git("log", range, "--no-merges", "--format=%s%n%b%x1e")
} catch {
  log = ""
}
const commits = log
  .split("\x1e")
  .map((c) => c.trim())
  .filter(Boolean)

const CONVENTIONAL = /^(\w+)(\([^)]*\))?(!)?:\s/
let hasBreaking = false
let hasFeat = false
let counted = 0

for (const c of commits) {
  const subject = c.split("\n")[0]
  const m = subject.match(CONVENTIONAL)
  if (!m) continue
  counted++
  const [, type, , bang] = m
  if (bang || /^BREAKING[ -]CHANGE:/m.test(c)) hasBreaking = true
  if (type === "feat") hasFeat = true
}

const [major, minor, patch] = (base ?? "v0.0.0")
  .replace(/^v/, "")
  .split(".")
  .map(Number)

let next
if (major === 0) {
  next = hasBreaking || hasFeat ? [0, minor + 1, 0] : [0, minor, patch + 1]
} else {
  next = hasBreaking
    ? [major + 1, 0, 0]
    : hasFeat
      ? [major, minor + 1, 0]
      : [major, minor, patch + 1]
}

let version = `v${next.join(".")}`

// Prerelease: find existing candidates for THIS version and take the next
// counter, so repeated staging builds produce rc.1, rc.2, … rather than
// colliding on one tag.
if (preLabel) {
  let existing = []
  try {
    existing = git("tag", "--list", `${version}-${preLabel}.*`)
      .split("\n")
      .filter(Boolean)
  } catch {
    existing = []
  }
  const highest = existing.reduce((max, t) => {
    const n = Number(t.slice(`${version}-${preLabel}.`.length))
    return Number.isFinite(n) && n > max ? n : max
  }, 0)
  version = `${version}-${preLabel}.${highest + 1}`
}

const bump =
  major === 0
    ? hasBreaking || hasFeat
      ? "minor (pre-1.0)"
      : "patch"
    : hasBreaking
      ? "major"
      : hasFeat
        ? "minor"
        : "patch"

console.error(
  `base=${base ?? "(none — first release)"} conventional-commits=${counted} bump=${bump} → ${version}`,
)

if (toOutput && process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${version}\nbase=${base ?? ""}\nbump=${bump}\ncommits=${counted}\n`,
  )
}

console.log(version)
