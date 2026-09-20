import pkg from "../package.json" with { type: "json" }
import { OpenAPIHono } from "@hono/zod-openapi"
import { HTTPException } from "hono/http-exception"
import { routePath } from "hono/route"
import type { VerifyDeps } from "./auth/api-key.js"
import { createBilling, type BillingDeps } from "./routes/billing.js"
import {
  createCheckoutStatus,
  type CheckoutStatusDeps,
} from "./routes/checkout-status.js"
import { createConsole, type ConsoleDeps } from "./routes/console.js"
import { createPolarWebhooks, type PolarWebhookDeps } from "./routes/polar-events.js"
import type { AcceptOps, Logger as AcceptLogger } from "./send/accept.js"
import type { Metering } from "./send/metering.js"
import { createAutoconfig, type AutoconfigDeps } from "./routes/autoconfig.js"
import { emails } from "./routes/emails.js"
import { createSesWebhooks, type SesWebhookDeps } from "./routes/ses-events.js"
import {
  createStalwartWebhooks,
  type StalwartWebhookDeps,
} from "./routes/stalwart-events.js"
import { webhookEndpoints } from "./routes/webhook-endpoints.js"
import { domains } from "./routes/domains.js"
import { mailboxes } from "./routes/mailboxes.js"
import { createApiKeyRoutes, type ApiKeyRouteDeps } from "./routes/api-keys.js"
import { createClerkWebhooks, type ClerkWebhookDeps } from "./routes/webhooks.js"
import type { EmailLookup } from "./send/lookup.js"
import { equalSecrets } from "./webhooks/signing.js"
import type { WebhookEndpointStore } from "./webhooks/store.js"
import type { DomainStore } from "./domains/store.js"
import type { SessionVerifier } from "./middleware/session.js"
import type { MailboxProvisioning } from "./mailboxes/provision.js"

/**
 * Read from package.json rather than `npm_package_version`, which is only set
 * when a script runs through the package manager — the container runs
 * `bun dist/index.js` directly and would publish a spec claiming version 0.0.0.
 *
 * ⚠ A STATIC IMPORT, NOT `createRequire(import.meta.url)("../package.json")`,
 * BECAUSE THE BUILD NOW BUNDLES. That call resolved relative to the emitted
 * file, which worked while `tsc` mirrored src/ into dist/ one file at a time.
 * `bun build` collapses the tree into dist/index.js, so `../package.json`
 * became /app/package.json — a file the runtime image does not have — and the
 * process died at import time with ERR_MODULE_NOT_FOUND. A static import is
 * resolved by the bundler and inlined, so there is nothing left to look up.
 */
const { version: API_VERSION } = pkg

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
   * Minting, listing, revoking and rotating a tenant's own API keys.
   *
   * ⚠ THESE ROUTES CANNOT MINT A TENANT'S FIRST KEY — they authenticate with
   * one. See routes/api-keys.ts. Omitted in tests and in the OpenAPI generator,
   * where they answer 501.
   */
  apiKeys?: ApiKeyRouteDeps
  /**
   * Sending domains, for `/domains`.
   *
   * ⚠ THE ONLY PLACE A PLAN'S DOMAIN LIMIT IS ENFORCED, because it is the only
   * thing in the application that writes `core.domains`. Omitted in tests and
   * in the OpenAPI generator, where the routes answer 501.
   */
  domains?: DomainStore
  /**
   * Verifies the Clerk session behind `/mailboxes`.
   *
   * ⚠ A DIFFERENT CREDENTIAL FROM `apiKeyAuth`, NOT A FALLBACK FOR IT. Nothing
   * accepts both: sending routes take a key and mailbox routes take a session.
   * Omitted in tests and in the OpenAPI generator, where `requireUser` answers
   * 501 rather than letting an unauthenticated caller through.
   */
  sessionAuth?: SessionVerifier
  /**
   * Creating a human mailbox, for `/mailboxes`.
   *
   * ⚠ THE ONLY PLACE `authd.accounts.active` IS EVER SET TRUE, which is what
   * makes a mailbox visible to authd at all. Omitted in tests and in the
   * OpenAPI generator, where the routes answer 501.
   */
  mailboxes?: MailboxProvisioning
  /** SES delivery events over SNS. Unauthenticated; signature-verified. */
  sesWebhooks?: SesWebhookDeps
  /**
   * Direct-route delivery outcomes, pushed by Stalwart. Unauthenticated;
   * signature-verified.
   *
   * ⚠ ITS ABSENCE IS NOT NEUTRAL: a direct-routed message then has no
   * `delivered` and no `bounced`, only `sent`. The route answers 503 rather
   * than accepting unsigned notifications, so the gap is visible in the logs
   * instead of being a customer noticing months later that half their mail
   * never reports.
   */
  stalwartWebhooks?: StalwartWebhookDeps
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
   * The dashboard's own surface, at `/console`.
   *
   * ⚠ SESSION AUTHENTICATED AND DELIBERATELY OUTSIDE THE OPENAPI DOCUMENT. It is
   * the console's private contract, not the product's API — publishing it would
   * put "list my invoices" in every generated SDK, and then it would have to be
   * supported there. Same rule `/billing` and `/webhooks` already follow.
   *
   * ⚠ AND NOTHING UNDER IT ACCEPTS AN API KEY. See routes/console.ts: a sending
   * key's advertised blast radius is "can send mail", and rotating keys or
   * connecting a customer's DNS provider is emphatically not that.
   */
  console?: ConsoleDeps

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
  /**
   * Where a 500 is written down, as opposed to where it is alerted on.
   *
   * ⚠ `reportError` WAS THE ONLY RECORD OF A FAILED REQUEST, AND IT IS THE ONE
   * THAT CAN BE TURNED OFF BY SOMEBODY ELSE. The handler below has said for a
   * long time that "what went wrong is in the log and in Sentry" — and half of
   * that was not true: nothing ever wrote a line. When Sentry stopped
   * accepting events, every 500 in production became invisible. A customer
   * reported "Could not check the records" on a domain whose DNS was perfect,
   * `kubectl logs` showed nothing at all for the request, and the only way to
   * find out what threw was to read the code and guess.
   *
   * ⚠ STDOUT IS THE FLOOR AND IT HAS NO QUOTA. The pod's logs are collected
   * whatever else is broken, which is exactly the property wanted from the
   * last thing that records a failure.
   */
  logError?: (error: unknown, context: Record<string, unknown>) => void
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
    deps.domains ||
    deps.sessionAuth ||
    deps.mailboxes
  ) {
    const auth = deps.apiKeyAuth
    const sendPath = deps.sendPath
    const lookup = deps.emailLookup
    const endpoints = deps.webhookEndpoints
    const domainStore = deps.domains
    const sessions = deps.sessionAuth
    const mailboxStore = deps.mailboxes
    app.use("*", async (c, next) => {
      if (auth) c.set("apiKeyAuth", auth)
      if (sendPath) c.set("sendPath", sendPath)
      if (lookup) c.set("emailLookup", lookup)
      if (endpoints) c.set("webhookEndpoints", endpoints)
      if (domainStore) c.set("domains", domainStore)
      if (sessions) c.set("sessionAuth", sessions)
      if (mailboxStore) c.set("mailboxes", mailboxStore)
      await next()
    })
  }

  /*
   * The API request log the console's Logs page reads.
   *
   * ⚠ IT IS A MIDDLEWARE RATHER THAN A CALL IN EACH ROUTE, BECAUSE THE VALUE OF
   * THIS LOG IS THAT IT IS COMPLETE. Somebody opens it to answer "did my server
   * actually call you, and what did you say" — and a log that covers the routes
   * whoever added it remembered answers that question wrongly in exactly the
   * case it is opened for. A wildcard covers the route somebody adds tomorrow.
   *
   * ⚠ ONLY API-KEY REQUESTS ARE RECORDED, WHICH THE `apiKeyId` GUARD ENFORCES
   * FOR FREE. `requireTenant` deliberately sets an EMPTY key id for a console
   * session (see middleware/tenant.ts), so a person clicking around the
   * dashboard does not fill their own request log with their own page loads —
   * which would bury the one integration call they came here to find. Anything
   * unauthenticated — health probes, inbound webhooks — has no `auth` at all.
   *
   * ⚠ AND IT IS FIRE-AND-FORGET, DELIBERATELY. The insert happens after the
   * response is built, off the request's critical path; awaiting it would let a
   * slow or full log table add latency to sending mail, and a failing one refuse
   * it. A logging failure is reported to the API's own logger so a silently
   * empty page is distinguishable from a genuinely quiet account.
   */
  const requestLog = deps.console?.queries
  const requestLogger = deps.console?.log
  if (requestLog) {
    app.use("*", async (c, next) => {
      const started = Date.now()
      await next()

      // ⚠ TYPED AS PRESENT BECAUSE EVERY AUTHENTICATED ROUTE SETS IT; at this
      // point in the stack the request may not have authenticated at all.
      const auth = c.get("auth") as { tenantId: string; apiKeyId: string } | undefined
      if (!auth?.apiKeyId || !auth.tenantId) return

      const status = c.res.status
      void (async () => {
        await requestLog.recordRequest({
          tenantId: auth.tenantId,
          apiKeyId: auth.apiKeyId,
          // ⚠ THE ROUTE PATTERN, NOT THE URL — the invariant `core.api_requests`
          // states. `/emails/{id}` groups a tenant's calls into rows that can be
          // counted; the concrete path would make every message id its own.
          method: c.req.method,
          path: routePath(c) ?? new URL(c.req.url).pathname,
          status,
          durationMs: Date.now() - started,
          errorName: status >= 400 ? await errorNameOf(c.res) : null,
          userAgent: c.req.header("user-agent") ?? null,
        })
      })().catch((error: unknown) => {
        requestLogger?.warn(
          { err: error, path: routePath(c) },
          "could not record the API request",
        )
      })
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

  // ⚠ SESSION AUTHENTICATED, AND THE ONLY ROUTES THAT ARE. Mailboxes are the
  // human half of i10; an API key must not be able to create one. See
  // middleware/session.ts.
  app.route("/mailboxes", mailboxes)

  // ⚠ API-key authenticated, like everything above it — which is exactly why it
  // cannot issue a tenant's first key. See routes/api-keys.ts.
  app.route("/api-keys", createApiKeyRoutes(deps.apiKeys))

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

  // ⚠ THE SAME EVENTS FOR THE OTHER ROUTE, AND WITHOUT IT A DIRECT-ROUTED
  // MESSAGE STOPS AT `sent`. `core.message_events` was written only by the SES
  // ingest, so a customer watching webhooks saw SES mail progress and their own
  // MTA's mail go silent — the one difference the per-domain route lever is
  // supposed to keep invisible. Both interpreters write through `ingestEvent`,
  // so what a customer receives does not say which MTA carried the message.
  app.route("/webhooks", createStalwartWebhooks(deps.stalwartWebhooks))

  // Polar subscription events, same prefix and the same rule. This is the one
  // that moves money into entitlement, so the signature check is the whole of
  // the authorisation — see routes/polar-events.ts.
  app.route("/webhooks", createPolarWebhooks(deps.polarWebhooks))

  // The dashboard. Mounted unconditionally so an unconfigured deployment
  // answers 501 with a reason rather than 404 — which would read as the console
  // being pointed at the wrong origin.
  app.route("/console", createConsole(deps.console))

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

  // ⚠ REGISTERED EVEN THOUGH NO CUSTOMER CODES AGAINST IT. `/mailboxes` names
  // this scheme, and a document that REFERENCES a security scheme it never
  // DEFINES is invalid OpenAPI — the drift check would still pass, because the
  // generated file matches the code that generated it, while Scalar renders a
  // dangling reference and a generator can emit a client with no way to
  // authenticate. Every name used in a `security:` block has to exist here.
  //
  // ⚠ AND IT IS A COOKIE, NOT A BEARER TOKEN, WHICH IS THE POINT OF IT BEING A
  // SECOND SCHEME RATHER THAN A SECOND USE OF THE FIRST. Mailbox routes take
  // the session a browser already holds from auth.i10.tech; they deliberately
  // do NOT accept an API key, so that a leaked sending key — whose whole
  // advertised blast radius is "can send mail" — cannot also create mailboxes
  // on the customer's domain.
  app.openAPIRegistry.registerComponent("securitySchemes", "sessionAuth", {
    type: "apiKey",
    in: "cookie",
    name: "__session",
    description:
      "The Clerk session cookie set when you sign in at auth.i10.tech. Used " +
      "by the console for mailbox management; it is not an alternative to an " +
      "API key, and the sending endpoints do not accept it.",
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

    /*
     * ⚠ A MALFORMED ID IS A 422, NOT A 500, AND IT IS NOT REPORTED. Ids on the
     * console surface are uuids, and `where id = 'banana'` does not return zero
     * rows — Postgres raises `22P02 invalid_text_representation` before the
     * planner looks at a tuple. Left alone, a typo in the address bar, a stale
     * bookmark or a crawler following a truncated link spends the error budget
     * and opens a Sentry issue for a request that was simply wrong.
     *
     * ⚠ AND IT IS HERE RATHER THAN IN A MIDDLEWARE ON THE CONSOLE ROUTER,
     * BECAUSE HONO'S `compose` CATCHES AT EVERY LEVEL. A `try { await next() }`
     * wrapper never sees a handler's throw: the inner dispatch has its own
     * try/catch and routes the error straight to this function. A sub-app's own
     * `onError` is no better — `app.route()` discards it. This handler is the
     * one place that genuinely runs.
     *
     * ⚠ THE CONDITION IS ONE SQLSTATE, WHICH IS WHAT MAKES IT SAFE. A deadlock,
     * a constraint violation and a dead connection all still fall through to
     * the 500 below and to the reporter — answering "your request was
     * malformed" while the database is on fire would tell a customer their
     * input is wrong and hide the outage from us.
     */
    if (isMalformedValue(error)) {
      return c.json(
        {
          statusCode: 422,
          name: "validation_error" as const,
          message:
            "One of the ids in this request is not a valid identifier. Ids are " +
            "uuids, as returned by the API.",
        },
        422,
      )
    }

    // ⚠ THE ROUTE PATTERN, NOT THE URL. `/emails/{id}` groups every failure of
    // one endpoint into one issue; the concrete path would open a new issue per
    // message id and bury the signal under its own volume.
    const where = { route: routePath(c), method: c.req.method }

    /*
     * ⚠ LOGGED FIRST, AND UNCONDITIONALLY. Reporting is a network call to a
     * third party with a quota; the log line is a write to stdout that cannot
     * be rate limited, rejected or switched off by a billing page. Doing the
     * cheap, reliable one first means a Sentry outage costs us the alert and
     * not the evidence.
     */
    deps.logError?.(error, where)
    deps.reportError?.(error, where)

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

/**
 * The `name` out of this API's error envelope, for the request log.
 *
 * ⚠ READ FROM A CLONE, AND ONLY FOR A BODY THAT IS ALREADY JSON. The response
 * has not been sent yet at this point; reading the real one would consume the
 * stream and the caller would receive nothing. The content-type guard keeps
 * this away from a streamed or binary response, where cloning would buffer
 * whatever the route was streaming.
 *
 * ⚠ AND IT SWALLOWS ITS OWN FAILURES, WHICH IS THE ONE PLACE THAT IS RIGHT.
 * This value is a convenience column on a log row; nothing branches on it, and
 * an unparseable body must not turn into a missing log entry.
 */
async function errorNameOf(response: Response): Promise<string | null> {
  const type = response.headers.get("content-type") ?? ""
  if (!type.includes("application/json")) return null
  try {
    const body = (await response.clone().json()) as { name?: unknown }
    return typeof body.name === "string" ? body.name.slice(0, 100) : null
  } catch {
    return null
  }
}

/**
 * Postgres `22P02 invalid_text_representation`: a literal that cannot be read
 * as its column's type.
 *
 * ⚠ THE CODE, NOT THE MESSAGE. Message text is localised by `lc_messages` and
 * is rewritten between major versions; SQLSTATE is part of the wire protocol
 * and has not changed in twenty years. Matching on "invalid input syntax for
 * type uuid" would work on the development machine and stop working on a server
 * whose locale is not English.
 */
function isMalformedValue(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "22P02"
  )
}
