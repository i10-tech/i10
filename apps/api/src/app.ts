import { createRequire } from "node:module"
import { OpenAPIHono } from "@hono/zod-openapi"
import type { VerifyDeps } from "./auth/api-key.js"
import type { AcceptOps, Logger as AcceptLogger } from "./send/accept.js"
import type { Metering } from "./send/metering.js"
import { createAutoconfig, type AutoconfigDeps } from "./routes/autoconfig.js"
import { emails } from "./routes/emails.js"
import { createClerkWebhooks, type ClerkWebhookDeps } from "./routes/webhooks.js"

/**
 * Read from package.json rather than `npm_package_version`, which pnpm only
 * sets when a script runs through it — the container runs `node dist/index.js`
 * and would publish a spec claiming version 0.0.0. The relative path resolves
 * to apps/api/package.json from both `src/` and `dist/`.
 */
const { version: API_VERSION } = createRequire(import.meta.url)("../package.json") as {
  version: string
}

export interface AppDeps {
  clerkWebhooks?: ClerkWebhookDeps
  /** Mail-client provisioning. See routes/autoconfig.ts. */
  autoconfig?: AutoconfigDeps
  /**
   * How API keys are verified. Omitted in tests and in the OpenAPI generator,
   * where requireApiKey then refuses every well-formed key with a 501 rather
   * than letting an unauthenticated caller through.
   */
  apiKeyAuth?: VerifyDeps
  /**
   * Persistence and queueing for the send path. Omitted in tests and in the
   * OpenAPI generator, where the routes then answer 501 rather than letting an
   * unconfigured deployment silently accept mail it will never send.
   */
  sendPath?: AcceptOps & { metering: Metering; log: AcceptLogger }
  /** Answers whether the database is reachable, for the readiness probe. */
  pingDb?: () => Promise<void>
}

export function createApp(deps: AppDeps = {}) {
  const app = new OpenAPIHono()

  // ⚠ INJECTED THROUGH THE CONTEXT, NOT CLOSED OVER. The email routes are
  // declared at module scope and `middleware:` on a createRoute() is resolved
  // at import time, so the middleware cannot capture anything createApp knows.
  // Setting it per request is what lets one process serve a configured app and
  // the tests serve an unconfigured one.
  if (deps.apiKeyAuth || deps.sendPath) {
    const auth = deps.apiKeyAuth
    const sendPath = deps.sendPath
    app.use("*", async (c, next) => {
      if (auth) c.set("apiKeyAuth", auth)
      if (sendPath) c.set("sendPath", sendPath)
      await next()
    })
  }

  // Liveness vs readiness are deliberately different endpoints.
  //
  // /healthz says the process is up. /readyz says it can serve — which means
  // its dependencies answer. Wiring a readiness probe to a liveness endpoint
  // is how a pod with a dead database keeps receiving traffic.
  app.get("/healthz", (c) => c.json({ ok: true }))

  app.get("/readyz", async (c) => {
    // A readiness check that can hang is worse than none — it turns a slow
    // dependency into a rollout that never completes. Hence the timeout.
    const checks: Record<string, boolean> = {}

    if (deps.pingDb) {
      checks.database = await withTimeout(deps.pingDb(), 2000)
        .then(() => true)
        .catch(() => false)
    }

    const ok = Object.values(checks).every(Boolean)
    return c.json({ ok, checks }, ok ? 200 : 503)
  })

  app.get("/version", (c) =>
    c.json({
      sha: process.env.GIT_SHA ?? "dev",
      builtAt: process.env.BUILD_TIME ?? null,
    }),
  )

  app.route("/emails", emails)

  // Mounted unconditionally. Only mounting it when configured would turn a
  // missing secret into a 404 that looks like Clerk having the wrong URL,
  // rather than the 503 that says what is actually wrong.
  //
  // Deliberately NOT in the OpenAPI document: this endpoint implements Clerk's
  // contract, not ours. Publishing it would invite customers to call it, and it
  // would show up in every generated SDK.
  app.route("/webhooks", createClerkWebhooks(deps.clerkWebhooks))

  // Mounted for the same reason and with the same exclusion from the document.
  // Traefik puts this path on `autoconfig.i10.tech` alongside Stalwart's own
  // autoconfig endpoints, so a mail client meets one hostname rather than two.
  app.route("/autoconfig", createAutoconfig(deps.autoconfig))

  // ⚠ THE HEADER IS PART OF THE COMPATIBILITY SURFACE. `Authorization: Bearer`
  // is what makes `resend/node` → `@i10/node` a one-line migration, so the
  // published document has to say exactly that.
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description:
      "Your i10 API key. Keys are prefixed `i10_live_` or `i10_test_` so they " +
      "are recognisable in your own logs and greppable in a leak scan.",
  })

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "i10 API",
      version: API_VERSION,
      description:
        "Transactional email. The document is generated from the same Zod " +
        "schemas the server validates with and the SDKs are built from, so it " +
        "cannot drift from the implementation.",
    },
    servers: [{ url: "https://api.i10.tech", description: "Production" }],
    tags: [{ name: "Emails", description: "Sending mail." }],
  })

  // The human-readable reference lives at docs.i10.tech/api, not here. This
  // origin serves machines; rendering HTML on it would mean two places to keep
  // in sync and a Scalar bundle in the API image for no reason. The document
  // itself stays, because SDK users and tooling expect it at the API origin.

  app.notFound((c) =>
    c.json({ statusCode: 404, name: "not_found", message: "Not found." }, 404),
  )

  return app
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timed out")), ms).unref?.(),
    ),
  ])
}
