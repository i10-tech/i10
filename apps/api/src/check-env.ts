/**
 * Validates the process environment with the API's own schema, then exits.
 *
 * Run as an Argo CD PreSync hook, before the migration, with the environment
 * each long-running workload will get. `loadEnv()` refuses to start on a bad
 * combination, and that is a crash loop AFTER the rollout has begun: the worker
 * Deployment is `Recreate`, so by then the old worker is already gone. The
 * environment only exists in the cluster, so CI cannot check it; this can.
 *
 * ⚠ IT OPENS NO CONNECTION AND PRINTS NO VALUE. `loadEnv()` only parses, and its
 * error lists each invalid variable by NAME with the reason, which is all a
 * reader needs and nothing that belongs in a log.
 */
import { loadEnv } from "./env.js"

try {
  loadEnv()
  console.log("environment valid")
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
}
