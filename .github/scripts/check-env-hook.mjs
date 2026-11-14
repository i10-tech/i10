/**
 * Asserts the PreSync environment check runs with exactly the environment of
 * the workload it stands in for.
 *
 * ⚠ infra/k8s/i10/workloads/check-env.yaml COPIES `envFrom`, `env` and the image
 * from the `api` and `worker` Deployments, because that directory is plain YAML
 * with nothing to share them through. A copy that drifts makes the check pass
 * against an environment no pod will ever have, which is worse than no check:
 * the next bad deploy looks verified. Nothing else notices, so this does.
 */

import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const WORKLOADS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "infra",
  "k8s",
  "i10",
  "workloads",
)

/** Every document in a manifest file. */
function documents(file) {
  const parsed = Bun.YAML.parse(readFileSync(join(WORKLOADS, file), "utf8"))
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean)
}

function container(file, kind, name, containerName) {
  const doc = documents(file).find((d) => d.kind === kind && d.metadata.name === name)
  const found = doc?.spec.template.spec.containers.find((c) => c.name === containerName)
  if (!found)
    throw new Error(`${file}: no ${kind} ${name} with container ${containerName}`)
  return found
}

const hook = (name) => container("check-env.yaml", "Job", "i10-api-check-env", name)

const PAIRS = [
  { file: "api.yaml", deployment: "i10-api", name: "api" },
  { file: "worker.yaml", deployment: "i10-worker", name: "worker" },
]

const problems = []
for (const { file, deployment, name } of PAIRS) {
  const real = container(file, "Deployment", deployment, name)
  const check = hook(name)
  for (const field of ["image", "envFrom", "env"]) {
    if (JSON.stringify(real[field]) !== JSON.stringify(check[field])) {
      problems.push(
        `check-env.yaml container "${name}": \`${field}\` differs from ${file}. ` +
          "Copy it across so the check runs with the environment the pod gets.",
      )
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"))
  process.exit(1)
}
console.log("check-env.yaml matches the api and worker environments")
