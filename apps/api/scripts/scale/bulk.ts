/**
 * Batched multi-row inserts, the bulk path for the seed.
 *
 * Each batch is one `insert ... select from json_populate_recordset(...)`, so the
 * server casts every value to its column's type and every constraint, foreign key
 * and trigger fires as it would for the application. RLS does not apply because
 * the seed runs as the owner, as a migration backfill would.
 *
 * ⚠ NOT `COPY FROM STDIN`. With postgres.js 4.1 under bun 1.4 the COPY query
 * resolves before the server has the data: rows were dropped with no error, and
 * the connection went back to the pool still in COPY mode, so the NEXT statement
 * on it was lost too (reproduced 2026-11-22: a 20,000 row COPY left 0 rows).
 */
import type { Sql } from "postgres"

export type Cell =
  string | number | boolean | Date | null | undefined | readonly unknown[] | object

const BATCH = 5_000

export class BulkWriter {
  private batch: Record<string, unknown>[] = []
  private jsonColumns = new Set<string>()
  rows = 0

  constructor(
    private readonly sql: Sql,
    readonly table: string,
    private readonly columns: readonly string[],
  ) {}

  async open(): Promise<this> {
    const [schema, name] = this.table.split(".")
    const types = await this.sql<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns
       where table_schema = ${schema!} and table_name = ${name!}`
    const known = new Map(types.map((t) => [t.column_name, t.data_type]))
    for (const c of this.columns) {
      const type = known.get(c)
      if (!type) throw new Error(`${this.table} has no column ${c}`)
      if (type === "jsonb" || type === "json") this.jsonColumns.add(c)
    }
    return this
  }

  async row(values: readonly Cell[]): Promise<void> {
    if (values.length !== this.columns.length) {
      throw new Error(
        `${this.table}: ${values.length} values for ${this.columns.length} columns`,
      )
    }
    const record: Record<string, unknown> = {}
    this.columns.forEach((c, i) => {
      const v = values[i]
      // A json column given text is JSON text; anything else is the value itself.
      record[c] =
        this.jsonColumns.has(c) && typeof v === "string" ? JSON.parse(v) : (v ?? null)
    })
    this.batch.push(record)
    this.rows++
    if (this.batch.length >= BATCH) await this.flush()
  }

  private async flush(): Promise<void> {
    if (this.batch.length === 0) return
    const payload = JSON.stringify(this.batch)
    this.batch = []
    const cols = this.columns.map((c) => `"${c}"`).join(", ")
    try {
      await this.sql.unsafe(
        `insert into ${this.table} (${cols}) select ${cols} from json_populate_recordset(null::${this.table}, $1::text::json)`,
        [payload],
      )
    } catch (err) {
      throw new Error(`${this.table}: ${(err as Error).message}`, { cause: err })
    }
  }

  async close(): Promise<number> {
    await this.flush()
    return this.rows
  }
}

/** Opens a writer, hands it to `fill`, and flushes it; returns the row count. */
export async function bulkRows(
  sql: Sql,
  table: string,
  columns: readonly string[],
  fill: (w: BulkWriter) => Promise<void>,
): Promise<number> {
  const w = await new BulkWriter(sql, table, columns).open()
  await fill(w)
  return w.close()
}
