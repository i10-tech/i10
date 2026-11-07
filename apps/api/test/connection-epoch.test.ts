import { drizzle } from "drizzle-orm/postgres-js"
import { describe, expect, it } from "bun:test"
import {
  AUTHD_SETTINGS_TTL_MS,
  raiseAgainWhenAuthdForgets,
  raiseConnectionCredentialEpochs,
} from "../src/projection/connection-epoch.js"

/**
 * Revoking a connection's cached mail passwords (#383): the SQL's text, without
 * a database, and the timing of the second raise. The statement against a real
 * database is in identity-authd-db.test.ts.
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

describe("raising again once authd has forgotten the old settings", () => {
  function run(raise: () => Promise<unknown>) {
    const scheduled: { run: () => void; ms: number }[] = []
    const failures: unknown[] = []
    raiseAgainWhenAuthdForgets(raise, {
      schedule: (fn, ms) => scheduled.push({ run: fn, ms }),
      onFailure: (e) => failures.push(e),
    })
    return { scheduled, failures }
  }

  it("waits longer than authd keeps the settings, and does not raise early", () => {
    let raised = 0
    const { scheduled } = run(async () => {
      raised++
    })
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]!.ms).toBeGreaterThan(AUTHD_SETTINGS_TTL_MS)
    expect(raised).toBe(0)
  })

  it("raises when the time comes", async () => {
    let raised = 0
    const { scheduled, failures } = run(async () => {
      raised++
    })
    scheduled[0]!.run()
    await Promise.resolve()
    expect(raised).toBe(1)
    expect(failures).toEqual([])
  })

  it("reports a failure to raise, and does not throw out of the timer", async () => {
    const { scheduled, failures } = run(async () => {
      throw new Error("db down")
    })
    expect(() => scheduled[0]!.run()).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(failures).toHaveLength(1)
  })

  // An uncaught exception out of a timer takes the process down.
  it("reports a raise that throws before it returns a promise", async () => {
    const { scheduled, failures } = run((() => {
      throw new Error("sync")
    }) as never)
    expect(() => scheduled[0]!.run()).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(failures).toHaveLength(1)
  })
})
