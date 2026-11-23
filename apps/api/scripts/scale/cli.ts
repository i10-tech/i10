/**
 * The database scale harness. See docs/research/db-scale/README.md.
 *
 *   bun scripts/scale/cli.ts up                      # scratch Postgres 18 + PgBouncer, migrated
 *   bun scripts/scale/cli.ts reset                   # back to the migrated, empty database
 *   bun scripts/scale/cli.ts seed --profile large --seed 1
 *   bun scripts/scale/cli.ts measure [--runs 30] [--only authd.]
 *   bun scripts/scale/cli.ts stats-roundtrip         # export, scrub, load into an empty twin, compare plans
 *   bun scripts/scale/cli.ts stats-export --source <url> --out <file>   # scrubbed statistics only
 *   bun scripts/scale/cli.ts stats-load --in <file>  # a padded twin to plan against
 *   bun scripts/scale/cli.ts down
 *
 * Everything runs against loopback docker containers named `dbscale-*`; nothing
 * here knows how to reach the cluster.
 */
import { parseArgs } from "node:util"
import { profileNamed } from "./profiles.js"
import { directUrl, down, reset, scratchFromEnv, up, waitForPooler } from "./scratch.js"
import { seed } from "./seed.js"

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: "string", default: "small" },
    seed: { type: "string", default: "1" },
    anchor: { type: "string" },
    runs: { type: "string", default: "30" },
    only: { type: "string" },
    out: { type: "string" },
    "no-fixtures": { type: "boolean", default: false },
    chaos: { type: "boolean", default: false },
    scratch: { type: "string", default: "main" },
    source: { type: "string" },
    in: { type: "string" },
  },
})

const log = (m: string) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`)
const main = scratchFromEnv(values.scratch)

switch (positionals[0]) {
  case "up":
    await up(main)
    await waitForPooler(main)
    log(`up: direct ${directUrl(main)}, pooler 127.0.0.1:${main.poolerPort}`)
    break
  case "reset":
    await reset(main)
    log("reset: i10 recreated from the migrated template")
    break
  case "down":
    down(main)
    if (main.name === "main") down(scratchFromEnv("stats"))
    log("down")
    break
  case "seed": {
    const summary = await seed({
      url: directUrl(main),
      profile: profileNamed(values.profile!),
      seed: Number(values.seed),
      anchor: values.anchor ? new Date(values.anchor) : undefined,
      fixtures: !values["no-fixtures"],
      chaos: values.chaos,
      log,
    })
    console.log(JSON.stringify(summary, null, 2))
    break
  }
  case "measure": {
    const { measure } = await import("./measure.js")
    await measure({
      scratch: main,
      runs: Number(values.runs),
      only: values.only,
      out: values.out,
      log,
    })
    break
  }
  case "coverage": {
    const { chaosCoverage } = await import("./chaos-coverage.js")
    const result = await chaosCoverage({
      scratch: main,
      seed: Number(values.seed),
      log,
    })
    console.log(JSON.stringify(result.totals, null, 2))
    log(`wrote ${result.file}`)
    break
  }
  case "stats-export": {
    if (!values.source || !values.out)
      throw new Error("stats-export needs --source <url> and --out <file>")
    const { exportScrubbed } = await import("./stats.js")
    await exportScrubbed({ source: values.source, out: values.out, log })
    break
  }
  case "stats-load": {
    if (!values.in) throw new Error("stats-load needs --in <file>")
    const { loadScrubbed } = await import("./stats.js")
    await loadScrubbed({ twin: scratchFromEnv("stats"), file: values.in, log })
    break
  }
  case "stats-roundtrip": {
    const { roundTrip } = await import("./stats.js")
    await roundTrip({
      source: main,
      twin: scratchFromEnv("stats"),
      out: values.out,
      log,
    })
    break
  }
  default:
    console.error(
      "usage: cli.ts up | reset | seed | measure | stats-roundtrip | stats-export | stats-load | down",
    )
    process.exit(2)
}
