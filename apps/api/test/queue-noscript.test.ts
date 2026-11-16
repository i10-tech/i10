import { afterAll, describe, expect, it } from "bun:test"
import { Redis } from "ioredis"
import { createQueueClient } from "../src/cache/redis.js"

/**
 * The queue client survives a Redis restart.
 *
 * Needs a real Redis, because the failure is the server's own `NOSCRIPT` reply;
 * skipped without one:
 *
 *   WEBHOOKS_TEST_REDIS_URL=redis://localhost:6379/13 bun test test/queue-noscript.test.ts
 *
 * `SCRIPT FLUSH` stands in for the restart: both empty the server's script
 * cache while the client keeps the sha it was handed.
 */
const URL = process.env.WEBHOOKS_TEST_REDIS_URL
const suite = URL ? describe : describe.skip

/** `.rejects` can hang under bun 1.4.2, so capture the rejection by hand. */
const rejection = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  )

suite("queue client after the server forgets its scripts", () => {
  const queue = URL ? createQueueClient(URL) : null
  const admin = URL ? new Redis(URL) : null

  afterAll(async () => {
    await Promise.all([queue?.quit(), admin?.quit()])
  })

  it("reloads a script it loaded and returns the right answer", async () => {
    const sha = (await queue!.script("LOAD", "return ARGV[1]")) as string
    expect(await queue!.evalsha(sha, 0, "first")).toBe("first")

    await admin!.script("FLUSH")

    expect(await queue!.evalsha(sha, 0, "second")).toBe("second")
  })

  it("still reports NOSCRIPT for a sha it never loaded", async () => {
    const sha = "0".repeat(40)
    expect(await rejection(queue!.evalsha(sha, 0))).toMatch(/^NOSCRIPT/)
  })

  it("rethrows a script error that is not NOSCRIPT, running it once", async () => {
    const sha = (await queue!.script(
      "LOAD",
      "redis.call('INCR', KEYS[1]); error('boom')",
    )) as string
    const key = `i10:test-noscript:${crypto.randomUUID().slice(0, 8)}`

    const message = await rejection(queue!.evalsha(sha, 1, key))

    expect(message).toContain("boom")
    expect(message).not.toMatch(/^NOSCRIPT/)
    expect(await admin!.get(key)).toBe("1")
    await admin!.del(key)
  })
})
