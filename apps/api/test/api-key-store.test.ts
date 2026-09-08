import { PgDialect } from "drizzle-orm/pg-core"
import { drizzle } from "drizzle-orm/postgres-js"
import { describe, expect, it, vi } from "vitest"
import { hashKey } from "../src/auth/api-key.js"
import { keyLookup, resolveStatement } from "../src/auth/store.js"
import { apiKeys } from "../src/db/core.js"
import type { Database } from "../src/db/client.js"

const dialect = new PgDialect()
const render = (q: Parameters<PgDialect["sqlToQuery"]>[0]) => dialect.sqlToQuery(q)

const TENANT = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"

describe("what the lookup asks for", () => {
  /**
   * ⚠ THE ASSERTION THIS FILE EXISTS FOR. `core.api_keys` carries
   * `tenant_isolation`, which reads `current_setting('app.tenant_id')` strictly
   * — and verification runs to DISCOVER the tenant, so there is none set when
   * it runs. Read off the table directly this does not return the wrong row; it
   * raises `unrecognized configuration parameter` on the first request after
   * every deploy, which is precisely the failure that has bitten this codebase
   * repeatedly.
   */
  it("goes through the definer function, never the table", () => {
    const { sql: statement } = render(resolveStatement("deadbeef"))
    expect(statement).toContain("core.resolve_api_key(")
    expect(statement).not.toContain("from core.api_keys")
  })

  // The hash is bound, never interpolated — it is attacker-supplied material.
  it("binds the hash as a parameter", () => {
    const { params, sql: statement } = render(resolveStatement("deadbeef"))
    expect(params).toEqual(["deadbeef"])
    expect(statement).not.toContain("deadbeef")
  })

  it("never sends the presented secret anywhere", () => {
    const secret = "i10_live_AAAAAAAAAAAAAAAAAAAAAAAA"
    const { params } = render(resolveStatement(hashKey(secret)))
    expect(params).not.toContain(secret)
  })
})

describe("reading a row back", () => {
  const fakeDb = (rows: unknown[]) =>
    ({
      execute: vi.fn(async () => rows),
    }) as unknown as Database

  /**
   * ⚠ COERCED, BECAUSE postgres.js HAS BEEN OBSERVED RETURNING A TIMESTAMPTZ AS
   * A STRING BESIDE ONE IT PARSED. `planRow` declared `z.date()` on exactly such
   * a column and threw `expected date, received string` on the first real call
   * in production — a 500 on every gate that resolves a plan. Accepting both is
   * free; assuming one is not.
   */
  it("accepts timestamps the driver returned as strings", async () => {
    const row = await keyLookup(
      fakeDb([
        {
          id: "key-1",
          tenant_id: TENANT,
          scopes: ["emails:send"],
          mode: "live",
          revoked_at: "2026-09-08T10:00:00.000Z",
          expires_at: null,
        },
      ]),
    ).byHash("h")

    expect(row?.revokedAt).toBeInstanceOf(Date)
    expect(row?.revokedAt?.toISOString()).toBe("2026-09-08T10:00:00.000Z")
    expect(row?.expiresAt).toBeNull()
  })

  it("accepts them as Date objects too", async () => {
    const at = new Date("2026-09-08T10:00:00.000Z")
    const row = await keyLookup(
      fakeDb([
        {
          id: "key-1",
          tenant_id: TENANT,
          scopes: [],
          mode: "live",
          revoked_at: at,
          expires_at: null,
        },
      ]),
    ).byHash("h")

    expect(row?.revokedAt).toEqual(at)
  })

  // ⚠ Null scopes must not become null on ResolvedKey — every consumer reads it
  // as an array, and one undefined here is a crash on a request path.
  it("reads a missing scopes column as empty rather than null", async () => {
    const row = await keyLookup(
      fakeDb([
        {
          id: "key-1",
          tenant_id: TENANT,
          scopes: null,
          mode: "live",
          revoked_at: null,
          expires_at: null,
        },
      ]),
    ).byHash("h")

    expect(row?.scopes).toEqual([])
  })

  it("returns null when nothing matched", async () => {
    expect(await keyLookup(fakeDb([])).byHash("h")).toBeNull()
  })
})

describe("what actually reaches postgres on a write", () => {
  /**
   * ⚠ A JS ARRAY BOUND INTO A RAW `sql` TEMPLATE RENDERS AS `($1, $2)` — A ROW
   * CONSTRUCTOR — AND POSTGRES ANSWERS `cannot cast type record to text[]`.
   * That exact defect shipped in the meter's mark-shipped statement and was only
   * found in production. This is a DIFFERENT path: drizzle's typed `.array()`
   * column has its own driver mapper, so it is expected to be fine — which is
   * exactly the kind of expectation worth pinning rather than believing.
   */
  it("binds scopes as one parameter, not as a row constructor", () => {
    const db = drizzle({} as never)
    const query = db
      .insert(apiKeys)
      .values({
        tenantId: TENANT,
        name: "production",
        secretHash: "abc",
        prefix: "i10_live_abcdefgh",
        mode: "live",
        scopes: ["emails:send", "domains:write"],
      })
      .getSQL()

    const { sql: statement, params } = render(query)

    expect(statement).not.toContain("::text[]")
    expect(statement).not.toMatch(/\(\$\d+, \$\d+\)::/)
    // One placeholder for the whole array, and no bound value is a JS array.
    for (const p of params) expect(Array.isArray(p)).toBe(false)
  })
})
