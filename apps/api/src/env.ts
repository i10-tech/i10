import { z } from "zod"

/**
 * Validated once at boot, and the process refuses to start without it.
 *
 * A missing variable that only surfaces on the first request is a deploy that
 * looks healthy and is not — the pod passes its readiness probe and then 500s
 * on real traffic. Failing here means the rollout never completes and the old
 * pod keeps serving.
 */
/**
 * Reads the SES kill switch out of its environment variable.
 *
 * ⚠ EXTRACTED SO IT CAN BE TESTED, AND IT NEEDED TO BE. Inline in the schema it
 * was `raw !== "false"` — so `SES_ENABLED=0`, which is what somebody actually
 * types at two in the morning, silently meant ENABLED. Every paid domain kept
 * routing into the outage the switch was thrown to escape, with no log line and
 * a variable that read as set in the config UI.
 *
 * ⚠ AN UNINTERPRETABLE VALUE THROWS RATHER THAN PICKING A SIDE. Defaulting
 * either way is a guess about intent at the exact moment intent matters most;
 * refusing to boot is loud, immediate, and cannot be misread.
 *
 * ⚠ AND ABSENT STILL MEANS ENABLED. The failure mode of defaulting off is every
 * paying customer's mail silently moving to our own IP the first time this is
 * missing from a config — a deliverability change nobody asked for, caused by a
 * typo in a secret name.
 */
export function parseSesEnabled(value: string | undefined): boolean {
  const raw = (value ?? "true").trim().toLowerCase()
  if (["true", "1", "yes", "on"].includes(raw)) return true
  if (["false", "0", "no", "off"].includes(raw)) return false
  throw new Error(
    `SES_ENABLED must be true/false (also 1/0, yes/no, on/off), got "${value}"`,
  )
}

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

  // The queues' Redis. i10's OWN instance, never one shared with PSL under a
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

  /**
   * Who i10's own authentication mail comes from, e.g. `i10 <no-reply@i10.tech>`.
   *
   * ⚠ UNSET MEANS CLERK KEEPS SENDING, WHICH IS THE SAFE DEFAULT RATHER THAN A
   * DEGRADED ONE. Clerk's per-template "Delivered by Clerk" switch is still on
   * until somebody turns it off, so an unconfigured deployment simply does not
   * take over — it must never be the case that we stop Clerk sending and then
   * fail to send ourselves, because that is a sign-up nobody can complete.
   */
  AUTH_EMAIL_FROM: z.string().min(1).optional(),

  /**
   * The tenant i10's own mail is attributed to.
   *
   * ⚠ A SLUG, NOT AN ID, AND RESOLVED AT BOOT. The tenant's uuid is generated
   * per deployment; migration 0029 makes the same point when it attributes
   * i10.tech by slug. A literal uuid copied between environments would send
   * nothing anywhere but the one it came from.
   */
  AUTH_EMAIL_TENANT_SLUG: z.string().min(1).default("i10"),

  // Issues and verifies customer API keys. Clerk owns the secret; what a
  // customer holds is that secret rewritten under our own prefix — see
  // src/auth/api-key.ts.
  CLERK_SECRET_KEY: z.string().min(1),

  /**
   * Clerk's publishable key, which `authenticateRequest` requires.
   *
   * ⚠ WITHOUT IT EVERY SESSION-AUTHENTICATED ROUTE ANSWERS 503, AND THAT IS NOT
   * OBVIOUS FROM ANYTHING. `@clerk/backend` needs the publishable key to know
   * which instance a token belongs to, and `authenticateRequest` THROWS
   * "Publishable key is missing" rather than returning a signed-out state. The
   * verifier catches that and reports `unavailable`, so `/console/*` and
   * `/mailboxes` answer "Could not verify your session right now. Retry
   * shortly." — a message that is correct for a Clerk outage and actively
   * misleading here, because waiting never helps. This took the console down in
   * production for exactly that reason.
   *
   * ⚠ IT IS NOT A SECRET, DESPITE SITTING BESIDE ONE. A publishable key is
   * published — it ships to every browser that loads the sign-in page. It is
   * here because Clerk's server SDK needs it, not because it needs protecting.
   *
   * ⚠ AND IT IS OPTIONAL IN THE SCHEMA WHILE `CLERK_SECRET_KEY` IS REQUIRED,
   * which is deliberate rather than an oversight. Making it required would stop
   * the API booting — and this process also carries `/emails`, the send path,
   * which has nothing to do with Clerk and would be taken down by a console
   * variable. Instead its absence is reported loudly at startup (see index.ts)
   * and on every failed verification. Once it is set everywhere, tightening
   * this to `.min(1)` is the better end state.
   */
  CLERK_PUBLISHABLE_KEY: z.string().optional(),

  /**
   * Origins allowed to present a Clerk session to `/mailboxes`.
   *
   * ⚠ THIS IS THE `azp` CHECK, AND LEAVING IT EMPTY DISABLES IT. One Clerk
   * instance can back several applications; without this, a token minted for
   * any of them is accepted here. It lists the origins that HOLD the session —
   * the dashboard — not the one that issues it, because `azp` records who asked
   * for the token rather than where the person typed their password.
   */
  CONSOLE_ORIGINS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ),

  /**
   * How long a verified key stays cached. One hour.
   *
   * ⚠ THE COMMENT HERE USED TO SAY THIS WAS HOW LONG A REVOKED KEY KEEPS
   * WORKING, AND THAT STOPPED BEING TRUE TWICE OVER. It was written when
   * verification was a network call to Clerk on every send, so the TTL traded
   * third-party latency against revocation lag. Migration 0031 moved keys into
   * `core.api_keys`, and `index.ts` now passes `keyLookup(db)` — an indexed
   * lookup on our own table. There is no longer a Clerk round trip to save.
   *
   * ⚠ AND REVOCATION DOES NOT WAIT FOR THIS TO EXPIRE. `routes/api-keys.ts`
   * deletes the cache entry on both revoke and rotate, keyed on the same secret
   * hash the verifier caches under — so a key revoked through the API stops
   * working at once, whatever this says. The TTL is the window only for a key
   * revoked OUT OF BAND: a direct UPDATE against the table, or a restore that
   * rolls one back.
   *
   * ⚠ THE CEILING WAS 300 AND SILENTLY REFUSED ANYTHING LARGER. A deployment
   * that set fifteen minutes did not get fifteen minutes — it failed schema
   * validation at boot, which is loud, but only if somebody read the log.
   */
  API_KEY_CACHE_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(3600),

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
   * The operator kill switch. `false` routes every send through our own MTA.
   *
   * ⚠ IT IS A SWITCH A PERSON THROWS, AND THERE IS DELIBERATELY NO HEALTH PROBE
   * BEHIND IT. `Transport` already handles SES being slow or throttling — those
   * come back `deferred` and the message waits. This is for the case that
   * outlasts a queue: SES down for long enough that waiting stops being the
   * right answer. See `resolveRoute`, which is where it is read.
   *
   * ⚠ DEFAULTS TO ENABLED, AND IT HAS TO. The failure mode of defaulting off is
   * every paying customer's mail silently moving to our own IP the first time
   * this variable is missing from a config — a deliverability change nobody
   * asked for, caused by a typo in a secret name.
   */
  /**
   * Whether the orphan sweep may actually delete what it finds.
   *
   * ⚠ IT DEFAULTS OFF, AND THAT IS NOT TIMIDITY. Every other sweep in this
   * codebase writes idempotent status updates; that one issues irreversible
   * deletes against a live mail account and a live nameserver. Its first run on
   * any deployment is simultaneously the one with the most accumulated orphans
   * and the one with the least evidence that its two ownership tests are
   * calibrated for that account. So it reports what it would remove, somebody
   * reads the log, and then this is turned on.
   *
   * ⚠ AND IT IS READ ONLY BY THAT JOB. Nothing on a request path consults it.
   */
  DOMAIN_ORPHANS_REMOVE: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1" || v === "yes" || v === "on"),

  SES_ENABLED: z
    .string()
    .optional()
    .transform((v, ctx) => {
      try {
        return parseSesEnabled(v)
      } catch (err) {
        ctx.addIssue({ code: "custom", message: (err as Error).message })
        return z.NEVER
      }
    }),

  /**
   * Whether SES's SMTP endpoint is configured as a relay for MAILBOX mail.
   *
   * ⚠ A SECOND SWITCH, AND NOT A DUPLICATE OF `SES_ENABLED`. The transactional
   * route calls the SES **API**; mailbox mail can only use SES **SMTP**, because
   * Stalwart's outbound has no HTTP hook and taking messages out of its queue
   * would mean rebuilding queueing, retries and DSN generation it already does
   * properly. Those are different credentials that can exist independently, so
   * one flag cannot honestly govern both.
   *
   * ⚠ IT DEFAULTS OFF, WHICH IS THE OPPOSITE OF `SES_ENABLED` AND DELIBERATE.
   * That one defaults on because defaulting off would silently move every paying
   * customer onto our own IP. This one defaults off because defaulting on would
   * point human mail at an SMTP relay that may have no credentials behind it —
   * and the first symptom would be our own mail queueing. Off until somebody
   * creates the credentials and means it.
   *
   * ⚠ IT IS READ AT BOOT AND PUBLISHED TO `core.routing_settings`, not read on
   * the send path. Stalwart decides this route inside Postgres; see
   * domains/routing-settings.ts.
   */
  SES_RELAY_ENABLED: z
    .string()
    .optional()
    .transform((v, ctx) => {
      try {
        // ⚠ THE SAME PARSER, SO `0`, `no` AND `off` MEAN THE SAME THING IN BOTH.
        // Two hand-rolled boolean readers is two chances for `SES_ENABLED=0` to
        // mean disabled in one place and enabled in the other — which is exactly
        // the bug `parseSesEnabled` was written to fix.
        return v === undefined ? false : parseSesEnabled(v)
      } catch (err) {
        ctx.addIssue({ code: "custom", message: (err as Error).message })
        return z.NEVER
      }
    }),

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
   * How many BATCHES one worker replica holds at once. Not the same number as
   * `WORKER_CONCURRENCY`, which is the fan-out inside a single batch.
   *
   * ⚠ ONE IS groupmq's DEFAULT AND IT IS THE WRONG DEFAULT FOR US. Per-group
   * serialisation is deliberate — a tenant never has two batches in flight —
   * but one batch at a time across ALL groups means one tenant's batch blocks
   * every other tenant's, which is precisely the head-of-line blocking the
   * transactional/bulk split was built to prevent, arriving one level down.
   *
   * ⚠ AND IT MULTIPLIES WITH EVERYTHING ELSE AGAINST THE SES RATE. What SES
   * sees is `replicas × WORKER_BATCH_CONCURRENCY × WORKER_CONCURRENCY` calls in
   * flight — at the defaults that is 1 × 8, and doubling this doubles it.
   *
   * ⚠ SO THE DEFAULT IS STILL 1 WHILE THE SES ACCOUNT IS IN THE SANDBOX, for
   * exactly the reason `maxReplicaCount` is 1 in worker-autoscale.yaml: at a
   * 1/s account rate the extra calls come back 429, the transport defers them,
   * and the queue drains SLOWER with nothing logging an error. What changed is
   * that the number now exists, is named, and is raised deliberately — before
   * this it was groupmq's undocumented default and the blocking it caused was
   * invisible. Raise it in the same change that raises the SES quota.
   */
  WORKER_BATCH_CONCURRENCY: z.coerce.number().int().positive().max(50).default(1),

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

  /**
   * How many times groupmq may re-run a send JOB before dead-lettering it.
   *
   * ⚠ THIS IS NOT THE MESSAGE'S RETRY BUDGET, AND CONFLATING THE TWO IS HOW
   * MAIL GETS SENT TWICE. A message that failed is already back in `queued`
   * with its attempt counted, and the row is the record. This governs only the
   * case where the HANDLER ITSELF threw, which is our bug rather than a
   * provider being slow.
   *
   * ⚠ AND IT MUST BE SET ON BOTH SIDES, WHICH IS WHY IT IS ONE VARIABLE.
   * groupmq stamps the enqueuing side's value on the job and `retry.lua`
   * enforces it as a ceiling; the Worker's own value is what actually
   * dead-letters, in `handleJobFailure`. Configured apart, the API and the
   * worker each looked right and the effective budget was whichever was
   * smaller — a number nothing in the code stated.
   */
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().max(20).default(3),

  // ── the stale-message sweep ───────────────────────────────────────────────

  /**
   * How long a row may sit `queued` before the sweep decides no job points at
   * it. Postgres interval syntax.
   *
   * ⚠ IT IS AN UPPER BOUND ON HOW LATE A DEFERRED MESSAGE IS, NOT A TUNING
   * KNOB. A message SES throttled goes back to `queued` with nothing pointing
   * at it, and this plus the CronJob's interval is the whole of the delay
   * before it is tried again. Too short and the sweep re-enqueues rows a worker
   * is about to take anyway — harmless, because the claim refuses them, but it
   * spends the pass's budget on work that was never lost.
   */
  SWEEP_QUEUED_GRACE: z.string().min(1).default("5 minutes"),

  /**
   * The most rows one pass will take.
   *
   * ⚠ HITTING IT IS A SIGNAL, NOT A LIMIT TO RAISE. The sweep reports reaching
   * this to Sentry, because a backlog bigger than one pass means messages are
   * being stranded faster than they are being rescued — which is a problem
   * upstream of the sweep and is not fixed by sweeping harder.
   */
  SWEEP_MAX_ROWS: z.coerce.number().int().positive().max(10_000).default(1_000),

  /**
   * How far back the send-side reconcilers look, in days.
   *
   * ⚠ A WINDOW RATHER THAN A HIGH-WATER MARK, DELIBERATELY. Both legs are
   * idempotent — the SES repair refuses a row already `sent`, and `track` is
   * keyed on the message id — so overlapping windows cost a repeated
   * read and nothing else. A stored cursor would have to survive a restore, and
   * would silently skip whatever it was wrong about.
   *
   * ⚠ AND IT MUST COMFORTABLY EXCEED THE RUN INTERVAL, or a discrepancy that
   * appears just before a run is examined once and then falls out of the window
   * forever.
   */
  RECONCILE_LOOKBACK_DAYS: z.coerce.number().int().positive().max(30).default(2),

  // ── metering ──────────────────────────────────────────────────────────────

  /**
  /**
   * The metered feature every email is one unit of.
   *
   * ⚠ IT IS A ROW IN `core.plans`' entitlements, AND RENAMING IT DOES NOT FAIL.
   * A feature id no plan grants resolves to `unentitled`, which fails open — so
   * every send goes, unmetered and unbilled, with only a log line to say so.
   * The same warning was true of Autumn's catalogue and is the reason
   * `unentitled` is a separate outcome rather than folded into `exceeded`.
   */
  METERING_FEATURE_ID: z.string().min(1).default("emails"),

  /**
   * The plan a brand-new tenant lands on.
   *
   * ⚠ IT MUST EXIST IN `core.plans`, WHICH IS WHY MIGRATION 0012 SEEDS IT
   * RATHER THAN LEAVING IT TO A JOB. A tenant assigned a plan id that is not
   * there has no entitlement at all — and unlike a missing catalogue in a
   * remote service, this one is a foreign key, so the assignment fails loudly
   * instead of leaving a customer silently unmetered.
   */
  METERING_FREE_PLAN_ID: z.string().min(1).default("free"),

  /**
   * The event name usage is ingested under, and what Polar's meter filters on.
   *
   * ⚠ IF THIS AND THE METER DISAGREE, THE METER AGGREGATES NOTHING — and every
   * ingest still answers 200, because the events are stored either way. The
   * symptom is an invoice with no usage on it, a month later, which is the
   * worst possible time to find out. It defaults to the feature id so the two
   * only differ if somebody makes them.
   */
  METERING_EVENT_NAME: z.string().min(1).default("emails"),

  /**
   * The domain whose SPF record lists i10's own outbound MTAs.
   *
   * ⚠ CUSTOMERS PUBLISH `include:` THIS, NEVER OUR IP ADDRESSES. A literal
   * address in a customer's DNS pins our infrastructure into records we cannot
   * edit: changing a relay, adding a second, or moving provider would mean
   * asking every customer to re-publish, and the ones who did not would start
   * failing SPF with nothing to tell them why.
   *
   * ⚠ AND IT IS A DEDICATED SUBDOMAIN RATHER THAN THE APEX. SPF allows ten DNS
   * lookups per evaluation, and the apex record has its own job — who may send
   * as i10.tech. Conflating them means every customer's SPF inherits every
   * include we add for our own mail.
   */
  MAIL_SPF_INCLUDE: z.string().min(1).default("_spf.i10.tech"),

  /**
   * The host that receives bounces for mail we deliver ourselves.
   *
   * ⚠ IT IS THE MX FOR EVERY CUSTOMER'S `bounce.<domain>`, WHICH IS WHY DMARC
   * PASSES ON SPF FOR THE DIRECT ROUTE. Bouncing to a name on i10.tech instead
   * would need no customer record and would leave SPF unaligned with their
   * `From:` — DMARC would then be passing on DKIM alone.
   *
   * ⚠ IT MUST NAME AN UNPROXIED HOST, AND THE DEFAULT USED TO NOT. This was
   * `mx.i10.tech`, which resolves to Cloudflare's anycast proxy
   * (172.67.x, 104.21.x) rather than to the machine — and the proxy does not
   * carry SMTP, so every bounce for a direct-routed message would have been
   * delivered nowhere. `mail.i10.tech` is deliberately unproxied for exactly
   * this reason; `infra/tofu/stacks/dns/main.tf` warns about the same trap for
   * the apex, where `a:i10.tech` would authorise Cloudflare's range to send as
   * every customer.
   *
   * ⚠ AND RFC 2181 FORBIDS AN MX TARGET THAT IS A CNAME. Whatever this names
   * has to be an address record on a host that answers on port 25.
   */
  MAIL_BOUNCE_HOST: z.string().min(1).default("mail.i10.tech"),

  /**
   * i10's authoritative nameservers, for customers who delegate subdomains.
   *
   * ⚠ A DELEGATED DOMAIN'S MAIL DNS DEPENDS ENTIRELY ON THESE ANSWERING. A
   * customer publishing records in their own provider keeps resolving whatever
   * happens to us; a delegating one stops resolving at all. Two names are
   * listed because resolvers expect more than one and will retry the second —
   * but pointing both at one machine buys the appearance of redundancy and not
   * the fact of it, which is the reason to move this to Cloudflare or Route 53
   * rather than a reason it is fine.
   */
  /**
   * Stalwart's API, for sampling how much disk each tenant's mailboxes use.
   *
   * ⚠ THE IN-CLUSTER SERVICE, NOT `https://mail.i10.tech`. The management API
   * is deliberately not routed publicly — `infra/k8s/i10/stalwart/ingressroute.yaml`
   * sends only autoconfig, autodiscover and MTA-STS to the pod, and the network
   * policy's own comment says 8080 is left out "because the management API
   * belongs behind Traefik". Every management path answers 404 from outside.
   * `i10-prod` is an allowed source namespace, so the reconcile job reaches it
   * at `http://i10-stalwart:8080`.
   *
   * ⚠ OPTIONAL, AND ITS ABSENCE SKIPS THE SAMPLE RATHER THAN ZEROING IT. A
   * deployment that cannot ask the mail server must leave the last figure
   * standing: replacing it with 0 would hand every tenant their whole storage
   * allowance back, silently, and in the direction nobody reports.
   */
  STALWART_URL: z.url().optional(),
  STALWART_API_TOKEN: z.string().min(1).optional(),

  /**
   * The HMAC key on Stalwart's `WebHook` object, and the only thing standing
   * between a public endpoint and a stranger's suppression list.
   *
   * ⚠ WITHOUT IT THE DIRECT ROUTE HAS NO DELIVERY EVENTS AT ALL — a
   * direct-routed message stops at `sent` and never reaches `delivered` or
   * `bounced`. `/webhooks/stalwart` answers 503 rather than accepting unsigned
   * notifications, which is the same refusal the direct transport makes when
   * its own credentials are missing: visible, and not a quiet downgrade.
   *
   * ⚠ NOT BASE64-DECODED BEFORE IT KEYS THE HMAC, unlike every other secret in
   * this file. Stalwart signs with the configured string's own bytes; see
   * `webhooks/stalwart.ts` for why reusing `decodeSecret` here rejects every
   * genuine notification.
   */
  STALWART_WEBHOOK_SECRET: z.string().min(1).optional(),

  /**
   * Stalwart's SMTP submission endpoint, for the direct route.
   *
   * ⚠ SUBMISSION, NOT PORT 25, AND NOT THE SAME THING AS `STALWART_URL`. That
   * one is the management API, used to sample mailbox storage. This is where a
   * finished message is handed over for queueing and delivery.
   *
   * ⚠ ALL THREE ARE OPTIONAL SO THE WORKER STARTS WITHOUT THEM, AND THE DIRECT
   * TRANSPORT REFUSES TO SEND WHEN THEY ARE ABSENT. The alternative — requiring
   * them — makes every deployment that only ever uses SES fail to boot over a
   * route it does not take. The refusal is `deferred`, so the mail waits in the
   * queue rather than being lost, and the backlog is the alarm.
   */
  STALWART_SUBMISSION_HOST: z.string().min(1).optional(),
  /**
   * ⚠ 465, NOT 587, AND THE DEFAULT USED TO BE WRONG. There is no 587 listener
   * on our Stalwart — `NetworkListener` has `smtp` on 25 and `submissions` on
   * 465, and nothing else speaks SMTP. A worker pointed at 587 got no
   * connection at all, which surfaces as `deferred` on every direct send with
   * an ECONNREFUSED nobody reads.
   *
   * ⚠ AND THERE IS NO REASON TO ADD ONE. 465 is implicit TLS from the first
   * byte; 587 is cleartext until STARTTLS succeeds. RFC 8314 §3 prefers the
   * former for exactly that reason — there is no plaintext phase to strip.
   * `submissionConfig` reads this number and picks the TLS mode from it, so the
   * port is the only thing that has to be right.
   */
  STALWART_SUBMISSION_PORT: z.coerce.number().int().positive().default(465),
  STALWART_SUBMISSION_USER: z.string().min(1).optional(),
  STALWART_SUBMISSION_PASSWORD: z.string().min(1).optional(),

  MAIL_NAMESERVERS: z
    .string()
    .default("ns1.i10.tech,ns2.i10.tech")
    .transform((raw) =>
      raw
        .split(",")
        .map((ns) => ns.trim().toLowerCase().replace(/\.$/, ""))
        .filter((ns) => ns.length > 0),
    )
    .refine((list) => list.length > 0, "at least one nameserver is required"),

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
  // Polar takes the money; `core.plan_assignments` holds the entitlement. The
  // two never speak: the webhook is the only thing carrying state between them,
  // which is why billing/reconcile.ts exists to notice a lost one.
  //
  // ⚠ THE ENTITLEMENT USED TO LIVE IN AUTUMN, AND THE SEPARATION IS OLDER THAN
  // THE SWAP. Autumn attached plans with `no_billing_changes` for exactly this
  // reason — one system decides who paid, another decides what they may do —
  // and moving the second half in-house changed the owner, not the shape.

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

  // ── customers' own DNS providers ──────────────────────────────────────────

  /**
   * The OAuth applications we have registered with DNS providers.
   *
   * ⚠ ONE VARIABLE PER FIELD, DISCOVERED BY PREFIX RATHER THAN DECLARED. This
   * was a single JSON object, and the argument for that was sound as far as it
   * went: eight providers is sixteen variables, and declaring each one here to
   * be plumbed through and remembered is sixteen chances to miss one.
   * DISCOVERY removes that objection entirely — nothing is declared, so nothing
   * can be forgotten — and leaves only the reason the JSON had to go.
   *
   * ⚠ WHICH IS THAT A MALFORMED BLOB REFUSED TO BOOT THE API. `loadEnv` throws
   * on an invalid value and the process exits, so one trailing comma typed into
   * Doppler while adding the second provider stopped SENDING — the API, the
   * console's entire backend, the cron jobs that mount the same secret — for a
   * convenience feature nobody had finished configuring. Measured rather than
   * theorised: a stray `,` produces `Invalid environment` and a crashloop.
   *
   * ⚠ SO THE BLAST RADIUS IS NOW ONE PROVIDER. A key missing its pair is that
   * provider skipped and named in the boot log; every other provider, and the
   * rest of the API, is untouched. That is precisely the failure the old
   * comment described — "a Connect button that does nothing for one provider
   * while working for seven" — and accepted as the cost of the JSON, when it
   * was in fact the better outcome of the two.
   *
   *   DNS_OAUTH_CLOUDFLARE_CLIENT_ID      = …
   *   DNS_OAUTH_CLOUDFLARE_CLIENT_SECRET  = …  (omit for a PKCE-only client)
   *   DNS_OAUTH_CLOUDFLARE_SCOPES         = …  (optional; overrides the registry)
   *
   * The provider is the registry slug upper-cased with `-` as `_`, so
   * `google-cloud-dns` is `DNS_OAUTH_GOOGLE_CLOUD_DNS_CLIENT_ID`.
   *
   * ⚠ ITS ABSENCE DISABLES THE ONE-CLICK PATH AND NOTHING ELSE. A provider with
   * no app here simply has no OAuth option; the pasted-token path still works,
   * which is the only path several providers have at all. The console asks the
   * API what is connectable rather than assuming, so an unregistered app
   * presents as "paste a token" and not as a broken button.
   *
   * ⚠ AND THE SECRETS ARE REAL SECRETS. A client secret for a DNS provider's
   * OAuth app, combined with a stolen authorisation code, is a route to writing
   * in a customer's zone. Doppler, never the manifest.
   */
  DNS_OAUTH_APPS: z
    .record(
      z.string(),
      z.object({
        clientId: z.string().min(1),
        clientSecret: z.string().min(1).optional(),
        scopes: z.array(z.string().min(1)).min(1).optional(),
      }),
    )
    .default({}),

  /**
   * Providers whose variables were present but unusable, for the boot log.
   *
   * ⚠ SKIPPED IS NOT SILENT. A client id with no secret beside it is somebody
   * half-way through configuring a provider, and the symptom — one Connect
   * button that quietly does nothing — is invisible until a customer presses
   * it. Not worth refusing to boot over; absolutely worth a line at startup.
   */
  DNS_OAUTH_IGNORED: z.array(z.string()).default([]),

  /**
   * Where a DNS provider sends the browser back after authorisation.
   *
   * ⚠ ONE URL FOR EVERY PROVIDER, WITH THE SLUG APPENDED AS A PATH SEGMENT.
   * Providers compare the redirect URI against a registered value EXACTLY, so
   * building it from a request header would produce a URI that works on one
   * hostname and is rejected on another — which, in a product with a console on
   * `dash.` and local development on `localhost`, means it is rejected in
   * exactly one of the two and nobody can tell which is wrong.
   *
   * ⚠ IT MUST MATCH WHAT IS REGISTERED WITH EACH PROVIDER, CHARACTER FOR
   * CHARACTER, INCLUDING THE ABSENCE OF A TRAILING SLASH.
   */
  DNS_OAUTH_REDIRECT_BASE: z.url().default("https://dash.i10.tech/dns/callback"),

  /**
   * A Worker that performs the token exchange Cloudflare will not let us make.
   *
   * ⚠ THIS IS NOT A PROXY FOR CONVENIENCE; IT IS FOR ONE MEASURED REFUSAL.
   * `dash.cloudflare.com` is a DASHBOARD host with bot management on, and from
   * psl-vps it answers a managed challenge — `403`, `cf-mitigated: challenge` —
   * to every client we can build: curl and Bun, HTTP/1.1 and h2, IPv4 and IPv6.
   * The identical request from a residential line gets ordinary OAuth JSON.
   * It is a decision about our ADDRESS, so no header, client or HTTP version
   * changes it, and the user-agent work that preceded this could not have.
   *
   * ⚠ ONLY THE TOKEN EXCHANGE, AND ONLY CLOUDFLARE'S. `api.cloudflare.com` —
   * every zone read and record write the publish path makes — has never been
   * challenged from the cluster, and no other provider's token endpoint is
   * either. The host list lives in `dns/oauth.ts`; see `BROKERED_HOSTS`.
   *
   * ⚠ BOTH OR NEITHER. A URL with no secret would call an authenticated Worker
   * with no credential and fail every exchange; a secret with no URL does
   * nothing. Set neither and Cloudflare is simply called directly, which is
   * correct anywhere the egress is not challenged — local development, or a
   * deployment whose addresses Cloudflare has since exempted.
   */
  DNS_OAUTH_BROKER_URL: z.url().optional(),
  DNS_OAUTH_BROKER_SECRET: z.string().min(1).optional(),

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
   * ⚠ OPTIONAL, AND ITS ABSENCE IS A VISIBLE STATE RATHER THAN A QUIET ONE.
   * Without it the services run and report
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

/**
 * Postgres interval syntax, in milliseconds, or null if we cannot tell.
 *
 * ⚠ IT REFUSES TO GUESS RATHER THAN GUESSING WRONG. Postgres accepts far more
 * than this recognises — `P1DT2H`, `1 mon`, fractional units — and a parser that
 * returned a plausible number for a form it did not really understand would
 * turn the check below into a check that fails on correct configuration. Null
 * means "not comparable", and the invariant is then left unenforced rather than
 * enforced against a made-up value.
 */
const UNITS: [RegExp, number][] = [
  [/^(?:ms|msec|millisecond)s?$/, 1],
  [/^(?:s|sec|second)s?$/, 1_000],
  [/^(?:m|min|minute)s?$/, 60_000],
  [/^(?:h|hr|hour)s?$/, 3_600_000],
  [/^(?:d|day)s?$/, 86_400_000],
]

export function intervalToMs(value: string): number | null {
  const text = value.trim().toLowerCase()

  const clock = /^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/.exec(text)
  if (clock) {
    return (
      Number(clock[1]) * 3_600_000 +
      Number(clock[2]) * 60_000 +
      Number(clock[3]) * 1_000
    )
  }

  const parts = text.match(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)
  if (!parts) return null
  // Anything the pairs did not consume means we are reading a form we do not
  // fully understand, so we decline the whole string.
  if (parts.join("").replace(/\s+/g, "") !== text.replace(/\s+/g, "")) return null

  let total = 0
  for (const part of parts) {
    const [, amount, unit] = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(part.trim()) ?? []
    if (!amount || !unit) return null
    const factor = UNITS.find(([pattern]) => pattern.test(unit))?.[1]
    if (factor === undefined) return null
    total += Number(amount) * factor
  }

  return total
}

/**
 * ⚠ THE ONE INVARIANT THAT WAS STATED IN THREE COMMENTS AND ENFORCED NOWHERE.
 * Redis governs liveness and Postgres governs correctness: groupmq hands a job
 * to a second worker after `WORKER_JOB_TIMEOUT_MS`, and the claim refuses that
 * worker the rows until `WORKER_CLAIM_STALE_AFTER` has passed. Set the interval
 * shorter than the lease and the database releases a row while Redis still
 * believes the first worker holds it — both win the compare-and-swap in turn,
 * and a duplicate send becomes routine rather than exceptional.
 *
 * It is checked here because the two are configured independently, in Doppler,
 * by different people at different times, and nothing else in the system would
 * report the mistake.
 */
const validated = schema.superRefine((env, ctx) => {
  const staleAfterMs = intervalToMs(env.WORKER_CLAIM_STALE_AFTER)
  if (staleAfterMs !== null && staleAfterMs <= env.WORKER_JOB_TIMEOUT_MS) {
    ctx.addIssue({
      code: "custom",
      path: ["WORKER_CLAIM_STALE_AFTER"],
      message:
        `"${env.WORKER_CLAIM_STALE_AFTER}" (${staleAfterMs}ms) must be longer than ` +
        `WORKER_JOB_TIMEOUT_MS (${env.WORKER_JOB_TIMEOUT_MS}ms). Postgres must ` +
        `release a claim after Redis releases the job, never before, or two ` +
        `workers can both win the claim and send the same message twice.`,
    })
  }

  /**
   * ⚠ THE DEFAULT IS THE BUG, WHICH IS WHY THIS IS A CHECK AND NOT A DEFAULT.
   * `SENTRY_ENVIRONMENT` falls back to "development", so a production
   * deployment that never sets it reports its errors tagged as a developer's
   * laptop — and every dashboard, alert rule and filter that selects on
   * environment quietly excludes the only deployment anybody cares about.
   * Nothing errors, nothing is missing, and the events are simply filed under
   * the wrong name.
   *
   * ⚠ AND `NODE_ENV` CANNOT SUPPLY THE ANSWER, WHICH IS THE WHOLE DIFFICULTY.
   * The promotion model re-tags one image for staging and production, so both
   * run `NODE_ENV=production` — deriving the value would label staging's errors
   * as production's, trading a visible mistake for an invisible one. The only
   * correct source is an explicit statement per deployment, so production is
   * required to make it and this is what makes the omission loud.
   */
  if (env.NODE_ENV === "production" && env.SENTRY_ENVIRONMENT === "development") {
    ctx.addIssue({
      code: "custom",
      path: ["SENTRY_ENVIRONMENT"],
      message:
        `must be set explicitly when NODE_ENV is production — "development" is ` +
        `the fallback, and leaving it means production errors arrive tagged as ` +
        `development and are filtered out of every view that matters. Staging ` +
        `and production run the same image, so only this value tells them apart.`,
    })
  }
})

export type Env = z.infer<typeof schema>

/** One provider's OAuth application, as configured. */
export interface OAuthAppConfig {
  clientId: string
  clientSecret?: string
  scopes?: string[]
}

/**
 * Gathers the DNS provider OAuth apps out of `DNS_OAUTH_<PROVIDER>_*`.
 *
 * ⚠ IT DISCOVERS RATHER THAN DECLARES, which is the whole reason per-provider
 * variables are workable at all. Declaring sixteen fields would be sixteen
 * chances to add a provider's variables and forget to read one; nothing here
 * knows which providers exist, so adding the eighth needs no code at all.
 *
 * ⚠ AND A HALF-CONFIGURED PROVIDER IS SKIPPED, NOT FATAL. Somebody pasting a
 * client id and going to find the secret has a partial configuration for a
 * minute or an hour, and refusing to boot over it would stop mail for a feature
 * that is not yet switched on. The provider is named in `ignored` so the
 * absence is reported rather than merely tolerated.
 */
export function collectOAuthApps(source: NodeJS.ProcessEnv): {
  apps: Record<string, OAuthAppConfig>
  ignored: string[]
} {
  const parts = new Map<string, { id?: string; secret?: string; scopes?: string }>()

  for (const [key, raw] of Object.entries(source)) {
    const match = /^DNS_OAUTH_(.+)_(CLIENT_ID|CLIENT_SECRET|SCOPES)$/.exec(key)
    if (!match) continue

    const group = parts.get(match[1]!) ?? {}
    const value = (raw ?? "").trim()
    if (match[2] === "CLIENT_ID") group.id = value
    else if (match[2] === "CLIENT_SECRET") group.secret = value
    else group.scopes = value
    parts.set(match[1]!, group)
  }

  const apps: Record<string, OAuthAppConfig> = {}
  const ignored: string[] = []

  for (const [suffix, held] of parts) {
    // ⚠ THE REGISTRY'S SLUGS ARE KEBAB-CASE and an env var name cannot be, so
    // `google-cloud-dns` arrives as `GOOGLE_CLOUD_DNS` and converts back here.
    const slug = suffix.toLowerCase().replace(/_/g, "-")

    /*
     * ⚠ AN EMPTY SECRET IS NOT AN ABSENT ONE. Absent means a public client
     * authenticating with PKCE alone; empty means a value somebody meant to
     * fill in, and forwarding it produces `invalid_client` — which reads in a
     * log exactly like a real secret that has been rotated.
     */
    const usable =
      held.id !== undefined &&
      held.id.length > 0 &&
      held.secret !== "" &&
      held.scopes !== ""

    if (!usable) {
      ignored.push(slug)
      continue
    }

    const scopes = held.scopes ? held.scopes.split(/[\s,]+/).filter(Boolean) : []

    apps[slug] = {
      clientId: held.id!,
      ...(held.secret ? { clientSecret: held.secret } : {}),
      ...(scopes.length > 0 ? { scopes } : {}),
    }
  }

  return { apps, ignored: ignored.sort() }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const { apps, ignored } = collectOAuthApps(source)

  /*
   * ⚠ MERGED INTO THE SOURCE BEFORE VALIDATION, not patched onto the result, so
   * the schema still gets to refuse a shape this collector should never have
   * produced. It is the one field assembled from several variables rather than
   * read from one, and that is not a reason to let it skip the check.
   */
  const parsed = validated.safeParse({
    ...source,
    DNS_OAUTH_APPS: apps,
    DNS_OAUTH_IGNORED: ignored,
  })
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n")
    throw new Error(`Invalid environment:\n${detail}`)
  }
  return parsed.data
}
