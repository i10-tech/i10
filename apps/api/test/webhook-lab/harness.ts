import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Redis } from "ioredis"
import { createQueueClient } from "../../src/cache/redis.js"
import type { Database } from "../../src/db/client.js"
import * as schema from "../../src/db/schema.js"
import { webhookEventOps } from "../../src/webhooks/db.js"
import { parseAllowList, type Lookup } from "../../src/webhooks/egress.js"
import { startWebhookEngine, type WebhookEngine } from "../../src/webhooks/engine.js"
import type { WebhookEventType } from "../../src/webhooks/events.js"
import { generateKey } from "../../src/webhooks/keys.js"
import type { PolicyRules, RetryRules } from "../../src/webhooks/schedule.js"
import { secretBox } from "../../src/webhooks/signing.js"
import { webhookEndpointStore } from "../../src/webhooks/store.js"
import { startReceiver, type Receiver } from "./receiver.js"

/**
 * The webhook conformance lab (#273): the real delivery engine, the real
 * Postgres schema and a real Redis, pointed at a local receiver.
 *
 * ⚠ THE ENGINE IS `startWebhookEngine`, THE SAME FUNCTION worker.ts CALLS.
 * Only the timings are shortened (so a retry schedule is seconds, not
 * minutes), the receiver's address is allow-listed, and `lab.test` resolves
 * to it. Everything between an event being recorded and a POST arriving is
 * production code.
 *
 *   WEBHOOKS_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/webhooks_scratch \
 *   WEBHOOKS_TEST_REDIS_URL=redis://localhost:6379/14 \
 *   bun test test/webhook-lab
 */

export const DATABASE_URL = process.env.WEBHOOKS_TEST_DATABASE_URL
export const REDIS_URL = process.env.WEBHOOKS_TEST_REDIS_URL
export const enabled = Boolean(DATABASE_URL && REDIS_URL)

/**
 * The lab's clock: production's rules (webhooks/schedule.ts), scaled down so a
 * run takes seconds. Same code, smaller numbers.
 */
const LAB_POLICY: PolicyRules = { gaps: [1, 2, 4, 4], disableAfterSeconds: 3 }
export const LAB_RULES: RetryRules = {
  policies: {
    free: LAB_POLICY,
    pro: LAB_POLICY,
    scale: LAB_POLICY,
    enterprise: LAB_POLICY,
  },
  // Production: an hour.
  retryAfterCapSeconds: 10,
  // Production: a minute.
  overloadPenaltySeconds: 4,
  // Production: 20%. None here, so timings can be asserted.
  jitter: 0,
}

export const LAB = {
  maxAttempts: LAB_POLICY.gaps.length + 1,
  /** Production: 10s. */
  timeoutMs: 1_500,
  /** Production: every 30s, for rows due longer than 60s. */
  sweepEveryMs: 500,
  sweepGraceSeconds: 1,
  /** Production's default, so the fairness scenario measures the real number. */
  concurrency: 8,
  /** Production: 5 minutes. */
  holdMs: 2_000,
  /** Production: 3 timeouts, then 30s doubling to 10 minutes. */
  breaker: { threshold: 2, coolMs: 10_000, maxCoolMs: 20_000 },
}

const ALL_EVENTS: WebhookEventType[] = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.opened",
  "email.clicked",
  "email.unsubscribed",
]

export interface Lab {
  receiver: Receiver
  engine: WebhookEngine
  redis: Redis
  owner: ReturnType<typeof postgres>
  db: Database
  /** A fresh workspace, removed when the lab stops. */
  workspace: () => Promise<string>
  /**
   * An endpoint at `http://<host>:<receiver>/<path>`, inserted directly so the
   * lab can use plain http and its own hostnames. Returns its id and the HMAC
   * secret it signs with.
   */
  endpoint: (
    tenantId: string,
    path: string,
    opts?: { events?: WebhookEventType[]; host?: string; rateLimit?: number },
  ) => Promise<{ id: string; secret: string; url: string }>
  /** Records an event the way SES ingestion does, and queues its deliveries. */
  emit: (
    tenantId: string,
    data: Record<string, unknown>,
    opts?: { type?: WebhookEventType; occurredAt?: Date; enqueue?: boolean },
  ) => Promise<string[]>
  /**
   * Queues an endpoint's pending deliveries in one burst, newest first, the
   * way near-simultaneous SNS notifications arrive.
   */
  enqueuePending: (endpointId: string) => Promise<void>
  /** The delivery rows for an endpoint, oldest event first. */
  deliveries: (
    endpointId: string,
  ) => Promise<
    { id: string; status: string; attempts: number; last_error: string | null }[]
  >
  store: ReturnType<typeof webhookEndpointStore>
  /** Restarts the engine, as a deploy or a crash would. */
  restart: (gracefulMs?: number) => Promise<void>
  stop: () => Promise<void>
}

/** Names the lab resolves itself; anything else goes to the system resolver. */
const LAB_DNS: Record<string, Array<[string, 4 | 6]>> = {
  "lab.test": [["127.0.0.1", 4]],
  "private.lab.test": [["10.0.0.1", 4]],
  "metadata.lab.test": [["169.254.169.254", 4]],
  "cgnat.lab.test": [["100.64.0.1", 4]],
  "v6-loopback.lab.test": [["::1", 6]],
  // ⚠ NOT 127.0.0.1, WHICH THE LAB ALLOW-LISTS FOR ITS RECEIVER. A probe
  // aimed there would be permitted by the lab's own configuration and prove
  // nothing about the classifier.
  "mapped.lab.test": [["::ffff:10.0.0.1", 6]],
  "rebind.lab.test": [
    ["93.184.215.14", 4],
    ["10.0.0.2", 4],
  ],
}

const lookup: Lookup = async (host) => {
  const answer = LAB_DNS[host]
  if (!answer) throw new Error(`ENOTFOUND ${host}`)
  return answer.map(([address, family]) => ({ address, family }))
}

const SES_TYPE: Record<WebhookEventType, string> = {
  "email.sent": "Send",
  "email.delivered": "Delivery",
  "email.bounced": "Bounce",
  "email.complained": "Complaint",
  "email.delivery_delayed": "DeliveryDelay",
  "email.failed": "Reject",
  "email.opened": "Open",
  "email.clicked": "Click",
  "email.unsubscribed": "Subscription",
}

export const until = async <T>(
  fn: () => T | Promise<T>,
  timeoutMs: number,
  everyMs = 50,
): Promise<T | undefined> => {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await Bun.sleep(everyMs)
  }
  return undefined
}

export async function startLab(): Promise<Lab> {
  const owner = postgres(DATABASE_URL!, { max: 4, onnotice: () => {} })
  const app = postgres(DATABASE_URL!.replace(/\/\/[^@]+@/, "//i10_api:i10_api@"), {
    max: 16,
    onnotice: () => {},
  })
  const db = drizzle(app, { schema }) as unknown as Database
  const redis = createQueueClient(REDIS_URL!)
  // ⚠ A NAMESPACE OF ITS OWN PER RUN, so the lab never sees, or flushes, a
  // real queue's keys - and two runs never see each other's.
  const namespace = `i10:webhooks-lab:${crypto.randomUUID().slice(0, 8)}`
  const secrets = secretBox("ab".repeat(32))
  const receiver = startReceiver()
  const tenants: string[] = []
  const log = { info: () => {}, warn: () => {}, error: () => {} }

  const start = () =>
    startWebhookEngine({
      db,
      redis,
      secrets,
      log,
      name: `lab:${namespace}`,
      namespace,
      concurrency: LAB.concurrency,
      timeoutMs: LAB.timeoutMs,
      rules: LAB_RULES,
      holdMs: LAB.holdMs,
      breaker: LAB.breaker,
      sweepEveryMs: LAB.sweepEveryMs,
      sweepGraceSeconds: LAB.sweepGraceSeconds,
      schedulerIntervalMs: 200,
      egressAllow: parseAllowList("127.0.0.1/32"),
      lookup,
    })

  const lab: Lab = {
    receiver,
    engine: start(),
    redis,
    owner,
    db,
    store: webhookEndpointStore(db, secrets),

    async workspace() {
      const id = crypto.randomUUID()
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
                  values (${id}, ${`lab-${id.slice(0, 8)}`}, 'Lab', ${`lab-${id}`})`
      tenants.push(id)
      return id
    },

    async endpoint(tenantId, path, opts = {}) {
      const key = generateKey("hmac_sha256")
      const url = `http://${opts.host ?? "lab.test"}:${receiver.port}/${path.replace(/^\//, "")}`
      const [row] = await owner`
        insert into core.webhook_endpoints (tenant_id, url, secret_ciphertext, events, rate_limit)
        values (${tenantId}, ${url}, ${secrets.seal(key.secret)},
                ${opts.events ?? ALL_EVENTS}::core.webhook_event_type[], ${opts.rateLimit ?? null})
        returning id`
      return { id: row!.id as string, secret: key.secret, url }
    },

    async emit(tenantId, data, opts = {}) {
      const ops = webhookEventOps({ db, queue: lab.engine.queue })
      const occurredAt = opts.occurredAt ?? new Date()
      const messageId = crypto.randomUUID()
      const type = opts.type ?? "email.delivered"
      const recorded = await ops.record({
        tenantId,
        messageCreatedAt: occurredAt,
        event: {
          type,
          messageId,
          occurredAt,
          sourceEventId: crypto.randomUUID(),
          suppress: [],
          data,
          // ⚠ A REAL SES SHAPE, because replay-missing (#282) rebuilds `data`
          // from what was stored, the way ingestion first read it.
          raw: {
            eventType: SES_TYPE[type],
            mail: {
              timestamp: occurredAt.toISOString(),
              source: (data.from as string | undefined) ?? "Lab <lab@example.com>",
              destination: ["someone@example.com"],
              commonHeaders: { subject: "lab" },
              tags: {
                i10_message_id: [messageId],
                ...Object.fromEntries(
                  Object.entries(
                    (data.tags as Record<string, string> | undefined) ?? {},
                  ).map(([k, v]) => [k, [v]]),
                ),
              },
            },
            delivery: { timestamp: occurredAt.toISOString() },
          },
        },
      })
      if (recorded.status !== "recorded") return []
      if (opts.enqueue !== false) await ops.enqueue(recorded.deliveries)
      return recorded.deliveries.map((d) => d.id)
    },

    async enqueuePending(endpointId) {
      const rows =
        await owner`select id, tenant_id, endpoint_id, occurred_at from core.webhook_deliveries
                                where endpoint_id = ${endpointId} and status = 'pending'
                                order by occurred_at desc`
      await webhookEventOps({ db, queue: lab.engine.queue }).enqueue(
        rows.map((r) => ({
          id: r.id as string,
          tenantId: r.tenant_id as string,
          endpointId: r.endpoint_id as string,
          occurredAt: r.occurred_at as Date,
        })),
      )
    },

    async deliveries(endpointId) {
      return owner`select id, status, attempts, last_error from core.webhook_deliveries
                    where endpoint_id = ${endpointId} order by occurred_at, created_at` as never
    },

    async restart(gracefulMs = 0) {
      await lab.engine.close(gracefulMs)
      lab.engine = start()
    },

    async stop() {
      await lab.engine.close(0)
      receiver.stop()
      const keys = await redis.keys(`${namespace}*`)
      if (keys.length) await redis.del(...keys)
      redis.disconnect()
      if (tenants.length)
        await owner`delete from core.tenants where id = any(${tenants})`
      await owner.end()
      await app.end()
    },
  }
  return lab
}
