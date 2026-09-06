import { createRequire } from "node:module"
import { OpenAPIHono } from "@hono/zod-openapi"
import { HTTPException } from "hono/http-exception"
import { routePath } from "hono/route"
import type { VerifyDeps } from "./auth/api-key.js"
import { createBilling, type BillingDeps } from "./routes/billing.js"
import {
  createCheckoutStatus,
  type CheckoutStatusDeps,
} from "./routes/checkout-status.js"
import { createPolarWebhooks, type PolarWebhookDeps } from "./routes/polar-events.js"
import type { AcceptOps, Logger as AcceptLogger } from "./send/accept.js"
import type { Metering } from "./send/metering.js"
import { createAutoconfig, type AutoconfigDeps } from "./routes/autoconfig.js"
import { emails } from "./routes/emails.js"
import { createSesWebhooks, type SesWebhookDeps } from "./routes/ses-events.js"
import { webhookEndpoints } from "./routes/webhook-endpoints.js"
import { domains } from "./routes/domains.js"
import { createClerkWebhooks, type ClerkWebhookDeps } from "./routes/webhooks.js"
import type { EmailLookup } from "./send/lookup.js"
import { equalSecrets } from "./webhooks/signing.js"
import type { WebhookEndpointStore } from "./webhooks/store.js"
import type { DomainStore } from "./domains/store.js"

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
  /**
   * Reads a message back for `GET /emails/{id}`. Omitted in tests and in the
   * OpenAPI generator, where the route answers 501 rather than 404 — a 404
   * would say the message does not exist, which is a different and wrong claim.
   */
  emailLookup?: EmailLookup
  /** Customer-managed webhook destinations, for `/webhook-endpoints`. */
  webhookEndpoints?: WebhookEndpointStore
  /**
   * Sending domains, for `/domains`.
   *
   * ⚠ THE ONLY PLACE A PLAN'S DOMAIN LIMIT IS ENFORCED, because it is the only
   * thing in the application that writes `core.domains`. Omitted in tests and
   * in the OpenAPI generator, where the routes answer 501.
   */
  domains?: DomainStore
  /** SES delivery events over SNS. Unauthenticated; signature-verified. */
  sesWebhooks?: SesWebhookDeps
  /**
   * Polar subscription events. Unauthenticated; signature-verified.
   *
   * ⚠ THE ONLY WIRING IN THE APPLICATION THAT CAN GRANT A PAID PLAN. Everything
   * it needs to do that is behind billing/grants.ts, which takes the two
   * operations rather than a whole client — so no other route can reach `grantPlan`
   * by way of something it happens to have been passed.
   */
  polarWebhooks?: PolarWebhookDeps
  /** Starting a checkout, and reading back the plan in force. API-key authed. */
  billing?: BillingDeps
  /**
   * What the post-checkout page polls. Unauthenticated, and grants nothing:
   * it reports the row the Polar webhook writes. See routes/checkout-status.ts.
   */
  checkoutStatus?: CheckoutStatusDeps
  /**
   * Queue depth, for the autoscaler and for whoever is asking why mail is slow.
   *
   * ⚠ TOKEN-GUARDED AND OUTSIDE THE OPENAPI DOCUMENT. It is not a customer
   * endpoint: it answers for the whole deployment rather than for one tenant,
   * and it touches Redis on every request, which makes an open one a free
   * amplifier. KEDA sends a bearer token, so there is no reason to leave it
   * open.
   */
  metrics?: {
    token: string
    queueDepth: () => Promise<QueueDepth>
  }
  /** Answers whether the database is reachable, for the readiness probe. */
  pingDb?: () => Promise<void>
  /**
   * Where an unhandled route error goes, besides into the 500.
   *
   * ⚠ INJECTED RATHER THAN IMPORTED, so this module still knows nothing about
   * Sentry. Every test in the suite builds an app without it and gets the same
   * 500 with no reporting, which is also what a local checkout gets.
   *
   * ⚠ AND WITHOUT IT A 500 IS REPORTED NOWHERE. A throw inside a route does not
   * crash the process, so the SDK's uncaught-exception handler never sees it;
   * with tracing off there is no HTTP instrumentation to catch it either. This
   * hook is the only path from a failed request to an alert.
   */
  reportError?: (error: unknown, context?: Record<string, unknown>) => void
}

/**
 * ⚠ `pending` IS THE SCALING SIGNAL AND `delayed` DELIBERATELY IS NOT. A send
 * scheduled for next Tuesday sits in the delayed set for a week; counting it
 * would hold every worker replica up for seven days waiting on one email. What
 * needs capacity is work that is due now.
 */
export interface QueueDepth {
  /** Per queue: work that is ready or in flight. */
  pending: Record<string, number>
  /** Per queue: jobs waiting for their moment. Reported, never scaled on. */
  delayed: Record<string, number>
  /** The sum of `pending`, which is what an autoscaler reads. */
  total: number
}

export function createApp(deps: AppDeps = {}) {
  const app = new OpenAPIHono()

  // ⚠ INJECTED THROUGH THE CONTEXT, NOT CLOSED OVER. The email routes are
  // declared at module scope and `middleware:` on a createRoute() is resolved
  // at import time, so the middleware cannot capture anything createApp knows.
  // Setting it per request is what lets one process serve a configured app and
  // the tests serve an unconfigured one.
  if (
    deps.apiKeyAuth ||
    deps.sendPath ||
    deps.emailLookup ||
    deps.webhookEndpoints ||
    deps.domains
  ) {
    const auth = deps.apiKeyAuth
    const sendPath = deps.sendPath
    const lookup = deps.emailLookup
    const endpoints = deps.webhookEndpoints
    const domainStore = deps.domains
    app.use("*", async (c, next) => {
      if (auth) c.set("apiKeyAuth", auth)
      if (sendPath) c.set("sendPath", sendPath)
      if (lookup) c.set("emailLookup", lookup)
      if (endpoints) c.set("webhookEndpoints", endpoints)
      if (domainStore) c.set("domains", domainStore)
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

  // ⚠ NOT IN THE OPENAPI DOCUMENT, ON PURPOSE. Publishing it would put an
  // operational endpoint in every generated SDK and invite customers to call
  // something that answers for the whole deployment rather than for them.
  app.get("/internal/queue-depth", async (c) => {
    const metrics = deps.metrics
    if (!metrics) {
      return c.json(
        {
          statusCode: 501,
          name: "internal_server_error" as const,
          message: "Metrics are not configured.",
        },
        501,
      )
    }

    const header = c.req.header("Authorization") ?? ""
    const given = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
    // ⚠ CONSTANT TIME. `===` on a token returns as soon as two bytes differ,
    // and the time that takes is enough to recover it one byte at a time.
    if (!equalSecrets(metrics.token, given)) {
      return c.json(
        { statusCode: 401, name: "invalid_access" as const, message: "Bad token." },
        401,
      )
    }

    return c.json(await metrics.queueDepth(), 200)
  })

  app.get("/version", (c) =>
    c.json({
      sha: process.env.GIT_SHA ?? "dev",
      builtAt: process.env.BUILD_TIME ?? null,
    }),
  )

  app.route("/emails", emails)

  // Customer-facing, API-key authenticated. ⚠ Deliberately NOT under
  // `/webhooks`, which is the inbound router below: one prefix for two opposite
  // authentication models is how a middleware mistake exposes the wrong half.
  app.route("/webhook-endpoints", webhookEndpoints)

  // Resend's paths, verbs and body keys. See routes/domains.ts.
  app.route("/domains", domains)

  // Mounted unconditionally. Only mounting it when configured would turn a
  // missing secret into a 404 that looks like Clerk having the wrong URL,
  // rather than the 503 that says what is actually wrong.
  //
  // Deliberately NOT in the OpenAPI document: this endpoint implements Clerk's
  // contract, not ours. Publishing it would invite customers to call it, and it
  // would show up in every generated SDK.
  app.route("/webhooks", createClerkWebhooks(deps.clerkWebhooks))

  // SES delivery events, over SNS. Same router prefix, same exclusion from the
  // document, and the same rule: nothing reaches the database before the
  // signature verifies — here it protects a tenant's suppression list.
  app.route("/webhooks", createSesWebhooks(deps.sesWebhooks))

  // Polar subscription events, same prefix and the same rule. This is the one
  // that moves money into entitlement, so the signature check is the whole of
  // the authorisation — see routes/polar-events.ts.
  app.route("/webhooks", createPolarWebhooks(deps.polarWebhooks))

  // ⚠ ALSO OUTSIDE THE OPENAPI DOCUMENT, AND NOT FOR THE SAME REASON. The two
  // routers above implement somebody else's contract; this one is ours, but it
  // is a console action rather than part of the email API, and publishing it
  // would put "create a checkout session" in every generated SDK.
  app.route("/billing", createBilling(deps.billing))

  // ⚠ SEPARATE FROM `/billing` BECAUSE IT IS THE ONE BILLING ROUTE A BROWSER
  // MAY CALL UNAUTHENTICATED. `/billing` guards `*` with requireApiKey, which
  // is fail-closed and worth keeping; an exception carved into that wildcard
  // would be one refactor away from unguarding its neighbours. It grants
  // nothing — it reads back a row only the Polar webhook can move.
  app.route("/checkout-status", createCheckoutStatus(deps.checkoutStatus))

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

  app.onError((error, c) => {
    // Hono raises this for a malformed body and similar; it carries its own
    // status and response, and rewriting it as a 500 would both lie to the
    // caller and report their bad request as our bug.
    if (error instanceof HTTPException) return error.getResponse()

    // ⚠ THE ROUTE PATTERN, NOT THE URL. `/emails/{id}` groups every failure of
    // one endpoint into one issue; the concrete path would open a new issue per
    // message id and bury the signal under its own volume.
    deps.reportError?.(error, { route: routePath(c), method: c.req.method })

    // ⚠ THE SAME SHAPE AS EVERY OTHER ERROR THIS API RETURNS, and deliberately
    // no detail. What went wrong is in the log and in Sentry; a caller learning
    // which internal call threw learns something about our infrastructure and
    // nothing they can act on.
    return c.json(
      { statusCode: 500, name: "internal_error", message: "Something went wrong." },
      500,
    )
  })

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
