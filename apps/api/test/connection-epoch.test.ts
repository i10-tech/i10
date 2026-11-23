import { drizzle } from "drizzle-orm/postgres-js"
import { describe, expect, it } from "bun:test"
import { raiseConnectionCredentialEpochs } from "../src/projection/connection-epoch.js"

/**
 * Revoking a connection's cached mail passwords (#383): the SQL's text, without
 * a database. The statement against a real database is in
 * connection-epoch-db.test.ts.
 */
const db = drizzle.mock()

describe("raising a connection's credential epochs", () => {
  const statement = () => raiseConnectionCredentialEpochs(db, "conn-1").toSQL()

  it("increments inside the statement rather than reading and writing back", () => {
    expect(statement().sql).toContain(
      '"credential_epoch" = "authd"."accounts"."credential_epoch" + 1',
    )
  })

  // ⚠ THE CONNECTION'S ACCOUNTS ONLY: raising everyone's would make every
  // workspace's mail clients pay for one workspace's change.
  it("touches the accounts the connection manages, and no others", () => {
    const { sql: text, params } = statement()
    expect(text).toContain('"authd"."accounts"."clerk_user_id" in (select')
    expect(text).toContain('from "authd"."managed_accounts"')
    expect(text).toContain('"authd"."managed_accounts"."connection_id" = $')
    expect(params).toContain("conn-1")
  })

  it("changes nothing else that matters to authd", () => {
    const { sql: text } = statement()
    const set = text.slice(text.indexOf(" set "), text.indexOf(" where "))
    expect(set).not.toContain("active")
    expect(set).not.toContain("clerk_updated_at")
    expect(set).not.toContain("suspended")
  })
})
