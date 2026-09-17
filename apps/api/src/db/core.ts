import { sql } from "drizzle-orm"
import {
  bigint,
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

/**
 * How far along a domain's verification is.
 *
 * ⚠ RESEND'S VOCABULARY, VERBATIM, AND THAT IS THE POINT OF THE CHOICE. These
 * strings reach customer code as literals in `if (domain.status === ...)`, and
 * a migration from Resend that has to rewrite those comparisons is a migration
 * that does not happen. `temporary_failure` in particular is not a synonym for
 * `failed`: SES uses it for a DNS lookup that failed in a way worth retrying,
 * and collapsing the two would tell a customer their correct records are wrong.
 */
/**
 * Which MTA a domain's mail leaves through.
 *
 * ⚠ `auto` IS NOT A THIRD MTA, IT IS "ASK THE PLAN". Free tenants send through
 * our own MTA and paid ones through SES, and that mapping is policy that will
 * change. Storing the RESOLVED answer on every domain would freeze today's
 * policy into rows and make a pricing change a backfill; storing `auto` keeps
 * the decision in one place and leaves the column for the exceptions.
 *
 * ⚠ AND THE OVERRIDES EXIST FOR SUPPORT, NOT FOR CUSTOMERS. A domain pinned to
 * `direct` or `ses` ignores the plan entirely — for a customer whose
 * deliverability needs one specific path, or to move somebody off a route that
 * is having a bad day. It is a dashboard control, not an API field.
 */
export const deliveryRoute = core.enum("delivery_route", ["auto", "ses", "direct"])

/**
 * Which MTA actually carried one message. Stamped by the worker at send.
 *
 * ⚠ A SEPARATE TYPE FROM `delivery_route` BECAUSE `auto` IS NOT AN ANSWER. The
 * column above is a stored PREFERENCE and may say "ask the plan"; this one is
 * the record of what happened, and a message that was sent went one way or the
 * other. Reusing the override's type here would make `auto` representable on a
 * row describing the past, and the reporting query that counts direct against
 * SES would silently have a third bucket nobody meant to create.
 */
export const sentRoute = core.enum("sent_route", ["ses", "direct"])

export const domainStatus = core.enum("domain_status", [
  /** No identity has been created yet. */
  "not_started",
  /** Records issued, waiting for DNS to propagate. */
  "pending",
  "verified",
  /** SES gave up. The records are absent or wrong. */
  "failed",
  /** A retryable lookup failure. NOT the same as `failed`. */
  "temporary_failure",
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
     *
     * ⚠ THIS ONE IS THE SES ROUTE'S RETURN PATH, AND ITS MX MUST BE AMAZON'S.
     * That is why there is a second one below rather than one shared label: a
     * name has one MX target, and the two routes need different ones.
     */
    mailFromSubdomain: text("mail_from_subdomain").notNull().default("send"),

    /**
     * The return path for mail we deliver ourselves.
     *
     * ⚠ A SECOND SUBDOMAIN EXISTS SO THAT SPF ALIGNS ON BOTH ROUTES. Sending
     * direct with a bounce address on i10's own domain works and DMARC still
     * passes — on DKIM alone. Passing on SPF *as well* requires the envelope
     * sender to be on the CUSTOMER'S domain, which means their DNS needs a
     * return path pointing at us. Two labels, two MX records, published once.
     *
     * ⚠ RELAXED ALIGNMENT IS WHAT MAKES A SUBDOMAIN ENOUGH. DMARC's default
     * `aspf=r` aligns anything under the organizational domain, so
     * `bounce.example.com` aligns with `From: someone@example.com`. Under
     * `aspf=s` it would not — which is a reason never to publish a DMARC record
     * for a customer with strict alignment on.
     */
    bounceSubdomain: text("bounce_subdomain").notNull().default("bounce"),

    /**
     * Which MTA this domain's API mail leaves through. `auto` asks the plan.
     *
     * ⚠ ON THE DOMAIN, NOT THE TENANT, BECAUSE DELIVERABILITY IS PER DOMAIN. A
     * customer with a warmed sending domain and a brand-new one has different
     * needs for each, and a tenant-level switch would force the same answer on
     * both.
     *
     * ⚠ THIS WAS ONE COLUMN CALLED `delivery_route` AND ONE VALUE COULD NOT SAY
     * ENOUGH. A domain has two kinds of mail leaving it — what the API sends
     * and what its mailboxes send — and they are different products with
     * different economics. One column forced the same answer on both, so a
     * customer whose people send through our own MTA could not also have their
     * transactional traffic on SES. Split 2026-09-16; the old column became
     * this one, so every existing preference kept applying to API mail.
     */
    transactionalRoute: deliveryRoute("transactional_route").notNull().default("auto"),

    /**
     * @deprecated Superseded by `transactionalRoute`. Dropped in a follow-up.
     *
     * ⚠ STILL HERE BECAUSE A RENAME IS NOT SAFE IN ONE DEPLOY. `ALTER TABLE
     * RENAME COLUMN` is instant, but between the migration and the last old pod
     * rolling there are readers in flight expecting the old name, and they fail
     * for the width of the rollout. Expand, backfill, switch readers, contract:
     * this column is backfilled into `transactional_route` by migration and
     * read by nothing from 2026-09-16.
     */
    deliveryRoute: deliveryRoute("delivery_route").notNull().default("auto"),

    /**
     * Which MTA this domain's MAILBOX mail leaves through. `auto` asks the plan.
     *
     * ⚠ STORED AND RENDERED, AND READ BY NOTHING YET. Stalwart chooses the
     * mailbox route itself by evaluating an expression against its own queue,
     * and that expression — plus the SES SMTP relay behind it — is not built.
     * The column exists so the preference has somewhere to live and the API can
     * answer with it; see docs/decisions/mail-routing.md. It is the same shape
     * of promise `delivery_route` made before anything read that either, which
     * is exactly why the note is here rather than implied.
     */
    mailboxRoute: deliveryRoute("mailbox_route").notNull().default("auto"),

    /**
     * Whether i10 serves this domain's mail records from its own nameservers.
     *
     * ⚠ IT CHANGES WHAT THE CUSTOMER MUST PUBLISH, WHICH IS WHY IT IS NOT A
     * SETTING TO TOGGLE. Delegated, they add three NS record sets and we serve
     * the rest; manual, they add six records themselves. Flipping it on a live
     * domain invalidates whichever set is already published, so it is chosen at
     * creation and changed only deliberately.
     *
     * ⚠ AND MANUAL IS THE DEFAULT, BECAUSE IT HAS NO DEPENDENCY ON US. Records
     * in the customer's own DNS keep resolving whatever happens to our
     * nameserver; a delegated domain stops resolving entirely. Until that is
     * served by something with real redundancy, the safer shape is the default.
     */
    delegated: boolean("delegated").notNull().default(false),

    /**
     * BYODKIM. Both halves are published in the customer's DNS and neither is
     * secret: the selector is the label the key is served under, the public key
     * is the TXT record's payload. The private half is `dkimPrivateKeySealed`
     * below.
     *
     * ⚠ THE SELECTOR IS RANDOM RATHER THAN A FIXED `i10`, which is what makes
     * rotation possible at all — see domains/dkim.ts. A fixed one means a single
     * name per domain, so replacing a key is a destructive edit of a live record
     * with a window in which nothing verifies.
     */
    dkimSelector: text("dkim_selector"),
    dkimPublicKey: text("dkim_public_key"),

    /** The SES tenant this domain's sending is attributed to. */
    sesTenantName: text("ses_tenant_name"),

    /**
     * The DKIM private key, sealed with `WEBHOOK_SECRET_KEY`.
     *
     * ⚠ SEALED, WHICH IS WHAT LETS IT LIVE IN THIS TABLE AT ALL. A database
     * backup, a replica or a read-only analytics grant must never be enough to
     * sign mail as a customer's domain, and none of them are: the key that
     * opens this lives outside the database, so the ciphertext is inert without
     * it.
     *
     * ⚠ AN EARLIER DESIGN PUT A `dkim_private_key_ref` HERE INSTEAD — a pointer
     * into an external secret store, on the reasoning that the key must not be
     * in this table at any price. Sealing buys the same property without the
     * second system to run, so the column was superseded and never written;
     * migration 0034 dropped it. The comment above it survived the change and
     * claimed for a while that the private key was not in this table, directly
     * beside the column holding it.
     *
     * ⚠ AND IT IS NEVER RETURNED BY THE API. There is no "show me my DKIM key"
     * endpoint, for the same reason there is none for a webhook signing secret:
     * such a call is a better target than the database it would read from.
     */
    dkimPrivateKeySealed: text("dkim_private_key_sealed"),

    /**
     * ⚠ SES'S ANSWER, COPIED — NOT DERIVED FROM `verified_at`. A domain can be
     * `failed` or `temporary_failure` while `verified_at` is null, and those
     * three states are what a customer needs told apart: one means wait, one
     * means check your DNS, one means it never started.
     */
    status: domainStatus("status").notNull().default("not_started"),

    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    dnsCheckedAt: timestamp("dns_checked_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("domains_tenant_idx").on(t.tenantId)],
)

/**
 * Every API key i10 has issued. This table IS the credential store.
 *
 * ⚠ IT USED TO BE A THIN INDEX OF KEYS CLERK HELD, AND THE COMMENT HERE ARGUED
 * AGAINST EXACTLY WHAT IT NOW DOES — no hash, no scopes, no revocation, on the
 * grounds that a second source of truth for authentication "fails silently and
 * in the customer's favour". That reasoning was sound while Clerk was the first
 * source. It stopped applying when Clerk was removed: there is one source now,
 * and it is this table.
 *
 * ⚠ WHAT FORCED THE CHANGE WAS LATENCY, MEASURED RATHER THAN ASSUMED. Verifying
 * against Clerk cost ~900ms on a cache miss with a 60s TTL, which is most
 * requests for a customer who sends sporadically — larger than the SES call it
 * was authenticating. See drizzle/0031.
 *
 * ⚠ AND THE TENANT LINK DID NOT MOVE. It was already `tenant_id` here, mirrored
 * into a Clerk claim that auth/api-key.ts read on every request. Clerk's own
 * `subject` was never consulted.
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

    name: text("name").notNull(),

    /**
     * SHA-256 of the WHOLE key as presented, prefix included.
     *
     * ⚠ THE PLAINTEXT IS NEVER STORED AND CANNOT BE RECOVERED. It is returned
     * once, at creation, and a customer who loses it rotates rather than reads
     * it back.
     *
     * ⚠ AND HASHING THE PREFIX TOO IS WHAT RETIRES AN OLD HAZARD. While Clerk
     * issued these, `i10_live_` and `i10_test_` were nine characters each and
     * stripped to one identical secret, so the mode could never be read off the
     * string. Covered by the hash, they are simply two different keys.
     */
    secretHash: text("secret_hash").notNull().unique(),

    /**
     * The leading, non-secret part of the key — `i10_live_a1b2c3d4`. Shown in
     * the dashboard so a customer can tell two keys apart, and greppable in a
     * leak scan. It is not sufficient to authenticate.
     */
    prefix: text("prefix").notNull(),

    /**
     * `live` or `test`.
     *
     * ⚠ AUTHORITATIVE, WHERE IT WAS ONCE DISPLAY-ONLY. It is a property of the
     * row the hash matched, not of the string a caller sent.
     */
    mode: text("mode").notNull(),

    /**
     * ⚠ CARRIED, NOT ENFORCED. `ResolvedKey` exposes these and no route checks
     * them yet. Empty is "unrestricted", which is what every key has.
     */
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'`),

    /**
     * ⚠ REVOCATION IS IMMEDIATE, AND THAT IS THE WHOLE REASON IT LIVES HERE.
     * Under Clerk the floor was the cache TTL — a leaked production key stayed
     * live for up to a minute. Setting this and deleting the cache entry ends it
     * at once.
     */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    /**
     * ⚠ COARSE BY CONSTRUCTION — written on a cache miss, so once a minute per
     * key rather than once per request. See `core.resolve_api_key`. It answers
     * "is this key still in use", which does not need to be exact.
     */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),

    /**
     * The Clerk user who minted it.
     *
     * ⚠ AUDIT ONLY, NEVER AUTHORIZATION. A sending key belongs to the
     * organisation; authorizing against its creator would mean offboarding one
     * employee takes production sending down with them. Authorization reads
     * `tenantId`, always.
     */
    createdBy: text("created_by"),

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

    /**
     * The broadcast this message was fanned out from, if any.
     *
     * ⚠ NOT A FOREIGN KEY, LIKE EVERY OTHER REFERENCE ON THIS TABLE.
     * `core.messages` is partitioned, and a partitioned table cannot be the
     * referencing side of an FK to a non-partitioned one without the constraint
     * being declared on every partition — which the create-partition path would
     * have to know about and would silently omit for any partition made by
     * hand. The reference is enforced by the code that writes it, which is the
     * same position `domain_id` and `api_key_id` already take.
     *
     * ⚠ AND IT IS WHAT MAKES A BROADCAST'S NUMBERS DERIVED RATHER THAN STORED.
     * Every count on the broadcast page is an aggregate over the messages that
     * carry this id, joined to their events — so a late bounce moves the number
     * on its own, and there is no counter to drift.
     */
    broadcastId: uuid("broadcast_id"),

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

    /**
     * The relaying MTA's own id for the accepted message, and the join key for
     * its events.
     *
     * ⚠ THIS WAS `ses_message_id`, AND THE NAME WAS A ROUTING ASSUMPTION IN A
     * COLUMN. A direct-routed message has no SES id — it has whatever our own
     * MTA called it — so the old name would have meant writing a Stalwart queue
     * id into a column named for Amazon, and every reader would have had to
     * know that. Renamed 2026-09-16 alongside `sent_route`, which says which
     * provider the id belongs to.
     */
    providerMessageId: text("provider_message_id"),

    /**
     * @deprecated Superseded by `providerMessageId`. Dropped in a follow-up.
     *
     * ⚠ SAME EXPAND-AND-CONTRACT AS `delivery_route` ON `core.domains`, and it
     * matters more here: this table is the billing record, and the SES
     * reconcilers read it on a schedule. A column that vanished under a running
     * reconciler would turn a repair pass into an error pass. Backfilled into
     * `provider_message_id` by migration and read by nothing from 2026-09-16.
     */
    sesMessageId: text("ses_message_id"),

    /**
     * Which MTA carried it. Null until the worker has actually sent it.
     *
     * ⚠ NULLABLE ON PURPOSE: A QUEUED MESSAGE HAS NOT BEEN ROUTED YET. The
     * route is resolved at send, not at admission, because the domain's
     * preference or the tenant's plan can change while a message sits in the
     * queue — and stamping it early would record an intention rather than a
     * fact. It is also what makes "how much went direct" answerable without
     * joining anything.
     */
    sentRoute: sentRoute("sent_route"),

    lastError: text("last_error"),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    // The queue drain and the sweeper both scan by status within a class.
    index("messages_claim_idx").on(t.queue, t.status, t.createdAt),
    // Every dashboard list is "this tenant's recent messages".
    index("messages_tenant_recent_idx").on(t.tenantId, t.createdAt),
    index("messages_ses_id_idx").on(t.sesMessageId),
    index("messages_provider_id_idx").on(t.providerMessageId),
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
 * ⚠ AND IT IS WRITTEN BEFORE THE ENTITLEMENT MOVES. The order is deliberate:
 * row first, entitlement second. If the grant then fails, the truth is
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
     * The plan the entitlement was last successfully moved to, and NULL until
     * one lands.
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
 * THAT THEY ARE NEVER READ APART FROM THEIR PLAN. Autumn modelled these as
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

    /**
     * Where this plan sits relative to the others. Higher is more.
     *
     * ⚠ AN EXPLICIT NUMBER, NOT AN INFERENCE FROM PRICE OR ALLOWANCE. Whether a
     * plan change is an upgrade decides how Polar prorates it — charged now, or
     * deferred to the period end — so the answer has to be one somebody chose.
     * Inferring it from the `emails` allowance breaks the moment a plan is
     * cheaper on volume and dearer on seats, and inferring it from price means
     * storing a price we deliberately do not own.
     *
     * ⚠ TIES ARE NOT UPGRADES. Two plans at the same rank are a sideways move,
     * which is neither charged nor deferred — see `directionOf`.
     */
    rank: integer("rank").notNull().default(0),

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
 * How much disk each tenant's mailboxes occupy, as last sampled.
 *
 * ⚠ A SAMPLE, NOT A LEDGER, AND THE DIFFERENCE IS THE WHOLE DESIGN. Storage is
 * a LEVEL that goes up and down — a deleted folder frees space — so it cannot
 * be accumulated from events the way sends are. There is exactly one row per
 * tenant and it is overwritten; the history, if it is ever wanted, is a
 * different table with a different retention.
 *
 * ⚠ AND IT IS OUR COPY OF SOMEBODY ELSE'S NUMBER. Stalwart computes it and owns
 * it. This exists so the quota check is an indexed local read rather than a
 * synchronous call to another service on a request path — see the note on
 * freshness in `sampledAt`.
 */
export const tenantStorage = core.table("tenant_storage", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),

  /**
   * ⚠ BYTES, NOT GIGABYTES, AND THE ALLOWANCE IS IN BYTES TOO. Rounding to GB
   * forces a choice between a ceiling — where one byte past ten gigabytes reads
   * as eleven and refuses — and a floor, which hands out up to a gigabyte free.
   * Neither is defensible on a cap, and `draw()` needs no rounding at all if
   * both sides are exact. The catalogue writes the byte figure and says the GB
   * equivalent in a comment.
   *
   * ⚠ `bigint`, BECAUSE A TERABYTE DOES NOT FIT IN AN `integer`. 2^31 bytes is
   * 2.1 GB — a limit some tenants would pass in their first month.
   */
  bytes: bigint("bytes", { mode: "number" }).notNull(),

  /**
   * When the figure was taken.
   *
   * ⚠ THE GATE READS A NUMBER THAT IS MINUTES OLD, ON PURPOSE. A mailbox quota
   * check at delivery time is Stalwart's own business and it does that itself,
   * exactly; ours is for plan limits and billing, where a synchronous call to
   * another service on the request path would put its availability inside ours
   * for no accuracy anyone can use.
   */
  sampledAt: timestamp("sampled_at", { withTimezone: true }).notNull().defaultNow(),
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

    /**
     * When this unit reached Polar's meter. NULL until it has.
     *
     * ⚠ IT IS A WATERMARK PER ROW, NOT A GLOBAL ONE, AND THAT IS WHAT MAKES THE
     * FLUSH RESUMABLE. A "last shipped at" timestamp would be wrong the moment a
     * late-arriving event lands behind it — the row would be skipped forever,
     * silently, and the customer would be under-billed with nothing to notice
     * it. Per row, an interrupted flush simply finds the same rows next time.
     *
     * ⚠ AND IT IS SET ONLY AFTER POLAR ANSWERS. Marking first and posting after
     * loses usage on any failure; posting first and marking after can only
     * re-send, which `external_id` makes free.
     */
    ingestedAt: timestamp("ingested_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.featureId, t.eventId] }),
    // The gate's only read: one tenant, one feature, one shard, one window.
    index("meter_events_window_idx").on(t.tenantId, t.featureId, t.shard, t.occurredAt),
  ],
)

/**
 * The two routing inputs that are configuration rather than rows.
 *
 * ⚠ A PROJECTION OF THE ENVIRONMENT, NOT A SECOND SOURCE OF TRUTH. `SES_ENABLED`
 * and `METERING_FREE_PLAN_ID` are authored in Doppler and read from `env` by the
 * API and the worker; this row is a copy the API upserts at boot. It exists for
 * one reader that cannot see our pods' environment: the `core.mailbox_route`
 * function Stalwart calls to decide where a mailbox domain's human mail goes.
 *
 * ⚠ WITHOUT IT THE KILL SWITCH WOULD ONLY MOVE HALF THE MAIL. `SES_ENABLED` is
 * thrown during an incident and the transactional path honours it immediately;
 * mailbox mail is routed inside Stalwart, which would keep relaying to the thing
 * that is down. "One rule, three readers" has to include the reader that lives
 * in another process.
 */
export const routingSettings = core.table("routing_settings", {
  /**
   * ⚠ ONE ROW, ENFORCED BY THE KEY. A second would give the function two answers
   * and a `limit 1` would pick one of them silently.
   */
  id: boolean("id").primaryKey().default(true),

  /** Mirrors `SES_ENABLED`. */
  sesEnabled: boolean("ses_enabled").notNull().default(true),

  /**
   * Whether SES's SMTP endpoint is configured as a relay for mailbox mail.
   *
   * ⚠ A SECOND SWITCH, AND NOT A DUPLICATE OF THE FIRST. The transactional route
   * uses the SES API; mailbox mail can only use SES SMTP, because Stalwart's
   * outbound has no HTTP hook. Different credentials, which can exist
   * independently — so one flag cannot govern both.
   *
   * ⚠ DEFAULTS FALSE SO THE MIGRATION MOVES NO MAIL. i10.tech is on `pro` and
   * hosts mailboxes, so a default of true would silently put our own human mail
   * onto a relay with no credentials behind it.
   */
  sesRelayEnabled: boolean("ses_relay_enabled").notNull().default(false),

  /** Mirrors `METERING_FREE_PLAN_ID`. */
  freePlanId: text("free_plan_id").notNull().default("free"),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

// ─────────────────────────────────────────────────────────────────────────────
// Marketing mail.
//
// ⚠ THE MODEL IS CONTACTS + SEGMENTS + TOPICS, NOT "AUDIENCES", AND THE
// DIFFERENCE IS NOT COSMETIC. The obvious shape — a list, with people on it —
// makes the same person a different row on every list, which means unsubscribing
// them once unsubscribes them from one list, and a CSV re-import quietly
// resurrects them on the others. A contact is therefore GLOBAL to a tenant and
// unique by address; a segment is a grouping of contacts; and a topic is the
// thing the RECIPIENT sees and controls.
//
// ⚠ A SEGMENT IS INTERNAL AND A TOPIC IS PUBLIC, AND CONFLATING THEM IS A
// COMPLIANCE BUG. "Customers who bought in Q3" is a segment: the recipient must
// never see it, and it is not something they can opt out of. "Product updates"
// is a topic: it appears on their preference page and their choice about it is
// binding. One table for both would either leak internal targeting to
// recipients or make their preferences unenforceable.
//
// ⚠ AND A BROADCAST FANS OUT INTO ORDINARY MESSAGES. One row in `core.messages`
// per recipient, on the `bulk` queue, carrying the broadcast's id — so metering,
// suppression, DKIM, the event ingest, webhooks and the delivery log are the
// code that already exists and is already in production. A parallel sending path
// for marketing mail would be a second answer to "did this deliver", and the two
// would disagree the first time an event arrived late.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A person a tenant can send marketing mail to. Global to the tenant.
 *
 * ⚠ UNIQUE BY ADDRESS PER TENANT, WHICH IS THE WHOLE POINT. The same person on
 * "Product updates" and "Beta testers" is ONE row with two segment memberships,
 * so unsubscribing them is one write that holds everywhere.
 *
 * ⚠ `unsubscribed` IS GLOBAL AND IS NOT THE SAME AS A TOPIC PREFERENCE. True
 * here means "send me no marketing at all" and overrides every topic; a topic
 * preference is the finer-grained control underneath it. Reading only one of the
 * two is how somebody who unsubscribed from everything still receives a
 * newsletter.
 *
 * ⚠ AND NEITHER IS `core.suppressions`. Unsubscribing from a newsletter must not
 * stop a password reset, and a hard bounce on a transactional message must not
 * silently remove somebody from a list they can still be reached on. Three
 * questions, three places, all consulted at send.
 */
export const contacts = core.table(
  "contacts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** ⚠ STORED LOWERCASED. The unique index below is on the stored value. */
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),

    unsubscribed: boolean("unsubscribed").notNull().default(false),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),

    /**
     * Custom merge fields, keyed by `contact_properties.key`.
     *
     * ⚠ A JSONB BAG RATHER THAN A COLUMN PER PROPERTY, because the keys are the
     * customer's and are created at runtime. The `contact_properties` table
     * below is what gives them a declared type and a fallback — without it this
     * column is a free-for-all where `plan` is the string "3" for one contact
     * and the number 3 for the next, and a template renders one of them wrong.
     */
    properties: jsonb("properties").$type<Record<string, unknown>>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("contacts_tenant_email_uq").on(t.tenantId, t.email),
    index("contacts_tenant_idx").on(t.tenantId, t.createdAt),
  ],
)

export const propertyType = core.enum("property_type", ["string", "number", "boolean"])

/**
 * A declared custom field on a contact.
 *
 * ⚠ THE DECLARATION IS WHAT MAKES A FALLBACK POSSIBLE, AND A FALLBACK IS WHAT
 * STOPS "Hi {{first_name}}," GOING OUT AS "Hi ,". A template references a key;
 * the contacts who have no value for it are the majority on any real import.
 * Without a declared default the choice is between rendering an empty string and
 * refusing to send.
 */
export const contactProperties = core.table(
  "contact_properties",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * ⚠ CASE-SENSITIVE, AND THE UNIQUE INDEX BELOW IS TOO. `plan` and `Plan`
     * are two properties. That is surprising, and the alternative is worse: a
     * case-insensitive key means a CSV import with both spellings silently
     * merges two columns of different data into one field.
     */
    key: text("key").notNull(),
    type: propertyType("type").notNull().default("string"),
    /** Rendered when a contact has no value. Stored as text; cast on read. */
    fallbackValue: text("fallback_value"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("contact_properties_tenant_key_uq").on(t.tenantId, t.key)],
)

/**
 * An internal grouping of contacts. Never visible to a recipient.
 *
 * ⚠ STATIC MEMBERSHIP, NOT A STORED QUERY, AND THAT IS A DELIBERATE FIRST
 * VERSION. A rule-based segment ("everyone who opened in the last 30 days") has
 * to be evaluated at send time against the event log, which makes a broadcast's
 * recipient list unreproducible after the fact — somebody asks "why did she get
 * this" and the answer is "she matched at 09:04". Explicit membership is
 * auditable, and a rules engine can be added later as a thing that WRITES
 * membership rather than replaces it.
 */
export const segments = core.table(
  "segments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("segments_tenant_idx").on(t.tenantId, t.createdAt)],
)

export const segmentContacts = core.table(
  "segment_contacts",
  {
    segmentId: uuid("segment_id")
      .notNull()
      .references(() => segments.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /**
     * ⚠ DENORMALISED ONTO THE JOIN TABLE SO RLS IS A PLAIN EQUALITY. Every other
     * policy in `core` compares one column to `app.tenant_id`; a join table
     * without its own `tenant_id` would need a policy that joins to `segments`,
     * which is itself under RLS — evaluated per row, on the table that grows
     * fastest here.
     */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.segmentId, t.contactId] }),
    index("segment_contacts_contact_idx").on(t.contactId),
    index("segment_contacts_tenant_idx").on(t.tenantId),
  ],
)

export const topicDefault = core.enum("topic_default", ["opt_in", "opt_out"])
export const topicVisibility = core.enum("topic_visibility", ["private", "public"])

/**
 * A kind of email a recipient can choose to receive or not.
 *
 * ⚠ THIS IS THE RECIPIENT'S SURFACE, NOT THE SENDER'S. It appears on the
 * preference page behind every unsubscribe link, and a person's answer to it is
 * binding on us. That is why it is a different table from `segments` — see the
 * block comment above.
 *
 * ⚠ `default_subscription` IS IMMUTABLE ONCE SET, AND THE APPLICATION ENFORCES
 * IT. Flipping a topic from opt-out to opt-in would retroactively subscribe
 * every contact who had simply never answered — which is sending marketing mail
 * to people who did not ask, at scale, because of a dropdown.
 */
export const topics = core.table(
  "topics",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    defaultSubscription: topicDefault("default_subscription").notNull().default("opt_in"),
    visibility: topicVisibility("visibility").notNull().default("public"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("topics_tenant_idx").on(t.tenantId, t.createdAt)],
)

/**
 * A contact's explicit answer about one topic.
 *
 * ⚠ A ROW HERE MEANS THEY CHOSE; ITS ABSENCE MEANS THEY HAVE NOT. That is why
 * `subscribed` is NOT NULL and the row is optional, rather than a nullable
 * column on a row that always exists. The default comes from the topic, and
 * "never asked" has to stay distinguishable from "said yes" — otherwise
 * switching a topic's default silently rewrites people's stated preferences.
 */
export const contactTopics = core.table(
  "contact_topics",
  {
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    subscribed: boolean("subscribed").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.contactId, t.topicId] }),
    index("contact_topics_topic_idx").on(t.topicId),
    index("contact_topics_tenant_idx").on(t.tenantId),
  ],
)

export const broadcastStatus = core.enum("broadcast_status", [
  "draft",
  "scheduled",
  /** Fan-out in progress. Some recipients have messages, some do not yet. */
  "sending",
  "sent",
  "canceled",
])

/**
 * One marketing send to one segment.
 *
 * ⚠ IT HOLDS THE CONTENT, NOT THE DELIVERY. Once fan-out starts, what happened
 * lives in `core.messages` and `core.message_events` like every other email,
 * joined back by `broadcast_id`. The counters a person sees on the broadcast
 * page are aggregates over those, computed on read — a denormalised
 * `delivered_count` would be wrong within a day, because events arrive for hours
 * after a send, and nothing would ever recompute it to disagree.
 */
export const broadcasts = core.table(
  "broadcasts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * ⚠ `set null`, NOT `cascade`. Deleting a segment must not delete the record
     * of a broadcast already sent to it — that record is what a customer needs
     * when somebody asks why they received an email.
     */
    segmentId: uuid("segment_id").references(() => segments.id, {
      onDelete: "set null",
    }),
    /** Which topic's preferences this send respects. Null means every contact. */
    topicId: uuid("topic_id").references(() => topics.id, { onDelete: "set null" }),

    name: text("name").notNull(),
    fromAddress: text("from_address").notNull(),
    replyTo: text("reply_to")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    subject: text("subject").notNull(),
    previewText: text("preview_text"),
    html: text("html"),
    text: text("text"),

    status: broadcastStatus("status").notNull().default("draft"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),

    /** How many contacts the fan-out resolved to. Written once, at fan-out. */
    recipientCount: integer("recipient_count"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("broadcasts_tenant_idx").on(t.tenantId, t.createdAt)],
)

/**
 * A reusable email, referenced by id from a send.
 *
 * ⚠ DRAFT AND PUBLISHED ARE TWO DIFFERENT COLUMNS, NOT ONE COLUMN AND A FLAG.
 * A template is referenced by `template_id` from production code that is sending
 * mail right now; editing it has to be possible without that edit going live
 * mid-sentence. `published_html` is what a send renders and `html` is what the
 * editor shows, and "Publish" is the one operation that copies one to the other.
 */
export const templates = core.table(
  "templates",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    /** A path like `transactional/auth`. Flat storage, rendered as a tree. */
    folder: text("folder"),

    subject: text("subject"),
    html: text("html"),
    text: text("text"),

    /** ⚠ WHAT A SEND ACTUALLY RENDERS. See the note above. */
    publishedHtml: text("published_html"),
    publishedText: text("published_text"),
    publishedSubject: text("published_subject"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** Bumped on every publish. Cheap provenance for "which one went out". */
    version: integer("version").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("templates_tenant_idx").on(t.tenantId, t.createdAt),
    uniqueIndex("templates_tenant_name_uq").on(t.tenantId, t.name),
  ],
)

// ─────────────────────────────────────────────────────────────────────────────
// Console state: what the dashboard needs to remember that is not the product.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far through onboarding a tenant is.
 *
 * ⚠ THIS DECIDES WHERE WE SEND SOMEBODY, NEVER WHERE THEY MAY GO. `/onboarding`
 * is a route anyone can open at any time — see docs/decisions/console.md — and
 * this row only answers "should the console redirect them there on arrival".
 * A flag that gated access would make re-running the flow after an upgrade
 * impossible, which is the exact thing it is required to support.
 *
 * ⚠ `last_onboarded_plan` IS WHAT MAKES "RE-RUN ON UPGRADE FROM FREE" WORK
 * WITHOUT RE-RUNNING ON EVERY UPGRADE. The rule is: re-run when the plan changed
 * AND the plan we last onboarded on was the free one. A boolean would force a
 * choice between never re-running and re-running on pro → scale, and the second
 * is an insult to somebody who just paid us more.
 */
export const onboarding = core.table("onboarding", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),

  /** The step last reached. A string, not an int — see the console's STEPS. */
  step: text("step").notNull().default("workspace"),

  /**
   * ⚠ SET WHEN THE FLOW IS FINISHED *OR* SKIPPED, AND THE TWO ARE NOT
   * DISTINGUISHED ON PURPOSE. Both mean "stop redirecting me". Whether somebody
   * completed step 4 is answerable from the things themselves — do they have a
   * verified domain, do they have a key — and those answers stay true when this
   * row is wrong.
   */
  completedAt: timestamp("completed_at", { withTimezone: true }),

  /** The plan in force when `completed_at` was last set. See above. */
  lastOnboardedPlan: text("last_onboarded_plan"),

  /** Free-text, from step 1. Product research, never logic. */
  useCase: text("use_case"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A customer's credential for their own DNS provider.
 *
 * ⚠ THE SECRET IS SEALED WITH THE SAME KEY AND THE SAME ENVELOPE AS A WEBHOOK
 * SIGNING SECRET (`webhook_endpoints.secret_ciphertext`), and it is never
 * returned by any route. A DNS API token is the most dangerous credential this
 * product stores: it can rewrite a customer's MX records and take delivery of
 * their mail. It is written once, read only by the record writer, and the
 * console sees a label and a timestamp.
 *
 * ⚠ AND THE SCOPE IS THE ZONE, NOT THE ACCOUNT, WHEREVER THE PROVIDER ALLOWS IT.
 * Cloudflare and Route 53 can both restrict to one zone; the connect flow asks
 * for that and says why. Where a provider only issues account-wide credentials
 * the UI says so plainly rather than implying a narrower blast radius than
 * exists — see `ProviderApi.zoneScoped` in @repo/dns-providers.
 *
 * ⚠ NOTHING WRITES THIS TABLE YET, AND THAT IS KNOWN RATHER THAN OVERLOOKED.
 * The console's "Connect <provider>" button is rendered disabled and labelled
 * `soon` — deliberately, because the capability is real and the adapters are
 * the next piece of work — and `@repo/dns-providers` already carries the per-
 * provider facts those adapters need. It is here now because it arrives with
 * the RLS policy and the `tenant_id` cascade that 0037 applies to all eleven
 * console tables in one place; adding the only table that handles a
 * zone-rewriting credential in a later, separate migration is how one ends up
 * without a policy. If the connect flow is abandoned, drop it — an empty table
 * is not free, it is a thing every future reader has to ask about.
 */
export const dnsConnections = core.table(
  "dns_connections",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** The registry slug. See packages/dns-providers. */
    provider: text("provider").notNull(),

    /** What the customer called it. Shown in the console; never a secret. */
    label: text("label"),

    /**
     * ⚠ THE WHOLE CREDENTIAL, SEALED. Some providers need two parts (a key and a
     * secret, or a key id and a region), so this is a sealed JSON object rather
     * than a sealed string — otherwise the second provider to need two fields
     * forces a migration.
     */
    credentialSealed: text("credential_sealed").notNull(),

    /** Which zones this credential was proven to reach, at connect time. */
    zones: text("zones")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastError: text("last_error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dns_connections_tenant_idx").on(t.tenantId, t.provider)],
)

/**
 * The API request log behind the console's Logs page.
 *
 * ⚠ IT RECORDS THE ENVELOPE AND NEVER THE BODY. A request body on this API
 * contains the customer's mail — subject lines, recipients, and the HTML of
 * whatever they sent. Keeping it would turn an operational log into a copy of
 * every email the platform has ever carried, retained under a policy nobody
 * wrote, readable by anyone who can read logs. Method, path, status, duration
 * and the key that was used answer every question this page exists to answer.
 *
 * ⚠ AND IT IS NOT PARTITIONED, WHICH IS A DECISION WITH AN EXPIRY DATE.
 * `core.messages` is partitioned because it is the product; this is a 30-day
 * operational window swept on a schedule. When request volume makes the sweep
 * expensive it becomes partitioned like its neighbour — the index below is
 * already ordered to make that a mechanical change.
 */
export const apiRequests = core.table(
  "api_requests",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Null for a request that failed before a key resolved. */
    apiKeyId: uuid("api_key_id"),

    method: text("method").notNull(),
    /** ⚠ THE ROUTE PATTERN, NOT THE URL. `/emails/{id}`, never the message id. */
    path: text("path").notNull(),
    status: integer("status").notNull(),
    durationMs: integer("duration_ms").notNull(),

    /** The error `name` from the response envelope, when there was one. */
    errorName: text("error_name"),

    /**
     * ⚠ TRUNCATED TO A PREFIX. A user agent is unbounded and attacker-
     * controlled; 200 characters identifies an SDK and a version, which is the
     * question somebody is actually asking ("is this the old client?").
     */
    userAgent: text("user_agent"),

    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("api_requests_tenant_idx").on(t.tenantId, t.occurredAt)],
)
