import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import { describe, expect, it } from "bun:test"
import { knownTenantsStatement } from "../src/billing/db.js"

/**
 * These assert the SQL, without a database.
 *
 * ⚠ AND THEY EXIST BECAUSE NOTHING ELSE COULD HAVE CAUGHT THE BUG THEY ARE
 * ABOUT. `knownTenants` shipped passing every test in the suite and failed on
 * the second tenant in production, because the defect was in what Postgres
 * received rather than in anything the code returned — a fake answers the same
 * either way. The statement text is the only place this is visible.
 */
const dialect = new PgDialect()
const render = (q: SQL) => dialect.sqlToQuery(q)

const A = "01a0c2d7-60eb-77dd-af4a-2bd365528859"
const B = "01a0b9c4-0025-763a-ac00-632d7ddaf86b"

describe("asking which tenants this database holds", () => {
  /*
   * ⚠ THE WHOLE BUG, IN ONE ASSERTION. Interpolating a JS array expands to
   * `($1, $2)`, which Postgres reads as a ROW CONSTRUCTOR — and
   * `cannot cast type record to uuid[]` took the subscription leg of the
   * reconciler down every half hour for 23 hours. One parameter carrying an
   * array literal is the fix.
   */
  it("passes the ids as one array parameter, not as a row constructor", () => {
    const { sql: statement, params } = render(knownTenantsStatement([A, B])!)

    expect(statement).toContain("core.tenants_known($1::uuid[])")
    expect(statement).not.toContain("$2")
    expect(params).toEqual([`{${A},${B}}`])
  })

  /*
   * ⚠ THE CASE THAT HID IT. With one id the broken form expands to `($1)`,
   * which is a plain parenthesised expression and casts perfectly well — so the
   * bug was invisible for exactly as long as one tenant had a subscription.
   * Pinning one and two together is what stops it coming back.
   */
  it("uses the same shape for a single id as for many", () => {
    const { sql: statement, params } = render(knownTenantsStatement([A])!)

    expect(statement).toContain("core.tenants_known($1::uuid[])")
    expect(params).toEqual([`{${A}}`])
  })

  /*
   * ⚠ NOT DEFENSIVENESS — CORRECTNESS. These ids arrive from
   * `customer.external_id`, which is whatever text whoever created the Polar
   * customer put there. A `,` or `}` in one would corrupt the literal and throw,
   * which is the exact failure being fixed; and an id this database cannot hold
   * is not a known tenant, so dropping it puts the subscription in
   * `unknownTenant` where it belongs.
   */
  it("drops ids that are not uuids rather than corrupting the literal", () => {
    const { params } = render(knownTenantsStatement([A, "not-a-uuid,}", B])!)

    expect(params).toEqual([`{${A},${B}}`])
  })

  // Nothing to ask about is not a question worth a round trip.
  it("asks nothing when no id survives", () => {
    expect(knownTenantsStatement(["nonsense"])).toBeNull()
    expect(knownTenantsStatement([])).toBeNull()
  })
})
