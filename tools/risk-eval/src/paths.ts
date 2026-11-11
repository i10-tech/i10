import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

/** The i10 checkout this tool lives in: tools/risk-eval/src -> repo root. */
export const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..")

/** The tool's own directory, where the manifest and counts are committed. */
export const TOOL_DIR = resolve(import.meta.dir, "..")

/** Names the pipeline itself uses under the cache root. */
export const RESERVED_DIRS = ["normalised", "splits", "runs"] as const

/**
 * Where downloads, extractions and results live.
 *
 * ⚠ THE CACHE MUST NEVER BE INSIDE THE REPOSITORY. The data is real phishing
 * and spam; the one thing that has to be impossible is `git add .` picking it
 * up. A path inside the checkout is refused outright rather than warned about.
 */
export function cacheRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.I10_RISK_EVAL_CACHE
  const root = resolve(configured && configured !== "" ? configured : defaultCache())
  const rel = relative(REPO_ROOT, root)
  const inside =
    rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
  if (inside) {
    throw new Error(
      `the cache directory ${root} is inside the repository (${REPO_ROOT}); ` +
        "set I10_RISK_EVAL_CACHE to a path outside it",
    )
  }
  return root
}

function defaultCache(): string {
  return join(homedir(), ".cache", "i10-risk-eval")
}

/** Dataset ids become directory names, so they are a closed alphabet. */
export function assertDatasetId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`bad dataset id: ${id}`)
  if ((RESERVED_DIRS as readonly string[]).includes(id)) {
    throw new Error(`dataset id ${id} collides with a pipeline directory`)
  }
}

export function datasetDir(root: string, id: string): string {
  assertDatasetId(id)
  return join(root, id)
}
