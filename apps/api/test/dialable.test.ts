import { describe, expect, it } from "bun:test"
import type { Sql } from "postgres"
import { dialable } from "../src/db/client.js"

/**
 * ⚠ THESE PIN WHAT IS RETRIED, WHICH IS THE PART THAT CAN GO WRONG IN BOTH
 * DIRECTIONS. Retry too little and every short-lived job keeps losing the
 * ClusterIP first-connect race — the domain prover exited before selecting a
 * single domain, run after run. Retry too much and a wrong password or a
 * missing database spends ten seconds pretending to be a network blip before
 * saying what it actually is.
 */

/** A tagged-template stand-in that fails with the given errors, then answers. */
function fakeSql(failures: unknown[]) {
  let calls = 0
  const fn = (async () => {
    calls += 1
    const next = failures.shift()
    if (next) throw next
    return [{ "?column?": 1 }]
  }) as unknown as Sql
  return { sql: fn, calls: () => calls }
}

const refused = Object.assign(new Error("connect ECONNREFUSED 10.43.50.120:5432"), {
  code: "ECONNREFUSED",
})

describe("waiting for the database", () => {
  // The race itself: refused on the first dial, fine a moment later.
  it("retries a refused connection until it answers", async () => {
    const warned: unknown[] = []
    const db = fakeSql([refused, refused])

    await dialable(db.sql, { warn: (o) => warned.push(o) }, { delayMs: 0 })

    expect(db.calls()).toBe(3)
    expect(warned).toHaveLength(2)
  })

  // ⚠ A CONFIGURATION IS NOT A RACE. Wrong credentials are the same wrong
  // credentials in a second, so they surface on the first attempt.
  it("does not retry an authentication failure", async () => {
    const auth = Object.assign(
      new Error('password authentication failed for user "x"'),
      {
        code: "28P01",
      },
    )
    const db = fakeSql([auth])

    await expect(dialable(db.sql, undefined, { delayMs: 0 })).rejects.toBe(auth)
    expect(db.calls()).toBe(1)
  })

  // ⚠ AND IT GIVES UP. A database that is genuinely down must still fail the
  // job, so the check-in says so instead of the pod hanging until its deadline.
  it("stops after its budget and surfaces the real error", async () => {
    const db = fakeSql([refused, refused, refused])

    await expect(dialable(db.sql, undefined, { attempts: 3, delayMs: 0 })).rejects.toBe(
      refused,
    )
    expect(db.calls()).toBe(3)
  })

  it("answers at once when the first dial works", async () => {
    const db = fakeSql([])
    await dialable(db.sql, undefined, { delayMs: 0 })
    expect(db.calls()).toBe(1)
  })
})
