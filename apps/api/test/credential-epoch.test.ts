import { drizzle } from "drizzle-orm/postgres-js"
import { describe, expect, it } from "bun:test"
import { raiseCredentialEpoch } from "../src/projection/credential-epoch.js"

/**
 * The SQL of the epoch raise, without a database - the properties that are
 * silently catastrophic if they regress live in the statement text.
 *
 * ⚠ IT LIVES IN ITS OWN MODULE, NOT IN `writer.ts`, BECAUSE `webhooks.test.ts`
 * REPLACES `writer.js` WITH A `mock.module` THAT BUN KEEPS FOR THE REST OF THE
 * RUN. A test importing a new export from there passes alone and fails in the
 * full suite.
 */
const db = drizzle.mock()

describe("raising the credential epoch", () => {
  const statement = () => raiseCredentialEpoch(db, "user_1").toSQL()

  // ⚠ A read-then-write would let two writers land on the same number, and a
  // missed raise is a cached password outliving its revocation.
  it("increments inside the statement rather than reading and writing back", () => {
    expect(statement().sql).toContain(
      '"credential_epoch" = "authd"."accounts"."credential_epoch" + 1',
    )
  })

  it("touches one account only, by Clerk user id", () => {
    const { sql: text, params } = statement()
    expect(text).toContain('where "authd"."accounts"."clerk_user_id" = $')
    expect(params).toContain("user_1")
  })

  it("changes nothing else that matters to authd", () => {
    const { sql: text } = statement()
    const set = text.slice(text.indexOf(" set "), text.indexOf(" where "))
    expect(set).not.toContain("active")
    expect(set).not.toContain("clerk_updated_at")
  })
})
