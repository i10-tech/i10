import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

/**
 * The transactional product: tenants, their domains and keys, and the mail they
 * send. Separate from `authd`, which is a read model of Clerk and is queried by
 * a different process in a different language.
 *
 * ⚠ EVERY TABLE HERE IS TENANT-SCOPED AND PROTECTED BY ROW LEVEL SECURITY. The
 * policies live in the migration, not here — Drizzle has no DDL for them — and
 * they read `app.tenant_id`, which `withTenant()` sets per transaction. A query
 * issued without that setting does not return an empty result — it raises,
 * deliberately, so a missing tenant context fails at the first query rather
 * than quietly returning nothing and looking like an empty account.
 *
 * It raises one of two errors, and the difference is worth knowing at 3am. A
 * connection that has never set the parameter says `unrecognized configuration
 * parameter "app.tenant_id"`. One that set it inside an EARLIER transaction
 * reverts to an empty value rather than to undefined, and says `invalid input
 * syntax for type uuid: ""`. Connections are pooled, so the second is the one
 * production will show you, and on its own it reads like a bad parameter
 * instead of a forgotten `withTenant()`.
 *
 * ⚠ RLS DOES NOT APPLY TO THE TABLE OWNER. The `i10` role owns these tables and
 * runs the migrations; the API and the worker connect as `i10_api`, which owns
 * nothing. Pointing the application at the owner turns every policy below into
 * a no-op with no error and no log line, which is why `assertRlsSubject()` in
 * client.ts refuses to start against an owning or BYPASSRLS role.
 */
export const core = pgSchema("core")

export const tenantStatus = core.enum("tenant_status", [
  "active",
  "suspended",
  "deleted",
])

export const messageStatus = core.enum("message_status", [
  "queued",
  "sending",
  "sent",
  "failed",
  "canceled",
])

/**
 * The two priority classes.
 *
 * ⚠ THESE ARE CLASSES, NOT TENANTS. Separating them stops one tenant's bulk
 * batch from queueing in front of another tenant's password reset, which is the
 * failure that matters most — latency on a reset is the product. It does
 * nothing about one tenant flooding the transactional class; that is what the
 * per-tenant admission limit at the API is for.
 *
 * Fairness WITHIN a class is deliberately left to a later step. Every job
 * carries its `tenant_id`, so the group key that BullMQ Pro's round-robin needs
 * already exists — the upgrade is two constructors, not a redesign.
 */
export const messageQueue = core.enum("message_queue", ["transactional", "bulk"])

export const messageEventType = core.enum("message_event_type", [
  "queued",
  "sent",
  "delivered",
  "delivery_delayed",
  "bounced",
  "complained",
  "rejected",
  "failed",
])

/**
 * What a customer's endpoint can subscribe to.
 *
 * ⚠ THESE NAMES ARE A PUBLIC CONTRACT AND ARRIVE IN CUSTOMER CODE AS STRING
 * LITERALS. A rename is a breaking change to every `if (event.type === …)` any
 * customer has written, and it breaks silently — their handler stops matching
 * and does nothing. Add, never rename.
 *
 * ⚠ AND EVERY ONE OF THEM ORIGINATES AT SES, INCLUDING `email.sent`. The send
 * worker does not emit events: SES's configuration set publishes `Send` the
 * moment it accepts a message, so one ingestion path produces all of them in
 * one order from one source. Emitting `sent` ourselves and the rest from SES
 * would give two clocks, two failure modes, and a `sent` that can arrive for a
 * message SES later rejected.
 */
export const webhookEventType = core.enum("webhook_event_type", [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
])

export const webhookDeliveryStatus = core.enum("webhook_delivery_status", [
  "pending",
  "delivered",
  /** Every attempt used. Terminal — the reconciler for this is a person. */
  "failed",
])

export const suppressionReason = core.enum("suppression_reason", [
  "hard_bounce",
  "complaint",
  "manual",
  "unsubscribe",
])

/**
 * A customer of i10 — the unit of ownership, billing and isolation.
 *
 * ⚠ IT REFERENCES CLERK, IT IS NOT CLERK. `clerk_org_id` is nullable because a
 * solo developer signs up with no organization and must still be able to send.
 * Making the Clerk org the tenant would force everyone into an org and would
 * make reading your own data depend on Clerk being reachable. Clerk stays
 * authoritative for identity; ownership of mail is ours.
 */
export const tenants = core.table(
  "tenants",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),

    /** URL-safe handle. Stable once issued — it appears in dashboard links. */
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),

    clerkOrgId: text("clerk_org_id").unique(),

    /**
     * Who the tenant belongs to when there is no organization, and who survives
     * one being deleted. Not a foreign key: `authd.accounts` only ever holds
     * users with a mailbox on a domain we host, and most tenant owners will not
     * have one.
     */
    ownerClerkUserId: text("owner_clerk_user_id").notNull(),

    /**
     * Suspension is not deletion. A suspended tenant keeps its data and its
     * domains — it simply stops being allowed to send, which is a decision
     * billing makes and this column records.
     */
    status: tenantStatus("status").notNull().default("active"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tenants_owner_idx").on(t.ownerClerkUserId)],
)

/**
 * A domain a tenant has proven it controls.
 *
 * ⚠ `name` IS GLOBALLY UNIQUE, ACROSS TENANTS. Two tenants cannot both own
 * example.com, and that is a security property rather than a modelling
 * preference: a second tenant claiming a verified domain could send as it and
 * could receive its mail. The uniqueness is what makes verification mean
 * anything.
 *
 * ⚠ THIS TABLE REPLACES THE `MAIL_DOMAINS` ENV VAR. That variable is one global
 * list for the whole deployment, which is correct only while i10.tech is the
 * only domain. Once a customer hosts mailboxes, the question "may this address
 * become a local recipient" has a per-tenant answer and has to be a query.
 */
export const domains = core.table(
  "domains",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    name: text("name").notNull().unique(),

    /** What the domain is used for. A domain may do both, or only one. */
    sends: boolean("sends").notNull().default(true),
    hostsMailboxes: boolean("hosts_mailboxes").notNull().default(false),

    /**
     * The custom MAIL FROM subdomain, stored as the label only ("send"), not
     * the FQDN — the FQDN is `${mailFromSubdomain}.${name}` and storing it
     * twice invites the two to disagree.
     */
    mailFromSubdomain: text("mail_from_subdomain").notNull().default("send"),

    /**
     * BYODKIM. The selector and public key are published in the customer's DNS
     * and are not secret.
     *
     * ⚠ THE PRIVATE KEY IS NOT IN THIS TABLE AND MUST NOT BE. It is held where
     * secrets are held, and this column names it. A database backup, a replica,
     * or a read-only analytics grant must never be enough to sign mail as a
     * customer's domain.
     */
    dkimSelector: text("dkim_selector"),
    dkimPublicKey: text("dkim_public_key"),
    dkimPrivateKeyRef: text("dkim_private_key_ref"),

    /** The SES tenant this domain's sending is attributed to. */
    sesTenantName: text("ses_tenant_name"),

    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    dnsCheckedAt: timestamp("dns_checked_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("domains_tenant_idx").on(t.tenantId)],
)

/**
 * A thin index of the keys Clerk holds for a tenant.
 *
 * ⚠ NO SECRET, NO HASH, NO SCOPES, NO `revoked`, NO `last_used_at`. Clerk owns
 * every one of those and answers for them — `apiKeys.verify()` returns scopes,
 * revocation and expiry, and Clerk maintains `lastUsedAt` itself. Copying any of
 * it here would create a second source of truth for authentication, which is the
 * one kind of duplication that fails silently and in the customer's favour.
 *
 * What is left is the part Clerk cannot answer: which i10 tenant a key belongs
 * to, in one place, when a tenant's keys may be split between a Clerk
 * organization and its owning user. The tenant also travels in the key's own
 * claims, so the request path never reads this table — only the dashboard does.
 */
export const apiKeys = core.table(
  "api_keys",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Clerk's own id for the key, `ak_…`. The join key to everything real. */
    clerkKeyId: text("clerk_key_id").notNull().unique(),

    name: text("name").notNull(),

    /**
     * The leading, non-secret part of the key — `i10_live_a1b2c3d4`. Shown in
     * the dashboard so a customer can tell two keys apart, and greppable in a
     * leak scan. It is not sufficient to authenticate.
     */
    prefix: text("prefix").notNull(),

    /**
     * ⚠ FOR DISPLAY ONLY. The authoritative mode is the `mode` claim Clerk
     * returns from verify(), because `i10_live_` and `i10_test_` are the same
     * length and unwrap to the same secret — see src/auth/api-key.ts. Trusting
     * this column to decide behaviour would reintroduce exactly that hole.
     */
    mode: text("mode").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("api_keys_tenant_idx").on(t.tenantId)],
)

/**
 * Ingress idempotency — layer one of three.
 *
 * A customer retrying `POST /emails` after a timeout must get the same message
 * id back, not a second email. `request_hash` separates a genuine retry from a
 * reused key carrying a different body; the latter is a 409, because silently
 * returning the first message would be worse than either sending or refusing.
 *
 * ⚠ THE ROW IS INSERTED BEFORE THE MESSAGES, NOT AFTER, AND THE PRIMARY KEY IS
 * WHAT SERIALISES A DOUBLE-POST. `insert … on conflict (tenant_id, key) do
 * nothing` blocks on a conflicting row that is still uncommitted, so of two
 * simultaneous retries one inserts and the other waits, then reads the ids the
 * winner wrote. Deciding outside the transaction — read, then insert — would
 * let both miss and both mint a full set of messages, which is the exact
 * duplicate this table exists to prevent.
 *
 * Rows are pruned after 24 hours. A key is a retry window, not a permanent
 * record, and keeping them forever makes this table the largest thing in the
 * database within a year.
 */
export const idempotencyKeys = core.table(
  "idempotency_keys",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    /**
     * Every id the key minted, in the order the caller submitted them.
     *
     * ⚠ AN ARRAY BECAUSE `POST /emails/batch` IS ONE KEY OVER 100 MESSAGES. A
     * single `message_id` can only replay a single send; a replayed batch would
     * have to answer with 99 nulls or with nothing, and an SDK that got nothing
     * back would send the batch again. Null only while the inserting
     * transaction is still open — a committed row always carries its ids.
     */
    messageIds: uuid("message_ids").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.key] }),
    index("idempotency_keys_created_idx").on(t.createdAt),
  ],
)

/**
 * One row per message accepted, and the source of truth for whether it was sent.
 *
 * ⚠ THIS TABLE IS THE SEND LOCK, NOT BULLMQ. A BullMQ job lock expires, and a
 * worker that is merely slow — a blocked event loop, a long SES call without
 * lock renewal — has its job declared stalled and handed to a second worker.
 * That is the double-send path, and it opens under load. The guard is a
 * compare-and-swap here:
 *
 *   update core.messages set status='sending', attempts=attempts+1,
 *          claimed_by=$2, claimed_at=now()
 *    where id=$1 and created_at=$3 and status='queued' returning *
 *
 * No row back means another worker owns it and this one drops the job. Redis is
 * the transport; Postgres decides.
 *
 * ⚠ PARTITIONED BY `created_at`, MONTHLY, AND BY TIME RATHER THAN BY TENANT.
 * Tenant partitioning yields thousands of partitions and worse plans; time
 * partitioning makes retention a DROP, which is the only operation on this
 * table that is otherwise ruinous. The consequence is that the primary key must
 * include the partition key — hence `(id, created_at)` — and that a lookup by
 * bare id would have to touch every partition. It does not have to: the ids are
 * UUIDv7, so the timestamp is inside the id and the partition is derivable from
 * it.
 *
 * The partitions and the DEFAULT catch-all are created in the migration.
 */
export const messages = core.table(
  "messages",
  {
    id: uuid("id")
      .notNull()
      .default(sql`uuidv7()`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    tenantId: uuid("tenant_id").notNull(),
    domainId: uuid("domain_id"),
    apiKeyId: uuid("api_key_id"),

    queue: messageQueue("queue").notNull().default("transactional"),
    status: messageStatus("status").notNull().default("queued"),

    fromAddress: text("from_address").notNull(),
    toAddresses: text("to_addresses").array().notNull(),
    ccAddresses: text("cc_addresses")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    bccAddresses: text("bcc_addresses")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    replyTo: text("reply_to")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    subject: text("subject").notNull(),

    /**
     * The delivery attempt counter and its claim.
     *
     * A row left in `sending` past the claim timeout is genuinely ambiguous —
     * SES was called and the outcome was never recorded, and there is no way to
     * ask SES which it was. The sweeper resends it: a reset that never arrives
     * is a support ticket, a duplicate is a shrug. What makes that safe is that
     * the retry reuses the SAME RFC 5322 Message-ID, derived from `id`, so
     * receiving systems collapse the duplicate.
     */
    attempts: integer("attempts").notNull().default(0),
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),

    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),

    /** SES's id for the accepted message, and the join key for its events. */
    sesMessageId: text("ses_message_id"),
    lastError: text("last_error"),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    // The queue drain and the sweeper both scan by status within a class.
    index("messages_claim_idx").on(t.queue, t.status, t.createdAt),
    // Every dashboard list is "this tenant's recent messages".
    index("messages_tenant_recent_idx").on(t.tenantId, t.createdAt),
    index("messages_ses_id_idx").on(t.sesMessageId),
  ],
)

/**
 * Bodies, kept out of `messages` on purpose.
 *
 * The hot paths — draining the queue, listing a tenant's recent sends, sweeping
 * stuck rows — never read the body, and an HTML body is orders of magnitude
 * larger than the row that describes it. Keeping them apart is what lets the
 * status table stay narrow enough for its indexes to matter.
 *
 * Partitioned on the same key as `messages`, so a retention DROP removes both.
 */
export const messageBodies = core.table(
  "message_bodies",
  {
    messageId: uuid("message_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    tenantId: uuid("tenant_id").notNull(),

    text: text("text"),
    html: text("html"),
    headers: jsonb("headers"),

    /**
     * Files to send with the message: `{ filename, content_type?, content }`
     * with the content base64-encoded, exactly as the caller supplied it.
     *
     * ⚠ IN THE DATABASE RATHER THAN IN OBJECT STORAGE, AND THAT IS A BOUNDED
     * DECISION. The contract caps a message's attachments, so a row cannot grow
     * without limit — and the alternative, a bucket, would put a second store
     * with its own lifecycle, its own access control and its own retention in
     * front of every send. Here retention is the partition drop that already
     * exists, and row level security already covers it.
     *
     * ⚠ AND IT IS WHY THIS TABLE IS SPLIT FROM `messages`. The claim, the
     * sweeper and every dashboard list read the status row; none of them read
     * this. A 10 MB column on the hot table would be a 10 MB column on the
     * queue drain.
     */
    attachments: jsonb("attachments"),

    /**
     * The caller's own labels, forwarded to SES as `EmailTags` and echoed back
     * on every event it publishes.
     *
     * ⚠ OURS WIN ON A COLLISION. `i10_message_id` is the join key between
     * `core.message_events` and this message; a customer tag able to overwrite
     * it would detach every event for that send from the row it describes.
     * Names beginning `i10_` are refused at the contract.
     */
    tags: jsonb("tags"),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.createdAt] })],
)

/**
 * The delivery log, fed by SES event destinations and by our own transitions.
 *
 * ⚠ NO FOREIGN KEY TO `messages`, AND THAT IS DELIBERATE. Events arrive
 * asynchronously from an external system that has its own retry schedule; an FK
 * turns a race — an event landing while its message row is still being written,
 * or after retention has dropped it — into a failed insert and a lost event. An
 * index gives the joins without making SES's timing our correctness problem.
 *
 * `source_event_id` is SES's own id for the notification, and the unique index
 * on it makes SNS redelivery a no-op.
 */
export const messageEvents = core.table(
  "message_events",
  {
    id: uuid("id")
      .notNull()
      .default(sql`uuidv7()`),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),

    tenantId: uuid("tenant_id").notNull(),
    messageId: uuid("message_id").notNull(),

    type: messageEventType("type").notNull(),
    sourceEventId: text("source_event_id"),
    payload: jsonb("payload"),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.occurredAt] }),
    index("message_events_message_idx").on(t.messageId, t.occurredAt),
    index("message_events_tenant_idx").on(t.tenantId, t.occurredAt),
    uniqueIndex("message_events_source_idx").on(t.sourceEventId, t.occurredAt),
  ],
)

/**
 * A customer's HTTP endpoint, and what it wants to hear about.
 *
 * ⚠ THE ENDPOINT IS THE UNIT OF ORDERING AND OF ISOLATION, WHICH IS WHY THE
 * DELIVERY QUEUE IS GROUPED BY ITS ID RATHER THAN BY TENANT. One customer's
 * staging endpoint timing out for an hour must not delay their production one,
 * and events for a single endpoint must arrive in the order they happened —
 * `email.sent` before `email.delivered`, or a customer's state machine reads
 * backwards. Per-endpoint grouping gives both.
 */
export const webhookEndpoints = core.table(
  "webhook_endpoints",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** ⚠ https only, and never a private address — see webhooks/endpoints.ts. */
    url: text("url").notNull(),
    description: text("description"),

    /**
     * The signing secret, ENCRYPTED AT REST.
     *
     * ⚠ IT CANNOT BE A HASH, WHICH IS WHY IT IS ENCRYPTED INSTEAD. A signature
     * is computed, not compared, so the worker needs the secret back — one-way
     * hashing is not available here the way it is for a password. What is
     * available is that a database dump alone is not enough: the key lives in
     * the environment, so an exfiltrated backup yields ciphertext.
     *
     * ⚠ AND THE PLAINTEXT IS SHOWN EXACTLY ONCE, AT CREATION. Storing it
     * retrievably would make "reveal my signing secret" an API call, and that
     * call is a far better target than the database.
     */
    secretCiphertext: text("secret_ciphertext").notNull(),

    events: webhookEventType("events").array().notNull(),

    enabled: boolean("enabled").notNull().default(true),

    /**
     * ⚠ AN ENDPOINT THAT HAS FAILED LONG ENOUGH IS TURNED OFF, AND THAT IS A
     * PROTECTION FOR US RATHER THAN A COURTESY TO THEM. A customer who deletes
     * their receiver without deleting the endpoint would otherwise have every
     * event they ever generate retried against a dead host, forever, at our
     * expense — and the queue those retries sit in is shared.
     */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhook_endpoints_tenant_idx").on(t.tenantId)],
)

/**
 * One attempt to tell one endpoint about one event.
 *
 * ⚠ A ROW PER (EVENT, ENDPOINT), WRITTEN BEFORE ANYTHING IS QUEUED. The same
 * discipline as the send path: the database is the record and the queue is a
 * prompt to look at it. A job whose row does not exist is dropped silently; a
 * row no job points at is late, and a sweep can find it.
 *
 * ⚠ AND IT CARRIES ITS OWN PAYLOAD RATHER THAN REBUILDING IT AT DELIVERY TIME.
 * A webhook says what was true when the event happened. Rebuilding from the
 * message row at attempt four would describe the message as it is now — a
 * `bounced` event whose body says `sent`, because a later retry succeeded.
 */
export const webhookDeliveries = core.table(
  "webhook_deliveries",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),

    eventType: webhookEventType("event_type").notNull(),
    /**
     * When the event HAPPENED, which is not when we heard about it.
     *
     * ⚠ THIS IS WHAT THE CUSTOMER'S ENVELOPE CARRIES, SO IT CANNOT BE
     * `created_at`. SNS can be delayed, and our ingestion can be down for an
     * hour and catch up afterwards — publishing the row's own creation time
     * would tell a customer a bounce from an hour ago happened just now, and
     * anyone measuring delivery latency would be measuring our backlog.
     */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** The message this is about. No FK — see `messageEvents` for why. */
    messageId: uuid("message_id"),
    payload: jsonb("payload").notNull(),

    status: webhookDeliveryStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    /** The last HTTP status we saw, for "why is my endpoint not working". */
    responseStatus: integer("response_status"),
    lastError: text("last_error"),

    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("webhook_deliveries_endpoint_idx").on(t.endpointId, t.createdAt),
    index("webhook_deliveries_tenant_idx").on(t.tenantId, t.createdAt),
    // The queue for "what has not been delivered and is not moving".
    index("webhook_deliveries_pending_idx").on(t.status, t.createdAt),
  ],
)

/**
 * Addresses this tenant may no longer send to.
 *
 * Enforced at our API before a send reaches SES, so a customer who keeps a dead
 * address in their own database is refused with a reason rather than quietly
 * burning reputation on it. Scoped per tenant: one customer's hard bounce is not
 * evidence about another customer's relationship with the same person.
 */
export const suppressions = core.table(
  "suppressions",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Lowercased on write; comparisons here must never be case-sensitive. */
    address: text("address").notNull(),
    reason: suppressionReason("reason").notNull(),
    /** The message that caused it, for "why am I suppressed" in the dashboard. */
    messageId: uuid("message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.address] })],
)

/**
 * What a tenant is paying for, as Polar last told us.
 *
 * ⚠ THIS TABLE IS A COPY, NOT THE TRUTH. Polar is the state of record for
 * subscriptions — it took the money and it is what a dispute is settled
 * against. This row exists so the console can answer "what plan am I on"
 * without a round trip to Polar, and so the reconciler has something to compare
 * against; every value in it arrives from a signature-verified webhook.
 *
 * ⚠ AND IT IS WRITTEN BEFORE AUTUMN IS TOLD ANYTHING. The order is deliberate:
 * row first, entitlement second. If the Autumn call then fails, the truth is
 * already durable and the reconciler repairs the entitlement on its next pass.
 * Reversed, a crash between the two leaves a customer holding a paid plan that
 * nothing in our database records — invisible, and never revoked.
 *
 * ⚠ ONE ROW PER TENANT, NOT A HISTORY. `tenant_id` is unique so the upsert has
 * something to conflict on; what the customer is entitled to today is a single
 * question with a single answer. The audit trail lives in Polar, which keeps it
 * properly and is the thing anyone would actually be asked to produce.
 */
export const subscriptions = core.table(
  "subscriptions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),

    tenantId: uuid("tenant_id")
      .notNull()
      .unique()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * ⚠ ALSO UNIQUE, AND THAT IS A SAFETY PROPERTY. Two tenants pointing at one
     * Polar subscription would mean one payment entitling two accounts, and the
     * reconciler — which matches on this id — would flip the plan back and
     * forth between them on every pass.
     */
    polarSubscriptionId: text("polar_subscription_id").notNull().unique(),
    polarCustomerId: text("polar_customer_id").notNull(),
    polarProductId: text("polar_product_id").notNull(),

    /** Our plan id, from POLAR_PRODUCTS. What they bought. */
    planId: text("plan_id").notNull(),

    /**
     * ⚠ `text`, NOT AN ENUM, AND THE REASON IS THE RETRY LOOP. Polar owns this
     * vocabulary and can add to it; an enum would make an unrecognised status a
     * failed INSERT, which is a 500, which Polar retries for hours while the
     * customer's plan never lands. Storing what they said and deciding
     * separately (billing/events.ts) keeps a vocabulary change from being an
     * outage.
     */
    status: text("status").notNull(),

    /**
     * Set the moment a customer clicks cancel, while the subscription is still
     * active and paid for. Recorded so the console can say "ends on the 4th",
     * and deliberately not acted on — see billing/events.ts.
     */
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),

    /**
     * ⚠ POLAR'S CLOCK, AND THE ONLY THING THAT ORDERS TWO EVENTS. Deliveries
     * retry and overtake each other; a delayed `active` arriving after
     * `revoked` would re-grant a plan to a customer who churned. The upsert
     * refuses to move a row backwards past this value.
     */
    eventAt: timestamp("event_at", { withTimezone: true }).notNull(),

    /**
     * The plan Autumn was last successfully told about, and NULL until one
     * lands.
     *
     * ⚠ THIS COLUMN IS THE ENTIRE POINT OF THE RECONCILER. It is what makes
     * "the row was written but the entitlement never applied" a query rather
     * than an invisible state — where it is out of step with the plan the
     * subscription entitles, a customer is paying for something they do not
     * have, or holding something they no longer pay for.
     */
    grantedPlanId: text("granted_plan_id"),
    grantedAt: timestamp("granted_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("subscriptions_granted_idx").on(t.grantedPlanId, t.planId)],
)

/**
 * Where a plan came from, and who is allowed to overwrite it.
 *
 * ⚠ THE DISCRIMINATOR IS A MECHANISM, NOT A LABEL. `catalog` plans are seeded
 * from configuration and reconciled destructively by a push — the file wins,
 * and anything edited by clicking is reverted. `custom` plans belong to one
 * tenant, are created through the dashboard for a specific deal, and a push
 * never touches them. The second is the only reason the first can safely be
 * destructive.
 */
export const planSource = core.enum("plan_source", ["catalog", "custom"])

/**
 * One line of what a plan grants, as stored.
 *
 * ⚠ THIS TYPE IS AN ASSERTION ABOUT JSON, NOT A GUARANTEE. `$type` is erased at
 * runtime and the column can hold anything a migration or a psql session put
 * there, so every read parses it — see `parseEntitlements` in
 * src/metering/postgres.ts. It mirrors `Entitlement` in `@repo/metering`, and it
 * is declared here rather than imported so the schema stays free of a
 * dependency that drizzle-kit would have to resolve.
 */
export type StoredEntitlement =
  | {
      /** Used up and replenished: emails. Has a reset cycle. */
      kind: "consumable"
      featureId: string
      allowance: number | "unlimited"
      overage: "billable" | "never"
      interval: "day" | "week" | "month" | "year" | "lifetime"
      intervalCount?: number
    }
  | {
      /**
       * Held persistently: domains, mailboxes, storage.
       *
       * ⚠ NO `interval`, AND THE UNION IS WHY RATHER THAN A COMMENT. A domain
       * does not refill. A shape that can carry a reset interval is one
       * somebody eventually sets, after which the limit silently scopes itself
       * to a window and every domain created before the boundary stops
       * counting.
       */
      kind: "continuous"
      featureId: string
      allowance: number | "unlimited"
      overage: "billable" | "never"
    }

/**
 * The plan catalogue, and the bespoke plans beside it.
 *
 * ⚠ THE ENTITLEMENTS ARE `jsonb` RATHER THAN A CHILD TABLE, AND THE REASON IS
 * THAT THEY ARE NEVER READ APART FROM THEIR PLAN. Autumn models these as
 * `product_items` rows because it carries a full pricing model — tiers, prices,
 * proration. Ours are four fields, always loaded as a set, and a child table
 * would buy a second RLS policy, a second index and a join on the hot path of
 * every quota check in exchange for nothing.
 *
 * ⚠ AND A PLAN IS NOT TENANT-SCOPED THE WAY EVERY OTHER TABLE HERE IS. A
 * catalogue row has `tenant_id IS NULL` and is readable by everyone; a custom
 * row is readable only by its owner. The policy in the migration says so, and
 * its WITH CHECK excludes NULL — so `i10_api` can create a bespoke plan for the
 * tenant it is scoped to, and can never create or alter a catalogue one. That
 * is the "the file is the source of truth" rule, enforced by the database
 * rather than by reviewers.
 */
export const plans = core.table(
  "plans",
  {
    /** `free`, `pro`, or something a sales deal produced. */
    id: text("id").primaryKey(),
    source: planSource("source").notNull(),

    /**
     * ⚠ NULL FOR A CATALOGUE PLAN, AND A CHECK CONSTRAINT TIES IT TO `source`.
     * The two ways to get this wrong are both silent: a custom plan with no
     * owner is invisible to the tenant it was built for, and a catalogue plan
     * with one is a price list only one customer can see.
     */
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    entitlements: jsonb("entitlements").$type<StoredEntitlement[]>().notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("plans_tenant_idx").on(t.tenantId)],
)

/**
 * Which plan a tenant is on, and the clock their windows are measured from.
 *
 * ⚠ SEPARATE FROM `subscriptions`, BECAUSE AN ASSIGNMENT DOES NOT REQUIRE A
 * PAYMENT. `core.subscriptions` is our copy of what Polar says was bought;
 * this is what we actually entitle the tenant to. They agree for every ordinary
 * customer and must be able to differ for the ones that matter — an enterprise
 * on a bespoke plan, an account comped by support, our own internal tenant.
 * Folding this into `subscriptions` would mean inventing a fake Polar
 * subscription id to put anybody on a plan they did not buy.
 *
 * ⚠ ONE ROW PER TENANT. What they are entitled to today is a single question
 * with a single answer; the history of how they got there lives in Polar and in
 * the audit trail, which keep it properly.
 */
export const planAssignments = core.table("plan_assignments", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),

  planId: text("plan_id")
    .notNull()
    .references(() => plans.id),

  /**
   * ⚠ SET ONCE, AND NEVER MOVED BY A PLAN CHANGE. Every reset boundary for this
   * tenant is derived from it, so rewriting it re-buckets all of their history
   * — and re-anchoring on assignment would hand every customer a free reset:
   * exhaust the allowance, change plan, start a fresh window, repeat. The
   * upsert in src/metering/postgres.ts deliberately omits this column from its
   * DO UPDATE, which is where the rule is actually enforced.
   */
  anchor: timestamp("anchor", { withTimezone: true }).notNull(),

  /**
   * The customer's own switch: "keep going past my plan and bill me".
   *
   * ⚠ OFF BY DEFAULT, AND IT IS THE CUSTOMER'S TO SET. It is the whole
   * difference between "your sends stopped" and "you owe us twenty-seven
   * dollars you did not expect", and only one of those is a decision we are
   * entitled to make on somebody's behalf.
   *
   * ⚠ AND IT GRANTS NOTHING ON ITS OWN. Each entitlement says whether that
   * feature may be exceeded at all; this only turns it on where the plan
   * already permits it. A tenant with this set still cannot buy a fourth
   * domain, because nobody sells a fourth domain.
   */
  overageEnabled: boolean("overage_enabled").notNull().default(false),

  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * The ledger: one row per unit of metered usage.
 *
 * ⚠ IT DUPLICATES A COUNT THAT `core.messages` ALREADY IMPLIES, AND THAT IS THE
 * POINT RATHER THAN AN OVERSIGHT. `send/reconcile.ts` exists to compare two
 * INDEPENDENTLY DERIVED numbers; deriving the meter from `core.messages` would
 * have it compare a number against itself, and a bad flush — from the send path
 * today, from a Durable Object at the edge later — would become undetectable.
 * The cost is a narrow row per message; the thing bought is the only mechanism
 * that can notice metering has gone wrong.
 *
 * ⚠ THE PRIMARY KEY DOES NOT INCLUDE `shard`, AND THAT IS DELIBERATE. Dedup is
 * on `(tenant_id, feature_id, event_id)` so that the same message cannot be
 * counted twice if it is ever replayed against a different shard than the one
 * that first recorded it. The shard is stored for attribution, not identity.
 *
 * ⚠ NOT PARTITIONED, UNLIKE `messages`. Its volume is the same but its
 * retention is not: message content ages out, and billing evidence is what a
 * disputed invoice is settled against. When this needs partitioning it wants
 * yearly bounds and a different retention job than the monthly one in 0002 —
 * a decision to make with a real row count rather than now.
 */
export const meterEvents = core.table(
  "meter_events",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** `emails`. The metered feature this unit was drawn from. */
    featureId: text("feature_id").notNull(),

    /**
     * ⚠ `messageId`, AND IT IS THE PROPERTY THE WHOLE DESIGN RESTS ON. The same
     * value keys the buffer entry at the edge, this row, and Polar's
     * `external_id`, which is what makes every leg independently retryable —
     * and being independently retryable is what makes buffering usage away from
     * this table safe at all.
     */
    eventId: text("event_id").notNull(),

    shard: integer("shard").notNull().default(0),

    /** Units consumed. One email is 1. */
    value: integer("value").notNull().default(1),

    /**
     * ⚠ THE `sent_at` THE DATABASE STORED, NOT THE RECORDING PROCESS'S CLOCK.
     * The reconciler buckets our side by `core.messages.sent_at` and the meter's
     * by this column; a millisecond of disagreement across a boundary shows a
     * deficit in one window and a surplus in the next, and tops the deficit up
     * on every run forever.
     */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),

    /** When we wrote it. The gap from `occurred_at` is the flush lag. */
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.featureId, t.eventId] }),
    // The gate's only read: one tenant, one feature, one shard, one window.
    index("meter_events_window_idx").on(t.tenantId, t.featureId, t.shard, t.occurredAt),
  ],
)
