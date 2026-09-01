import { serve } from "@hono/node-server"
import pino from "pino"
import { createApp } from "./app.js"
import { assertRlsSubject, createDb } from "./db/client.js"
import { loadEnv } from "./env.js"

const log = pino({ name: "i10-api" })
const env = loadEnv()

const { sql, db } = createDb(env.DATABASE_URL)

// ⚠ BEFORE THE LISTENER, NOT AFTER, AND NOT IN A HEALTH CHECK. Connecting as a
// role that bypasses row level security is the one misconfiguration in this
// service that produces no error and no wrong answer — it removes the tenant
// boundary and everything keeps working. Checked here, it fails the rollout
// while the previous pod is still serving.
try {
  await assertRlsSubject(sql)
} catch (error) {
  log.fatal({ err: error }, "refusing to start")
  await sql.end({ timeout: 5 })
  process.exit(1)
}

const app = createApp({
  clerkWebhooks: {
    db,
    signingSecret: env.CLERK_WEBHOOK_SECRET,
    hostedDomains: env.MAIL_DOMAINS,
    log,
  },
  pingDb: async () => {
    await sql`select 1`
  },
})

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port, env: env.NODE_ENV }, "i10 api listening")
})

// Kubernetes sends SIGTERM and then waits terminationGracePeriodSeconds before
// SIGKILL. Closing the listener lets in-flight sends finish; without this a
// rolling deploy drops requests that were already accepted.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log.info({ signal }, "shutting down")
    server.close(() => {
      // Close the pool after the listener, so in-flight requests can finish
      // their queries rather than failing on a pool that vanished under them.
      void sql.end({ timeout: 5 }).finally(() => process.exit(0))
    })
  })
}
