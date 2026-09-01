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
