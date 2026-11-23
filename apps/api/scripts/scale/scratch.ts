/* eslint-disable turbo/no-undeclared-env-vars -- run by hand, never a turbo task */
/**
 * A throwaway Postgres shaped like production, in docker, for the scale harness.
 *
 * ⚠ LOCAL ONLY. Every port binds 127.0.0.1, every container is named
 * `dbscale-<name>-*`, and `down` removes only those. Nothing here can reach the
 * cluster: there is no kubeconfig, no Doppler, no remote host.
 *
 * What matches production (infra/k8s/i10/platform-db):
 * - the image, `ghcr.io/cloudnative-pg/postgresql:18.6-standard-bookworm` (cluster.yaml),
 *   so the planner, the collation library and pgvector are prod's builds;
 * - the 1 GiB memory limit and default `shared_buffers` (128 MB), so a large table
 *   does not fit in cache, as it will not in prod;
 * - `full_page_writes = off` (cluster.yaml);
 * - the `vector` extension (database.yaml), created before migrating as CNPG does;
 * - PgBouncer in transaction pooling mode, `default_pool_size = 20`,
 *   `max_client_conn = 200` (pooler.yaml), from CNPG's own PgBouncer image.
 *
 * What does NOT (and why): `pg_stat_statements` and `auto_explain` are preloaded
 * and `track_io_timing` is on, because the measurement needs them; prod has none
 * of the three. `auto_explain` stays inert (`log_min_duration = -1`) except inside
 * the one transaction that asks for the plans of nested function statements.
 * Authentication is `trust` on loopback, because passwords are not what is measured.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import postgres from "postgres"
import { applyMigrations } from "../../src/migrate-run.js"

export const PG_IMAGE = "ghcr.io/cloudnative-pg/postgresql:18.6-standard-bookworm"
export const POOLER_IMAGE = "ghcr.io/cloudnative-pg/pgbouncer:1.25.1"

/** The four roles the migrations grant to (CNPG makes them in prod). */
export const ROLES = ["authd", "i10_api", "pdns", "stalwart"] as const
export type Role = (typeof ROLES)[number] | "i10"

export const AUTO_EXPLAIN_PARAMS = [
  "auto_explain.log_min_duration",
  "auto_explain.log_analyze",
  "auto_explain.log_buffers",
  "auto_explain.log_nested_statements",
  "auto_explain.log_format",
  "auto_explain.log_level",
  "auto_explain.log_timing",
  "auto_explain.log_verbose",
] as const

export interface Scratch {
  name: string
  port: number
  poolerPort: number | null
}

const MIGRATIONS = join(import.meta.dirname, "..", "..", "drizzle")

/** A direct connection to the primary, as `role` (default the owner, `i10`). */
export function directUrl(s: Scratch, role: Role = "i10", database = "i10"): string {
  return `postgres://${role}@127.0.0.1:${s.port}/${database}`
}

/** A connection through PgBouncer, as the application has it. */
export function poolerUrl(s: Scratch, role: Role): string {
  if (s.poolerPort === null) throw new Error(`scratch ${s.name} has no pooler`)
  return `postgres://${role}@127.0.0.1:${s.poolerPort}/i10`
}

function docker(args: string[], { check = true } = {}): string {
  const r = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" })
  if (check && r.exitCode !== 0) {
    throw new Error(`docker ${args.join(" ")}: ${r.stderr.toString().trim()}`)
  }
  return r.stdout.toString().trim()
}

export const pgName = (s: Scratch) => `dbscale-${s.name}-pg`
const poolerName = (s: Scratch) => `dbscale-${s.name}-pooler`
const netName = (s: Scratch) => `dbscale-${s.name}`

async function waitFor(url: string, what: string, attempts = 60): Promise<void> {
  for (let i = 1; ; i++) {
    const sql = postgres(url, { max: 1, connect_timeout: 2, onnotice: () => {} })
    try {
      await sql`select 1`
      return
    } catch (err) {
      if (i >= attempts)
        throw new Error(`${what} never became reachable: ${String(err)}`)
      await Bun.sleep(500)
    } finally {
      await sql.end({ timeout: 1 })
    }
  }
}

/**
 * Starts the server (and the pooler unless `poolerPort` is null), creates the
 * database `i10`, the four roles and the extensions, and migrates it with the
 * same runner production uses.
 */
export async function up(
  s: Scratch,
  { migrate = true, postgresArgs = [] as string[] } = {},
): Promise<void> {
  down(s)
  docker(["network", "create", netName(s)])
  // initdb and postgres in one command: the CNPG image has no docker-entrypoint.
  // Initialised once, so `docker restart` (a cold cache) keeps the data.
  const init = [
    "{ [ -s /tmp/pgdata/PG_VERSION ] || {" +
      " initdb -D /tmp/pgdata -U i10 --auth=trust --encoding=UTF8 --locale=C >/dev/null &&" +
      // The published port is 127.0.0.1 only; inside, the pooler dials over the docker network.
      " echo 'host all all 0.0.0.0/0 trust' >> /tmp/pgdata/pg_hba.conf; }; }",
    "exec postgres -D /tmp/pgdata -c listen_addresses='*' -c full_page_writes=off" +
      " -c shared_preload_libraries=pg_stat_statements,auto_explain -c pg_stat_statements.track=all" +
      " -c track_io_timing=on -c max_connections=100" +
      postgresArgs.map((a) => ` -c ${a}`).join(""),
  ].join(" && ")
  docker([
    "run",
    "-d",
    "--name",
    pgName(s),
    "--network",
    netName(s),
    "--memory",
    "1g",
    "--shm-size",
    "256m",
    "-p",
    `127.0.0.1:${s.port}:5432`,
    "--entrypoint",
    "bash",
    PG_IMAGE,
    "-c",
    init,
  ])
  await waitFor(directUrl(s, "i10", "postgres"), "postgres")

  const admin = postgres(directUrl(s, "i10", "postgres"), {
    max: 1,
    onnotice: () => {},
  })
  try {
    await admin`create database i10`
    for (const role of ROLES) await admin.unsafe(`create role ${role} login`)
  } finally {
    await admin.end()
  }
  const db = postgres(directUrl(s), { max: 1, onnotice: () => {} })
  try {
    // CNPG creates these as the superuser before the first migration (database.yaml).
    await db`create extension if not exists vector`
    await db`create extension if not exists pg_stat_statements`
    // The measurement asks for nested plans as the application roles, inside one
    // transaction (measure.ts). These are superuser-only settings otherwise.
    for (const param of AUTO_EXPLAIN_PARAMS) {
      await db.unsafe(`grant set on parameter ${param} to i10_api, authd`)
    }
  } finally {
    await db.end()
  }
  if (migrate) {
    await applyMigrations(directUrl(s), MIGRATIONS)
    // A migrated, empty copy to reset from in a second instead of re-migrating.
    const admin2 = postgres(directUrl(s, "i10", "postgres"), {
      max: 1,
      onnotice: () => {},
    })
    try {
      await admin2`create database ${admin2(TEMPLATE)} template i10`
    } finally {
      await admin2.end()
    }
  }

  if (s.poolerPort !== null) startPooler(s)
}

const TEMPLATE = "i10_migrated"

/**
 * Drops `i10` and recreates it from the migrated template, with the database
 * grants migration 0001 made (a template copies the contents, not the ACL).
 */
export async function reset(s: Scratch): Promise<void> {
  const admin = postgres(directUrl(s, "i10", "postgres"), {
    max: 1,
    onnotice: () => {},
  })
  try {
    await admin`drop database if exists i10 with (force)`
    await admin`create database i10 template ${admin(TEMPLATE)}`
    await admin`grant connect on database i10 to authd, i10_api, stalwart`
  } finally {
    await admin.end()
  }
}

function startPooler(s: Scratch): void {
  const dir = join(tmpdir(), `dbscale-${s.name}-pooler`)
  mkdirSync(dir, { recursive: true })
  const users = ["i10", ...ROLES]
  writeFileSync(
    join(dir, "userlist.txt"),
    users.map((u) => `"${u}" ""`).join("\n") + "\n",
  )
  writeFileSync(
    join(dir, "pgbouncer.ini"),
    [
      "[databases]",
      `i10 = host=${pgName(s)} port=5432 dbname=i10`,
      "[pgbouncer]",
      "listen_addr = 0.0.0.0",
      "listen_port = 5432",
      "auth_type = trust",
      "auth_file = /cfg/userlist.txt",
      // pooler.yaml
      "pool_mode = transaction",
      "max_client_conn = 200",
      "default_pool_size = 20",
      "ignore_startup_parameters = extra_float_digits,options",
      "",
    ].join("\n"),
  )
  docker([
    "run",
    "-d",
    "--name",
    poolerName(s),
    "--network",
    netName(s),
    "-p",
    `127.0.0.1:${s.poolerPort}:5432`,
    "-v",
    `${dir}:/cfg:ro`,
    "--entrypoint",
    "pgbouncer",
    POOLER_IMAGE,
    "/cfg/pgbouncer.ini",
  ])
}

export async function waitForPooler(s: Scratch): Promise<void> {
  await waitFor(poolerUrl(s, "i10_api"), "pgbouncer")
}

/** Removes this scratch's containers and network, and nothing else. */
export function down(s: Scratch): void {
  docker(["rm", "-f", pgName(s), poolerName(s)], { check: false })
  docker(["network", "rm", netName(s)], { check: false })
}

/** Restarts the server, which empties shared buffers, for a cold-cache run. */
export async function restart(s: Scratch): Promise<void> {
  docker(["restart", pgName(s)])
  await waitFor(directUrl(s), "postgres")
}

/**
 * `main` is the seeded database, `stats` the empty twin the statistics
 * round trip loads into (no pooler), `dev` a second seeded one for working on
 * the harness while `main` seeds. Ports start at DB_SCALE_PORT (55491).
 */
const LAYOUT: Record<string, { offset: number; pooler: boolean }> = {
  main: { offset: 0, pooler: true },
  stats: { offset: 10, pooler: false },
  dev: { offset: 20, pooler: true },
}

export function scratchFromEnv(name = "main"): Scratch {
  const base = Number(process.env.DB_SCALE_PORT ?? 55491)
  const l = LAYOUT[name]
  if (!l)
    throw new Error(`unknown scratch "${name}" (${Object.keys(LAYOUT).join(", ")})`)
  return {
    name,
    port: base + l.offset,
    poolerPort: l.pooler ? base + l.offset + 1 : null,
  }
}
