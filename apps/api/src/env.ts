import { z } from "zod"

/**
 * Validated once at boot, and the process refuses to start without it.
 *
 * A missing variable that only surfaces on the first request is a deploy that
 * looks healthy and is not — the pod passes its readiness probe and then 500s
 * on real traffic. Failing here means the rollout never completes and the old
 * pod keeps serving.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),

  // The Postgres behind PgBouncer.
  //
  // ⚠ TRANSACTION POOLING DROPS `search_path` — PgBouncer accepts the SET and
  // silently ignores it, because a pooled connection is not the same backend
  // twice. Schema-qualify every statement, or use SET LOCAL inside an explicit
  // transaction. Advisory locks must be pg_advisory_xact_lock, never the
  // session variant, for the same reason.
  DATABASE_URL: z.string().min(1),

  // BullMQ's Redis. i10's OWN instance, never one shared with PSL under a
  // prefix — queues are product data, and a shared Redis is exactly the kind
  // of coupling that turns extraction into a rewrite.
  REDIS_URL: z.string().min(1),

  // ⚠ THE REGION IS BAKED INTO EVERY CUSTOMER'S DNS.
  //
  // The bounce MX must point at feedback-smtp.<region>.amazonses.com. SES
  // re-verifies it continuously, and RFC 2181 forbids an MX target that is a
  // CNAME — so it cannot be aliased behind an i10 hostname. Changing region
  // means every customer edits DNS. Chosen once, deliberately: eu-central-1.
  AWS_REGION: z.literal("eu-central-1").default("eu-central-1"),

  // Signs Clerk's webhooks, via Svix. This is an authentication boundary, not
  // a checksum: everything downstream writes to the mailbox projection, so a
  // forged event could create a mailbox on a domain we host or silence one.
  CLERK_WEBHOOK_SECRET: z.string().min(1),

  // Issues and verifies customer API keys. Clerk owns the secret; what a
  // customer holds is that secret rewritten under our own prefix — see
  // src/auth/api-key.ts.
  CLERK_SECRET_KEY: z.string().min(1),

  // ⚠ THIS NUMBER IS HOW LONG A REVOKED KEY KEEPS WORKING. Verification is a
  // network call to Clerk on every send, so it is cached — and the TTL is the
  // whole trade. Longer means less Clerk on the critical path and a longer
  // window where a key someone revoked in a panic still sends mail.
  API_KEY_CACHE_TTL_SECONDS: z.coerce.number().int().positive().max(300).default(60),

  // ⚠ THE DOMAINS i10 ACTUALLY HOSTS MAIL FOR. Only addresses in these domains
  // may enter the projection, because a row there makes Stalwart treat the
  // address as a LOCAL RECIPIENT. Most users sign up with a Gmail or a work
  // address; projecting one would have Stalwart accept and swallow mail
  // addressed to somebody else's domain.
  MAIL_DOMAINS: z
    .string()
    .min(1)
    .transform((v) =>
      v
        .split(",")
        .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
        .filter(Boolean),
    )
    .refine((d) => d.length > 0, "must list at least one domain"),

  // ── the worker ────────────────────────────────────────────────────────────

  /**
   * ⚠ WITHOUT IT SES PUBLISHES NO EVENTS, AND THE SES RECONCILER READS EXACTLY
   * THOSE EVENTS. A missing configuration set does not fail a send; it silently
   * removes half the safety net, so this is required rather than optional.
   */
  SES_CONFIGURATION_SET: z.string().min(1),

  /**
   * Provider calls in flight per worker replica.
   *
   * ⚠ IT IS A QUOTA KNOB AS MUCH AS A THROUGHPUT ONE. SES caps a send RATE in
   * messages per second, and every replica spends from the same account budget,
   * so what SES sees is this multiplied by the replica count. Derive it from the
   * account's rate divided by replicas, not from what one process can manage.
   */
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(100).default(8),

  /**
   * How long a row may sit in `sending` before another worker may take it.
   *
   * ⚠ IT MUST EXCEED groupmq's job timeout, or the two release the same job at
   * different moments and the compare-and-swap stops being the tie-breaker.
   * Postgres interval syntax.
   */
  WORKER_CLAIM_STALE_AFTER: z.string().min(1).default("5 minutes"),

  /** groupmq's lease. Shorter than WORKER_CLAIM_STALE_AFTER, deliberately. */
  WORKER_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  // ── metering ──────────────────────────────────────────────────────────────

  /**
   * Autumn, which owns balances, entitlements and usage.
   *
   * ⚠ SELF-HOSTED, SO THE BASE URL IS CONFIGURATION RATHER THAN A CONSTANT. The
   * default is the SaaS, which is what a local checkout and the test
   * environment talk to; production points at our own instance.
   */
  AUTUMN_URL: z.url().default("https://api.useautumn.com"),

  /**
   * ⚠ OPTIONAL, AND ITS ABSENCE IS A DELIBERATE, VISIBLE STATE. Without it the
   * services run `unmetered` — every send allowed, nothing counted — which is
   * the correct behaviour for a local checkout and a loud one in the boot log.
   * Making it required would mean no one can run the API without a billing
   * account; making it silently default to metering would mean a misconfigured
   * production looks identical to a working one.
   */
  AUTUMN_SECRET_KEY: z.string().min(1).optional(),

  /** The metered feature. One email is one unit of it. */
  AUTUMN_FEATURE_ID: z.string().min(1).default("emails"),

  /**
   * The plan a new tenant is auto-enabled onto.
   *
   * ⚠ IT MUST MATCH A PLAN IN infra/autumn/autumn.config.ts. A tenant enabled
   * onto a plan id Autumn does not have is a customer with no entitlement —
   * `check` refuses, our client reads that as unavailable, and the tenant sends
   * unmetered forever with nothing in the logs to say why.
   */
  AUTUMN_FREE_PLAN_ID: z.string().min(1).default("free"),

  /**
   * ⚠ THIS IS ADDED TO THE LATENCY OF EVERY `POST /emails` WHEN AUTUMN IS SLOW,
   * because the quota check is synchronous. Short on purpose: a timeout is
   * `unavailable`, and `unavailable` sends — so the cost of being impatient is
   * a little unbilled usage, and the cost of being patient is every customer's
   * password reset waiting on a billing service.
   */
  AUTUMN_TIMEOUT_MS: z.coerce.number().int().positive().max(10_000).default(2000),

  // ── webhooks ──────────────────────────────────────────────────────────────

  /**
   * Encrypts customers' webhook signing secrets at rest. 32 bytes, hex or
   * base64 — `openssl rand -hex 32`.
   *
   * ⚠ OPTIONAL, AND ITS ABSENCE DISABLES WEBHOOKS RATHER THAN WEAKENING THEM.
   * Without a key the endpoint routes answer 501 and no delivery is attempted,
   * which is a visible missing feature. The alternative — falling back to
   * storing secrets in plaintext — would be a silent downgrade of the one thing
   * that makes a webhook trustworthy.
   *
   * ⚠ AND LOSING IT IS NOT RECOVERABLE. Every stored secret becomes
   * undecryptable, so every customer has to rotate. It belongs in Doppler with
   * the same care as CLERK_SECRET_KEY.
   */
  WEBHOOK_SECRET_KEY: z.string().min(32).optional(),

  /**
   * How many delivery attempts a webhook gets before the row is marked failed.
   * The backoff is exponential and capped at eight minutes, so five attempts
   * span roughly a quarter of an hour — enough for a deploy or a restart.
   */
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().max(20).default(5),

  /** Provider webhook deliveries in flight per worker replica. */
  WEBHOOK_CONCURRENCY: z.coerce.number().int().positive().max(100).default(8),

  /**
   * ⚠ GUARDS THE QUEUE-DEPTH ENDPOINT THE AUTOSCALER READS. Queue depth is not
   * secret in a damaging way, but an unauthenticated endpoint that touches
   * Redis on every request is a free amplifier — and KEDA can send a bearer
   * token, so there is no reason to leave it open.
   */
  METRICS_TOKEN: z.string().min(16).optional(),

  // ⚠ THE NAME ON THE CERTIFICATE AND IN THE SMTP GREETING, not a hostname we
  // are free to pick per environment. It is `SystemSettings.defaultHostname` in
  // Stalwart, the target of every SRV record in the zone, and the subject a
  // client checks the TLS certificate against. Changing it here alone would
  // hand out configuration profiles pointing at a name that fails verification.
  MAIL_HOSTNAME: z.string().min(1).default("mail.i10.tech"),

  // ── billing ───────────────────────────────────────────────────────────────
  //
  // Polar takes the money; Autumn holds the entitlement. The two never speak —
  // see send/autumn.ts on `no_billing_changes` for why that separation is the
  // design rather than a limitation.

  /**
   * ⚠ WHICH POLAR, AND IT IS A DIFFERENT DATABASE RATHER THAN A DIFFERENT MODE.
   * Sandbox has its own tokens, its own webhook secrets and its own product
   * ids; nothing crosses. Defaulting to `sandbox` means the mistake this can
   * make is "a real customer's checkout did not charge them", which is
   * recoverable and loud — rather than "test traffic took real money".
   */
  POLAR_SERVER: z.enum(["sandbox", "production"]).default("sandbox"),

  /**
   * An organization access token, `polar_oat_…`.
   *
   * ⚠ OPTIONAL, AND ITS ABSENCE DISABLES CHECKOUT RATHER THAN FAKING IT. The
   * billing routes answer 501, which is a visible missing feature; the webhook
   * receiver does not need it at all, because verifying and applying an event
   * uses only the signing secret.
   */
  POLAR_ACCESS_TOKEN: z.string().min(1).optional(),

  /**
   * The endpoint secret from Polar's dashboard, `whsec_…`.
   *
   * ⚠ THIS IS THE ONLY THING GUARDING THE PLAN-GRANTING ENDPOINT. Polar has no
   * API key of ours to present, so the signature is the whole of the access
   * control — without this the receiver answers 503 and grants nothing, which
   * is the correct way to be misconfigured.
   */
  POLAR_WEBHOOK_SECRET: z.string().min(1).optional(),

  /**
   * Our plan ids mapped to Polar product ids, as JSON: `{"pro":"<uuid>"}`.
   *
   * ⚠ CONFIGURATION RATHER THAN CODE BECAUSE THE IDS DIFFER PER ENVIRONMENT.
   * The sandbox product and the production product are different objects with
   * different ids, and a constant in the source would mean the sandbox grants
   * nothing (an unrecognised product is ignored) while looking fine.
   *
   * ⚠ AND IT IS THE ALLOWLIST. `POST /billing/checkout` takes a plan name and
   * looks the product up here; a caller cannot name a product id of their own,
   * which would otherwise let anyone buy Pro at whatever price they chose.
   */
  POLAR_PRODUCTS: z
    .string()
    .default("{}")
    .transform((raw, ctx) => {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new TypeError("not an object")
        }
        const out: Record<string, string> = {}
        for (const [plan, product] of Object.entries(parsed)) {
          if (typeof product !== "string" || product.length === 0) {
            throw new TypeError(`product id for "${plan}" is not a string`)
          }
          out[plan] = product
        }
        return out
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: `must be a JSON object of plan id to Polar product id (${
            error instanceof Error ? error.message : String(error)
          })`,
        })
        return z.NEVER
      }
    }),

  /**
   * Where Polar returns the browser after payment.
   *
   * ⚠ A PAGE THAT POLLS, NOT A PAGE THAT GRANTS. Anybody can navigate here —
   * it is a plain redirect with no proof attached — so whatever is served must
   * ask our own API what plan the tenant holds and wait. See routes/billing.ts.
   */
  POLAR_SUCCESS_URL: z.url().optional(),

  /** Bounds the checkout call, which sits in front of a waiting customer. */
  POLAR_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(5000),

  // ── observability ─────────────────────────────────────────────────────────

  /**
   * Where errors and cron check-ins go.
   *
   * ⚠ OPTIONAL, AND ITS ABSENCE IS A VISIBLE STATE RATHER THAN A QUIET ONE —
   * the same rule as AUTUMN_SECRET_KEY. Without it the services run and report
   * nothing, and say so in a line of the boot log you can grep for. Making it
   * required would mean nobody can run the API without a Sentry account;
   * letting it fail silently would mean a production that lost its DSN looks
   * exactly like one that has it, which is the failure mode this whole piece
   * exists to remove.
   *
   * ⚠ A DSN IS NOT A SECRET IN THE WAY THE OTHER KEYS HERE ARE. It authorises
   * sending events, not reading them, and the browser SDKs publish it. It still
   * belongs in Doppler, because someone who has it can fill the quota.
   */
  SENTRY_DSN: z.url().optional(),

  /**
   * Which deployment an issue came from.
   *
   * ⚠ IT MUST DISTINGUISH STAGING FROM PRODUCTION, because the promotion model
   * re-tags one image for both. Everything else about the two is identical by
   * design, so this string is the only thing in an event that says which one
   * broke.
   */
  SENTRY_ENVIRONMENT: z.string().min(1).default("development"),
})

export type Env = z.infer<typeof schema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n")
    throw new Error(`Invalid environment:\n${detail}`)
  }
  return parsed.data
}
