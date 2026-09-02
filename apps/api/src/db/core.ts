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
