import { serve } from "@hono/node-server"
import pino from "pino"
import { createApp } from "./app.js"
import { loadEnv } from "./env.js"

const log = pino({ name: "i10-api" })
const env = loadEnv()

const server = serve({ fetch: createApp().fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port, env: env.NODE_ENV }, "i10 api listening")
})

// Kubernetes sends SIGTERM and then waits terminationGracePeriodSeconds before
// SIGKILL. Closing the listener lets in-flight sends finish; without this a
// rolling deploy drops requests that were already accepted.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log.info({ signal }, "shutting down")
    server.close(() => process.exit(0))
  })
}
