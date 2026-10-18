import { afterAll, describe, expect, it } from "bun:test"
import { createQueueClient } from "../src/cache/redis.js"
import {
  createInvitationQueue,
  invitationJobId,
  invitationScheduler,
  startInvitationWorker,
  type ExpireOutcome,
  type InvitationJob,
} from "../src/queue/invitation-queue.js"

/**
 * The invitation expiry job against a real Redis and groupmq (#327): it runs
 * at the instant it was scheduled for, never before, and a cancelled one
 * never runs.
 *
 *   WEBHOOKS_TEST_REDIS_URL=redis://localhost:6379/13 bun test test/invitation-queue.test.ts
 *
 * ⚠ REAL groupmq ON PURPOSE. Its delayed jobs have fired early in other paths
 * (chaining ignores the delay; retry.lua floors the clock to the second), so
 * only the library itself can say this one does not.
 */
const URL = process.env.WEBHOOKS_TEST_REDIS_URL
const suite = URL ? describe : describe.skip
const quiet = { warn: () => {}, info: () => {} }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

suite("invitation expiry jobs", () => {
  const redis = URL ? createQueueClient(URL) : null
  const namespace = `i10:test-invitations:${crypto.randomUUID().slice(0, 8)}`
  const queue = redis ? createInvitationQueue({ redis, namespace }) : null
  const workers: { close: (ms?: number) => Promise<void> }[] = []

  afterAll(async () => {
    await Promise.all(workers.map((w) => w.close(1_000)))
    await redis?.quit()
  })

  /** An `expire` that only revokes at or after `at`, by the wall clock. */
  const clockedExpire =
    (dueAt: Map<string, number>, revoked: Map<string, number>) =>
    async (job: InvitationJob): Promise<ExpireOutcome> => {
      const at = dueAt.get(job.id)!
      const left = at - Date.now()
      if (left > 0) return { outcome: "early", ms: left }
      revoked.set(job.id, Date.now())
      return { outcome: "expired" }
    }

  const dueAt = new Map<string, number>()
  const revoked = new Map<string, number>()

  it("revokes at the instant, never before", async () => {
    workers.push(
      startInvitationWorker({
        queue: queue!,
        name: "test:invitations",
        expire: clockedExpire(dueAt, revoked),
        log: quiet,
        schedulerIntervalMs: 100,
      }),
    )
    const schedule = invitationScheduler(queue!)
    const ids = ["a", "b", "c"].map((x) => `${x}-${crypto.randomUUID()}`)
    for (const [i, id] of ids.entries()) {
      const at = Date.now() + 1_200 + i * 300
      dueAt.set(id, at)
      await schedule.schedule({ id, tenantId: "t" }, new Date(at))
    }
    for (let i = 0; i < 60 && revoked.size < ids.length; i++) await sleep(100)
    for (const id of ids) {
      const when = revoked.get(id)
      expect(when).toBeDefined()
      expect(when!).toBeGreaterThanOrEqual(dueAt.get(id)!)
      // On time to within the promotion tick and a little scheduling noise.
      expect(when! - dueAt.get(id)!).toBeLessThan(2_000)
    }
  }, 15_000)

  it("never runs once cancelled", async () => {
    const schedule = invitationScheduler(queue!)
    const id = `cancel-${crypto.randomUUID()}`
    dueAt.set(id, Date.now() + 600)
    await schedule.schedule({ id, tenantId: "t" }, new Date(dueAt.get(id)!))
    expect(await queue!.getJob(invitationJobId(id))).toBeTruthy()
    await schedule.cancel(id)
    // The worker from the test above is still running on this queue.
    await sleep(1_500)
    expect(revoked.has(id)).toBe(false)
  }, 10_000)
})
