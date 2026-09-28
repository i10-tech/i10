import { describe, expect, it } from "bun:test"
import type { Sql } from "postgres"
import { assertRlsSubject } from "../src/db/client.js"

/**
 * The boot guard on the tenant boundary (#212).
 *
 * ⚠ EVERY HOLE IT CHECKS FOR WAS SILENT IN PRODUCTION. A role that owns the
 * tables, a partition with no policy, a definer function anybody can call - in
 * each case every query works and every test passes, and the boundary is gone.
 * The guard is the only thing that says so, so it has to keep saying so.
 */

const ROLE_OK = { role: "i10_api", superuser: false, bypassrls: false, owned: 0 }
const SCHEMA_OK = { unprotected: [], partitions: [], definers: [] }

/** A `sql` whose Nth query answers `answers[N]`; the first is `dialable`'s. */
const fakeSql = (...answers: unknown[][]) => {
  const queue = [[{ "?column?": 1 }], ...answers]
  return (() => Promise.resolve(queue.shift() ?? [])) as unknown as Sql
}

describe("assertRlsSubject", () => {
  it("starts when the role and the schema both hold the boundary", async () => {
    await assertRlsSubject(fakeSql([ROLE_OK], [SCHEMA_OK]))
  })

  it("refuses the schema owner", async () => {
    await expect(
      assertRlsSubject(fakeSql([{ ...ROLE_OK, role: "i10", owned: 33 }], [SCHEMA_OK])),
    ).rejects.toThrow(/owns 33 table/)
  })

  it("refuses a table without row level security", async () => {
    await expect(
      assertRlsSubject(
        fakeSql([ROLE_OK], [{ ...SCHEMA_OK, unprotected: ["new_table"] }]),
      ),
    ).rejects.toThrow(/tables without row level security: new_table/)
  })

  // ⚠ RLS on a partitioned table applies only through the parent.
  it("refuses a partition the role can read directly", async () => {
    await expect(
      assertRlsSubject(
        fakeSql([ROLE_OK], [{ ...SCHEMA_OK, partitions: ["messages_2026_09"] }]),
      ),
    ).rejects.toThrow(/partitions this role can read around.*messages_2026_09/)
  })

  // ⚠ Any role with USAGE on core - the mail server's, today - could call it.
  it("refuses a definer function PUBLIC can execute", async () => {
    await expect(
      assertRlsSubject(
        fakeSql([ROLE_OK], [{ ...SCHEMA_OK, definers: ["terminate_tenant"] }]),
      ),
    ).rejects.toThrow(
      /SECURITY DEFINER functions any role can execute: terminate_tenant/,
    )
  })
})
