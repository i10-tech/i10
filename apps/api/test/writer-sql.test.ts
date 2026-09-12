import { isNull, or, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import { describe, expect, it } from "bun:test"
import { accounts } from "../src/db/schema.js"

/**
 * These assert the SQL the writer's upsert generates, without a database.
 *
 * The two properties below are the ones that are silently catastrophic if they
 * regress, and both are invisible in a unit test that only checks return
 * values — they live in the statement text.
 */
const db = drizzle.mock()

function upsert() {
  return db
    .insert(accounts)
    .values({ clerkUserId: "u", email: "a@i10.tech", clerkUpdatedAt: new Date() })
    .onConflictDoUpdate({
      target: accounts.clerkUserId,
      set: {
        email: sql`excluded.email`,
        displayName: sql`excluded.display_name`,
        clerkUpdatedAt: sql`excluded.clerk_updated_at`,
        updatedAt: sql`now()`,
      },
      setWhere: or(
        isNull(accounts.clerkUpdatedAt),
        sql`excluded.clerk_updated_at >= ${accounts.clerkUpdatedAt}`,
      ),
    })
    .toSQL().sql
}

describe("the projection upsert", () => {
  // ⚠ `active` is the subscription gate. If it ever appeared in the SET clause,
  // every suspended mailbox would switch back on the next time its owner edited
  // their Clerk profile.
  it("never writes `active`", () => {
    const statement = upsert()
    const doUpdate = statement.slice(statement.indexOf("do update set"))
    expect(doUpdate).not.toContain("active")
  })

  // Without this, a delayed older webhook overwrites newer state.
  it("guards against out-of-order delivery", () => {
    const statement = upsert()
    expect(statement).toContain("excluded.clerk_updated_at >=")
    // A row that has never carried a timestamp must still accept the write.
    expect(statement).toContain('clerk_updated_at" is null')
  })

  it("targets the primary key, so a replay updates rather than duplicating", () => {
    expect(upsert()).toContain("on conflict")
    expect(upsert()).toContain("clerk_user_id")
  })

  it("writes into the authd schema, since PgBouncer drops search_path", () => {
    expect(upsert()).toContain('"authd"."accounts"')
  })
})
