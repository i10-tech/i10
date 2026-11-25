import { describe, expect, it } from "bun:test"
import type { Sql } from "postgres"
import { assertRlsSubject } from "../src/db/client.js"
import {
  NON_RLS_ALLOWLIST,
  assertRlsAllowlist,
  checkRlsAllowlist,
} from "../src/db/rls-allowlist.js"

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

  // ⚠ Any role with USAGE on a schema (core, identity, authd, ...) could call it.
  it("refuses a definer function PUBLIC can execute in any application schema", async () => {
    await expect(
      assertRlsSubject(
        fakeSql(
          [ROLE_OK],
          [
            {
              ...SCHEMA_OK,
              definers: ["authd.log_access_change", "core.terminate_tenant"],
            },
          ],
        ),
      ),
    ).rejects.toThrow(
      /SECURITY DEFINER functions any role can execute: authd\.log_access_change, core\.terminate_tenant/,
    )
  })

  it("queries SECURITY DEFINER functions across all non-system, non-extension schemas", async () => {
    const queries: string[] = []
    const queue = [[{ "?column?": 1 }], [ROLE_OK], [SCHEMA_OK]]
    const capturingSql = ((strings: TemplateStringsArray) => {
      queries.push(strings.join(" "))
      return Promise.resolve(queue.shift() ?? [])
    }) as unknown as Sql
    await assertRlsSubject(capturingSql)
    const schemaQuery = queries[2] ?? ""
    expect(schemaQuery).toContain(
      "n.nspname not in ('pg_catalog', 'information_schema')",
    )
    expect(schemaQuery).toContain("n.nspname not like 'pg_%'")
    expect(schemaQuery).toContain("d.deptype = 'e'")
  })
})

describe("NON_RLS_ALLOWLIST", () => {
  it("gives every allowlisted table a non-empty reason and includes authd.mail_devices", () => {
    expect(NON_RLS_ALLOWLIST["authd.mail_devices"]).toBeTruthy()
    for (const [table, reason] of Object.entries(NON_RLS_ALLOWLIST)) {
      expect(table).toMatch(/^[a-z_]+\.[a-z_]+$/)
      expect(reason.trim().length).toBeGreaterThan(10)
    }
  })

  it("passes when the database matches the allowlist exactly", () => {
    expect(checkRlsAllowlist(Object.keys(NON_RLS_ALLOWLIST))).toEqual({
      unlisted: [],
      stale: [],
    })
  })

  it("flags an unlisted table without RLS and a stale allowlist entry", async () => {
    const allAllowed = Object.keys(NON_RLS_ALLOWLIST)
    const withNew = [...allAllowed, "authd.unlisted_table"]
    expect(checkRlsAllowlist(withNew)).toEqual({
      unlisted: ["authd.unlisted_table"],
      stale: [],
    })
    const missingOne = allAllowed.filter((t) => t !== "authd.mail_devices")
    expect(checkRlsAllowlist(missingOne)).toEqual({
      unlisted: [],
      stale: ["authd.mail_devices"],
    })

    const fake = (() =>
      Promise.resolve(withNew.map((name) => ({ name })))) as unknown as Sql
    await expect(assertRlsAllowlist(fake)).rejects.toThrow(
      /tables without RLS missing from NON_RLS_ALLOWLIST: authd\.unlisted_table/,
    )

    const fakeStale = (() =>
      Promise.resolve(missingOne.map((name) => ({ name })))) as unknown as Sql
    await expect(assertRlsAllowlist(fakeStale)).rejects.toThrow(
      /stale NON_RLS_ALLOWLIST entries.*authd\.mail_devices/,
    )
  })
})
