import type postgres from "postgres"

/**
 * Refuses a role that row level security would quietly filter. As `i10_api` a
 * cross-workspace job would see no rows rather than an error, and report
 * "nothing left to do".
 *
 * ⚠ THE NAMED TABLE ONLY. For a partitioned table name the parent and read
 * through it: a query through the parent is checked against the parent's
 * policies, never the partitions' own.
 */
export async function assertSeesEveryRow(
  sql: ReturnType<typeof postgres>,
  table: string,
) {
  const [schema, name] = table.split(".") as [string, string]
  const [row] = await sql<{ ok: boolean }[]>`
    select (c.relowner = r.oid or r.rolsuper or r.rolbypassrls) as ok
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_roles r on r.rolname = current_user
     where n.nspname = ${schema} and c.relname = ${name}`
  if (!row?.ok) {
    throw new Error(
      `${sql.options.user} cannot see every row of ${table}: run as the owner role (MIGRATE_DATABASE_URL)`,
    )
  }
}
