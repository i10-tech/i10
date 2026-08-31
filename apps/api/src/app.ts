import { Hono } from "hono"
import { emails } from "./routes/emails.js"

export function createApp() {
  const app = new Hono()

  // Liveness vs readiness are deliberately different endpoints.
  //
  // /healthz says the process is up. /readyz says it can serve — which means
  // its dependencies answer. Wiring a readiness probe to a liveness endpoint
  // is how a pod with a dead database keeps receiving traffic.
  app.get("/healthz", (c) => c.json({ ok: true }))

  app.get("/readyz", (c) =>
    // TODO(phase-2): probe Postgres and Redis here, with a short timeout. A
    // readiness check that can hang is worse than none — it turns a slow
    // dependency into a rollout that never completes.
    c.json({ ok: true, checks: {} }),
  )

  app.get("/version", (c) =>
    c.json({
      sha: process.env.GIT_SHA ?? "dev",
      builtAt: process.env.BUILD_TIME ?? null,
    }),
  )

  app.route("/emails", emails)

  app.notFound((c) =>
    c.json({ statusCode: 404, name: "not_found", message: "Not found." }, 404),
  )

  return app
}
