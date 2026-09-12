import { readFileSync } from "node:fs"
import { describe, expect, it } from "bun:test"
import { PgDialect } from "drizzle-orm/pg-core"
import {
  mailboxDomainsStatement,
  mailboxesStatement,
  sendingDomainsStatement,
} from "../src/metering/levels.js"

/**
 * Two questions about a domain, and they must never collapse into one.
 *
 *   counting  — how many does this tenant HAVE?     verified or not
 *   acting    — what may this domain DO?            verified only
 *
 * A limit counts what exists, because an unverified domain is still a row the
 * customer created and can see in their dashboard; counting only verified ones
 * lets a tenant park fifty pending domains against a limit of three. Acting is
 * the opposite: a row in `core.mailbox_domains()` makes Stalwart treat the
 * domain as a local recipient, so an unverified one would let somebody receive
 * mail for a name they merely typed.
 *
 * Both predicates live in places a unit test cannot reach — one in a migration,
 * one in a statement — so they are asserted as text, the same way
 * reconcile.test.ts pins the snapshot functions.
 */
const migration = readFileSync(
  new URL("../drizzle/0016_mailbox_domain_owners.sql", import.meta.url),
  "utf8",
)

const functionBody = (name: string) => {
  const start = migration.indexOf(`CREATE FUNCTION "core"."${name}"`)
  expect(start, `${name} is not in 0016`).toBeGreaterThan(-1)
  return migration.slice(start, migration.indexOf("$$;", start))
}

const dialect = new PgDialect()
const TENANT = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"

describe("what a domain may do", () => {
  const body = functionBody("mailbox_domains")

  /**
   * ⚠ THE SECURITY BOUNDARY. Without it, anyone who types a domain name they do
   * not own starts receiving that domain's mail — the claim is enough.
   */
  it("returns verified domains only", () => {
    expect(body).toContain("d.verified_at IS NOT NULL")
  })

  // A sending domain is not a mailbox domain. Returning one here would have
  // Stalwart accept mail for a domain the tenant only ever wanted to send from.
  it("returns mailbox domains only", () => {
    expect(body).toContain("d.hosts_mailboxes")
    expect(body).not.toContain("d.sends")
  })

  // ⚠ The name and its owner, and nothing else. The caller is a Clerk webhook
  // with no tenant context; it is about to be told the name anyway.
  it("returns the minimum", () => {
    expect(body).toContain("SELECT d.name, d.tenant_id")
    expect(body).not.toContain("dkim")
    expect(body).not.toContain("ses_tenant_name")
  })
})

describe("what a tenant has", () => {
  const rendered = (q: ReturnType<typeof sendingDomainsStatement>) =>
    dialect.sqlToQuery(q).sql

  /**
   * ⚠ THE CONTRAST THIS FILE EXISTS FOR. The limit counts pending domains; the
   * ownership function refuses them. If the counting statements ever grow a
   * `verified_at` predicate, a tenant can hold unlimited unverified domains.
   */
  it("counts unverified domains against the limit", () => {
    for (const statement of [
      rendered(sendingDomainsStatement(TENANT)),
      rendered(mailboxDomainsStatement(TENANT)),
    ]) {
      expect(statement).not.toContain("verified_at")
    }
    expect(functionBody("mailbox_domains")).toContain("verified_at")
  })
})

describe("the backfill", () => {
  // ⚠ Only where it is currently unattributed, so a value already written by
  // the projection is never overwritten by a migration re-running.
  it("fills only rows with no tenant", () => {
    expect(migration).toContain("a.tenant_id IS NULL")
  })

  it("matches on the address's domain, case-insensitively", () => {
    expect(migration).toContain("lower(split_part(a.email, '@', 2)) = lower(d.name)")
  })

  // The count has to be indexed on the column that was never written until now.
  it("indexes the column it populates", () => {
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS "accounts_tenant_idx"')
    expect(dialect.sqlToQuery(mailboxesStatement(TENANT)).sql).toContain("tenant_id =")
  })
})
